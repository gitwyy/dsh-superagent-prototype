/** Serialized, fail-closed supervisor. External awaits never hold the command queue. */
import { randomUUID } from 'node:crypto'
import type { ActionName, Command, Incoming, NightConfig, NightController, PendingReply, PendingActionInput, RunResult, Runner, Task } from './contracts.ts'
import { NightStore, type DurableState, type PendingAction, type PendingCheck } from './store.ts'
import { NIGHT_HELP, NIGHT_HELP_TOPICS } from './commands.ts'
import { replyPage } from './replies.ts'
import { policyDigest, ReleaseGrantSchema } from './release/coordinator.ts'

const MAX_SHIFT_MS = 12 * 60 * 60 * 1000
const STOP_GRACE_MS = 10_000
const iso = () => new Date().toISOString()
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
/** Reject local/ambiguous timestamps, overflow dates and invalid offsets. */
function instant(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return NaN
  const [, y, m, d, h, min, sec, zone] = match
  const year = Number(y), month = Number(m), day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || Number(h) > 23 || Number(min) > 59 || Number(sec ?? 0) > 59
    || (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59))) return NaN
  return Date.parse(value)
}
function checkedResult(value: RunResult): RunResult {
  if (!value || !['succeeded', 'failed', 'cancelled', 'blocked', 'unknown'].includes(value.outcome)
    || typeof value.writerStopped !== 'boolean' || (value.remoteActive !== undefined && typeof value.remoteActive !== 'boolean') || typeof value.summary !== 'string'
    || !Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string')) {
    return { outcome: 'unknown', summary: '执行器返回的停止证据无效。', writerStopped: false, evidence: [] }
  }
  return structuredClone(value)
}
interface Active { runId: string; taskId: string; abort: AbortController; done: Promise<void>; settle: () => void; stopTimer?: ReturnType<typeof setTimeout>; taskTimer?: ReturnType<typeof setTimeout> }

export function createController(config: NightConfig, runner: Runner): NightController { return new Controller(config, runner) }

/** Serializes durable human grants and asynchronous runner completions without blocking stop/status commands. */
class Controller implements NightController {
  private readonly config: NightConfig
  private readonly store: NightStore
  private state: DurableState
  private readonly windows: { from: number; until: number }[]
  private serial: Promise<void> = Promise.resolve()
  private active?: Active
  private dispatchCheck?: string
  private boundaryTimer?: ReturnType<typeof setTimeout>
  private closing = false
  private closed = false
  private recoveryLatched = false
  private closePromise?: Promise<void>
  private readonly shutdownErrors: unknown[] = []
  private closedReplies: PendingReply[] = []

