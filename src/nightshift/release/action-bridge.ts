import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { RunRequest } from '../contracts.ts'
import type { ReleaseAction, ReleaseResult } from './contracts.ts'

/** Host-verified commit facts; never accepted from a socket/client message. */
export interface HostCommitReceipt {
  taskId: string; runId: string; repository: string; root: string
  head: string; parent: string; branch: string; treeSha: string; sourceDigest: string
  validationIds: string[]; recipePins: Record<string, string>
}
export interface ActionCommitFacts { repository: string; head: string; parent: string; branch: string; sourceDigest: string; validationIds: string[]; recipePins: Record<string, string> }
export interface BridgeActionInput { action: 'validate' | 'commit' | 'publish'; repository: string; recipe?: string; message?: string; title?: string; description?: string }
export interface BridgeReleaseInput { action: ReleaseAction; repository: string; sha: string; title?: string; description?: string }
interface Guard { checkedPath(path: string, write?: boolean): { path: string; root: string } }
interface ActionBroker { execute(input: BridgeActionInput, signal: AbortSignal): Promise<unknown> }
export interface ActionBridgeOptions {
  request: RunRequest
  baseline: Record<string, { head: string; branch: string }>
  guardPath: string
  signal: AbortSignal
  assertAuthorized(): void
  onCommit?(receipt: HostCommitReceipt): Promise<void> | void
  release?(input: BridgeReleaseInput, signal: AbortSignal): Promise<ReleaseResult>
  /** Dependency injection is host/test-only, never policy or socket-controlled. */
  factories?: {
    createGuard(policy: Record<string, unknown>): Guard
    createActions(policy: Record<string, unknown>, guard: Guard, callbacks: { assertAuthorized(): void; onCommit(facts: ActionCommitFacts): Promise<void> }): ActionBroker
  }
  readTimeoutMs?: number
}
export interface ActionBridge { socketPath: string; token: string; close(): Promise<void> }
const exec = promisify(execFile)
const MAX_FRAME = 16 * 1024
const within = (root: string, path: string) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)) }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const alias = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\0\r]/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function fail(message: string): never { throw new Error(message) }

/** One authenticated request per connection. Host configuration is assembled here,
 * never returned to Pi. Socket capability is run-scoped, not an OS isolation claim:
 * arbitrary same-UID code can inspect the process/files and is outside this boundary.
 * close waits for owned broker work to settle; it never fabricates writer-stopped.
 */
