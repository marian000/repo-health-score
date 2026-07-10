# Security policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/marian000/repo-health-score/security/advisories/new). Please do not open a public issue for a vulnerability.

Include what you can: the version, the platform, and a way to reproduce it. A proof of concept is welcome but a clear description of the flaw is enough.

Expect an acknowledgement within a week. If a report turns out to be valid, the advisory will credit you unless you ask otherwise.

## Supported versions

Until 1.0, only the latest release is supported. Fixes land on `main` and go out in the next release.

## What this tool does that is worth scrutinising

This is a scanner. It runs against untrusted repositories, on CI runners that hold tokens. Three parts of it are security-relevant, and reports about them are especially welcome.

**It downloads and executes a binary.** Gitleaks is a Go binary, not an npm package. It is fetched on first run from the pinned release, verified against a SHA-256 digest committed in `src/util/gitleaks-binary.ts`, and cached. The cached copy is re-verified against that digest on every use, not only at download — a poisoned cache is detected, wiped, and re-downloaded rather than executed. Set `REPO_HEALTH_GITLEAKS_PATH` to skip the download entirely and use a binary you trust.

**It executes subprocesses in a repository it does not control.** Every subprocess goes through `src/util/exec.ts`, which uses `execFile` and never `exec`, so arguments are passed as an array and never reach a shell. A repository path or branch name containing `;` or `$(...)` is a string, not a command. There is no shell interpolation anywhere in the codebase, and adding one would be a vulnerability rather than a style choice.

**It reports paths and matched content.** Findings are made repo-relative before they are rendered, so a PR comment does not publish the absolute path of a maintainer's home directory. Secret findings report the rule that matched and the location, never the matched credential.

## Scanning a pull request from a fork

The `pull_request` event checks out the head of the PR, which an attacker controls. Two consequences follow, both deliberate:

The repository's own `.gitleaks.toml` is honoured, because test fixtures legitimately need to allowlist planted secrets. A pull request can therefore add a catch-all allowlist and score 100 on the secrets category. The action emits an informational finding whenever a repository-supplied config was used, so the number is never produced silently under rules the scanned tree provided. **Read the config before trusting the score on an untrusted PR.**

Do not run this action on `pull_request_target`. That event runs with a writable token and access to secrets while checking out untrusted code, which would hand a repository token to anyone who opens a pull request. The action is built for `pull_request`, where the token is read-only on forks and the comment step degrades to the job summary.

## Reports that are out of scope

A finding this tool misses is a bug, not a vulnerability — open an issue. The same goes for a false positive. The score is an indicator, not a security boundary, and it is not designed to resist a repository author who wants their own repository to score well.
