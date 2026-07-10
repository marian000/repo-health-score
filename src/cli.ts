import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderBadge } from './output/badge.js';
import { renderJsonReport } from './output/json-report.js';
import { renderPrComment } from './output/pr-comment.js';
import { scanRepository } from './orchestrator.js';
import { RefNotFoundError, withRefWorktree } from './util/worktree.js';
import type { Report } from './scoring/engine.js';

const USAGE = `
repo-health-score — score a repository 0-100 on security, maintainability, and DX

Usage:
  npx repo-health-score [path] [options]

Options:
  --fail-under <n>    Exit with code 1 if the score is below n (default: never fail)
  --json <file>       Write the full JSON report to a file
  --badge <file>      Write the badge SVG to a file
  --comment <file>    Write the PR comment markdown to a file
  --base-ref <ref>    Scan this ref too, and report the comment as a delta
                      against it (e.g. origin/main). Requires full history.
  --quiet             Suppress progress output
  --help              Show this message

Exit codes:
  0  scan completed (and, if --fail-under was given, the score met the threshold)
  1  score below --fail-under
  2  the scan itself failed
`;

export interface CliResult {
  readonly exitCode: number;
  readonly report?: Report;
}

/**
 * Parse arguments, scan the repository, render the requested outputs.
 *
 * Returns the exit code rather than calling `process.exit`, so tests can drive
 * the whole CLI without tearing down the test runner.
 */
export async function main(
  argv: readonly string[],
  toolVersion: string,
): Promise<CliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        'fail-under': { type: 'string' },
        json: { type: 'string' },
        badge: { type: 'string' },
        comment: { type: 'string' },
        'base-ref': { type: 'string' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${message(error)}\n${USAGE}`);
    return { exitCode: 2 };
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return { exitCode: 0 };
  }

  const threshold = parseThreshold(values['fail-under']);
  if (threshold instanceof Error) {
    process.stderr.write(`${threshold.message}\n`);
    return { exitCode: 2 };
  }

  const repoRoot = resolve(positionals[0] ?? '.');
  const log = values.quiet
    ? () => undefined
    : (text: string) => process.stderr.write(`${text}\n`);

  let report: Report;
  try {
    report = await scanRepository({ repoRoot, log });
  } catch (error) {
    process.stderr.write(`Scan failed: ${message(error)}\n`);
    return { exitCode: 2 };
  }

  const baseRef = values['base-ref'];

  // The baseline is a second full scan — Gitleaks over the whole tree again.
  // Only the comment consumes it, so computing it for `--json` alone would
  // double the runtime and discard the result.
  if (baseRef !== undefined && values.comment === undefined) {
    process.stderr.write(
      '--base-ref only affects the PR comment, and --comment was not given. Skipping the baseline scan.\n',
    );
  }
  const baseline =
    baseRef === undefined || values.comment === undefined
      ? undefined
      : await scanBaseline(repoRoot, baseRef, log);

  await Promise.all([
    values.json === undefined
      ? undefined
      : write(
          values.json,
          renderJsonReport(report, {
            generatedAt: new Date().toISOString(),
            toolVersion,
          }),
        ),
    values.badge === undefined
      ? undefined
      : write(values.badge, renderBadge(report)),
    values.comment === undefined
      ? undefined
      : write(
          values.comment,
          renderPrComment(report, {
            ...(baseline === undefined ? {} : { baseline }),
            ...(baseRef === undefined ? {} : { baseBranch: baseRef }),
          }),
        ),
  ]);

  process.stdout.write(renderSummary(report));

  // Without --fail-under the tool is a reporter, not a gate. Exiting non-zero
  // by default would break every pipeline that adopts it before the maintainers
  // have had a chance to fix anything.
  if (threshold !== null && report.score < threshold) {
    process.stderr.write(
      `\nScore ${report.score} is below the --fail-under threshold of ${threshold}.\n`,
    );
    return { exitCode: 1, report };
  }

  return { exitCode: 0, report };
}

/**
 * Scan the base ref, in a throwaway worktree, at this same moment.
 *
 * Both halves of that sentence matter. A worktree keeps the user's checkout
 * untouched, and scanning *now* rather than reusing a score stored from the
 * last run on the base branch is what makes the delta mean "this pull request
 * did it": a CVE published in the meantime appears in both reports and cancels
 * out, while a dependency the branch added appears only in the head report.
 *
 * A baseline is a nicety. Failing the whole run because the base ref is missing
 * — the default on a shallow CI checkout — would trade a complete report for no
 * report at all, so this degrades to no delta and says why.
 */
async function scanBaseline(
  repoRoot: string,
  baseRef: string,
  log: (message: string) => void,
): Promise<Report | undefined> {
  log(`Scanning ${baseRef} for comparison…`);

  try {
    return await withRefWorktree(repoRoot, baseRef, (worktreeRoot) =>
      scanRepository({ repoRoot: worktreeRoot, log }),
    );
  } catch (error) {
    const hint =
      error instanceof RefNotFoundError
        ? ' Fetch it first — in GitHub Actions, check out with `fetch-depth: 0`.'
        : '';
    process.stderr.write(
      `Could not scan the base ref "${baseRef}", so the report has no delta: ${message(error)}.${hint}\n`,
    );
    return undefined;
  }
}

function renderSummary(report: Report): string {
  const lines = [
    ``,
    `Repo Health Score: ${report.grade} (${report.score}/100)`,
    ``,
  ];

  for (const category of report.categories) {
    if (category.status === 'not-applicable') {
      lines.push(`  ${pad(category.category)} n/a   ${category.reason}`);
      continue;
    }
    const note =
      category.hardZeroed === true
        ? 'critical secret found — category zeroed'
        : category.findings.length === 0
          ? 'ok'
          : `${category.findings.length} finding(s)`;
    lines.push(
      `  ${pad(category.category)} ${String(category.score).padStart(3)}   ${note}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function pad(text: string): string {
  return text.padEnd(14);
}

/** Returns null when the flag is absent, an Error when it is present but unusable. */
function parseThreshold(raw: string | undefined): number | null | Error {
  if (raw === undefined) return null;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return new Error(
      `--fail-under must be an integer between 0 and 100, got "${raw}".`,
    );
  }
  return value;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), content, 'utf8');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
