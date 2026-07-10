# Contributing to repo-health-score

Thanks for considering a contribution. This project scores repositories on security, maintainability, and developer experience — and it holds itself to the same standard. The self-scan badge in the README is not decoration; if a change lowers our own score, that's a signal worth discussing.

## Ground rules

- **Everything is in English** — code, comments, identifiers, commit messages, issues, and pull requests.
- **Zero-config is a hard requirement.** `npx repo-health-score .` must work on a fresh checkout with no setup. A feature that only works after configuration is a bug in the default path, not a feature.
- **Modules wrap proven tools; they don't reimplement detection.** If a mature scanner exists for what you want to check, wrap it. Write custom analysis only where no good standard tool exists.
- **Every finding must be actionable.** Reporting "3 undocumented functions" is half the job. Say _which_ functions, in which file, and what to add. A number without a fix is not a finding.

## Getting started

```bash
git clone https://github.com/marian000/repo-health-score.git
cd repo-health-score
npm install
```

```bash
npm run build          # compile TypeScript
npm test               # unit + integration tests against tests/fixtures/
npm run lint           # lint and format check
npm run typecheck      # type-check without emitting
npx . /path/to/repo    # run the CLI against a target repository
```

> **Note:** the project is pre-MVP. The scanning modules and the CLI entry point are still landing, so `npx . /path/to/repo` does not work yet. Everything else above does.

## Development workflow

1. **Open an issue first** for anything larger than a typo. It's cheaper to align on approach than to rework a finished PR.
2. **Branch off `main`.** Name it `feat/<short-desc>`, `fix/<short-desc>`, or `docs/<short-desc>`. Never commit directly to `main`.
3. **Keep commits atomic.** One logical change per commit. Split unrelated work rather than bundling it.
4. **Add tests.** Every module change needs coverage against the fixture repos in `tests/fixtures/`.
5. **Open a pull request.** Describe what changed and _why_. Link the issue it closes.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/). This is load-bearing, not cosmetic: the release workflow derives semantic versions from these prefixes.

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:** `feat` (→ minor bump), `fix` (→ patch), `docs`, `refactor`, `test`, `chore`, `ci`, `perf`, `build`. A `!` after the type, or a `BREAKING CHANGE:` footer, triggers a major bump.

**Scopes:** `secrets`, `dependencies`, `licenses`, `docs`, `bus-factor`, `scoring`, `badge`, `cli`, `action`.

**Subject:** imperative mood ("add", not "added" or "adds"), lowercase, no trailing period, 50 characters or fewer.

**Body:** wrap at 72 characters. Include it only when the _why_ isn't obvious from the diff — explain reasoning and tradeoffs, don't restate the change.

```
feat(scoring): reweight N/A categories instead of awarding 100

A repo with no dependency manifest scored a free 100 on a 25%
category, inflating the total above repos that do have deps.
Redistribute the weight proportionally across applicable
categories instead.

Closes #17
```

```
fix(bus-factor): exclude bot commits from authorship
```

## Adding a new module

`src/modules/` is the extension point. A new language audit (Python's `pip-audit`, Ruby's `bundler-audit`, Go's `govulncheck`) should drop in without touching the orchestrator or the scoring engine. If your module requires changing either, the module interface is wrong — say so in the issue.

A module must:

- **Return the shared result shape** — a category score (0–100) plus a list of findings, each carrying a file, a location, a description of the problem, and a concrete fix.
- **Degrade gracefully.** If the underlying tool isn't installed (no Composer, no Python), report the category as `N/A` with a clear message and an install hint. Never crash, never silently penalize the score. The scoring engine redistributes the weight of `N/A` categories across the applicable ones.
- **Run locally.** No external API calls, no tokens, no network beyond fetching a vulnerability database. This keeps the tool usable in any CI and preserves zero-config.
- **Never be silently wrong.** If a precondition is missing — a shallow clone with no history for bus-factor analysis, for instance — report `N/A` with a warning. Wrong output is worse than no output, because nobody checks a number that looks plausible.
- **Ship with fixtures.** Add a repository under `tests/fixtures/` with the problem planted, so the module's output can be asserted against a known input.

If your module plants a secret in a fixture for testing, allowlist it in the project's `.gitleaks.toml` — otherwise our own self-scan finds it and zeroes the secrets category.

## Scoring changes

Weights live in `src/scoring/weights.json` and are overridable per project. Changing the _defaults_ changes every user's score overnight, so a weight change needs justification in an issue before a PR — including what it does to the scores of the reference repositories.

Two rules in the engine are deliberate special cases, not oversights:

- **Exposed secrets are a hard zero**, not a proportional penalty. One critical match zeroes the category.
- **Secrets are scanned on HEAD only**, not through git history. Old rotated secrets in history would cause an unfixable permanent zero on a 30% category. History scanning is opt-in.

## Reporting security issues

Do not open a public issue for a vulnerability in this tool. See [SECURITY.md](SECURITY.md), or email the maintainer directly.

## Code of conduct

Be decent. Assume good faith, critique the code rather than the person, and accept that maintainers may decline a change that's well-built but out of scope.

## License

By contributing, you agree that your contributions are licensed under the same terms as the project. See [LICENSE](LICENSE).
