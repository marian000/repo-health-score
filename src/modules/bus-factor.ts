import { run } from '../util/exec.js';
import { isSourceFile, listTrackedFiles } from '../util/source-files.js';
import {
  notApplicable,
  scored,
  type CategoryResult,
  type Finding,
  type ScanContext,
  type ScanModule,
} from './types.js';

/**
 * Commit authors that are automation, not people.
 *
 * Left in, they inflate the contributor count of every file they touch: a
 * lockfile bumped weekly by Dependabot looks collaboratively maintained when
 * exactly one human has ever read it. Matched against author name and email.
 */
const BOT_PATTERNS: readonly RegExp[] = [
  /\[bot\]/i,
  /^dependabot/i,
  /^renovate(\[bot\])?$/i,
  /^github-actions/i,
  /^greenkeeper/i,
  /^snyk-bot/i,
  /noreply@github\.com$/i,
];

/** A file is "critical" if it lands in the top slice of source files by churn. */
const CRITICAL_FILE_PERCENTILE = 0.2;

/** Below this, "the top 20% of files" is not a sample, it is a coin flip. */
const MIN_SOURCE_FILES = 10;

/**
 * Below this many commits, churn carries no signal: every file has been touched
 * once, ranking them by commit count sorts ties arbitrarily, and whichever
 * files land on top get called critical for no reason.
 */
const MIN_COMMITS = 20;

interface FileAuthorship {
  readonly path: string;
  readonly commits: number;
  readonly authors: ReadonlySet<string>;
}

export const busFactorModule: ScanModule = {
  category: 'bus-factor',
  name: 'Bus factor',

  async scan(context: ScanContext): Promise<CategoryResult> {
    if (!context.isGitRepo) {
      return notApplicable(
        'Not a git repository, so there is no history to analyse',
        'Run against a git checkout rather than an exported archive.',
      );
    }

    // A shallow clone has one commit of history. `git log` succeeds, reports a
    // single author for every file, and this module would confidently score 0 —
    // the worst kind of wrong, because the number looks plausible.
    if (context.isShallowClone) {
      return notApplicable(
        'Shallow clone: git history is truncated, so authorship cannot be measured',
        'Check out with full history. In GitHub Actions: `actions/checkout@v4` with `fetch-depth: 0`.',
      );
    }

    const { files, commitCount } = await collectAuthorship(context);

    if (commitCount < MIN_COMMITS) {
      return notApplicable(
        `Only ${commitCount} non-merge commit(s) of history; too few to tell critical files from incidental ones`,
      );
    }

    if (files.length < MIN_SOURCE_FILES) {
      return notApplicable(
        `Only ${files.length} tracked source file(s); too few to identify a meaningful critical subset`,
      );
    }

    const critical = selectCriticalFiles(files);
    const soleAuthored = critical.filter((file) => file.authors.size === 1);

    return scored(
      Math.round((1 - soleAuthored.length / critical.length) * 100),
      soleAuthored.map(toFinding),
    );
  },
};

/**
 * Count commits and distinct human authors per file, in one pass over history.
 *
 * `git log --numstat` prints a header per commit followed by one line per
 * touched file, which attributes files to authors without running `git blame`
 * per file — blame on a large repo takes minutes; this takes seconds.
 *
 * It measures who *changed* a file rather than who owns each surviving line.
 * For the question bus factor actually asks — if this person leaves, who
 * understands this code — change history is the better proxy anyway.
 */
async function collectAuthorship(
  context: ScanContext,
): Promise<{ files: FileAuthorship[]; commitCount: number }> {
  const { stdout } = await run(
    'git',
    ['log', '--numstat', '--no-merges', '--format=%x00%aN%x00%aE'],
    { cwd: context.repoRoot, timeoutMs: 120_000 },
  );

  const commits = new Map<string, number>();
  const authors = new Map<string, Set<string>>();
  let currentAuthor: string | null = null;
  let commitCount = 0;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('\0')) {
      commitCount += 1;
      const [, name = '', email = ''] = line.split('\0');
      currentAuthor = isBot(name, email) ? null : name;
      continue;
    }
    if (currentAuthor === null || line.trim() === '') continue;

    // "added<TAB>deleted<TAB>path". Binary files report "-" for both counts.
    const path = line.split('\t')[2];
    if (path === undefined || !isSourceFile(path)) continue;

    commits.set(path, (commits.get(path) ?? 0) + 1);
    let fileAuthors = authors.get(path);
    if (fileAuthors === undefined) {
      fileAuthors = new Set();
      authors.set(path, fileAuthors);
    }
    fileAuthors.add(currentAuthor);
  }

  // Files that only exist in history, deleted since, would skew the sample.
  const tracked = new Set(await listTrackedFiles(context.repoRoot));

  const files = [...commits.entries()]
    .filter(([path]) => tracked.has(path))
    .map(([path, count]) => ({
      path,
      commits: count,
      authors: authors.get(path) ?? new Set<string>(),
    }));

  return { files, commitCount };
}

/**
 * The most-churned source files.
 *
 * Churn is the proxy for criticality: a file nobody has needed to change since
 * it was written carries little risk if its author leaves, however central it
 * looks in the dependency graph.
 */
function selectCriticalFiles(
  files: readonly FileAuthorship[],
): readonly FileAuthorship[] {
  const ranked = [...files].sort(
    (a, b) => b.commits - a.commits || a.path.localeCompare(b.path),
  );
  const count = Math.max(
    1,
    Math.ceil(ranked.length * CRITICAL_FILE_PERCENTILE),
  );
  return ranked.slice(0, count);
}

function toFinding(file: FileAuthorship): Finding {
  const [author = 'unknown'] = file.authors;
  return {
    severity: file.commits >= 10 ? 'medium' : 'low',
    problem: `\`${file.path}\` has a single contributor (${author}) across ${file.commits} commit(s)`,
    fix: `Have a second maintainer review or co-author changes to \`${file.path}\`, and document its design so the knowledge outlives one person.`,
    file: file.path,
  };
}

function isBot(name: string, email: string): boolean {
  return BOT_PATTERNS.some(
    (pattern) => pattern.test(name) || pattern.test(email),
  );
}
