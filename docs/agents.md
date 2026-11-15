# Magician Security Check · Agent interface

Requires Node 22+. Run from the folder containing this guide. All commands are non-interactive and support `--root <directory>`: either one repository or a matrix folder containing repositories. Scope is detected automatically; override ambiguous layouts with `--scope project|workspace`.

```sh
node .magician/cli.mjs matrix --json
node .magician/cli.mjs inventory --json
node .magician/cli.mjs doctor --json
node .magician/cli.mjs scan --json
node .magician/cli.mjs update --dry-run --json
node .magician/cli.mjs update --apply --json
```

`inventory` is an offline discovery step. `doctor` checks configuration and whether native package managers/OSV are available. `scan` audits all independent Node roots and uses `osv-scanner` for other dependency ecosystems. With `scan --offline`, only runtime version lookups are skipped; package audits still use the network.

## Output contract

With `--json`, stdout contains exactly one JSON object, never prose or prompts:

```json
{"schemaVersion":1,"command":"scan","status":"ok","exitCode":0,"root":"/project","errors":[],"warnings":[],"data":{}}
```

| Exit | Status | Agent action |
| --- | --- | --- |
| 0 | `ok` | Inspect warnings and coverage before reporting success. |
| 1 | `findings` | Review runtime/configuration failures or dependency vulnerabilities; verify a compatible correction. |
| 2 | `error` | Fix missing tools, registry/network failures, invalid arguments or incomplete scans, then rerun. Never treat this as clean. |

`data.repositories[]` is always an array, even for one repo. Each entry includes `root`, `relativePath`, `status`, `exitCode`, errors/warnings and its own `data.inventory`, `data.checks`, raw scanner JSON, coverage or update actions. `data.summary` aggregates repository outcomes. A failing repo does not hide the others. The contract is versioned by `schemaVersion`, independently of package version.

Machine-readable schema: `.magician/docs/agent-report.schema.json`.

## Installation and updates

```sh
node .magician/cli.mjs init --dry-run --json
node .magician/cli.mjs init --json
```

Run the newer, pinned package's `init` command to upgrade the local copy. Files recorded in `.magician/install-manifest.json` are updated only while their content still matches the previous installation. Modified user files cause a conflict before any writes. The installer preserves existing AGENTS.md instructions; a preexisting Dependabot configuration receives a merge candidate, not a replacement. In a matrix folder, init installs the shared CLI and guides only; install CI inside individual repos using `init --root <repo>`. Commit the appropriate local CLI, generated workflows, Dependabot and guides in each Git repository.

`init --automerge` additionally installs the guarded Dependabot workflow. Enable Dependabot alerts/security updates and squash/auto-merge in GitHub; require **Rubicon security** and the application's real test/build checks on the default branch; set `RUBICON_REQUIRED_CHECKS` to those names as a JSON array, e.g. `["Rubicon security","Application tests"]`. These are repository settings, not permissions granted by local installation. Private repositories need a GitHub plan supporting branch protection.

## Operating boundaries

- Inventory, doctor and scan do not edit application files or GitHub settings. Do not install missing tools, merge PRs or deploy without authority for the target project.
- Never weaken required checks, run `audit fix --force`, or hide a scanner error to obtain a successful exit code.
- A clean audit covers known advisories and resolved artifacts, not the production runtime or behavioral compatibility of an upgrade.
- Version/security updates are proposed by Dependabot. Patch/minor autofusion still requires the configured server-enforced checks; major updates, code, workflow and runtime changes require review.

## Applying local security corrections

`update` only plans by default and returns findings when corrections are pending. Review each repo's `data.actions`; use `--apply` only within the user's authority. The local automatic backend currently supports npm lockfile-only corrections, without force or lifecycle scripts. Other managers/ecosystems, runtime changes and unavailable/major corrections remain explicit review actions for the agent or Dependabot.

Application requires a clean Git worktree and a per-repo update lock. Unsafe version/manifest changes or failed post-audits are restored. A stale lock must be reviewed against running processes before removal. The command never commits, pushes, merges, deploys or runs application tests. After applied changes, inspect `changedFiles` and run the project's tests/build before publishing; `tests: "not-run"` is explicit in the report. A clean advisory report does not prove application compatibility.
