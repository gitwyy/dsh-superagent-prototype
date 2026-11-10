# Task-preauthorized GitLab release capability

## Authorized scope

The operator approved the existing 17 Mate v2 aliases, task-level preauthorization for push/create MR/merge/non-production deployment, 30-day project bots, and fast-forward-only merge settings. Production remains prohibited. The existing freeze is retained: 2026-11-12 00:00 through 2026-11-14 00:00 Asia/Shanghai.

**Deployment already exists:** merging master triggers the existing Jenkins webhook builds. `deploy` here means adopting/observing those exact builds. It does not POST a second Jenkins build, automatically retry, cancel unrelated jobs, or invent a new delivery pipeline.

Runtime capability is enabled only by an explicit locally configured `releasePolicy` and current operator attestation, after identity/route/write-window integration has been verified. A token or project setting alone is not runtime permission. Current deployment supports the existing **test** routes; preprod has no verified destination and remains unavailable. Production is always outside this policy.

## Human authorization

Normal task approval and local actions remain separate. A release grant binds task owner, approval message, policy digest, exact repository/source branch/target/base SHA, action list, environment and expiry. Source branches must be `agent/` or `sdd/`; targets cannot be pushed directly.

Example structure (replace every placeholder, valid for at most 12 hours and never across the freeze):

```text
预授权发布 <task-id> 截止 <ISO-datetime-with-offset> | [{"repository":"mate-account","sourceBranch":"sdd/<task-branch>","targetBranch":"master","baseSha":"<40-hex-reviewed-target-base>","environment":"test","actions":["push","create_mr","merge","deploy"]}]
```

For application repos with automatic Jenkins deployment, merge requires **both** merge and deploy grants. Preprod is not inferred from a name; only a verified locally configured route is available. A task grant does not start work: an active night shift and unexpired task budget are also required.

Private read-only control commands:

- `发布状态`: lists the sender's journaled external operations.
- `核查发布 <operation-id>`: authoritative readback only; never resends an external write.

## Host trust boundary

Pi only receives a run-scoped Unix socket capability. Local validation/commit runs in the host action broker with isolated process groups; release token paths, route policy and token values are never serialized into Pi environment or tool arguments. Host verifies actual Git HEAD/parent/tree/branch before recording a durable commit receipt. Publication requires a complete same-task receipted linear commit chain from the authorized base; a clean worktree is not proof of ownership.

These are cooperative process/tool boundaries, **not an OS sandbox**. Same-user malicious processes or deliberately hostile validator code are outside file-permission confidentiality claims. Validators remain reviewed/pinned code; they must not detach, access unrelated credentials or publish independently.

## Mutation and reconciliation

- Exact expected GitLab numeric user ID + username, project ID/path, host and target branch are checked with the same private credential used by the action.
- Default transport is HTTPS. The operator explicitly accepted internal HTTP only for the company GitLab host; redirects and TLS-verification disabling are not permitted.
- Push exports checked local objects to a host-private bare repository, ignoring checkout transport/config/hooks/alternates; one exact nonforce SHA refspec, no tags or deletion.
- MR creation uses a stable host marker, exact source/target, and refuses conflicting/unowned MRs.
- Merge requires server-enforced FF-only, current exact target base/source SHA, successful required MR pipeline/jobs, approvals and resolved discussions. No auto-merge, squash, rebase or force-push fallback.
- Every side effect is journaled as prepared then dispatching before sending; acceptance is not completion. Interrupted/ambiguous results become unknown and never auto-retry.
- Readback verifies the actual merged SHA/tree and exact sibling Jenkins job→build→source SHA→destination/config/artifact digest/health evidence. Missing or changed evidence remains active/unknown.
- Local Pi exit does not mean remote CI/deployment stopped. The controller refuses safe handoff while remote effects are active/unknown. Generic recovery cannot bypass the release journal.

## Jenkins write-window gate

The standalone Python gate validates a canonical HMAC-signed capability for one exact job/source/project/non-production destination and a short window. It writes durable exclusive nonce and operation/job intent markers before granting admission. Unknown/reused markers fail closed. It must execute at the existing worker's actual deployment-write boundary, not only at build start. Signed capabilities expire at the minimum task/shift/freeze boundary.

The gate cannot cancel an already-admitted patch, prove deploy completion, or learn later revocation while offline. Trusted bot actor propagation, grant retrieval, deployment-only secret mounts, restricted observer credentials and publisher hashes are required for activation. Unrelated human pipelines retain their existing route. No new build is triggered during onboarding.

Current publisher configuration is verified at onboarding and represented by a **short-lived operator attestation** (initially24h). Runtime compares that local record and expiry to policy; it does not continuously GET administrator-only Jenkins config.xml. An administrator change requires re-review/renewal; expired evidence blocks releases instead of granting indefinite permission.

Local `source` validation is a pinned, non-executing syntax/whitespace/conflict check. It explicitly does not compile or run unit tests. Required full validation remains the exact-source-SHA successful GitLab MR pipeline. Existing protected tracked files may participate in host-private digesting but cannot be modified/published through the ordinary guard.

Preauthorized release branches are created only at the exact admitted base SHA. Missing local objects or an existing conflicting branch stop the task without reset/rebase. The operator must synchronize that base safely; source branches never silently start from a stale feature checkout.

## Provisioning and rollback

`scripts/provision-nightshift-release.py` performs only project-token creation and `merge_method=ff` changes using the operator's existing authenticated CLI. It does not call auth login, modify personal keychain state, push code, create/merge MR, or trigger builds. It records before/after settings and token IDs in a private 0700 directory; secrets use 0600 files and never stdout. Interrupted provisioning requires read-only reconciliation, not duplicate token creation.

The current 17 project tokens are Maintainer(40), scopes `api` and `write_repository`, expiring 2026-12-10. Those are project-scoped, not group/instance administrator grants. Runtime policy still denies direct protected-target push and out-of-scope actions regardless of token capability.

Rollback after checking no active/unknown release effects: disable release policy; revoke only these recorded project-token IDs if desired; restore only each recorded prior merge_method after verifying it has not changed since provisioning. Do not rotate/revoke unrelated identities or weaken branch protections. Jenkins changes have their own exact backup/hash-checked rollback. `rollback-jenkins-nightshift.py` plans a targeted restoration of this operation's20 job parser/extraction and4 Managed changes; default dry-run refuses drift. Observer ACL rollback uses the frozen `observer-rollback.groovy` operation receipt. Never remove gate assets while configured publishers still require them.

API references: [GitLab project access tokens](https://docs.gitlab.com/api/project_access_tokens/), [projects](https://docs.gitlab.com/api/projects/), [merge requests](https://docs.gitlab.com/api/merge_requests/). Server API version/edition differences fail closed rather than bypassing approval evidence.
