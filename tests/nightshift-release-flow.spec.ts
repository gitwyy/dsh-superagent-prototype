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
import { createMergeObjects, type MergeGitRunner } from '../src/nightshift/release/merge-objects.ts'
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
 p=ticket['payload'];extra={} if p['version']==1 else dict(approved_source_sha=p['sourceSha'],target_sha=p['targetSha'],tree_sha=p['expectedTreeSha'],parents=(p['targetSha'],p['sourceSha']),verification_source_sha=data['mergedSha'],verification_profile='full-verify',verification_passed=True)
 ctx=g.GateContext(job=p['jobs'][0],build_id='fixture-build-57',source_sha=p['sourceSha'] if p['version']==1 else data['mergedSha'],project_id=p['projectId'],destination_id=p['destinationId'],environment=p['environment'],key_id=p['keyId'],**extra)
 out.append(g.validate(ticket,bytes.fromhex(data['key']),ctx,datetime.fromisoformat(data['now'].replace('Z','+00:00'))))
print(json.dumps(out))
`
function fixture(siblings = false, ordinary = false) {
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
  let target = base, expectedTree = treeSha, mergedSha = sha
  if (ordinary) {
    git('checkout', '-q', 'master'); writeFileSync(join(repo, 'TARGET.txt'), 'independent target change\n'); git('add', '--', 'TARGET.txt'); git('commit', '-qm', 'disposable divergent target')
    target = git('rev-parse', 'HEAD'); expectedTree = git('merge-tree', '--write-tree', target, sha).split('\n')[0]!
    mergedSha = git('commit-tree', expectedTree, '-p', target, '-p', sha, '-m', 'disposable ordinary merged result')
    git('checkout', '-q', 'agent/flow-task')
  }
  const gitCredential = join(root, 'git-credential.json'), jenkinsCredential = join(root, 'jenkins-credential.json')
  writeFileSync(gitCredential, JSON.stringify({ token: 'offline-token-never-live', userId: 71, username: 'project_bot', projectId: 445, expiresAt: future() }), { mode: 0o600 })
  writeFileSync(jenkinsCredential, JSON.stringify({ username: 'reader', token: 'offline-jenkins-token', expiresAt: future() }), { mode: 0o600 })
  const runtime = { keyId: 'fixture-key', keyFile: join(root, 'key.bin'), ticketDir: join(root, 'tickets'), attestationFile: join(root, 'attestation.json') }
  writeFileSync(runtime.keyFile, KEY, { mode: 0o600 })
  const policy: ReleasePolicy = { version: 1, enabled: true, maxGrantSeconds: 3600, freezeWindows: [], repositories: { app: { alias: 'app', root: repo, projectId: 445, projectPath: 'payment/refactor/app', host: 'gitlab.fixture.invalid', apiOrigin: GITLAB, expectedUserId: 71, expectedUsername: 'project_bot', credentialFile: gitCredential, targetBranch: 'master', ciSha256: ciHash, requiredJobs: ['unit'], mergeTriggersDeploy: true, pushHasNoRemoteJobs: true,
    triggerPolicy: { reviewedAt: future(-2000), expiresAt: future(), productionExcluded: true, fingerprint: 'reviewed-ci' }, environments: { test: { kind: 'jenkins', id: 'test-route', jobs: [JOB], origin: JENKINS, expectedConfigSha256: { [JOB]: jobHash }, destinationId: 'test:namespace:app', remoteDeadlineEnforced: true, credentialRef: jenkinsCredential } } } } }
  if (ordinary) policy.repositories.app!.mergeMode = 'merge-commit'
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
  const remote = { source: undefined as string | undefined, target, mr: false, description: '', merged: false, pipeline: 'missing', deployment: 'absent', queueId: 901, number: 57, timestamp: Date.now(), tamperMetadata: false, buildVisible: true, siblingVisible: true }
  const calls: { origin: string; method: string; path: string; body?: Record<string, unknown> }[] = [], pushes: string[] = []
  const mr = () => ({ iid: 9, source_project_id: 445, target_project_id: 445, source_branch: 'agent/flow-task', target_branch: 'master', author: { id: 71 }, sha, state: remote.merged ? 'merged' : 'opened', description: remote.description, draft: false, has_conflicts: false, detailed_merge_status: 'mergeable', squash: false, squash_on_merge: false, merge_when_pipeline_succeeds: false, ...(remote.pipeline === 'missing' ? {} : { head_pipeline: { id: 21 } }), ...(remote.merged ? { merge_commit_sha: remote.target } : {}) })
  const release = () => ({ source_instance: GITLAB, source: ordinary && remote.merged ? remote.target : sha, project: '445', ref: 'refs/heads/master', mode: 'master-auto', jenkins_url: `${JENKINS}/`, jenkins_job: JOB, jenkins_build: String(remote.number), target: { namespace: 'test', deployment: 'app' }, result: 'ready', image: `registry.fixture.invalid/app@sha256:${imageHash}`, before_image: 'registry.fixture.invalid/app:before', generation: 7, pods: ['app-fixture-pod'], health_basis: 'fixture exact runtime proof' })
  const build = () => ({ number: remote.number, queueId: remote.queueId, timestamp: remote.timestamp, building: remote.deployment === 'running', result: remote.deployment === 'running' ? null : 'SUCCESS', actions: [{ parameters: [{ name: 'branch', value: ordinary && remote.merged ? remote.target : sha }] }, { lastBuiltRevision: { SHA1: ordinary && remote.merged ? remote.target : sha } }] })
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
        if (ordinary && path === `${prefix}/${number}/artifact/jenkins-evidence/nightshift-merge-verification.json`) return json({ version: 2, sourceSha: sha, deployedSha: remote.target, targetSha: target, treeSha: expectedTree, parents: [target, sha], profile: 'full-verify', passed: true })
        if (ordinary && path === `${prefix}/${number}/artifact/jenkins-evidence/test-audit.json`) return json({ tests: 3, skipped: 0, failures: 0, errors: 0, core_executed: 3, reason: null })
      }
      throw new Error('Unexpected fake Jenkins endpoint')
    }
    expect(url.origin).toBe(GITLAB); expect(new Headers(init?.headers).get('PRIVATE-TOKEN')).toBe('offline-token-never-live')
    if (method === 'POST' && path === '/api/v4/projects/445/merge_requests') {
      expect(remote.mr).toBe(false); remote.mr = true; remote.description = String(body!.description)
      return json({ iid: 9 })
    }
    if (ordinary && method === 'PUT' && path === '/api/v4/projects/445/merge_requests/9') { remote.description = String(body!.description); return json(mr()) }
    if (method === 'PUT' && path === '/api/v4/projects/445/merge_requests/9/merge') {
      expect(body).toMatchObject({ sha, squash: false, merge_when_pipeline_succeeds: false }); remote.merged = true; remote.target = mergedSha; remote.deployment = 'running'; remote.timestamp = Date.now()
      return json(mr())
    }
    expect(method).toBe('GET')
    if (path === '/api/v4/user') return json({ id: 71, username: 'project_bot', state: 'active' })
    if (path === '/api/v4/projects/445') return json({ id: 445, path_with_namespace: 'payment/refactor/app', default_branch: 'master', archived: false, only_allow_merge_if_pipeline_succeeds: true, merge_method: ordinary ? 'merge' : 'ff', squash_option: 'never' })
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
    if (path.includes('/repository/commits/')) { const id = path.split('/').at(-1)!; return json({ id, parent_ids: git('rev-list', '--parents', '-n', '1', id).split(' ').slice(1) }) }
    throw new Error('Unexpected fake GitLab endpoint')
  }
  const objectCalls: string[][] = []
  const objectGit: MergeGitRunner = async (args, options) => {
    options.signal.throwIfAborted(); objectCalls.push([...args])
    let argv = [...args], env = options.env
    if (args.includes('fetch') || args.includes('ls-remote')) {
      const endpoint = `${GITLAB}/payment/refactor/app.git`; expect(args).toContain(endpoint)
      if (args.includes('ls-remote')) return { code: 0, stdout: `${sha}\trefs/heads/agent/flow-task\n${remote.target}\trefs/heads/master\n` }
      argv = argv.map(value => value === endpoint ? repo : value)
      argv.splice(argv.indexOf('fetch'), 0, '-c', 'protocol.file.allow=always'); env = { ...env, GIT_ALLOW_PROTOCOL: 'file' }
    }
    return { code: 0, stdout: execFileSync('/usr/bin/git', argv, { cwd: options.cwd, env, timeout: 10_000 }) }
  }
  const service = createReleaseServices(config, runtime, { fetch: fetcher, gitlabFactory: options => createGitlabTransport({ ...options,
    ...(ordinary ? { mergeObjects: createMergeObjects({ tempRoot: options.tempRoot, runGit: objectGit }) } : {}), push: async request => {
    request.signal.throwIfAborted(); request.assertAuthorized(); expect(request.sha).toBe(sha); expect(request.sourceBranch).toBe('agent/flow-task'); expect(request.expectedRemoteSha).toBeUndefined()
    pushes.push(request.sha); remote.source = request.sha
    return { remoteIds: [`sha:${request.sha}`], detail: 'fake nonforce push accepted' }
  } }) }); services.push(service)
  const coordinator = createReleaseCoordinator(policy, join(stateDir, 'release.sqlite'), { grant: () => grant, isAuthorized: owner => owner === 'owner', activeDeadline: () => grant.expiresAt, candidate: (_id, repository, sha) => receipts.candidate(task, repository, sha) }, service.transport); coordinators.push(coordinator)
  const execute = (action: ReleaseAction) => coordinator.execute({ taskId: task.id, repository: 'app', action, sha, ...(action === 'create_mr' ? { title: 'Fixture approved change', description: 'Offline composed-flow test.' } : {}) }, signal())
  return { root, config, grant, task, receipts, receiptId, sha, base, treeSha, target, expectedTree, mergedSha, objectCalls, git, runtime, remote, calls, pushes, coordinator, execute }
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

  it('composes a genuine divergent ordinary merge with real merge-tree planning, signed v2 metadata, M full verification and no Jenkins write', async () => {
    const f = fixture(false, true); await throughMr(f)
    expect(f.target).not.toBe(f.base); expect(f.mergedSha).not.toBe(f.sha); expect(f.expectedTree).not.toBe(f.treeSha)
    expect(f.remote.description).not.toContain('superagent-deploy-v1')
    const prep = await f.coordinator.prepareMerge({ taskId: f.task.id, repository: 'app', sha: f.sha }, signal())
    expect(prep.status).toBe('accepted')
    expect(await f.coordinator.reconcile(prep.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    const plan = f.coordinator.operations().find(operation => operation.id === prep.operationId)!.mergePlan!
    expect(plan).toMatchObject({ sourceSha: f.sha, targetSha: f.target, expectedTreeSha: f.expectedTree, validationProfile: 'full-verify' })
    expect(f.objectCalls.some(args => args.includes('merge-tree'))).toBe(true)
    const metadata = /<!-- superagent-deploy-v1\n([\s\S]*?)\n-->/.exec(f.remote.description)!, tickets = JSON.parse(metadata[1]!)
    expect(tickets[0].payload).toMatchObject({ version: 2, sourceSha: f.sha, targetSha: f.target, expectedTreeSha: f.expectedTree, operationId: prep.operationId, validationProfile: 'full-verify' })
    const valid = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', pythonValidate, gate], { encoding: 'utf8', input: JSON.stringify({ tickets, mergedSha: f.mergedSha, key: KEY.toString('hex'), now: new Date().toISOString() }), timeout: 10_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }))
    expect(valid[0]).toMatchObject({ valid: true, deployedSha: f.mergedSha, approvedSourceSha: f.sha, admissionOnly: true })
    const merge = await f.execute('merge'); expect(merge.status).toBe('accepted')
    expect(await f.coordinator.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'accepted', remoteActive: true })
    const deploy = await f.execute('deploy'); expect(deploy.status).toBe('accepted')
    f.remote.deployment = 'succeeded'
    expect(await f.coordinator.reconcile(deploy.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(await f.coordinator.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(f.coordinator.operations().every(operation => operation.state === 'succeeded')).toBe(true)
    expect(f.calls.filter(call => call.method !== 'GET').map(call => [call.method, call.path])).toEqual([
      ['POST', '/api/v4/projects/445/merge_requests'], ['PUT', '/api/v4/projects/445/merge_requests/9'], ['PUT', '/api/v4/projects/445/merge_requests/9/merge'],
    ])
    expect(f.pushes).toEqual([f.sha]); expect(f.calls.filter(call => call.origin === JENKINS).every(call => call.method === 'GET')).toBe(true)
    expect(f.git('rev-parse', 'HEAD')).toBe(f.sha); expect(f.git('status', '--porcelain')).toBe('')
  })

  it('does not refresh stale ordinary preparation or approve a postmerge target-parent race', async () => {
    const f = fixture(false, true); await throughMr(f)
    const prep = await f.coordinator.prepareMerge({ taskId: f.task.id, repository: 'app', sha: f.sha }, signal()); expect(prep.status).toBe('accepted')
    expect((await f.coordinator.reconcile(prep.operationId!, signal())).status).toBe('succeeded')
    f.remote.target = f.base
    expect((await f.execute('merge')).status).toBe('blocked')
    expect((await f.coordinator.prepareMerge({ taskId: f.task.id, repository: 'app', sha: f.sha }, signal())).operationId).toBe(prep.operationId)
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(2)
    f.remote.target = f.target
    const merge = await f.execute('merge'); expect(merge.status).toBe('accepted')
    const wrong = f.git('commit-tree', f.expectedTree, '-p', f.base, '-p', f.sha, '-m', 'fixture raced server merge')
    f.remote.target = wrong; f.remote.deployment = 'succeeded'
    expect(await f.coordinator.reconcile(merge.operationId!, signal())).toMatchObject({ status: 'unknown', remoteActive: true })
    expect((await f.execute('deploy')).status).toBe('blocked')
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(3)
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
