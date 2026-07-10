# Test fixtures

Two repositories with known contents, so a scan has an expected answer to be
wrong about. `clean` is healthy and scores an A. `planted` carries one of every
problem the five modules look for, and scores an F.

They are stored here as plain file trees, not as git repositories, and
`tests/support/fixtures.ts` materialises each one into a temporary directory
before a test runs: it copies the tree, substitutes the planted secret, writes
the `node_modules` stubs, and replays a scripted commit history.

Three details of that are not incidental.

**A repository cannot be nested inside a repository.** `docs` needs
`isGitRepo`, and `bus-factor` needs real history — thirty-odd commits by two
named authors, with three files churned far more than the rest so the "top 20%
by churn" rule has something to select. Committing a `.git` directory here is
not possible, so the history is replayed on every run.

**`node_modules/` is in the root `.gitignore`,** so the stub packages cannot be
committed either. The `licenses` module reads the installed tree via `npm ls`,
which needs those directories on disk. They are three-line `package.json` files
with nothing but a name, a version, and a license.

**The planted secret is never committed.** `config/production.env` holds the
placeholder `__PLANTED_AWS_ACCESS_KEY__`, and the real credential-shaped string
is assembled at materialisation time. Committing it would trip this project's
own secret scan on every self-scan run, and GitHub's push protection — enabled
on this repository — would reject the commit that introduced it.

## What each fixture is expected to produce

| Category | `clean` | `planted` | Why |
|---|---|---|---|
| Secrets | 100 | **0** | An AWS access key id in `config/production.env`. A `critical` finding hard-zeroes the category. |
| Dependencies | 100 | **0** | `lodash@4.17.4` carries enough advisories to drive the penalty past 100, so the score floors. |
| Licenses | 100 | **75** | `gpl-lib` is GPL-3.0 and reached transitively through `lodash`, in an MIT project. Strong copyleft is `high`: −25. |
| Documentation | 100 | **35** | README has an Installation section but no Usage one (50), and one of four public functions has a docblock (25). `50 × 0.4 + 25 × 0.6`. |
| Bus factor | 100 | **0** | The three most-churned files have a single author. In `clean` they alternate between two. |

Totals: `clean` scores 100 (A). `planted` scores 17 (F) — the weights sum to
100 only because every category is applicable.

## Two things worth knowing before you edit these

**Gitleaks decodes base64.** A key hidden as
`Buffer.from('QUtJQV...', 'base64')` is found and reported. String
concatenation is not, which is why `fixtures.ts` builds the key from two
halves.

**Gitleaks reports absolute paths,** so an allowlist anchored with
`paths = ['''^tests/fixtures/''']` matches nothing and silently suppresses
nothing. Write it unanchored. There is no `.gitleaks.toml` in this repository
precisely because nothing here needs allowlisting — an allowlist that exists
only out of habit is an allowlist nobody rereads.
