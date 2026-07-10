import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPOSER_SANDBOX } from '../util/composer.js';
import { ok, unavailable, type EcosystemScan } from '../util/ecosystem.js';
import { CommandNotFoundError, run } from '../util/exec.js';
import {
  notApplicable,
  scored,
  type CategoryResult,
  type Finding,
  type ScanContext,
  type ScanModule,
  type Severity,
} from './types.js';

/**
 * Strong copyleft: linking against these obliges the combined work to adopt the
 * same license. Shipping one inside a permissively-licensed project is the
 * incompatibility this module exists to catch.
 *
 * AGPL outranks GPL because it triggers on network use rather than
 * distribution — a SaaS obligation most teams never realise they took on.
 */
const STRONG_COPYLEFT: Record<string, Severity> = {
  'agpl-3.0': 'critical',
  'agpl-3.0-only': 'critical',
  'agpl-3.0-or-later': 'critical',
  agpl: 'critical',
  'sspl-1.0': 'critical',
  'gpl-2.0': 'high',
  'gpl-2.0-only': 'high',
  'gpl-2.0-or-later': 'high',
  'gpl-3.0': 'high',
  'gpl-3.0-only': 'high',
  'gpl-3.0-or-later': 'high',
  gpl: 'high',
};

/**
 * Weak copyleft: obliges you to publish changes *to the dependency*, not to
 * your own code. Worth surfacing, not worth a large penalty.
 */
const WEAK_COPYLEFT: Record<string, Severity> = {
  'lgpl-2.1': 'low',
  'lgpl-3.0': 'low',
  lgpl: 'low',
  'mpl-2.0': 'low',
  'epl-2.0': 'low',
};

/** Project licenses under which a copyleft dependency is a genuine conflict. */
const PERMISSIVE_PROJECT_LICENSES = [
  'mit',
  'apache-2.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
  'unlicense',
  '0bsd',
];

const PENALTY: Record<Severity, number> = {
  critical: 40,
  high: 25,
  medium: 10,
  low: 5,
  info: 0,
};

interface Conflict {
  readonly package: string;
  readonly license: string;
}

export const licensesModule: ScanModule = {
  category: 'licenses',
  name: 'Licenses',

  async scan(context: ScanContext): Promise<CategoryResult> {
    const hasComposer = await exists(join(context.repoRoot, 'composer.json'));
    const hasNpm = await exists(join(context.repoRoot, 'package.json'));

    if (!hasComposer && !hasNpm) {
      return notApplicable(
        'No composer.json or package.json at the repository root',
      );
    }

    const projectLicense = await readProjectLicense(context.repoRoot);

    // Without the project's own license there is nothing to be incompatible
    // with: a GPL dependency is correct in a GPL project and a problem in an
    // MIT one.
    if (projectLicense === null) {
      return notApplicable(
        'The project declares no license, so dependency compatibility cannot be judged',
        'Add a `license` field to composer.json or package.json.',
      );
    }

    // A copyleft project may depend on copyleft freely. Resolving the whole
    // dependency tree to conclude "no conflict possible" would be wasted work.
    if (!isPermissive(projectLicense)) {
      return scored(100);
    }

    const scans: EcosystemScan<Conflict>[] = [];
    if (hasComposer) scans.push(await listComposerConflicts(context));
    if (hasNpm) scans.push(await listNpmConflicts(context));

    const succeeded = scans.filter((scan) => scan.status === 'ok');

    // No ecosystem could be read. An empty conflict list here means "we did not
    // look", not "we looked and found nothing" — those must not score the same.
    if (succeeded.length === 0) {
      const blocked = scans.filter((scan) => scan.status === 'unavailable');
      return notApplicable(
        blocked.map((scan) => scan.reason).join('; '),
        blocked.map((scan) => scan.hint).join(' '),
      );
    }

    const conflicts = succeeded.flatMap((scan) => [...scan.items]);
    const penalty = conflicts.reduce(
      (sum, conflict) => sum + PENALTY[severityOf(conflict.license) ?? 'low'],
      0,
    );

    return scored(
      100 - penalty,
      conflicts.map((conflict) => toFinding(conflict, projectLicense)),
    );
  },
};

/**
 * `composer licenses --format=json` reports every installed package's license.
 *
 * This is deliberately not `licensee`: that tool identifies the *repository's
 * own* license from its LICENSE file — a different question — and is a Ruby
 * gem, which would break the zero-config promise.
 */