  constructor(config: NightConfig, private readonly runner: Runner) {
    this.config = structuredClone(config)
    if (!Number.isSafeInteger(config.maxTaskSeconds) || config.maxTaskSeconds <= 0 || config.maxTaskSeconds * 1000 > MAX_SHIFT_MS) {
      throw new Error('maxTaskSeconds must be a positive integer no greater than 43200')
    }
    this.windows = config.freezeWindows.map(window => {
      const from = instant(window.from), until = instant(window.until)
      if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) throw new Error('Freeze windows require valid, ordered ISO timestamps with explicit timezone')
      return { from, until }
    }).sort((a, b) => a.from - b.from)
    this.store = new NightStore(this.config)
    this.state = this.store.load()!
    try {
      this.change(state => {
        const interrupted = state.tasks.filter(task => task.state === 'running')
        if (interrupted.length || state.activeRunId || state.pendingCheck || state.mode === 'NIGHT_RUNNING' || state.mode === 'HANDOFF_PENDING') {
          state.mode = 'RECOVERY_REQUIRED'
          state.problems = ['监管器重启前授权或任务未完成；必须人工核查恢复，不会自动重跑。']
          if (interrupted.length || state.activeRunId) state.writerStopped = false
          for (const task of interrupted) {
            task.state = 'unknown'; task.endedAt = iso()
            task.result = { outcome: 'unknown', summary: '任务完成结果尚未持久化时监管器重启；禁止自动重跑。', writerStopped: false, evidence: [] }
            this.store.reply(`run:${task.runId ?? task.id}:interrupted`, task.target, `${task.id}：重启后结果 unknown。RECOVERY_REQUIRED；不会自动重跑。`)
          }
          if (state.pendingCheck) this.store.reply(`${state.pendingCheck.id}:final`, state.pendingCheck.target, '准入被重启中断。RECOVERY_REQUIRED；请人工核查后重新 recover。')
          delete state.pendingCheck
          this.completeStops(state, false)
        }
      })
      this.recoveryLatched = this.state.mode === 'RECOVERY_REQUIRED'
      if (this.state.mode !== 'DAY_MANUAL') this.store.acquireWorkspace()
    } catch (error) { this.store.close(this.state.writerStopped); throw error }
  }

  snapshot(): ReturnType<NightController['snapshot']> {
    return structuredClone({ mode: this.state.mode, deadline: this.state.deadline, tasks: this.state.tasks, activeRunId: this.state.activeRunId, problems: this.state.problems })
  }
  pendingReplies(): PendingReply[] { return this.closed ? structuredClone(this.closedReplies) : this.store.pendingReplies() }
  markReplySent(id: string): void {
    if (this.closed) throw new Error('Nightshift controller is closed; acknowledge delivery before closing or after reopening')
    this.store.markReplySent(id)
  }
  private enqueue(action: () => void): Promise<void> {
    const result = this.serial.then(action)
    this.serial = result.catch(() => {})
    return result
  }
  private background(action: () => void): void {
    void this.enqueue(() => { if (!this.closed) action() }).catch(error => this.failClosed(error))
  }
  private failClosed(error: unknown): void {
    if (this.closed) return
    if (this.closing) this.shutdownErrors.push(error)
    this.recoveryLatched = true
    this.dispatchCheck = undefined
    this.requestAbort()
    clearTimeout(this.boundaryTimer)
    this.state.mode = 'RECOVERY_REQUIRED'
    this.state.writerStopped = !this.active && this.state.writerStopped
    this.state.problems = [`监管器持久化/状态切换失败：${errorText(error)}`]
    try { this.store.save(this.state) } catch { /* Keep reservation; no further dispatch even if storage failed. */ }
  }
  /** Publish state only after its replies and inbox receipt commit together. */
  private change(body: (state: DurableState) => void): void {
    const next = structuredClone(this.state)
    this.store.transaction(() => { body(next); this.store.save(next) })
    this.state = next
    if (next.mode === 'RECOVERY_REQUIRED') this.recoveryLatched = true
  }
  private frozen(now = Date.now()): boolean { return this.windows.some(window => window.from <= now && now < window.until) }
  private boundary(): number { return Math.min(instant(this.state.deadline ?? ''), ...this.windows.filter(window => window.from > Date.now()).map(window => window.from)) }
  private grantValid(): boolean { return this.config.enabled && !this.closing && this.state.mode === 'NIGHT_RUNNING' && Number.isFinite(instant(this.state.deadline ?? '')) && instant(this.state.deadline!) > Date.now() && !this.frozen() }
  private taskAllowed(task: Task): boolean {
    return task.state === 'queued' && task.approved === true && !!task.approveMessageId && !!task.ownerId && task.proposal?.requiresScopeConfirmation !== true
      && (task.access === 'read' || task.access === 'write') && task.repositories.length > 0
      && task.repositories.every(repository => Object.hasOwn(this.config.repositories, repository))
  }

  handle(input: Incoming, command: Command): Promise<void> {
    // Do not retain caller-owned mutable objects across the serialized boundary.
    input = structuredClone(input); command = structuredClone(command)
    return this.enqueue(() => {
      if (this.closed || this.closing) throw new Error('Nightshift controller is closing')
      if (this.store.seen(input.id)) return
      this.store.assertOwned()
      let check: PendingCheck | undefined
      let stop = false
      this.change(state => {
        this.store.receive(input.id, input.actorId, iso())
        const reply = (text: string) => this.store.reply(`${input.id}:reply`, input.target, text)
        if (!input.id || !input.actorId || !input.direct || !input.human || input.target.source !== 'feishu' || !input.target.chatId || !input.target.messageId) {
          // Ignore groups/bots entirely: no group replies and no disclosure of private task state.
          return
        }
        if (command.type === 'status') {
          const mine = state.tasks.filter(task => task.ownerId === input.actorId), page = command.page ?? 1
          const pages = Math.max(1, Math.ceil(mine.length / 2)), start = (page - 1) * 2
          if (!Number.isSafeInteger(page) || page < 1 || page > pages) { reply(`页码无效；状态共${pages}页。`); return }
          const tasks = [...mine].reverse().slice(start, start + 2).map(task => `${task.id} ${task.state}/${task.proposal?.requiresScopeConfirmation ? '待确认范围' : task.approved ? '已批准' : '待批准'}`)
          reply(`${state.mode}｜排队 ${state.tasks.filter(task => task.state === 'queued').length}｜运行 ${state.activeRunId ?? '无'}｜截止 ${state.deadline ?? '无'}\n${tasks.join('\n')}\n状态 ${page}/${pages}；查详情：任务详情 <ID>。${state.problems.length ? '\n存在待核查问题；当前状态不代表可安全接班。' : ''}`); return
        }
        if (command.type === 'help') { reply(command.topic ? NIGHT_HELP_TOPICS[command.topic] : NIGHT_HELP); return }
        if (command.type === 'task-detail') {
          const task = state.tasks.find(task => task.id === command.taskId && task.ownerId === input.actorId)
          if (!task) { reply('拒绝：任务不存在或不属于本人。'); return }
          const full = `任务 ${task.id}\n状态 ${task.state}｜${task.proposal?.requiresScopeConfirmation ? '待明确确认范围' : task.approved ? '已批准' : '未批准'}\n仓库 ${task.repositories.join(',')}｜权限 ${task.access}\n本地动作 ${task.actions?.join(',') || '无'}｜发布授权 ${task.releaseGrant ? '已记录，以完整授权范围和有效期为准' : '无'}\n原始任务：\n${task.text}${task.result ? `\n执行结果：${task.result.outcome}\n${task.result.summary}\n本地退出${task.result.writerStopped ? '已证' : '未证'}｜远端活动或未知${task.result.remoteActive ? '是' : '否'}` : ''}`
          const part = replyPage(full, command.page ?? 1)
          reply(`${part.text}\n任务详情 ${task.id} <页码>`); return
        }
        if (command.type === 'reply-detail') {
          const stored = this.store.replyForOwner(command.replyId, input.actorId, input.target.chatId)
          if (!stored) { reply('拒绝：回执不存在或不属于本人私聊。'); return }
          const part = replyPage(stored.text, command.page ?? 1)
          reply(`${part.text}\n回复详情 ${command.replyId} <页码>`); return
        }
        if (command.type === 'pause' || command.type === 'handoff') {
          this.invalidateCheck(state)
          const mode = command.type === 'handoff' ? 'DAY_MANUAL' : 'NIGHT_PAUSED'
          if (this.active) {
            state.mode = this.recoveryLatched ? 'RECOVERY_REQUIRED' : 'HANDOFF_PENDING'; state.stopRequests.push({ id: input.id, target: input.target, mode }); stop = true
            reply(`${state.mode}：已请求停止，尚未确认写入进程退出，请勿编辑工作区。`)
          } else if (!state.writerStopped || state.mode === 'RECOVERY_REQUIRED') {
            state.mode = 'RECOVERY_REQUIRED'; reply('RECOVERY_REQUIRED：无法确认写入已停止，未确认交接；请先人工核查并 recover。')
          } else {
            state.mode = mode; delete state.deadline
            reply(`${mode}：受监管写入进程已停止。`)
          }
          return
        }
        if (!this.config.enabled) { reply('夜间功能未启用，不接受任务授权或执行。'); return }
        if (command.type === 'propose-action') {
          this.proposeAction(state, command.action, input, reply)
          return
        }
        if (command.type === 'confirm-action') {
          const pending = state.pendingAction
          if (!pending || pending.ownerId !== input.actorId || pending.chatId !== input.target.chatId) {
            reply('没有等待确认的操作；这条消息没有执行。先说目标，我会复述边界再请你确认。'); return
          }
          delete state.pendingAction
          if (!Number.isFinite(Date.parse(pending.expiresAt)) || Date.parse(pending.expiresAt) <= Date.now()) {
            reply('这次确认已过期，未执行；请重新说一次目标。'); return
          }
          check = this.executePending(state, pending, input, reply)
          return
        }
        if (command.type === 'decline-action') {
          const pending = state.pendingAction
          if (!pending || pending.ownerId !== input.actorId || pending.chatId !== input.target.chatId) { reply('没有等待确认的操作。'); return }
          delete state.pendingAction
          const drafted = pending.request.kind === 'task-scope' && pending.request.taskId
            ? state.tasks.find(task => task.id === pending.request.taskId && task.ownerId === input.actorId && task.state === 'queued' && task.proposal?.requiresScopeConfirmation === true)
            : undefined
          if (drafted) { drafted.state = 'cancelled'; drafted.endedAt = iso(); reply('已取消，未执行；刚生成的草案也已取消。') }
          else reply('已取消，未执行。')
          return
        }
        if (command.type === 'enqueue' || command.type === 'propose') {
          if (!command.text.trim() || command.text.length > 12000 || command.repositories.length === 0 || command.repositories.some(repository => !Object.hasOwn(this.config.repositories, repository)) || !['read', 'write'].includes(command.access)) {
            reply('拒绝：请提供任务内容、已配置的仓库别名和明确的 read/write 权限。'); return
          }
          const task: Task = { id: randomUUID(), originId: input.id, ownerId: input.actorId, text: command.text, repositories: [...new Set(command.repositories)], access: command.access, approved: false, target: input.target, state: 'queued', createdAt: iso() }
          if (command.type === 'propose') task.proposal = { requiresScopeConfirmation: true, issueRefs: (command.issueRefs ?? []).slice(0, 20) }
          state.tasks.push(task)
          if (task.proposal) reply(`已生成待确认任务 ${task.id}。\n建议范围：${task.repositories.join(',')}／${task.access === 'write' ? '修改' : '只读'}；跨域范围未自动扩展。\n原文已保存，可查任务详情 ${task.id}。\n请明确：确认任务 ${task.id} ${task.access === 'write' ? '修改' : '只读'} ${task.repositories.join(',')}\n未授权提交/发布，未启动。`)
          else reply(`已排队 ${task.id}｜${task.repositories.join(',')}｜${task.access}。需任务所有者明确批准；添加任务不会启动夜间执行。`)
        } else if (command.type === 'confirm-task') {
          const task = state.tasks.find(task => task.id === command.taskId && task.ownerId === input.actorId)
          if (!task || task.state !== 'queued' || task.proposal?.requiresScopeConfirmation !== true || state.mode === 'RECOVERY_REQUIRED'
            || !['read', 'write'].includes(command.access) || command.repositories.length === 0 || command.repositories.some(repo => !Object.hasOwn(this.config.repositories, repo))) {
            reply('拒绝：只有本人未启动的草案可确认；须提供准确白名单仓库及只读/修改权限。'); return
          }
          task.repositories = [...new Set(command.repositories)]; task.access = command.access
          task.proposal.requiresScopeConfirmation = false; task.proposal.confirmedMessageId = input.id
          // Confirm scope only. Approval remains a separate action so confirmation never starts work in a running shift.
          task.approved = false; delete task.approveMessageId; delete task.actions; delete task.actionsApproveMessageId; delete task.releaseGrant
          reply(`范围已确认 ${task.id}｜${task.repositories.join(',')}｜${task.access}。\n下一步：批准任务 ${task.id}。\n未授权提交/发布，未启动；如夜班已运行，批准后可能立即调度。`)
        } else if (command.type === 'authorize-release') {
          const task = state.tasks.find(item => item.id === command.taskId), policy = this.config.releasePolicy
          if (!task || task.ownerId !== input.actorId || task.state !== 'queued' || !task.approved || task.access !== 'write'
            || state.mode === 'RECOVERY_REQUIRED' || !policy?.enabled) {
            reply('拒绝：发布策略未启用，或不是本人已批准的排队写任务。'); return
          }
          const expires = instant(command.expiresAt), time = Date.now()
          if (!Number.isFinite(expires) || expires <= time || expires - time > policy.maxGrantSeconds * 1000 || this.frozen(time)
            || this.windows.some(w => w.from < expires && w.until > time)) {
            reply('拒绝：发布有效期须在允许时限内且不能跨越冻结窗口。'); return
          }
          const parsed = ReleaseGrantSchema.safeParse({ id: randomUUID(), taskId: task.id, ownerId: task.ownerId,
            approvalMessageId: input.id, issuedAt: iso(), expiresAt: command.expiresAt,
            policyDigest: policyDigest(policy), scopes: command.scopes })
          if (!parsed.success || parsed.data.scopes.some(scope => {
            const repo = policy.repositories[scope.repository]
            return (policy.allowedActions !== undefined && scope.actions.some(action => !policy.allowedActions!.includes(action)))
              || !task.repositories.includes(scope.repository) || !repo || repo.targetBranch !== scope.targetBranch
              || (scope.environment && !repo.environments[scope.environment])
              || (repo.mergeTriggersDeploy && scope.actions.includes('merge') && (!scope.actions.includes('deploy') || !scope.environment))
              || (scope.actions.includes('deploy') && (!scope.actions.includes('merge') || !scope.environment))
          })) { reply('拒绝：发布范围、目标分支或测试部署联动授权不完整。'); return }
          task.releaseGrant = parsed.data
          reply(`发布预授权已记录 ${task.id}｜截止 ${parsed.data.expiresAt}｜${parsed.data.scopes.map(s => `${s.repository}:${s.sourceBranch}→${s.targetBranch}/${s.environment ?? '无部署'}/${s.actions.join(',')}`).join('；')}。执行仍需夜班启动与逐步证据门禁；deploy 只跟踪合并触发的部署，不重复触发 Jenkins。`)
        } else if (command.type === 'authorize-actions') {
          this.grantActions(state, command.taskId, command.actions, input, reply)
        } else if (command.type === 'approve' || command.type === 'cancel') {
          const task = state.tasks.find(item => item.id === command.taskId)
          if (!task || task.ownerId !== input.actorId) { reply('拒绝：任务不存在，或发送者不是任务所有者。'); return }
          if (command.type === 'approve') {
            if (task.state !== 'queued' || state.mode === 'RECOVERY_REQUIRED') { reply('拒绝：只能在非恢复状态批准排队中的任务。'); return }
            if (task.proposal?.requiresScopeConfirmation) { reply(`拒绝：请先确认准确范围：确认任务 ${task.id} 只读|修改 仓名。草案不视为执行授权。`); return }
            task.approved = true; task.approveMessageId = input.id
            reply(`已批准 ${task.id}｜仓库 ${task.repositories.join(',')}｜权限 ${task.access}。执行仍需有效的夜间时限授权。`)
          } else if (task.state === 'queued') {
            task.state = 'cancelled'; task.endedAt = iso(); reply(`已取消排队任务 ${task.id}。`)
          } else if (task.state === 'running' && this.active?.taskId === task.id) {
            this.invalidateCheck(state); state.mode = 'HANDOFF_PENDING'
            state.stopRequests.push({ id: input.id, target: input.target, mode: 'NIGHT_PAUSED' }); stop = true
            reply(`已请求取消 ${task.id}；尚未确认写入进程退出。`)
          } else reply(`任务 ${task.id} 当前为 ${task.state}，不会自动重跑。`)
        } else if (command.type === 'start' || command.type === 'recover') {
          if (this.active || state.pendingCheck || this.dispatchCheck || state.mode === 'HANDOFF_PENDING') { reply('拒绝：已有任务或准入检查正在进行。'); return }
          if (command.type === 'start') {
            const deadline = instant(command.deadline), now = Date.now()
            if (!state.writerStopped || state.mode === 'RECOVERY_REQUIRED') { reply('拒绝：启动前必须先显式 recover。'); return }
            if (state.mode === 'NIGHT_RUNNING') { reply('拒绝：夜间授权已生效；修改截止时间前请先 pause。'); return }
            if (!Number.isFinite(deadline) || deadline <= now || deadline - now > MAX_SHIFT_MS || this.frozen(now)) { reply('拒绝：截止时间须为未来12小时内、带明确时区的 ISO 时间，且当前不在冻结窗口。'); return }
            check = { id: input.id, target: input.target, kind: 'start', deadline: new Date(deadline).toISOString() }
          } else {
            if (state.mode !== 'RECOVERY_REQUIRED' || command.acknowledged !== true) { reply('拒绝：recover 仅用于 RECOVERY_REQUIRED，且必须由人工明确确认已核查异常写入。'); return }
            check = { id: input.id, target: input.target, kind: 'recover' }
          }
          try { this.store.acquireWorkspace() } catch (error) { check = undefined; reply(`拒绝：工作区锁不可用。${errorText(error)}`); return }
          state.pendingCheck = check
          reply('预检中；尚未确认夜间启动或安全交接。')
        }
      })
      if (this.state.mode === 'DAY_MANUAL' && !this.state.pendingCheck && this.state.writerStopped) this.store.releaseWorkspace()
      if (stop) this.requestAbort()
      if (check) this.preflight(check)
      this.pump()
    }).catch(error => { this.failClosed(error); throw error })
  }

  private createProposal(state: DurableState, text: string, repositories: string[], access: 'read' | 'write',
    issueRefs: string[] | undefined, input: Incoming): Task {
    const task: Task = { id: randomUUID(), originId: input.id, ownerId: input.actorId, text, repositories: [...new Set(repositories)],
      access, approved: false, target: input.target, state: 'queued', createdAt: iso(),
      proposal: { requiresScopeConfirmation: true, issueRefs: (issueRefs ?? []).slice(0, 20) } }
    state.tasks.push(task)
    return task
  }
  /** Stage exactly one action with its human-readable boundary; confirmation performs only this. */
  private stage(state: DurableState, input: Incoming, request: PendingActionInput, summary: string): void {
    state.pendingAction = { id: randomUUID(), ownerId: input.actorId, chatId: input.target.chatId,
      createdAt: iso(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), request, summary }
  }
  private pickTask(state: DurableState, input: Incoming, taskId: string | undefined): Task | undefined {
    const mine = state.tasks.filter(task => task.ownerId === input.actorId && ['queued', 'running'].includes(task.state)
      && task.proposal?.requiresScopeConfirmation !== true)
    if (taskId) return mine.find(task => task.id === taskId)
    const approved = mine.filter(task => task.approved)
    return approved.length === 1 ? approved[0] : mine.length === 1 ? mine[0] : undefined
  }
  private proposeAction(state: DurableState, request: PendingActionInput, input: Incoming, reply: (text: string) => void): void {
    if (!request || typeof request !== 'object') { reply('这条消息没有执行：目标不清楚。'); return }
    const now = Date.now()
    if (request.kind === 'task-proposal') {
      const text = typeof request.text === 'string' ? request.text.trim() : ''
      const requested = Array.isArray(request.repositories) ? [...new Set(request.repositories)] : []
      const repositories = requested.filter(name => Object.hasOwn(this.config.repositories, name))
      const access = request.access === 'read' ? 'read' : 'write'
      if (!text || text.length > 12000 || !repositories.length || repositories.length !== requested.length) {
        reply('这条消息没有执行：任务范围不明确或包含未配置的仓库。'); return
      }
      const existing = state.tasks.find(task => task.ownerId === input.actorId && task.state === 'queued'
        && task.proposal?.requiresScopeConfirmation === true && task.repositories.join(',') === repositories.join(',')
        && (request.issueRefs?.length ? task.proposal.issueRefs.some(ref => request.issueRefs!.includes(ref)) : task.text === text))
      // Reuse the same draft, but refresh its text: a later attempt may carry host-injected issue context.
      if (existing) { existing.text = text; existing.repositories = repositories; existing.access = access }
      const task = existing ?? this.createProposal(state, text, repositories, access, request.issueRefs, input)
      this.stage(state, input, { kind: 'task-scope', taskId: task.id }, repositories.join(','))
      reply(`将登记一个待执行任务：\n范围 ${repositories.join(',')}（${access === 'read' ? '只读' : '修改'}）。\n不含提交、推送、合并、部署，也不会自动执行。\n确认这个范围吗？回复“确认”，或“算了”。`)
      return
    }
    if (request.kind === 'start') {
      if (state.mode === 'RECOVERY_REQUIRED' || (state.mode !== 'NIGHT_RUNNING' && !state.writerStopped)) { reply('当前是恢复态，需要先人工核查。说“可以恢复”，我再确认。'); return }
      if (state.mode !== 'NIGHT_RUNNING' && (this.active || state.pendingCheck || this.dispatchCheck || state.mode === 'HANDOFF_PENDING')) { reply('现在有任务或准入检查在进行，完成或停止后再开始新的。'); return }
      const eligible = state.tasks.filter(task => task.ownerId === input.actorId && task.state === 'queued' && task.proposal?.requiresScopeConfirmation !== true)
      if (!eligible.length) { reply('没有可执行的任务；先告诉我处理哪个仓库和问题。'); return }
      const names = eligible.map(task => `${task.repositories.join(',')}（${task.access === 'read' ? '只读' : '修改'}）`).join('；')
      // A running shift already holds the authorization window: approve now, do not demand a new start.
      if (state.mode === 'NIGHT_RUNNING') {
        if (!this.grantValid()) { reply('夜班运行授权已失效；请重新开始并给截止时间。'); return }
        this.stage(state, input, { kind: 'start', deadline: state.deadline, taskId: eligible[0]!.id }, names)
        reply(`夜班已在运行（截止 ${state.deadline}）。将批准并在该时间内启动 ${eligible.length} 个任务：${names}。\n只执行已确认范围；提交、推送、合并、部署仍各自授权。\n确认吗？回复“确认”，或“算了”。`)
        return
      }
      const deadlineMs = typeof request.deadline === 'string' ? instant(request.deadline) : NaN
      if (!Number.isFinite(deadlineMs) || deadlineMs <= now || deadlineMs - now > MAX_SHIFT_MS || this.frozen(now)) {
        reply('截止时间须在未来12小时内、带明确时区，且不跨越冻结窗口。'); return
      }
      this.stage(state, input, { kind: 'start', deadline: request.deadline, taskId: eligible[0]!.id }, names)
      reply(`将批准并启动 ${eligible.length} 个任务：${names}。\n截止 ${request.deadline}。\n只执行已确认范围；提交、推送、合并、部署仍各自授权。\n确认开始吗？回复“确认”，或“算了”。`)
      return
    }
    if (request.kind === 'allow-commit') {
      const task = this.pickTask(state, input, request.taskId)
      if (!task) { reply('没有唯一对应的任务；先告诉我处理哪个仓库和问题。'); return }
      if (!task.approved) { reply('任务还没有批准；先说“开始”并给截止时间，批准后再授权提交。'); return }
      this.stage(state, input, { kind: 'allow-commit', taskId: task.id }, task.repositories.join(','))
      reply(`将允许任务范围 ${task.repositories.join(',')} 的本地验证和提交。\n不含推送、合并、部署，也不允许任意 shell。\n确认授权吗？回复“确认”，或“算了”。`)
      return
    }
    if (request.kind === 'recover') {
      if (state.mode !== 'RECOVERY_REQUIRED') { reply('当前不是恢复态，无需恢复。'); return }
      this.stage(state, input, { kind: 'recover' }, '恢复')
      reply('将把状态恢复为人工模式，unknown 任务保持原状、不重跑。\n确认已核查现场并恢复吗？回复“确认”，或“算了”。')
      return
    }
    reply('这条消息没有执行：目标不清楚。')
  }
  private executePending(state: DurableState, pending: PendingAction, input: Incoming, reply: (text: string) => void): PendingCheck | undefined {
    const request = pending.request
    if (request.kind === 'task-scope') {
      const task = state.tasks.find(item => item.id === request.taskId && item.ownerId === input.actorId)
      if (!task || task.state !== 'queued' || task.proposal?.requiresScopeConfirmation !== true) { reply('任务状态已变化，未执行。'); return }
      task.proposal.requiresScopeConfirmation = false
      task.proposal.confirmedMessageId = input.id
      task.approved = false; delete task.approveMessageId; delete task.actions; delete task.actionsApproveMessageId; delete task.releaseGrant
      reply(`范围已确认：${task.repositories.join(',')}（${task.access === 'read' ? '只读' : '修改'}）。\n还没有开始。说“开始，截止今晚八点”这样的时间，我复述后再确认。`)
      return
    }
    if (request.kind === 'start') {
      const deadlineMs = typeof request.deadline === 'string' ? instant(request.deadline) : NaN
      const now = Date.now()
      const eligible = state.tasks.filter(task => task.ownerId === input.actorId && task.state === 'queued' && task.proposal?.requiresScopeConfirmation !== true)
      if (!eligible.length) { reply('没有可执行的任务，未开始。'); return }
      // Already running: approving is the whole action; the existing scheduler will pick the task up.
      if (state.mode === 'NIGHT_RUNNING') {
        if (!this.grantValid()) { reply('夜班运行授权已失效；请重新开始并给截止时间。'); return }
        for (const task of eligible) { task.approved = true; task.approveMessageId = input.id }
        reply(`已批准 ${eligible.length} 个任务；将在当前截止 ${state.deadline} 内执行。`)
        return
      }
      if (this.active || state.pendingCheck || this.dispatchCheck || state.mode === 'HANDOFF_PENDING') {
        reply('当前不能开始：有任务或准入检查在进行。'); return
      }
      if (!Number.isFinite(deadlineMs) || deadlineMs <= now || deadlineMs - now > MAX_SHIFT_MS || this.frozen(now)) {
        reply('当前不能开始：截止时间已不适用。'); return
      }
      const check: PendingCheck = { id: input.id, target: input.target, kind: 'start',
        deadline: new Date(deadlineMs).toISOString(), taskIds: eligible.map(task => task.id) }
      try { this.store.acquireWorkspace() } catch (error) { reply(`拒绝：工作区锁不可用。${errorText(error)}`); return }
      state.pendingCheck = check
      reply('预检中；通过后开始执行，未通过会说明原因。')
      return check
    }
    if (request.kind === 'allow-commit') {
      const task = this.pickTask(state, input, request.taskId)
      if (!task) { reply('任务状态已变化，未执行。'); return }
      this.grantActions(state, task.id, ['validate', 'commit'], input, reply)
      return
    }
    if (request.kind === 'recover') {
      if (state.mode !== 'RECOVERY_REQUIRED' || this.active || state.pendingCheck || this.dispatchCheck) {
        reply('当前不能恢复：不是恢复态，或有任务/准入检查在进行。'); return
      }
      const check: PendingCheck = { id: input.id, target: input.target, kind: 'recover' }
      try { this.store.acquireWorkspace() } catch (error) { reply(`拒绝：工作区锁不可用。${errorText(error)}`); return }
      state.pendingCheck = check
      reply('预检中；通过后恢复到人工模式，unknown 任务不会重跑。')
      return check
    }
    reply('这条消息没有执行：目标不清楚。')
  }
  private grantActions(state: DurableState, taskId: string, actions: ActionName[], input: Incoming, reply: (text: string) => void): void {
    const task = state.tasks.find(item => item.id === taskId)
    if (!task || task.ownerId !== input.actorId || !['queued', 'running'].includes(task.state) || !task.approved || state.mode === 'RECOVERY_REQUIRED') {
      reply('拒绝：只有任务所有者可为已批准的任务授权额外动作。'); return
    }
    if (!actions.length || actions.some(a => !['validate', 'commit', 'publish'].includes(a))
      || (task.access !== 'write' && actions.some(a => a !== 'validate'))) {
      reply('拒绝：动作范围无效，提交/发布还要求任务 write 权限。'); return
    }
    const missing = task.repositories.filter(repo => !this.config.repositoryActions?.[repo])
    if (missing.length) { reply(`拒绝：仓库尚无本地受审动作配置：${missing.join(',')}。`); return }
    if (actions.includes('publish')) { reply('发布尚未启用：需先验证专用发布身份与远端边界；未授予 publish。'); return }
    task.actions = [...new Set(actions)]
    task.actionsApproveMessageId = input.id
    reply(`已授权动作 ${task.id}：${task.actions.join(',')}。验证会执行本地配置中固定的受信任程序；不授予任意 shell、合并、部署或群消息权限。${task.state === 'running' ? '\n任务已在运行，本次授权可能从本轮之后的步骤生效；需要立即生效请先停下再启动。' : ''}`)
  }

  private invalidateCheck(state: DurableState): void {
    this.dispatchCheck = undefined
    if (state.pendingCheck) this.store.reply(`${state.pendingCheck.id}:final`, state.pendingCheck.target, '准入已被后续停止操作取消；如需运行，请重新 start/recover。')
    delete state.pendingCheck
  }
  private preflight(check: PendingCheck): void {
    const tasks = structuredClone(this.state.tasks.filter(task => check.kind === 'start' ? this.taskAllowed(task) : task.state === 'unknown' || task.state === 'running'))
    void Promise.resolve().then(() => this.runner.preflight(structuredClone(this.config), tasks)).then(
      result => this.background(() => this.admitted(check, result)),
      error => this.background(() => this.admitted(check, { ok: false, problems: [`预检失败：${errorText(error)}`] })),
    )
  }
  private admitted(check: PendingCheck, result: { ok: boolean; problems: string[] }): void {
    if (this.state.pendingCheck?.id !== check.id || this.closing) return
    this.store.assertWorkspace()
    const problems = Array.isArray(result?.problems) ? result.problems.map(String) : ['预检响应无效']
    const valid = result?.ok === true && problems.length === 0
    this.change(state => {
      delete state.pendingCheck
      if (!valid || (check.kind === 'start' && (this.frozen() || instant(check.deadline!) <= Date.now() || !this.config.enabled))) {
        state.problems = valid ? ['预检期间授权已过期或进入冻结窗口。'] : problems.length ? problems : ['预检未能确认安全。']
        this.store.reply(`${check.id}:final`, check.target, `准入拒绝：${state.problems.join('；')}`)
        return
      }
      state.problems = []
      if (check.kind === 'recover') {
        // Human acknowledgement plus a clean preflight is explicit reconciliation, not replay authorization.
        state.writerStopped = true; state.mode = 'DAY_MANUAL'; delete state.activeRunId; delete state.deadline
        this.completeStops(state, false)
        this.store.reply(`${check.id}:final`, check.target, '人工核查确认及预检通过：DAY_MANUAL。unknown 任务保持原状、不重跑；执行新任务仍需 start。')
      } else {
        state.mode = 'NIGHT_RUNNING'; state.deadline = check.deadline
        // Approval happened by explicit confirmation of the exact scope/task list, and only after preflight passed.
        for (const id of check.taskIds ?? []) {
          const approved = state.tasks.find(task => task.id === id && task.state === 'queued' && task.proposal?.requiresScopeConfirmation !== true)
          if (approved) { approved.approved = true; approved.approveMessageId = check.id }
        }
        this.store.reply(`${check.id}:final`, check.target, `NIGHT_RUNNING｜截止 ${check.deadline}；仅执行已明确批准的排队任务。`)
      }
    })
    if (check.kind === 'recover' && this.state.mode === 'DAY_MANUAL') this.recoveryLatched = false
    if (this.state.mode === 'DAY_MANUAL' && this.state.writerStopped) this.store.releaseWorkspace()
    this.pump()
  }

  private armBoundary(): void {
    clearTimeout(this.boundaryTimer)
    if (!this.grantValid()) return
    this.boundaryTimer = setTimeout(() => this.background(() => this.pump()), Math.max(1, Math.min(this.boundary() - Date.now(), 2_147_483_647)))
    this.boundaryTimer.unref?.()
  }
  private pump(): void {
    if (this.closed || this.closing) return
    if (this.state.mode === 'NIGHT_RUNNING' && !this.grantValid()) {
      this.dispatchCheck = undefined
      this.change(state => { state.mode = this.active ? 'HANDOFF_PENDING' : 'NIGHT_PAUSED'; state.problems = ['夜间授权到期或进入冻结窗口；需重新明确 start。']; delete state.deadline })
      if (this.active) this.requestAbort()
    }
    this.armBoundary()
    if (!this.grantValid() || this.active || this.dispatchCheck) return
    const task = this.state.tasks.find(item => this.taskAllowed(item))
    if (!task) return
    // Recheck each task, not just the first task of a shift. Never hold commands behind this await.
    const token = this.dispatchCheck = randomUUID()
    void Promise.resolve().then(() => this.runner.preflight(structuredClone(this.config), [structuredClone(task)])).then(
      result => this.background(() => this.dispatch(token, task.id, result)),
      error => this.background(() => this.dispatch(token, task.id, { ok: false, problems: [errorText(error)] })),
    )
  }
  private dispatch(token: string, taskId: string, preflight: { ok: boolean; problems: string[] }): void {
    if (this.dispatchCheck !== token) return
    this.dispatchCheck = undefined
    const task = this.state.tasks.find(item => item.id === taskId)
    if (!this.grantValid() || this.active || !task || !this.taskAllowed(task)) { this.pump(); return }
    if (preflight?.ok !== true || !Array.isArray(preflight.problems) || preflight.problems.length > 0) {
      this.change(state => { state.mode = 'NIGHT_PAUSED'; state.problems = preflight?.problems?.length ? preflight.problems.map(String) : ['任务预检未能确认安全。']; delete state.deadline })
      this.armBoundary(); return
    }
    this.store.assertWorkspace()
    const runId = randomUUID()
    const deadline = new Date(Math.min(this.boundary(), Date.now() + this.config.maxTaskSeconds * 1000)).toISOString()
    this.change(state => {
      const next = state.tasks.find(item => item.id === taskId)!
      next.state = 'running'; next.startedAt = iso(); next.runId = runId
      state.activeRunId = runId; state.writerStopped = false
      this.store.reply(`run:${runId}:started`, next.target, `${next.id}：开始执行｜${next.repositories.join(',')}｜${next.access}｜截止 ${deadline}。`)
    })
    let settle!: () => void
    const done = new Promise<void>(resolve => { settle = resolve })
    const active: Active = { runId, taskId, abort: new AbortController(), done, settle }
    this.active = active
    active.taskTimer = setTimeout(() => this.background(() => {
      if (this.active !== active) return
      this.change(state => { state.mode = this.recoveryLatched ? 'RECOVERY_REQUIRED' : 'HANDOFF_PENDING'; state.problems = ['任务执行时限已到，正在停止写入进程。']; delete state.deadline })
      this.requestAbort()
    }), Math.max(1, instant(deadline) - Date.now()))
    active.taskTimer.unref?.()
    // The running marker is durable BEFORE invoking code that can create a writer.
    let running: Promise<RunResult>
    try { running = this.runner.run({ runId, task: structuredClone(this.state.tasks.find(item => item.id === taskId)!), deadline, config: structuredClone(this.config) }, active.abort.signal) }
    catch (error) { running = Promise.reject(error) }
    void Promise.resolve(running).then(
      result => this.background(() => this.finished(active, checkedResult(result))),
      error => this.background(() => this.finished(active, { outcome: 'unknown', summary: `执行器异常退出且未提供停止确认：${errorText(error)}`, writerStopped: false, evidence: [] })),
    )
  }

  private requestAbort(): void {
    const active = this.active
    if (!active) return
    active.abort.abort()
    if (active.stopTimer) return
    active.stopTimer = setTimeout(() => this.background(() => {
      if (this.active !== active) return
      try {
        this.change(state => {
          state.mode = 'RECOVERY_REQUIRED'; state.writerStopped = false; state.problems = ['停止宽限期内未确认写入进程退出；工作区锁继续保留。']
          const task = state.tasks.find(item => item.id === active.taskId)!
          task.state = 'unknown'
          task.result = { outcome: 'unknown', summary: state.problems[0]!, writerStopped: false, evidence: [] }
          this.completeStops(state, false)
        })
      } finally {
        // Even a broken disk cannot make close wait forever or release an unproven writer reservation.
        active.settle()
      }
    }), STOP_GRACE_MS)
    active.stopTimer.unref?.()
  }
  private completeStops(state: DurableState, safe: boolean): void {
    for (const stop of state.stopRequests) this.store.reply(`${stop.id}:final`, stop.target,
      safe ? `${state.mode}：已确认受监管写入进程退出。` : 'RECOVERY_REQUIRED：未确认写入停止或安全交接，请勿假定工作区可编辑。')
    state.stopRequests = []
  }
  private finished(active: Active, result: RunResult): void {
    if (this.active !== active) return
    this.store.assertWorkspace()
    this.change(state => {
      const task = state.tasks.find(item => item.id === active.taskId)!
      task.result = result; task.state = result.writerStopped ? result.outcome : 'unknown'; task.endedAt = iso()
      state.writerStopped = result.writerStopped
      const ambiguous = result.remoteActive === true || !result.writerStopped || result.outcome === 'unknown' || this.recoveryLatched || state.mode === 'RECOVERY_REQUIRED'
      if (ambiguous) {
        state.mode = 'RECOVERY_REQUIRED'; state.problems = [`${task.id}：${result.summary}。需人工核查恢复；不会自动重跑。`]
      } else {
        delete state.activeRunId
        if (state.mode === 'HANDOFF_PENDING') {
          state.mode = state.stopRequests.some(stop => stop.mode === 'DAY_MANUAL') ? 'DAY_MANUAL' : 'NIGHT_PAUSED'
          delete state.deadline
        }
      }
      this.store.reply(`run:${active.runId}:finished`, task.target, `${task.id}：${task.state}。${result.summary}\n写入进程退出：${result.writerStopped ? '已确认' : '未确认'}。${result.remoteActive ? '\n远端发布/部署仍活动或结果未知；本地退出不代表远端停止，未确认安全交接。' : ''}`)
      this.completeStops(state, !ambiguous)
    })
    clearTimeout(active.stopTimer); clearTimeout(active.taskTimer)
    this.active = undefined
    active.settle()
    if (this.state.mode === 'DAY_MANUAL' && this.state.writerStopped) this.store.releaseWorkspace()
    this.pump()
  }

  /** System pause is a revocation, not a fabricated human grant. A later start is always explicit. */
  suspend(): Promise<void> {
    return this.enqueue(() => {
      if (this.closed || this.closing) return
      this.change(state => {
        this.invalidateCheck(state)
        delete state.deadline
        if (state.mode !== 'RECOVERY_REQUIRED') state.mode = this.active ? 'HANDOFF_PENDING' : 'NIGHT_PAUSED'
        state.problems = ['宿主服务已暂停；夜间授权已撤销，恢复服务后仍需人工重新 start。']
      })
      clearTimeout(this.boundaryTimer)
      this.requestAbort()
    }).catch(error => { this.failClosed(error); throw error })
  }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      let active: Active | undefined
      await this.enqueue(() => {
        this.closing = true; this.dispatchCheck = undefined; clearTimeout(this.boundaryTimer)
        // Capture the writer before touching disk: shutdown must not depend on a successful commit.
        active = this.active
        try {
          this.change(state => {
            this.invalidateCheck(state)
            if (active && !this.recoveryLatched) state.mode = 'HANDOFF_PENDING'
            else if (state.mode === 'NIGHT_RUNNING') { state.mode = 'NIGHT_PAUSED'; delete state.deadline }
          })
        } catch (error) {
          // Latch recovery and retain the original error, but still drain the writer before rejecting.
          this.failClosed(error)
        } finally {
          if (active) this.requestAbort()
        }
      })
      if (active) await active.done
      await this.enqueue(() => {
        if (this.active) { clearTimeout(this.active.stopTimer); clearTimeout(this.active.taskTimer) }
        try { this.closedReplies = this.store.pendingReplies() }
        catch (error) { this.failClosed(error) }
        // A failed completion commit leaves writerStopped false, so the reservation survives close.
        try { this.store.close(this.state.writerStopped); this.closed = true }
        catch (error) { this.failClosed(error) }
      })
      if (this.shutdownErrors.length) {
        throw new AggregateError(this.shutdownErrors, `Nightshift shutdown encountered persistence/cleanup errors: ${this.shutdownErrors.map(errorText).join('; ')}`)
      }
    })()
  }
}
