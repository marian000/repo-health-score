# repo-health-score

![repo health](./badge.svg)

Score any repository from 0 to 100 on security, maintainability, and developer experience — and get told how to fix what's wrong, not just what the number is.

That badge is this repository's own score, regenerated on every push. We eat what we cook.

## Why another scanner

[OpenSSF Scorecard](https://github.com/ossf/scorecard) already covers supply-chain security well. This tool differs in two ways that shaped every design decision:

**It looks past security.** Undocumented public functions and code only one person has ever touched are real risks to a project's future, and neither shows up in a vulnerability scan. They count here.

**Every finding carries a fix.** "3 undocumented functions" is half a report. This tool names the functions, the files, and what to write. `Finding.fix` is a required field in the module contract — a finding without a remedy does not typecheck.

The PHP/Composer ecosystem is the deliberate first-class target. It is underserved relative to JavaScript, and when a design choice trades PHP support against JS support, PHP wins.

## Installation

No installation, no configuration:

```bash
npx repo-health-score .
```

Gitleaks is a Go binary rather than an npm package, so it is downloaded on first run, checksum-verified against a digest pinned in this repository, and cached. Everything else uses the package managers already present in the repository you are scanning.

## Usage

```bash
npx repo-health-score .                    # score the current directory
npx repo-health-score ../other-repo        # score somewhere else
npx repo-health-score . --fail-under 70    # exit 1 if the score drops below 70
npx repo-health-score . --json report.json --badge badge.svg
```

```
Repo Health Score: A (93/100)

  secrets        100   ok
  dependencies   100   ok
  licenses       100   ok
  docs            88   1 finding(s)
  bus-factor     n/a   Only 4 non-merge commit(s) of history
```

Without `--fail-under`, the CLI always exits 0. It is a reporter until you ask it to be a gate.

### Options

| Flag               | Effect                                         |
| ------------------ | ---------------------------------------------- |
| `--fail-under <n>` | Exit 1 when the score is below `n`             |
| `--json <file>`    | Write the full report, including every finding |
| `--badge <file>`   | Write the badge SVG                            |
| `--comment <file>` | Write the PR comment markdown                  |
| `--quiet`          | Suppress progress output                       |

## What it measures

| Category                | Weight | What it checks                                                                                  |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| Exposed secrets         | 30%    | Credentials committed to the working tree, via [Gitleaks](https://github.com/gitleaks/gitleaks) |
| Vulnerable dependencies | 25%    | Active CVEs, via `composer audit` and `npm audit`                                               |
| Licenses                | 15%    | Copyleft dependencies inside a permissively-licensed project                                    |
| Documentation           | 15%    | README sections, and docblocks on public functions                                              |
| Bus factor              | 15%    | Share of high-churn source files with a single contributor                                      |

Weights live in `src/scoring/weights.json` and are overridable per project.

Two rules look like bugs until you know they are deliberate:

**A critical secret zeroes its category outright**, rather than costing proportional points. A leaked live credential is not 80% healthy because the rest of the repo is.

**A category that cannot be scanned is redistributed, not awarded 100.** A repo with no dependency manifest has its 25% spread across the other categories. Scoring it 100 would rank it above a repo that has dependencies and audits them cleanly — the absence of a thing is not evidence of its health.

Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, E ≥ 50, F below.

## Honest limitations

Worth knowing before you trust a number:

- **Secrets are scanned on the working tree, not git history.** A secret committed and later rotated would otherwise pin a permanent zero on 30% of the score with no reachable remedy. History scanning will be opt-in.
- **Documentation coverage is lexical, not syntactic.** It matches declarations with regular expressions rather than walking an AST, so it undercounts rather than overcounts. A parser per language is planned for v2.
- **Bus factor needs full history.** GitHub Actions checks out with `fetch-depth: 1` by default, which leaves one commit. The module reports N/A rather than scoring from a truncated history — use `fetch-depth: 0`.
- **Monorepos are not supported yet.** Only manifests at the repository root are read.
- **npm license checking needs `node_modules` on disk.** Reading only direct dependencies would miss the deep transitive GPL dependency that the check exists to find.

Anywhere a precondition is missing, the category reports N/A with a reason. Wrong output is worse than no output, because nobody re-checks a number that looks plausible.

## Contributing

`src/modules/` is the extension point. A new language audit — `pip-audit`, `bundler-audit`, `govulncheck` — should drop in without touching the orchestrator or the scoring engine.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the module contract and the commit conventions.

## License

[Apache-2.0](LICENSE).
