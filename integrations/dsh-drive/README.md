# Cross-entry exclusion for the fixed nightshift workspace

The legacy driver cannot yet prove all detached descendants have stopped; sharing its lock as though it could would create false handoff evidence. Instead, this integration **excludes enrolled fixed workspaces from drive**, in day and night modes. Independent per-line workspaces are unchanged. It is an entry restriction, not an OS sandbox.

`protected-workspaces.mjs` reads `~/.dsh/state/mate-v2-nightshift-workspace-locks/managed-workspaces.json`:

```json
{"version":1,"workspaces":[{"owner":"mate-v2-nightshift","workspace":"/canonical/fixed/workspace","repositories":["/canonical/fixed/workspace/new/repo"]}]}
```

Exact, ancestor, descendant and symlink aliases are rejected before Pi spawn. Nested `new/<repo>` aliases are checked. An invalid registry fails closed. A system with no enrolled registry keeps existing driver behavior. Manual editors and arbitrary unrelated programs are not intercepted.

## Reproducible package preparation

```bash
node integrations/dsh-drive/prepare-copy.mjs /absolute/original/dsh-drive /absolute/new-copy /absolute/driver-config.json
```

The script checks original file SHA256s, copies into a NEW directory, and adds the guard in both `src/driver.mjs` and CLI `run` before session/log changes. It prepares an independently installable `@local/dsh-drive-nightshift` bundle, with localized metadata and an original icon. Configuration matches this installation's maxConcurrent=4; review before deploying elsewhere. Never patch the installed profile manually.

Install via `plugin_manager` after checking no active runs: disable the old `dsh-drive` row, install the guarded bundle, verify `drive_lines` and guard rejection. The old package remains available for rollback. A second driver tool registration must not run concurrently.

## Standalone and legacy launchers

For standalone source not in Git, save original file bytes/hashes before changes, add the same module to `src/`, and apply these targeted edits:

- driver: import `./protected-workspaces.mjs`; immediately after required workspace validation call `assertDriveWorkspaceAllowed(path.resolve(workspace))`.
- CLI: import `../src/protected-workspaces.mjs`; before `buildPiEnv`, validate both `r.workspace` and `process.env.PI_DRIVE_WORKSPACE || r.workspace`.
- historical `pi_drive.mjs`: import `./dsh-drive/src/protected-workspaces.mjs`; after prompt validation, call `assertDriveWorkspaceAllowed(path.resolve(WORKSPACE))`.

Legacy original SHA256: `ead883b35f56c827aba468b8325e76b61a36c823ee32fc4ac136661b1d52d8b1`. The two current-driver baselines are recorded by the preparation script. Do not apply the patch if baselines have changed without reviewing/rebasing.

## Tests and boundaries

- Superagent's `tests/drive-exclusion.spec.ts`: 4 isolated registry/alias cases.
- Driver tests require their original parent `.dsh-driver/tools` and config layout. A naive package-only copy has unrelated fixture failures; use a complete **disposable** parent layout, not live business directories. Verified 244 checks with 0 failures in that layout.
- Both protected CLI and kernel deny a fixed-workspace target with a fake executable before a Pi process is spawned. Never use a live business prompt as a guard test.
- Tool guard does not claim to block arbitrary shell `cd`, manual Pi invocation, or any unrelated same-user executable. Day/night handoff still requires operator discipline and process inspection.

## Rollback

Use Plugin Manager to disable `@local/dsh-drive-nightshift`, then re-enable the old driver row. Restore the backed-up standalone files only after verifying current files still match the deployed versions. Leave the registry intact until the nightshift service is stopped/reconciled. Re-enabling an unprotected driver while it can target the fixed workspace weakens exclusion; this must be an explicit rollback choice, not an automated repair.
