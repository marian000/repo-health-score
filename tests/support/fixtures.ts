import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { run } from '../../src/util/exec.js';

/**
 * Materialises the fixture repositories in `tests/fixtures/`.
 *
 * The trees on disk are inert: no `.git`, no `node_modules`, no secret. A git
 * repository cannot be nested inside this one, `node_modules/` is ignored by
 * the root `.gitignore`, and a committed credential would trip both our own
 * secret scan and GitHub's push protection. So each of the three is built here,
 * into a temporary directory, immediately before a scan runs against it.
 *
 * See `tests/fixtures/README.md` for what each fixture is expected to score.
 */

export type FixtureName = 'clean' | 'planted';

/** Where the planted credential lands, relative to the fixture root. */
export const PLANTED_SECRET_FILE = 'config/production.env';

/**
 * The AWS access key id planted in the `planted` fixture.
 *
 * Assembled from two halves rather than written whole. Written whole, this line
 * would be a `critical` finding in every scan this project runs on itself, and
 * GitHub's push protection — enabled on this repository — would reject the
 * commit that introduced it. It authorises nothing; only its shape matters.
 *
 * Do not "tidy" this into a base64 blob. Gitleaks decodes base64 and finds the
 * key inside; it does not evaluate string concatenation.
 */
const PLANTED_AWS_ACCESS_KEY = 'AKIA' + 'ZXBQ7RNTLW3JKDVM';

const PLACEHOLDERS: Readonly<Record<string, string>> = {
  __PLANTED_AWS_ACCESS_KEY__: PLANTED_AWS_ACCESS_KEY,
};

interface Author {
  readonly name: string;
  readonly email: string;
}

const ALICE: Author = { name: 'Alice Nakamura', email: 'alice@example.com' };
const BOB: Author = { name: 'Bob Ferreira', email: 'bob@example.com' };

/** The twelve tracked source files, identical in both fixtures. */
const SOURCE_FILES: readonly string[] = [
  'src/Account.php',
  'src/Billing.php',
  'src/Cache.php',
  'src/Config.php',
  'src/Database.php',
  'src/Invoice.php',
  'src/Logger.php',
  'src/Mailer.php',
  'src/Order.php',
  'src/Payment.php',
  'src/Report.php',
  'src/Router.php',
];

/**
 * The files bus-factor should call critical.
 *
 * The module takes the top 20% of source files by churn: `ceil(12 × 0.2)` is
 * three. Six extra commits each puts these three at seven commits against one
 * for every other file, so the selection is decided by churn rather than by how
 * `sort` happens to break a tie.
 */
const CHURNED_FILES: readonly string[] = [
  'src/Invoice.php',
  'src/Payment.php',
  'src/Router.php',
];

const CHURN_COMMITS = 6;

/** Committed before any source file, so `git add` never has to guess. */
const SCAFFOLD_FILES: Readonly<Record<FixtureName, readonly string[]>> = {
  clean: ['.gitignore', 'README.md', 'package.json', 'package-lock.json'],
  planted: [
    '.gitignore',
    'README.md',
    'package.json',
    'package-lock.json',
    PLANTED_SECRET_FILE,
  ],
};

/**
 * Files whose `__PLACEHOLDER__` tokens are replaced before the first commit.
 *
 * Kept apart from `SCAFFOLD_FILES` deliberately, though they overlap today. The
 * two answer different questions — what goes in the first commit, and what
 * carries a placeholder — and folding them together means a placeholder added to
 * a source file is copied through verbatim. The scan would then find nothing,
 * and a test asserting one finding would still see the one already there.
 */
const SUBSTITUTED_FILES: Readonly<Record<FixtureName, readonly string[]>> = {
  clean: [],
  planted: [PLANTED_SECRET_FILE],
};

interface PackageStub {
  /** Path under `node_modules/`. */
  readonly path: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

/**
 * The installed tree the `licenses` module reads through `npm ls`.
 *
 * `gpl-lib` sits under `lodash`, not beside it, because a transitive copyleft
 * dependency is the case the module exists to catch: reading only the top-level
 * manifest would miss it. It is not a real package — nothing installs it — but
 * `npm ls` reports whatever manifest it finds on disk.
 */
const NODE_MODULES: Readonly<Record<FixtureName, readonly PackageStub[]>> = {
  clean: [
    { path: 'ms', manifest: { name: 'ms', version: '2.1.3', license: 'MIT' } },
  ],
  planted: [
    {
      path: 'lodash',
      manifest: {
        name: 'lodash',
        version: '4.17.4',
        license: 'MIT',
        dependencies: { 'gpl-lib': '^1.0.0' },
      },
    },
    {
      path: 'lodash/node_modules/gpl-lib',
      manifest: {
        name: 'gpl-lib',
        version: '1.0.0',
        license: 'GPL-3.0',
      },
    },
  ],
};

/**
 * Copy a fixture into a temporary directory, plant its secret, install its
 * stub packages, and replay its commit history.
 *
 * @returns the absolute path of the materialised repository.
 */
export async function materialiseFixture(name: FixtureName): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), `rhs-fixture-${name}-`));

  await cp(fixtureSource(name), repoRoot, { recursive: true });
  await substitutePlaceholders(repoRoot, SUBSTITUTED_FILES[name]);
  await assertNoPlaceholderSurvived(repoRoot);
  await buildHistory(repoRoot, name);
  await installStubs(repoRoot, NODE_MODULES[name]);

  return repoRoot;
}

