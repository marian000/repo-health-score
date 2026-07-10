import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/util/exec.js';
import { RefNotFoundError, withRefWorktree } from '../../src/util/worktree.js';

let repoRoot: string;

const git = async (...args: string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd: repoRoot });
  return stdout.trim();
};

const commit = async (file: string, contents: string, message: string) => {
  await writeFile(join(repoRoot, file), contents, 'utf8');
  await git('add', file);
  await git('commit', '--no-gpg-sign', '-m', message);
};

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'worktree-test-'));
  await git('init', '--initial-branch=main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');
  await commit('app.txt', 'base\n', 'first');
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('withRefWorktree', () => {
  it('checks out the ref as it was, not the current working tree', async () => {
    const baseCommit = await git('rev-parse', 'HEAD');
    await commit('app.txt', 'changed\n', 'second');

    const seen = await withRefWorktree(repoRoot, baseCommit, (worktreeRoot) =>
      readFile(join(worktreeRoot, 'app.txt'), 'utf8'),
    );

    expect(seen).toBe('base\n');
  });

  it('resolves a branch name, not only a sha', async () => {
    const seen = await withRefWorktree(repoRoot, 'main', (worktreeRoot) =>
      readFile(join(worktreeRoot, 'app.txt'), 'utf8'),
    );
    expect(seen).toBe('base\n');
  });

  it('leaves uncommitted changes in the real working tree untouched', async () => {
    // The baseline scan runs against a branch the user is not on, while they
    // may have uncommitted work. Disturbing it would be unforgivable.
    await writeFile(join(repoRoot, 'app.txt'), 'uncommitted\n', 'utf8');

    await withRefWorktree(repoRoot, 'main', () => Promise.resolve());

    expect(await readFile(join(repoRoot, 'app.txt'), 'utf8')).toBe(
      'uncommitted\n',
    );
  });

  it('removes the worktree afterwards, including its git bookkeeping', async () => {
    let path = '';
    await withRefWorktree(repoRoot, 'main', async (worktreeRoot) => {
      path = worktreeRoot;
      expect(await git('worktree', 'list')).toContain(worktreeRoot);
    });

    expect(await git('worktree', 'list')).not.toContain(path);
  });

  it('removes the worktree even when the callback throws', async () => {
    await expect(
      withRefWorktree(repoRoot, 'main', () => {
        throw new Error('scan exploded');
      }),
    ).rejects.toThrow('scan exploded');

    // A leaked worktree makes every later `worktree add` warn, and a leaked
    // temp directory outlives the process.
    expect(await git('worktree', 'list')).not.toContain('repo-health-baseline');
  });

  it('reports an unknown ref as RefNotFoundError, the shallow-clone case', async () => {
    await expect(
      withRefWorktree(repoRoot, 'origin/main', () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(RefNotFoundError);
  });

  it('refuses a ref that git would read as an option', async () => {
    // Arguments never reach a shell, but `--upload-pack=…` still changes what
    // git does, and the ref arrives from a workflow input.
    await expect(
      withRefWorktree(repoRoot, '--output=/tmp/pwned', () =>
        Promise.resolve(1),
      ),
    ).rejects.toBeInstanceOf(RefNotFoundError);
  });

  it('does not treat a tag as a branch checkout conflict', async () => {
    await git('tag', 'v1.0.0');
    const seen = await withRefWorktree(repoRoot, 'v1.0.0', (worktreeRoot) =>
      readFile(join(worktreeRoot, 'app.txt'), 'utf8'),
    );
    expect(seen).toBe('base\n');
  });

  it('checks out the ref even when it is the branch already checked out', async () => {
    // `git worktree add` refuses a branch checked out elsewhere unless detached.
    const seen = await withRefWorktree(repoRoot, 'main', (worktreeRoot) =>
      readFile(join(worktreeRoot, 'app.txt'), 'utf8'),
    );
    expect(seen).toBe('base\n');
  });
});
