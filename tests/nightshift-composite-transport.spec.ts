/** Host composition tests inject every external client; no GitLab/Jenkins/network actions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createReleaseServices, type ReleaseServices, type ReleaseServicesOptions } from '../src/nightshift/release/composite-transport.ts'
import { policyDigest } from '../src/nightshift/release/coordinator.ts'
import type { DeploymentTicketEvidence, DeploymentTickets } from '../src/nightshift/release/deployment-tickets.ts'
import type { GitlabTransportOptions } from '../src/nightshift/release/gitlab.ts'
import type { DispatchContext, ReleaseTransport, RemoteSnapshot } from '../src/nightshift/release/contracts.ts'
import type { NightConfig } from '../src/nightshift/contracts.ts'

const roots: string[] = [], services: ReleaseServices[] = []
const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40), HASH = 'c'.repeat(64), JOB = 'test/app'
const future = (ms = 60_000) => new Date(Date.now() + ms).toISOString()
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-composite-'))); roots.push(root)
  const workspace = join(root, 'workspace'), repo = join(workspace, 'app'); mkdirSync(repo, { recursive: true })
  const runtime = { keyId: 'key-1', keyFile: join(root, 'key'), ticketDir: join(root, 'tickets'), attestationFile: join(root, 'attestation.json') }
  const repository = { alias: 'app', root: repo, projectId: 445, projectPath: 'payment/refactor/app', host: 'git.example.test', apiOrigin: 'https://git.example.test', expectedUserId: 9, expectedUsername: 'bot', credentialFile: join(root, 'git-credential'), targetBranch: 'master', ciSha256: HASH, requiredJobs: ['unit'], mergeTriggersDeploy: true, triggerPolicy: { reviewedAt: future(-1000), expiresAt: future(), productionExcluded: true, fingerprint: 'reviewed' }, environments: { test: { kind: 'jenkins' as const, id: 'test-route', jobs: [JOB], origin: 'https://jenkins.example.test', expectedConfigSha256: { [JOB]: HASH }, destinationId: 'test:app', remoteDeadlineEnforced: true, credentialRef: join(root, 'reader') } } }
  const config: NightConfig = { enabled: true, workspace, stateDir: join(root, 'state'), piExecutable: '/fake/pi', piHome: join(root, 'pi'), sessionFile: join(root, 'session'), repositories: { app: repo }, maxTaskSeconds: 60, freezeWindows: [], releasePolicy: { version: 1, enabled: true, repositories: { app: repository }, freezeWindows: [], maxGrantSeconds: 3600 } }
  const scope = { repository: 'app', sourceBranch: 'agent/task-1', targetBranch: 'master', baseSha: BASE, environment: 'test' as const, actions: ['push', 'create_mr', 'merge', 'deploy'] as ('push' | 'create_mr' | 'merge' | 'deploy')[] }
  const digest = policyDigest(config.releasePolicy!)
  const context: DispatchContext = { repository, scope, request: { taskId: 'task-1', repository: 'app', action: 'merge', sha: SHA }, deadline: future(), assertAuthorized: vi.fn(),
    operation: { id: 'merge-op', logicalKey: HASH, grantId: 'grant-1', taskId: 'task-1', repository: 'app', action: 'merge', sha: SHA, policyDigest: digest, state: 'dispatching', createdAt: future(-1000), updatedAt: future(-1000), remoteIds: [], detail: '' },
    grant: { id: 'grant-1', taskId: 'task-1', ownerId: 'owner', approvalMessageId: 'approve-1', issuedAt: future(-1000), expiresAt: future(), policyDigest: digest, scopes: [structuredClone(scope)] },
    candidate: { taskId: 'task-1', repository: 'app', sha: SHA, treeSha: BASE, baseSha: BASE, sourceBranch: scope.sourceBranch, clean: true, commitReceiptId: 'host-receipt', validated: true, validationReceiptIds: ['host-validation'], ciSha256: HASH, changedProtectedPaths: [] },
    snapshot: { identity: { id: 9, username: 'bot' }, project: { id: 445, path: repository.projectPath, defaultBranch: 'master', pipelineRequired: true }, sourceSha: SHA, targetSha: BASE, targetCiSha256: HASH, productionExcluded: true, triggerPolicyFingerprint: 'reviewed' },
  }
  const document = { version: 1, expiresAt: future(), repositories: { app: { root: repo, destinationId: 'test:app', configSha256: { [JOB]: HASH }, remoteDeadlineEnforced: true, targets: { [JOB]: { kind: 'java', project: '445', sourceInstance: 'https://git.example.test', namespace: 'test', deployment: 'app' } } } } }
  const save = () => writeFileSync(runtime.attestationFile, JSON.stringify(document), { mode: 0o600 }); save()
  let evidence: DeploymentTicketEvidence | undefined = { deadline: context.deadline, sourceNotBefore: future(-2000), operationId: 'create-op', policyDigest: digest, jobTickets: { [JOB]: { signature: HASH, payload: { version: 1, taskId: 'task-1', grantId: 'grant-1', operationId: 'create-op', projectId: 445, sourceSha: SHA, environment: 'test', jobs: [JOB], destinationId: 'test:app', issuedAt: future(-1000), notBefore: future(-1000), expiresAt: context.deadline, freezeWindows: [], keyId: runtime.keyId, nonce: 'n'.repeat(43) } } } }
  const tickets: DeploymentTickets = { metadata: vi.fn(async context => { context.assertAuthorized(); return 'signed-metadata' }), verify: vi.fn(async context => { context.assertAuthorized() }), evidence: vi.fn(async () => structuredClone(evidence)) }
  const gitlab: ReleaseTransport = { observe: vi.fn(async () => structuredClone(context.snapshot)), dispatch: vi.fn(async (context, signal) => { signal.throwIfAborted(); context.assertAuthorized(); return { remoteIds: ['fake-accepted'], detail: 'fake' } }) }
  let captured: GitlabTransportOptions | undefined
  const fetcher = vi.fn() as unknown as typeof fetch
  const observer: NonNullable<ReleaseServicesOptions['observer']> = vi.fn(async (context, snapshot, signal, options) => {
    signal.throwIfAborted()
    const attestation = await options!.attest!(context)
    const route = context.repository.environments.test!
    return { ...snapshot, deployment: attestation ? { routeId: route.id, sourceSha: context.request.sha, state: 'absent', ids: [], destinationId: attestation.destinationId, healthy: false, remoteDeadlineEnforced: attestation.remoteDeadlineEnforced, configSha256: attestation.configSha256, deadline: attestation.deadline } : { routeId: route.id, sourceSha: context.request.sha, state: 'unknown', ids: [], destinationId: route.destinationId, healthy: false, remoteDeadlineEnforced: false } }
  })
  const ticketFactory = vi.fn(() => tickets), gitlabFactory = vi.fn((options: GitlabTransportOptions) => { captured = options; return gitlab })
  const options: ReleaseServicesOptions = { fetch: fetcher, observer, ticketFactory, gitlabFactory }
  const create = () => { const value = createReleaseServices(config, runtime, options); services.push(value); return value }
  return { root, repo, config, runtime, context, document, save, tickets, gitlab, observer, fetcher, ticketFactory, gitlabFactory, options, create, captured: () => captured!, evidence: () => evidence!, setEvidence: (value: DeploymentTicketEvidence | undefined) => { evidence = value } }
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-composite-')) throw new Error(`Unsafe cleanup ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('host composite release service construction', () => {
  it('passes only pinned host runtime settings to factories and combines GitLab with trusted signed-deadline Jenkins evidence', async () => {
    const h = fixture(), service = h.create()
    expect(h.ticketFactory).toHaveBeenCalledWith({ keyId: h.runtime.keyId, keyFile: h.runtime.keyFile, stateDir: h.runtime.ticketDir, freezeWindows: [] })
    expect(h.captured()).toMatchObject({ tempRoot: join(h.config.stateDir, 'release-git'), fetch: h.fetcher, deploymentTickets: { metadata: expect.any(Function), verify: expect.any(Function) } })
    const observed = await service.transport.observe(h.context, new AbortController().signal)
    expect(observed.deployment).toMatchObject({ state: 'absent', remoteDeadlineEnforced: true, deadline: h.context.deadline, configSha256: { [JOB]: HASH } })
    expect(h.tickets.evidence).toHaveBeenCalledWith('task-1', 'app', SHA)
    expect(h.gitlab.observe).toHaveBeenCalledTimes(1); expect(h.observer).toHaveBeenCalledTimes(1)
    expect(h.fetcher).not.toHaveBeenCalled()
  })

  it('skips Jenkins overlay for nondeployment scopes and never triggers deploy mutations', async () => {
    const h = fixture(), service = h.create(), context = { ...h.context, scope: { ...h.context.scope } }
    delete context.scope.environment
    expect(await service.transport.observe(context, new AbortController().signal)).toEqual(h.context.snapshot)
    expect(h.observer).not.toHaveBeenCalled()
    await expect(service.transport.dispatch({ ...h.context, request: { ...h.context.request, action: 'deploy' } }, new AbortController().signal)).rejects.toThrow('observation-only')
    expect(h.gitlab.dispatch).not.toHaveBeenCalled()
  })

  it.each(['workspace-key', 'workspace-attestation', 'alias-root', 'freeze-drift', 'runtime-extra'] as const)('rejects %s configuration substitution before factories create clients', invalid => {
    const h = fixture()
    if (invalid === 'workspace-key') h.runtime.keyFile = join(h.config.workspace, 'secret')
    if (invalid === 'workspace-attestation') h.runtime.attestationFile = join(h.config.workspace, 'attestation.json')
    if (invalid === 'alias-root') h.config.repositories.app = h.root
    if (invalid === 'freeze-drift') h.config.freezeWindows = [{ from: '2026-11-12T00:00:00+08:00', until: '2026-11-14T00:00:00+08:00' }]
    if (invalid === 'runtime-extra') Object.assign(h.runtime, { administratorToken: 'forbidden' })
    expect(h.create).toThrow()
    expect(h.gitlabFactory).not.toHaveBeenCalled()
  })

  it('rejects caller repository substitutions and pins the original configuration snapshot', async () => {
    const h = fixture(), service = h.create()
    const substituted = { ...h.context, repository: { ...h.context.repository, projectId: 999 } }
    await expect(service.transport.observe(substituted, new AbortController().signal)).rejects.toThrow()
    h.config.repositories.app = h.root
    expect((await service.transport.observe(h.context, new AbortController().signal)).deployment!.state).toBe('absent')
    expect(h.gitlab.observe).toHaveBeenCalledTimes(1)
  })
})

describe('fresh private operator attestation and signed scope binding', () => {
  it.each(['mode', 'symlink', 'hardlink', 'expired', 'false-enforcement', 'wrong-root', 'extra-alias', 'destination', 'config-hash', 'missing-job', 'extra-field', 'oversized'] as const)('returns unknown and blocks merge on %s attestation', async invalid => {
    const h = fixture()
    if (invalid === 'mode') chmodSync(h.runtime.attestationFile, 0o644)
    if (invalid === 'symlink') { const alias = join(h.root, 'attestation-link'); symlinkSync(h.runtime.attestationFile, alias); h.runtime.attestationFile = alias }
    if (invalid === 'hardlink') linkSync(h.runtime.attestationFile, join(h.root, 'attestation-hardlink'))
    if (invalid === 'expired') h.document.expiresAt = future(-1)
    if (invalid === 'false-enforcement') h.document.repositories.app.remoteDeadlineEnforced = false
    if (invalid === 'wrong-root') h.document.repositories.app.root = h.root
    if (invalid === 'extra-alias') Object.assign(h.document.repositories, { unconfigured: h.document.repositories.app })
    if (invalid === 'destination') h.document.repositories.app.destinationId = 'production'
    if (invalid === 'config-hash') h.document.repositories.app.configSha256[JOB] = 'd'.repeat(64)
    if (invalid === 'missing-job') delete (h.document.repositories.app.targets as Record<string, unknown>)[JOB]
    if (invalid === 'extra-field') Object.assign(h.document.repositories.app, { adminToken: 'PRIVATE_TOKEN' })
    if (!['mode', 'symlink', 'hardlink'].includes(invalid)) h.save()
    if (invalid === 'oversized') writeFileSync(h.runtime.attestationFile, 'x'.repeat(512 * 1024 + 1))
    const service = h.create(), result = await service.transport.observe(h.context, new AbortController().signal)
    expect(result.deployment).toMatchObject({ state: 'unknown', remoteDeadlineEnforced: false })
    await expect(service.transport.dispatch(h.context, new AbortController().signal)).rejects.toThrow()
    expect(h.gitlab.dispatch).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN')
  })

  it.each(['missing', 'policy', 'sha', 'environment', 'project', 'job', 'key', 'destination'] as const)('does not compose a deadline from %s ticket evidence', async invalid => {
    const h = fixture()
    if (invalid === 'missing') h.setEvidence(undefined)
    else {
      const evidence = h.evidence(), payload = evidence.jobTickets[JOB]!.payload
      if (invalid === 'policy') evidence.policyDigest = 'd'.repeat(64)
      if (invalid === 'sha') payload.sourceSha = BASE
      if (invalid === 'environment') payload.environment = 'preprod'
      if (invalid === 'project') payload.projectId++
      if (invalid === 'job') payload.jobs = ['different-job']
      if (invalid === 'key') payload.keyId = 'other-key'
      if (invalid === 'destination') payload.destinationId = 'production'
    }
    const service = h.create()
    expect((await service.transport.observe(h.context, new AbortController().signal)).deployment!.state).toBe('unknown')
    await expect(service.transport.dispatch(h.context, new AbortController().signal)).rejects.toThrow()
    expect(h.gitlab.dispatch).not.toHaveBeenCalled()
  })

  it('passes the pre-source grant epoch, not later ticket signing time, to the bounded Jenkins history observer', async () => {
    const h = fixture(), service = h.create()
    let observed: string | undefined
    h.options.observer = async (context, snapshot, _signal, options) => { observed = (await options!.attest!(context))?.notBefore; return snapshot }
    await service.transport.observe(h.context, new AbortController().signal)
    expect(observed).toBe(h.evidence().sourceNotBefore)
    expect(Date.parse(observed!)).toBeLessThan(Date.parse(h.evidence().jobTickets[JOB]!.payload.notBefore))
    h.evidence().sourceNotBefore = future(1000)
    await service.transport.observe(h.context, new AbortController().signal)
    expect(observed).toBeUndefined()
  })

  it('reloads the attestation on every observation rather than caching permissions', async () => {
    const h = fixture(), service = h.create()
    expect((await service.transport.observe(h.context, new AbortController().signal)).deployment!.state).toBe('absent')
    h.document.repositories.app.remoteDeadlineEnforced = false; h.save()
    expect((await service.transport.observe(h.context, new AbortController().signal)).deployment!.state).toBe('unknown')
  })

  it('accepts read-only0400 attestations and exposes no publisher credentials in overlay output', async () => {
    const h = fixture(); chmodSync(h.runtime.attestationFile, 0o400)
    const service = h.create(), result = await service.transport.observe(h.context, new AbortController().signal)
    expect(result.deployment!.state).toBe('absent')
    expect(JSON.stringify(result)).not.toContain(h.runtime.attestationFile)
    expect(JSON.stringify(result)).not.toContain(h.runtime.keyFile)
  })
})

describe('ticket callbacks final boundary and lifecycle', () => {
  it('delegates createMR metadata and merge verification only through host ticket callbacks', async () => {
    const h = fixture(); h.create()
    const callbacks = h.captured().deploymentTickets!
    const context = { ...h.context, request: { ...h.context.request, action: 'create_mr' as const } }
    expect(await callbacks.metadata(context)).toBe('signed-metadata')
    await callbacks.verify(h.context, 'exact MR metadata')
    expect(h.tickets.metadata).toHaveBeenCalledTimes(1)
    expect(h.tickets.verify).toHaveBeenCalledWith(expect.objectContaining({ request: h.context.request }), 'exact MR metadata')
  })

  it('refreshes merge deployment evidence immediately before GitLab and preserves synchronous live authorization', async () => {
    const h = fixture(), service = h.create()
    const result = await service.transport.dispatch(h.context, new AbortController().signal)
    expect(result.remoteIds).toEqual(['fake-accepted'])
    expect(h.gitlab.observe).toHaveBeenCalledTimes(1)
    expect(h.gitlab.dispatch).toHaveBeenCalledWith(expect.objectContaining({ snapshot: expect.objectContaining({ deployment: expect.objectContaining({ state: 'absent' }) }) }), expect.any(AbortSignal))
    expect(h.context.assertAuthorized).toHaveBeenCalled()
  })

  it('synchronously rejects operator revocation during GitLab final async reads before any external write', async () => {
    const h = fixture(), service = h.create(), mutation = vi.fn()
    vi.mocked(h.gitlab.dispatch).mockImplementationOnce(async context => {
      await Promise.resolve()
      h.document.repositories.app.remoteDeadlineEnforced = false; h.save()
      context.assertAuthorized()
      mutation()
      return { remoteIds: ['should-not-write'], detail: '' }
    })
    await expect(service.transport.dispatch(h.context, new AbortController().signal)).rejects.toThrow()
    expect(mutation).not.toHaveBeenCalled()
  })

  it('keeps createMR final mutation bound to the same live attestation after ticket metadata was signed', async () => {
    const h = fixture(), service = h.create(), mutation = vi.fn()
    vi.mocked(h.gitlab.dispatch).mockImplementationOnce(async context => {
      await h.captured().deploymentTickets!.metadata(context)
      h.document.expiresAt = future(-1); h.save()
      context.assertAuthorized()
      mutation()
      return { remoteIds: ['must-not-create'], detail: '' }
    })
    const context = { ...h.context, request: { ...h.context.request, action: 'create_mr' as const }, operation: { ...h.context.operation, action: 'create_mr' as const } }
    await expect(service.transport.dispatch(context, new AbortController().signal)).rejects.toThrow()
    expect(h.tickets.metadata).toHaveBeenCalledTimes(1)
    expect(mutation).not.toHaveBeenCalled()
  })

  it('rejects current host actor revocation even when all persisted attestation remains valid', async () => {
    const h = fixture(), service = h.create(); h.context.assertAuthorized = () => { throw new Error('actor revoked') }
    await expect(service.transport.dispatch(h.context, new AbortController().signal)).rejects.toThrow('actor revoked')
    expect(h.gitlab.dispatch).not.toHaveBeenCalled()
  })

  it('close aborts in-flight reads, waits settlement, and refuses new dispatch', async () => {
    const h = fixture(), service = h.create(), gate = deferred<RemoteSnapshot>(), entered = deferred<AbortSignal>()
    vi.mocked(h.gitlab.observe).mockImplementationOnce(async (_, signal) => { entered.resolve(signal); return gate.promise })
    const reading = service.transport.observe(h.context, new AbortController().signal)
    const observed = await entered.promise
    const failed = expect(reading).rejects.toThrow()
    let closed = false; const closing = service.close().then(() => { closed = true })
    expect(observed.aborted).toBe(true); expect(closed).toBe(false)
    gate.resolve(h.context.snapshot); await failed; await closing
    await expect(service.transport.dispatch(h.context, new AbortController().signal)).rejects.toThrow('closed')
    expect(h.gitlab.dispatch).not.toHaveBeenCalled()
  })
})
