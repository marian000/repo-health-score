import {
  CATEGORY_IDS,
  type CategoryId,
  type Finding,
} from '../modules/types.js';
import type {
  CategoryReport,
  Report,
  ScoredCategory,
} from '../scoring/engine.js';

/**
 * Identifies our comment so a subsequent run edits it instead of adding another.
 *
 * A PR that gets fifteen pushes should not accumulate fifteen score comments.
 * The Action greps open comments for this marker and PATCHes the match.
 */
export const COMMENT_MARKER = '<!-- repo-health-score -->';

/** Findings shown under "Recommendations" before the list is truncated. */
const MAX_RECOMMENDATIONS = 10;

const CATEGORY_LABELS: Record<CategoryId, string> = {
  secrets: 'Secrets',
  dependencies: 'Dependencies',
  licenses: 'Licenses',
  docs: 'Documentation',
  'bus-factor': 'Bus factor',
};

export interface PrCommentOptions {
  /**
   * The same scan, run against the PR's base branch at the same moment.
   *
   * Scanning the base *now* rather than reusing a stored score is what
   * separates "this PR introduced a vulnerability" from "a CVE was published
   * since main was last scanned". A newly-disclosed CVE appears in both
   * reports and cancels out of the delta; a dependency the PR added appears
   * only in the head report.
   */
  readonly baseline?: Report;
  readonly baseBranch?: string;
}

/**
 * Render the PR comment as markdown, leading with the marker that lets a later
 * run find and edit this comment rather than posting a second one.
 */
export function renderPrComment(
  report: Report,
  options: PrCommentOptions = {},
): string {
  const lines: string[] = [COMMENT_MARKER, ''];

  lines.push(
    `## 🩺 Repo Health Score: ${report.grade} (${report.score}/100)${renderTotalDelta(report, options)}`,
  );
  lines.push('');
  lines.push(...renderTable(report, options));

  const note = renderComparisonNote(report, options);
  if (note !== null) lines.push('', note);

  const recommendations = renderRecommendations(report, options);
  if (recommendations.length > 0) {
    lines.push('', '### Recommendations', '');
    lines.push(...recommendations);
  }

  const skipped = report.categories.filter(
    (category) => category.status === 'not-applicable',
  );
  if (skipped.length > 0) {
    lines.push(
      '',
      '<details><summary>Categories that could not be scored</summary>',
      '',
    );
    for (const category of skipped) {
      const hint = category.hint === undefined ? '' : ` ${category.hint}`;
      lines.push(
        `- **${CATEGORY_LABELS[category.category]}** — ${category.reason}.${hint}`,
      );
    }
    lines.push('', '</details>');
  }

  return `${lines.join('\n')}\n`;
}

interface Comparison {
  readonly delta: number;
  /** Set when the two scans could not score the same categories. */
  readonly sharedOnly: readonly CategoryId[] | null;
}

/**
 * Compare two reports over the categories both of them actually scored.
 *
 * The two headline scores are not directly comparable unless both scans covered
 * the same categories, because an N/A category redistributes its weight across
 * the rest: a baseline checked out into a bare worktree has no `node_modules`,
 * reports licenses as N/A, and so carries a different total than an identical
 * tree with dependencies installed. Subtracting those totals reports a change
 * the pull request did not make.
 *
 * Restricting both sides to the shared categories and renormalising fixes it.
 * `effectiveWeight` is already proportional to the configured weight, so
 * renormalising over a subset recovers the original ratios. The alternative —
 * hiding the delta whenever coverage differs — suppressed it on the most common
 * setup there is, a JS project that runs `npm ci` before the scan.
 */
function compare(report: Report, baseline: Report): Comparison | null {
  const inBoth = CATEGORY_IDS.filter(
    (id) =>
      scoredCategory(report, id) !== undefined &&
      scoredCategory(baseline, id) !== undefined,
  );
  if (inBoth.length === 0) return null;

  const full =
    inBoth.length === scoredCount(report) &&
    inBoth.length === scoredCount(baseline);

  // Identical coverage: the engine already rounded both totals, so subtract the
  // published numbers rather than recomputing and risking an off-by-one against
  // the score printed right next to it.
  if (full) {
    return { delta: report.score - baseline.score, sharedOnly: null };
  }

  const delta =
    Math.round(weightedAverage(report, inBoth)) -
    Math.round(weightedAverage(baseline, inBoth));

  return { delta, sharedOnly: inBoth };
}

function weightedAverage(report: Report, ids: readonly CategoryId[]): number {
  const categories = ids
    .map((id) => scoredCategory(report, id))
    .filter((category) => category !== undefined);

  const totalWeight = categories.reduce(
    (sum, category) => sum + category.effectiveWeight,
    0,
  );
  if (totalWeight === 0) return 0;

  return (
    categories.reduce(
      (sum, category) => sum + category.score * category.effectiveWeight,
      0,
    ) / totalWeight
  );
}

function scoredCategory(
  report: Report,
  id: CategoryId,
): ScoredCategory | undefined {
  const category = report.categories.find((c) => c.category === id);
  return category?.status === 'scored' ? category : undefined;
}

function scoredCount(report: Report): number {
  return report.categories.filter((category) => category.status === 'scored')
    .length;
}

