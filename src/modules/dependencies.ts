import { access } from 'node:fs/promises';
import { join } from 'node:path';
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
 * Points deducted per active advisory, by severity.
 *
 * Deliberately steep: two criticals take a category from 100 to 20. A repo
 * shipping two critical CVEs is not "80% healthy on dependencies", and scaling
 * the penalty by total dependency count would let a large project hide
 * criticals behind a big denominator.
 */
const PENALTY: Record<Severity, number> = {
  critical: 40,
  high: 25,
  medium: 10,
  low: 5,
  info: 0,
};

interface Advisory {
  readonly package: string;
  readonly severity: Severity;
  readonly title: string;
  readonly reference?: string;
  readonly fixedIn?: string;
}

export const dependenciesModule: ScanModule = {
  category: 'dependencies',
  name: 'Vulnerable dependencies',

  async scan(context: ScanContext): Promise<CategoryResult> {
    const scans: EcosystemScan<Advisory>[] = [];

    // PHP first: the underserved ecosystem is the reason this project exists.
    if (await exists(join(context.repoRoot, 'composer.json'))) {
      scans.push(await auditComposer(context));
    }
    if (await exists(join(context.repoRoot, 'package.json'))) {
      scans.push(await auditNpm(context));
    }

    if (scans.length === 0) {
      return notApplicable(
        'No composer.json or package.json at the repository root',
        'Monorepos with manifests in subdirectories are not scanned yet.',
      );
    }

    const succeeded = scans.filter((scan) => scan.status === 'ok');

    // Every manifest belongs to a package manager we could not run. We know
    // nothing about this repo's dependencies, and 100 would be a lie. Note this
    // is not `advisories.length === 0` — a clean repo also has no advisories.
    if (succeeded.length === 0) {
      const blocked = scans.filter((scan) => scan.status === 'unavailable');
      return notApplicable(
        blocked.map((scan) => scan.reason).join('; '),
        blocked.map((scan) => scan.hint).join(' '),
      );
    }

    const advisories = succeeded.flatMap((scan) => [...scan.items]);
    const penalty = advisories.reduce(
      (sum, advisory) => sum + PENALTY[advisory.severity],
      0,
    );

    return scored(100 - penalty, advisories.map(toFinding));
  },
};

/**
 * `composer audit --format=json` against the lockfile.
 *
 * Exit code 1 means "advisories found", which is the normal path here rather
 * than a failure, so the exit code is ignored in favour of parsing stdout.
 */
async function auditComposer(
  context: ScanContext,
): Promise<EcosystemScan<Advisory>> {
  context.log('Auditing Composer dependencies…');

  let stdout: string;
  try {
    ({ stdout } = await run(
      'composer',
      ['audit', '--format=json', '--no-interaction'],
      { cwd: context.repoRoot },
    ));
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      return unavailable(
        'Composer is not installed, so PHP dependencies could not be audited',
        'Install Composer and re-run. In GitHub Actions, add `shivammathur/setup-php`.',
      );
    }
    throw error;
  }

  const parsed = parseJson(stdout);
  if (parsed === null) return ok([]);

  const advisories: Advisory[] = [];
  for (const [packageName, entries] of Object.entries(
    asRecord(parsed['advisories']),
  )) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const advisory = asRecord(entry);
      advisories.push({
        package: packageName,
        severity: normaliseSeverity(advisory['severity']),
        title: asString(advisory['title']) ?? 'Unspecified vulnerability',
        ...pick(
          'reference',
          asString(advisory['cve']) ?? asString(advisory['link']),
        ),
        ...pick(
          'fixedIn',
          firstFixedVersion(asString(advisory['affectedVersions'])),
        ),
      });
    }
  }

  return ok(advisories);
}

/**
 * `npm audit --json` against the lockfile.
 *
 * npm reports a tree where a transitive advisory repeats on every dependent.
 * Deduplicating by (package, advisory id) means one CVE reachable through three
 * paths is penalised once, not three times.
 */
