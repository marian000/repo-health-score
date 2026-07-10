import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { busFactorModule } from '../../src/modules/bus-factor.js';
import { dependenciesModule } from '../../src/modules/dependencies.js';
import { docsModule } from '../../src/modules/docs.js';
import { licensesModule } from '../../src/modules/licenses.js';
import { secretsModule } from '../../src/modules/secrets.js';
import type { CategoryId, ScanModule } from '../../src/modules/types.js';
import { scanRepository } from '../../src/orchestrator.js';
import type { Report, ScoredCategory } from '../../src/scoring/engine.js';
import { run } from '../../src/util/exec.js';
import { resolveGitleaks } from '../../src/util/gitleaks-binary.js';
import { scanContext } from '../support/context.js';
import {
  materialiseFixture,
  PLANTED_SECRET_FILE,
  removeFixture,
  type FixtureName,
} from '../support/fixtures.js';

/**
 * Known input, expected score.
 *
 * Every other test in this suite feeds a module a value it constructed. These
 * two feed the whole pipeline a repository, and check the one number a user
 * ever sees. A module can be individually correct and still produce a wrong
 * total — through a weight, a rounding step, or the redistribution rule — and
 * nothing but an end-to-end scan of known input catches that.
 *
 * The suite is split by what each module needs from the outside world:
 *
 * - `licenses`, `docs` and `bus-factor` read the checkout and nothing else, so
 *   their scores are asserted exactly, offline, on every machine.
 * - `secrets` needs the Gitleaks binary and `dependencies` needs the npm
 *   registry. Those are asserted too, but only where they can actually run.
 *
 * Skipping beats mocking here. A mocked `npm audit` would assert that this code
 * parses a recording of npm's output, which is not the thing that breaks.
 */

const SELF_CONTAINED_MODULES: readonly ScanModule[] = [
  licensesModule,
  docsModule,
  busFactorModule,
];

const registryReachable = await canReachRegistry();
const gitleaksReady = await canRunGitleaks();
const fullScanPossible = registryReachable && gitleaksReady;

// Skipping is a developer convenience, not a CI result. A registry blip would
// otherwise turn "the dependency tests never ran" into a green build — the same
// "absence of a measurement is evidence of health" mistake the modules
// themselves refuse to make.
if (isCI() && !fullScanPossible) {
  throw new Error(
    'Integration tests need the npm registry and the Gitleaks download, and CI has both. ' +
      `Registry reachable: ${String(registryReachable)}. Gitleaks runnable: ${String(gitleaksReady)}.`,
  );
}

let cleanRoot: string;
let plantedRoot: string;

/** Removed in `afterAll` even if a later fixture fails to materialise. */
const materialised: string[] = [];

beforeAll(async () => {
  const track = async (name: FixtureName): Promise<string> => {
    const root = await materialiseFixture(name);
    materialised.push(root);
    return root;
  };

  [cleanRoot, plantedRoot] = await Promise.all([
    track('clean'),
    track('planted'),
  ]);
});

afterAll(async () => {
  // Not `removeFixture(cleanRoot)`: if the planted fixture threw, the clean one
  // was still created, and both variables are still undefined. `rm(undefined)`
  // raises a TypeError that buries the failure that actually mattered.
  await Promise.all(materialised.map(removeFixture));
});

