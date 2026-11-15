# Magician Security Check

- Runtime: Node 22+. Zero runtime npm dependencies; CLI entry point is `cli.mjs`.
- `node cli.mjs matrix --root <folder> --json` discovers one repo or a matrix of repositories automatically; `doctor` checks prerequisites; `scan` performs a read-only audit with the same scope rules.
- `update` plans security changes; only `update --apply` mutates compatible npm lockfiles in clean Git repos. It never commits/pushes and must restore unsafe or failed changes. Other ecosystems/runtime/major changes remain review actions.
- For installation in another authorized project, use `node cli.mjs init --root <project> --dry-run --json`, inspect the plan, then rerun without `--dry-run`.
- JSON stdout is one schemaVersion=1 document; exit codes are 0=ok, 1=findings, 2=error/incomplete coverage.
- Run `node --test` for behavior changes. CI also validates the packed CLI and real npm/OSV auditing on Node 22/24/26.
- Preserve non-interactive behavior, existing user instructions/configuration, and fail-closed autofusion. Do not add an install/prepare lifecycle script or bypass branch checks.
- Behavior contracts: `docs/automation-spec.md`; installed agent guide: `docs/agents.md`.
