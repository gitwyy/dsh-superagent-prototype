/** A bounded private-message control vocabulary. Natural language cannot silently grant execution permission. */
import type { Command } from './contracts.ts'
import { ReleaseScopeSchema } from './release/coordinator.ts'
import { z } from 'zod'

export const NIGHT_HELP = [
  'Mate v2 单会话夜班（仅私聊）。默认白天人工；消息入队不等于开始执行。',
  '任务格式：入队 只读 mate-workspace | 任务说明',
  '写任务格式：入队 修改 mate-account,mate-workspace | 已确认的 spec/task 与范围',
  '批准任务 <任务ID>  — 确认该条任务的仓与读/写范围；不授予合并/部署权限',
  '授权动作 <任务ID> 验证,提交  — 额外允许本地受审验证程序/提交；默认无，不允许发布/合并',
  '开始夜班 截止 2026-11-10T07:00:00+08:00  — 必须是未来 12 小时内的明确截止时间',
  '状态 / 队列 / 帮助',
  '暂停 / 我要接班 / 取消任务 <任务ID>',
  '确认恢复  — 仅对已核对现场的恢复请求；未知结果的任务不会自动重跑',
  '收到“可以接班”之前不要同时写该工作区。真实 pi 执行仍遵守 SDD 门禁；受护栏拦截的操作会等待人工。',
].join('\n')

export function parseNightCommand(text: string): Command {
  const value = text.trim()
  if (/^(?:状态|队列|进度|现在做到哪了[？?]?|\/status)$/u.test(value)) return { type: 'status' }
  if (/^(?:帮助|夜班帮助|\/help)$/u.test(value)) return { type: 'help' }
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
      throw new Error('截止时间必须带日期、时间和时区，例如 2026-11-10T07:00:00+08:00。')
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
