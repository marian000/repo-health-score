import {
  CATEGORY_IDS,
  type CategoryId,
  type CategoryResult,
  type Finding,
  type NotApplicableResult,
} from '../modules/types.js';
import defaultWeights from './weights.json' with { type: 'json' };

export type Weights = Record<CategoryId, number>;

export type Grade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** Lower bound of each grade, highest first. Order matters — first match wins. */
const GRADE_THRESHOLDS: readonly (readonly [Grade, number])[] = [
  ['A', 90],
  ['B', 80],
  ['C', 70],
  ['D', 60],
  ['E', 50],
  ['F', 0],
];

export interface ScoredCategory {
  readonly category: CategoryId;
  readonly status: 'scored';
  /** The module's raw 0-100 judgement, before the hard-zero rule. */
  readonly rawScore: number;
  /** What actually feeds the weighted average. Differs from rawScore only on a secrets hard zero. */
  readonly score: number;
  /** The weight applied after N/A redistribution. Sums to 1 across all scored categories. */
  readonly effectiveWeight: number;
  readonly findings: readonly Finding[];
  /** Set when the secrets hard-zero rule overrode the module's score. */
  readonly hardZeroed?: true;
}

export interface SkippedCategory extends NotApplicableResult {
  readonly category: CategoryId;
}

export type CategoryReport = ScoredCategory | SkippedCategory;

export interface Report {
  readonly score: number;
  readonly grade: Grade;
  /** Always in CATEGORY_IDS order, so reports diff cleanly across runs. */
  readonly categories: readonly CategoryReport[];
  /** Every finding across every category, sorted worst-first. */
  readonly findings: readonly Finding[];
}

const SEVERITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
} as const;

/**
 * Collapse per-category results into one 0-100 score and a letter grade.
 *
 * Two rules here are deliberate special cases, not oversights:
 *
 * **Secrets hard-zero.** Any critical secrets finding zeroes that category
 * outright, regardless of what the module scored. A leaked live credential is
 * not 80% healthy because the other 80% of the repo is fine.
 *
 * **N/A redistribution.** A category that could not be scanned has its weight
 * spread proportionally across the categories that could. Awarding it a free
 * 100 would rank a repo with no dependencies above one that has dependencies
 * and audits them cleanly — the absence of a thing is not evidence of health.
 *
 * @throws if every scored category carries zero weight — that is a config
 * mistake, and silently reporting F would hide it.
 */
export function calculateScore(
  results: ReadonlyMap<CategoryId, CategoryResult>,
  weights: Weights = resolveWeights(),
): Report {
  const categories: CategoryReport[] = [];
  const allFindings: Finding[] = [];

  // Total weight of categories that actually produced a score. Everything else
  // gets redistributed across these, proportionally to their configured weight.
  let applicableWeight = 0;
  let scoredCount = 0;
  for (const [category, result] of results) {
    if (result.status === 'scored') {
      applicableWeight += weights[category];
      scoredCount += 1;
    }
  }

  // Some categories scored, but the user weighted all of them to zero. There is
  // no meaningful average to take. Reporting F would look like a verdict on the
  // repo when it is really a verdict on the config, so say so.
  if (scoredCount > 0 && applicableWeight === 0) {
    throw new Error(
      'Every scanned category has a weight of 0. At least one scored category must carry non-zero weight.',
    );
  }

  for (const [category, result] of results) {
    if (result.status === 'not-applicable') {
      categories.push({ ...result, category });
      continue;
    }

    const hardZeroed = category === 'secrets' && hasCritical(result.findings);
    const score = hardZeroed ? 0 : result.score;
    // scoredCount > 0 implies applicableWeight > 0 (guarded above), so this is safe.
    const effectiveWeight = weights[category] / applicableWeight;

    allFindings.push(...result.findings);
    categories.push({
      category,
      status: 'scored',
      rawScore: result.score,
      score,
      effectiveWeight,
      findings: result.findings,
      ...(hardZeroed ? { hardZeroed: true as const } : {}),
    });
  }

  // Nothing was measured. Scoring 100 would read "healthy" and 0 reads
  // "unhealthy"; both lie, but F prompts the user to read the reasons.
  const score =
    scoredCount === 0
      ? 0
      : Math.round(
          categories
            .filter(isScored)
            .reduce((sum, c) => sum + c.score * c.effectiveWeight, 0),
        );

  return {
    score,
    grade: toGrade(score),
    categories: categories.sort(byCanonicalOrder),
    findings: allFindings.sort(bySeverity),
  };
}

/** Maps a 0-100 score to its letter grade. Boundaries are inclusive lower bounds: 90 is an A. */
export function toGrade(score: number): Grade {
  for (const [grade, threshold] of GRADE_THRESHOLDS) {
    if (score >= threshold) return grade;
  }
  return 'F';
}

/**
 * Merge user overrides over the defaults and validate the result.
 *
 * Weights are relative, not required to sum to 1 — `calculateScore` normalises
 * by the applicable total anyway. That means a user can write `{"secrets": 100}`
 * and get sensible behaviour rather than a silent miscalculation.
 *
 * Unknown keys are rejected rather than ignored. A user who writes `secret`
 * instead of `secrets` has a config that does nothing; failing loudly beats
 * scoring them against defaults they think they overrode.
 */
export function resolveWeights(
  overrides: Readonly<Record<string, unknown>> = {},
): Weights {
  for (const key of Object.keys(overrides)) {
    if (!isCategoryId(key)) {
      throw new Error(
        `Unknown category "${key}" in weights. Expected one of: ${CATEGORY_IDS.join(', ')}.`,
      );
    }
  }

  // weights.json is user-editable, and overrides arrive from a YAML config, so
  // neither is trustworthy at runtime however well-typed it looks here.
  const merged: Record<string, unknown> = { ...defaultWeights, ...overrides };
  const validated = {} as Weights;

  for (const category of CATEGORY_IDS) {
    const weight = merged[category];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `Invalid weight for "${category}": ${String(weight)}. Weights must be non-negative finite numbers.`,
      );
    }
    validated[category] = weight;
  }

  return validated;
}

function isCategoryId(value: string): value is CategoryId {
  return CATEGORY_IDS.some((id) => id === value);
}

function isScored(category: CategoryReport): category is ScoredCategory {
  return category.status === 'scored';
}

function hasCritical(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'critical');
}

function byCanonicalOrder(a: CategoryReport, b: CategoryReport): number {
  return CATEGORY_IDS.indexOf(a.category) - CATEGORY_IDS.indexOf(b.category);
}

function bySeverity(a: Finding, b: Finding): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}
