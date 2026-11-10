/** Actual release composition with fake HTTP/push only. No real network, Jenkins mutation, or business repository. */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createReleaseCoordinator, policyDigest, type ReleaseCoordinator } from '../src/nightshift/release/coordinator.ts'
import { createReleaseServices, type ReleaseServices } from '../src/nightshift/release/composite-transport.ts'
import { createGitlabTransport } from '../src/nightshift/release/gitlab.ts'
import { CommitReceipts } from '../src/nightshift/release/receipts.ts'
import { GIT_SAFE_ARGS, workerEnvironment } from '../src/nightshift/preflight.ts'
import type { NightConfig, Task } from '../src/nightshift/contracts.ts'
import type { ReleaseAction, ReleaseGrant, ReleasePolicy } from '../src/nightshift/release/contracts.ts'

const roots: string[] = [], coordinators: ReleaseCoordinator[] = [], services: ReleaseServices[] = [], stores: CommitReceipts[] = []
const GITLAB = 'https://gitlab.fixture.invalid', JENKINS = 'https://jenkins.fixture.invalid', JOB = 'test/app', JOB_PATH = '/job/test/job/app', KEY = Buffer.alloc(32, 71)
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const future = (milliseconds = 120_000) => new Date(Date.now() + milliseconds).toISOString()
const signal = () => new AbortController().signal
const gate = fileURLToPath(new URL('../integrations/jenkins/nightshift-gate.py', import.meta.url))
const pythonValidate = String.raw`
import importlib.util,json,sys
from datetime import datetime
spec=importlib.util.spec_from_file_location('nightshift_gate',sys.argv[1]);g=importlib.util.module_from_spec(spec);sys.modules[spec.name]=g;spec.loader.exec_module(g)
data=json.load(sys.stdin); out=[]
for ticket in data['tickets']:
 p=ticket['payload'];ctx=g.GateContext(job=p['jobs'][0],build_id='fixture-build-57',source_sha=p['sourceSha'],project_id=p['projectId'],destination_id=p['destinationId'],environment=p['environment'],key_id=p['keyId'])
 out.append(g.validate(ticket,bytes.fromhex(data['key']),ctx,datetime.fromisoformat(data['now'].replace('Z','+00:00'))))
print(json.dumps(out))
`
function fixture(siblings = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-release-flow-'))); roots.push(root)
  const repo = join(root, 'workspace', 'app'), home = join(root, 'home'), stateDir = join(root, 'state')
  for (const path of [repo, home, stateDir]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const config: NightConfig = { enabled: true, workspace: join(root, 'workspace'), stateDir, piExecutable: '/fake/pi', piHome: home, sessionFile: join(stateDir, 'session'), repositories: { app: repo }, maxTaskSeconds: 120, freezeWindows: [] }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', [...GIT_SAFE_ARGS, '-C', repo, ...args], { encoding: 'utf8', timeout: 5000, env: { ...workerEnvironment(config), GIT_AUTHOR_NAME: 'Offline Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Offline Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).trim()
  const ci = 'workflow:\n  rules: []\n', ciHash = hash(ci), jobHash = hash('reviewed job configuration'), imageHash = hash('immutable fixture image')
  git('init', '-q', '-b', 'master'); writeFileSync(join(repo, '.gitlab-ci.yml'), ci); writeFileSync(join(repo, 'VALUE.txt'), 'baseline\n'); git('add', '.'); git('commit', '-qm', 'disposable baseline')
  const base = git('rev-parse', 'HEAD'), grantIssuedAt = future(-1000)
  git('checkout', '-q', '-b', 'agent/flow-task'); writeFileSync(join(repo, 'VALUE.txt'), 'approved change\n'); git('add', '--', 'VALUE.txt'); git('commit', '-qm', 'disposable candidate')
  const sha = git('rev-parse', 'HEAD'), treeSha = git('rev-parse', 'HEAD^{tree}')
  const gitCredential = join(root, 'git-credential.json'), jenkinsCredential = join(root, 'jenkins-credential.json')
  writeFileSync(gitCredential, JSON.stringify({ token: 'offline-token-never-live', userId: 71, username: 'project_bot', projectId: 445, expiresAt: future() }), { mode: 0o600 })
  writeFileSync(jenkinsCredential, JSON.stringify({ username: 'reader', token: 'offline-jenkins-token', expiresAt: future() }), { mode: 0o600 })
  const runtime = { keyId: 'fixture-key', keyFile: join(root, 'key.bin'), ticketDir: join(root, 'tickets'), attestationFile: join(root, 'attestation.json') }
  writeFileSync(runtime.keyFile, KEY, { mode: 0o600 })
  const policy: ReleasePolicy = { version: 1, enabled: true, maxGrantSeconds: 3600, freezeWindows: [], repositories: { app: { alias: 'app', root: repo, projectId: 445, projectPath: 'payment/refactor/app', host: 'gitlab.fixture.invalid', apiOrigin: GITLAB, expectedUserId: 71, expectedUsername: 'project_bot', credentialFile: gitCredential, targetBranch: 'master', ciSha256: ciHash, requiredJobs: ['unit'], mergeTriggersDeploy: true, pushHasNoRemoteJobs: true,
    triggerPolicy: { reviewedAt: future(-2000), expiresAt: future(), productionExcluded: true, fingerprint: 'reviewed-ci' }, environments: { test: { kind: 'jenkins', id: 'test-route', jobs: [JOB], origin: JENKINS, expectedConfigSha256: { [JOB]: jobHash }, destinationId: 'test:namespace:app', remoteDeadlineEnforced: true, credentialRef: jenkinsCredential } } } } }
  config.releasePolicy = policy; config.releaseRuntime = runtime
  writeFileSync(runtime.attestationFile, JSON.stringify({ version: 1, expiresAt: future(), repositories: { app: { root: repo, destinationId: 'test:namespace:app', configSha256: { [JOB]: jobHash }, remoteDeadlineEnforced: true, targets: { [JOB]: { kind: 'java', project: '445', sourceInstance: GITLAB, namespace: 'test', deployment: 'app', mode: 'master-auto' } } } } }), { mode: 0o600 })
  const grant: ReleaseGrant = { id: 'grant-flow', taskId: 'task-flow', ownerId: 'owner', approvalMessageId: 'approval-flow', issuedAt: grantIssuedAt, expiresAt: future(), policyDigest: policyDigest(policy), scopes: [{ repository: 'app', sourceBranch: 'agent/flow-task', targetBranch: 'master', baseSha: base, actions: ['push', 'create_mr', 'merge', 'deploy'], environment: 'test' }] }
  const task: Task = { id: 'task-flow', originId: 'dm-flow', ownerId: 'owner', text: 'Approved bounded release fixture', repositories: ['app'], access: 'write', approved: true, approveMessageId: 'approve', releaseGrant: grant, target: { source: 'feishu', chatId: 'private', messageId: 'dm-flow' }, state: 'running', createdAt: grantIssuedAt }
  const receipts = new CommitReceipts(join(stateDir, 'receipts.sqlite'), config); stores.push(receipts)
  const receiptId = receipts.record({ taskId: task.id, runId: 'run-flow', repository: 'app', root: repo, head: sha, parent: base, branch: 'agent/flow-task', treeSha, sourceDigest: hash('source fixture'), validationIds: [hash('passed pinned source check')], recipePins: { source: hash('pinned source recipe') } })
  if (siblings) {
    const route = policy.repositories.app!.environments.test!, job = 'test/worker'
    route.jobs.push(job); route.expectedConfigSha256[job] = jobHash
    const attestation = { version: 1, expiresAt: future(), repositories: { app: { root: repo, destinationId: route.destinationId, configSha256: route.expectedConfigSha256, remoteDeadlineEnforced: true, targets: Object.fromEntries(route.jobs.map(job => [job, { kind: 'java', project: '445', sourceInstance: GITLAB, namespace: 'test', deployment: 'app', mode: 'master-auto' }])) } } }
    writeFileSync(runtime.attestationFile, JSON.stringify(attestation), { mode: 0o600 }); grant.policyDigest = policyDigest(policy)
  }
  const remote = { source: undefined as string | undefined, target: base, mr: false, description: '', merged: false, pipeline: 'missing', deployment: 'absent', queueId: 901, number: 57, timestamp: Date.now(), tamperMetadata: false, buildVisible: true, siblingVisible: true }
  const calls: { origin: string; method: string; path: string; body?: Record<string, unknown> }[] = [], pushes: string[] = []
  const mr = () => ({ iid: 9, source_project_id: 445, target_project_id: 445, source_branch: 'agent/flow-task', target_branch: 'master', author: { id: 71 }, sha, state: remote.merged ? 'merged' : 'opened', description: remote.description, draft: false, has_conflicts: false, detailed_merge_status: 'mergeable', squash: false, squash_on_merge: false, merge_when_pipeline_succeeds: false, ...(remote.pipeline === 'missing' ? {} : { head_pipeline: { id: 21 } }), ...(remote.merged ? { merge_commit_sha: sha } : {}) })
  const release = () => ({ source_instance: GITLAB, source: sha, project: '445', ref: 'refs/heads/master', mode: 'master-auto', jenkins_url: `${JENKINS}/`, jenkins_job: JOB, jenkins_build: String(remote.number), target: { namespace: 'test', deployment: 'app' }, result: 'ready', image: `registry.fixture.invalid/app@sha256:${imageHash}`, before_image: 'registry.fixture.invalid/app:before', generation: 7, pods: ['app-fixture-pod'], health_basis: 'fixture exact runtime proof' })
  const build = () => ({ number: remote.number, queueId: remote.queueId, timestamp: remote.timestamp, building: remote.deployment === 'running', result: remote.deployment === 'running' ? null : 'SUCCESS', actions: [{ parameters: [{ name: 'branch', value: sha }] }, { lastBuiltRevision: { SHA1: sha } }] })
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ origin: url.origin, method, path: url.pathname, ...(body ? { body } : {}) })
    expect(init?.redirect).toBe('manual')
    const json = (value: unknown, status = 200, list = false) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...(list ? { 'x-next-page': '' } : {}) } })
    const path = url.pathname
    if (url.origin === JENKINS) {
      expect(method).toBe('GET'); expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from('reader:offline-jenkins-token').toString('base64')}`)
      if (path === '/queue/api/json') return json({ items: [] })
      const jobs = policy.repositories.app!.environments.test!.jobs
      for (const [index, job] of jobs.entries()) {
        const prefix = job.split('/').map(part => `/job/${part}`).join(''), number = remote.number + index
        const visible = index === 0 ? remote.buildVisible : remote.siblingVisible
        const info = { ...build(), number, queueId: remote.queueId + index }
        if (path === `${prefix}/api/json`) return json({ builds: remote.deployment === 'absent' || !visible ? [] : [info] })
        if (path === `${prefix}/${number}/api/json`) return json(info)
        if (path === `${prefix}/${number}/artifact/jenkins-evidence/release.json` || path === `${prefix}/${number}/artifact/jenkins-evidence/attempt.json`) return json({ ...release(), jenkins_job: job, jenkins_build: String(number) })
      }
      throw new Error('Unexpected fake Jenkins endpoint')
    }
    expect(url.origin).toBe(GITLAB); expect(new Headers(init?.headers).get('PRIVATE-TOKEN')).toBe('offline-token-never-live')
    if (method === 'POST' && path === '/api/v4/projects/445/merge_requests') {
      expect(remote.mr).toBe(false); remote.mr = true; remote.description = String(body!.description)
      return json({ iid: 9 })
    }
    if (method === 'PUT' && path === '/api/v4/projects/445/merge_requests/9/merge') {
      expect(body).toMatchObject({ sha, squash: false, merge_when_pipeline_succeeds: false }); remote.merged = true; remote.target = sha; remote.deployment = 'running'; remote.timestamp = Date.now()
      return json(mr())
    }
    expect(method).toBe('GET')
    if (path === '/api/v4/user') return json({ id: 71, username: 'project_bot', state: 'active' })
    if (path === '/api/v4/projects/445') return json({ id: 445, path_with_namespace: 'payment/refactor/app', default_branch: 'master', archived: false, only_allow_merge_if_pipeline_succeeds: true, merge_method: 'ff', squash_option: 'never' })
    if (path.endsWith('/branches/master')) return json({ name: 'master', protected: true, commit: { id: remote.target } })
    if (path.endsWith('/branches/agent%2Fflow-task')) return remote.source ? json({ name: 'agent/flow-task', commit: { id: remote.source } }) : json({}, 404)
    if (path.includes('/repository/files/')) return new Response(ci)
    if (path.endsWith('/merge_requests')) return json(remote.mr ? [mr()] : [], 200, true)
    if (path.endsWith('/merge_requests/9')) return json(mr())
    if (path.endsWith('/approvals')) return json({ approved: true, approvals_left: 0 })
    if (path.endsWith('/approval_state')) return json({ rules: [{ approvals_required: 1, approved: true }] })
    if (path.endsWith('/discussions')) return json([], 200, true)
    if (path.endsWith('/pipelines/21')) return json({ id: 21, project_id: 445, sha, source: 'merge_request_event', status: remote.pipeline })
    if (path.endsWith('/jobs')) return json([{ name: 'unit', status: remote.pipeline, allow_failure: false, pipeline: { id: 21 } }], 200, true)
    if (path.endsWith('/bridges')) return json([], 200, true)
    if (path.endsWith(`/repository/commits/${sha}`)) return json({ id: sha, parent_ids: [base] })
    throw new Error('Unexpected fake GitLab endpoint')
  }
  const service = createReleaseServices(config, runtime, { fetch: fetcher, gitlabFactory: options => createGitlabTransport({ ...options, push: async request => {
    request.signal.throwIfAborted(); request.assertAuthorized(); expect(request.sha).toBe(sha); expect(request.sourceBranch).toBe('agent/flow-task'); expect(request.expectedRemoteSha).toBeUndefined()
    pushes.push(request.sha); remote.source = request.sha
    return { remoteIds: [`sha:${request.sha}`], detail: 'fake nonforce push accepted' }
  } }) }); services.push(service)
  const coordinator = createReleaseCoordinator(policy, join(stateDir, 'release.sqlite'), { grant: () => grant, isAuthorized: owner => owner === 'owner', activeDeadline: () => grant.expiresAt, candidate: (_id, repository, sha) => receipts.candidate(task, repository, sha) }, service.transport); coordinators.push(coordinator)
  const execute = (action: ReleaseAction) => coordinator.execute({ taskId: task.id, repository: 'app', action, sha, ...(action === 'create_mr' ? { title: 'Fixture approved change', description: 'Offline composed-flow test.' } : {}) }, signal())
  return { root, config, grant, task, receipts, receiptId, sha, base, treeSha, runtime, remote, calls, pushes, coordinator, execute }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close()
  for (const service of services.splice(0)) await service.close()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-release-flow-')) throw new Error(`Unsafe fixture cleanup ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})
