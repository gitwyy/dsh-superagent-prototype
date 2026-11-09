/** Serialized, fail-closed supervisor. External awaits never hold the command queue. */
import { randomUUID } from 'node:crypto'
import type { Command, Incoming, NightConfig, NightController, PendingReply, RunResult, Runner, Task } from './contracts.ts'
import { NightStore, type DurableState, type PendingCheck } from './store.ts'
import { NIGHT_HELP } from './commands.ts'

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
    || typeof value.writerStopped !== 'boolean' || typeof value.summary !== 'string'
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
    return task.state === 'queued' && task.approved === true && !!task.approveMessageId && !!task.ownerId
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
          const tasks = state.tasks.slice(-10).map(task => `${task.id} ${task.state} [${task.repositories.join(',')}/${task.access}/${task.approved ? '已批准' : '待批准'}/动作:${task.actions?.join(',') || '无'}] ${task.text.replace(/\s+/g, ' ').slice(0, 100)}`)
          reply(`${state.mode}｜排队 ${state.tasks.filter(task => task.state === 'queued').length}｜运行 ${state.activeRunId ?? '无'}｜截止 ${state.deadline ?? '无'}\n${tasks.join('\n')}${state.problems.length ? `\n注意：${state.problems.join('；')}` : ''}`); return
        }
        if (command.type === 'help') { reply(NIGHT_HELP); return }
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
        if (command.type === 'enqueue') {
          if (!command.text.trim() || command.repositories.length === 0 || command.repositories.some(repository => !Object.hasOwn(this.config.repositories, repository)) || !['read', 'write'].includes(command.access)) {
            reply('拒绝：请提供任务内容、已配置的仓库别名和明确的 read/write 权限。'); return
          }
          const task: Task = { id: randomUUID(), originId: input.id, ownerId: input.actorId, text: command.text, repositories: [...new Set(command.repositories)], access: command.access, approved: false, target: input.target, state: 'queued', createdAt: iso() }
          state.tasks.push(task)
          reply(`已排队 ${task.id}｜${task.repositories.join(',')}｜${task.access}。需任务所有者明确批准；添加任务不会启动夜间执行。`)
        } else if (command.type === 'authorize-actions') {
          const task = state.tasks.find(item => item.id === command.taskId)
          if (!task || task.ownerId !== input.actorId || task.state !== 'queued' || !task.approved || state.mode === 'RECOVERY_REQUIRED') {
            reply('拒绝：只有任务所有者可为已批准的排队任务授权额外动作。'); return
          }
          if (!command.actions.length || command.actions.some(a => !['validate', 'commit', 'publish'].includes(a))
            || (task.access !== 'write' && command.actions.some(a => a !== 'validate'))) {
            reply('拒绝：动作范围无效，提交/发布还要求任务 write 权限。'); return
          }
          const missing = task.repositories.filter(repo => !this.config.repositoryActions?.[repo])
          if (missing.length) { reply(`拒绝：仓库尚无本地受审动作配置：${missing.join(',')}。`); return }
          if (command.actions.includes('publish')) { reply('发布尚未启用：需先验证专用发布身份与远端边界；未授予 publish。'); return }
          task.actions = [...new Set(command.actions)]
          task.actionsApproveMessageId = input.id
          reply(`已授权动作 ${task.id}：${task.actions.join(',')}。验证会执行本地配置中固定的受信任程序；不授予任意 shell、合并、部署或群消息权限。`)
        } else if (command.type === 'approve' || command.type === 'cancel') {
          const task = state.tasks.find(item => item.id === command.taskId)
          if (!task || task.ownerId !== input.actorId) { reply('拒绝：任务不存在，或发送者不是任务所有者。'); return }
          if (command.type === 'approve') {
            if (task.state !== 'queued' || state.mode === 'RECOVERY_REQUIRED') { reply('拒绝：只能在非恢复状态批准排队中的任务。'); return }
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
      const ambiguous = !result.writerStopped || result.outcome === 'unknown' || this.recoveryLatched || state.mode === 'RECOVERY_REQUIRED'
      if (ambiguous) {
        state.mode = 'RECOVERY_REQUIRED'; state.problems = [`${task.id}：${result.summary}。需人工核查恢复；不会自动重跑。`]
      } else {
        delete state.activeRunId
        if (state.mode === 'HANDOFF_PENDING') {
          state.mode = state.stopRequests.some(stop => stop.mode === 'DAY_MANUAL') ? 'DAY_MANUAL' : 'NIGHT_PAUSED'
          delete state.deadline
        }
      }
      this.store.reply(`run:${active.runId}:finished`, task.target, `${task.id}：${task.state}。${result.summary}\n写入进程退出：${result.writerStopped ? '已确认' : '未确认'}。`)
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
