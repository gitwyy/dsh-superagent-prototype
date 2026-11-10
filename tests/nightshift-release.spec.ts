/** Release coordinator tests use fake transports and isolated SQLite directories; no business/network mutations. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createReleaseCoordinator, policyDigest, type ReleaseCoordinator } from '../src/nightshift/release/coordinator.ts'
import { ReleaseJournal, type ReleaseIntent } from '../src/nightshift/release/journal.ts'
import { releaseMarker, type MergePlan, type CandidateEvidence, type ReleaseAuthority, type ReleaseGrant, type ReleasePolicy, type ReleaseRequest, type ReleaseTransport, type RemoteSnapshot } from '../src/nightshift/release/contracts.ts'

const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40), TREE = 'c'.repeat(40), CI = 'd'.repeat(64), JOB = 'e'.repeat(64)
const roots: string[] = [], coordinators: ReleaseCoordinator[] = []
const signal = () => new AbortController().signal
const later = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString()
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nightshift-release-')); roots.push(root)
  const policy: ReleasePolicy = { version: 1, enabled: true, maxGrantSeconds: 3600, freezeWindows: [], repositories: { repo: {
    alias: 'repo', root: join(root, 'repo'), projectId: 17, projectPath: 'mate/repo', host: 'git.example.test', apiOrigin: 'https://git.example.test', expectedUserId: 9, expectedUsername: 'release-bot', credentialFile: join(root, 'credential'), targetBranch: 'develop', ciSha256: CI, requiredJobs: ['test'], mergeTriggersDeploy: false,
    triggerPolicy: { reviewedAt: later(-60_000), expiresAt: later(3_600_000), productionExcluded: true, fingerprint: 'reviewed-topology-v1' },
    environments: { test: { kind: 'jenkins', id: 'test-route', jobs: ['test-deploy'], origin: 'https://jenkins.example.test', expectedConfigSha256: { 'test-deploy': JOB }, destinationId: 'test-cluster', remoteDeadlineEnforced: true, credentialRef: 'host-only-jenkins' } },
  } } }
  const grant: ReleaseGrant = { id: 'grant-1', taskId: 'task-1', ownerId: 'owner', approvalMessageId: 'dm-approval', issuedAt: later(-1000), expiresAt: later(1800_000), policyDigest: policyDigest(policy), scopes: [{ repository: 'repo', sourceBranch: 'agent/task-1', targetBranch: 'develop', baseSha: BASE, actions: ['push', 'create_mr', 'merge', 'deploy'], environment: 'test' }] }
  const candidate: CandidateEvidence = { taskId: 'task-1', repository: 'repo', sha: SHA, treeSha: TREE, baseSha: BASE, sourceBranch: 'agent/task-1', clean: true, commitReceiptId: 'host-commit-receipt', validated: true, validationReceiptIds: ['host-validation-receipt'], ciSha256: CI, changedProtectedPaths: [] }
  const snapshot: RemoteSnapshot = { identity: { id: 9, username: 'release-bot' }, project: { id: 17, path: 'mate/repo', defaultBranch: 'develop', pipelineRequired: true, fastForwardOnly: true }, targetSha: BASE, targetCiSha256: CI, productionExcluded: true, triggerPolicyFingerprint: 'reviewed-topology-v1', pipeline: { id: 88, sha: SHA, status: 'success', jobs: [{ name: 'test', status: 'success', allowFailure: false }] } }
  let activeDeadline: string | undefined = later(1800_000), authorized = true
  const authority: ReleaseAuthority = { grant: vi.fn(() => structuredClone(grant)), isAuthorized: vi.fn(() => authorized), activeDeadline: vi.fn(() => activeDeadline), candidate: vi.fn(async () => structuredClone(candidate)) }
  const transport: ReleaseTransport = { observe: vi.fn(async () => structuredClone(snapshot)), dispatch: vi.fn(async () => ({ remoteIds: ['remote-1'], detail: 'accepted, not completed' })) }
  const path = join(root, 'release.sqlite')
  const create = () => { grant.policyDigest = policyDigest(policy); const coordinator = createReleaseCoordinator(policy, path, authority, transport); coordinators.push(coordinator); return coordinator }
  const request = (action: ReleaseRequest['action'] = 'push'): ReleaseRequest => ({ taskId: 'task-1', repository: 'repo', action, sha: SHA, ...(action === 'create_mr' ? { title: 'Reviewed change' } : {}) })
  const mr = () => {
    snapshot.sourceSha = SHA
    snapshot.mergeRequest = { iid: 27, sourceProjectId: 17, targetProjectId: 17, sourceBranch: 'agent/task-1', targetBranch: 'develop', sha: SHA, state: 'opened', authorId: 9, draft: false, conflicts: false, mergeable: true, approved: true, unresolvedDiscussions: 0, marker: releaseMarker('task-1', 'repo', SHA) }
  }
  const route = () => { snapshot.deployment = { routeId: 'test-route', sourceSha: SHA, state: 'absent', ids: [], destinationId: 'test-cluster', healthy: false, remoteDeadlineEnforced: true, configSha256: { 'test-deploy': JOB }, deadline: grant.expiresAt } }
  const merged = () => { mr(); snapshot.mergeRequest = { ...snapshot.mergeRequest!, state: 'merged', mergeCommitSha: SHA, mergeCommitVerified: true, mergeTreeSha: TREE, mergeParents: [BASE] }; snapshot.targetSha = SHA }
  const builds = () => { snapshot.deployment!.builds = snapshot.deployment!.ids.map((id, index) => ({ job: policy.repositories.repo!.environments.test!.jobs[index]!, id, sha: SHA, destinationId: 'test-cluster', state: snapshot.deployment!.state as 'running' | 'succeeded' | 'failed', healthy: snapshot.deployment!.healthy, artifactDigest: `sha256:${JOB}` })) }
  return { root, policy, grant, candidate, snapshot, authority, transport, path, create, request, mr, route, merged, builds, revoke: () => { authorized = false }, deactivate: () => { activeDeadline = undefined }, deadline: (value: string) => { activeDeadline = value } }
}
function harnessAwaiting() {
  const h = fixture()
  h.policy.repositories.repo!.mergeTriggersDeploy = true
  h.policy.repositories.repo!.environments.test!.jobs.push('test-deploy-two')
  h.policy.repositories.repo!.environments.test!.expectedConfigSha256['test-deploy-two'] = JOB
  h.mr(); h.route(); h.snapshot.deployment!.configSha256!['test-deploy-two'] = JOB
  return { ...h, controller: h.create() }
}
function ordinaryFixture(deploy = false) {
  const h = fixture(), target = 'f'.repeat(40), mergedSha = '1'.repeat(40), mergedTree = '2'.repeat(40)
  h.policy.repositories.repo!.mergeMode = 'merge-commit'; h.policy.repositories.repo!.mergeTriggersDeploy = deploy
  h.mr(); h.snapshot.project.fastForwardOnly = false; h.snapshot.project.mergeMethod = 'merge'; h.snapshot.targetSha = target
  const plan: MergePlan = { version: 2, sourceSha: SHA, targetSha: target, expectedTreeSha: mergedTree, ciSha256: CI, validationProfile: 'full-verify' }
  h.transport.planMerge = vi.fn(async () => structuredClone(plan))
  vi.mocked(h.transport.dispatch).mockImplementation(async context => {
    context.assertAuthorized()
    if (context.request.action === 'prepare_merge') {
      h.snapshot.preparation = { plan: structuredClone(context.operation.mergePlan!), metadataDigest: '3'.repeat(64), operationId: context.operation.id, expiresAt: context.deadline, verified: true }
      if (deploy) { h.route(); h.snapshot.deployment!.approvedSourceSha = SHA; h.snapshot.deployment!.mergePlan = structuredClone(plan) }
    }
    return { remoteIds: [`${context.request.action}:accepted`], detail: 'fake acceptance only' }
  })
  const merged = () => {
    h.snapshot.mergeRequest = { ...h.snapshot.mergeRequest!, state: 'merged', mergeCommitSha: mergedSha, mergeCommitVerified: true, mergeTreeSha: mergedTree, mergeParents: [target, SHA] }
    h.snapshot.targetSha = mergedSha
    if (deploy) {
      h.snapshot.deployment = { ...h.snapshot.deployment!, sourceSha: mergedSha, approvedSourceSha: SHA, mergePlan: structuredClone(plan), state: 'running', ids: ['deploy-1'], healthy: false,
        builds: [{ job: 'test-deploy', id: 'deploy-1', sha: mergedSha, destinationId: 'test-cluster', state: 'running', healthy: false }] }
    }
  }
  return { ...h, target, mergedSha, mergedTree, plan, merged }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close()
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || !root.startsWith(join(tmpdir(), 'nightshift-release-'))) throw new Error(`Unexpected cleanup target ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('release authority and immutable evidence', () => {
  it('accepts a disabled empty policy but never dispatches, and rejects ambiguous/overflow timestamps', async () => {
    const h = fixture(); h.policy.enabled = false; h.policy.repositories = {}
    const c = h.create()
    expect((await c.execute(h.request(), signal())).status).toBe('blocked')
    for (const from of ['2026-11-12T00:00:00', '2026-02-30T00:00:00Z', '2026-11-12T24:00:00Z']) {
      expect(() => policyDigest({ ...h.policy, freezeWindows: [{ from, until: '2026-11-14T00:00:00+08:00' }] })).toThrow()
    }
  })

  it.each(['merge', 'deploy'] as const)('blocks operator-disabled %s even if a task grant includes it', async action => {
    const h = fixture(); h.policy.allowedActions = ['push', 'create_mr']; const c = h.create()
    expect((await c.execute(h.request(action), signal())).status).toBe('blocked')
    expect(h.transport.observe).not.toHaveBeenCalled(); expect(h.transport.dispatch).not.toHaveBeenCalled()
  })
  it.each(['push', 'create_mr'] as const)('allows %s after parallel target advances under narrowed policy', async action => {
    const h = fixture(); h.policy.allowedActions = ['push', 'create_mr']; h.snapshot.targetSha = 'f'.repeat(40)
    h.snapshot.project.fastForwardOnly = false
    if (action === 'create_mr') h.snapshot.sourceSha = SHA
    const c = h.create(); expect((await c.execute(h.request(action), signal())).status).toBe('accepted')
    expect(h.transport.dispatch).toHaveBeenCalledOnce()
  })
  it('hashes policy canonically including deadlines/freeze/route identity', () => {
    const h = fixture(), reordered = { maxGrantSeconds: h.policy.maxGrantSeconds, freezeWindows: h.policy.freezeWindows, repositories: h.policy.repositories, enabled: true, version: 1 as const }
    expect(policyDigest(reordered)).toBe(policyDigest(h.policy))
    reordered.freezeWindows = [{ from: '2026-11-12T00:00:00+08:00', until: '2026-11-14T00:00:00+08:00' }]
    expect(policyDigest(reordered)).not.toBe(policyDigest(h.policy))
    const route = structuredClone(h.policy); route.repositories.repo!.environments.test!.destinationId = 'other'
    expect(policyDigest(route)).not.toBe(policyDigest(h.policy))
  })

  it.each(['disabled', 'revoked', 'inactive', 'expired', 'future', 'too-long', 'policy', 'wrong-task', 'missing-action', 'target', 'base', 'source', 'production', 'attestation-expired', 'freeze'] as const)('blocks %s authorization without dispatch', async reason => {
    const h = fixture()
    if (reason === 'disabled') h.policy.enabled = false
    if (reason === 'freeze') h.policy.freezeWindows = [{ from: later(-60_000), until: later(60_000) }]
    const c = h.create()
    if (reason === 'revoked') h.revoke()
    if (reason === 'inactive') h.deactivate()
    if (reason === 'expired') h.grant.expiresAt = later(-1)
    if (reason === 'future') h.grant.issuedAt = later(60_000)
    if (reason === 'too-long') h.grant.expiresAt = later(7200_000)
    if (reason === 'policy') h.grant.policyDigest = '0'.repeat(64)
    if (reason === 'wrong-task') h.grant.taskId = 'other-task'
    if (reason === 'missing-action') h.grant.scopes[0]!.actions = ['create_mr']
    if (reason === 'target') h.grant.scopes[0]!.targetBranch = 'main'
    if (reason === 'base') h.grant.scopes[0]!.baseSha = 'f'.repeat(40)
    if (reason === 'source') h.grant.scopes[0]!.sourceBranch = 'agent/other-task'
    if (reason === 'production') (h.grant.scopes[0] as { environment: string }).environment = 'production'
    if (reason === 'attestation-expired') { await c.close(); h.policy.repositories.repo!.triggerPolicy.expiresAt = later(-1); const next = h.create(); expect((await next.execute(h.request(), signal())).status).toBe('blocked'); return }
    expect((await c.execute(h.request(), signal())).status).toBe('blocked')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
    expect(c.operations()).toEqual([])
  })

  it.each(['dirty', 'unvalidated', 'missing-receipt', 'empty-validation', 'bad-tree', 'wrong-ci', 'protected-path', 'wrong-task', 'wrong-sha'] as const)('rejects %s candidate evidence', async fault => {
    const h = fixture(), c = h.create()
    if (fault === 'dirty') h.candidate.clean = false
    if (fault === 'unvalidated') h.candidate.validated = false
    if (fault === 'missing-receipt') h.candidate.commitReceiptId = ''
    if (fault === 'empty-validation') h.candidate.validationReceiptIds = []
    if (fault === 'bad-tree') h.candidate.treeSha = 'not-a-tree'
    if (fault === 'wrong-ci') h.candidate.ciSha256 = '0'.repeat(64)
    if (fault === 'protected-path') h.candidate.changedProtectedPaths = ['.gitlab-ci.yml']
    if (fault === 'wrong-task') h.candidate.taskId = 'another-task'
    if (fault === 'wrong-sha') h.candidate.sha = BASE
    expect((await c.execute(h.request(), signal())).status).toBe('blocked')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
  })

  it.each(['user-id', 'username', 'project-id', 'project-path', 'branch', 'pipeline-required', 'ci', 'production', 'fingerprint'] as const)('rejects remote %s drift', async fault => {
    const h = fixture(), c = h.create()
    if (fault === 'user-id') h.snapshot.identity.id++
    if (fault === 'username') h.snapshot.identity.username = 'somebody'
    if (fault === 'project-id') h.snapshot.project.id++
    if (fault === 'project-path') h.snapshot.project.path = 'fork/repo'
    if (fault === 'branch') h.snapshot.project.defaultBranch = 'main'
    if (fault === 'pipeline-required') h.snapshot.project.pipelineRequired = false
    if (fault === 'ci') h.snapshot.targetCiSha256 = '0'.repeat(64)
    if (fault === 'production') h.snapshot.productionExcluded = false
    if (fault === 'fingerprint') h.snapshot.triggerPolicyFingerprint = 'unreviewed'
    expect((await c.execute(h.request(), signal())).status).toBe('blocked')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
  })

  it('accepts strict request data only and never derives repository/action/credentials from prose', async () => {
    const h = fixture(), c = h.create()
    expect((await c.execute({ ...h.request(), url: 'https://evil.test' } as ReleaseRequest, signal())).status).toBe('blocked')
    expect((await c.execute({ ...h.request(), repository: '../outside' }, signal())).status).toBe('blocked')
    expect((await c.execute({ ...h.request(), action: 'production' as never }, signal())).status).toBe('blocked')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
  })
})

describe('durable remote intent and reconciliation', () => {
  it('persists dispatching before send; accepted IDs are not completion; reconcile proves push', async () => {
    const h = fixture(), c = h.create()
    vi.mocked(h.transport.dispatch).mockImplementation(async context => {
      expect(c.operations()[0]!.state).toBe('dispatching')
      expect(context.deadline).toBe(h.grant.expiresAt)
      expect(context.operation.sha).toBe(SHA)
      return { remoteIds: ['push-1'], detail: 'accepted' }
    })
    const result = await c.execute(h.request(), signal())
    expect(result).toMatchObject({ status: 'accepted', remoteActive: true, remoteIds: ['push-1'] })
    h.snapshot.sourceSha = SHA
    expect(await c.reconcile(result.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
  })

  it('does not call dispatch again on duplicate requests even after grant expiry or rebuild', async () => {
    const h = fixture(), c = h.create()
    const first = await c.execute(h.request(), signal())
    expect(await c.execute(h.request(), signal())).toEqual(first)
    h.grant.expiresAt = later(-1)
    expect(await c.execute(h.request(), signal())).toEqual(first)
    await c.close()
    const reopened = h.create()
    expect(await reopened.execute(h.request(), signal())).toEqual(first)
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
    h.snapshot.sourceSha = SHA
    expect((await reopened.reconcile(first.operationId!, signal())).status).toBe('succeeded')
  })

  it('persists response-loss unknown across reopen and permits read-only proof but no replay', async () => {
    const h = fixture(), c = h.create()
    vi.mocked(h.transport.dispatch).mockRejectedValueOnce(new Error('accepted remotely then response lost'))
    const result = await c.execute(h.request(), signal())
    expect(result).toMatchObject({ status: 'unknown', remoteActive: true })
    await c.close()
    const reopened = h.create()
    expect(await reopened.execute(h.request(), signal())).toEqual(result)
    expect((await reopened.reconcile(result.operationId!, signal())).status).toBe('unknown')
    h.snapshot.sourceSha = SHA
    expect((await reopened.reconcile(result.operationId!, signal())).status).toBe('succeeded')
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('read-only reconciliation remains available after expiry/revocation/freeze and remoteActive survives close/reopen', async () => {
    vi.useFakeTimers()
    const h = fixture(); h.policy.freezeWindows = [{ from: later(1000), until: later(10_000) }]
    const c = h.create(), result = await c.execute(h.request(), signal())
    expect(c.remoteActive()).toBe(true)
    expect(c.remoteActive('task-1')).toBe(true)
    expect(c.remoteActive('other-task')).toBe(false)
    expect(vi.mocked(h.transport.dispatch).mock.calls[0]![0].deadline).toBe(h.policy.freezeWindows[0]!.from)
    await c.close()
    expect(c.remoteActive('task-1')).toBe(true)
    const reopened = h.create()
    h.revoke(); h.deactivate(); h.grant.expiresAt = later(-1)
    await vi.advanceTimersByTimeAsync(1001)
    h.snapshot.sourceSha = SHA
    expect(await reopened.reconcile(result.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(reopened.remoteActive()).toBe(false)
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('converts interrupted durable dispatch to unknown, not a new send', async () => {
    const h = fixture(), c = h.create()
    const first = await c.execute(h.request(), signal())
    await c.close()
    const journal = new ReleaseJournal(h.path), row = journal.get(first.operationId!)!
    row.operation.state = 'dispatching'; journal.save(row); journal.close()
    const reopened = h.create()
    expect(reopened.operations()[0]!.state).toBe('unknown')
    expect((await reopened.execute(h.request(), signal())).status).toBe('unknown')
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('seals interrupted prepared intent without dispatching or inheriting old authority', async () => {
    const h = fixture(), c = h.create()
    const first = await c.execute(h.request(), signal())
    await c.close()
    const journal = new ReleaseJournal(h.path), row = journal.get(first.operationId!)!
    row.operation.state = 'prepared'; row.remoteActive = false; journal.save(row); journal.close()
    const reopened = h.create()
    expect(await reopened.execute(h.request(), signal())).toMatchObject({ status: 'failed', remoteActive: false })
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('fails closed on journal write failure before remote dispatch', async () => {
    const h = fixture(), c = h.create()
    const saved = ReleaseJournal.prototype.save
    vi.spyOn(ReleaseJournal.prototype, 'save').mockImplementationOnce(function(this: ReleaseJournal, intent: ReleaseIntent) {
      if (intent.operation.state === 'dispatching') throw new Error('disk full')
      return saved.call(this, intent)
    })
    expect((await c.execute(h.request(), signal())).status).toBe('failed')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
  })

  it('records unknown if acceptance cannot be committed and never automatically retries', async () => {
    const h = fixture(), c = h.create(), saved = ReleaseJournal.prototype.save
    vi.spyOn(ReleaseJournal.prototype, 'save').mockImplementation(function(this: ReleaseJournal, intent: ReleaseIntent) {
      if (intent.operation.state === 'accepted') throw new Error('commit acceptance failed')
      return saved.call(this, intent)
    })
    const first = await c.execute(h.request(), signal())
    expect(first).toMatchObject({ status: 'unknown', remoteActive: true })
    expect(await c.execute(h.request(), signal())).toEqual(first)
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('refuses concurrent coordinator instances and never steals an existing lock', async () => {
    const h = fixture(), c = h.create()
    expect(() => h.create()).toThrow()
    await c.close()
    writeFileSync(`${h.path}.lock`, 'stale or foreign owner')
    expect(() => h.create()).toThrow()
    expect(readFileSync(`${h.path}.lock`, 'utf8')).toBe('stale or foreign owner')
  })

  it('allows MR-only flow without a push pipeline only under an explicit pinned no-remote-jobs attestation', async () => {
    const h = fixture(); h.policy.repositories.repo!.pushHasNoRemoteJobs = true; const c = h.create()
    const result = await c.execute(h.request(), signal())
    h.snapshot.sourceSha = SHA; delete h.snapshot.pipeline
    expect(await c.reconcile(result.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect((await c.execute(h.request('create_mr'), signal())).status).toBe('accepted')
  })

  it('keeps a proven push remote-active while its pipeline is running or missing', async () => {
    const h = fixture(), c = h.create(), result = await c.execute(h.request(), signal())
    h.snapshot.sourceSha = SHA
    h.snapshot.pipeline!.status = 'running'
    expect(await c.reconcile(result.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: true })
    delete h.snapshot.pipeline
    expect(await c.reconcile(result.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: true })
    expect((await c.execute(h.request('create_mr'), signal())).status).toBe('blocked')
  })
})

describe('fresh authorization and serialized lifecycle', () => {
  it.each(['owner', 'deadline', 'grant', 'candidate', 'active'] as const)('rechecks %s after asynchronous observation', async change => {
    const h = fixture(), c = h.create(), gate = deferred<RemoteSnapshot>()
    vi.mocked(h.transport.observe).mockReturnValueOnce(gate.promise)
    const pending = c.execute(h.request(), signal()); await drain()
    if (change === 'owner') h.revoke()
    if (change === 'deadline') h.grant.expiresAt = later(-1)
    if (change === 'grant') h.grant.approvalMessageId = 'replacement'
    if (change === 'candidate') h.candidate.treeSha = 'f'.repeat(40)
    if (change === 'active') h.deactivate()
    gate.resolve(structuredClone(h.snapshot))
    expect((await pending).status).toBe('blocked')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
  })

  it.each(['owner', 'paused', 'shortened-deadline'] as const)('transport live callback prevents mutation after %s changes during its final network read', async revocation => {
    const h = fixture(), c = h.create(), gate = deferred<void>(), externalWrite = vi.fn()
    vi.mocked(h.transport.dispatch).mockImplementationOnce(async context => {
      await gate.promise
      context.assertAuthorized()
      externalWrite()
      return { remoteIds: ['never-written'], detail: 'accepted' }
    })
    const pending = c.execute(h.request(), signal()); await drain()
    if (revocation === 'owner') h.revoke()
    if (revocation === 'paused') h.deactivate()
    if (revocation === 'shortened-deadline') h.deadline(later(1000))
    gate.resolve()
    expect(await pending).toMatchObject({ status: 'unknown', remoteActive: true })
    expect(externalWrite).not.toHaveBeenCalled()
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('rechecks freeze after await and sends next freeze as the effective deadline', async () => {
    vi.useFakeTimers()
    const h = fixture(); h.policy.freezeWindows = [{ from: later(2000), until: later(4000) }]
    const c = h.create(), gate = deferred<RemoteSnapshot>()
    vi.mocked(h.transport.observe).mockReturnValueOnce(gate.promise)
    const pending = c.execute(h.request(), signal()); await drain()
    await vi.advanceTimersByTimeAsync(2001)
    gate.resolve(structuredClone(h.snapshot))
    expect((await pending).status).toBe('blocked')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    const next = await c.execute(h.request(), signal())
    expect(next.status).toBe('accepted')
  })

  it('serializes overlapping requests and prevents a new logical mutation while prior remote effects remain unresolved', async () => {
    const h = fixture(), c = h.create(), gate = deferred<{ remoteIds: string[]; detail: string }>()
    vi.mocked(h.transport.dispatch).mockReturnValueOnce(gate.promise)
    const first = c.execute(h.request(), signal()); await drain()
    const second = c.execute(h.request('create_mr'), signal()); await drain()
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
    gate.resolve({ remoteIds: ['push-1'], detail: 'accepted' })
    expect((await first).status).toBe('accepted')
    expect((await second).status).toBe('blocked')
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('close aborts pending observation before dispatch and waits for owned work without resetting remote state', async () => {
    const h = fixture(), c = h.create(), gate = deferred<RemoteSnapshot>()
    let observedSignal: AbortSignal | undefined
    vi.mocked(h.transport.observe).mockImplementationOnce(async (_, signal) => { observedSignal = signal; return gate.promise })
    const pending = c.execute(h.request(), signal()); await drain()
    let closed = false
    const closing = c.close().then(() => { closed = true }); await drain()
    expect(observedSignal!.aborted).toBe(true)
    expect(closed).toBe(false)
    gate.resolve(structuredClone(h.snapshot))
    expect((await pending).status).toBe('blocked')
    await closing
    expect(h.transport.dispatch).not.toHaveBeenCalled()
  })

  it('close does not translate a remotely accepted operation into stopped or complete', async () => {
    const h = fixture(), c = h.create(), gate = deferred<{ remoteIds: string[]; detail: string }>()
    let mutationSignal: AbortSignal | undefined
    vi.mocked(h.transport.dispatch).mockImplementationOnce(async (_, signal) => { mutationSignal = signal; return gate.promise })
    const pending = c.execute(h.request(), signal()); await drain()
    const closing = c.close(); await drain()
    expect(mutationSignal!.aborted).toBe(true)
    gate.resolve({ remoteIds: ['remote-1'], detail: 'already accepted' })
    expect(await pending).toMatchObject({ status: 'accepted', remoteActive: true })
    await closing
    expect(c.operations()[0]!.state).toBe('accepted')
    const reopened = h.create()
    expect((await reopened.execute(h.request(), signal())).remoteActive).toBe(true)
  })
})

describe('immutable ordinary merge preparation', () => {
  async function ready(h: ReturnType<typeof ordinaryFixture>, c: ReleaseCoordinator) {
    const result = await c.prepareMerge({ taskId: 'task-1', repository: 'repo', sha: SHA }, signal())
    expect(result.status).toBe('accepted')
    expect(await c.reconcile(result.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    return result.operationId!
  }

  it('allows genuine target divergence, journals separate metadata and merge, and verifies resulting M parents/tree', async () => {
    const h = ordinaryFixture(), c = h.create()
    expect(h.target).not.toBe(h.grant.scopes[0]!.baseSha)
    expect((await c.execute(h.request('merge'), signal())).status).toBe('blocked')
    const prepId = await ready(h, c)
    expect(c.operations()).toHaveLength(1)
    expect(c.operations()[0]).toMatchObject({ action: 'prepare_merge', mergePlan: h.plan })
    const merged = await c.execute(h.request('merge'), signal())
    expect(merged.status).toBe('accepted')
    expect(c.operations()[1]).toMatchObject({ action: 'merge', sha: SHA, preparationId: prepId, mergePlan: h.plan })
    expect(c.operations()[0]!.logicalKey).not.toBe(c.operations()[1]!.logicalKey)
    h.merged()
    expect(await c.reconcile(merged.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(vi.mocked(h.transport.dispatch).mock.calls.map(([context]) => context.request.action)).toEqual(['prepare_merge', 'merge'])
  })

  it.each(['plan', 'readback'] as const)('persists a local writer-unknown safety latch after %s, blocking repeats and reopen', async phase => {
    const h = ordinaryFixture(), c = h.create(), error = Object.assign(new Error('local process group unverified'), { code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false, pgid: 12345 })
    if (phase === 'plan') {
      vi.mocked(h.transport.planMerge!).mockRejectedValueOnce(error)
      await expect(c.prepareMerge(h.request(), signal())).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN' })
    } else {
      const prepared = await c.prepareMerge(h.request(), signal())
      vi.mocked(h.transport.observe).mockRejectedValueOnce(error)
      await expect(c.reconcile(prepared.operationId!, signal())).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN' })
    }
    expect(c.remoteActive()).toBe(true)
    const calls = vi.mocked(h.transport.planMerge!).mock.calls.length
    await c.prepareMerge(h.request(), signal())
    await c.close(); const reopened = h.create()
    expect(reopened.remoteActive()).toBe(true)
    expect((await reopened.execute(h.request('merge'), signal())).status).toBe('blocked')
    await reopened.prepareMerge(h.request(), signal())
    expect(h.transport.planMerge).toHaveBeenCalledTimes(calls)
    expect((await reopened.reconcile('any-operation', signal())).remoteActive).toBe(true)
  })

  it('publishes no second preparation even after target changes or reconstruction', async () => {
    const h = ordinaryFixture(), c = h.create(), prepId = await ready(h, c)
    h.snapshot.targetSha = '4'.repeat(40)
    expect((await c.prepareMerge(h.request(), signal())).operationId).toBe(prepId)
    expect((await c.execute(h.request('merge'), signal())).status).toBe('blocked')
    await c.close(); const reopened = h.create()
    expect((await reopened.prepareMerge(h.request(), signal())).operationId).toBe(prepId)
    expect((await reopened.execute(h.request('merge'), signal())).status).toBe('blocked')
    expect(h.transport.planMerge).toHaveBeenCalledTimes(1); expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('never retries unknown metadata publication and can reconcile exact immutable readback', async () => {
    const h = ordinaryFixture(), c = h.create()
    vi.mocked(h.transport.dispatch).mockImplementationOnce(async context => {
      h.snapshot.preparation = { plan: context.operation.mergePlan!, metadataDigest: '3'.repeat(64), operationId: context.operation.id, expiresAt: context.deadline, verified: true }
      throw new Error('response lost after metadata PUT')
    })
    const prep = await c.prepareMerge(h.request(), signal())
    expect(prep).toMatchObject({ status: 'unknown', remoteActive: true })
    await c.close(); const reopened = h.create()
    expect(await reopened.prepareMerge(h.request(), signal())).toEqual(prep)
    expect((await reopened.execute(h.request('merge'), signal())).status).toBe('blocked')
    expect(await reopened.reconcile(prep.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect((await reopened.execute(h.request('merge'), signal())).status).toBe('accepted')
    expect(h.transport.dispatch).toHaveBeenCalledTimes(2)
    expect(h.transport.planMerge).toHaveBeenCalledTimes(1)
  })

  it.each(['target-race', 'source-plan', 'ci-plan', 'unvalidated-profile', 'owner-revoked', 'source-ci-failed'] as const)('blocks %s before metadata mutation', async fault => {
    const h = ordinaryFixture(), c = h.create()
    if (fault === 'source-ci-failed') h.snapshot.pipeline!.status = 'failed'
    vi.mocked(h.transport.planMerge!).mockImplementationOnce(async () => {
      if (fault === 'target-race') h.snapshot.targetSha = '4'.repeat(40)
      if (fault === 'owner-revoked') h.revoke()
      return { ...h.plan, ...(fault === 'source-plan' ? { sourceSha: BASE } : {}), ...(fault === 'ci-plan' ? { ciSha256: '0'.repeat(64) } : {}), ...(fault === 'unvalidated-profile' ? { validationProfile: 'package-only' as never } : {}) }
    })
    expect((await c.prepareMerge(h.request(), signal())).status).toBe('blocked')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
  })

  it.each(['digest', 'plan', 'op-id', 'expiry', 'unverified'] as const)('does not merge when immutable preparation %s changes', async fault => {
    const h = ordinaryFixture(), c = h.create(); await ready(h, c)
    if (fault === 'digest') h.snapshot.preparation!.metadataDigest = '4'.repeat(64)
    if (fault === 'plan') h.snapshot.preparation!.plan.expectedTreeSha = '4'.repeat(40)
    if (fault === 'op-id') h.snapshot.preparation!.operationId = 'another-prep'
    if (fault === 'expiry') h.snapshot.preparation!.expiresAt = later(-1)
    if (fault === 'unverified') h.snapshot.preparation!.verified = false
    expect((await c.execute(h.request('merge'), signal())).status).toBe('blocked')
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['parents', 'tree', 'target-raced', 'unverified'] as const)('marks actual M %s mismatch unknown without a second merge attempt', async fault => {
    const h = ordinaryFixture(), c = h.create(); await ready(h, c)
    const merged = await c.execute(h.request('merge'), signal()); h.merged()
    if (fault === 'parents') h.snapshot.mergeRequest!.mergeParents = [SHA, h.target]
    if (fault === 'tree') h.snapshot.mergeRequest!.mergeTreeSha = TREE
    if (fault === 'target-raced') h.snapshot.mergeRequest!.mergeParents = ['4'.repeat(40), SHA]
    if (fault === 'unverified') h.snapshot.mergeRequest!.mergeCommitVerified = false
    expect(await c.reconcile(merged.operationId!, signal())).toMatchObject({ status: 'unknown', remoteActive: true })
    expect((await c.execute(h.request('merge'), signal())).operationId).toBe(merged.operationId)
    expect(h.transport.dispatch).toHaveBeenCalledTimes(2)
  })

  it.each(['missing', 'wrong-sha', 'wrong-tree', 'not-passed'] as const)('rejects deployment completion with %s actual-M full verification', async fault => {
    const h = ordinaryFixture(true), c = h.create(); await ready(h, c)
    const merged = await c.execute(h.request('merge'), signal()); expect(merged.status).toBe('accepted'); h.merged()
    const deployment = h.snapshot.deployment!
    deployment.state = 'succeeded'; deployment.healthy = true; deployment.builds![0] = { ...deployment.builds![0]!, state: 'succeeded', healthy: true, artifactDigest: `sha256:${JOB}` }
    deployment.fullVerification = { sha: h.mergedSha, treeSha: h.mergedTree, profile: 'full-verify', passed: true }
    if (fault === 'missing') delete deployment.fullVerification
    if (fault === 'wrong-sha') deployment.fullVerification!.sha = SHA
    if (fault === 'wrong-tree') deployment.fullVerification!.treeSha = TREE
    if (fault === 'not-passed') deployment.fullVerification!.passed = false
    expect(await c.reconcile(merged.operationId!, signal())).toMatchObject({ status: 'unknown', remoteActive: true })
  })

  it('adopts only existing M builds and completes after exact full-verify M/E proof', async () => {
    const h = ordinaryFixture(true), c = h.create(), prepId = await ready(h, c)
    const merge = await c.execute(h.request('merge'), signal()); h.merged()
    expect(await c.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'accepted', remoteActive: true })
    const deploy = await c.execute(h.request('deploy'), signal())
    expect(deploy.status).toBe('accepted')
    expect(c.operations().at(-1)).toMatchObject({ sha: SHA, preparationId: prepId, mergePlan: h.plan })
    const deployment = h.snapshot.deployment!
    deployment.state = 'succeeded'; deployment.healthy = true; deployment.fullVerification = { sha: h.mergedSha, treeSha: h.mergedTree, profile: 'full-verify', passed: true }
    deployment.builds![0] = { ...deployment.builds![0]!, state: 'succeeded', healthy: true, artifactDigest: `sha256:${JOB}` }
    expect(await c.reconcile(deploy.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(await c.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(h.transport.dispatch).toHaveBeenCalledTimes(2)
  })

  it('seals completed historical source/merge evidence across later target advances without another observe', async () => {
    const h = ordinaryFixture(), c = h.create()
    delete h.snapshot.mergeRequest
    const created = await c.execute(h.request('create_mr'), signal()); h.mr()
    await c.reconcile(created.operationId!, signal())
    const before = c.operations()[0]!
    await ready(h, c); const merged = await c.execute(h.request('merge'), signal()); h.merged(); await c.reconcile(merged.operationId!, signal())
    h.snapshot.targetSha = '9'.repeat(40); h.snapshot.mergeRequest!.mergeCommitSha = '8'.repeat(40)
    const observed = vi.mocked(h.transport.observe).mock.calls.length
    expect(await c.reconcile(created.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(await c.reconcile(merged.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(h.transport.observe).toHaveBeenCalledTimes(observed)
    expect(c.remoteActive()).toBe(false)
    expect(c.operations()[0]!.logicalKey).toBe(before.logicalKey)
    expect(c.operations()[0]!.mergePlan).toBeUndefined()
  })
})

describe('MR, merge and observation-only deployment gates', () => {
  it('progresses env=test push → MR → terminal CI → merge without treating a provisional deployment route as premerge activity', async () => {
    const h = fixture()
    h.policy.repositories.repo!.mergeTriggersDeploy = true
    h.policy.repositories.repo!.pushHasNoRemoteJobs = true
    h.route(); h.snapshot.deployment!.state = 'unknown'; h.snapshot.deployment!.remoteDeadlineEnforced = false
    delete h.snapshot.deployment!.configSha256; delete h.snapshot.deployment!.deadline; delete h.snapshot.pipeline
    const c = h.create(), pushed = await c.execute(h.request(), signal())
    expect(pushed).toMatchObject({ status: 'accepted', remoteActive: true })
    h.snapshot.sourceSha = SHA
    expect(await c.reconcile(pushed.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(c.remoteActive()).toBe(false)

    const created = await c.execute(h.request('create_mr'), signal())
    expect(created.status).toBe('accepted')
    h.mr()
    // No MR pipeline is not equivalent to success, even though provisional deploy evidence is ignored.
    expect(await c.reconcile(created.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: true })
    expect((await c.execute(h.request('merge'), signal())).status).toBe('blocked')
    h.snapshot.pipeline = { id: 88, sha: SHA, status: 'running', jobs: [{ name: 'test', status: 'running', allowFailure: false }] }
    expect((await c.reconcile(created.operationId!, signal())).remoteActive).toBe(true)
    h.snapshot.pipeline.status = 'success'; h.snapshot.pipeline.jobs[0]!.status = 'success'
    expect(await c.reconcile(created.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(c.remoteActive()).toBe(false)

    // Ignoring provisional premerge activity must not weaken merge's exact remote route/deadline gates.
    expect((await c.execute(h.request('merge'), signal())).status).toBe('blocked')
    h.route()
    const merged = await c.execute(h.request('merge'), signal())
    expect(merged).toMatchObject({ status: 'accepted', remoteActive: true })
    expect(vi.mocked(h.transport.dispatch).mock.calls.map(([context]) => context.request.action)).toEqual(['push', 'create_mr', 'merge'])
    h.merged(); h.snapshot.deployment!.state = 'unknown'; h.snapshot.deployment!.ids = []
    expect((await c.reconcile(merged.operationId!, signal())).remoteActive).toBe(true)
    expect(c.remoteActive()).toBe(true)
    // Earlier push/MR facts do not invent an empty-ID deployment, but the merge intent remains active.
    expect((await c.reconcile(pushed.operationId!, signal())).remoteActive).toBe(false)
    expect(c.remoteActive()).toBe(true)
  })

  it('does not resurrect sealed push activity when a later merge owns active deployment effects', async () => {
    const h = fixture(); h.policy.repositories.repo!.mergeTriggersDeploy = true; h.policy.repositories.repo!.pushHasNoRemoteJobs = true
    const c = h.create(), pushed = await c.execute(h.request(), signal())
    h.snapshot.sourceSha = SHA
    await c.reconcile(pushed.operationId!, signal())
    h.mr(); h.route()
    const merged = await c.execute(h.request('merge'), signal())
    expect(merged.status).toBe('accepted')
    h.merged(); h.snapshot.deployment!.ids = ['webhook-build-1']; h.snapshot.deployment!.state = 'running'; h.builds()
    const observed = vi.mocked(h.transport.observe).mock.calls.length
    expect(await c.reconcile(pushed.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(h.transport.observe).toHaveBeenCalledTimes(observed)
    expect(c.remoteActive()).toBe(true) // The separate merge intent, not the historical push, owns uncertainty.
  })

  it('does not clear a premerge pipeline just because the deployment placeholder has no concrete IDs', async () => {
    const h = fixture(); h.policy.repositories.repo!.pushHasNoRemoteJobs = true
    h.route(); h.snapshot.deployment!.state = 'unknown'; h.snapshot.pipeline!.status = 'running'
    const c = h.create(), pushed = await c.execute(h.request(), signal())
    h.snapshot.sourceSha = SHA
    expect(await c.reconcile(pushed.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: true })
    expect((await c.execute(h.request('create_mr'), signal())).status).toBe('blocked')
  })
  it('requires exact pushed source and records MR creation as accepted, never auto-adopts a preexisting MR', async () => {
    const h = fixture(), c = h.create()
    expect((await c.execute(h.request('create_mr'), signal())).status).toBe('blocked')
    h.snapshot.sourceSha = SHA
    const result = await c.execute(h.request('create_mr'), signal())
    expect(result.status).toBe('accepted')
    h.mr()
    expect((await c.reconcile(result.operationId!, signal())).status).toBe('succeeded')
    h.grant.id = 'new-grant'
    expect((await c.execute(h.request('create_mr'), signal())).status).toBe('blocked')
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['no-ff', 'head', 'author', 'marker', 'draft', 'conflict', 'approval', 'discussion', 'pipeline-sha', 'pipeline-status', 'job-missing', 'job-allowed-failure', 'job-duplicate'] as const)('blocks merge with %s evidence', async fault => {
    const h = fixture(); h.mr(); const c = h.create()
    if (fault === 'no-ff') h.snapshot.project.fastForwardOnly = false
    if (fault === 'head') h.snapshot.mergeRequest!.sha = BASE
    if (fault === 'author') h.snapshot.mergeRequest!.authorId++
    if (fault === 'marker') h.snapshot.mergeRequest!.marker = 'unowned'
    if (fault === 'draft') h.snapshot.mergeRequest!.draft = true
    if (fault === 'conflict') h.snapshot.mergeRequest!.conflicts = true
    if (fault === 'approval') h.snapshot.mergeRequest!.approved = false
    if (fault === 'discussion') h.snapshot.mergeRequest!.unresolvedDiscussions = 1
    if (fault === 'pipeline-sha') h.snapshot.pipeline!.sha = BASE
    if (fault === 'pipeline-status') h.snapshot.pipeline!.status = 'running'
    if (fault === 'job-missing') h.snapshot.pipeline!.jobs = []
    if (fault === 'job-allowed-failure') h.snapshot.pipeline!.jobs[0]!.allowFailure = true
    if (fault === 'job-duplicate') h.snapshot.pipeline!.jobs.push({ ...h.snapshot.pipeline!.jobs[0]! })
    expect((await c.execute(h.request('merge'), signal())).status).toBe('blocked')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
  })

  it('merge readback requires exact verified resulting SHA/tree/target, not HTTP acceptance', async () => {
    const h = fixture(); h.mr(); const c = h.create()
    const result = await c.execute(h.request('merge'), signal())
    expect(result.status).toBe('accepted')
    expect((await c.reconcile(result.operationId!, signal())).status).toBe('accepted')
    h.merged(); h.snapshot.mergeRequest!.mergeTreeSha = BASE
    expect((await c.reconcile(result.operationId!, signal())).status).toBe('accepted')
    h.snapshot.mergeRequest!.mergeTreeSha = TREE
    expect(await c.reconcile(result.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
  })

  it.each(['no-deploy-grant', 'no-route-evidence', 'wrong-config', 'wrong-destination', 'no-remote-deadline', 'late-deadline'] as const)('blocks automatic-deployment merge without %s', async fault => {
    const h = fixture(); h.policy.repositories.repo!.mergeTriggersDeploy = true; h.mr(); h.route()
    if (fault === 'no-deploy-grant') h.grant.scopes[0]!.actions = ['merge']
    if (fault === 'no-route-evidence') delete h.snapshot.deployment
    if (fault === 'wrong-config') h.snapshot.deployment!.configSha256!['test-deploy'] = '0'.repeat(64)
    if (fault === 'wrong-destination') h.snapshot.deployment!.destinationId = 'production-cluster'
    if (fault === 'no-remote-deadline') h.snapshot.deployment!.remoteDeadlineEnforced = false
    if (fault === 'late-deadline') h.snapshot.deployment!.deadline = later(3000_000)
    const c = h.create()
    expect((await c.execute(h.request('merge'), signal())).status).toBe('blocked')
    expect(h.transport.dispatch).not.toHaveBeenCalled()
  })

  it('adopts exact webhook-created deployment without sending any second trigger', async () => {
    const h = fixture(); h.policy.repositories.repo!.mergeTriggersDeploy = true; h.mr(); h.route(); const c = h.create()
    const merge = await c.execute(h.request('merge'), signal())
    expect(merge.status).toBe('accepted')
    h.merged(); h.snapshot.deployment!.state = 'running'; h.snapshot.deployment!.ids = ['jenkins-101']; h.builds()
    expect(await c.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'accepted', remoteActive: true })
    const adopted = await c.execute(h.request('deploy'), signal())
    expect(adopted).toMatchObject({ status: 'accepted', remoteIds: ['jenkins-101'], remoteActive: true })
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
    h.snapshot.deployment!.state = 'succeeded'; h.snapshot.deployment!.healthy = true; h.snapshot.deployment!.artifactDigest = `sha256:${JOB}`; h.builds()
    expect(await c.reconcile(adopted.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(await c.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('rejects manual deployment without an exact journaled merge and rejects replacement build IDs', async () => {
    const h = fixture(); h.policy.repositories.repo!.mergeTriggersDeploy = true; h.mr(); h.route(); const c = h.create()
    expect((await c.execute(h.request('deploy'), signal())).status).toBe('blocked')
    await c.execute(h.request('merge'), signal())
    h.merged(); h.snapshot.deployment!.state = 'running'; h.snapshot.deployment!.ids = ['jenkins-101']; h.builds()
    const adopted = await c.execute(h.request('deploy'), signal())
    h.snapshot.deployment!.ids = ['jenkins-102']; h.snapshot.deployment!.state = 'succeeded'; h.snapshot.deployment!.healthy = true; h.snapshot.deployment!.artifactDigest = 'sha256:other'
    expect(await c.reconcile(adopted.operationId!, signal())).toMatchObject({ status: 'unknown', remoteActive: true })
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['missing-sibling', 'wrong-job', 'wrong-sha', 'wrong-destination', 'unhealthy', 'mutable-artifact', 'swapped-builds'] as const)('does not falsely complete sibling deployments with %s', async fault => {
    const h = fixture(); h.policy.repositories.repo!.mergeTriggersDeploy = true
    h.policy.repositories.repo!.environments.test!.jobs.push('test-deploy-two')
    h.policy.repositories.repo!.environments.test!.expectedConfigSha256['test-deploy-two'] = JOB
    h.mr(); h.route(); h.snapshot.deployment!.configSha256!['test-deploy-two'] = JOB
    const c = h.create(), merge = await c.execute(h.request('merge'), signal())
    h.merged(); h.snapshot.deployment!.state = 'running'; h.snapshot.deployment!.ids = ['build-1', 'build-2']; h.builds()
    await c.reconcile(merge.operationId!, signal()) // Pin original job→ID mappings.
    h.snapshot.deployment!.state = 'succeeded'; h.snapshot.deployment!.healthy = true; h.builds()
    if (fault === 'missing-sibling') h.snapshot.deployment!.builds!.pop()
    if (fault === 'wrong-job') h.snapshot.deployment!.builds![0]!.job = 'production-job'
    if (fault === 'wrong-sha') h.snapshot.deployment!.builds![0]!.sha = BASE
    if (fault === 'wrong-destination') h.snapshot.deployment!.builds![0]!.destinationId = 'production'
    if (fault === 'unhealthy') h.snapshot.deployment!.builds![0]!.healthy = false
    if (fault === 'mutable-artifact') h.snapshot.deployment!.builds![0]!.artifactDigest = 'latest'
    if (fault === 'swapped-builds') { h.snapshot.deployment!.builds![0]!.id = 'build-2'; h.snapshot.deployment!.builds![1]!.id = 'build-1' }
    const result = await c.reconcile(merge.operationId!, signal())
    expect(result.status).not.toBe('succeeded')
    expect(result.remoteActive).toBe(true)
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['replacement', 'disappeared', 'expired', 'unverified-merge'] as const)('rejects %s after partial webhook observation instead of forgetting pinned siblings', async fault => {
    const h = harnessAwaiting()
    const merge = await h.controller.execute(h.request('merge'), signal())
    h.merged(); h.snapshot.deployment!.state = 'unknown'; h.snapshot.deployment!.ids = ['build-1']; h.builds(); h.snapshot.deployment!.builds![0]!.state = 'running'; h.snapshot.deployment!.awaitingWebhook = true
    expect(await h.controller.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'accepted', remoteActive: true })
    if (fault === 'replacement') { h.snapshot.deployment!.ids = ['replacement']; h.snapshot.deployment!.builds![0]!.id = 'replacement' }
    if (fault === 'disappeared') { h.snapshot.deployment!.ids = []; h.snapshot.deployment!.builds = [] }
    if (fault === 'expired') h.snapshot.deployment!.deadline = new Date(Date.now() - 1).toISOString()
    if (fault === 'unverified-merge') h.snapshot.mergeRequest!.mergeCommitVerified = false
    expect(await h.controller.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'unknown', remoteActive: true })
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })

  it('failed webhook deployment remains unsafe with possible partial effects and cannot be retriggered', async () => {
    const h = fixture(); h.policy.repositories.repo!.mergeTriggersDeploy = true; h.mr(); h.route(); const c = h.create()
    const merge = await c.execute(h.request('merge'), signal())
    h.merged(); h.snapshot.deployment!.ids = ['jenkins-101']; h.snapshot.deployment!.state = 'failed'; h.builds()
    expect(await c.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'failed', remoteActive: true })
    expect(await c.execute(h.request('merge'), signal())).toMatchObject({ status: 'failed', remoteActive: true })
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1)
  })
})