async function throughMr(f: ReturnType<typeof fixture>) {
  const push = await f.execute('push'); expect(push.status).toBe('accepted')
  expect(await f.coordinator.reconcile(push.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
  const mr = await f.execute('create_mr'); expect(mr.status).toBe('accepted')
  expect(await f.coordinator.reconcile(mr.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: true })
  expect((await f.execute('merge')).status).toBe('blocked')
  f.remote.pipeline = 'success'
  expect(await f.coordinator.reconcile(mr.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
  return { push, mr }
}

describe('actual release composition with isolated fake endpoints', { timeout: 30_000 }, () => {
  it('completes receipted push → signed MR → exact CI → FF merge → existing webhook deployment without a duplicate trigger', async () => {
    const f = fixture(), { push, mr } = await throughMr(f)
    const match = /<!-- superagent-deploy-v1\n([\s\S]*?)\n-->/.exec(f.remote.description)
    expect(match).not.toBeNull()
    const tickets = JSON.parse(match![1]!)
    expect(tickets[0].payload).toMatchObject({ operationId: mr.operationId, sourceSha: f.sha, taskId: f.task.id, projectId: 445, jobs: [JOB], environment: 'test' })
    const validated = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', pythonValidate, gate], { encoding: 'utf8', input: JSON.stringify({ tickets, key: KEY.toString('hex'), now: new Date().toISOString() }), timeout: 10_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }))
    expect(validated[0]).toMatchObject({ valid: true, admissionOnly: true, postAdmissionCancellation: false })
    const merge = await f.execute('merge'); expect(merge).toMatchObject({ status: 'accepted', remoteActive: true })
    expect(await f.coordinator.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'accepted', remoteActive: true })
    const deploy = await f.execute('deploy')
    expect(deploy).toMatchObject({ status: 'accepted', remoteActive: true, remoteIds: [`${JOB}:queue:901`] })
    expect(await f.execute('deploy')).toEqual(deploy)
    f.remote.deployment = 'succeeded'
    expect(await f.coordinator.reconcile(deploy.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(await f.coordinator.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(f.coordinator.operations().map(operation => [operation.action, operation.state])).toEqual([['push', 'succeeded'], ['create_mr', 'succeeded'], ['merge', 'succeeded'], ['deploy', 'succeeded']])
    expect(f.coordinator.remoteActive()).toBe(false)
    expect(f.pushes).toEqual([f.sha])
    expect(f.calls.filter(call => call.method !== 'GET')).toEqual([
      expect.objectContaining({ origin: GITLAB, method: 'POST', path: '/api/v4/projects/445/merge_requests' }),
      expect.objectContaining({ origin: GITLAB, method: 'PUT', path: '/api/v4/projects/445/merge_requests/9/merge' }),
    ])
    expect(f.calls.filter(call => call.origin === JENKINS).every(call => call.method === 'GET')).toBe(true)
    expect((await f.receipts.candidate(f.task, 'app', f.sha)).commitReceiptId).toBe(f.receiptId)
    expect(await f.execute('push')).toMatchObject({ operationId: push.operationId, status: 'succeeded' })
  })

  it('keeps postmerge no-build and partial sibling gaps accepted/active, grows pinned IDs monotonically and completes without resend', async () => {
    const f = fixture(true); await throughMr(f)
    f.remote.buildVisible = false; f.remote.siblingVisible = false
    const merge = await f.execute('merge'); expect(merge.status).toBe('accepted')
    expect(await f.coordinator.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'accepted', remoteActive: true })
    expect((await f.execute('deploy')).status).toBe('blocked')
    f.remote.buildVisible = true
    expect(await f.coordinator.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'accepted', remoteActive: true })
    expect((await f.execute('deploy')).status).toBe('blocked')
    f.remote.siblingVisible = true
    expect(await f.coordinator.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'accepted', remoteActive: true })
    const deploy = await f.execute('deploy'); expect(deploy).toMatchObject({ status: 'accepted', remoteActive: true, remoteIds: ['test/app:queue:901', 'test/worker:queue:902'] })
    f.remote.deployment = 'succeeded'
    expect(await f.coordinator.reconcile(deploy.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(await f.coordinator.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(f.coordinator.operations().every(operation => operation.state === 'succeeded')).toBe(true)
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(2)
    expect(f.pushes).toHaveLength(1)
  })

  it('keeps a tampered signed MR unknown without merging or retriggering any remote action', async () => {
    const f = fixture(); await throughMr(f)
    const match = /<!-- superagent-deploy-v1\n([\s\S]*?)\n-->/.exec(f.remote.description)!, parsed = JSON.parse(match[1]!)
    parsed[0].signature = '0'.repeat(64)
    f.remote.description = f.remote.description.replace(match[1]!, JSON.stringify(parsed))
    const merge = await f.execute('merge')
    expect(merge).toMatchObject({ status: 'unknown', remoteActive: true })
    expect(await f.execute('merge')).toEqual(merge)
    expect(f.remote.merged).toBe(false)
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(1)
    expect(f.calls.some(call => call.origin === JENKINS && call.method !== 'GET')).toBe(false)
    expect(f.pushes).toHaveLength(1)
  })
})
