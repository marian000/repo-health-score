import { describe, expect, it } from 'vitest';
import {
  calculateScore,
  resolveWeights,
  toGrade,
  type Weights,
} from '../../src/scoring/engine.js';
import {
  CATEGORY_IDS,
  clampScore,
  notApplicable,
  scored,
  type CategoryId,
  type CategoryResult,
  type Finding,
} from '../../src/modules/types.js';

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'medium',
  problem: 'Something is wrong',
  fix: 'Make it right',
  ...overrides,
});

const results = (
  entries: Partial<Record<CategoryId, CategoryResult>>,
): Map<CategoryId, CategoryResult> =>
  new Map(Object.entries(entries) as [CategoryId, CategoryResult][]);

const perfect = () =>
  results({
    secrets: scored(100),
    dependencies: scored(100),
    licenses: scored(100),
    docs: scored(100),
    'bus-factor': scored(100),
  });

describe('toGrade', () => {
  it.each([
    [100, 'A'],
    [90, 'A'],
    [89, 'B'],
    [80, 'B'],
    [70, 'C'],
    [60, 'D'],
    [50, 'E'],
    [49, 'F'],
    [0, 'F'],
  ])('scores %i as %s', (score, grade) => {
    expect(toGrade(score)).toBe(grade);
  });
});