async function auditNpm(
  context: ScanContext,
): Promise<EcosystemScan<Advisory>> {
  context.log('Auditing npm dependencies…');

  let stdout: string;
  try {
    ({ stdout } = await run('npm', ['audit', '--json'], {
      cwd: context.repoRoot,
    }));
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      return unavailable(
        'npm is not installed, so JavaScript dependencies could not be audited',
        'Install Node.js and re-run. In GitHub Actions, add `actions/setup-node`.',
      );
    }
    throw error;
  }

  const parsed = parseJson(stdout);
  if (parsed === null) return ok([]);

  // npm reports failures as an error object rather than by exit code alone.
  // The cause matters: telling an offline CI to run `npm install` sends the
  // user in a circle, because the lockfile they are told to generate is
  // already there.
  if ('error' in parsed) {
    const error = asRecord(parsed['error']);
    const code = asString(error['code']) ?? 'unknown';
    const summary = asString(error['summary']) ?? code;

    return code === 'ENOLOCK'
      ? unavailable(
          'npm could not audit: no lockfile found',
          'Run `npm install` to generate package-lock.json, then re-run.',
        )
      : unavailable(
          `npm could not audit: ${summary}`,
          'npm audit needs network access to the registry. Check connectivity or registry configuration.',
        );
  }

  const seen = new Set<string>();
  const advisories: Advisory[] = [];

  for (const [packageName, raw] of Object.entries(
    asRecord(parsed['vulnerabilities']),
  )) {
    const vulnerability = asRecord(raw);
    const packageSeverity = normaliseSeverity(vulnerability['severity']);
    const via = vulnerability['via'];
    if (!Array.isArray(via)) continue;

    for (const source of via) {
      // A string entry means "vulnerable because of this other package"; the
      // advisory is reported on that package's own entry. Counting it here too
      // would penalise one CVE once per dependent.
      if (typeof source !== 'object' || source === null) continue;

      const advisory = asRecord(source);
      const title = asString(advisory['title']) ?? 'Unspecified vulnerability';
      const key = `${packageName}::${advisoryId(advisory) ?? title}`;
      if (seen.has(key)) continue;
      seen.add(key);

      advisories.push({
        package: packageName,
        severity:
          advisory['severity'] === undefined
            ? packageSeverity
            : normaliseSeverity(advisory['severity']),
        title,
        ...pick('reference', asString(advisory['url'])),
        ...pick('fixedIn', fixedVersionFromNpm(vulnerability['fixAvailable'])),
      });
    }
  }

  return ok(advisories);
}

function toFinding(advisory: Advisory): Finding {
  return {
    severity: advisory.severity,
    problem: `\`${advisory.package}\`: ${advisory.title}`,
    fix: advisory.fixedIn
      ? `Upgrade \`${advisory.package}\` to ${advisory.fixedIn} or later.`
      : `Upgrade \`${advisory.package}\` to a patched release, or replace it if none exists.`,
    ...pick('reference', advisory.reference),
  };
}

/**
 * What identifies one advisory, for deduplication.
 *
 * Not the title. `lodash@4.17.4` carries four separate advisories all titled
 * "Prototype Pollution in lodash" — GHSA-fvqr-27wr-82fm (moderate),
 * GHSA-4xc9-xhrj-v574 (high), GHSA-jf85-cpcp-j695 (critical) and
 * GHSA-p6mc-m468-83gw (high). Keying on the title folds them into whichever npm
 * happened to list first, so the critical one vanishes from the score and from
 * the findings, and the repo is told it is healthier than it is.
 *
 * `source` is npm's own advisory id; `url` is the GHSA permalink. Either is
 * unique per advisory and stable across the dependents that reach it.
 */
function advisoryId(advisory: Record<string, unknown>): string | undefined {
  const source = advisory['source'];
  if (typeof source === 'number') return String(source);
  return asString(advisory['url']);
}

/** npm's `fixAvailable` is `false`, `true`, or `{name, version, isSemVerMajor}`. */
function fixedVersionFromNpm(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const fix = asRecord(value);
  const version = asString(fix['version']);
  if (version === undefined) return undefined;
  return fix['isSemVerMajor'] === true ? `${version} (major bump)` : version;
}

/** Composer reports affected ranges like `<2.3.0|>=3.0,<3.1.2`; the first upper bound is the fix. */
function firstFixedVersion(affected: string | undefined): string | undefined {
  if (affected === undefined) return undefined;
  return /<=?\s*([\d.]+)/.exec(affected)?.[1];
}

function normaliseSeverity(value: unknown): Severity {
  switch (asString(value)?.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
    case 'moderate':
      return 'medium';
    case 'low':
      return 'low';
    default:
      // Composer omits severity on some advisories. Rating an unrated CVE as
      // `info` would zero its penalty, so assume it is worth patching.
      return 'medium';
  }
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

/** Builds `{key: value}` or `{}` — exactOptionalPropertyTypes rejects an explicit undefined. */
function pick<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
