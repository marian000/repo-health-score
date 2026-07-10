# repo-vitals

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
npx repo-vitals .
```

Gitleaks is a Go binary rather than an npm package, so it is downloaded on first run, checksum-verified against a digest pinned in this repository, and cached. Everything else uses the package managers already present in the repository you are scanning.

## Usage

```bash
npx repo-vitals .                    # score the current directory
npx repo-vitals ../other-repo        # score somewhere else
npx repo-vitals . --fail-under 70    # exit 1 if the score drops below 70
npx repo-vitals . --json report.json --badge badge.svg
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

| Flag               | Effect                                               |
| ------------------ | ---------------------------------------------------- |
| `--fail-under <n>` | Exit 1 when the score is below `n`                   |
| `--json <file>`    | Write the full report, including every finding       |
| `--badge <file>`   | Write the badge SVG                                  |
| `--comment <file>` | Write the PR comment markdown                        |
| `--base-ref <ref>` | Also scan `<ref>`, and report the comment as a delta |
| `--quiet`          | Suppress progress output                             |

## GitHub Action

```yaml
name: Repo health

on: [pull_request]

permissions:
  contents: read
  pull-requests: write # required to post the score comment

jobs:
  score:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # bus factor and the base-branch delta need history
      - uses: marian000/repo-health-score@v0
        with:
          fail-under: '70'
```

On a pull request the action posts one comment and edits it in place on every
later push, rather than adding a new one each time. The comment shows the delta
against the base branch, which is scanned in a throwaway worktree at the same
moment as the head — so a CVE disclosed since the base branch was last touched
appears in both scans and cancels out, instead of being blamed on your PR.

| Input        | Default              | Effect                                           |
| ------------ | -------------------- | ------------------------------------------------ |
| `path`       | `.`                  | Repository root to scan                          |
| `fail-under` | _(none)_             | Fail the job below this score. Empty never fails |
| `base-ref`   | the PR's base branch | Ref to compare against                           |
| `comment`    | `true`               | Post the score comment on the pull request       |
| `badge`      | _(none)_             | Write the badge SVG to this path                 |
| `json`       | _(none)_             | Write the JSON report to this path               |

Outputs `score`, `grade`, and `report` (a path to the JSON) for later steps.

Two things are worth knowing before you wire this up. Without `fetch-depth: 0`
the checkout is one commit deep, so bus factor reports N/A and the delta is
skipped — the action warns rather than scoring from a truncated history. And a
pull request opened from a fork gets a read-only token, so the comment cannot be
posted; the score goes to the job summary instead of failing the run.

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
