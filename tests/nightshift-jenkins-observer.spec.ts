/** Offline Jenkins observer tests: fixed synthetic HTTP responses, temp credentials, no live service calls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { overlayJenkinsObservation, type JenkinsDeploymentAttestation, type JenkinsObservationContext, type JenkinsObserverOptions } from '../src/nightshift/release/jenkins-observer.ts'
import { releaseMarker, type RemoteSnapshot } from '../src/nightshift/release/contracts.ts'

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), CONFIG = 'c'.repeat(64), ARTIFACT = 'd'.repeat(64), WEB = 'e'.repeat(64)
const ORIGIN = 'http://127.0.0.1:18765', JOB = 'test/backend', NUMBER = 57, QUEUE = 101
const roots: string[] = []
const future = (ms = 60_000) => new Date(Date.now() + ms).toISOString()
const jobPath = (name: string) => name.split('/').map(part => `/job/${encodeURIComponent(part)}`).join('')
type Json = Record<string, any>
function fixture(kind: 'java' | 'web' = 'java') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-jenkins-observer-'))); roots.push(root)
  const credentialRef = join(root, 'credential.json'), secret = { username: 'reader', token: 'PRIVATE_READER_TOKEN', expiresAt: future() }
  writeFileSync(credentialRef, JSON.stringify(secret), { mode: 0o600 })
  const route = { kind: 'jenkins' as const, id: 'reviewed-test-route', jobs: [JOB], origin: ORIGIN, expectedConfigSha256: { [JOB]: CONFIG }, destinationId: 'k8s-test:namespace/app', remoteDeadlineEnforced: true, credentialRef }
  const context: JenkinsObservationContext = { repository: { alias: 'app', root: join(root, 'repo'), projectId: 445, projectPath: 'payment/refactor/app', host: 'git.example.test', apiOrigin: 'https://git.example.test', allowInsecureHttp: true, expectedUserId: 9, expectedUsername: 'release-bot', credentialFile: join(root, 'git-credential'), targetBranch: 'master', ciSha256: CONFIG, requiredJobs: ['unit'], mergeTriggersDeploy: true, triggerPolicy: { reviewedAt: future(-1000), expiresAt: future(), productionExcluded: true, fingerprint: 'reviewed' }, environments: { test: route } }, scope: { repository: 'app', sourceBranch: 'agent/task-1', targetBranch: 'master', baseSha: OTHER, environment: 'test', actions: ['merge', 'deploy'] }, request: { taskId: 'task-1', repository: 'app', action: 'merge', sha: SHA } }
  const attestation: JenkinsDeploymentAttestation = { expiresAt: future(), deadline: future(30_000), configSha256: { [JOB]: CONFIG }, remoteDeadlineEnforced: true, destinationId: route.destinationId, targets: { [JOB]: kind === 'java' ? { kind: 'java', project: '445', sourceInstance: 'https://git.example.test', namespace: 'test-namespace', deployment: 'app', mode: 'master-auto' } : { kind: 'web', service: 'app-web', config: { uid: 'config-uid', sha256: WEB }, sourceUrl: 'https://git.example.test/payment/refactor/app.git', branch: 'master', profile: 'build-only' } } }
  const snapshot: RemoteSnapshot = { identity: { id: 9, username: 'release-bot' }, project: { id: 445, path: 'payment/refactor/app', defaultBranch: 'master', pipelineRequired: true, fastForwardOnly: true }, sourceSha: SHA, targetSha: SHA, targetCiSha256: CONFIG, productionExcluded: true, triggerPolicyFingerprint: 'reviewed', mergeRequest: { iid: 27, sourceProjectId: 445, targetProjectId: 445, sourceBranch: 'agent/task-1', targetBranch: 'master', sha: SHA, state: 'merged', authorId: 9, draft: false, conflicts: false, mergeable: true, approved: true, unresolvedDiscussions: 0, mergeCommitSha: SHA, mergeCommitVerified: true, mergeTreeSha: OTHER, marker: releaseMarker('task-1', 'app', SHA) } }
  const build: Json = { number: NUMBER, queueId: QUEUE, result: 'SUCCESS', building: false, actions: [{ parameters: [{ name: 'branch', value: SHA }] }, { lastBuiltRevision: { SHA1: SHA } }] }
  const release: Json = kind === 'java'
    ? { source_instance: 'https://git.example.test', source: SHA, project: '445', ref: 'refs/heads/master', mode: 'master-auto', jenkins_url: `${ORIGIN}/`, jenkins_job: JOB, jenkins_build: String(NUMBER), target: { namespace: 'test-namespace', deployment: 'app' }, result: 'ready', image: `registry.test/app@sha256:${ARTIFACT}`, before_image: 'registry.test/app:previous', generation: 4, pods: ['app-abc-123'], health_basis: 'rollout+pods' }
    : { service: 'app-web', source: SHA, image: `registry.test/app-web@sha256:${ARTIFACT}`, result: 'ready', patch_attempted: true, stage: 'runtime-verification', config: { uid: 'config-uid', resource_version: '42', sha256: WEB }, generation: 4, pods: ['web-abc-123'] }
  const attempt: Json = kind === 'java' ? { ...release } : { service: 'app-web', source: SHA, branch: 'master', url: 'https://git.example.test/payment/refactor/app.git', mode: 'master-auto', attempt: 'attempt-1', result: 'ready', cleanup: true, profile: 'build-only', possible_partial_update: false, release: structuredClone(release), audit: { environment: 'test', service: 'app-web', source: SHA, result: 'passed', mode: 'master-auto', profile: 'build-only', tests_executed: false, config_sha256: CONFIG }, image_inputs: { source: SHA } }
  const queue: Json = { items: [] }, list: Json = { builds: [build] }
  const responses = new Map<string, unknown>([
    ['/queue/api/json', queue], [`${jobPath(JOB)}/api/json`, list], [`${jobPath(JOB)}/${NUMBER}/api/json`, build],
    [`${jobPath(JOB)}/${NUMBER}/artifact/jenkins-evidence/release.json`, release], [`${jobPath(JOB)}/${NUMBER}/artifact/jenkins-evidence/attempt.json`, attempt],
  ])
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect(url.origin).toBe(ORIGIN); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from('reader:PRIVATE_READER_TOKEN').toString('base64')}`)
    expect(url.pathname).not.toMatch(/config\.xml|console|buildWithParameters|\/build$/)
    const value = responses.get(url.pathname)
    return value instanceof Response ? value : new Response(value === undefined ? '' : JSON.stringify(value), { status: value === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } })
  })
  const options: JenkinsObserverOptions = { attest: vi.fn(async () => structuredClone(attestation)), fetch: fetcher as typeof fetch }
  const observe = () => overlayJenkinsObservation(context, snapshot, new AbortController().signal, options)
  return { root, secret, credentialRef, context, route, attestation, snapshot, build, release, attempt, queue, list, responses, fetcher, options, observe }
}
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-jenkins-observer-')) throw new Error(`Unsafe fixture cleanup ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('pinned GET-only Jenkins observer', () => {
  it.each(['java', 'web'] as const)('proves %s artifact identity/readiness with stable queue identity and no secret leakage', async kind => {
    const h = fixture(kind), before = structuredClone(h.snapshot)
    const result = await h.observe()
    expect(result.deployment).toMatchObject({ state: 'succeeded', healthy: true, ids: [`${JOB}:queue:${QUEUE}`], remoteDeadlineEnforced: true, configSha256: { [JOB]: CONFIG }, deadline: h.attestation.deadline, builds: [{ job: JOB, id: `${JOB}:queue:${QUEUE}`, sha: SHA, destinationId: h.route.destinationId, state: 'succeeded', artifactDigest: `sha256:${ARTIFACT}`, healthy: true }] })
    expect(h.snapshot).toEqual(before)
    expect(JSON.stringify(result)).not.toContain(h.secret.token)
    expect(JSON.stringify(result)).not.toContain(h.credentialRef)
    expect(JSON.stringify(result)).not.toContain('config-uid')
    expect(h.fetcher).toHaveBeenCalledTimes(5)
  })

  it.each(['missing-attestation', 'expired', 'wrong-config', 'missing-job', 'destination', 'deadline-unenforced', 'route-unenforced'] as const)('fails closed before fetch for %s evidence', async invalid => {
    const h = fixture()
    if (invalid === 'missing-attestation') delete h.options.attest
    if (invalid === 'expired') h.attestation.expiresAt = future(-1)
    if (invalid === 'wrong-config') h.attestation.configSha256[JOB] = WEB
    if (invalid === 'missing-job') delete h.attestation.targets[JOB]
    if (invalid === 'destination') h.attestation.destinationId = 'production'
    if (invalid === 'deadline-unenforced') h.attestation.remoteDeadlineEnforced = false
    if (invalid === 'route-unenforced') h.route.remoteDeadlineEnforced = false
    expect((await h.observe()).deployment).toMatchObject({ state: 'unknown', remoteDeadlineEnforced: false, healthy: false })
    expect(h.fetcher).not.toHaveBeenCalled()
  })

  it.each(['permissions', 'symlink', 'hardlink', 'expired', 'username-colon', 'malformed', 'oversized', 'extra-secret'] as const)('rejects %s credentials without leaking or using them', async invalid => {
    const h = fixture()
    if (invalid === 'permissions') chmodSync(h.credentialRef, 0o644)
    if (invalid === 'symlink') { const alias = join(h.root, 'symlink'); symlinkSync(h.credentialRef, alias); h.route.credentialRef = alias }
    if (invalid === 'hardlink') linkSync(h.credentialRef, join(h.root, 'hardlink'))
    if (invalid === 'expired') writeFileSync(h.credentialRef, JSON.stringify({ ...h.secret, expiresAt: future(-1) }))
    if (invalid === 'username-colon') writeFileSync(h.credentialRef, JSON.stringify({ ...h.secret, username: 'bad:user' }))
    if (invalid === 'malformed') writeFileSync(h.credentialRef, 'secret malformed JSON')
    if (invalid === 'oversized') writeFileSync(h.credentialRef, 'x'.repeat(20_000))
    if (invalid === 'extra-secret') writeFileSync(h.credentialRef, JSON.stringify({ ...h.secret, adminPassword: 'secret' }))
    const result = await h.observe()
    expect(result.deployment!.state).toBe('unknown'); expect(h.fetcher).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_READER_TOKEN|adminPassword|credential.json/)
  })

  it.each(['redirect', 'large-body', 'invalid-json', 'failed-get', 'cancelled', 'foreign-origin', 'traversal-job'] as const)('does not follow or trust %s transport evidence', async invalid => {
    const h = fixture()
    if (invalid === 'redirect') h.responses.set('/queue/api/json', new Response(null, { status: 302, headers: { Location: 'https://evil.test/token' } }))
    if (invalid === 'large-body') { h.options.maxBodyBytes = 100; h.responses.set('/queue/api/json', { items: [], padding: 'x'.repeat(101) }) }
    if (invalid === 'invalid-json') h.responses.set('/queue/api/json', new Response('bad json'))
    if (invalid === 'failed-get') h.responses.set('/queue/api/json', new Response('PRIVATE_READER_TOKEN', { status: 500 }))
    if (invalid === 'foreign-origin') h.route.origin = 'http://127.0.0.1:18765/path'
    if (invalid === 'traversal-job') h.route.jobs = ['../../evil']
    const controller = new AbortController(); if (invalid === 'cancelled') controller.abort()
    const result = await overlayJenkinsObservation(h.context, h.snapshot, controller.signal, h.options)
    expect(result.deployment!.state).toBe('unknown')
    expect(JSON.stringify(result)).not.toContain(h.secret.token)
    expect(h.fetcher.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('requires explicit HTTP consent and leaves unrelated no-route observations untouched', async () => {
    const h = fixture(); delete h.context.repository.allowInsecureHttp
    expect((await h.observe()).deployment!.state).toBe('unknown'); expect(h.fetcher).not.toHaveBeenCalled()
    delete h.context.scope.environment
    expect(await h.observe()).toEqual(h.snapshot)
  })

  it('rejects attestation or credential expiration occurring during a read', async () => {
    vi.useFakeTimers()
    const h = fixture(), original = h.options.fetch!
    let advanced = false
    h.options.fetch = async (...args) => { const response = await original(...args); if (!advanced) { advanced = true; vi.setSystemTime(Date.now() + 120_000) }; return response }
    expect((await h.observe()).deployment!.state).toBe('unknown')
    expect(h.fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('exact build selection and remote activity', () => {
  it('observes a recent unique source in a long-lived job only when the 101st timestamp proves the grant-era window complete', async () => {
    const h = fixture(), now = Date.now()
    h.attestation.notBefore = new Date(now - 5000).toISOString()
    h.build.timestamp = now - 1000
    h.list.builds = [h.build, ...Array.from({ length: 100 }, (_, index) => ({ number: 1000 - index, queueId: 2000 - index, timestamp: now - (index + 2) * 1000, result: 'SUCCESS', building: false, actions: [{ lastBuiltRevision: { SHA1: OTHER } }] }))]
    expect((await h.observe()).deployment!.state).toBe('succeeded')
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes('timestamp'))).toBe(true)
    expect(h.fetcher).toHaveBeenCalledTimes(5)
  })

  it.each(['no-bound', 'boundary-not-crossed', 'boundary-equal', 'future-time', 'missing-time', 'unordered-time', 'duplicate-before-signing', 'source-before-grant', 'readback-time-drift'] as const)('keeps long-history %s evidence unknown rather than guessing latest', async invalid => {
    const h = fixture(), now = Date.now(), issuedAt = now - 5000
    h.attestation.notBefore = new Date(issuedAt).toISOString()
    h.build.timestamp = now - 1000
    h.list.builds = [h.build, ...Array.from({ length: 100 }, (_, index) => ({ number: 1000 - index, queueId: 2000 - index, timestamp: now - (index + 2) * 1000, result: 'SUCCESS', building: false, actions: [{ lastBuiltRevision: { SHA1: OTHER } }] }))]
    if (invalid === 'no-bound') delete h.attestation.notBefore
    if (invalid === 'boundary-not-crossed') h.attestation.notBefore = new Date(now - 200_000).toISOString()
    if (invalid === 'boundary-equal') h.attestation.notBefore = new Date(h.list.builds[100].timestamp).toISOString()
    if (invalid === 'future-time') h.build.timestamp = now + 60_000
    if (invalid === 'missing-time') delete h.list.builds[20].timestamp
    if (invalid === 'unordered-time') h.list.builds[20].timestamp = now - 500
    // Ticket signing was now-2000; duplicate now-3000 is earlier than signing but later than grant.
    if (invalid === 'duplicate-before-signing') h.list.builds[2].actions = [{ lastBuiltRevision: { SHA1: SHA } }]
    if (invalid === 'source-before-grant') h.list.builds[99].actions = [{ lastBuiltRevision: { SHA1: SHA } }]
    if (invalid === 'readback-time-drift') h.responses.set(`${jobPath(JOB)}/${NUMBER}/api/json`, { ...h.build, timestamp: now - 500 })
    expect((await h.observe()).deployment).toMatchObject({ state: 'unknown', healthy: false })
  })

  it('never chooses newest when multiple builds claim the same source', async () => {
    const h = fixture(); h.list.builds = [h.build, { ...h.build, number: 58, queueId: 102 }]
    expect((await h.observe()).deployment!.state).toBe('unknown')
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes('/58/'))).toBe(false)
  })

  it.each(['conflicting-sha', 'changed-readback', 'queue-id-drift', 'duplicate-number', 'too-many-builds', 'too-many-queue', 'malformed-action'] as const)('fails closed on %s selection evidence', async invalid => {
    const h = fixture()
    if (invalid === 'conflicting-sha') h.build.actions[0].parameters[0].value = OTHER
    if (invalid === 'changed-readback') h.responses.set(`${jobPath(JOB)}/${NUMBER}/api/json`, { ...h.build, actions: [{ lastBuiltRevision: { SHA1: OTHER } }] })
    if (invalid === 'queue-id-drift') h.responses.set(`${jobPath(JOB)}/${NUMBER}/api/json`, { ...h.build, queueId: 102 })
    if (invalid === 'duplicate-number') h.list.builds.push(structuredClone(h.build))
    if (invalid === 'too-many-builds') h.list.builds = Array.from({ length: 101 }, (_, number) => ({ ...h.build, number: number + 1 }))
    if (invalid === 'too-many-queue') h.queue.items = Array.from({ length: 101 }, (_, id) => ({ id: id + 1, task: { name: 'unrelated' }, actions: [] }))
    if (invalid === 'malformed-action') h.build.actions = [null]
    expect((await h.observe()).deployment!.state).toBe('unknown')
  })

  it('tracks the same physical queue ID through queued, running and verified-success states', async () => {
    const h = fixture(); h.list.builds = []
    h.queue.items = [{ id: QUEUE, task: { name: 'backend', fullName: JOB }, actions: [{ parameters: [{ name: 'branch', value: SHA }] }] }]
    const queued = await h.observe(); expect(queued.deployment).toMatchObject({ state: 'queued', ids: [`${JOB}:queue:${QUEUE}`], healthy: false })
    h.queue.items = []; h.list.builds = [h.build]; h.build.building = true; h.build.result = null
    const running = await h.observe(); expect(running.deployment).toMatchObject({ state: 'running', ids: queued.deployment!.ids })
    h.build.building = false; h.build.result = 'SUCCESS'
    expect((await h.observe()).deployment).toMatchObject({ state: 'succeeded', ids: queued.deployment!.ids })
  })

  it.each(['open', 'wrong-marker', 'unverified-merge', 'wrong-target'] as const)('does not claim same-SHA artifact success is an authorized merge deployment with %s MR', async invalid => {
    const h = fixture()
    if (invalid === 'open') h.snapshot.mergeRequest!.state = 'opened'
    if (invalid === 'wrong-marker') h.snapshot.mergeRequest!.marker = 'another-task'
    if (invalid === 'unverified-merge') h.snapshot.mergeRequest!.mergeCommitVerified = false
    if (invalid === 'wrong-target') h.snapshot.targetSha = OTHER
    expect((await h.observe()).deployment).toMatchObject({ state: 'unknown', healthy: false })
  })

  it('does not infer folder-job absence from a leaf-only unidentifiable queue entry', async () => {
    const h = fixture(); h.list.builds = []; h.snapshot.mergeRequest!.state = 'opened'
    h.queue.items = [{ id: QUEUE, task: { name: 'backend' }, actions: [] }]
    expect((await h.observe()).deployment!.state).toBe('unknown')
  })

  it('reports terminal failure with concrete IDs and never says healthy', async () => {
    const h = fixture(); h.build.result = 'FAILURE'
    expect((await h.observe()).deployment).toMatchObject({ state: 'failed', healthy: false, ids: [`${JOB}:queue:${QUEUE}`], builds: [{ state: 'failed', healthy: false }] })
    expect(h.fetcher).toHaveBeenCalledTimes(3)
  })

  it('reports absence only for an exact still-open owned MR, never after merge or ambiguous queue evidence', async () => {
    const h = fixture(); h.list.builds = []
    expect((await h.observe()).deployment!.state).toBe('unknown')
    h.snapshot.mergeRequest!.state = 'opened'
    expect((await h.observe()).deployment!.state).toBe('absent')
    h.snapshot.mergeRequest!.marker = 'foreign'
    expect((await h.observe()).deployment!.state).toBe('unknown')
    h.snapshot.mergeRequest!.marker = releaseMarker('task-1', 'app', SHA)
    h.queue.items = [{ id: 9, task: { fullName: JOB }, actions: [{ parameters: [{ name: 'branch', value: 'master' }] }] }]
    expect((await h.observe()).deployment!.state).toBe('unknown')
  })

  it('flags only an unexpired exact-merge visibility gap as awaiting webhook, never conflicts or expiry', async () => {
    const h = fixture(); h.list.builds = []
    expect((await h.observe()).deployment).toMatchObject({ state: 'unknown', healthy: false, ids: [], awaitingWebhook: true })
    h.attestation.deadline = future(-1)
    expect((await h.observe()).deployment).not.toHaveProperty('awaitingWebhook')
    h.attestation.deadline = future(); h.snapshot.mergeRequest!.mergeCommitVerified = false
    expect((await h.observe()).deployment).not.toHaveProperty('awaitingWebhook')
    h.snapshot.mergeRequest!.mergeCommitVerified = true; h.list.builds = [h.build, { ...h.build, number: 58, queueId: 102 }]
    expect((await h.observe()).deployment).not.toHaveProperty('awaitingWebhook')
  })

  it('does not substitute another SHA or reuse a simultaneous queued retry', async () => {
    const h = fixture(); h.build.actions = [{ lastBuiltRevision: { SHA1: OTHER } }]
    expect((await h.observe()).deployment!.state).toBe('unknown')
    h.build.actions = [{ lastBuiltRevision: { SHA1: SHA } }]
    h.queue.items = [{ id: QUEUE + 1, task: { fullName: JOB }, actions: [{ parameters: [{ name: 'source40', value: SHA }] }] }]
    expect((await h.observe()).deployment!.state).toBe('unknown')
  })
})

describe('artifact identity and runtime health proofs', () => {
  it.each(['wrong-project', 'wrong-source', 'wrong-instance', 'wrong-job', 'wrong-build', 'wrong-origin', 'wrong-namespace', 'wrong-deployment', 'wrong-ref', 'wrong-mode', 'attempt-image', 'not-ready', 'no-pods', 'zero-generation', 'mutable-image', 'missing-release', 'missing-attempt'] as const)('denies Java %s artifact evidence', async invalid => {
    const h = fixture()
    if (invalid === 'wrong-project') h.release.project = 'other'
    if (invalid === 'wrong-source') h.release.source = OTHER
    if (invalid === 'wrong-instance') h.release.source_instance = 'https://other.test'
    if (invalid === 'wrong-job') h.release.jenkins_job = 'other-job'
    if (invalid === 'wrong-build') h.release.jenkins_build = '58'
    if (invalid === 'wrong-origin') h.release.jenkins_url = `${ORIGIN}/job/wrong/57/`
    if (invalid === 'wrong-namespace') h.release.target.namespace = 'production'
    if (invalid === 'wrong-deployment') h.release.target.deployment = 'other'
    if (invalid === 'wrong-ref') h.release.ref = 'refs/heads/other'
    if (invalid === 'wrong-mode') h.release.mode = 'manual'
    if (invalid === 'attempt-image') h.attempt.image = 'registry.test/app:latest'
    if (invalid === 'not-ready') h.release.result = 'pending'
    if (invalid === 'no-pods') h.release.pods = []
    if (invalid === 'zero-generation') h.release.generation = 0
    if (invalid === 'mutable-image') h.release.image = 'registry.test/app:latest'
    if (invalid === 'missing-release') h.responses.delete(`${jobPath(JOB)}/${NUMBER}/artifact/jenkins-evidence/release.json`)
    if (invalid === 'missing-attempt') h.responses.delete(`${jobPath(JOB)}/${NUMBER}/artifact/jenkins-evidence/attempt.json`)
    const result = await h.observe(); expect(result.deployment).toMatchObject({ state: 'unknown', healthy: false })
  })

  it('checks optional Java publisher fingerprint against pinned manifest without exposing its arbitrary config', async () => {
    const h = fixture(); Object.assign(h.attestation.targets[JOB]!, { publisherFingerprint: WEB })
    const manifest = { source: SHA, project: '445', environment: 'test', jenkins_job: JOB, jenkins_build: String(NUMBER), config_fingerprint: WEB, target: { namespace: 'test-namespace', deployment: 'app', container: 'app' }, image: h.release.image, private_config: 'MUST_NOT_ESCAPE' }
    h.responses.set(`${jobPath(JOB)}/${NUMBER}/artifact/jenkins-evidence/release-manifest.json`, manifest)
    const result = await h.observe(); expect(result.deployment!.state).toBe('succeeded'); expect(JSON.stringify(result)).not.toContain('MUST_NOT_ESCAPE')
    manifest.config_fingerprint = CONFIG
    expect((await h.observe()).deployment!.state).toBe('unknown')
  })

  it.each(['service', 'source', 'config-uid', 'config-hash', 'stage', 'patch', 'release-not-ready', 'attempt-partial', 'attempt-cleanup', 'attempt-source-url', 'attempt-branch', 'attempt-profile', 'nested-generation', 'audit-environment', 'audit-not-passed', 'audit-mode', 'audit-profile', 'audit-tests', 'audit-config', 'image-source'] as const)('denies Web %s artifact evidence', async invalid => {
    const h = fixture('web')
    if (invalid === 'service') h.release.service = 'another'
    if (invalid === 'source') h.release.source = OTHER
    if (invalid === 'config-uid') h.release.config.uid = 'other-config'
    if (invalid === 'config-hash') h.release.config.sha256 = CONFIG
    if (invalid === 'stage') h.release.stage = 'build-only'
    if (invalid === 'patch') h.release.patch_attempted = false
    if (invalid === 'release-not-ready') h.release.result = 'passed'
    if (invalid === 'attempt-partial') h.attempt.possible_partial_update = true
    if (invalid === 'attempt-cleanup') h.attempt.cleanup = false
    if (invalid === 'attempt-source-url') h.attempt.url = 'https://other.test/repository.git'
    if (invalid === 'attempt-branch') h.attempt.branch = 'production'
    if (invalid === 'attempt-profile') h.attempt.profile = 'other'
    if (invalid === 'nested-generation') h.attempt.release.generation = 99
    if (invalid === 'audit-environment') h.attempt.audit.environment = 'production'
    if (invalid === 'audit-not-passed') h.attempt.audit.result = 'ready'
    if (invalid === 'audit-mode') h.attempt.audit.mode = 'manual'
    if (invalid === 'audit-profile') h.attempt.audit.profile = 'full-verify'
    if (invalid === 'audit-tests') h.attempt.audit.tests_executed = true
    if (invalid === 'audit-config') h.attempt.audit.config_sha256 = 'latest'
    if (invalid === 'image-source') h.attempt.image_inputs.source = OTHER
    expect((await h.observe()).deployment).toMatchObject({ state: 'unknown', healthy: false })
  })

  it('matches captured publisher audit passed versus runtime ready without conflating build and nginx digests', async () => {
    // Sanitized projection of decoded-mate-web-release.py validate_build_report and captured attempt/release schema.
    const h = fixture('web')
    expect(h.attempt.audit.result).toBe('passed')
    expect(h.release.result).toBe('ready')
    expect(h.attempt.audit.config_sha256).not.toBe(h.release.config.sha256)
    const target = h.attestation.targets[JOB]!
    if (target.kind !== 'web') throw new Error('Fixture target mismatch')
    target.buildConfigSha256 = CONFIG
    expect((await h.observe()).deployment!.state).toBe('succeeded')
    h.attempt.audit.config_sha256 = WEB // Still well-formed, but wrong optional operator build-config pin.
    expect((await h.observe()).deployment!.state).toBe('unknown')
    delete target.buildConfigSha256
    expect((await h.observe()).deployment!.state).toBe('succeeded')
    target.profile = h.attempt.profile = h.attempt.audit.profile = 'full-verify'
    h.attempt.audit.tests_executed = true
    expect((await h.observe()).deployment!.state).toBe('succeeded')
    h.release.result = 'passed'
    expect((await h.observe()).deployment!.state).toBe('unknown')
  })

  it('uses the captured Java release-manifest.json endpoint only, with no guessed manifest fallback', async () => {
    // jenkins-artifact-contract.json captured mate-account#57 and mate-data-center-export#71 use this relativePath.
    const h = fixture(); Object.assign(h.attestation.targets[JOB]!, { publisherFingerprint: WEB })
    const manifest = { source: SHA, project: '445', environment: 'test', jenkins_job: JOB, jenkins_build: String(NUMBER), config_fingerprint: WEB, target: { namespace: 'test-namespace', deployment: 'app' }, image: h.release.image }
    h.responses.set(`${jobPath(JOB)}/${NUMBER}/artifact/jenkins-evidence/manifest.json`, manifest)
    expect((await h.observe()).deployment!.state).toBe('unknown')
    expect(h.fetcher.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/jenkins-evidence/manifest.json'))).toBe(false)
    h.responses.set(`${jobPath(JOB)}/${NUMBER}/artifact/jenkins-evidence/release-manifest.json`, manifest)
    expect((await h.observe()).deployment!.state).toBe('succeeded')
  })

  it('returns complete separate facts only after every configured sibling build verifies', async () => {
    const h = fixture(), sibling = 'test/worker', number = 58, queueId = 102
    h.route.jobs.push(sibling); (h.route.expectedConfigSha256 as Record<string, string>)[sibling] = CONFIG
    h.attestation.configSha256[sibling] = CONFIG; h.attestation.targets[sibling] = structuredClone(h.attestation.targets[JOB]!)
    const build = { ...h.build, number, queueId }
    const release = { ...h.release, jenkins_job: sibling, jenkins_build: String(number) }, attempt = { ...h.attempt, jenkins_job: sibling, jenkins_build: String(number) }
    h.responses.set(`${jobPath(sibling)}/api/json`, { builds: [build] })
    h.responses.set(`${jobPath(sibling)}/${number}/api/json`, build)
    h.responses.set(`${jobPath(sibling)}/${number}/artifact/jenkins-evidence/release.json`, release)
    h.responses.set(`${jobPath(sibling)}/${number}/artifact/jenkins-evidence/attempt.json`, attempt)
    const result = await h.observe()
    expect(result.deployment).toMatchObject({ state: 'succeeded', healthy: true, ids: [`${JOB}:queue:${QUEUE}`, `${sibling}:queue:${queueId}`] })
    expect(result.deployment!.builds).toHaveLength(2)
    expect(result.deployment!.builds!.every(build => build.healthy && build.artifactDigest === `sha256:${ARTIFACT}`)).toBe(true)
  })

  it('requires every configured sibling job instead of treating one success as full deployment', async () => {
    const h = fixture(); const sibling = 'test/web'
    h.route.jobs.push(sibling); (h.route.expectedConfigSha256 as Record<string, string>)[sibling] = CONFIG
    h.attestation.configSha256[sibling] = CONFIG; h.attestation.targets[sibling] = structuredClone(h.attestation.targets[JOB]!)
    h.responses.set(`${jobPath(sibling)}/api/json`, { builds: [] })
    const result = await h.observe()
    expect(result.deployment).toMatchObject({ state: 'unknown', healthy: false, ids: [`${JOB}:queue:${QUEUE}`] })
    expect(result.deployment!.builds).toHaveLength(1)
  })
})
