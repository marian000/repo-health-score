import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  languageOf,
  listSourceFiles,
  type Language,
} from '../util/source-files.js';
import {
  notApplicable,
  scored,
  type CategoryResult,
  type Finding,
  type ScanContext,
  type ScanModule,
} from './types.js';

/**
 * Weight of the two halves of this category.
 *
 * A repo can have every function documented and still be unusable without a
 * README explaining what it is, so the README is worth more per byte than a
 * perfect docblock ratio.
 */
const README_WEIGHT = 0.4;
const DOCBLOCK_WEIGHT = 0.6;

const README_NAMES = ['README.md', 'README.rst', 'README.txt', 'README'];

/** Sections a README needs before a stranger can use the project. */
const REQUIRED_SECTIONS: readonly {
  readonly label: string;
  readonly synonyms: readonly string[];
}[] = [
  {
    label: 'Installation',
    synonyms: ['install', 'installation', 'getting started', 'setup'],
  },
  {
    label: 'Usage',
    synonyms: ['usage', 'use', 'quick start', 'quickstart', 'example'],
  },
];

/**
 * What counts as a public declaration, per language.
 *
 * Keyed by language because the same syntax means opposite things: a bare
 * `function foo()` is public in PHP and module-private in an ES module. Running
 * the PHP pattern over TypeScript reports every internal helper as an
 * undocumented public function — a wrong number that looks entirely plausible.
 *
 * This is lexical, not syntactic. A real implementation walks an AST via
 * nikic/php-parser or tree-sitter, which is deferred to v2: a parser per
 * language is most of the work of this module and little of the MVP's value.
 * The tradeoff is tuned to fail quiet — `hasDocblockAbove` searches upwards
 * rather than demanding a docblock on a fixed line, so the common error is
 * missing a finding rather than inventing one.
 */