function renderTotalDelta(report: Report, options: PrCommentOptions): string {
  if (options.baseline === undefined) return '';

  const comparison = compare(report, options.baseline);
  if (comparison === null || comparison.delta === 0) return '';

  const base = options.baseBranch ?? 'the base branch';
  const arrow =
    comparison.delta > 0
      ? `▲ ${comparison.delta}`
      : `▼ ${Math.abs(comparison.delta)}`;

  return ` — ${arrow} vs ${base}`;
}

/** Says so, in the comment, whenever the delta above covers less than everything. */
function renderComparisonNote(
  report: Report,
  options: PrCommentOptions,
): string | null {
  if (options.baseline === undefined) return null;

  const base = options.baseBranch ?? 'the base branch';
  const comparison = compare(report, options.baseline);

  if (comparison === null) {
    return `_No category could be scored on both this branch and ${base}, so there is no comparison to draw._`;
  }
  if (comparison.sharedOnly === null) return null;

  const shared = comparison.sharedOnly
    .map((id) => CATEGORY_LABELS[id])
    .join(', ');

  return `_The delta compares only the categories both scans could score (${shared}). The rest were N/A on one side — most often \`node_modules\`, which is absent from the ${base} checkout — and an N/A category redistributes its weight, so including it would report a change this pull request did not make._`;
}

function renderTable(report: Report, options: PrCommentOptions): string[] {
  const withDelta = options.baseline !== undefined;
  const header = withDelta
    ? ['| Category | Score | Δ | Status |', '|---|---|---|---|']
    : ['| Category | Score | Status |', '|---|---|---|'];

  const rows = CATEGORY_IDS.flatMap((id) => {
    const category = report.categories.find((c) => c.category === id);
    if (category === undefined) return [];

    const label = CATEGORY_LABELS[id];
    const score = category.status === 'scored' ? String(category.score) : 'N/A';
    const status = renderStatus(category);

    if (!withDelta) return [`| ${label} | ${score} | ${status} |`];

    return [
      `| ${label} | ${score} | ${renderCategoryDelta(id, report, options.baseline)} | ${status} |`,
    ];
  });

  return [...header, ...rows];
}

function renderCategoryDelta(
  id: CategoryId,
  report: Report,
  baseline: Report | undefined,
): string {
  if (baseline === undefined) return '';

  const head = report.categories.find((c) => c.category === id);
  const base = baseline.categories.find((c) => c.category === id);

  // A category that changed applicability tells the reader more than a number.
  if (head?.status !== 'scored' || base?.status !== 'scored') {
    return head?.status === base?.status ? '=' : '—';
  }

  const delta = head.score - base.score;
  if (delta === 0) return '=';
  return delta > 0 ? `▲ ${delta}` : `▼ ${Math.abs(delta)}`;
}

/** Ranked worst-first, matching the engine's ordering of `report.findings`. */
const SEVERITY_RANK: Record<Finding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function renderStatus(category: CategoryReport): string {
  if (category.status === 'not-applicable') return '➖ not scored';
  if (category.hardZeroed === true) {
    return '🚨 critical secret found — category zeroed';
  }
  if (category.findings.length === 0) return '✅';

  const count = category.findings.length;
  const noun = count === 1 ? 'issue' : 'issues';

  // A category's own findings arrive in whatever order its module produced
  // them; only the report-wide list is sorted. Reading findings[0] as "the
  // worst" silently understates a category holding [low, critical].
  const worst = worstSeverity(category.findings);
  const callout =
    worst === 'critical' || worst === 'high' ? ` (worst: ${worst})` : '';

  return `⚠️ ${count} ${noun}${callout}`;
}

function worstSeverity(findings: readonly Finding[]): Finding['severity'] {
  return findings.reduce<Finding['severity']>(
    (worst, finding) =>
      SEVERITY_RANK[finding.severity] < SEVERITY_RANK[worst]
        ? finding.severity
        : worst,
    'info',
  );
}

/**
 * Findings the PR is responsible for, newest problems first.
 *
 * With a baseline, pre-existing findings are filtered out: a reviewer needs to
 * know what *this change* broke, not the repo's whole backlog. Without one,
 * every finding is fair game.
 */
function renderRecommendations(
  report: Report,
  options: PrCommentOptions,
): string[] {
  const preexisting = new Set(
    (options.baseline?.findings ?? []).map(fingerprint),
  );
  const introduced = report.findings.filter(
    (finding) => !preexisting.has(fingerprint(finding)),
  );

  const shown = introduced.slice(0, MAX_RECOMMENDATIONS);
  const lines = shown.map((finding, index) => {
    const location =
      finding.file === undefined
        ? ''
        : ` (\`${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}\`)`;
    return `${index + 1}. **${finding.problem}**${location}\n   ${finding.fix}`;
  });

  const hidden = introduced.length - shown.length;
  if (hidden > 0) {
    lines.push(
      '',
      `_…and ${hidden} more. See the full JSON report in this run's artifacts._`,
    );
  }

  return lines;
}

/** Identity of a finding across two scans of slightly different trees. */
function fingerprint(finding: Finding): string {
  return `${finding.severity}::${finding.problem}::${finding.file ?? ''}`;
}