async function listComposerConflicts(
  context: ScanContext,
): Promise<EcosystemScan<Conflict>> {
  context.log('Reading Composer dependency licenses…');

  let stdout: string;
  try {
    ({ stdout } = await run(
      'composer',
      ['licenses', '--format=json', '--no-interaction', ...COMPOSER_SANDBOX],
      { cwd: context.repoRoot },
    ));
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      return unavailable(
        'Composer is not installed, so PHP dependency licenses could not be read',
        'Install Composer and re-run.',
      );
    }
    throw error;
  }

  const parsed = parseJson(stdout);
  if (parsed === null) return ok([]);

  const conflicts: Conflict[] = [];
  for (const [name, raw] of Object.entries(asRecord(parsed['dependencies']))) {
    const declared = asRecord(raw)['license'];
    const values = Array.isArray(declared)
      ? declared.filter((value): value is string => typeof value === 'string')
      : [];
    if (values.length === 0) continue;

    // Composer reports `license` as an array. A dual-licensed package lets the
    // consumer pick, so one permissive option anywhere clears the package.
    if (values.some((value) => severityOf(value) === null)) continue;

    conflicts.push({ package: name, license: values[0] ?? 'unknown' });
  }

  return ok(conflicts);
}

/**
 * npm ships no license lister, so this walks the installed tree via `npm ls`.
 *
 * It needs `node_modules` on disk. Reading only package.json's direct
 * dependencies would miss exactly the deep transitive GPL dependency this
 * module exists to find, so an uninstalled tree is unavailable, not empty.
 */
async function listNpmConflicts(
  context: ScanContext,
): Promise<EcosystemScan<Conflict>> {
  if (!(await exists(join(context.repoRoot, 'node_modules')))) {
    return unavailable(
      'node_modules is absent, so transitive npm licenses could not be resolved',
      'Run `npm install` before scanning.',
    );
  }

  context.log('Reading npm dependency licenses…');

  let stdout: string;
  try {
    // `npm ls` exits non-zero on peer-dependency complaints while still
    // emitting a complete tree, so the exit code is ignored.
    ({ stdout } = await run('npm', ['ls', '--json', '--all', '--long'], {
      cwd: context.repoRoot,
      timeoutMs: 60_000,
    }));
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      return unavailable(
        'npm is not installed, so JavaScript dependency licenses could not be read',
        'Install Node.js and re-run.',
      );
    }
    throw error;
  }

  const parsed = parseJson(stdout);
  if (parsed === null) return ok([]);

  const conflicts: Conflict[] = [];
  const seen = new Set<string>();

  const walk = (node: Record<string, unknown>): void => {
    for (const [name, raw] of Object.entries(asRecord(node['dependencies']))) {
      if (seen.has(name)) continue;
      seen.add(name);

      const dependency = asRecord(raw);
      const license = asString(dependency['license']);
      if (license !== undefined && severityOf(license) !== null) {
        conflicts.push({ package: name, license });
      }
      walk(dependency);
    }
  };
  walk(parsed);

  return ok(conflicts);
}

/** The project's own declared license, from whichever manifest declares one. */
async function readProjectLicense(repoRoot: string): Promise<string | null> {
  for (const manifest of ['composer.json', 'package.json']) {
    try {
      const parsed = parseJson(
        await readFile(join(repoRoot, manifest), 'utf8'),
      );
      if (parsed === null) continue;

      const license = parsed['license'];
      if (typeof license === 'string' && license !== '') return license;
      // Composer allows an array for dual-licensed projects.
      if (Array.isArray(license) && typeof license[0] === 'string') {
        return license[0];
      }
    } catch {
      continue;
    }
  }
  return null;
}

function toFinding(conflict: Conflict, projectLicense: string): Finding {
  const severity = severityOf(conflict.license) ?? 'low';
  const isStrong = severity === 'critical' || severity === 'high';

  return {
    severity,
    problem: `\`${conflict.package}\` is licensed ${conflict.license}, which conflicts with this project's ${projectLicense} license`,
    fix: isStrong
      ? `Replace \`${conflict.package}\` with a permissively-licensed equivalent, or relicense this project under ${conflict.license}. Distributing ${projectLicense} code linked against ${conflict.license} obliges you to release the combined work under ${conflict.license}.`
      : `Review your use of \`${conflict.package}\`: ${conflict.license} requires publishing modifications to the dependency itself, though not to your own code.`,
    reference: `https://spdx.org/licenses/${conflict.license}.html`,
  };
}

/** null means "no conflict" — either permissive, or unrecognised and assumed benign. */
function severityOf(license: string): Severity | null {
  const key = license.toLowerCase().trim();
  return STRONG_COPYLEFT[key] ?? WEAK_COPYLEFT[key] ?? null;
}

function isPermissive(license: string): boolean {
  return PERMISSIVE_PROJECT_LICENSES.includes(license.toLowerCase().trim());
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
