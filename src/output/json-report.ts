import { GITLEAKS_VERSION } from '../util/gitleaks-binary.js';
import type { Report } from '../scoring/engine.js';

/**
 * Schema version of the emitted JSON.
 *
 * The report is the documented artifact of every run and the intended basis for
 * score history in v1. Consumers need to know when its shape changes, and a
 * version they can branch on is cheaper than making them guess from the keys.
 */
export const REPORT_SCHEMA_VERSION = 1;

export interface JsonReportOptions {
  /** ISO-8601. Passed in rather than read from the clock, so runs are reproducible in tests. */
  readonly generatedAt: string;
  readonly toolVersion: string;
}

/**
 * Serialise a report as stable, diffable JSON.
 *
 * Keys are emitted in a fixed order and categories are already sorted
 * canonically by the engine, so two runs on an unchanged repo differ only in
 * `generatedAt`. That is what makes the artifact usable as history: a diff
 * shows what changed about the repository, not how the serialiser felt.
 */
export function renderJsonReport(
  report: Report,
  options: JsonReportOptions,
): string {
  return `${JSON.stringify(
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      generatedAt: options.generatedAt,
      tool: {
        name: 'repo-health-score',
        version: options.toolVersion,
        gitleaksVersion: GITLEAKS_VERSION,
      },
      score: report.score,
      grade: report.grade,
      categories: report.categories.map((category) =>
        category.status === 'scored'
          ? {
              id: category.category,
              status: category.status,
              score: category.score,
              rawScore: category.rawScore,
              weight: Number(category.effectiveWeight.toFixed(6)),
              hardZeroed: category.hardZeroed ?? false,
              findings: category.findings,
            }
          : {
              id: category.category,
              status: category.status,
              reason: category.reason,
              ...(category.hint === undefined ? {} : { hint: category.hint }),
            },
      ),
    },
    null,
    2,
  )}\n`;
}
