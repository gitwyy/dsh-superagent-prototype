/** Natural language through the real adapter/Outbox: restate, confirm, then exactly one action. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NightAdapter } from '../src/nightshift/adapter.ts'
import { Outbox } from '../src/app/outbox.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { wordCount, checkedImText } from '../src/infra/text.ts'
import type { NightConfig } from '../src/nightshift/contracts.ts'
import type { Trigger } from '../src/core/index.ts'

const fixtures: { adapter: NightAdapter; store: Store; root: string }[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.adapter.close(); f.store.close(); if (dirname(f.root) !== realpathSync(tmpdir()) || !f.root.split('/').at(-1)?.startsWith('night-dialogue-adapter-')) throw new Error('Unsafe cleanup'); rmSync(f.root, { recursive: true, force: false }) } })
let sequence = 0
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'night-dialogue-adapter-'))), workspace = join(root, 'workspace'); mkdirSync(workspace)
  const config: NightConfig = { enabled: true, workspace, stateDir: join(root, 'state'), piHome: root, piExecutable: process.execPath,
    sessionFile: join(root, 'session'), lockRoot: join(root, 'locks'),
    repositories: { 'mate-manage-web': workspace, 'mate-account': workspace }, maxTaskSeconds: 120, freezeWindows: [] }
  const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { directMessages: true, chats: [], otherChats: 'none' } } }, policy: { sources: { feishu: { allowed: [{ id: 'owner' }] } } } })
  const store = new Store(join(root, 'host.sqlite'))
  const send = vi.fn()
  const outbox = { send } as unknown as Outbox
  const runner = { preflight: vi.fn(async () => ({ ok: true, problems: [] })), run: vi.fn(async () => ({ outcome: 'succeeded' as const, summary: 'ok', writerStopped: true, evidence: [] })) }
  const health = { set: vi.fn(), get: vi.fn(), release: vi.fn() }
  const adapter = new NightAdapter({ config, settings: () => settings, outbox, health, runner })
  fixtures.push({ adapter, store, root })
  const event = (text: string, id = `nl-${++sequence}`): Trigger => ({ id, source: 'feishu', actor: { source: 'feishu', id: 'owner' }, human: true, addressed: 'direct',
    at: new Date().toISOString(), text, meta: { direct: true }, threads: [],
    channel: { source: 'feishu', thread: 'feishu:dm-owner', address: { chatId: 'dm-owner', messageId: id, direct: 'true' } } })
  const last = () => send.mock.calls.at(-1)![0].text as string
  const all = () => send.mock.calls.map(([message]) => message.text as string).join('\n')
  const bounded = () => { for (const [message] of send.mock.calls) { expect(wordCount(message.text)).toBeLessThanOrEqual(100); expect(() => checkedImText(message.text)).not.toThrow() } }
  return { adapter, runner, event, last, all, bounded, store }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
void sleep

describe('natural-language private control through the real adapter', () => {
  it('restates scope once, then approves and runs without another confirmation', async () => {
    const f = fixture()
    await f.adapter.receive(f.event('处理 mate-manage-web open issue mate-manage-web#84，授权自动代处理各域接线和会签。'))
    expect(f.last()).toContain('mate-manage-web')
    expect(f.last()).toContain('确认这个范围吗')
    expect(f.adapter.snapshot().tasks[0]!.proposal?.requiresScopeConfirmation).toBe(true)
    await f.adapter.receive(f.event('确认'))
    await vi.waitFor(() => expect(f.adapter.snapshot().mode).toBe('NIGHT_RUNNING'), { timeout: 5000 })
    await vi.waitFor(() => expect(f.runner.run).toHaveBeenCalledTimes(1), { timeout: 5000 })
    expect(f.adapter.snapshot().tasks[0]!.approved).toBe(true)
    f.bounded()
  })
  it('cancels the staged draft when the owner declines, and cannot be confirmed by anyone else', async () => {
    const f = fixture()
    await f.adapter.receive(f.event('处理 mate-account#84'))
    const id = f.adapter.snapshot().tasks[0]!.id
    await f.adapter.receive({ ...f.event('确认'), actor: { source: 'feishu', id: 'other' } })
    expect(f.adapter.snapshot().tasks[0]!.proposal?.requiresScopeConfirmation).toBe(true)
    await f.adapter.receive(f.event('算了'))
    expect(f.adapter.snapshot().tasks.find(task => task.id === id)!.state).toBe('cancelled')
    expect(f.runner.run).not.toHaveBeenCalled()
    f.bounded()
  })
  it('keeps explicit grammar working and refuses vague prose with one short reply', async () => {
    const f = fixture()
    await f.adapter.receive(f.event('入队 只读 mate-manage-web | 查看说明'))
    expect(f.adapter.snapshot().tasks).toHaveLength(1)
    await f.adapter.receive(f.event('今天天气不错'))
    expect(f.last()).toContain('没听清')
    expect(f.adapter.snapshot().tasks).toHaveLength(1)
    expect(f.runner.run).not.toHaveBeenCalled()
    f.bounded()
  })
  it('reports status and refuses a start that has no confirmed task', async () => {
    const f = fixture()
    await f.adapter.receive(f.event('怎么样了'))
    expect(f.last()).toContain('DAY_MANUAL')
    await f.adapter.receive(f.event('开始，截止1小时后'))
    expect(f.last()).toContain('没有可执行的任务')
    expect(f.adapter.snapshot().mode).toBe('DAY_MANUAL')
    expect(f.runner.run).not.toHaveBeenCalled()
    f.bounded()
  })
})
