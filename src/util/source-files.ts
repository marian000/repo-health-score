/**
 * Which files count as hand-maintained source.
 *
 * Shared by docs and bus-factor because both answer questions about human
 * effort: who understands this file, and is its public surface explained. The
 * authorship of a lockfile or a `.gitignore` answers neither — counting them
 * makes a solo repo look worse and a generated tree look collaborative.
 */

import { run } from './exec.js';

export type Language = 'php' | 'js';

const EXTENSION_LANGUAGES: Readonly<Record<string, Language>> = {
  '.php': 'php',
  '.ts': 'js',
  '.tsx': 'js',
  '.mts': 'js',
  '.cts': 'js',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
};

const IGNORED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(dist|build|out|vendor|node_modules|coverage|__snapshots__)\//,
  /(^|\/)(tests?|specs?|fixtures?|__tests__|__mocks__)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.d\.[cm]?ts$/,
  /\.min\.(js|css)$/,
];

/** The language a path is written in, or null when it is not source we analyse. */
export function languageOf(path: string): Language | null {
  if (IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(path))) return null;

  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  return EXTENSION_LANGUAGES[path.slice(dot).toLowerCase()] ?? null;
}

/** True when the path is hand-maintained source in a language we analyse. */
export function isSourceFile(path: string): boolean {
  return languageOf(path) !== null;
}

/**
 * Files git already knows about. Untracked work and ignored build output stay out.
 *
 * This is the right set for history-based analysis: a file with no commits has
 * no authorship to measure.
 */
export async function listTrackedFiles(
  repoRoot: string,
): Promise<readonly string[]> {
  const { stdout } = await run('git', ['ls-files'], { cwd: repoRoot });
  return stdout.split('\n').filter((path) => path !== '');
}

/**
 * Every source file in the working tree, committed or not.
 *
 * Deliberately wider than `listTrackedFiles`. Scanning only committed files
 * means a developer running the CLI locally before committing sees a score that
 * ignores everything they just wrote — the code most likely to need a docblock.
 * `--others --exclude-standard` adds untracked files while still honouring
 * `.gitignore`, matching the working-tree view the secrets module scans.
 */
export async function listSourceFiles(
  repoRoot: string,
): Promise<readonly string[]> {
  const { stdout } = await run(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot },
  );
  return stdout
    .split('\n')
    .filter((path) => path !== '')
    .filter(isSourceFile);
}
