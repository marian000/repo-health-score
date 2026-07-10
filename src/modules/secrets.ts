import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { run } from '../util/exec.js';
import {
  resolveGitleaks,
  UnsupportedPlatformError,
} from '../util/gitleaks-binary.js';
import {
  notApplicable,
  scored,
  type CategoryResult,
  type Finding,
  type ScanContext,
  type ScanModule,
  type Severity,
} from './types.js';

/**
 * Gitleaks rules whose matches are not worth a hard zero.
 *
 * A `critical` secrets finding zeroes 30% of the total score outright, so the
 * bar for critical must be "this is almost certainly a live credential". The
 * generic and entropy-based rules match high-entropy strings — test fixtures,
 * base64 blobs, minified assets — often enough that letting them zero a repo's
 * score would train users to ignore the category entirely.
 *
 * Provider-specific rules (an AWS key, a Stripe live key) have a distinctive
 * shape and near-zero false-positive rate. Those are the criticals.
 */
const LOW_CONFIDENCE_RULES: readonly RegExp[] = [
  /^generic-api-key$/,
  /entropy/i,
  /^curl-auth-header$/,
];

/** Rules that match a credential which is safe by construction. */
const IGNORED_RULES: readonly string[] = ['jwt-base64'];

interface GitleaksFinding {
  readonly RuleID: string;
  readonly Description: string;
  readonly File: string;
  readonly StartLine: number;
  readonly Match: string;
}

export const secretsModule: ScanModule = {
  category: 'secrets',
  name: 'Exposed secrets',

  async scan(context: ScanContext): Promise<CategoryResult> {
    let gitleaks: string;
    try {
      gitleaks = await resolveGitleaks();
    } catch (error) {
      if (error instanceof UnsupportedPlatformError) {
        return notApplicable(
          `No Gitleaks build is available for this platform (${process.platform}-${process.arch})`,
          'Install Gitleaks manually and set REPO_HEALTH_GITLEAKS_PATH to its location.',
        );
      }
      // A checksum mismatch or a failed download is not a repo problem, and
      // scoring 100 would tell the user their secrets are clean when nothing
      // was scanned. Surface it as a gap, with the reason intact.
      return notApplicable(
        `Gitleaks could not be prepared: ${message(error)}`,
        'Set REPO_HEALTH_GITLEAKS_PATH to a pre-installed Gitleaks binary, or check network access.',
      );
    }

    const { findings, usedRepoConfig } = await detect(context, gitleaks);

    const relevant = findings.filter(
      (finding) => !IGNORED_RULES.includes(finding.RuleID),
    );

    // Disclose that the repository chose the rules it was judged by. On a
    // `pull_request` run the head tree is attacker-controlled, so a PR can add
    // a catch-all allowlist and score 100. Honouring the config is still right
    // — fixtures need it — but the number must never be produced silently
    // under rules the scanned repo supplied.
    const disclosures: Finding[] = usedRepoConfig
      ? [
          {
            severity: 'info',
            problem:
              "Secret scanning used the rules and allowlist in the repository's own `.gitleaks.toml`",
            fix: 'Review `.gitleaks.toml` when reading this score: an allowlist there can suppress real findings.',
            file: '.gitleaks.toml',
          },
        ]
      : [];

    if (relevant.length === 0) return scored(100, disclosures);

    const leaks = relevant.map((finding) =>
      toFinding(finding, context.repoRoot),
    );

    // Penalise the leaks only. The disclosure above is informational; scoring
    // it would dock a repo for having a .gitleaks.toml at all.
    //
    // The engine hard-zeroes this category on any critical finding, so this
    // score is only ever consulted when every match is low-confidence.
    const penalty = leaks.reduce(
      (sum, finding) => sum + (finding.severity === 'high' ? 25 : 10),
      0,
    );

    return scored(100 - penalty, [...leaks, ...disclosures]);
  },
};

/**
 * Scan the working tree, not git history.
 *
 * `gitleaks dir` reads files as they are on disk. The alternative, scanning
 * history, finds every secret ever committed — including ones rotated years
 * ago, which cannot be removed without rewriting history. That would pin a
 * permanent zero on 30% of the score with no reachable remedy, so history
 * scanning is a separate opt-in rather than the default.
 */
async function detect(
  context: ScanContext,
  gitleaks: string,
): Promise<{ findings: GitleaksFinding[]; usedRepoConfig: boolean }> {
  const staging = await mkdtemp(join(tmpdir(), 'repo-health-secrets-'));
  const reportPath = join(staging, 'report.json');

  try {
    const args = [
      'dir',
      context.repoRoot,
      '--report-format',
      'json',
      '--report-path',
      reportPath,
      '--no-banner',
      '--exit-code',
      '0',
    ];

    // Respect a project's own allowlist when it has one. This keeps the tool
    // zero-config — the file is optional — while letting a repo exempt the
    // test fixtures it deliberately plants secrets in.
    const configPath = join(context.repoRoot, '.gitleaks.toml');
    const usedRepoConfig = await exists(configPath);
    if (usedRepoConfig) {
      context.log("Using the repository's .gitleaks.toml allowlist");
      args.push('--config', configPath);
    }

    await run(gitleaks, args, { cwd: context.repoRoot, timeoutMs: 180_000 });

    // Gitleaks writes no report file when it finds nothing.
    if (!(await exists(reportPath))) return { findings: [], usedRepoConfig };

    const parsed: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
    return {
      findings: Array.isArray(parsed) ? (parsed as GitleaksFinding[]) : [],
      usedRepoConfig,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function toFinding(finding: GitleaksFinding, repoRoot: string): Finding {
  const severity = severityOf(finding.RuleID);
  // Gitleaks echoes back the path it was given, and it is given an absolute
  // one. Left as-is, every PR comment would publish the maintainer's home
  // directory, and paths would not match the repo-relative ones other modules
  // report from `git ls-files`.
  const file = toRepoRelative(finding.File, repoRoot);

  return {
    severity,
    problem: `${finding.Description || finding.RuleID} in \`${file}\``,
    fix:
      severity === 'critical'
        ? `Revoke this credential now — it must be assumed compromised the moment it was committed. Then remove it from \`${file}\`, load it from an environment variable instead, and purge it from git history with \`git filter-repo\`.`
        : `Confirm whether the match in \`${file}\` is a real credential. If it is, revoke and rotate it. If it is test data, add it to an allowlist in \`.gitleaks.toml\`.`,
    file,
    line: finding.StartLine,
    reference: finding.RuleID,
  };
}

function toRepoRelative(path: string, repoRoot: string): string {
  if (!isAbsolute(path)) return path;
  const relativePath = relative(repoRoot, path);
  // A path outside the repo would escape with `..`; keep it verbatim rather
  // than emit something that looks repo-relative but is not.
  return relativePath.startsWith('..') ? path : relativePath;
}

/**
 * Provider-specific rules are critical; generic pattern matches are high.
 *
 * Only `critical` triggers the engine's hard zero, so this function decides
 * whether a match costs a repo 30 points or 25.
 */
function severityOf(ruleId: string): Severity {
  return LOW_CONFIDENCE_RULES.some((pattern) => pattern.test(ruleId))
    ? 'high'
    : 'critical';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
