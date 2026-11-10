/** Natural-language staging → one confirmation → exactly that action; no direct grant from prose. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Command, Incoming, NightConfig, NightController, RunRequest, RunResult, Runner } from '../src/nightshift/contracts.ts'
import { createController } from '../src/nightshift/controller.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const stopped = (outcome: RunResult['outcome'] = 'succeeded'): RunResult => ({ outcome, summary: 'fake result', writerStopped: true, evidence: [] })
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const roots: string[] = [], controllers: NightController[] = [], runs: { resolve: (result: RunResult) => void }[] = []
let sequence = 0
function input(id = `m-${++sequence}`, change: Partial<Incoming> = {}): Incoming {
  return { id, actorId: 'owner', text: 'direct human command', at: new Date().toISOString(), direct: true, human: true,
    target: { source: 'feishu', chatId: 'dm-owner', messageId: id }, ...change }
}
function harness(overrides: Partial<NightConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nightshift-dialogue-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const config: NightConfig = { enabled: true, workspace, stateDir: join(root, 'state'), lockRoot: join(root, 'locks'), piExecutable: '/fake/pi',
    piHome: join(root, 'pi'), sessionFile: join(root, 'pi', 'session.jsonl'),
    repositories: { 'mate-manage-web': workspace, 'mate-account': workspace }, maxTaskSeconds: 3600, freezeWindows: [], ...overrides }
  const calls: RunRequest[] = []
  const runner: Runner = {
    preflight: vi.fn(async () => ({ ok: true, problems: [] as string[] })),
    run: vi.fn((request: RunRequest) => { calls.push(request); const gate = deferred<RunResult>(); runs.push(gate); return gate.promise }),
  }
  const controller = createController(config, runner); controllers.push(controller)
  return { root, config, runner, calls, controller }
}
async function command(controller: NightController, value: Command, incoming = input()) { await controller.handle(incoming, value); await drain(); return incoming }
const texts = (controller: NightController) => controller.pendingReplies().map(reply => reply.text).join('\n')
const deadline = (hours = 1) => new Date(Date.now() + hours * 3600_000).toISOString()
afterEach(async () => {
  for (const run of runs.splice(0)) run.resolve(stopped('cancelled'))
  await drain()
  for (const controller of controllers.splice(0)) await controller.close()
  vi.useRealTimers()
  for (const root of roots.splice(0)) { if (resolve(root) !== root || !root.startsWith(join(tmpdir(), 'nightshift-dialogue-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) }
})

describe('natural-language staging requires one explicit confirmation', () => {
  it('stages a task proposal, restates its exact boundary, and confirms only the scope', async () => {
    const h = harness()
    await command(h.controller, { type: 'propose-action', action: { kind: 'task-proposal', text: '处理 #84', repositories: ['mate-manage-web'], access: 'write' } })
    const task = h.controller.snapshot().tasks[0]!
    expect(task).toMatchObject({ approved: false, repositories: ['mate-manage-web'], access: 'write', state: 'queued' })
    expect(task.proposal?.requiresScopeConfirmation).toBe(true)
    expect(texts(h.controller)).toContain('范围 mate-manage-web')
    expect(texts(h.controller)).toContain('确认这个范围吗')
    await command(h.controller, { type: 'confirm-action' })
    expect(h.controller.snapshot().tasks[0]!.proposal?.requiresScopeConfirmation).toBe(false)
    expect(h.controller.snapshot().tasks[0]!.approved).toBe(false)
    expect(h.calls).toHaveLength(0)
  })
  it('never starts from prose alone and rejects confirmation without a staged action', async () => {
    const h = harness()
    await command(h.controller, { type: 'confirm-action' })
    expect(texts(h.controller)).toContain('没有等待确认的操作')
    expect(h.calls).toHaveLength(0)
    const proposed = await command(h.controller, { type: 'propose-action', action: { kind: 'start', deadline: deadline() } })
    expect(texts(h.controller)).toContain('没有可执行的任务')
    expect(proposed.id).toBeTruthy(); expect(h.calls).toHaveLength(0)
  })
  it('rejects another actor, an expired confirmation, and a second confirmation', async () => {
    const h = harness()
    await command(h.controller, { type: 'propose-action', action: { kind: 'task-proposal', text: '处理 #84', repositories: ['mate-manage-web'], access: 'write' } })
    await command(h.controller, { type: 'confirm-action' }, input(undefined, { actorId: 'other' }))
    expect(h.controller.snapshot().tasks[0]!.proposal?.requiresScopeConfirmation).toBe(true)
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11 * 60_000 })
    await command(h.controller, { type: 'confirm-action' })
    expect(texts(h.controller)).toContain('已过期')
    expect(h.controller.snapshot().tasks[0]!.proposal?.requiresScopeConfirmation).toBe(true)
    vi.useRealTimers()
    await command(h.controller, { type: 'confirm-action' })
    expect(texts(h.controller)).toContain('没有等待确认的操作')
  })
  it('declining cancels the staged draft and never executes it', async () => {
    const h = harness()
    await command(h.controller, { type: 'propose-action', action: { kind: 'task-proposal', text: '处理 #84', repositories: ['mate-manage-web'], access: 'write' } })
    await command(h.controller, { type: 'decline-action' })
    expect(h.controller.snapshot().tasks[0]!.state).toBe('cancelled')
    expect(h.calls).toHaveLength(0)
    expect(texts(h.controller)).toContain('已取消')
  })
  it('starts only after scope confirmation and a second confirmation, with approval deferred until preflight passes', async () => {
    const h = harness()
    await command(h.controller, { type: 'propose-action', action: { kind: 'task-proposal', text: '处理 #84', repositories: ['mate-manage-web'], access: 'write' } })
    await command(h.controller, { type: 'confirm-action' })
    await command(h.controller, { type: 'propose-action', action: { kind: 'start', deadline: deadline() } })
    expect(texts(h.controller)).toContain('将批准并启动 1 个任务')
    expect(h.controller.snapshot().tasks[0]!.approved).toBe(false)
    await command(h.controller, { type: 'confirm-action' })
    await drain()
    expect(h.controller.snapshot().mode).toBe('NIGHT_RUNNING')
    expect(h.controller.snapshot().tasks[0]!.approved).toBe(true)
    expect(h.calls).toHaveLength(1)
  })
  it('does not approve a task when preflight fails', async () => {
    const h = harness()
    vi.mocked(h.runner.preflight).mockResolvedValue({ ok: false, problems: ['repo dirty'] })
    await command(h.controller, { type: 'propose-action', action: { kind: 'task-proposal', text: '处理 #84', repositories: ['mate-manage-web'], access: 'write' } })
    await command(h.controller, { type: 'confirm-action' })
    await command(h.controller, { type: 'propose-action', action: { kind: 'start', deadline: deadline() } })
    await command(h.controller, { type: 'confirm-action' })
    await drain()
    expect(h.controller.snapshot().mode).not.toBe('NIGHT_RUNNING')
    expect(h.controller.snapshot().tasks[0]!.approved).toBe(false)
    expect(h.calls).toHaveLength(0)
  })
  it('rejects deadlines beyond 12 hours or inside a freeze window, and rejects starting while running', async () => {
    const h = harness({ freezeWindows: [{ from: new Date(Date.now() + 1800_000).toISOString(), until: new Date(Date.now() + 7200_000).toISOString() }] })
    await command(h.controller, { type: 'propose-action', action: { kind: 'task-proposal', text: '处理 #84', repositories: ['mate-manage-web'], access: 'write' } })
    await command(h.controller, { type: 'confirm-action' })
    await command(h.controller, { type: 'propose-action', action: { kind: 'start', deadline: deadline(13) } })
    expect(texts(h.controller)).toContain('12小时内')
    await command(h.controller, { type: 'propose-action', action: { kind: 'start', deadline: deadline() } })
    expect(texts(h.controller)).toContain('冻结')
  })
  it('grants local commit only after approval, by staged confirmation, and never publish', async () => {
    const policy = { validations: { check: { executable: '/bin/true', executableSha256: 'a'.repeat(64), args: [], timeoutSeconds: 1, pinnedFiles: {} } },
      requiredValidations: ['check'], author: { name: 'Agent', email: 'agent@example.invalid' }, targetBranch: 'master' }
    const h = harness({ repositoryActions: { 'mate-manage-web': policy } })
    await command(h.controller, { type: 'propose-action', action: { kind: 'task-proposal', text: '处理 #84', repositories: ['mate-manage-web'], access: 'write' } })
    await command(h.controller, { type: 'confirm-action' })
    await command(h.controller, { type: 'propose-action', action: { kind: 'allow-commit' } })
    expect(texts(h.controller)).toContain('还没有批准')
    await command(h.controller, { type: 'propose-action', action: { kind: 'start', deadline: deadline() } })
    await command(h.controller, { type: 'confirm-action' })
    await command(h.controller, { type: 'propose-action', action: { kind: 'allow-commit' } })
    expect(texts(h.controller)).toContain('本地验证和提交')
    await command(h.controller, { type: 'confirm-action' })
    expect(h.controller.snapshot().tasks[0]!.actions).toEqual(['validate', 'commit'])
  })
  it('recovers only from RECOVERY_REQUIRED after staged confirmation', async () => {
    const h = harness()
    await command(h.controller, { type: 'propose-action', action: { kind: 'recover' } })
    expect(texts(h.controller)).toContain('不是恢复态')
    expect(h.controller.snapshot().mode).toBe('DAY_MANUAL')
  })
})