describe('the three modules that need nothing but the checkout', () => {
  let clean: Report;
  let planted: Report;

  beforeAll(async () => {
    [clean, planted] = await Promise.all([
      scanRepository({ repoRoot: cleanRoot, modules: SELF_CONTAINED_MODULES }),
      scanRepository({
        repoRoot: plantedRoot,
        modules: SELF_CONTAINED_MODULES,
      }),
    ]);
  });

  describe('the clean fixture', () => {
    it('scores 100 and grades A', () => {
      expect(clean.score).toBe(100);
      expect(clean.grade).toBe('A');
    });

    it('finds nothing to report', () => {
      expect(clean.findings).toEqual([]);
    });

    it('scores every category, rather than skipping one as N/A', () => {
      // A skipped category redistributes its weight, so a fixture that quietly
      // stops being scannable would still score 100 — and this test would pass
      // while measuring nothing.
      for (const id of ['licenses', 'docs', 'bus-factor'] as const) {
        expect(scoredCategory(clean, id).score).toBe(100);
      }
    });
  });

  describe('the planted fixture', () => {
    it('scores 37 and grades F', () => {
      // (75 + 35 + 0) / 3, the three equally-weighted categories in this scan.
      expect(planted.score).toBe(37);
      expect(planted.grade).toBe('F');
    });

    it('docks 25 for a transitive GPL dependency in an MIT project', () => {
      const licenses = scoredCategory(planted, 'licenses');
      expect(licenses.score).toBe(75);
      expect(licenses.findings).toHaveLength(1);

      const [conflict] = licenses.findings;
      expect(conflict?.severity).toBe('high');
      expect(conflict?.problem).toContain('gpl-lib');
      expect(conflict?.problem).toContain('GPL-3.0');
      // `lodash` is MIT and reached the same way. Only the copyleft one counts.
      expect(conflict?.problem).not.toContain('lodash');
    });

    it('scores docs on the missing README section and the missing docblocks', () => {
      // README has Installation but no Usage: 50. One of four public functions
      // carries a docblock: 25. 50 × 0.4 + 25 × 0.6 = 35.
      const docs = scoredCategory(planted, 'docs');
      expect(docs.score).toBe(35);

      const problems = reportedProblems(docs);
      expect(problems).toContain('Usage');
      for (const fn of ['charge()', 'generate()', 'send()']) {
        expect(problems).toContain(fn);
      }
    });

    it('does not report the one function that is documented', () => {
      expect(reportedProblems(scoredCategory(planted, 'docs'))).not.toContain(
        'total()',
      );
    });

    it('zeroes bus factor and names the sole author of each critical file', () => {
      const busFactor = scoredCategory(planted, 'bus-factor');
      expect(busFactor.score).toBe(0);

      // The three most-churned files, and no others: `ceil(12 × 0.2)`.
      expect(busFactor.findings.map((finding) => finding.file).sort()).toEqual([
        'src/Invoice.php',
        'src/Payment.php',
        'src/Router.php',
      ]);
      for (const finding of busFactor.findings) {
        expect(finding.problem).toContain('Alice Nakamura');
      }
    });

    it('every finding says how to fix it', () => {
      // The project's whole claim over a bare score. A finding with an empty
      // `fix` is a number pretending to be advice.
      for (const finding of planted.findings) {
        expect(finding.fix.length).toBeGreaterThan(20);
      }
    });
  });
});

