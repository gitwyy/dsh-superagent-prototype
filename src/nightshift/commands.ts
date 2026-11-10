/** A bounded private-message control vocabulary. Natural language cannot silently grant execution permission. */
import type { Command } from './contracts.ts'
import { ReleaseScopeSchema } from './release/coordinator.ts'
import { z } from 'zod'

export const NIGHT_HELP = [
  'Mate v2：私聊控制，默认白天人工。',
  '直接说目标即可：处理 mate-manage-web#84；开始，截止今晚八点；可以提交；先停一下；进度怎么样。',
  '我会先复述范围和截止，再等你一句“确认”才执行；不确认就不动。',
  '查看：任务详情／发布状态／帮助 任务|发布|控制。',
  '停止：暂停／我要接班。收到安全交接确认前，请勿同时写工作区。',
].join('\n')
export const NIGHT_HELP_TOPICS = {
  task: '说“处理 mate-manage-web#84”或“继续处理 manage-web 的84”。\n我会复述仓库和读写范围，你回“确认”才登记；说“算了”取消。\n登记后说“开始，截止今晚八点”，我再复述一次并开始。\n说“可以提交”只给本地验证和提交，不含推送/合并/部署。\n跨仓请直接列仓库名，我不会把“各域”自动扩成全部。',
  release: '发布仍需明确基线，说“发布状态”查看已有操作。\n本地动作说“可以提交”，只允许受审验证和提交。\n推送/建MR/合并/测试部署需要精确范围授权，可在任务开始后单独确认。\n应用仓合并会触发已有测试部署，不会重复触发构建。\n生产不开放；冻结窗口内不执行。',
  control: '开始：说“开始，截止今晚八点”，我复述后等你确认。\n停止：说“先停一下”暂停；“我要接班”停止并核查能否安全交接。\n进度：说“进度怎么样”。\n恢复：说“可以恢复”，我确认后回到人工模式，unknown 不重跑。\n我不承诺本地退出等于远端部署停止。',
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
