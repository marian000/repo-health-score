import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.js';

/**
 * Raised when a ref cannot be resolved to a commit in the local repository.
 *
 * The overwhelmingly common cause is a shallow clone: GitHub Actions checks out
 * with `fetch-depth: 1`, so the base branch simply is not there. That is a
 * fixable configuration problem, not a reason to fail a scan, so callers are
 * expected to catch this and continue without a baseline.
 */
export class RefNotFoundError extends Error {
  constructor(readonly ref: string) {
    super(`Cannot resolve "${ref}" to a commit in this repository`);
    this.name = 'RefNotFoundError';
  }
}

/**
 * Check out `ref` into a throwaway worktree and run `fn` against it.
 *
 * A worktree, rather than `git stash` or a second clone: it shares the object
 * database (so it costs a checkout, not a fetch) and it leaves the user's
 * working tree — including uncommitted changes — completely untouched. The
 * baseline scan must not be able to disturb the thing it is a baseline for.
 *
 * The worktree is removed even if `fn` throws.
 *
 * @throws {RefNotFoundError} if `ref` names no commit reachable locally.
 */
export async function withRefWorktree<T>(
  repoRoot: string,
  ref: string,
  fn: (worktreeRoot: string) => Promise<T>,
): Promise<T> {
  const commit = await resolveCommit(repoRoot, ref);

  const parent = await mkdtemp(join(tmpdir(), 'repo-health-baseline-'));
  const worktreeRoot = join(parent, 'tree');

  const added = await run(
    'git',
    ['worktree', 'add', '--detach', '--quiet', worktreeRoot, commit],
    { cwd: repoRoot, timeoutMs: 120_000 },
  );
  if (added.exitCode !== 0) {
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
    throw new Error(
      `Could not create a worktree for "${ref}": ${added.stderr.trim()}`,
    );
  }

  try {
    return await fn(worktreeRoot);
  } finally {
    // `worktree remove` also deletes the administrative entry under .git. Doing
    // it by `rm` alone would leave the parent repo believing the worktree still
    // exists, and every later `worktree add` would warn about it.
    await run('git', ['worktree', 'remove', '--force', worktreeRoot], {
      cwd: repoRoot,
      timeoutMs: 60_000,
    }).catch(() => undefined);

    await rm(parent, { recursive: true, force: true, maxRetries: 3 });

    // `remove` fails if anything still holds a handle inside the worktree —
    // routine on Windows. The directory is gone either way by now, so prune the
    // entry it left behind rather than let it accumulate across runs.
    await run('git', ['worktree', 'prune'], {
      cwd: repoRoot,
      timeoutMs: 30_000,
    }).catch(() => undefined);
  }
}

async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
  // A ref beginning with `-` would be read by git as an option rather than a
  // revision. Arguments never reach a shell, so this is not injection — but
  // `--upload-pack=…` style flags still change what git does, and the ref
  // arrives from a workflow input.
  if (ref.startsWith('-')) throw new RefNotFoundError(ref);

  // `--verify --quiet` exits non-zero with no output when the ref is unknown.
  const { stdout, exitCode } = await run(
    'git',
    ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    { cwd: repoRoot, timeoutMs: 10_000 },
  );

  const commit = stdout.trim();
  if (exitCode !== 0 || commit === '') throw new RefNotFoundError(ref);
  return commit;
}
