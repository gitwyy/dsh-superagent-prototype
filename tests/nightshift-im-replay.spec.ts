/** Real SQLite Outbox/NightStore and adapter replay; no Feishu network, source loops, Pi or business actions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NightAdapter } from '../src/nightshift/adapter.ts'
import { Outbox } from '../src/app/outbox.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { checkedImText, wordCount } from '../src/infra/text.ts'
import { backfillChat } from '../src/sources/feishu-loops.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { NightConfig, RunResult } from '../src/nightshift/contracts.ts'
import type { Trigger } from '../src/core/index.ts'
import type { ReleaseOperation, ReleaseScope } from '../src/nightshift/release/contracts.ts'

const fixtures: { adapter: NightAdapter; store: Store; root: string }[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.adapter.close(); f.store.close(); if (dirname(f.root) !== realpathSync(tmpdir()) || !f.root.split('/').at(-1)?.startsWith('night-im-replay-')) throw new Error('Unsafe fixture cleanup'); rmSync(f.root, { recursive: true, force: false }) } })
let sequence = 0
const original = '处理 mate-manage-web open issue mate-manage-web#84，授权自动代处理各域接线和会签。'
function fixture(repositoryCount = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'night-im-replay-'))); const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const repositories = Object.fromEntries(Array.from({ length: repositoryCount }, (_, i) => [i ? `repo-${i}` : 'mate-manage-web', workspace]))
  const config: NightConfig = { enabled: true, workspace, stateDir: join(root, 'state'), piHome: root, piExecutable: process.execPath, sessionFile: join(root, 'session'), lockRoot: join(root, 'locks'), repositories, maxTaskSeconds: 120, freezeWindows: [], releasePolicy: { version: 1, enabled: true, repositories: Object.fromEntries(Object.entries(repositories).map(([alias, path], i) => [alias, { alias, root: path, projectId: 400 + i, projectPath: `group/${alias}`, host: 'gitlab.invalid', apiOrigin: 'https://gitlab.invalid', expectedUserId: 95, expectedUsername: 'bot', credentialFile: join(root, 'not-read.json'), targetBranch: 'master', ciSha256: 'c'.repeat(64), requiredJobs: ['test'], mergeTriggersDeploy: false, triggerPolicy: { reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), productionExcluded: true, fingerprint: 'd'.repeat(64) }, environments: {} }])), maxGrantSeconds: 3600, freezeWindows: [] } }
  const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { directMessages: true, chats: [], otherChats: 'none' } } }, policy: { sources: { feishu: { allowed: [{ id: 'owner' }, { id: 'other' }] } } } })
  const health = { set: vi.fn(), get: vi.fn(), release: vi.fn() }
  const operations: ReleaseOperation[] = []
  const runner = { preflight: vi.fn(async () => ({ ok: true, problems: [] })), run: vi.fn(async (): Promise<RunResult> => ({ outcome: 'failed', summary: '不可确认完成。'.repeat(1000), writerStopped: true, evidence: [] })), operations: () => operations }
  let delivery!: (payload: unknown, id: string) => Promise<void>
  const enqueue = vi.fn()
  const delivered = vi.fn(async () => 'sent' as const)
  const open = () => {
    const store = new Store(join(root, 'host.sqlite'))
    const outbox = new Outbox({ store, effects: { handle: vi.fn((_kind, handler) => { delivery = handler as typeof delivery }), enqueue, cancel: vi.fn(), idle: vi.fn(async () => {}) }, sources: { instance: vi.fn(() => ({ enabled: true }) as never), channelAllowed: vi.fn(() => true), send: delivered }, commands: {} as never, paused: () => false })
    const send = vi.spyOn(outbox, 'send')
    const adapter = new NightAdapter({ config, settings: () => settings, outbox, health, runner })
    return { store, outbox, send, adapter }
  }
  const first = open()
  const f = { root, config, settings, health, runner, operations, enqueue, delivered, ...first,
    async reopen() { await f.adapter.close(); f.store.close(); Object.assign(f, open()) },
    event(text: string, id = `replay-${++sequence}`, actor = 'owner'): Trigger { return { id, source: 'feishu', actor: { source: 'feishu', id: actor }, human: true, addressed: 'direct', at: new Date().toISOString(), text, meta: { direct: true }, threads: [], channel: { source: 'feishu', thread: 'feishu:dm-owner', address: { chatId: 'dm-owner', messageId: id, direct: 'true' } } } },
    async deliverPending() { for (const receipt of f.store.receipts.waiting()) await delivery({}, receipt.id) },
    rawReply(id: string) { const db = new DatabaseSync(join(config.stateDir, 'nightshift.sqlite'), { readOnly: true }); try { const row = db.prepare('SELECT value FROM outbox WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as { id: string; text: string } : undefined } finally { db.close() } },
    bounded() { for (const receipt of f.store.receipts.waiting()) { expect(wordCount(receipt.text)).toBeLessThanOrEqual(100); expect(() => checkedImText(receipt.text)).not.toThrow() } },
  }
  fixtures.push(f); return f
}
function historyContext(f: ReturnType<typeof fixture>) {
  const at = Date.now() - 5000
  const message = Object.freeze({ message_id: 'om-original', chat_id: 'dm-owner', create_time: String(at), root_id: 'om-original', thread_id: 'omt-original', sender: { id: 'owner', sender_type: 'user' }, body: { content: JSON.stringify({ text: original }) } })
  const lark = vi.fn(async (_args: string[]) => ({ has_more: false, items: [message] }))
  const commands = { lark, withSignal: () => commands }
  const ctx = { commands, state: { get: (key: { name: string } | string) => f.store.get(typeof key === 'string' ? key : key.name), set: (key: { name: string } | string, value: unknown) => f.store.set(typeof key === 'string' ? key : key.name, value) }, threads: { subscribed: () => [], describe: vi.fn() }, deployment: { feishu: { botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu' } }, receive: (trigger: Trigger) => f.adapter.receive(trigger) } as unknown as SourceContext
  return { ctx, lark, since: new Date(at - 1000).toISOString(), until: new Date(at + 1000).toISOString() }
}

describe('durable private IM recovery and replay', () => {
  it('recovers immutable Feishu chat/thread history once across close/reopen without authorization or execution', async () => {
    const f = fixture(); const history = historyContext(f)
    await backfillChat(history.ctx, 'dm-owner', true, history.since, history.until, new AbortController().signal)
    const containers = history.lark.mock.calls.map(([args]) => JSON.parse(args[args.indexOf('--params') + 1]!).container_id_type)
    expect(containers).toEqual(['chat', 'thread'])
    const task = f.adapter.snapshot().tasks[0]!
    expect(f.adapter.snapshot().tasks).toHaveLength(1)
    expect(task).toMatchObject({ text: original, approved: false, state: 'queued', proposal: { requiresScopeConfirmation: true } })
    expect(task.releaseGrant).toBeUndefined(); expect(task.actions).toBeUndefined(); expect(f.runner.run).not.toHaveBeenCalled()
    f.bounded(); await f.deliverPending(); expect(f.delivered).toHaveBeenCalledTimes(1)
    await f.reopen()
    await backfillChat(history.ctx, 'dm-owner', true, history.since, history.until, new AbortController().signal)
    expect(f.adapter.snapshot().tasks.map(item => item.id)).toEqual([task.id])
    expect(f.adapter.snapshot().tasks[0]!.approved).toBe(false); expect(f.runner.run).not.toHaveBeenCalled(); expect(f.enqueue).toHaveBeenCalledTimes(1)
    await f.adapter.receive(f.event('状态', 'status-after-replay')); f.bounded(); await f.deliverPending()
    expect(f.delivered).toHaveBeenCalledTimes(2)
    expect(f.health.set.mock.calls.some(([value]) => value.state === 'error')).toBe(false)
  })
  it('retains original controller receipt after failed Outbox enqueue and sends exactly once on replay', async () => {
    const f = fixture(); const event = f.event(original, 'om-enqueue-failure')
    f.send.mockImplementation(() => { throw new Error('simulated durable Outbox admission failure') })
    await f.adapter.receive(event)
    expect(f.adapter.snapshot().tasks).toHaveLength(1)
    expect(f.adapter.controller.pendingReplies()).toHaveLength(1)
    expect(f.store.receipts.waiting()).toEqual([])
    await f.reopen() // close still fails transfer; reopening uses a real healthy Outbox
    expect(f.adapter.controller.pendingReplies()).toEqual([])
    expect(f.store.receipts.waiting()).toHaveLength(1)
    await f.adapter.receive(event); expect(f.adapter.snapshot().tasks).toHaveLength(1)
    expect(f.store.receipts.waiting()).toHaveLength(1); expect(f.enqueue).toHaveBeenCalledTimes(1)
    await f.deliverPending(); expect(f.delivered).toHaveBeenCalledTimes(1)
    await f.reopen(); await f.adapter.receive(event); await f.deliverPending()
    expect(f.delivered).toHaveBeenCalledTimes(1); expect(f.runner.run).not.toHaveBeenCalled()
  })
  it('bounds oversized grants/release status while keeping durable owner-only full grant receipts', async () => {
    const f = fixture(16); const names = Object.keys(f.config.repositories)
    await f.adapter.receive(f.event(`入队 修改 ${names.join(',')} | 只建立待批准任务`, 'multi-task'))
    const task = f.adapter.snapshot().tasks[0]!
    await f.adapter.receive(f.event(`批准任务 ${task.id}`, 'approve-task'))
    const scopes: ReleaseScope[] = names.map(repository => ({ repository, sourceBranch: `sdd/${task.id}`, targetBranch: 'master', baseSha: 'a'.repeat(40), actions: ['push', 'create_mr'] }))
    const expires = new Date(Date.now() + 120000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await f.adapter.receive(f.event(`预授权发布 ${task.id} 截止 ${expires} | ${JSON.stringify(scopes)}`, 'grant-oversize'))
    const stored = f.rawReply('grant-oversize:reply')!
    expect(wordCount(stored.text)).toBeGreaterThan(100)
    expect(f.adapter.snapshot().tasks[0]!.releaseGrant).toBeDefined()
    const sent = f.send.mock.calls.at(-1)![0]; expect(sent.text).toContain('非完整回执'); expect(sent.text).toContain('回复详情 grant-oversize:reply')
    expect(f.runner.run).not.toHaveBeenCalled(); f.bounded()
    await f.reopen()
    await f.adapter.receive(f.event('回复详情 grant-oversize:reply 1', 'owned-detail'))
    expect(f.send.mock.calls.at(-1)![0].text).toContain('分页摘录')
    await f.adapter.receive(f.event('回复详情 grant-oversize:reply 1', 'denied-detail', 'other'))
    expect(f.send.mock.calls.at(-1)![0].text).toContain('不属于本人')
    f.operations.push({ id: 'op-oversize', taskId: task.id, grantId: 'grant', logicalKey: 'key', repository: 'mate-manage-web', action: 'merge', sha: 'a'.repeat(40), policyDigest: 'b'.repeat(64), state: 'unknown', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), remoteIds: [], detail: '远端结果不明，不得接班。'.repeat(1000) })
    await f.adapter.receive(f.event('发布状态', 'long-status'))
    expect(f.send.mock.calls.at(-1)![0].text).toContain('分页摘录'); f.bounded()
    expect(f.rawReply('grant-oversize:reply')!.text).toBe(stored.text)
  })
  it('keeps oversized finish receipt retrievable after restart and does not rerun a finished task on source replay', async () => {
    const f = fixture(); const source = f.event('入队 只读 mate-manage-web | 核查本地说明', 'finish-source')
    await f.adapter.receive(source); const id = f.adapter.snapshot().tasks[0]!.id
    await f.adapter.receive(f.event(`批准任务 ${id}`, 'finish-approve'))
    await f.adapter.receive(f.event('开始夜班 截止 ' + new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'), 'finish-start'))
    await vi.waitFor(() => expect(f.adapter.snapshot().tasks[0]!.state).toBe('failed'))
    await vi.waitFor(() => expect(f.send.mock.calls.some(([message]) => message.text.includes('回复详情 run:'))).toBe(true), { timeout: 2000 })
    const task = f.adapter.snapshot().tasks[0]!, replyId = `run:${task.runId}:finished`, originalReceipt = f.rawReply(replyId)!.text
    expect(wordCount(originalReceipt)).toBeGreaterThan(100); f.bounded()
    await f.reopen(); await f.adapter.receive(source)
    await f.adapter.receive(f.event(`回复详情 ${replyId} 1`, 'finish-detail'))
    expect(f.send.mock.calls.at(-1)![0].text).toContain('分页摘录')
    await f.adapter.receive(f.event(`回复详情 ${replyId} 1`, 'finish-detail-denied', 'other'))
    expect(f.send.mock.calls.at(-1)![0].text).toContain('不属于本人')
    expect(f.rawReply(replyId)!.text).toBe(originalReceipt); expect(f.runner.run).toHaveBeenCalledTimes(1); expect(f.adapter.snapshot().tasks).toHaveLength(1); f.bounded()
  })
})
