import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docsModule } from '../../src/modules/docs.js';
import type { ScanContext } from '../../src/modules/types.js';
import { run } from '../../src/util/exec.js';

let repoRoot: string;

const context = (): ScanContext => ({
  repoRoot,
  isGitRepo: true,
  isShallowClone: false,
  log: () => undefined,
});

async function writeFixture(path: string, content: string): Promise<void> {
  const absolute = join(repoRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

/** The docs module reads the working tree through git, so fixtures need a repo. */
async function initRepo(): Promise<void> {
  await run('git', ['init', '--quiet'], { cwd: repoRoot });
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'rhs-docs-'));
  await initRepo();
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe('docsModule', () => {
  it('is not applicable outside a git repository', async () => {
    const result = await docsModule.scan({ ...context(), isGitRepo: false });
    expect(result.status).toBe('not-applicable');
  });

  describe('README', () => {
    it('flags a missing README', async () => {
      const result = await docsModule.scan(context());
      expect(result).toMatchObject({ status: 'scored', score: 0 });
      expect(result.status === 'scored' && result.findings[0]?.problem).toMatch(
        /No README/,
      );
    });

    it('scores a README with both required sections', async () => {
      await writeFixture(
        'README.md',
        '# Thing\n\n## Installation\n\nnpm i\n\n## Usage\n\nuse it\n',
      );
      const result = await docsModule.scan(context());
      expect(result).toMatchObject({ status: 'scored', score: 100 });
    });

    it('accepts synonyms for the required sections', async () => {
      await writeFixture(
        'README.md',
        '# Thing\n\n## Getting started\n\n## Quick start\n',
      );
      const result = await docsModule.scan(context());
      expect(result).toMatchObject({ score: 100 });
    });

    it('flags a README that is missing a Usage section', async () => {
      await writeFixture('README.md', '# Thing\n\n## Installation\n\nnpm i\n');
      const result = await docsModule.scan(context());
      expect(result).toMatchObject({ status: 'scored', score: 50 });
      expect(result.status === 'scored' && result.findings).toHaveLength(1);
    });
  });

  describe('docblock coverage', () => {
    const readme = '# T\n\n## Installation\n\n## Usage\n';

    it('does not treat a bare TypeScript function as public', async () => {
      // `function helper()` is module-private in an ES module. Applying PHP's
      // "bare function is public" rule here reports every internal helper.
      await writeFixture('README.md', readme);
      await writeFixture(
        'src/a.ts',
        'function helper(): void {}\n\n/** Doc. */\nexport function shown(): void {}\n',
      );
      const result = await docsModule.scan(context());
      expect(result).toMatchObject({ score: 100 });
    });

    it('treats a bare PHP function as public', async () => {
      // In PHP the same syntax *is* public, so it must be counted.
      await writeFixture('README.md', readme);
      await writeFixture('src/a.php', '<?php\nfunction helper() {}\n');
      const result = await docsModule.scan(context());
      expect(result.status === 'scored' && result.findings).toContainEqual(
        expect.objectContaining({
          problem: 'Public function `helper()` has no docblock',
          file: 'src/a.php',
          line: 2,
        }),
      );
    });

    it('does not count private or protected PHP methods', async () => {
      await writeFixture('README.md', readme);
      await writeFixture(
        'src/a.php',
        '<?php\nclass C {\n  private function a() {}\n  protected function b() {}\n}\n',
      );
      const result = await docsModule.scan(context());
      expect(result).toMatchObject({ score: 100 });
    });

    it('accepts a docblock separated by attributes and blank lines', async () => {
      await writeFixture('README.md', readme);
      await writeFixture(
        'src/a.php',
        '<?php\n/**\n * Does a thing.\n */\n#[Route("/x")]\n\npublic function handle() {}\n',
      );
      const result = await docsModule.scan(context());
      expect(result).toMatchObject({ score: 100 });
    });

    it('accepts a single-line docblock', async () => {
      await writeFixture('README.md', readme);
      await writeFixture(
        'src/a.ts',
        '/** Adds. */\nexport function add(): void {}\n',
      );
      expect(await docsModule.scan(context())).toMatchObject({ score: 100 });
    });

    it('does not accept a plain line comment as documentation', async () => {
      await writeFixture('README.md', readme);
      await writeFixture(
        'src/a.ts',
        '// adds two numbers\nexport function add(): void {}\n',
      );
      const result = await docsModule.scan(context());
      expect(result.status === 'scored' && result.findings).toHaveLength(1);
    });

    it('counts arrow-function exports', async () => {
      await writeFixture('README.md', readme);
      await writeFixture('src/a.ts', 'export const f = (x: number) => x;\n');
      const result = await docsModule.scan(context());
      expect(result.status === 'scored' && result.findings[0]?.problem).toMatch(
        /`f\(\)`/,
      );
    });

    it('ignores test files, type declarations, and vendored code', async () => {
      await writeFixture('README.md', readme);
      await writeFixture('src/a.test.ts', 'export function t(): void {}\n');
      await writeFixture('src/a.d.ts', 'export function d(): void;\n');
      await writeFixture('vendor/lib/x.php', '<?php\nfunction v() {}\n');
      await writeFixture('tests/helper.ts', 'export function h(): void {}\n');
      const result = await docsModule.scan(context());
      expect(result).toMatchObject({ score: 100 });
    });

    it('ignores constructors and framework hooks', async () => {
      await writeFixture('README.md', readme);
      await writeFixture(
        'src/a.php',
        '<?php\nclass C {\n  public function __construct() {}\n}\n',
      );
      expect(await docsModule.scan(context())).toMatchObject({ score: 100 });
    });

    it('weights the README above docblock coverage', async () => {
      // README 100 (0.4) + docblocks 0 (0.6) = 40
      await writeFixture('README.md', readme);
      await writeFixture(
        'src/a.ts',
        'export function undocumented(): void {}\n',
      );
      expect(await docsModule.scan(context())).toMatchObject({ score: 40 });
    });

    it('scores the README alone when there is no public API', async () => {
      await writeFixture('README.md', readme);
      await writeFixture('src/a.ts', 'const x = 1;\nexport { x };\n');
      expect(await docsModule.scan(context())).toMatchObject({ score: 100 });
    });

    it('sees uncommitted files, so a local run reflects work in progress', async () => {
      await writeFixture('README.md', readme);
      await writeFixture('src/new.ts', 'export function fresh(): void {}\n');
      // Nothing has been committed; `git ls-files` alone would report nothing.
      const result = await docsModule.scan(context());
      expect(result.status === 'scored' && result.findings).toHaveLength(1);
    });

    it('honours .gitignore when collecting source files', async () => {
      await writeFixture('README.md', readme);
      await writeFixture('.gitignore', 'generated/\n');
      await writeFixture('generated/a.ts', 'export function g(): void {}\n');
      expect(await docsModule.scan(context())).toMatchObject({ score: 100 });
    });
  });
});