export async function startActionBridge(options: ActionBridgeOptions): Promise<ActionBridge> {
  if (process.platform === 'win32') fail('Action bridge requires Unix domain sockets')
  const request = structuredClone(options.request)
  const baseline = structuredClone(options.baseline)
  const { config, task, runId } = request
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  let closing = false
  type Uncertainty = Error & { code: 'NIGHTSHIFT_ACTION_UNKNOWN' | 'NIGHTSHIFT_WRITER_UNKNOWN' | 'NIGHTSHIFT_RELEASE_UNKNOWN'; writerStopped: boolean; remoteActive: boolean; pgid?: number }
  let uncertainty: Uncertainty | undefined
  const currentUncertainty = (): Uncertainty | undefined => uncertainty
  const recoveryKey = randomBytes(16).toString('hex')
  const latchUnknown = async (code: Uncertainty['code'], pgid?: number) => {
    const writerStopped = code !== 'NIGHTSHIFT_WRITER_UNKNOWN' && uncertainty?.writerStopped !== false
    const remoteActive = code === 'NIGHTSHIFT_RELEASE_UNKNOWN' || uncertainty?.remoteActive === true
    const effectiveCode = !writerStopped ? 'NIGHTSHIFT_WRITER_UNKNOWN' : remoteActive ? 'NIGHTSHIFT_RELEASE_UNKNOWN' : 'NIGHTSHIFT_ACTION_UNKNOWN'
    uncertainty = Object.assign(new Error('Host action outcome requires recovery; retain run lease'), { code: effectiveCode as Uncertainty['code'], writerStopped, remoteActive, ...(Number.isSafeInteger(pgid) && pgid! > 1 ? { pgid } : uncertainty?.pgid ? { pgid: uncertainty.pgid } : {}) })
    controller.abort() // revoke before any persistence await or socket reply
    try {
      const record = resolve(config.stateDir, `bridge-unknown-${recoveryKey}-${code}.json`)
      if (await realpath(config.stateDir) !== config.stateDir) fail('Recovery state path changed')
      const file = await open(record, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify({ runId, taskId: task.id, code: uncertainty.code, writerStopped, remoteActive, pgid: uncertainty.pgid }) + '\n'); await file.sync() }
      finally { await file.close() }
      const directory = await open(config.stateDir, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch { /* fail-closed in-memory latch remains; close must still reject */ }
  }
  let commitCallbackActive = false
  const authorize = () => {
    signal.throwIfAborted()
    if (closing || Date.now() >= Date.parse(request.deadline) || !Number.isFinite(Date.parse(request.deadline))) fail('Action bridge admission expired')
    options.assertAuthorized()
  }
  authorize()
  if (!isAbsolute(config.workspace) || await realpath(config.workspace) !== config.workspace || !isAbsolute(config.stateDir) || within(config.workspace, config.stateDir)) fail('Action bridge requires canonical workspace and external state directory')
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
  if (await realpath(config.stateDir) !== config.stateDir) fail('Action state directory may not traverse symlinks')
  const repositoryMap: Record<string, string> = {}
  for (const name of task.repositories) {
    const path = config.repositories[name]
    if (!alias(name) || !path || !isAbsolute(path) || await realpath(path) !== path || !within(config.workspace, path)) fail('Invalid bridge repository scope')
    repositoryMap[name] = path
  }
  if (!Object.keys(repositoryMap).length) fail('Action bridge requires an explicit repository scope')
  const repositoryActions = Object.fromEntries(Object.keys(repositoryMap).filter(name => Object.hasOwn(config.repositoryActions ?? {}, name)).map(name => [name, config.repositoryActions![name]]))
  const policy: Record<string, unknown> = { runId, taskId: task.id, workspace: config.workspace, piHome: config.piHome, stateDir: config.stateDir, sessionFile: config.sessionFile, repositories: Object.values(repositoryMap), registry: Object.values(config.repositories), repositoryMap, repositoryActions, baseline, approved: task.approved === true, access: task.access, actions: task.actions ?? [], actionApprovalId: task.actionsApproveMessageId }
  let factories = options.factories
  if (!factories) {
    const guardPath = await realpath(options.guardPath)
    const actionsPath = await realpath(resolve(dirname(guardPath), 'nightshift-actions.mjs'))
    for (const path of [guardPath, actionsPath]) {
      const info = await lstat(path)
      if (!isAbsolute(path) || within(config.workspace, path) || !info.isFile() || info.nlink !== 1) fail('Broker modules must be trusted regular resources outside the editable workspace')
    }
    const guardModule = await import(pathToFileURL(guardPath).href) as { createGuard: NonNullable<ActionBridgeOptions['factories']>['createGuard'] }
    const actionModule = await import(pathToFileURL(actionsPath).href) as { createActions: NonNullable<ActionBridgeOptions['factories']>['createActions'] }
    if (typeof guardModule.createGuard !== 'function' || typeof actionModule.createActions !== 'function') fail('Trusted broker modules do not expose the required factories')
    factories = { createGuard: guardModule.createGuard, createActions: actionModule.createActions }
  }
  authorize()
  const guard = factories.createGuard(policy)
  const commitHeads = new Set<string>()
  const persistCommit = async (facts: ActionCommitFacts) => {
    // A successfully made commit must still be recorded after pause/abort. Do not
    // reauthorize a mutation here: this callback persists already-observed facts.
    if (!commitCallbackActive || !options.onCommit || !facts || !alias(facts.repository) || !Object.hasOwn(repositoryMap, facts.repository) || !sha(facts.head) || !sha(facts.parent) || !bounded(facts.branch, 200) || !/^(?:sdd|agent)\//.test(facts.branch) || !hash(facts.sourceDigest) || !Array.isArray(facts.validationIds) || !facts.validationIds.length || facts.validationIds.some(id => !bounded(id, 200)) || !object(facts.recipePins) || !Object.keys(facts.recipePins).length || Object.values(facts.recipePins).some(pin => !hash(pin))) fail('Invalid host commit receipt facts')
    const root = repositoryMap[facts.repository]!
    if (commitHeads.has(`${facts.repository}:${facts.head}`)) fail('Duplicate host commit receipt callback')
    const env = { PATH: '/usr/bin:/bin', HOME: config.stateDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
    const readGit = async (args: string[]) => (await exec('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'log.showSignature=false', '-C', root, ...args], { env, timeout: 5_000, maxBuffer: 64 * 1024 })).stdout.trim()
    const actual = (await readGit(['rev-parse', 'HEAD', 'HEAD^', 'HEAD^{tree}'])).split('\n')
    const branch = await readGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (actual[0] !== facts.head || actual[1] !== facts.parent || !sha(actual[2]) || branch !== facts.branch) fail('Host commit readback disagrees with broker receipt')
    const receipt: HostCommitReceipt = { taskId: task.id, runId, repository: facts.repository, root, head: facts.head, parent: facts.parent, branch, treeSha: actual[2], sourceDigest: facts.sourceDigest, validationIds: [...facts.validationIds], recipePins: { ...facts.recipePins } }
    await options.onCommit(receipt)
    commitHeads.add(`${facts.repository}:${facts.head}`)
  }
  const onCommit = async (facts: ActionCommitFacts) => {
    try { await persistCommit(facts) }
    catch (error) { await latchUnknown('NIGHTSHIFT_ACTION_UNKNOWN'); throw error }
  }
  const broker = factories.createActions(policy, guard, { assertAuthorized: authorize, onCommit })
  authorize()
  // macOS sun_path is 104 bytes; stateDir commonly exceeds that limit. /tmp is
  // canonicalized first and a fresh private namespace carries the actual socket.
  const tmp = await realpath('/tmp')
  const directory = await mkdtemp(resolve(tmp, 'dsh-ns-'))
  await chmod(directory, 0o700)
  const directoryIdentity = await lstat(directory)
  const socketPath = resolve(directory, 'rpc.sock')
  if (Buffer.byteLength(socketPath) >= 104) fail('Action socket path exceeds Unix limit')
  const tokenBytes = randomBytes(32); const token = tokenBytes.toString('hex')
  const sockets = new Set<Socket>()
  const acceptedIds = new Set<string>()
  let active: Promise<void> | undefined
  let busy = false
  let closingPromise: Promise<void> | undefined
  let socketInode: number | undefined
  const safeActionResult = (result: unknown): Record<string, unknown> => {
    if (!object(result) || !['succeeded', 'failed', 'blocked', 'unknown'].includes(String(result.outcome)) || (result.writerStopped !== undefined && result.writerStopped !== true) || (result.passed !== undefined && typeof result.passed !== 'boolean') || (result.passed === true && result.outcome !== 'succeeded') || (result.exitCode !== undefined && result.exitCode !== null && !Number.isInteger(result.exitCode)) || (result.head !== undefined && !sha(result.head))) return { outcome: 'unknown', summary: 'Host action returned unverified evidence; manual recovery is required.' }
    const outcome = result.outcome
    const out: Record<string, unknown> = { outcome, summary: outcome === 'succeeded' ? 'Host action completed with verified evidence.' : outcome === 'failed' ? 'Validation failed; edit the approved source and revalidate.' : outcome === 'blocked' ? 'Host action was denied by approval, scope or evidence checks.' : 'Host action outcome is uncertain; manual recovery is required.' }
    if (typeof result.passed === 'boolean') out.passed = result.passed
    if (result.exitCode === null || (typeof result.exitCode === 'number' && Number.isInteger(result.exitCode))) out.exitCode = result.exitCode
    if (sha(result.head)) out.head = result.head
    return out
  }
  const safeReleaseResult = (result: ReleaseResult): Record<string, unknown> => {
    if (!object(result) || !['blocked', 'prepared', 'dispatching', 'accepted', 'succeeded', 'failed', 'unknown'].includes(result.status) || typeof result.remoteActive !== 'boolean') return { status: 'unknown', remoteActive: true, remoteIds: [], detail: 'Remote evidence could not be verified.' }
    return { status: result.status, remoteActive: result.remoteActive, remoteIds: (Array.isArray(result.remoteIds) ? result.remoteIds : []).filter(id => typeof id === 'string' && /^[a-zA-Z0-9._:#/-]{1,200}$/.test(id)).slice(0, 40), ...(typeof result.operationId === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(result.operationId) ? { operationId: result.operationId } : {}), detail: result.status === 'succeeded' ? 'Release evidence verified by the host.' : result.remoteActive ? 'Remote activity is active or uncertain; no blind retry is allowed.' : 'Release request was inspected by the host; no additional authority was granted.' }
  }
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    if (closing || sockets.size > 32) { socket.destroy(); return }
    let consumed = false; let buffer = Buffer.alloc(0)
    const timeout = setTimeout(() => socket.destroy(), options.readTimeoutMs ?? 5_000)
    socket.once('close', () => clearTimeout(timeout))
    const reply = (value: Record<string, unknown>) => {
      if (socket.destroyed) return
      socket.setTimeout(2_000, () => socket.destroy())
      // One bounded response; end waits for queued bytes/backpressure then closes.
      socket.end(JSON.stringify(value) + '\n')
    }
    socket.on('data', (chunk: Buffer) => {
      if (consumed) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME) { socket.destroy(); return }
      const end = buffer.indexOf(10)
      if (end < 0) return
      consumed = true; clearTimeout(timeout)
      if (end !== buffer.length - 1) { socket.destroy(); return }
      let message: Record<string, unknown>
      try {
        const line = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))
        const parsed: unknown = JSON.parse(line)
        if (!object(parsed)) throw new Error('shape')
        message = parsed
      } catch { reply({ id: null, ok: false, error: 'Invalid bridge frame' }); return }
      const requestId = message.id
      if (!bounded(requestId, 100) || !/^[a-zA-Z0-9._:-]+$/.test(requestId) || Object.keys(message).some(key => !['id', 'token', 'kind', 'input'].includes(key)) || !['action', 'release'].includes(String(message.kind))) { reply({ id: null, ok: false, error: 'Invalid bridge request' }); return }
      const supplied = typeof message.token === 'string' && /^[a-f0-9]{64}$/.test(message.token) ? Buffer.from(message.token, 'hex') : Buffer.alloc(32)
      if (!timingSafeEqual(supplied, tokenBytes)) { reply({ id: requestId, ok: false, error: 'Bridge authentication denied' }); return }
      if (closing || busy || uncertainty) { reply({ id: requestId, ok: false, error: 'Bridge busy, closing or requires writer recovery; concurrent execution denied' }); return }
      if (acceptedIds.has(requestId) || acceptedIds.size >= 1000) { reply({ id: requestId, ok: false, error: 'Duplicate request or run request budget exceeded' }); return }
      const input = message.input
      const release = message.kind === 'release'
      const allowed = release ? ['action', 'repository', 'sha', 'title', 'description'] : ['action', 'repository', 'recipe', 'message', 'title', 'description']
      if (!object(input) || Object.keys(input).some(key => !allowed.includes(key)) || !alias(input.repository) || !Object.hasOwn(repositoryMap, input.repository) || !(release ? ['push', 'create_mr', 'merge', 'deploy'] : ['validate', 'commit', 'publish']).includes(String(input.action)) || (release && !sha(input.sha)) || ['recipe', 'message', 'title', 'description'].some(key => input[key] !== undefined && !bounded(input[key], key === 'recipe' ? 100 : key === 'title' ? 250 : 8000))) { reply({ id: requestId, ok: false, error: 'Invalid scoped bridge action' }); return }
      acceptedIds.add(requestId)
      busy = true
      const operation = (async () => {
        let invokedRelease = false; let invokedAction = false
        try {
          authorize()
          if (release) {
            if (!options.release) { reply({ id: requestId, ok: true, result: { status: 'blocked', remoteActive: false, remoteIds: [], detail: 'Release capability is unavailable.' } }); return }
            invokedRelease = true
            const result = await options.release(input as unknown as BridgeReleaseInput, signal)
            const sanitized = safeReleaseResult(result)
            const journaled = typeof sanitized.operationId === 'string'
            const malformed = !object(result) || !['blocked', 'prepared', 'dispatching', 'accepted', 'succeeded', 'failed', 'unknown'].includes(String(result.status)) || typeof result.remoteActive !== 'boolean' || !Array.isArray(result.remoteIds) || result.remoteIds.some(id => typeof id !== 'string')
            if (malformed || (!journaled && (sanitized.status === 'unknown' || sanitized.remoteActive === true || !['blocked', 'failed'].includes(String(sanitized.status))))) {
              await latchUnknown('NIGHTSHIFT_RELEASE_UNKNOWN')
              reply({ id: requestId, ok: true, result: { status: 'unknown', remoteActive: true, remoteIds: [], detail: 'Remote result lacks verified durable journal ownership; manual recovery is required.' } })
            } else reply({ id: requestId, ok: true, result: sanitized })
          } else {
            if (input.action === 'commit' && !options.onCommit) { reply({ id: requestId, ok: true, result: { outcome: 'blocked', summary: 'Durable host commit receipt storage is required.' } }); return }
            commitCallbackActive = input.action === 'commit'; invokedAction = true
            const result = await broker.execute(input as unknown as BridgeActionInput, signal)
            commitCallbackActive = false
            if (input.action === 'commit' && object(result) && result.outcome === 'succeeded' && (!sha(result.head) || !commitHeads.has(`${input.repository}:${result.head}`))) fail('Commit success requires a persisted host receipt')
            const sanitized = safeActionResult(result)
            if (sanitized.outcome === 'unknown' || currentUncertainty()) {
              if (!currentUncertainty()) await latchUnknown(object(result) && result.writerStopped === false ? 'NIGHTSHIFT_WRITER_UNKNOWN' : 'NIGHTSHIFT_ACTION_UNKNOWN')
              reply({ id: requestId, ok: true, result: { outcome: 'unknown', writerStopped: currentUncertainty()?.writerStopped ?? false, summary: 'Host action outcome requires manual recovery; run lease is retained.' } })
            } else reply({ id: requestId, ok: true, result: sanitized })
          }
        } catch (error) {
          if (object(error) && error.code === 'NIGHTSHIFT_WRITER_UNKNOWN') await latchUnknown('NIGHTSHIFT_WRITER_UNKNOWN', typeof error.pgid === 'number' ? error.pgid : undefined)
          else if (invokedRelease) await latchUnknown('NIGHTSHIFT_RELEASE_UNKNOWN')
          else if (invokedAction) await latchUnknown('NIGHTSHIFT_ACTION_UNKNOWN')
          reply({ id: requestId, ok: true, result: release ? { status: invokedRelease ? 'unknown' : 'blocked', remoteActive: invokedRelease, remoteIds: [], detail: invokedRelease ? 'Remote result is unknown; reconcile without retry.' : 'Host authorization denied.' } : currentUncertainty() ? { outcome: 'unknown', writerStopped: currentUncertainty()!.writerStopped, summary: 'Host action outcome requires manual recovery; run lease is retained.' } : { outcome: 'blocked', summary: 'Host authorization denied before action execution.' } })
        } finally { commitCallbackActive = false; busy = false }
      })()
      active = operation
      void operation.finally(() => { if (active === operation) active = undefined })
    })
  })
  const cleanup = async () => {
    // Verify the exact exclusively-created directory identity before removing it.
    if (dirname(directory) !== tmp || !directory.startsWith(`${tmp}${sep}dsh-ns-`) || await realpath(directory) !== directory || (await lstat(directory)).ino !== directoryIdentity.ino) fail('Action socket namespace changed; cleanup refused')
    try { const info = await lstat(socketPath); if (socketInode === undefined || info.ino !== socketInode || !info.isSocket()) fail('Action socket ownership changed; cleanup refused') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rm(directory, { recursive: true, force: false })
  }
  const close = (): Promise<void> => {
    if (closingPromise) return closingPromise
    closing = true; controller.abort()
    closingPromise = (async () => {
      const stopped = new Promise<void>((done, rejectClose) => server.close(error => error ? rejectClose(new Error('Action bridge listener close failed')) : done()))
      await active
      for (const socket of sockets) socket.destroy()
      await stopped
      if (uncertainty) throw uncertainty // listener stopped, but action/writer/remote ownership is NOT released
      await cleanup()
    })()
    return closingPromise
  }
  try {
    await new Promise<void>((done, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socketPath, () => { server.removeListener('error', rejectListen); done() })
    })
    await chmod(socketPath, 0o600); socketInode = (await lstat(socketPath)).ino
    authorize()
  } catch {
    if (server.listening) await close()
    else await cleanup()
    fail('Action bridge startup failed')
  }
  const abort = () => { void close().catch(() => { /* caller must await close to observe cleanup failure */ }) }
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  return { socketPath, token, close: async () => { options.signal.removeEventListener('abort', abort); await close() } }
}
