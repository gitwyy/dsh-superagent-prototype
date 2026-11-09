/** No live pi/git/network calls: all state and workspace reservations use isolated temp directories. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Command, Incoming, NightConfig, NightController, RunRequest, RunResult, Runner } from '../src/nightshift/contracts.ts'
import { createController } from '../src/nightshift/controller.ts'
import { NightStore } from '../src/nightshift/store.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const stopped = (outcome: RunResult['outcome'] = 'succeeded'): RunResult => ({ outcome, summary: 'fake result', writerStopped: true, evidence: ['fake process group is absent'] })
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const roots: string[] = []
const controllers: NightController[] = []
const runs: { resolve: (result: RunResult) => void }[] = []
let messageSequence = 0
function input(id = `m-${++messageSequence}`, change: Partial<Incoming> = {}): Incoming {
  return { id, actorId: 'owner', text: 'direct human command', at: new Date().toISOString(), direct: true, human: true, target: { source: 'feishu', chatId: 'dm-owner', messageId: id }, ...change }
}
function harness(overrides: Partial<NightConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nightshift-controller-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const config: NightConfig = { enabled: true, workspace, stateDir: join(root, 'state'), lockRoot: join(root, 'locks'), piExecutable: '/fake/pi', piHome: join(root, 'pi'), sessionFile: join(root, 'pi', 'session.jsonl'), repositories: { repo: 'repo' }, maxTaskSeconds: 3600, freezeWindows: [], ...overrides }
  const calls: { request: RunRequest; signal: AbortSignal; gate: ReturnType<typeof deferred<RunResult>> }[] = []
  const runner: Runner = {
    preflight: vi.fn(async () => ({ ok: true, problems: [] })),
    run: vi.fn((request, signal) => { const gate = deferred<RunResult>(); calls.push({ request, signal, gate }); runs.push(gate); return gate.promise }),
  }
  const create = (changes: Partial<NightConfig> = {}) => { const controller = createController({ ...config, ...changes }, runner); controllers.push(controller); return controller }
  const controller = create()
  return { root, config, runner, calls, controller, create }
}
async function command(controller: NightController, value: Command, incoming = input()) { await controller.handle(incoming, value); await drain(); return incoming }
async function task(controller: NightController, approved = true, access: 'read' | 'write' = 'write') {
  await command(controller, { type: 'enqueue', text: 'Implement and test one change', repositories: ['repo'], access })
  const task = controller.snapshot().tasks.at(-1)!
  if (approved) await command(controller, { type: 'approve', taskId: task.id })
  return task.id
}
async function start(controller: NightController, ms = 60_000) { return command(controller, { type: 'start', deadline: new Date(Date.now() + ms).toISOString() }) }
const texts = (controller: NightController) => controller.pendingReplies().map(reply => reply.text).join('\n')
afterEach(async () => {
  for (const run of runs.splice(0)) run.resolve(stopped('cancelled'))
  await drain()
  for (const controller of controllers.splice(0)) await controller.close()
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    // Delete only the exact independently created test directory, never a live configured path.
    if (resolve(root) !== root || !root.startsWith(join(tmpdir(), 'nightshift-controller-'))) throw new Error(`Unexpected test cleanup target: ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('nightshift durable authorization and serial dispatch', () => {
  it('defaults DAY_MANUAL, queues without running, and requires explicit approval and start', async () => {
    const { controller, calls } = harness()
    const id = await task(controller, false)
    expect(controller.snapshot().mode).toBe('DAY_MANUAL')
    expect(calls).toHaveLength(0)
    await start(controller)
    expect(calls).toHaveLength(0)
    await command(controller, { type: 'approve', taskId: id })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request.task).toMatchObject({ access: 'write', approved: true, ownerId: 'owner' })
    expect(controller.snapshot().activeRunId).toBe(calls[0]!.request.runId)
  })

  it('requires separate explicit actions and configured recipes; publication remains denied', async () => {
    const policy = { validations: { check: { executable: '/bin/true', executableSha256: 'a'.repeat(64), args: [], timeoutSeconds: 1, pinnedFiles: { 'test.txt': 'b'.repeat(64) } } }, requiredValidations: ['check'], author: { name: 'Agent', email: 'agent@example.invalid' }, targetBranch: 'master' }
    const { controller } = harness({ repositoryActions: { repo: policy } })
    const id = await task(controller, false)
    await command(controller, { type: 'authorize-actions', taskId: id, actions: ['validate', 'commit'] })
    expect(controller.snapshot().tasks[0]!.actions).toBeUndefined()
    await command(controller, { type: 'approve', taskId: id })
    await command(controller, { type: 'authorize-actions', taskId: id, actions: ['validate', 'commit'] }, input(undefined, { actorId: 'other' }))
    expect(controller.snapshot().tasks[0]!.actions).toBeUndefined()
    await command(controller, { type: 'authorize-actions', taskId: id, actions: ['validate', 'commit'] })
    expect(controller.snapshot().tasks[0]!.actions).toEqual(['validate', 'commit'])
    await command(controller, { type: 'authorize-actions', taskId: id, actions: ['publish'] })
    expect(controller.snapshot().tasks[0]!.actions).not.toContain('publish')
    expect(texts(controller)).toContain('发布尚未启用')
  })

  it('does not dispatch or grant authorization when disabled', async () => {
    const { controller, calls, runner } = harness({ enabled: false })
    await command(controller, { type: 'enqueue', text: 'write', repositories: ['repo'], access: 'write' })
    await start(controller)
    expect(controller.snapshot()).toMatchObject({ mode: 'DAY_MANUAL', tasks: [] })
    expect(calls).toHaveLength(0)
    expect(runner.preflight).not.toHaveBeenCalled()
    expect(texts(controller)).toContain('未启用')
  })

  it('rejects nonhuman/group commands, unknown repositories and approval by another actor', async () => {
    const { controller, calls } = harness()
    for (const change of [{ human: false }, { direct: false }]) await command(controller, { type: 'enqueue', text: 'bad', repositories: ['repo'], access: 'write' }, input(undefined, change))
    await command(controller, { type: 'enqueue', text: 'bad', repositories: ['../escape'], access: 'write' })
    expect(controller.snapshot().tasks).toHaveLength(0)
    const id = await task(controller, false, 'read')
    await command(controller, { type: 'approve', taskId: id }, input(undefined, { actorId: 'stranger' }))
    await start(controller)
    expect(calls).toHaveLength(0)
    expect(controller.snapshot().tasks[0]!.approved).toBe(false)
  })

  it('runs exactly one task at a time and preflights every dispatch', async () => {
    const { controller, calls, runner } = harness()
    const first = await task(controller), second = await task(controller)
    await start(controller)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request.task.id).toBe(first)
    calls[0]!.gate.resolve(stopped()); await drain()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.request.task.id).toBe(second)
    expect(controller.snapshot().tasks.map(task => task.state)).toEqual(['succeeded', 'running'])
    expect(runner.preflight).toHaveBeenCalledTimes(3)
  })

  it('keeps caller mutation from changing trusted config or task authorization', async () => {
    const h = harness()
    h.config.enabled = false
    h.config.repositories.repo = 'changed-outside-controller'
    const message = input()
    const request: Command = { type: 'enqueue', text: 'approved original', repositories: ['repo'], access: 'read' }
    const pending = h.controller.handle(message, request)
    request.text = 'mutated'; request.repositories[0] = 'unknown'; message.actorId = 'attacker'
    await pending
    const id = h.controller.snapshot().tasks[0]!.id
    await command(h.controller, { type: 'approve', taskId: id })
    await start(h.controller)
    expect(h.calls[0]!.request.task).toMatchObject({ text: 'approved original', ownerId: 'owner', access: 'read' })
    expect(h.calls[0]!.request.config.repositories.repo).toBe('repo')
    const snapshot = h.controller.snapshot(); snapshot.tasks[0]!.approved = false
    expect(h.controller.snapshot().tasks[0]!.approved).toBe(true)
  })
})

describe('handoff and ambiguity', () => {
  it('responds to status/handoff without awaiting a runner and only acknowledges after verified stop', async () => {
    const { controller, calls } = harness()
    await task(controller); await task(controller); await start(controller)
    await command(controller, { type: 'status' })
    const handoff = await command(controller, { type: 'handoff' })
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(controller.snapshot().mode).toBe('HANDOFF_PENDING')
    expect(controller.pendingReplies().find(reply => reply.id === `${handoff.id}:reply`)!.text).toContain('尚未确认')
    expect(controller.pendingReplies().some(reply => reply.id === `${handoff.id}:final`)).toBe(false)
    calls[0]!.gate.resolve(stopped('cancelled')); await drain()
    expect(controller.snapshot().mode).toBe('DAY_MANUAL')
    expect(calls).toHaveLength(1)
    expect(controller.pendingReplies().find(reply => reply.id === `${handoff.id}:final`)!.text).toContain('已确认受监管写入进程退出')
  })

  it('never acknowledges handoff or dispatches another task when runner says writer remains alive', async () => {
    const { controller, calls, config } = harness()
    await task(controller); await task(controller); await start(controller)
    const handoff = await command(controller, { type: 'handoff' })
    calls[0]!.gate.resolve({ ...stopped(), writerStopped: false }); await drain()
    expect(controller.snapshot()).toMatchObject({ mode: 'RECOVERY_REQUIRED', activeRunId: calls[0]!.request.runId })
    expect(controller.snapshot().tasks.map(task => task.state)).toEqual(['unknown', 'queued'])
    expect(controller.pendingReplies().find(reply => reply.id === `${handoff.id}:final`)!.text).toContain('未确认写入停止')
    await start(controller)
    expect(calls).toHaveLength(1)
    const lock = new NightStore({ ...config, stateDir: join(config.stateDir, '..', 'inspect') })
    expect(() => lock.acquireWorkspace()).toThrow('lock unavailable')
    lock.close(true)
    await controller.close()
    expect(() => createController(config, { preflight: async () => ({ ok: true, problems: [] }), run: async () => stopped() })).toThrow('lock unavailable')
  })

  it('treats thrown runner errors and unknown outcomes as recovery, never ordinary failure/replay', async () => {
    const h = harness()
    await task(h.controller); await start(h.controller)
    h.calls[0]!.gate.reject(new Error('lost child channel')); await drain()
    expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
    expect(h.controller.snapshot().tasks[0]).toMatchObject({ state: 'unknown', result: { writerStopped: false } })
    await command(h.controller, { type: 'handoff' })
    expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
  })

  it('bounds abort waiting, retains recovery on a late completion, and close does not claim safety', async () => {
    vi.useFakeTimers()
    const h = harness()
    await task(h.controller); await start(h.controller)
    const handoff = await command(h.controller, { type: 'handoff' })
    await vi.advanceTimersByTimeAsync(10_001); await drain()
    expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
    expect(h.controller.pendingReplies().find(reply => reply.id === `${handoff.id}:final`)!.text).toContain('未确认写入停止')
    h.calls[0]!.gate.resolve(stopped('cancelled')); await drain()
    expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
    await start(h.controller)
    expect(h.calls).toHaveLength(1)
  })

  it('close aborts and waits for stop evidence, keeps replies available for shutdown flush', async () => {
    const h = harness()
    await task(h.controller); await start(h.controller)
    let closed = false
    const closing = h.controller.close().then(() => { closed = true })
    await drain()
    expect(h.calls[0]!.signal.aborted).toBe(true)
    expect(closed).toBe(false)
    h.calls[0]!.gate.resolve(stopped('cancelled'))
    await closing
    expect(h.controller.snapshot().mode).toBe('NIGHT_PAUSED')
    expect(texts(h.controller)).toContain('写入进程退出：已确认')
    const reopened = h.create()
    expect(reopened.snapshot().mode).toBe('NIGHT_PAUSED')
    expect(h.calls).toHaveLength(1)
  })

  it('close always aborts after a save failure and reports it only after verified writer shutdown', async () => {
    const h = harness()
    await task(h.controller); await start(h.controller)
    const save = vi.spyOn(NightStore.prototype, 'save').mockImplementationOnce(() => { throw new Error('close save unavailable') })
    let settled = false
    const closing = h.controller.close()
    const rejection = expect(closing).rejects.toThrow('close save unavailable')
    void closing.then(() => { settled = true }, () => { settled = true })
    try {
      await drain()
      expect(h.calls[0]!.signal.aborted).toBe(true)
      expect(settled).toBe(false)
      expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
      h.calls[0]!.gate.resolve(stopped('cancelled'))
      await rejection
      expect(settled).toBe(true)
      expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
      expect(texts(h.controller)).toContain('写入进程退出：已确认')
      const reopened = h.create()
      expect(reopened.snapshot().mode).toBe('RECOVERY_REQUIRED')
      expect(h.calls).toHaveLength(1)
      // The already-asserted close rejection is cached; do not treat it as an unexpected cleanup failure.
      controllers.splice(controllers.indexOf(h.controller), 1)
    } finally { save.mockRestore() }
  })

  it.each([false, true])('close remains bounded and retains reservation on persistent save failure (reported stopped=%s)', async writerStopped => {
    vi.useFakeTimers()
    const h = harness()
    await task(h.controller); await start(h.controller)
    const save = vi.spyOn(NightStore.prototype, 'save').mockImplementation(() => { throw new Error('persistent shutdown disk failure') })
    const closing = h.controller.close()
    const rejection = expect(closing).rejects.toThrow('persistent shutdown disk failure')
    try {
      await drain()
      expect(h.calls[0]!.signal.aborted).toBe(true)
      h.calls[0]!.gate.resolve({ ...stopped('cancelled'), writerStopped }); await drain()
      await vi.advanceTimersByTimeAsync(10_001)
      await rejection
      expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
      expect(texts(h.controller)).not.toContain('写入进程退出：已确认')
      controllers.splice(controllers.indexOf(h.controller), 1)
    } finally { save.mockRestore() }
    // Even a positive runner response is insufficient when its completion could not be persisted.
    const inspector = new NightStore({ ...h.config, stateDir: join(h.root, 'inspect-shutdown') })
    expect(() => inspector.acquireWorkspace()).toThrow('lock unavailable')
    inspector.close(true)
    expect(() => h.create()).toThrow('lock unavailable')
    expect(h.calls).toHaveLength(1)
  })

  it('requires explicit acknowledged recovery plus clean preflight and never requeues unknown tasks', async () => {
    const h = harness()
    await task(h.controller); await start(h.controller)
    h.calls[0]!.gate.resolve({ ...stopped('unknown'), summary: 'ambiguous write outcome' }); await drain()
    await command(h.controller, { type: 'recover', acknowledged: false })
    expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
    vi.mocked(h.runner.preflight).mockResolvedValueOnce({ ok: false, problems: ['orphan process evidence ambiguous'] })
    await command(h.controller, { type: 'recover', acknowledged: true })
    expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
    await command(h.controller, { type: 'recover', acknowledged: true })
    expect(h.controller.snapshot().mode).toBe('DAY_MANUAL')
    await start(h.controller)
    expect(h.calls).toHaveLength(1)
    expect(h.controller.snapshot().tasks[0]!.state).toBe('unknown')
  })
})

describe('asynchronous admission races and deadline fences', () => {
  it('invalidates a slow admission when pause arrives; status and pause stay responsive', async () => {
    const h = harness(), gate = deferred<{ ok: boolean; problems: string[] }>()
    vi.mocked(h.runner.preflight).mockReturnValueOnce(gate.promise)
    await task(h.controller)
    const admission = await start(h.controller)
    await command(h.controller, { type: 'status' })
    await command(h.controller, { type: 'pause' })
    gate.resolve({ ok: true, problems: [] }); await drain()
    expect(h.calls).toHaveLength(0)
    expect(h.controller.snapshot().mode).toBe('NIGHT_PAUSED')
    expect(h.controller.pendingReplies().find(reply => reply.id === `${admission.id}:final`)!.text).toContain('取消')
  })

  it('rejects overlapping starts and invalidates per-task preflight on handoff/cancel', async () => {
    const h = harness(), gate = deferred<{ ok: boolean; problems: string[] }>()
    const id = await task(h.controller)
    vi.mocked(h.runner.preflight).mockResolvedValueOnce({ ok: true, problems: [] }).mockReturnValueOnce(gate.promise)
    await start(h.controller)
    await start(h.controller)
    await command(h.controller, { type: 'cancel', taskId: id })
    await command(h.controller, { type: 'handoff' })
    gate.resolve({ ok: true, problems: [] }); await drain()
    expect(h.calls).toHaveLength(0)
    expect(h.controller.snapshot()).toMatchObject({ mode: 'DAY_MANUAL', tasks: [{ state: 'cancelled' }] })
  })

  it('rechecks authorization at dispatch even when cancellation occurs during preflight', async () => {
    const h = harness(), gate = deferred<{ ok: boolean; problems: string[] }>()
    const id = await task(h.controller)
    vi.mocked(h.runner.preflight).mockResolvedValueOnce({ ok: true, problems: [] }).mockReturnValueOnce(gate.promise)
    await start(h.controller)
    await command(h.controller, { type: 'cancel', taskId: id })
    gate.resolve({ ok: true, problems: [] }); await drain()
    expect(h.calls).toHaveLength(0)
    expect(h.controller.snapshot().tasks[0]!.state).toBe('cancelled')
  })

  it('fails closed on unsuccessful/throwing preflight', async () => {
    const h = harness()
    await task(h.controller)
    vi.mocked(h.runner.preflight).mockRejectedValueOnce(new Error('inspection unavailable'))
    await start(h.controller)
    expect(h.calls).toHaveLength(0)
    expect(h.controller.snapshot().mode).toBe('DAY_MANUAL')
    expect(texts(h.controller)).toContain('inspection unavailable')
    vi.mocked(h.runner.preflight).mockResolvedValueOnce({ ok: true, problems: [] }).mockResolvedValueOnce({ ok: false, problems: ['dirty repo'] })
    await start(h.controller)
    expect(h.controller.snapshot().mode).toBe('NIGHT_PAUSED')
    expect(h.calls).toHaveLength(0)
  })

  it('rejects expired, too-long, invalid and timezone-ambiguous deadlines', async () => {
    const h = harness()
    for (const deadline of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 12 * 3600_000 + 10_000).toISOString(), '2030-01-01T23:00:00', '2030-02-30T23:00:00Z', 'not-a-date']) {
      await command(h.controller, { type: 'start', deadline })
    }
    expect(h.controller.snapshot().mode).toBe('DAY_MANUAL')
    expect(h.runner.preflight).not.toHaveBeenCalled()
  })

  it('cuts off running work at the shift deadline; queue cannot resume on its own', async () => {
    vi.useFakeTimers()
    const h = harness()
    await task(h.controller); await task(h.controller); await start(h.controller, 2000)
    expect(Date.parse(h.calls[0]!.request.deadline)).toBeLessThanOrEqual(Date.now() + 2000)
    await vi.advanceTimersByTimeAsync(2001); await drain()
    expect(h.calls[0]!.signal.aborted).toBe(true)
    expect(h.controller.snapshot().mode).toBe('HANDOFF_PENDING')
    h.calls[0]!.gate.resolve(stopped('cancelled')); await drain()
    expect(h.controller.snapshot().mode).toBe('NIGHT_PAUSED')
    await vi.advanceTimersByTimeAsync(3600_000)
    expect(h.calls).toHaveLength(1)
  })

  it('enforces max-task duration and denies expired preflight completion', async () => {
    vi.useFakeTimers()
    const h = harness({ maxTaskSeconds: 1 })
    await task(h.controller); await start(h.controller, 10_000)
    expect(Date.parse(h.calls[0]!.request.deadline)).toBe(Date.now() + 1000)
    await vi.advanceTimersByTimeAsync(1001)
    expect(h.calls[0]!.signal.aborted).toBe(true)
    h.calls[0]!.gate.resolve(stopped('cancelled')); await drain()
    const gate = deferred<{ ok: boolean; problems: string[] }>()
    vi.mocked(h.runner.preflight).mockReturnValueOnce(gate.promise)
    await start(h.controller, 1000)
    await vi.advanceTimersByTimeAsync(1001)
    gate.resolve({ ok: true, problems: [] }); await drain()
    expect(h.controller.snapshot().mode).toBe('NIGHT_PAUSED')
    expect(h.calls).toHaveLength(1)
  })

  it('bounds execution by freeze start and never automatically resumes after freeze end', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const h = harness({ freezeWindows: [{ from: new Date(now + 2000).toISOString(), until: new Date(now + 4000).toISOString() }] })
    await task(h.controller); await task(h.controller); await start(h.controller, 20_000)
    expect(Date.parse(h.calls[0]!.request.deadline)).toBe(now + 2000)
    await vi.advanceTimersByTimeAsync(2001)
    expect(h.calls[0]!.signal.aborted).toBe(true)
    h.calls[0]!.gate.resolve(stopped('cancelled')); await drain()
    await start(h.controller, 20_000)
    expect(h.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(h.calls).toHaveLength(1)
    expect(h.controller.snapshot().mode).toBe('NIGHT_PAUSED')
  })

  it('rejects malformed freeze configuration before creating state', () => {
    for (const freezeWindows of [[{ from: '2026-01-01T01:00', until: '2026-01-01T02:00Z' }], [{ from: '2026-02-30T00:00Z', until: '2026-03-02T00:00Z' }], [{ from: '2026-01-02T00:00Z', until: '2026-01-01T00:00Z' }]]) {
      expect(() => harness({ freezeWindows })).toThrow('Freeze windows')
    }
  })
})

describe('system suspension and strengthened fences', () => {
  it('suspend invalidates admitted dispatch and never fabricates a human inbox receipt', async () => {
    const h = harness(), gate = deferred<{ ok: boolean; problems: string[] }>()
    await task(h.controller)
    vi.mocked(h.runner.preflight).mockReturnValueOnce(gate.promise)
    await start(h.controller)
    const before = h.controller.pendingReplies().length
    await h.controller.suspend()
    gate.resolve({ ok: true, problems: [] }); await drain()
    expect(h.calls).toHaveLength(0)
    expect(h.controller.snapshot().mode).toBe('NIGHT_PAUSED')
    // Only the cancelled admission's final reply, no fake system/human approval message.
    expect(h.controller.pendingReplies()).toHaveLength(before + 1)
  })

  it('suspend aborts active work and queued tasks stay paused until a fresh explicit start', async () => {
    const h = harness()
    await task(h.controller); await task(h.controller); await start(h.controller)
    await h.controller.suspend()
    expect(h.calls[0]!.signal.aborted).toBe(true)
    expect(h.controller.snapshot().mode).toBe('HANDOFF_PENDING')
    h.calls[0]!.gate.resolve(stopped('cancelled')); await drain()
    expect(h.controller.snapshot().mode).toBe('NIGHT_PAUSED')
    expect(h.calls).toHaveLength(1)
    await start(h.controller)
    expect(h.calls).toHaveLength(2)
  })

  it('a second stop plus close cannot clear an abort-timeout recovery latch on late completion', async () => {
    vi.useFakeTimers()
    const h = harness()
    await task(h.controller); await start(h.controller)
    await command(h.controller, { type: 'handoff' })
    await vi.advanceTimersByTimeAsync(10_001)
    await command(h.controller, { type: 'handoff' })
    await h.controller.suspend()
    const closing = h.controller.close()
    await drain()
    h.calls[0]!.gate.resolve(stopped('cancelled')); await drain()
    await closing
    expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
    expect(texts(h.controller)).not.toContain('DAY_MANUAL：已确认')
  })

  it('start preflight sees only approved queued tasks and recover sees unknown scopes', async () => {
    const h = harness()
    const approved = await task(h.controller), unapproved = await task(h.controller, false)
    await start(h.controller)
    expect(vi.mocked(h.runner.preflight).mock.calls[0]![1].map(task => task.id)).toEqual([approved])
    expect(vi.mocked(h.runner.preflight).mock.calls[0]![1].some(task => task.id === unapproved)).toBe(false)
    h.calls[0]!.gate.resolve(stopped('unknown')); await drain()
    await command(h.controller, { type: 'recover', acknowledged: true })
    expect(vi.mocked(h.runner.preflight).mock.calls.at(-1)![1].map(task => task.id)).toEqual([approved])
  })

  it('revokes queued approval when a host repository alias is remapped after rebuild', async () => {
    const h = harness()
    const id = await task(h.controller)
    await h.controller.close()
    const reopened = h.create({ repositories: { repo: 'different-repository' } })
    expect(reopened.snapshot().mode).toBe('RECOVERY_REQUIRED')
    expect(reopened.snapshot().tasks[0]).toMatchObject({ id, approved: false })
    await command(reopened, { type: 'recover', acknowledged: true })
    await start(reopened)
    expect(h.calls).toHaveLength(0)
    await command(reopened, { type: 'approve', taskId: id })
    expect(h.calls).toHaveLength(1)
  })

  it('status lists recent actionable task IDs, titles, repositories, access and approval', async () => {
    const h = harness()
    const id = await task(h.controller)
    const message = await command(h.controller, { type: 'status' })
    const reply = h.controller.pendingReplies().find(reply => reply.id === `${message.id}:reply`)!.text
    expect(reply).toContain(id)
    expect(reply).toContain('Implement and test one change')
    expect(reply).toContain('repo/write/已批准')
  })

  it('ignores groups and bots without emitting replies to their targets', async () => {
    const h = harness()
    await command(h.controller, { type: 'status' }, input('group', { direct: false }))
    await command(h.controller, { type: 'help' }, input('bot', { human: false }))
    expect(h.controller.pendingReplies()).toEqual([])
  })

  it('returns recovery rather than trusting a malformed runner result', async () => {
    const h = harness()
    await task(h.controller); await start(h.controller)
    h.calls[0]!.gate.resolve({ outcome: 'succeeded', writerStopped: true } as RunResult); await drain()
    expect(h.controller.snapshot().mode).toBe('RECOVERY_REQUIRED')
    expect(h.controller.snapshot().tasks[0]!.state).toBe('unknown')
  })
})

describe('durability and conservative ownership', () => {
  it('keeps incoming idempotency and pending/sent reply identity across controller rebuilds', async () => {
    const h = harness(), incoming = input('stable-feishu-message')
    const enqueue: Command = { type: 'enqueue', text: 'exactly one task', repositories: ['repo'], access: 'write' }
    await Promise.all([h.controller.handle(incoming, enqueue), h.controller.handle(incoming, enqueue)])
    expect(h.controller.snapshot().tasks).toHaveLength(1)
    const before = h.controller.pendingReplies()
    expect(before).toHaveLength(1)
    await h.controller.close()
    const reopened = h.create()
    expect(reopened.pendingReplies()).toEqual(before)
    await reopened.handle(incoming, enqueue)
    expect(reopened.pendingReplies()).toEqual(before)
    reopened.markReplySent(before[0]!.id)
    reopened.markReplySent(before[0]!.id)
    await reopened.close()
    const twice = h.create()
    await twice.handle(incoming, enqueue)
    expect(twice.snapshot().tasks).toHaveLength(1)
    expect(twice.pendingReplies()).toEqual([])
  })

  it('atomically rolls back inbox and reply when a state transaction fails', async () => {
    const h = harness()
    await h.controller.close()
    const store = new NightStore(h.config)
    const before = store.load()
    expect(() => store.transaction(() => {
      store.receive('rollback', 'owner', new Date().toISOString())
      store.reply('rollback:reply', input().target, 'never publish')
      const state = store.load()!; state.mode = 'NIGHT_RUNNING'; store.save(state)
      throw new Error('simulated storage transaction fault')
    })).toThrow('simulated')
    expect(store.seen('rollback')).toBe(false)
    expect(store.pendingReplies()).toEqual([])
    expect(store.load()).toEqual(before)
    store.close(true)
  })

  it('marks interrupted running tasks unknown on reopening and requires explicit new recovery/start', async () => {
    const h = harness()
    const id = await task(h.controller)
    await h.controller.close()
    // Seed the post-crash durable image, after independent offline verification of fake writers.
    const store = new NightStore(h.config)
    const state = store.load()!
    state.mode = 'NIGHT_RUNNING'; state.writerStopped = false; state.activeRunId = 'interrupted-run'
    state.deadline = new Date(Date.now() + 60_000).toISOString()
    state.tasks[0]!.state = 'running'; state.tasks[0]!.runId = 'interrupted-run'
    store.save(state); store.close(true)
    const reopened = h.create()
    expect(reopened.snapshot()).toMatchObject({ mode: 'RECOVERY_REQUIRED', activeRunId: 'interrupted-run' })
    expect(reopened.snapshot().tasks[0]).toMatchObject({ id, state: 'unknown' })
    await start(reopened)
    expect(h.calls).toHaveLength(0)
    await command(reopened, { type: 'recover', acknowledged: true })
    expect(reopened.snapshot().mode).toBe('DAY_MANUAL')
    await start(reopened)
    expect(h.calls).toHaveLength(0)
    expect(reopened.snapshot().tasks[0]!.state).toBe('unknown')
  })

  it('treats interrupted pending admission as recovery, not implicit new authorization', async () => {
    const h = harness()
    await h.controller.close()
    const store = new NightStore(h.config), state = store.load()!
    state.pendingCheck = { id: 'interrupted-start', kind: 'start', deadline: new Date(Date.now() + 60_000).toISOString(), target: input().target }
    store.save(state); store.close(true)
    const reopened = h.create()
    expect(reopened.snapshot().mode).toBe('RECOVERY_REQUIRED')
    expect(texts(reopened)).toContain('准入被重启中断')
    expect(h.calls).toHaveLength(0)
  })

  it('serializes stateDir instances and canonical workspace aliases across different state dirs', async () => {
    const h = harness()
    expect(() => h.create()).toThrow('lock unavailable')
    const alias = join(h.root, 'workspace-alias'); symlinkSync(h.config.workspace, alias)
    const other = h.create({ stateDir: join(h.root, 'other-state'), workspace: alias })
    // DAY_MANUAL deliberately holds no workspace writer reservation.
    await start(h.controller)
    await start(other)
    expect(other.snapshot().mode).toBe('DAY_MANUAL')
    expect(texts(other)).toContain('lock unavailable')
    await command(h.controller, { type: 'handoff' })
    await start(other)
    expect(other.snapshot().mode).toBe('NIGHT_RUNNING')
  })

  it('never steals stale, malformed, or foreign lock files', async () => {
    const h = harness()
    await h.controller.close()
    const lockPath = join(realpathSync(h.config.stateDir), 'controller.lock')
    for (const body of ['not json', JSON.stringify({ pid: 999999999, host: 'gone' }), JSON.stringify({ pid: process.pid, host: 'live' })]) {
      writeFileSync(lockPath, body)
      expect(() => h.create()).toThrow('Do not remove')
      expect(readFileSync(lockPath, 'utf8')).toBe(body)
    }
  })

  it('detects replaced lock ownership and never deletes a foreign workspace reservation', async () => {
    const h = harness()
    await h.controller.close()
    const store = new NightStore(h.config)
    store.acquireWorkspace()
    const original = readFileSync(store.workspaceLockPath, 'utf8')
    writeFileSync(store.workspaceLockPath, 'foreign-owner')
    expect(() => store.assertWorkspace()).toThrow('ownership changed')
    expect(() => store.close(true)).toThrow('ownership changed')
    expect(readFileSync(store.workspaceLockPath, 'utf8')).toBe('foreign-owner')
    writeFileSync(store.workspaceLockPath, original)
    store.close(true)
  })

  it('fails closed and rolls back incoming/task/reply together if durable save fails', async () => {
    const h = harness()
    const save = vi.spyOn(NightStore.prototype, 'save').mockImplementationOnce(() => { throw new Error('disk unavailable') })
    try {
      await expect(h.controller.handle(input(), { type: 'enqueue', text: 'must not run', repositories: ['repo'], access: 'write' })).rejects.toThrow('disk unavailable')
      expect(h.controller.snapshot()).toMatchObject({ mode: 'RECOVERY_REQUIRED', tasks: [] })
      expect(h.controller.pendingReplies()).toEqual([])
      expect(h.calls).toHaveLength(0)
    } finally { save.mockRestore() }
  })

  it('rejects reusing persisted approval under a different workspace identity', async () => {
    const h = harness()
    await task(h.controller)
    await h.controller.close()
    const other = join(h.root, 'different-workspace'); mkdirSync(other)
    expect(() => h.create({ workspace: other })).toThrow('workspace identity mismatch')
    expect(existsSync(join(h.config.stateDir, 'controller.lock'))).toBe(false)
  })
})
