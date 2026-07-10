import { describe, expect, it } from 'vitest';
import {
  notApplicable,
  scored,
  type CategoryId,
  type CategoryResult,
  type Finding,
} from '../../src/modules/types.js';
import { calculateScore } from '../../src/scoring/engine.js';
import {
  COMMENT_MARKER,
  renderPrComment,
} from '../../src/output/pr-comment.js';

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'medium',
  problem: 'Something is wrong',
  fix: 'Make it right',
  ...overrides,
});

const reportOf = (entries: Partial<Record<CategoryId, CategoryResult>>) =>
  calculateScore(
    new Map(Object.entries(entries) as [CategoryId, CategoryResult][]),
  );

const clean = () =>
  reportOf({
    secrets: scored(100),
    dependencies: scored(100),
    licenses: scored(100),
    docs: scored(100),
    'bus-factor': scored(100),
  });

describe('renderPrComment', () => {
  it('leads with the marker that lets a later run edit this comment', () => {
    expect(renderPrComment(clean()).startsWith(COMMENT_MARKER)).toBe(true);
  });

  it('renders the score and grade in the heading', () => {
    expect(renderPrComment(clean())).toContain(
      '## 🩺 Repo Health Score: A (100/100)',
    );
  });

  it('omits the delta column when there is no baseline', () => {
    const comment = renderPrComment(clean());
    expect(comment).toContain('| Category | Score | Status |');
    expect(comment).not.toContain(' Δ ');
  });

  it('lists categories in canonical order, not scoring order', () => {
    const comment = renderPrComment(clean());
    const order = [
      'Secrets',
      'Dependencies',
      'Licenses',
      'Documentation',
      'Bus factor',
    ];
    const positions = order.map((label) => comment.indexOf(`| ${label} |`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  describe('with a baseline', () => {
    it('shows a drop against the base branch', () => {
      const baseline = clean();
      const head = reportOf({
        secrets: scored(100),
        dependencies: scored(60),
        licenses: scored(100),
        docs: scored(100),
        'bus-factor': scored(100),
      });

      const comment = renderPrComment(head, { baseline, baseBranch: 'main' });
      expect(comment).toContain('▼ 10 vs main');
      expect(comment).toContain('| Dependencies | 60 | ▼ 40 |');
    });

    it('shows an improvement', () => {
      const baseline = reportOf({ secrets: scored(50), docs: scored(50) });
      const head = reportOf({ secrets: scored(100), docs: scored(50) });
      expect(renderPrComment(head, { baseline })).toContain('▲');
    });

    it('marks unchanged categories with =', () => {
      const comment = renderPrComment(clean(), { baseline: clean() });
      expect(comment).toContain('| Secrets | 100 | = |');
    });

    it('marks a category that changed applicability with an em dash', () => {
      const baseline = reportOf({
        secrets: scored(100),
        dependencies: notApplicable('No manifest'),
      });
      const head = reportOf({
        secrets: scored(100),
        dependencies: scored(80),
      });
      expect(renderPrComment(head, { baseline })).toContain(
        '| Dependencies | 80 | — |',
      );
    });

    it('recommends only findings this PR introduced', () => {
      // The whole point of scanning the base branch at the same moment: a CVE
      // published since the last scan appears in both reports and cancels out,
      // while a dependency this PR added appears only in head.
      const preexisting = finding({ problem: 'Old CVE in `lib-a`' });
      const introduced = finding({ problem: 'New CVE in `lib-b`' });

      const baseline = reportOf({ dependencies: scored(75, [preexisting]) });
      const head = reportOf({
        dependencies: scored(50, [preexisting, introduced]),
      });

      const comment = renderPrComment(head, { baseline });
      expect(comment).toContain('New CVE in `lib-b`');
      expect(comment).not.toContain('Old CVE in `lib-a`');
    });

    it('omits the recommendations section when the PR introduced nothing', () => {
      const shared = finding({ problem: 'Pre-existing issue' });
      const baseline = reportOf({ docs: scored(50, [shared]) });
      const head = reportOf({ docs: scored(50, [shared]) });
      expect(renderPrComment(head, { baseline })).not.toContain(
        '### Recommendations',
      );
    });
  });

  describe('findings', () => {
    it('renders the fix alongside the problem', () => {
      const report = reportOf({
        dependencies: scored(60, [
          finding({
            problem: '`lib` has a CVE',
            fix: 'Upgrade `lib` to 2.3.',
            file: 'composer.lock',
          }),
        ]),
      });
      const comment = renderPrComment(report);
      expect(comment).toContain('**`lib` has a CVE**');
      expect(comment).toContain('Upgrade `lib` to 2.3.');
      expect(comment).toContain('(`composer.lock`)');
    });

    it('includes the line number when a finding has one', () => {
      const report = reportOf({
        docs: scored(50, [finding({ file: 'src/a.php', line: 42 })]),
      });
      expect(renderPrComment(report)).toContain('(`src/a.php:42`)');
    });

    it('truncates a long finding list and says how many were hidden', () => {
      const findings = Array.from({ length: 14 }, (_, i) =>
        finding({ problem: `Issue ${String(i)}` }),
      );
      const comment = renderPrComment(reportOf({ docs: scored(10, findings) }));
      expect(comment).toContain('and 4 more');
      expect(comment).not.toContain('Issue 13');
    });

    it('reports the worst severity in a category, not the first finding listed', () => {
      // Regression: only report.findings is sorted by severity. A category's
      // own list arrives in module order, so reading findings[0] understated
      // a category holding [low, critical].
      const report = reportOf({
        dependencies: scored(40, [
          finding({ severity: 'low', problem: 'minor' }),
          finding({ severity: 'critical', problem: 'severe' }),
        ]),
      });
      expect(renderPrComment(report)).toContain('(worst: critical)');
    });

    it('does not render a bare count in place of the severity for a single issue', () => {
      const report = reportOf({
        dependencies: scored(75, [finding({ severity: 'high' })]),
      });
      const comment = renderPrComment(report);
      expect(comment).toContain('⚠️ 1 issue (worst: high)');
      expect(comment).not.toContain('1 issue (1)');
    });

    it('announces a hard-zeroed secrets category unmistakably', () => {
      const report = reportOf({
        secrets: scored(100, [finding({ severity: 'critical' })]),
      });
      expect(renderPrComment(report)).toContain('🚨 critical secret found');
    });
  });

  it('explains categories that could not be scored, without scoring them', () => {
    const report = reportOf({
      secrets: scored(100),
      'bus-factor': notApplicable('Shallow clone', 'Use fetch-depth: 0.'),
    });
    const comment = renderPrComment(report);
    expect(comment).toContain('| Bus factor | N/A |');
    expect(comment).toContain('➖ not scored');
    expect(comment).toContain('Shallow clone');
    expect(comment).toContain('Use fetch-depth: 0.');
  });
});