describe('calculateScore', () => {
  it('averages the categories by weight', () => {
    const report = calculateScore(perfect());
    expect(report.score).toBe(100);
    expect(report.grade).toBe('A');
  });

  it('reproduces the worked example from the spec', () => {
    // secrets 100, deps 60, licenses 100, docs 70, bus-factor 60
    // = 30 + 15 + 15 + 10.5 + 9 = 79.5 -> 80
    const report = calculateScore(
      results({
        secrets: scored(100),
        dependencies: scored(60),
        licenses: scored(100),
        docs: scored(70),
        'bus-factor': scored(60),
      }),
    );
    expect(report.score).toBe(80);
    expect(report.grade).toBe('B');
  });

  describe('secrets hard-zero', () => {
    it('zeroes the secrets category on any critical finding, whatever the module scored', () => {
      const report = calculateScore(
        results({
          ...Object.fromEntries(perfect()),
          secrets: scored(95, [finding({ severity: 'critical' })]),
        }),
      );

      const secrets = report.categories.find((c) => c.category === 'secrets');
      expect(secrets).toMatchObject({
        status: 'scored',
        rawScore: 95,
        score: 0,
        hardZeroed: true,
      });
      // 100 across the other 70% of weight, 0 across secrets' 30%.
      expect(report.score).toBe(70);
    });

    it('does not hard-zero on a non-critical secrets finding', () => {
      const report = calculateScore(
        results({
          ...Object.fromEntries(perfect()),
          secrets: scored(90, [finding({ severity: 'high' })]),
        }),
      );
      const secrets = report.categories.find((c) => c.category === 'secrets');
      expect(secrets).toMatchObject({ score: 90 });
      expect(secrets).not.toHaveProperty('hardZeroed');
    });

    it('does not hard-zero other categories on a critical finding', () => {
      const report = calculateScore(
        results({
          ...Object.fromEntries(perfect()),
          dependencies: scored(40, [finding({ severity: 'critical' })]),
        }),
      );
      const deps = report.categories.find((c) => c.category === 'dependencies');
      expect(deps).toMatchObject({ score: 40 });
    });
  });

  describe('N/A redistribution', () => {
    it('never awards a free 100 to a skipped category', () => {
      // Repo with no dependency manifest: deps is N/A, everything else is 50.
      // A free 100 would give 62.5; redistribution correctly gives 50.
      const report = calculateScore(
        results({
          secrets: scored(50),
          dependencies: notApplicable('No manifest'),
          licenses: scored(50),
          docs: scored(50),
          'bus-factor': scored(50),
        }),
      );
      expect(report.score).toBe(50);
    });

    it('redistributes weight proportionally across applicable categories', () => {
      // deps (0.25) is N/A. Remaining weight 0.75 renormalises:
      // secrets 0.30/0.75 = 0.4, licenses/docs/bus-factor 0.2 each.
      const report = calculateScore(
        results({
          secrets: scored(100),
          dependencies: notApplicable('No manifest'),
          licenses: scored(0),
          docs: scored(0),
          'bus-factor': scored(0),
        }),
      );
      expect(report.score).toBe(40);

      const secrets = report.categories.find((c) => c.category === 'secrets');
      expect(secrets?.status).toBe('scored');
      expect(
        secrets?.status === 'scored' ? secrets.effectiveWeight : null,
      ).toBeCloseTo(0.4, 10);
    });

    it('effective weights of scored categories always sum to 1', () => {
      const report = calculateScore(
        results({
          secrets: scored(80),
          dependencies: notApplicable('No manifest'),
          licenses: notApplicable('No manifest'),
          docs: scored(70),
          'bus-factor': scored(60),
        }),
      );
      const total = report.categories
        .filter((c) => c.status === 'scored')
        .reduce((sum, c) => sum + c.effectiveWeight, 0);
      expect(total).toBeCloseTo(1, 10);
    });

    it('preserves the reason and hint for skipped categories', () => {
      const report = calculateScore(
        results({
          secrets: scored(100),
          'bus-factor': notApplicable('Shallow clone', 'Use fetch-depth: 0'),
        }),
      );
      expect(report.categories).toContainEqual({
        category: 'bus-factor',
        status: 'not-applicable',
        reason: 'Shallow clone',
        hint: 'Use fetch-depth: 0',
      });
    });

    it('scores 0 with grade F when every category is N/A', () => {
      // Nothing was measured. 100 would read "healthy" and 0 reads "unhealthy";
      // both lie, but F at least prompts the user to look at the reasons.
      const report = calculateScore(
        results({
          secrets: notApplicable('a'),
          dependencies: notApplicable('b'),
          licenses: notApplicable('c'),
          docs: notApplicable('d'),
          'bus-factor': notApplicable('e'),
        }),
      );
      expect(report.score).toBe(0);
      expect(report.grade).toBe('F');
      expect(report.categories).toHaveLength(5);
      expect(report.findings).toEqual([]);
    });

    it('keeps scored categories and their findings when another category is N/A', () => {
      // Regression: an early-return path once dropped every scored category
      // from the report whenever the applicable weight summed to zero.
      const report = calculateScore(
        results({
          secrets: notApplicable('Gitleaks download failed'),
          dependencies: scored(60, [finding({ problem: 'CVE-2026-1' })]),
          licenses: scored(100),
          docs: scored(70),
          'bus-factor': scored(60),
        }),
      );
      expect(report.categories).toHaveLength(5);
      expect(
        report.categories.filter((c) => c.status === 'scored'),
      ).toHaveLength(4);
      expect(report.findings.map((f) => f.problem)).toEqual(['CVE-2026-1']);
    });
  });

  describe('zero-weight configs', () => {
    it('throws rather than silently reporting F when every scored category has weight 0', () => {
      // The user zeroed everything but secrets, and secrets could not run. An F
      // here would read as a verdict on the repo; it is a verdict on the config.
      const weights: Weights = {
        secrets: 1,
        dependencies: 0,
        licenses: 0,
        docs: 0,
        'bus-factor': 0,
      };
      expect(() =>
        calculateScore(
          results({
            secrets: notApplicable('Gitleaks download failed'),
            dependencies: scored(60, [finding()]),
            licenses: scored(100),
          }),
          weights,
        ),
      ).toThrow(/weight of 0/);
    });

    it('does not throw when nothing was scored at all', () => {
      const weights: Weights = {
        secrets: 0,
        dependencies: 0,
        licenses: 0,
        docs: 0,
        'bus-factor': 0,
      };
      const report = calculateScore(
        results({ secrets: notApplicable('a') }),
        weights,
      );
      expect(report.score).toBe(0);
    });
  });

  describe('report ordering', () => {
    it('emits categories in canonical order regardless of insertion order', () => {
      // Modules resolve in whatever order they finish. A committed badge and a
      // diffable JSON artifact both require a stable row order.
      const shuffled = new Map<CategoryId, CategoryResult>([
        ['bus-factor', scored(60)],
        ['docs', scored(70)],
        ['secrets', scored(100)],
        ['licenses', notApplicable('No manifest')],
        ['dependencies', scored(60)],
      ]);
      const report = calculateScore(shuffled);
      expect(report.categories.map((c) => c.category)).toEqual([
        ...CATEGORY_IDS,
      ]);
    });
  });

  it('collects findings across categories, worst severity first', () => {
    const report = calculateScore(
      results({
        secrets: scored(100, [finding({ severity: 'low', problem: 'low' })]),
        docs: scored(50, [
          finding({ severity: 'high', problem: 'high' }),
          finding({ severity: 'info', problem: 'info' }),
        ]),
        dependencies: scored(50, [
          finding({ severity: 'medium', problem: 'medium' }),
        ]),
      }),
    );
    expect(report.findings.map((f) => f.problem)).toEqual([
      'high',
      'medium',
      'low',
      'info',
    ]);
  });

  it('honours custom weights', () => {
    const weights: Weights = {
      secrets: 1,
      dependencies: 0,
      licenses: 0,
      docs: 0,
      'bus-factor': 0,
    };
    const report = calculateScore(
      results({
        secrets: scored(42),
        dependencies: scored(100),
        licenses: scored(100),
        docs: scored(100),
        'bus-factor': scored(100),
      }),
      weights,
    );
    expect(report.score).toBe(42);
  });
});

