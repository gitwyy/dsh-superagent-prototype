/** Feishu-to-nightshift adapter. Reuses the existing Source and Outbox; never starts a second event consumer. */
import { key, type ReceiveResult, type Trigger } from '../core/index.ts'
import { allowedSender, type Settings } from '../policy.ts'
import type { Outbox } from '../app/outbox.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { NightConfig, NightController, Runner, Incoming } from './contracts.ts'
import { createController } from './controller.ts'
import { parseNightCommand } from './commands.ts'
import { parseNightProposal } from './proposals.ts'
import { boundedNightReply, replyPage } from './replies.ts'
import type { ManagedRunner } from './release/managed-runner.ts'

export interface NightAdapterHost {
  settings(): Settings
  outbox: Pick<Outbox, 'send'>
  health: HealthEntry
  config: NightConfig
  runner: Runner & Partial<Pick<ManagedRunner, 'operations' | 'reconcile'>>
}
/** Authenticates direct messages and transfers durable supervisor receipts into the existing Outbox. */
export class NightAdapter {
  readonly controller: NightController
  private readonly timer: ReturnType<typeof setInterval>
  private lastMode?: string
  private lastPause = false
  private closed = false
  constructor(private readonly host: NightAdapterHost) {
    const denied = () => this.dispatchDenied(host.settings())
    this.controller = createController(host.config, {
      preflight: async (config, tasks) => {
        if (denied()) return { ok: false, problems: ['服务暂停或来源/任务所有者授权已撤销。'] }
        const result = await host.runner.preflight(config, tasks)
        return denied() ? { ok: false, problems: ['预检期间授权发生变化。'] } : result
      },
      run: async (request, signal) => {
        if (denied() || !allowedSender(host.settings(), { source: 'feishu', id: request.task.ownerId })) {
          return { outcome: 'blocked', summary: '执行前发现来源/所有者授权已撤销，未启动 pi。', writerStopped: true, evidence: [] }
        }
        return host.runner.run(request, signal)
      },
    })
    this.timer = setInterval(() => this.flush(), 500)
    this.timer.unref?.()
    this.flush()
  }
  private dispatchDenied(settings: Settings): boolean {
    const fs = settings.sources.feishu
    return settings.paused || !fs?.enabled || fs.config.directMessages !== true || fs.config.otherChats !== 'none'
      || !Array.isArray(fs.config.chats) || fs.config.chats.length !== 0
      || this.controller?.snapshot().tasks.some(task => (task.state === 'running' || (task.state === 'queued' && task.approved))
        && !allowedSender(settings, { source: 'feishu', id: task.ownerId })) === true
  }
  /** In dedicated mode, ALL inputs are consumed here; nothing falls through into the old DSH executor. */
  async receive(trigger: Trigger): Promise<ReceiveResult> {
    const s = this.host.settings()
    const denied = this.dispatchDenied(s)
    if (denied && !this.lastPause) {
      this.lastPause = true
      await this.controller.suspend()
    }
    const fs = s.sources.feishu
    if (this.closed || !this.host.config.enabled || !fs?.enabled || trigger.source !== 'feishu' || !trigger.human
      || trigger.addressed !== 'direct' || trigger.meta.direct !== true || !allowedSender(s, trigger.actor)
      || trigger.channel?.source !== 'feishu' || trigger.channel.address.direct !== 'true') return 'filtered'
    const at = Date.parse(trigger.at)
    if (!Number.isFinite(at) || (this.host.config.acceptAfter && at < Date.parse(this.host.config.acceptAfter))) return 'filtered'
    const { chatId, messageId } = trigger.channel.address
    if (!chatId || !messageId) return 'filtered'
    const incoming: Incoming = { id: trigger.id, actorId: trigger.actor.id, text: trigger.text, at: trigger.at,
      direct: true, human: true, target: { source: 'feishu', chatId, messageId } }
    const releaseStatus = /^发布状态(?:\s+([1-9]\d{0,3}))?$/u.exec(trigger.text.trim())
    if (releaseStatus && this.host.runner.operations) {
      const operations = this.host.runner.operations().filter(op => this.controller.snapshot().tasks.some(t => t.id === op.taskId && t.ownerId === incoming.actorId))
      const text = operations.length ? [...operations].reverse().map(op => `${op.id} ${op.repository}/${op.action} ${op.state} ${op.sha.slice(0, 12)}\n${op.detail}`).join('\n') : '没有本人的远端发布记录；未执行远端动作。'
      const page = replyPage(text, Number(releaseStatus[1] ?? 1))
      this.host.outbox.send({ id: key('release-status', trigger.id), channel: trigger.channel, kind: 'reply',
        text: boundedNightReply(`${page.text}\n查看其他页：发布状态 <页码>。`) })
      return 'stored'
    }
    const reconcile = /^核查发布\s+([a-zA-Z0-9-]{1,100})$/u.exec(trigger.text.trim())
    if (reconcile && this.host.runner.operations && this.host.runner.reconcile) {
      const operation = this.host.runner.operations().find(op => op.id === reconcile[1])
      if (!operation || !this.controller.snapshot().tasks.some(t => t.id === operation.taskId && t.ownerId === incoming.actorId)) return 'filtered'
      const result = await this.host.runner.reconcile(operation.id, AbortSignal.timeout(30000))
      this.host.outbox.send({ id: key('release-reconcile', trigger.id), channel: trigger.channel, kind: 'reply',
        text: boundedNightReply(`${result.operationId ?? operation.id} ${result.status}\n${result.detail}\n远端活动或结果不明：${result.remoteActive ? '是' : '否'}。本操作只读核查，没有重新触发。`) })
      return 'stored'
    }
    let command
    try { command = parseNightCommand(trigger.text) }
    catch {
      const proposal = parseNightProposal(trigger.text, Object.keys(this.host.config.repositories))
      if (proposal) command = { type: 'propose' as const, ...proposal }
      else {
        this.host.outbox.send({ id: key('night-invalid', trigger.id), channel: trigger.channel, kind: 'reply',
          text: '这条消息没有执行：指令格式或任务范围不明确。可说“处理 mate-manage-web#84”生成待确认任务，或用“入队 只读 仓名 | 任务说明”。查看：帮助／帮助 任务／帮助 发布。' })
        return 'stored'
      }
    }
    // Controls that stop work must remain usable when the ordinary application is paused.
    if (denied && !['status', 'help', 'task-detail', 'reply-detail', 'pause', 'handoff', 'cancel'].includes(command.type)) {
      this.host.outbox.send({ id: key('night-paused', trigger.id), channel: trigger.channel, kind: 'reply',
        text: '服务管理开关已暂停；未启动或批准任务。可发送“状态”或“我要接班”。' })
      return 'stored'
    }
    await this.controller.handle(incoming, command)
    this.flush()
    return 'stored'
  }
  snapshot() {
    return { enabled: this.host.config.enabled, workspace: this.host.config.workspace,
      sessionFile: this.host.config.sessionFile, repositories: Object.keys(this.host.config.repositories),
      ...(this.host.config.releasePolicy ? { releaseEnabled: this.host.config.releasePolicy.enabled,
        releaseAllowedActions: this.host.config.releasePolicy.allowedActions ?? ['push', 'create_mr', 'merge', 'deploy'],
        releaseOperations: this.host.runner.operations?.() ?? [] } : {}),
      ...this.controller.snapshot() }
  }
  private flush(): void {
    if (this.closed) return
    try {
      const settings = this.host.settings()
      const paused = this.dispatchDenied(settings)
      if (paused && !this.lastPause) void this.controller.suspend().catch(error => {
        this.host.health.set({ state: 'error', detail: `Nightshift pause failed: ${String(error)}` })
      })
      this.lastPause = paused
      for (const message of this.controller.pendingReplies()) {
        this.host.outbox.send({ id: key('night-out', message.id), kind: 'reply', text: boundedNightReply(message.text, `回复详情 ${message.id}`),
          channel: { source: 'feishu', thread: `feishu:${message.target.chatId}`,
            address: { chatId: message.target.chatId, messageId: message.target.messageId, direct: 'true' } } })
        // Superagent's Outbox durably owns retries once send() commits. Replay uses the same ID.
        this.controller.markReplySent(message.id)
      }
      const state = this.controller.snapshot()
      if (state.mode !== this.lastMode) {
        this.lastMode = state.mode
        this.host.health.set({ state: state.mode === 'RECOVERY_REQUIRED' ? 'error' : 'ready',
          detail: `Mate v2 nightshift: ${state.mode}${state.problems.length ? `; ${state.problems.join('; ')}` : ''}` })
      }
    } catch (error) {
      this.host.health.set({ state: 'error', detail: `Nightshift receipt/health failure: ${String(error)}` })
    }
  }
  async close(): Promise<void> {
    clearInterval(this.timer)
    this.flush()
    this.closed = true
    // close() persists any final stop receipts; the next startup transfers them into the application outbox.
    await this.controller.close()
  }
}
