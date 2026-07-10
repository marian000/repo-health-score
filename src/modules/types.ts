/**
 * The contract every scanning module implements.
 *
 * This file is the community extension point. A new language audit — Python's
 * `pip-audit`, Ruby's `bundler-audit`, Go's `govulncheck` — should satisfy
 * these types and drop into the orchestrator without either the orchestrator
 * or the scoring engine changing. If a module cannot be expressed here, the
 * interface is wrong; fix the interface rather than working around it.
 */

/**
 * The five scored categories of the MVP, in canonical report order.
 *
 * This array is the single source of truth: it drives the `CategoryId` type,
 * validation of `weights.json`, and the row order of every renderer. Reports
 * must not vary with the order modules happen to finish in, or the committed
 * badge churns and the JSON artifact cannot be diffed across runs.
 *
 * Adding a category means adding a weight to `weights.json`.
 */
export const CATEGORY_IDS = [
  'secrets',
  'dependencies',
  'licenses',
  'docs',
  'bus-factor',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/**
 * Severity of a single finding.
 *
 * `critical` is load-bearing in the secrets module: one critical match zeroes
 * that category outright. Elsewhere it only ranks output.
 */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * One problem found in the scanned repository.
 *
 * The `fix` field is not optional and not decorative. A finding that reports a
 * problem without a concrete remediation fails the project's core promise:
 * "here is what's wrong AND how to repair it". "3 undocumented functions" is
 * half a finding; naming them and the docblock to add is a whole one.
 */
export interface Finding {
  readonly severity: Severity;
  /** One line, imperative or declarative: "Hardcoded AWS key", "GPL-3.0 dependency". */
  readonly problem: string;
  /** Concrete remediation: "Bump `package-x` to v2.3+", "Add a docblock to `handle()`". */
  readonly fix: string;
  /** Repo-relative path. Omitted for findings that aren't tied to a file (e.g. missing README). */
  readonly file?: string;
  /** 1-indexed line number, when the module can pinpoint one. */
  readonly line?: number;
  /** CVE id, license SPDX id, or a URL with more context. */
  readonly reference?: string;
}

/**
 * A category that was successfully scanned.
 *
 * `score` is 0-100, where 100 is healthy. It is the module's own judgement of
 * its category; the engine only applies the weight (and the secrets hard-zero).
 */
export interface ScoredResult {
  readonly status: 'scored';
  readonly score: number;
  readonly findings: readonly Finding[];
}

/**
 * A category that could not be scanned, and why.
 *
 * Returned when a precondition is missing: no dependency manifest, no Composer
 * on PATH, a shallow clone with no history to analyse. The engine redistributes
 * this category's weight proportionally across the applicable ones — it never
 * awards a free 100, which would inflate the total above repos that do have
 * dependencies to audit.
 *
 * Reaching for this is always better than guessing. A plausible-looking wrong
 * number is worse than an honest gap, because nobody re-checks a number that
 * looks right.
 */
export interface NotApplicableResult {
  readonly status: 'not-applicable';
  /** Why the scan could not run: "No composer.json or package.json at repo root". */
  readonly reason: string;
  /** How the user could make it run, when that's in their control. */
  readonly hint?: string;
}

export type CategoryResult = ScoredResult | NotApplicableResult;

/** Everything a module is given about the repository under scan. */
export interface ScanContext {
  /** Absolute path to the root of the repository being scanned. */
  readonly repoRoot: string;
  /** False when `.git` is absent — bus-factor is the only module that needs it. */
  readonly isGitRepo: boolean;
  /**
   * True when the checkout has truncated history (`git rev-parse --is-shallow-repository`).
   *
   * GitHub Actions checks out with `fetch-depth: 1` by default, which silently
   * starves any `git log`/`git blame` analysis. Modules that depend on history
   * must return not-applicable rather than report from a one-commit history.
   */
  readonly isShallowClone: boolean;
  /** Emits progress to the user. Modules should not write to stdout directly. */
  readonly log: (message: string) => void;
}

/**
 * A scanning module.
 *
 * Rules a module must honour, in order of how badly violating them hurts:
 *
 * 1. **Never be silently wrong.** Missing precondition → `not-applicable`.
 * 2. **Never throw for an expected condition.** No tool installed, no manifest,
 *    no git history: all are `not-applicable`, not exceptions. A thrown error
 *    means a genuine bug in the module.
 * 3. **Run locally.** No API calls, no tokens, no network beyond fetching a
 *    vulnerability database or a scanner binary. This preserves zero-config and
 *    keeps the tool usable in locked-down CI.
 * 4. **Wrap, don't reimplement.** If a mature scanner exists, shell out to it.
 */
export interface ScanModule {
  readonly category: CategoryId;
  /** Human-readable name for progress output: "Exposed secrets". */
  readonly name: string;
  scan(context: ScanContext): Promise<CategoryResult>;
}

/** Convenience constructors — keep result shapes uniform across modules. */
export const scored = (
  score: number,
  findings: readonly Finding[] = [],
): ScoredResult => ({
  status: 'scored',
  score: clampScore(score),
  findings,
});

export const notApplicable = (
  reason: string,
  hint?: string,
): NotApplicableResult =>
  hint === undefined
    ? { status: 'not-applicable', reason }
    : { status: 'not-applicable', reason, hint };

/** Scores are always 0-100. A module that computes -15 has a bug; clamp rather than propagate it. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}