export async function removeFixture(repoRoot: string): Promise<void> {
  // maxRetries: git may still be flushing index locks as the directory is torn
  // down, which surfaces as a spurious ENOTEMPTY.
  await rm(repoRoot, { recursive: true, force: true, maxRetries: 3 });
}

function fixtureSource(name: FixtureName): string {
  return join(import.meta.dirname, '..', 'fixtures', name);
}

async function substitutePlaceholders(
  repoRoot: string,
  files: readonly string[],
): Promise<void> {
  for (const file of files) {
    const path = join(repoRoot, file);
    const original = await readFile(path, 'utf8');

    let substituted = original;
    for (const [placeholder, value] of Object.entries(PLACEHOLDERS)) {
      substituted = substituted.split(placeholder).join(value);
    }

    if (substituted !== original) await writeFile(path, substituted, 'utf8');
  }
}

/**
 * Fail loudly on a placeholder that no file in `SUBSTITUTED_FILES` claimed.
 *
 * Without this, planting a secret in a file nobody remembered to list leaves the
 * literal token on disk. Gitleaks finds nothing in it, the fixture is quietly
 * one problem short, and a test that asserts "one critical finding" still passes
 * on the finding that was already there. A fixture that lies about its own
 * contents is worse than no fixture.
 */
async function assertNoPlaceholderSurvived(repoRoot: string): Promise<void> {
  const entries = await readdir(repoRoot, {
    recursive: true,
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const path = join(entry.parentPath, entry.name);
    const content = await readFile(path, 'utf8');

    for (const placeholder of Object.keys(PLACEHOLDERS)) {
      if (content.includes(placeholder)) {
        throw new Error(
          `${relative(repoRoot, path)} still contains ${placeholder}. ` +
            'Add it to SUBSTITUTED_FILES in tests/support/fixtures.ts.',
        );
      }
    }
  }
}

/**
 * Thirty-one commits by two named authors.
 *
 * Bus factor refuses to score fewer than twenty commits or fewer than ten
 * source files, on the grounds that "the top 20% by churn" over a handful of
 * files is a coin flip rather than a measurement. One scaffold commit, twelve
 * file creations and eighteen churn commits clear both bars with room to spare.
 *
 * The only difference between the fixtures is who makes the churn commits. In
 * `clean` they alternate, so every critical file has two authors and the
 * category scores 100. In `planted` one person writes everything, and it
 * scores 0.
 */
async function buildHistory(
  repoRoot: string,
  name: FixtureName,
): Promise<void> {
  await git(repoRoot, ['init', '--quiet', '--initial-branch=main']);

  await commit(
    repoRoot,
    ALICE,
    SCAFFOLD_FILES[name],
    'chore: scaffold the project',
  );

  for (const file of SOURCE_FILES) {
    await commit(
      repoRoot,
      ALICE,
      [file],
      `feat: add ${basename(file, '.php')}`,
    );
  }

  for (const file of CHURNED_FILES) {
    for (let revision = 1; revision <= CHURN_COMMITS; revision++) {
      // A trailing comment: enough to make a commit, and it matches none of the
      // patterns docs uses to find a public declaration.
      await appendFile(
        join(repoRoot, file),
        `// revision ${String(revision)}\n`,
      );

      const author = name === 'clean' && revision % 2 === 1 ? BOB : ALICE;
      await commit(
        repoRoot,
        author,
        [file],
        `refactor: tune ${basename(file, '.php')} (${String(revision)})`,
      );
    }
  }
}

async function installStubs(
  repoRoot: string,
  stubs: readonly PackageStub[],
): Promise<void> {
  for (const stub of stubs) {
    const directory = join(repoRoot, 'node_modules', stub.path);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify(stub.manifest, null, 2)}\n`,
      'utf8',
    );
  }
}

/**
 * Identity is passed per invocation rather than written to the repository's
 * config, so a machine with no global git identity still runs these tests, and
 * one with an identity does not leak it into the fixture's history.
 */
async function commit(
  repoRoot: string,
  author: Author,
  files: readonly string[],
  message: string,
): Promise<void> {
  await git(repoRoot, ['add', '--', ...files]);
  await git(repoRoot, [
    '-c',
    `user.name=${author.name}`,
    '-c',
    `user.email=${author.email}`,
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    message,
  ]);
}

async function git(repoRoot: string, args: readonly string[]): Promise<void> {
  const { exitCode, stderr } = await run('git', args, {
    cwd: repoRoot,
    timeoutMs: 30_000,
  });
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}
