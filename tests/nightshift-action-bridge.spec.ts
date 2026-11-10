import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startActionBridge, type ActionBridge, type ActionBridgeOptions, type HostCommitReceipt } from '../src/nightshift/release/action-bridge.ts'
import type { RunRequest } from '../src/nightshift/contracts.ts'

const roots: string[] = []
const bridges: ActionBridge[] = []
const expectedUncertainty = new Map<ActionBridge, { code: string; writerStopped: boolean; remoteActive?: boolean }>()
async function removeRetainedSocket(bridge: ActionBridge) {
  const directory = dirname(bridge.socketPath)
  if (dirname(directory) !== await realpath('/tmp') || !directory.split('/').at(-1)?.startsWith('dsh-ns-') || await realpath(directory) !== directory) throw new Error('Unsafe recovery fixture cleanup')
  await rm(directory, { recursive: true, force: false })
}
const exec = promisify(execFile)
const guardPath = fileURLToPath(new URL('../resources/nightshift-guard.mjs', import.meta.url))
afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    const expected = expectedUncertainty.get(bridge)
    if (expected) { await expect(bridge.close()).rejects.toMatchObject(expected); await removeRetainedSocket(bridge) }
    else await bridge.close()
  }
  expectedUncertainty.clear()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== await realpath(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-bridge-test-') || await realpath(root) !== root) throw new Error('Unsafe test cleanup')
    await rm(root, { recursive: true, force: false })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'nightshift-bridge-test-'))); roots.push(root)
  const workspace = resolve(root, 'workspace'); const repo = resolve(workspace, 'app'); const stateDir = resolve(root, 'state'); const piHome = resolve(root, 'pi-home')
  await mkdir(repo, { recursive: true }); await mkdir(stateDir); await mkdir(piHome)
  await exec('/usr/bin/git', ['init', '-q', '-b', 'sdd/task', repo], { env: { PATH: '/usr/bin:/bin', HOME: piHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  const request: RunRequest = { runId: 'run-test', deadline: new Date(Date.now() + 60_000).toISOString(), config: { enabled: true, workspace, stateDir, piHome, piExecutable: '/usr/bin/false', sessionFile: resolve(stateDir, 'session.jsonl'), repositories: { app: repo }, maxTaskSeconds: 60, freezeWindows: [] }, task: { id: 'task-test', originId: 'origin', ownerId: 'owner', text: 'test', repositories: ['app'], access: 'write', approved: true, actions: ['validate', 'commit'], actionsApproveMessageId: 'action-approval', state: 'running', createdAt: new Date().toISOString(), target: { source: 'feishu', chatId: 'dm', messageId: 'message' } } }
  const controller = new AbortController()
  const options: ActionBridgeOptions = { request, baseline: {}, guardPath, signal: controller.signal, assertAuthorized: () => {}, factories: { createGuard: () => ({ checkedPath: path => ({ path, root: repo }) }), createActions: () => ({ execute: async () => ({ outcome: 'succeeded', summary: 'private host detail', passed: true, evidence: ['secret credential path'] }) }) } }
  return { root, repo, workspace, stateDir, request, controller, options }
}
async function openBridge(options: ActionBridgeOptions) { const bridge = await startActionBridge(options); bridges.push(bridge); return bridge }
function rpc(bridge: ActionBridge, message: Record<string, unknown>, raw?: string): Promise<any> {
  return new Promise((done, reject) => {
    const socket = createConnection(bridge.socketPath); let buffer = ''
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('fixture RPC timeout')) })
    socket.on('error', reject)
    socket.on('connect', () => socket.write(raw ?? JSON.stringify({ id: 'request-1', token: bridge.token, kind: 'action', input: { action: 'validate', repository: 'app', recipe: 'check' }, ...message }) + '\n'))
    socket.on('data', chunk => { buffer += chunk.toString('utf8') })
    socket.on('end', () => { try { done(buffer ? JSON.parse(buffer) : undefined) } catch (error) { reject(error) } })
    socket.on('close', () => { if (!buffer) done(undefined) })
  })
}

 describe('host-owned Unix action bridge', { timeout: 15_000 }, () => {
  it('uses a short private socket and never exposes host policy or raw broker output', async () => {
    const f = await fixture(); let seen: Record<string, unknown> | undefined
    f.options.factories!.createActions = policy => { seen = policy; return { execute: async () => ({ outcome: 'failed', passed: false, exitCode: 3, summary: '/host/credentials SECRET', evidence: ['SECRET'] }) } }
    const bridge = await openBridge(f.options)
    expect(Buffer.byteLength(bridge.socketPath)).toBeLessThan(104)
    expect((await lstat(dirname(bridge.socketPath))).mode & 0o777).toBe(0o700)
    expect((await lstat(bridge.socketPath)).mode & 0o777).toBe(0o600)
    const out = await rpc(bridge, {})
    expect(out).toMatchObject({ id: 'request-1', ok: true, result: { outcome: 'failed', passed: false, exitCode: 3 } })
    expect(JSON.stringify(out)).not.toContain('SECRET'); expect(JSON.stringify(out)).not.toContain('credentials')
    expect(seen).toMatchObject({ taskId: 'task-test', runId: 'run-test', actionApprovalId: 'action-approval', repositoryMap: { app: f.repo } })
    expect(seen).not.toHaveProperty('releasePolicy')
  })
  it('imports only the explicitly trusted resource module pair by default', async () => {
    const f = await fixture(); delete f.options.factories
    const bridge = await openBridge(f.options)
    expect((await rpc(bridge, {})).result.outcome).toBe('blocked')
    const copiedGuard = resolve(f.workspace, 'evil.mjs'); await writeFile(copiedGuard, 'throw new Error("must not import")')
    f.options.guardPath = copiedGuard
    await expect(startActionBridge(f.options)).rejects.toThrow()
  })
  it('rejects wrong token, spoofed policy, extra fields and out-of-scope repository', async () => {
    const f = await fixture(); let executions = 0
    f.options.factories!.createActions = () => ({ execute: async () => { executions++; return { outcome: 'succeeded' } } })
    const bridge = await openBridge(f.options)
    expect((await rpc(bridge, { token: '0'.repeat(64) })).ok).toBe(false)
    expect((await rpc(bridge, { policy: { approved: true } })).ok).toBe(false)
    expect((await rpc(bridge, { input: { action: 'validate', repository: 'outside', recipe: 'check' } })).ok).toBe(false)
    expect((await rpc(bridge, { input: { action: 'validate', repository: 'app', executable: '/bin/sh' } })).ok).toBe(false)
    expect(executions).toBe(0)
  })
  it('uses LF-only framing and rejects extra records or oversized frames', async () => {
    const f = await fixture(); const bridge = await openBridge(f.options)
    const message = { id: 'unicode', token: bridge.token, kind: 'action', input: { action: 'validate', repository: 'app', recipe: 'check', description: 'a\u2028b\u2029c' } }
    expect((await rpc(bridge, {}, JSON.stringify(message) + '\n')).ok).toBe(true)
    expect(await rpc(bridge, {}, JSON.stringify({ ...message, id: 'extra' }) + '\n{}\n')).toBeUndefined()
    expect(await rpc(bridge, {}, 'x'.repeat(17 * 1024))).toBeUndefined()
  })
  it('rejects malformed frames and times out an incomplete request without broker execution', async () => {
    const f = await fixture(); let executions = 0; f.options.readTimeoutMs = 20
    f.options.factories!.createActions = () => ({ execute: async () => { executions++; return { outcome: 'succeeded' } } })
    const bridge = await openBridge(f.options)
    expect((await rpc(bridge, {}, 'not-json\n')).error).toContain('Invalid')
    expect(await rpc(bridge, {}, '{"id":"unfinished"')).toBeUndefined()
    expect(executions).toBe(0)
  })
  it('rejects simultaneous action requests rather than queueing a second writer', async () => {
    const f = await fixture(); let finish!: () => void; let started!: () => void
    const entered = new Promise<void>(done => { started = done })
    f.options.factories!.createActions = () => ({ execute: async () => { started(); await new Promise<void>(done => { finish = done }); return { outcome: 'succeeded' } } })
    const bridge = await openBridge(f.options)
    const first = rpc(bridge, { id: 'first' }); await entered
    expect((await rpc(bridge, { id: 'second' })).error).toContain('concurrent')
    finish(); expect((await first).ok).toBe(true)
    expect((await rpc(bridge, { id: 'first' })).error).toContain('Duplicate')
  })
  it('rechecks live host authorization passed into the action broker after awaits', async () => {
    const f = await fixture(); let revoked = false; let mutations = 0
    f.options.assertAuthorized = () => { if (revoked) throw new Error('private authorization detail') }
    f.options.factories!.createActions = (_policy, _guard, callbacks) => ({ execute: async () => { await Promise.resolve(); revoked = true; callbacks.assertAuthorized(); mutations++; return { outcome: 'succeeded' } } })
    const bridge = await openBridge(f.options)
    expectedUncertainty.set(bridge, { code: 'NIGHTSHIFT_ACTION_UNKNOWN', writerStopped: true })
    expect((await rpc(bridge, {})).result.outcome).not.toBe('succeeded')
    expect(mutations).toBe(0)
  })
  it('close aborts active work and waits for settlement before resolving and deleting the socket', async () => {
    const f = await fixture(); let finish!: () => void; let activeSignal!: AbortSignal; let entered!: () => void
    const started = new Promise<void>(done => { entered = done })
    f.options.factories!.createActions = () => ({ execute: async (_input, signal) => { activeSignal = signal; entered(); await new Promise<void>(done => { finish = done }); return { outcome: 'failed', passed: false } } })
    const bridge = await openBridge(f.options); const response = rpc(bridge, {}); await started
    let closed = false; const closing = bridge.close().then(() => { closed = true })
    await Promise.resolve(); await Promise.resolve()
    expect(activeSignal.aborted).toBe(true); expect(closed).toBe(false)
    finish(); await closing; await response
    await expect(lstat(bridge.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await bridge.close()
  })
  it('latches uncertain host writer state and refuses successful close or namespace cleanup', async () => {
    const f = await fixture()
    f.options.factories!.createActions = () => ({ execute: async () => { throw Object.assign(new Error('private stderr'), { code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false, pgid: 1234567 }) } })
    const bridge = await startActionBridge(f.options) // uncertainty deliberately needs manual fixture cleanup
    const directory = dirname(bridge.socketPath)
    try {
      const out = await rpc(bridge, {})
      expect(out.result).toMatchObject({ outcome: 'unknown', writerStopped: false })
      expect((await rpc(bridge, { id: 'after-unknown' })).ok).toBe(false)
      await expect(bridge.close()).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false, pgid: 1234567 })
      await expect(bridge.close()).rejects.toMatchObject({ writerStopped: false })
      expect((await lstat(directory)).isDirectory()).toBe(true)
      const record = (await readdir(f.stateDir)).find(name => name.startsWith('bridge-unknown-'))!
      expect(JSON.parse(await readFile(resolve(f.stateDir, record), 'utf8'))).toMatchObject({ runId: 'run-test', pgid: 1234567, writerStopped: false })
    } finally {
      // Test-only manual reconciliation: no child was spawned by this injected broker.
      if (dirname(directory) !== await realpath('/tmp') || !directory.split('/').at(-1)?.startsWith('dsh-ns-') || await realpath(directory) !== directory) throw new Error('Unsafe recovery fixture cleanup')
      await rm(directory, { recursive: true, force: false })
    }
  })
  it.each([{ outcome: 'unknown' }, { unexpected: 'malformed' }, { outcome: 'blocked', passed: true }])('retains local uncertainty despite a lost socket response: %j', async result => {
    const f = await fixture(); let entered!: () => void; let finish!: () => void
    const started = new Promise<void>(done => { entered = done })
    f.options.factories!.createActions = () => ({ execute: async () => { entered(); await new Promise<void>(done => { finish = done }); return result } })
    const bridge = await openBridge(f.options)
    expectedUncertainty.set(bridge, { code: 'NIGHTSHIFT_ACTION_UNKNOWN', writerStopped: true })
    const socket = createConnection(bridge.socketPath); socket.on('error', () => {})
    await new Promise<void>(done => socket.once('connect', done))
    socket.write(JSON.stringify({ id: 'lost', token: bridge.token, kind: 'action', input: { action: 'validate', repository: 'app', recipe: 'check' } }) + '\n')
    await started; socket.destroy(); finish()
    await expect(bridge.close()).rejects.toMatchObject({ code: 'NIGHTSHIFT_ACTION_UNKNOWN', writerStopped: true })
    const files = (await readdir(f.stateDir)).filter(name => name.startsWith('bridge-unknown-'))
    expect(files).toHaveLength(1)
    expect(JSON.parse(await readFile(resolve(f.stateDir, files[0]!), 'utf8'))).toMatchObject({ taskId: 'task-test', runId: 'run-test', code: 'NIGHTSHIFT_ACTION_UNKNOWN', writerStopped: true, remoteActive: false })
  })
  it('latches malformed unjournaled releases but preserves coordinator ownership for valid journaled uncertainty', async () => {
    const f = await fixture(); f.options.release = async () => ({ status: 'unknown' } as never)
    const bridge = await openBridge(f.options)
    expectedUncertainty.set(bridge, { code: 'NIGHTSHIFT_RELEASE_UNKNOWN', writerStopped: true, remoteActive: true })
    expect((await rpc(bridge, { kind: 'release', input: { action: 'merge', repository: 'app', sha: 'a'.repeat(40) } })).result).toMatchObject({ status: 'unknown', remoteActive: true })
    expect((await rpc(bridge, { id: 'denied-after' })).ok).toBe(false)
    const other = await fixture()
    other.options.release = async () => ({ status: 'unknown', operationId: 'op-1', remoteActive: true, remoteIds: ['mr:451:9'], detail: 'private host details' })
    const journaled = await openBridge(other.options)
    expect((await rpc(journaled, { kind: 'release', input: { action: 'merge', repository: 'app', sha: 'a'.repeat(40) } })).result).toMatchObject({ status: 'unknown', operationId: 'op-1', remoteActive: true })
    await journaled.close() // coordinator journal, not the socket response, retains remote ownership
  })
  it('treats release exceptions as unknown remote activity, without leaking exception details', async () => {
    const f = await fixture(); f.options.release = async () => { throw new Error('token=HOST_SECRET /host/credential.json') }
    const bridge = await openBridge(f.options)
    expectedUncertainty.set(bridge, { code: 'NIGHTSHIFT_RELEASE_UNKNOWN', writerStopped: true, remoteActive: true })
    const out = await rpc(bridge, { kind: 'release', input: { action: 'push', repository: 'app', sha: 'a'.repeat(40) } })
    expect(out.result).toMatchObject({ status: 'unknown', remoteActive: true, remoteIds: [] })
    expect(JSON.stringify(out)).not.toContain('HOST_SECRET')
  })
  it('rejects commit without durable host receipt persistence', async () => {
    const f = await fixture(); let calls = 0
    f.options.factories!.createActions = () => ({ execute: async () => { calls++; return { outcome: 'succeeded' } } })
    const bridge = await openBridge(f.options)
    expect((await rpc(bridge, { input: { action: 'commit', repository: 'app', message: 'approved fix' } })).result.outcome).toBe('blocked')
    expect(calls).toBe(0)
  })
  it('cannot report commit success without invoking durable host receipt persistence', async () => {
    const f = await fixture(); f.options.onCommit = () => {}
    f.options.factories!.createActions = () => ({ execute: async () => ({ outcome: 'succeeded', head: 'a'.repeat(40) }) })
    const bridge = await openBridge(f.options)
    expectedUncertainty.set(bridge, { code: 'NIGHTSHIFT_ACTION_UNKNOWN', writerStopped: true })
    expect((await rpc(bridge, { input: { action: 'commit', repository: 'app', message: 'fix' } })).result.outcome).toBe('unknown')
  })
  it('enriches only host callback commit evidence with verified Git tree and run/task identity', async () => {
    const f = await fixture()
    const env = { PATH: '/usr/bin:/bin', HOME: f.stateDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = async (args: string[], input?: string) => {
      if (input === undefined) return (await exec('/usr/bin/git', ['-C', f.repo, ...args], { env })).stdout.trim()
      const { spawn } = await import('node:child_process')
      return new Promise<string>((done, reject) => { const child = spawn('/usr/bin/git', ['-C', f.repo, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }); let value = ''; child.stdout.on('data', chunk => { value += chunk }); child.stderr.resume(); child.on('error', reject); child.on('close', code => code === 0 ? done(value.trim()) : reject(new Error('fixture Git failed'))); child.stdin.end(input) })
    }
    const tree = await git(['mktree'], '')
    const parent = await git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor Fixture <fixture@invalid> 1 +0000\ncommitter Fixture <fixture@invalid> 1 +0000\n\nparent\n`)
    const head = await git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@invalid> 2 +0000\ncommitter Fixture <fixture@invalid> 2 +0000\n\nchild\n`)
    await git(['update-ref', 'refs/heads/sdd/task', head])
    let saved: HostCommitReceipt | undefined
    f.options.onCommit = receipt => { saved = receipt }
    f.options.factories!.createActions = (_policy, _guard, callbacks) => ({ execute: async () => { await callbacks.onCommit({ repository: 'app', head, parent, branch: 'sdd/task', sourceDigest: 'c'.repeat(64), validationIds: ['validated-1'], recipePins: { check: 'd'.repeat(64) } }); return { outcome: 'succeeded', head } } })
    const bridge = await openBridge(f.options)
    const out = await rpc(bridge, { input: { action: 'commit', repository: 'app', message: 'approved fix' } })
    expect(out.result).toMatchObject({ outcome: 'succeeded', head })
    expect(saved).toMatchObject({ taskId: 'task-test', runId: 'run-test', repository: 'app', root: f.repo, head, parent, treeSha: tree, branch: 'sdd/task', validationIds: ['validated-1'] })
    expect(JSON.stringify(out)).not.toContain(f.repo)
    f.options.onCommit = async () => { throw new Error('disk full /host/secret') }
    // Even a misbehaving broker that swallows callback errors cannot clear host uncertainty.
    f.options.factories!.createActions = (_policy, _guard, callbacks) => ({ execute: async () => {
      try { await callbacks.onCommit({ repository: 'app', head, parent, branch: 'sdd/task', sourceDigest: 'c'.repeat(64), validationIds: ['validated-1'], recipePins: { check: 'd'.repeat(64) } }) } catch { /* simulated downgrade */ }
      return { outcome: 'blocked' }
    } })
    const failingBridge = await openBridge(f.options)
    expectedUncertainty.set(failingBridge, { code: 'NIGHTSHIFT_ACTION_UNKNOWN', writerStopped: true })
    const failure = await rpc(failingBridge, { input: { action: 'commit', repository: 'app', message: 'fix' } })
    expect(failure.result.outcome).toBe('unknown'); expect(JSON.stringify(failure)).not.toContain('/host/secret')
  })
})
