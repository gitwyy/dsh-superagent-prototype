# Fixed-workspace Mate v2 nightshift (construction milestone)

This opt-in execution mode uses the existing Superagent Feishu Source and durable reply Outbox, but **does not start the normal DSH assessor/worker executor**. One persistent Pi session works in a fixed workspace. It is not a second Feishu consumer and does not inherit a Mate 1.0 project bot.

## Current capability and limits

- Default: `DAY_MANUAL`. Messages queue tasks; enqueue does not grant execution.
- A task names exact repository aliases and `read` or `write` access. Its owner must approve its ID. Starting a shift is a separate explicit command with an absolute timestamp/timezone, at most 12 hours ahead.
- Only allowlisted human direct messages are accepted. Group chats, bot messages, unknown senders and non-Feishu inputs never reach the legacy executor.
- Persistent SQLite inbox/state/outbox deduplicates messages and preserves uncertain results. Conservative locks never auto-steal a stale reservation: a dead supervisor may have left a writer alive.
- Pause/hand-off revokes dispatch, cancels the current run and verifies the POSIX process group is gone. Uncertainty enters `RECOVERY_REQUIRED`, not a false safe hand-off.
- **Push/MR publication, deployment, MCP and subagents remain disabled.** The runner reads scoped text, creates approved `sdd/` or `agent/` branches and edits scoped files. Optional `night_action` validation and local commit require a separate `授权动作` message plus locally pinned repository recipes. Nothing is enabled merely by the token's permissions. Dirty results still block the next task unless committed through approved checks or reviewed by a person. This is not yet complete autonomous overnight refactor delivery.
- Validation recipes execute operator-reviewed programs with normal OS permissions, not in a sandbox. Executable/source SHA256 pins prevent silent recipe replacement but do not prove that code is safe. Defaults configure no recipes. Validation receipts bind current source/HEAD/pins; changed source invalidates them. Commits enumerate only approved paths and never amend/reset/merge. Uncertain mutations require manual recovery, not retries.
- The Pi tool policy is not an OS sandbox. It cannot prevent an operator or unrelated same-user process from modifying the same directories. Human and automated writers must obey the same hand-off discipline.
- Actual mate-pi skills and prompt templates are loaded explicitly; ambient extensions, MCP, background subagents and group notification scripts are disabled. No silent bypass of a blocked skill step.

## Chinese private-message commands

```text
帮助
状态
入队 只读 mate-workspace | 阅读已确认 spec，列出下一步；不改文件
入队 修改 mate-account,mate-workspace | 执行明确批准的 spec/task；说明目标与验收
批准任务 <task-id>
授权动作 <task-id> 验证,提交
开始夜班 截止 2026-11-10T07:00:00+08:00
暂停
我要接班
取消任务 <task-id>
确认恢复
```

Unknown natural-language messages return usage rather than guessing authorization. A restart never implicitly starts a shift. Unknown tasks are not automatically replayed. `确认恢复` is valid only after the operator has independently reconciled live processes/changes; the runner still requires a successful preflight. Do not remove stale locks until every associated writer is confirmed stopped.

## Configuration

Set the main bundle's `nightshiftConfig` to an absolute, locally managed JSON file. Leave it empty to preserve the existing single-project ticket mode. Use a **separate state directory** with no open legacy tickets, and no enabled non-Feishu Sources. Feishu must use `chats: []`, `otherChats: none`, `directMessages: true` and a nonempty owner allowlist.

```json
{
  "enabled": true,
  "workspace": "/absolute/mate-workspace",
  "stateDir": "/absolute/private-state/nightshift",
  "sessionFile": "/absolute/private-state/nightshift/pi-session.jsonl",
  "piExecutable": "/absolute/bin/pi",
  "piHome": "/absolute/dedicated-pi-home",
  "harnessRoot": "/absolute/mate-pi",
  "lockRoot": "/absolute/shared-workspace-locks",
  "repositories": {
    "mate-workspace": "/absolute/mate-workspace",
    "mate-account": "/absolute/mate-workspace/new/mate-account"
  },
  "provider": "mate-newapi",
  "model": "gpt-6-astra",
  "thinking": "low",
  "maxTaskSeconds": 1800,
  "acceptAfter": "2026-11-09T14:00:00Z",
  "freezeWindows": [
    { "from": "2026-11-12T00:00:00+08:00", "until": "2026-11-14T00:00:00+08:00" }
  ]
}
```

Repository paths are canonicalized; Mate 1.0, legacy, external paths and unlisted nested repositories are excluded. State/session/piHome must live outside business repositories. `acceptAfter` prevents historical chat messages becoming new commands during migration. Runtime/model must be explicit and available. Dedicated piHome must not contain auto-loaded packages or executable credential configuration.

No keys belong in configuration examples, repository history or chat. Reuse an explicitly authorized private credential store; do not run a new GitLab login against the operator's shared keychain. Nightshift startup requires only the Feishu bot transport: it skips global git/PATH shims and GitLab account checks.

## Operational inspection

`GET /orchestrator/api/state` adds `nightshift` with mode, deadline, fixed workspace, permitted aliases, queue and active run. The Superagent overview displays the nightshift queue rather than the legacy ticket counters. Status/hand-off receipts remain deliverable even when normal processing is paused.

Store roles:
- `nightshift.sqlite`: task approvals, deduplication receipts, run status, private reply outbox.
- `controller.lock`: one supervisor for the state directory.
- shared hash-of-realpath lock: only one managed owner of the fixed workspace.
- `pi-runner.lock`: persisted process-group ownership; retained when shutdown cannot be verified.
- persistent Pi session: recorded under `sessionFile`; reopening does not replay a completed or unknown task.

## Verification and roll-back

Run `pnpm typecheck`, `pnpm test`, `pnpm build`. Tests use fake Pi subprocesses and disposable Git repositories. `tests/nightshift-smoke.manual.ts` is an explicit real-model opt-in smoke; it creates a scratch repo, reads a fixture and verifies clean state/process exit. It is not automatically part of the test suite and must never be pointed at a business repo.

Rollback: stop only the owning nightshift host; confirm Pi group termination/locks, then launch the previous Superagent build/state. Never run old and new listeners for the same Feishu application at once. Preserve nightshift state and unknown outcomes for inspection; do not delete locks or replay tasks as a recovery shortcut.

## Remaining before full overnight delivery

1. Configure and independently validate project-specific build/test recipes; implement pinned dedicated publication identity and bounded push/MR operations. Validation/commit broker exists, publication intentionally fails closed.
2. Owned dirty-change checkpoints and safe continuation between steps in a single task.
3. Remote approval/SDD confirmation correlation and independent verification/handoff evidence.
4. End-to-end private-message execution after the user explicitly queues, approves and starts a bounded v2 task.
