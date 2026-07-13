# Composer Fixture

A PHP project with two planted problems and nothing else.

`guzzlehttp/guzzle` is pinned at 6.5.0, which carries a long list of published
advisories. `acme/gpl-lib` does not exist on packagist; it is a stub in the
materialised `vendor/`, and it is GPL-3.0-or-later inside an MIT project.

This fixture exercises the Composer paths of `dependencies` and `licenses`. It
has no PHP sources and no commit history, because `docs` and `bus-factor` do not
care which package manager a project uses.

## Installation

```
composer install
```
