/** Managed-runner integration: real controller/host bridge, fake Pi, disposable Git only. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createController } from '../src/nightshift/controller.ts'
import { createManagedRunner, type ManagedRunner, type ManagedRunnerHost } from '../src/nightshift/release/managed-runner.ts'
import { createReleaseCoordinator, policyDigest } from '../src/nightshift/release/coordinator.ts'
import { GIT_SAFE_ARGS, workerEnvironment } from '../src/nightshift/preflight.ts'
import type { Command, Incoming, NightConfig, NightController, RunRequest } from '../src/nightshift/contracts.ts'
import type { ReleaseGrant, ReleasePolicy, ReleaseTransport, RemoteSnapshot } from '../src/nightshift/release/contracts.ts'

const roots: string[] = [], controllers: NightController[] = [], managed: ManagedRunner[] = [], children: ChildProcessWithoutNullStreams[] = []
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex')
const future = () => new Date(Date.now() + 60_000).toISOString()
let sequence = 0
function message(): Incoming { const id = `managed-${++sequence}`; return { id, actorId: 'owner', text: 'explicit test direct message', at: new Date().toISOString(), direct: true, human: true, target: { source: 'feishu', chatId: 'private', messageId: id } } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture(claimReleaseCompleted = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-managed-'))); roots.push(root)
  const workspace = join(root, 'workspace'), repo = join(workspace, 'app'), home = join(root, 'home'), stateDir = join(root, 'state')
  for (const directory of [repo, home, stateDir]) mkdirSync(directory, { recursive: true })
  const executable = join(root, 'fake-pi')
  writeFileSync(executable, `#!${process.execPath}\nconst p=JSON.parse(process.env.NIGHTSHIFT_POLICY);const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const r=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(r.type==='get_state'){emit({type:'extension_ui_request',method:'setStatus',statusKey:'nightshift-guard',statusText:p.runId+':ready'});emit({id:r.id,type:'response',success:true,data:{sessionFile:p.sessionFile,isStreaming:false,pendingMessageCount:0,model:{provider:'fake',id:'fixture'}}});}if(r.type==='prompt'){emit({id:r.id,type:'response',success:true,data:{disposition:'started'}});if(${claimReleaseCompleted}){emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'All releases successfully completed.'}]}});emit({type:'agent_settled',aborted:false});}}}});process.stdin.on('end',()=>process.exit(0));\n`)
  chmodSync(executable, 0o700)
  const script = "const fs=require('node:fs');fs.writeFileSync('validation-ran.txt','yes');process.exit(fs.readFileSync('VALUE.txt','utf8')==='after\\n'?0:3)"
  writeFileSync(join(repo, 'validate.cjs'), script); writeFileSync(join(repo, '.gitignore'), 'validation-ran.txt\n'); writeFileSync(join(repo, 'VALUE.txt'), 'before\n'); writeFileSync(join(repo, '.gitlab-ci.yml'), 'stages: [test]\n')
  const node = realpathSync(process.execPath)
  const config: NightConfig = { enabled: true, workspace, stateDir, lockRoot: join(root, 'locks'), piExecutable: executable, piHome: home, sessionFile: join(stateDir, 'session.jsonl'), repositories: { app: repo }, provider: 'fake', model: 'fixture', maxTaskSeconds: 60, freezeWindows: [], repositoryActions: { app: { author: { name: 'Managed Fixture', email: 'fixture@example.test' }, targetBranch: 'develop', requiredValidations: ['check'], validations: { check: { executable: node, executableSha256: hash(readFileSync(node)), args: ['validate.cjs'], timeoutSeconds: 5, pinnedFiles: { 'validate.cjs': hash(script) } } } } } }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', [...GIT_SAFE_ARGS, '-C', repo, ...args], { timeout: 5000, encoding: 'utf8', env: { ...workerEnvironment(config), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).trim()
  git('init', '-q', '-b', 'sdd/managed-fixture'); git('add', '.'); git('commit', '-qm', 'disposable baseline')
  const base = git('rev-parse', 'HEAD')
  const launched = deferred<{ child: ChildProcessWithoutNullStreams; policy: { hostActions: { socketPath: string; token: string }; [key: string]: unknown } }>()
  const spawnProcess = vi.fn((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args) as ChildProcessWithoutNullStreams; children.push(child)
    const options = args[2] as { env: NodeJS.ProcessEnv }
    launched.resolve({ child, policy: JSON.parse(options.env.NIGHTSHIFT_POLICY!) })
    return child
  }) as unknown as typeof spawn
  const options = { spawnProcess, probeWriters: async () => [], startupTimeoutMs: 15_000, shutdownGraceMs: 500, killGraceMs: 500 }
  const wrap = (host: ManagedRunnerHost, extra: Parameters<typeof createManagedRunner>[2] = {}) => { const runner = createManagedRunner(config, host, { ...options, ...extra }); managed.push(runner); return runner }
  return { root, repo, config, git, base, launched, spawnProcess, options, wrap }
}
async function runController(f: ReturnType<typeof fixture>, extra: Parameters<typeof createManagedRunner>[2] = {}) {
  let controller: NightController | undefined, allowed = true
  const runner = f.wrap({ snapshot: () => controller?.snapshot(), isAuthorized: () => allowed }, extra)
  controller = createController(f.config, runner); controllers.push(controller)
  const command = (command: Command) => controller!.handle(message(), command)
  await command({ type: 'enqueue', text: 'Fixture edits, validation and commit', repositories: ['app'], access: 'write' })
  const taskId = controller.snapshot().tasks[0]!.id
  await command({ type: 'approve', taskId })
  await command({ type: 'authorize-actions', taskId, actions: ['validate', 'commit'] })
  await command({ type: 'start', deadline: future() })
  const launch = await f.launched.promise
  return { controller, runner, command, taskId, launch, revoke: () => { allowed = false } }
}
function rpc(bridge: { socketPath: string; token: string }, input: object, kind = 'action', extra: object = {}): Promise<any> {
  return new Promise((done, reject) => {
    const socket = createConnection(bridge.socketPath); let output = ''
    socket.setTimeout(4000, () => { socket.destroy(); reject(new Error('Fixture bridge response timeout')) })
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id: `rpc-${++sequence}`, token: bridge.token, kind, input, ...extra }) + '\n'))
    socket.on('data', chunk => { output += chunk.toString('utf8') })
    socket.on('end', () => { try { done(JSON.parse(output)) } catch (error) { reject(error) } })
  })
}
function receiptRows(config: NightConfig) {
  const db = new DatabaseSync(join(config.stateDir, 'commit-receipts.sqlite'), { readOnly: true })
  try { return db.prepare('SELECT value FROM commit_receipts').all().map(row => JSON.parse(String(row.value))) } finally { db.close() }
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close()
  for (const runner of managed.splice(0)) await runner.close()
  for (const child of children.splice(0)) if (child.exitCode === null && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-managed-')) throw new Error(`Unsafe fixture cleanup ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('managed runner uses live controller authority and host-owned receipts', { timeout: 20_000 }, () => {
  it('denies a fabricated run when no live controller snapshot exists, before spawning Pi or validating', async () => {
    const f = fixture(), runner = f.wrap({ snapshot: () => undefined, isAuthorized: () => true })
    const request: RunRequest = { runId: 'fabricated-run', config: f.config, deadline: future(), task: { id: 'fabricated-task', originId: 'fake', ownerId: 'owner', text: 'not admitted', repositories: ['app'], access: 'write', approved: true, actions: ['validate'], actionsApproveMessageId: 'fake', state: 'running', createdAt: new Date().toISOString(), target: message().target } }
    await expect(runner.run(request, new AbortController().signal)).rejects.toThrow('authorization was revoked')
    expect(f.spawnProcess).not.toHaveBeenCalled()
    expect(existsSync(join(f.repo, 'validation-ran.txt'))).toBe(false)
    expect(receiptRows(f.config)).toEqual([])
  })

  it('validates and commits through the real bridge and persists only host-derived commit facts', async () => {
    const f = fixture(), externalCommit = vi.fn(), h = await runController(f, { onCommit: externalCommit })
    expect(h.controller.snapshot()).toMatchObject({ mode: 'NIGHT_RUNNING', activeRunId: expect.any(String) })
    expect(h.controller.snapshot().tasks[0]).toMatchObject({ id: h.taskId, state: 'running', approved: true, actions: ['validate', 'commit'] })
    const bridge = h.launch.policy.hostActions
    const forged = await rpc(bridge, { action: 'commit', repository: 'app', message: 'forged', head: 'a'.repeat(40), parent: f.base, treeSha: 'b'.repeat(40) })
    expect(forged.ok).toBe(false); expect(receiptRows(f.config)).toEqual([])
    writeFileSync(join(f.repo, 'VALUE.txt'), 'after\n') // Disposable approved source edit; never a business path.
    expect((await rpc(bridge, { action: 'validate', repository: 'app', recipe: 'check' })).result).toMatchObject({ outcome: 'succeeded', passed: true })
    const committed = await rpc(bridge, { action: 'commit', repository: 'app', message: 'test: host-managed fixture' })
    expect(committed.result).toMatchObject({ outcome: 'succeeded', head: f.git('rev-parse', 'HEAD') })
    expect(externalCommit).not.toHaveBeenCalled() // Host composition replaces caller-controlled receipt callbacks.
    const rows = receiptRows(f.config)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ taskId: h.taskId, runId: h.controller.snapshot().activeRunId, root: f.repo, repository: 'app', head: f.git('rev-parse', 'HEAD'), parent: f.base, treeSha: f.git('rev-parse', 'HEAD^{tree}'), branch: 'sdd/managed-fixture' })
    expect(rows[0].validationIds).toHaveLength(1)
    expect(rows[0].validationIds[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(f.git('status', '--porcelain')).toBe('')
    await h.controller.close(); await h.runner.close()
    expect(receiptRows(f.config)).toEqual(rows)
  })

  it('revoked host identity denies bridge actions even while the original controller task remains running', async () => {
    const f = fixture(), h = await runController(f)
    h.revoke()
    const result = await rpc(h.launch.policy.hostActions, { action: 'validate', repository: 'app', recipe: 'check' })
    expect(result.ok === false || ['blocked', 'unknown'].includes(result.result?.outcome)).toBe(true)
    expect(h.controller.snapshot().tasks[0]!.state).toBe('running')
    expect(existsSync(join(f.repo, 'validation-ran.txt'))).toBe(false)
  })

  it('controller pause revokes bridge actions before local writer shutdown has completed', async () => {
    const f = fixture(), h = await runController(f)
    await h.command({ type: 'pause' })
    expect(['HANDOFF_PENDING', 'NIGHT_PAUSED']).toContain(h.controller.snapshot().mode)
    let denied = false
    try { const result = await rpc(h.launch.policy.hostActions, { action: 'validate', repository: 'app', recipe: 'check' }); denied = result.ok === false || result.result?.outcome !== 'succeeded' }
    catch { denied = true } // Bridge already removed after verified local exit is also fail-closed.
    expect(denied).toBe(true)
    expect(existsSync(join(f.repo, 'validation-ran.txt'))).toBe(false)
  })

  it('release policy absence never calls injected external release/transport callbacks or leaks host config', async () => {
    const f = fixture(), externalRelease = vi.fn(), transport: ReleaseTransport = { observe: vi.fn(), dispatch: vi.fn() }
    const h = await runController(f, { release: externalRelease, transport })
    const result = await rpc(h.launch.policy.hostActions, { action: 'push', repository: 'app', sha: f.base }, 'release')
    expect(result.result).toMatchObject({ status: 'blocked', remoteActive: false })
    expect(externalRelease).not.toHaveBeenCalled(); expect(transport.observe).not.toHaveBeenCalled(); expect(transport.dispatch).not.toHaveBeenCalled()
    expect(h.launch.policy).not.toHaveProperty('releasePolicy')
    expect(h.launch.policy).not.toHaveProperty('repositoryActions')
    expect(h.runner.operations()).toEqual([])
    expect(await h.runner.reconcile('not-present', new AbortController().signal)).toMatchObject({ status: 'blocked', remoteActive: false })
  })

  it('refuses managed close while the live controller owns a writer', async () => {
    const f = fixture(), h = await runController(f)
    await expect(h.runner.close()).rejects.toThrow('Drain active local writer')
    await h.controller.close()
    await expect(h.runner.close()).resolves.toBeUndefined()
  })

  it('does not accept a successful model claim as completion of authorized release actions without host operations', async () => {
    const f = fixture(true), ci = hash('stages: [test]\n')
    f.config.releasePolicy = { version: 1, enabled: true, maxGrantSeconds: 3600, freezeWindows: [], repositories: { app: { alias: 'app', root: f.repo, projectId: 17, projectPath: 'mate/app', host: 'git.example.test', apiOrigin: 'https://git.example.test', expectedUserId: 9, expectedUsername: 'bot', credentialFile: join(f.root, 'not-read-secret'), targetBranch: 'develop', ciSha256: ci, requiredJobs: ['check'], mergeTriggersDeploy: false, pushHasNoRemoteJobs: true, triggerPolicy: { reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: future(), productionExcluded: true, fingerprint: 'reviewed' }, environments: {} } } }
    const transport: ReleaseTransport = { observe: vi.fn(), dispatch: vi.fn() }
    let controller: NightController | undefined
    const runner = f.wrap({ snapshot: () => controller?.snapshot(), isAuthorized: () => true }, { transport })
    const completed = deferred<Awaited<ReturnType<ManagedRunner['run']>>>()
    controller = createController(f.config, { preflight: (config, tasks) => runner.preflight(config, tasks), run: async (request, signal) => { const result = await runner.run(request, signal); completed.resolve(result); return result } }); controllers.push(controller)
    await controller.handle(message(), { type: 'enqueue', text: 'Complete authorized push and MR only with host evidence', repositories: ['app'], access: 'write' })
    const taskId = controller.snapshot().tasks[0]!.id
    await controller.handle(message(), { type: 'approve', taskId })
    await controller.handle(message(), { type: 'authorize-release', taskId, expiresAt: future(), scopes: [{ repository: 'app', sourceBranch: 'sdd/managed-fixture', targetBranch: 'develop', baseSha: f.base, actions: ['push', 'create_mr'] }] })
    expect(controller.snapshot().tasks[0]!.releaseGrant).toBeDefined()
    await controller.handle(message(), { type: 'start', deadline: future() })
    const result = await completed.promise
    expect(result).toMatchObject({ outcome: 'blocked', writerStopped: true, remoteActive: false })
    expect(result.summary).toContain('app/push'); expect(result.summary).toContain('app/create_mr')
    expect(runner.operations()).toEqual([])
    expect(transport.observe).not.toHaveBeenCalled(); expect(transport.dispatch).not.toHaveBeenCalled()
  })

  it.each(['success', 'unknown'] as const)('public merge prepares once (%s response), and ambiguous preparation needs explicit host reconciliation', async preparationResponse => {
    const f = fixture(), ci = hash('stages: [test]\n'), target = 'a'.repeat(40), resultSha = 'b'.repeat(40), resultTree = 'c'.repeat(40)
    f.config.releasePolicy = { version: 1, enabled: true, maxGrantSeconds: 3600, freezeWindows: [], repositories: { app: { alias: 'app', root: f.repo, projectId: 17, projectPath: 'mate/app', host: 'git.example.test', apiOrigin: 'https://git.example.test', expectedUserId: 9, expectedUsername: 'bot', credentialFile: join(f.root, 'not-read-secret'), targetBranch: 'develop', mergeMode: 'merge-commit', ciSha256: ci, requiredJobs: ['check'], mergeTriggersDeploy: false, triggerPolicy: { reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: future(), productionExcluded: true, fingerprint: 'reviewed' }, environments: {} } } }
    let snapshot: RemoteSnapshot | undefined
    const transport: ReleaseTransport = {
      observe: vi.fn(async () => structuredClone(snapshot!)),
      planMerge: vi.fn(async context => ({ version: 2 as const, sourceSha: context.request.sha, targetSha: target, expectedTreeSha: resultTree, ciSha256: ci, validationProfile: 'full-verify' as const })),
      dispatch: vi.fn(async context => {
        context.assertAuthorized()
        if (context.request.action === 'prepare_merge') {
          snapshot!.preparation = { plan: context.operation.mergePlan!, operationId: context.operation.id, metadataDigest: 'd'.repeat(64), expiresAt: context.deadline, verified: true }
          if (preparationResponse === 'unknown') throw new Error('lost metadata response')
        }
        if (context.request.action === 'merge') { snapshot!.targetSha = resultSha; Object.assign(snapshot!.mergeRequest!, { state: 'merged', mergeCommitSha: resultSha, mergeCommitVerified: true, mergeTreeSha: resultTree, mergeParents: [target, context.request.sha] }) }
        return { remoteIds: [`fake:${context.request.action}`], detail: 'fake accepted' }
      }),
    }
    let controller: NightController | undefined
    const runner = f.wrap({ snapshot: () => controller?.snapshot(), isAuthorized: () => true }, { transport })
    controller = createController(f.config, runner); controllers.push(controller)
    await controller.handle(message(), { type: 'enqueue', text: 'Authorized ordinary fixture merge', repositories: ['app'], access: 'write' })
    const taskId = controller.snapshot().tasks[0]!.id
    await controller.handle(message(), { type: 'approve', taskId })
    await controller.handle(message(), { type: 'authorize-actions', taskId, actions: ['validate', 'commit'] })
    await controller.handle(message(), { type: 'authorize-release', taskId, expiresAt: future(), scopes: [{ repository: 'app', sourceBranch: 'sdd/managed-fixture', targetBranch: 'develop', baseSha: f.base, actions: ['merge'] }] })
    await controller.handle(message(), { type: 'start', deadline: future() })
    const launch = await f.launched.promise
    writeFileSync(join(f.repo, 'VALUE.txt'), 'after\n')
    expect((await rpc(launch.policy.hostActions, { action: 'validate', repository: 'app', recipe: 'check' })).result.outcome).toBe('succeeded')
    const committed = await rpc(launch.policy.hostActions, { action: 'commit', repository: 'app', message: 'test: prepare merge fixture' }), sha = committed.result.head as string
    expect(committed.result.outcome).toBe('succeeded')
    snapshot = { identity: { id: 9, username: 'bot' }, project: { id: 17, path: 'mate/app', defaultBranch: 'develop', pipelineRequired: true, mergeMethod: 'merge', fastForwardOnly: false }, sourceSha: sha, targetSha: target, targetCiSha256: ci, productionExcluded: true, triggerPolicyFingerprint: 'reviewed',
      mergeRequest: { iid: 7, sourceProjectId: 17, targetProjectId: 17, sourceBranch: 'sdd/managed-fixture', targetBranch: 'develop', sha, state: 'opened', authorId: 9, draft: false, conflicts: false, mergeable: true, approved: true, unresolvedDiscussions: 0, marker: `nightshift:${taskId}:app:${sha}` },
      pipeline: { id: 1, sha, status: 'success', jobs: [{ name: 'check', status: 'success', allowFailure: false }] } }
    expect((await rpc(launch.policy.hostActions, { action: 'prepare_merge', repository: 'app', sha }, 'release')).ok).toBe(false)
    if (preparationResponse === 'unknown') {
      expect((await rpc(launch.policy.hostActions, { action: 'merge', repository: 'app', sha }, 'release')).result).toMatchObject({ status: 'unknown', remoteActive: true })
      expect(transport.dispatch).toHaveBeenCalledTimes(1)
      expect((await rpc(launch.policy.hostActions, { action: 'merge', repository: 'app', sha }, 'release')).result.status).toBe('unknown')
      expect(transport.dispatch).toHaveBeenCalledTimes(1)
      const prep = runner.operations()[0]!
      expect((await runner.reconcile(prep.id, new AbortController().signal)).status).toBe('succeeded')
    }
    expect((await rpc(launch.policy.hostActions, { action: 'merge', repository: 'app', sha }, 'release')).result).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect(runner.operations().map(operation => [operation.action, operation.state])).toEqual([['prepare_merge', 'succeeded'], ['merge', 'succeeded']])
    expect((await rpc(launch.policy.hostActions, { action: 'merge', repository: 'app', sha }, 'release')).result.status).toBe('succeeded')
    expect(transport.planMerge).toHaveBeenCalledTimes(1)
    expect(vi.mocked(transport.dispatch).mock.calls.map(([context]) => context.request.action)).toEqual(['prepare_merge', 'merge'])
  })

  it('persisted remote activity blocks preflight until read-only fake transport reconciliation proves terminal state', async () => {
    const f = fixture(), sha = 'a'.repeat(40), ci = 'b'.repeat(64)
    const policy: ReleasePolicy = { version: 1, enabled: true, maxGrantSeconds: 3600, freezeWindows: [], repositories: { app: { alias: 'app', root: f.repo, projectId: 17, projectPath: 'mate/app', host: 'git.example.test', apiOrigin: 'https://git.example.test', expectedUserId: 9, expectedUsername: 'bot', credentialFile: join(f.root, 'not-read-secret'), targetBranch: 'develop', ciSha256: ci, requiredJobs: ['check'], mergeTriggersDeploy: false, pushHasNoRemoteJobs: true, triggerPolicy: { reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: future(), productionExcluded: true, fingerprint: 'reviewed' }, environments: {} } } }
    const grant: ReleaseGrant = { id: 'remote-grant', taskId: 'prior-task', ownerId: 'owner', approvalMessageId: 'dm-release', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: future(), policyDigest: policyDigest(policy), scopes: [{ repository: 'app', sourceBranch: 'sdd/managed-fixture', targetBranch: 'develop', baseSha: f.base, actions: ['push'] }] }
    const snapshot: RemoteSnapshot = { identity: { id: 9, username: 'bot' }, project: { id: 17, path: 'mate/app', defaultBranch: 'develop', pipelineRequired: true }, targetSha: f.base, targetCiSha256: ci, productionExcluded: true, triggerPolicyFingerprint: 'reviewed' }
    const transport: ReleaseTransport = { observe: vi.fn(async () => structuredClone(snapshot)), dispatch: vi.fn(async () => ({ remoteIds: ['fake-accepted-push'], detail: 'fake remote acceptance only' })) }
    const coordinator = createReleaseCoordinator(policy, join(f.config.stateDir, 'release.sqlite'), { grant: () => grant, isAuthorized: () => true, activeDeadline: () => grant.expiresAt, candidate: async () => ({ taskId: 'prior-task', repository: 'app', sha, treeSha: 'c'.repeat(40), baseSha: f.base, sourceBranch: 'sdd/managed-fixture', clean: true, validated: true, commitReceiptId: 'fake-host-receipt', validationReceiptIds: ['fake-host-validation'], ciSha256: ci, changedProtectedPaths: [] }) }, transport)
    const accepted = await coordinator.execute({ taskId: 'prior-task', repository: 'app', action: 'push', sha }, new AbortController().signal)
    expect(accepted).toMatchObject({ status: 'accepted', remoteActive: true }); await coordinator.close()
    f.config.releasePolicy = policy
    const runner = f.wrap({ snapshot: () => undefined, isAuthorized: () => false }, { transport })
    const blocked = await runner.preflight(f.config, [])
    expect(blocked.ok).toBe(false)
    expect(blocked.problems.join(';')).toContain('Unresolved remote release/deployment')
    expect(f.spawnProcess).not.toHaveBeenCalled()
    snapshot.sourceSha = sha
    expect(await runner.reconcile(accepted.operationId!, new AbortController().signal)).toMatchObject({ status: 'succeeded', remoteActive: false })
    expect((await runner.preflight(f.config, [])).ok).toBe(true)
    expect(transport.dispatch).toHaveBeenCalledTimes(1) // Only the explicit fake seed, never managed replay.
  })
})
