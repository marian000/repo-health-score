import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busFactorModule } from '../../src/modules/bus-factor.js';
import type { ScanContext } from '../../src/modules/types.js';
import { run } from '../../src/util/exec.js';

let repoRoot: string;

const context = (): ScanContext => ({
  repoRoot,
  isGitRepo: true,
  isShallowClone: false,
  log: () => undefined,
});

async function git(...args: string[]): Promise<void> {
  await run('git', args, { cwd: repoRoot });
}

/**
 * Commit `file` as `author`. Identity is passed per-invocation rather than via
 * `git config`, so the test never depends on the machine's global git identity.
 */
async function commitAs(
  author: { name: string; email: string },
  file: string,
  content: string,
): Promise<void> {
  const absolute = join(repoRoot, file);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
  await git('add', file);
  await git(
    '-c',
    `user.name=${author.name}`,
    '-c',
    `user.email=${author.email}`,
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    `touch ${file}`,
  );
}

const alice = { name: 'Alice', email: 'alice@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const dependabot = {
  name: 'dependabot[bot]',
  email: 'support@dependabot.com',
};

/** Enough commits and files to clear the module's significance thresholds. */
async function buildRepo(
  spec: readonly { author: typeof alice; file: string }[],
): Promise<void> {
  for (const [index, entry] of spec.entries()) {
    await commitAs(entry.author, entry.file, `// revision ${String(index)}\n`);
  }
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'rhs-bus-'));
  await run('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: repoRoot,
  });
});

afterEach(async () => {
  // maxRetries: git may still be flushing index locks as the directory is torn
  // down, which surfaces as a spurious ENOTEMPTY.
  await rm(repoRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('busFactorModule', () => {
  it('is not applicable outside a git repository', async () => {
    const result = await busFactorModule.scan({
      ...context(),
      isGitRepo: false,
    });
    expect(result).toMatchObject({ status: 'not-applicable' });
  });

  it('refuses to score a shallow clone rather than reporting from truncated history', async () => {
    // The failure this guards: `git log` on a fetch-depth:1 checkout succeeds,
    // names one author for every file, and yields a confident, wrong 0.
    const result = await busFactorModule.scan({
      ...context(),
      isShallowClone: true,
    });
    expect(result).toMatchObject({ status: 'not-applicable' });
    expect(result.status === 'not-applicable' && result.hint).toMatch(
      /fetch-depth: 0/,
    );
  });

  it('refuses to score a repo with too little history', async () => {
    await buildRepo([
      { author: alice, file: 'a.ts' },
      { author: alice, file: 'b.ts' },
    ]);
    const result = await busFactorModule.scan(context());
    expect(result).toMatchObject({ status: 'not-applicable' });
    expect(result.status === 'not-applicable' && result.reason).toMatch(
      /too few/,
    );
  });

  it('refuses to score a repo with too few source files', async () => {
    // 20 commits, but all to the same three files.
    const spec = Array.from({ length: 21 }, (_, i) => ({
      author: alice,
      file: `src/${String(i % 3)}.ts`,
    }));
    await buildRepo(spec);
    const result = await busFactorModule.scan(context());
    expect(result).toMatchObject({ status: 'not-applicable' });
    expect(result.status === 'not-applicable' && result.reason).toMatch(
      /source file/,
    );
  });

  describe('with enough history', () => {
    /**
     * 12 source files and at least 20 commits, clearing both thresholds.
     * `src/0.ts` is the most-churned file, so it is always critical.
     */
    async function repoWith(hotFileAuthors: (typeof alice)[]): Promise<void> {
      const spec: { author: typeof alice; file: string }[] = [];
      for (let i = 0; i < 12; i++) {
        spec.push({ author: alice, file: `src/${String(i)}.ts` });
      }
      for (const author of hotFileAuthors) {
        for (let i = 0; i < 8; i++) spec.push({ author, file: 'src/0.ts' });
      }
      await buildRepo(spec);
    }

    it('scores 0 when every critical file has one author', async () => {
      await repoWith([alice]);
      const result = await busFactorModule.scan(context());
      expect(result).toMatchObject({ status: 'scored', score: 0 });
      expect(
        result.status === 'scored' && result.findings.length,
      ).toBeGreaterThan(0);
    });

    it('scores higher when critical files have several authors', async () => {
      await repoWith([alice, bob]);
      const result = await busFactorModule.scan(context());
      expect(result.status).toBe('scored');
      expect(result.status === 'scored' && result.score).toBeGreaterThan(0);
    });

    it('does not count bot commits as a second contributor', async () => {
      // Without bot exclusion, dependabot's commits make src/0.ts look
      // co-maintained and the file drops out of the findings.
      await repoWith([alice, dependabot]);
      const result = await busFactorModule.scan(context());
      expect(result.status === 'scored' && result.findings).toContainEqual(
        expect.objectContaining({ file: 'src/0.ts' }),
      );
    });

    it('ignores config files when choosing critical files', async () => {
      await repoWith([alice]);
      // A heavily-churned dotfile must not outrank real source.
      for (let i = 0; i < 10; i++) {
        await commitAs(alice, '.gitignore', `# ${String(i)}\n`);
      }
      const result = await busFactorModule.scan(context());
      expect(result.status === 'scored' && result.findings).not.toContainEqual(
        expect.objectContaining({ file: '.gitignore' }),
      );
    });

    it('names the sole author and offers a concrete fix', async () => {
      await repoWith([alice]);
      const result = await busFactorModule.scan(context());
      const finding =
        result.status === 'scored' ? result.findings[0] : undefined;
      expect(finding?.problem).toMatch(/Alice/);
      expect(finding?.fix).toMatch(/second maintainer/);
    });
  });
});