describe.skipIf(!gitleaksReady)('secrets, against a real Gitleaks', () => {
  it('finds no secret in the clean fixture', async () => {
    const result = await secretsModule.scan(scanContext(cleanRoot));
    expect(result).toMatchObject({ status: 'scored', score: 100 });
    expect(result.status === 'scored' && result.findings).toEqual([]);
  });

  it('finds the planted AWS key and rates it critical', async () => {
    const result = await secretsModule.scan(scanContext(plantedRoot));
    expect(result.status).toBe('scored');

    const findings = result.status === 'scored' ? result.findings : [];
    expect(findings).toHaveLength(1);

    const [leak] = findings;
    expect(leak?.severity).toBe('critical');
    // A repo-relative path, not the scanning machine's home directory.
    expect(leak?.file).toBe(PLANTED_SECRET_FILE);
    expect(leak?.fix).toContain('Revoke');
    // The finding must never carry the credential it found: a PR comment is a
    // more public place than the file the key was already sitting in.
    expect(JSON.stringify(leak)).not.toContain('AKIA');
  });

  it('hard-zeroes the category, whatever the module scored it', async () => {
    const report = await scanRepository({
      repoRoot: plantedRoot,
      modules: [secretsModule],
    });
    const secrets = scoredCategory(report, 'secrets');

    expect(secrets.hardZeroed).toBe(true);
    expect(secrets.score).toBe(0);
    // One low-confidence match would have cost 10 points, not 100. The zero is
    // the engine's rule, not the module's arithmetic.
    expect(secrets.rawScore).toBe(90);
  });

  it('honours a .gitleaks.toml allowlist, and discloses that it did', async () => {
    // Unanchored on purpose. Gitleaks matches this pattern against the absolute
    // path it was handed, so `^config/` would match nothing and silently
    // suppress nothing — the failure mode being an allowlist that looks like it
    // works.
    await writeFile(
      join(plantedRoot, '.gitleaks.toml'),
      [
        '[extend]',
        'useDefault = true',
        '',
        '[[allowlists]]',
        "paths = ['''config/production\\.env''']",
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      const result = await secretsModule.scan(scanContext(plantedRoot));
      expect(result).toMatchObject({ status: 'scored', score: 100 });

      const findings = result.status === 'scored' ? result.findings : [];
      expect(findings).toHaveLength(1);
      // A repo that supplies the rules it is judged by must say so in the
      // report, or a fork PR can allowlist everything and score 100 in silence.
      expect(findings[0]?.severity).toBe('info');
      expect(findings[0]?.problem).toContain('.gitleaks.toml');
    } finally {
      // Every later scan in this file reads this directory. Leaving the config
      // behind would suppress the planted key for all of them.
      await rm(join(plantedRoot, '.gitleaks.toml'), { force: true });
    }
  });
});

describe.skipIf(!registryReachable)(
  'dependencies, against the real npm registry',
  () => {
    it('scores 100 for a dependency with no advisories', async () => {
      const result = await dependenciesModule.scan(scanContext(cleanRoot));
      expect(result).toMatchObject({ status: 'scored', score: 100 });
    });

    it('floors at 0 for lodash 4.17.4 and names the upgrade', async () => {
      // Deliberately not an exact finding count: advisories are published over
      // time, and a test that pins today's count fails on a day nothing broke.
      // The penalties already exceed 100 several times over, so the floor is
      // the stable assertion.
      const result = await dependenciesModule.scan(scanContext(plantedRoot));
      expect(result).toMatchObject({ status: 'scored', score: 0 });

      const findings = result.status === 'scored' ? result.findings : [];
      expect(findings.length).toBeGreaterThan(0);

      const lodash = findings.find((finding) =>
        finding.problem.includes('lodash'),
      );
      expect(lodash?.fix).toContain('Upgrade `lodash`');
    });

    it('keeps advisories that share a title but not an id', async () => {
      // Regression: lodash 4.17.4 has four advisories titled "Prototype
      // Pollution in lodash", of which one is critical and npm lists it third.
      // Deduplicating by title kept the first — a moderate — and dropped the
      // critical from the score and from the report. The repo scored 10 rather
      // than 0, and the worst advisory against it was never mentioned.
      const result = await dependenciesModule.scan(scanContext(plantedRoot));
      const findings = result.status === 'scored' ? result.findings : [];

      expect(findings.map((finding) => finding.severity)).toContain('critical');
    });
  },
);

describe.skipIf(!fullScanPossible)(
  'the whole pipeline, all five modules',
  () => {
    // Scanned once, asserted several times. A full scan runs Gitleaks over the
    // whole tree and `npm audit` against the registry; doing that per assertion
    // costs more wall-clock than every other test in this file put together.
    let clean: Report;
    let planted: Report;

    beforeAll(async () => {
      [clean, planted] = await Promise.all([
        scanRepository({ repoRoot: cleanRoot }),
        scanRepository({ repoRoot: plantedRoot }),
      ]);
    });

    it('grades the clean fixture A', () => {
      expect(clean.score).toBe(100);
      expect(clean.grade).toBe('A');
      expect(clean.categories.every((c) => c.status === 'scored')).toBe(true);
    });

    it('grades the planted fixture F', () => {
      // secrets 0 × 0.30, dependencies 0 × 0.25, licenses 75 × 0.15,
      // docs 35 × 0.15, bus-factor 0 × 0.15  →  16.5, rounded to 17.
      expect(planted.score).toBe(17);
      expect(planted.grade).toBe('F');
    });

    it('sorts findings worst-first, so the PR comment leads with the leak', () => {
      expect(planted.findings[0]?.severity).toBe('critical');
    });
  },
);

/** One string per category, so a missing finding fails with the list that was there. */
function reportedProblems(category: ScoredCategory): string {
  return category.findings.map((finding) => finding.problem).join('\n');
}

function scoredCategory(report: Report, id: CategoryId): ScoredCategory {
  const category = report.categories.find((entry) => entry.category === id);
  if (category?.status !== 'scored') {
    const reason =
      category?.status === 'not-applicable' ? category.reason : 'absent';
    throw new Error(`Expected "${id}" to be scored, but it was ${reason}.`);
  }
  return category;
}

/** Every mainstream CI runner sets this; GitHub Actions sets it to `true`. */
function isCI(): boolean {
  const flag = process.env['CI'];
  return flag !== undefined && flag !== '' && flag !== 'false';
}

/** `npm audit` is the only module that talks to a network service. */
async function canReachRegistry(): Promise<boolean> {
  try {
    const response = await fetch('https://registry.npmjs.org/-/ping', {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Downloads and verifies the pinned binary on a cold cache; a no-op afterwards.
 *
 * Then runs it. `resolveGitleaks` honours `REPO_HEALTH_GITLEAKS_PATH` without
 * checking that anything is there, so resolving a path proves nothing: a stale
 * override would report the binary as ready and every secrets test would fail
 * with CommandNotFoundError rather than skip.
 */
async function canRunGitleaks(): Promise<boolean> {
  try {
    const binary = await resolveGitleaks();
    const { exitCode } = await run(binary, ['version'], {
      cwd: tmpdir(),
      timeoutMs: 10_000,
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}
