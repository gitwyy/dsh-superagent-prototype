/** A bounded private-message control vocabulary. Natural language cannot silently grant execution permission. */
import type { Command } from './contracts.ts'
import { ReleaseScopeSchema } from './release/coordinator.ts'
import { z } from 'zod'

export const NIGHT_HELP = [
  'Mate v2：私聊控制，默认白天人工。',
  '可直接说“处理 mate-manage-web#84”，仅生成待确认任务，不授权、不启动。',
  '查看：状态／任务详情 <ID>／发布状态。',
  '操作：帮助 任务／帮助 发布／帮助 控制。',
  '停止：暂停／我要接班。收到安全交接确认前，请勿同时写工作区。',
].join('\n')
export const NIGHT_HELP_TOPICS = {
  task: '明确入队：入队 修改|只读 仓名 | 任务说明。\n自然语言草案：确认任务 <ID> 修改|只读 仓名。\n确认范围后或明确入队后：批准任务 <ID>。\n查看原文：任务详情 <ID> [页码]。\n批准后仍需启动夜班；不会自动授予提交或发布。',
  release: '本地动作：授权动作 <ID> 验证,提交。\n发布：预授权发布 <ID> 截止 <带时区ISO时间> | <范围JSON数组>。\n每项包含repository/sourceBranch/targetBranch/baseSha/environment/actions。\n动作push/create_mr/merge/deploy；应用合并必须同时授权test部署。\n查询：发布状态 [页码]／核查发布 <操作ID>。',
  control: '开始夜班 截止 <未来12小时内带时区ISO时间>\n仅运行已批准任务；自然语言和入队均不启动。\n暂停／我要接班／取消任务 <ID>。\n确认恢复：仅用于RECOVERY_REQUIRED，须先人工核对。\n未知操作不重跑；本地退出不代表远端部署停止。',
} as const

export function parseNightCommand(text: string): Command {
  const value = text.trim()
  if (/^(?:状态|队列|进度|现在做到哪了[？?]?|\/status)$/u.test(value)) return { type: 'status' }
  const status = /^(?:状态|队列)\s+([1-9]\d{0,3})$/u.exec(value)
  if (status) return { type: 'status', page: Number(status[1]) }
  if (/^(?:帮助|夜班帮助|\/help)$/u.test(value)) return { type: 'help' }
  const help = /^帮助\s+(任务|发布|控制)$/u.exec(value)
  if (help) return { type: 'help', topic: ({ 任务: 'task', 发布: 'release', 控制: 'control' } as const)[help[1] as '任务' | '发布' | '控制'] }
  const detail = /^(任务详情|回复详情)\s+([A-Za-z0-9_:.-]{1,180})(?:\s+([1-9]\d{0,3}))?$/u.exec(value)
  if (detail) return detail[1] === '任务详情' ? { type: 'task-detail', taskId: detail[2]!, page: Number(detail[3] ?? 1) } : { type: 'reply-detail', replyId: detail[2]!, page: Number(detail[3] ?? 1) }
  const confirm = /^确认任务\s+([A-Za-z0-9_-]{1,100})\s+(只读|修改)\s+([a-z][a-z0-9,-]*)$/u.exec(value)
  if (confirm) return { type: 'confirm-task', taskId: confirm[1]!, access: confirm[2] === '只读' ? 'read' : 'write', repositories: [...new Set(confirm[3]!.split(','))] }
  if (/^(?:暂停|先暂停|暂停夜班|\/pause)$/u.test(value)) return { type: 'pause' }
  if (/^(?:我要接班|接班|交接|结束夜班|白天人工|\/handoff)$/u.test(value)) return { type: 'handoff' }
  if (value === '确认恢复') return { type: 'recover', acknowledged: true }
  const task = /^(批准任务|取消任务)\s+([A-Za-z0-9_-]{1,100})$/u.exec(value)
  if (task) return { type: task[1] === '批准任务' ? 'approve' : 'cancel', taskId: task[2]! }
  const actions = /^授权动作\s+([A-Za-z0-9_-]{1,100})\s+(验证|提交|发布)(?:[,，](验证|提交|发布))*$/u.exec(value)
  if (actions) {
    const names = value.split(/\s+/u).at(-1)!.split(/[,，]/u)
    const map = { 验证: 'validate', 提交: 'commit', 发布: 'publish' } as const
    return { type: 'authorize-actions', taskId: actions[1]!, actions: [...new Set(names.map(n => map[n as keyof typeof map]))] }
  }
  const release = /^预授权发布\s+([A-Za-z0-9_-]{1,100})\s+截止\s+(\S+)\s*\|\s*([\s\S]+)$/u.exec(value)
  if (release) {
    const expiresAt = z.string().datetime({ offset: true }).parse(release[2])
    if (release[3]!.length > 16000) throw new Error('发布范围过长。')
    const scopes = z.array(ReleaseScopeSchema).min(1).max(17).parse(JSON.parse(release[3]!))
    return { type: 'authorize-release', taskId: release[1]!, expiresAt, scopes }
  }
  const start = /^开始夜班\s+截止\s+(\S+)$/u.exec(value)
  if (start) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(start[1]!) || !Number.isFinite(Date.parse(start[1]!))) {
      throw new Error('截止时间必须带日期、时间和时区，格式为 YYYY-MM-DDTHH:mm:ss+08:00。')
    }
    return { type: 'start', deadline: new Date(start[1]!).toISOString() }
  }
  const enqueue = /^入队\s+(只读|修改)\s+([a-z][a-z0-9,-]*)\s*\|\s*([\s\S]+)$/u.exec(value)
  if (enqueue) {
    const repositories = [...new Set(enqueue[2]!.split(','))]
    if (repositories.some(repo => !/^[a-z][a-z0-9-]*$/.test(repo))) throw new Error('仓名列表无效。')
    const taskText = enqueue[3]!.trim()
    if (taskText.length > 12000) throw new Error('任务说明过长，请分成有界任务（最多 12000 字符）。')
    return { type: 'enqueue', access: enqueue[1] === '只读' ? 'read' : 'write', repositories, text: taskText }
  }
  // Unknown/quoted instructions are not an authority to start a job or reuse a previous task.
  throw new Error('这条消息没有执行。请用“入队 只读 仓名 | 任务说明”，或发送“帮助”。')
}
