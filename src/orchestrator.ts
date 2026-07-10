import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { busFactorModule } from './modules/bus-factor.js';
import { dependenciesModule } from './modules/dependencies.js';
import { docsModule } from './modules/docs.js';
import { licensesModule } from './modules/licenses.js';
import { secretsModule } from './modules/secrets.js';
import {
  notApplicable,
  type CategoryId,
  type CategoryResult,
  type ScanContext,
  type ScanModule,
} from './modules/types.js';
import { calculateScore, type Report, type Weights } from './scoring/engine.js';
import { run } from './util/exec.js';

/** Registration order does not affect the report: the engine sorts by CATEGORY_IDS. */
export const DEFAULT_MODULES: readonly ScanModule[] = [
  secretsModule,
  dependenciesModule,
  licensesModule,
  docsModule,
  busFactorModule,
];

export interface ScanOptions {
  readonly repoRoot: string;
  readonly weights?: Weights;
  readonly modules?: readonly ScanModule[];
  readonly log?: (message: string) => void;
}

/**
 * Run every module against a repository and collapse the results into a report.
 *
 * Modules run concurrently. They share no state, touch no common files, and
 * each shells out to a different tool, so the wall-clock cost of a scan is the
 * slowest module rather than their sum — which matters when Gitleaks takes
 * thirty seconds on a large tree.
 */
export async function scanRepository(options: ScanOptions): Promise<Report> {
  const log = options.log ?? (() => undefined);
  const modules = options.modules ?? DEFAULT_MODULES;

  const context: ScanContext = {
    repoRoot: options.repoRoot,
    isGitRepo: await isGitRepository(options.repoRoot),
    isShallowClone: await isShallowClone(options.repoRoot),
    log,
  };

  const settled = await Promise.all(
    modules.map(async (module) => {
      log(`Running ${module.name}…`);
      return [module.category, await runModule(module, context)] as const;
    }),
  );

  return calculateScore(
    new Map<CategoryId, CategoryResult>(settled),
    options.weights,
  );
}

/**
 * A module that throws has a bug: every expected condition — a missing tool, no
 * manifest, no history — is supposed to become a not-applicable result. Rather
 * than fail the whole scan, isolate the damage and report the crash as a gap in
 * that one category, so the other four still produce a score.
 */
async function runModule(
  module: ScanModule,
  context: ScanContext,
): Promise<CategoryResult> {
  try {
    return await module.scan(context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.log(`  ${module.name} failed: ${detail}`);
    return notApplicable(
      `The ${module.name} module crashed: ${detail}`,
      'This is a bug in repo-health-score. Please report it with the repository that triggered it.',
    );
  }
}

async function isGitRepository(repoRoot: string): Promise<boolean> {
  try {
    await access(join(repoRoot, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub Actions checks out with `fetch-depth: 1` by default, which leaves a
 * one-commit history that `git log` reports without complaint. Modules that
 * read history must know, or they will confidently score from a lie.
 */
async function isShallowClone(repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await run(
      'git',
      ['rev-parse', '--is-shallow-repository'],
      { cwd: repoRoot, timeoutMs: 5_000 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
