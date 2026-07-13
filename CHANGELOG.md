# Changelog

## 1.0.0 (2026-07-13)


### Features

* **action:** add the composite GitHub Action ([f307e87](https://github.com/marian000/repo-health-score/commit/f307e874d720fe088aaeaef90a3dc49ba6e6f401))
* **badge:** add badge, PR comment, and JSON report renderers ([8e64b3c](https://github.com/marian000/repo-health-score/commit/8e64b3cd933a2d32f180f86167a62d4fa6a958ff))
* **cli:** add --base-ref for base-branch deltas ([90a2603](https://github.com/marian000/repo-health-score/commit/90a260348d78b255e9af7b8fdc76e77feb13b933))
* **cli:** add orchestrator and npx entry point ([cab17a0](https://github.com/marian000/repo-health-score/commit/cab17a0151a84919c5bc1cf45cb7d1234e56ea83))
* **cli:** add process execution and source-file utilities ([2723d2c](https://github.com/marian000/repo-health-score/commit/2723d2c54313d06c9e7aa75b8458a65e8a6e304a))
* **dependencies:** audit Composer and npm advisories and licenses ([c63006c](https://github.com/marian000/repo-health-score/commit/c63006cc5e60b15230790290576bd2fe714827ab))
* **docs:** add documentation coverage and bus-factor analysis ([a9b8445](https://github.com/marian000/repo-health-score/commit/a9b84458a41e4472cc8ce73f764d4eddb4c88a18))
* **scoring:** add module contract and weighted scoring engine ([1d64517](https://github.com/marian000/repo-health-score/commit/1d645177018181f8bd1a6e9a1bce09f0d7133e2f))
* **secrets:** wrap Gitleaks with a checksum-pinned binary fetch ([7a2eaa8](https://github.com/marian000/repo-health-score/commit/7a2eaa8ea264d0134cb8ad20c0b0f95eaf5841b2))


### Bug Fixes

* **cli:** compare only shared scored categories ([97fba6c](https://github.com/marian000/repo-health-score/commit/97fba6cd7421f19646447e5973380cec6b9ad65f))
* **cli:** lint without requiring a prior build ([4cdc0ab](https://github.com/marian000/repo-health-score/commit/4cdc0ab6957e010bdf9451c646bf821fa79cf445))
* **dependencies:** key advisory dedupe on its id ([782e30b](https://github.com/marian000/repo-health-score/commit/782e30bce67e30a348056b669824d8b807ce6697))
* make the Composer paths actually scan, and stop them running code ([#6](https://github.com/marian000/repo-health-score/issues/6)) ([589d23f](https://github.com/marian000/repo-health-score/commit/589d23f75cad4a62678d7b20ed69b34057ee9cb2))