const DECLARATION_PATTERNS: Readonly<Record<Language, readonly RegExp[]>> = {
  php: [
    // `public function foo(`, `public static function foo(`, and bare
    // `function foo(` — public by default. `private`/`protected` never match,
    // because the optional group only admits `public`.
    /^\s*(?:public\s+(?:static\s+)?)?function\s+(\w+)\s*\(/,
  ],
  js: [
    /^\s*export\s+(?:async\s+)?function\s+(\w+)\s*\(/,
    // Arrow-function exports: `export const foo = (` / `= async (`.
    /^\s*export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
  ],
};

const DOCBLOCK_OPEN = /\/\*\*/;
const DOCBLOCK_CLOSE = /\*\//;
const LINE_COMMENT = /^\s*(?:\/\/|#)/;

/** Magic methods and framework hooks nobody documents individually. */
const UNDOCUMENTABLE_NAMES = new Set([
  '__construct',
  '__destruct',
  '__toString',
  '__get',
  '__set',
  '__call',
  '__invoke',
  'up',
  'down',
]);

interface UndocumentedFunction {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

export const docsModule: ScanModule = {
  category: 'docs',
  name: 'Documentation',

  async scan(context: ScanContext): Promise<CategoryResult> {
    if (!context.isGitRepo) {
      return notApplicable(
        'Not a git repository, so the set of tracked source files is unknown',
        'Run against a git checkout rather than a loose directory.',
      );
    }

    const readme = await findReadme(context.repoRoot);
    const readmeFindings = readme
      ? checkReadmeSections(readme.name, readme.content)
      : [missingReadmeFinding()];
    const readmeScore = readme
      ? Math.round(
          ((REQUIRED_SECTIONS.length - readmeFindings.length) /
            REQUIRED_SECTIONS.length) *
            100,
        )
      : 0;

    const { total, undocumented } = await analyseDocblocks(context.repoRoot);

    // No public API to document. Score the README alone, rather than inventing
    // a 100% docblock ratio over zero functions.
    if (total === 0) return scored(readmeScore, readmeFindings);

    const docblockScore = Math.round(
      ((total - undocumented.length) / total) * 100,
    );

    return scored(
      readmeScore * README_WEIGHT + docblockScore * DOCBLOCK_WEIGHT,
      [...readmeFindings, ...undocumented.map(toDocblockFinding)],
    );
  },
};

async function findReadme(
  repoRoot: string,
): Promise<{ name: string; content: string } | null> {
  for (const name of README_NAMES) {
    try {
      return { name, content: await readFile(join(repoRoot, name), 'utf8') };
    } catch {
      continue;
    }
  }
  return null;
}

function checkReadmeSections(name: string, content: string): Finding[] {
  const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
    (match[1] ?? '').toLowerCase(),
  );

  return REQUIRED_SECTIONS.filter(
    (section) =>
      !headings.some((heading) =>
        section.synonyms.some((synonym) => heading.includes(synonym)),
      ),
  ).map((section) => ({
    severity: 'low' as const,
    problem: `\`${name}\` has no ${section.label} section`,
    fix: `Add a \`## ${section.label}\` heading to \`${name}\` describing how to ${
      section.label === 'Installation'
        ? 'install the project'
        : 'use it, with at least one example'
    }.`,
    file: name,
  }));
}

function missingReadmeFinding(): Finding {
  return {
    severity: 'medium',
    problem: 'No README found at the repository root',
    fix: 'Add a `README.md` with, at minimum, what the project does, how to install it, and one usage example.',
  };
}

async function analyseDocblocks(
  repoRoot: string,
): Promise<{ total: number; undocumented: UndocumentedFunction[] }> {
  const files = await listSourceFiles(repoRoot);

  const parsed = await Promise.all(
    files.map(async (file) => {
      const language = languageOf(file);
      if (language === null) return null;
      try {
        const content = await readFile(join(repoRoot, file), 'utf8');
        return { file, language, lines: content.split('\n') };
      } catch {
        // Tracked but unreadable: a broken symlink, or deleted between
        // `git ls-files` and here. Not this module's problem to report.
        return null;
      }
    }),
  );

  let total = 0;
  const undocumented: UndocumentedFunction[] = [];

  for (const entry of parsed) {
    if (entry === null) continue;
    for (const [index, line] of entry.lines.entries()) {
      const name = declaredFunctionName(line, entry.language);
      if (name === null || UNDOCUMENTABLE_NAMES.has(name)) continue;

      total += 1;
      if (!hasDocblockAbove(entry.lines, index)) {
        undocumented.push({ name, file: entry.file, line: index + 1 });
      }
    }
  }

  return { total, undocumented };
}

function declaredFunctionName(line: string, language: Language): string | null {
  for (const pattern of DECLARATION_PATTERNS[language]) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * Walk upwards from a declaration looking for the end of a docblock.
 *
 * Skips blank lines, line comments, PHP attributes, and TS decorators, all of
 * which legitimately sit between a docblock and what it documents. Stops at the
 * first line that is none of those: a docblock further up belongs to something
 * else.
 */
function hasDocblockAbove(
  lines: readonly string[],
  declarationIndex: number,
): boolean {
  for (let i = declarationIndex - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) return false;

    const trimmed = line.trim();
    if (trimmed === '' || LINE_COMMENT.test(line)) continue;
    // TS decorators. PHP 8 attributes `#[Foo]` are caught by LINE_COMMENT.
    if (trimmed.startsWith('@')) continue;

    // Either the close of a multi-line block, or a whole one-line docblock.
    return DOCBLOCK_CLOSE.test(trimmed) || DOCBLOCK_OPEN.test(trimmed);
  }
  return false;
}

function toDocblockFinding(fn: UndocumentedFunction): Finding {
  return {
    severity: 'low',
    problem: `Public function \`${fn.name}()\` has no docblock`,
    fix: `Add a docblock above \`${fn.name}()\` in \`${fn.file}\` describing what it does, its parameters, and what it returns.`,
    file: fn.file,
    line: fn.line,
  };
}