describe('resolveWeights', () => {
  it('merges overrides over defaults', () => {
    expect(resolveWeights({ secrets: 0.5 })).toMatchObject({
      secrets: 0.5,
      dependencies: 0.25,
    });
  });

  it('accepts weights that do not sum to 1, since the engine normalises', () => {
    const weights = resolveWeights({ secrets: 100 });
    const report = calculateScore(
      results({ secrets: scored(80), docs: scored(0) }),
      weights,
    );
    // secrets 100 vs docs 0.15 -> secrets dominates
    expect(report.score).toBe(80);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid weight %s',
    (weight) => {
      expect(() => resolveWeights({ secrets: weight })).toThrow(
        /Invalid weight/,
      );
    },
  );

  it('rejects an unknown category rather than silently ignoring it', () => {
    // A user who typed "secret" for "secrets" has a config that does nothing.
    // Scoring them against defaults they believe they overrode is worse than
    // refusing to start.
    expect(() => resolveWeights({ secret: 0.5 })).toThrow(
      /Unknown category "secret"/,
    );
  });

  it('rejects a weights.json that is missing a category', () => {
    // Guards the runtime shape, not the compile-time one: a contributor adding
    // a module can drop a key from weights.json without TypeScript noticing.
    const incomplete: Record<string, unknown> = { secrets: 0.3 };
    const merged = { ...incomplete };
    delete (merged as Record<string, unknown>)['dependencies'];
    expect(() => resolveWeights({ ...merged, docs: undefined })).toThrow(
      /Invalid weight for "docs"/,
    );
  });

  it('accepts a weight of 0 for a single category', () => {
    expect(resolveWeights({ 'bus-factor': 0 })['bus-factor']).toBe(0);
  });
});

describe('clampScore', () => {
  it.each([
    [50, 50],
    [0, 0],
    [100, 100],
    [-15, 0],
    [130, 100],
    [79.5, 80],
    [79.4, 79],
  ])('clamps %s to %s', (input, expected) => {
    expect(clampScore(input)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'maps the non-finite value %s to 0 rather than poisoning the average',
    (input) => {
      expect(clampScore(input)).toBe(0);
    },
  );
});
