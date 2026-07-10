import type { ScanContext } from '../../src/modules/types.js';

/**
 * The `ScanContext` a module sees for an ordinary checkout.
 *
 * The defaults describe the healthy case — a git repository with full history —
 * because that is what every fixture builds. Tests that exercise a degradation
 * path spread over the field they mean to break:
 *
 * ```ts
 * await busFactorModule.scan({ ...scanContext(repoRoot), isShallowClone: true });
 * ```
 *
 * Shared rather than redeclared per test file, so that adding a required field
 * to `ScanContext` breaks in one place instead of silently in three.
 */
export const scanContext = (repoRoot: string): ScanContext => ({
  repoRoot,
  isGitRepo: true,
  isShallowClone: false,
  log: () => undefined,
});
