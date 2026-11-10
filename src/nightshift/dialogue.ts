/** Pure dialogue interpretation. Intents are suggestions for the host confirmation protocol, never execution authority. */
import { parseNightProposal } from './proposals.ts'

export interface DialogueTask {
  id: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'unknown'
  approved: boolean
  repositories: string[]
  access: 'read' | 'write'
  text: string
  scopePending: boolean
}
export interface DialogueContext {
  mode: 'DAY_MANUAL' | 'NIGHT_RUNNING' | 'HANDOFF_PENDING' | 'NIGHT_PAUSED' | 'RECOVERY_REQUIRED'
  repositories: string[]
  tasks: DialogueTask[]
  activeRunId?: string
  now: string
  offsetMinutes?: number
}
export type DialogueIntent =
  | { kind: 'confirm' } | { kind: 'decline' } | { kind: 'go'; deadline?: string }
  | { kind: 'pause' } | { kind: 'handoff' } | { kind: 'status' } | { kind: 'recover' }
  | { kind: 'allow-commit'; taskId?: string }
  | { kind: 'task'; text: string; repositories: string[]; access: 'read' | 'write'; issueRefs?: string[]; taskId?: string }

const EXPLICIT = /入队|批准任务|开始夜班|确认任务|预授权发布|授权动作|确认恢复|取消任务|任务详情|回复详情|发布状态|核查发布|帮助|夜班帮助|(?:^|\s)\/[a-z]/iu
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u
const MAX_SHIFT = 12 * 60 * 60 * 1000
const live = (task: DialogueTask) => task.state === 'queued' || task.state === 'running'
const aliasesValid = (names: string[]) => names.length <= 100 && names.every(name => /^[a-z][a-z0-9-]{0,99}$/.test(name)) && new Set(names).size === names.length
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function integer(text: string): number | undefined {
  if (/^(?:0|[1-9][0-9]{0,3})$/.test(text)) return Number(text)
  const digit: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (text.length === 1 && digit[text] !== undefined) return digit[text]
  if (text === '十') return 10
  const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(text)
  if (tens) return (tens[1] ? digit[tens[1]]! : 1) * 10 + (tens[2] ? digit[tens[2]]! : 0)
  return undefined
}
function clockNow(context: DialogueContext): { now: number; offset: number } | undefined {
  const offset = context.offsetMinutes ?? 480
  if (!Number.isInteger(offset) || offset < -840 || offset > 840 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(context.now)) return undefined
  const now = Date.parse(context.now)
  return Number.isFinite(now) ? { now, offset } : undefined
}
function formatInstant(instant: number, offset: number): string {
  const local = new Date(instant + offset * 60_000).toISOString().slice(0, 19)
  const absolute = Math.abs(offset)
  return `${local}${offset < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}
function deadline(text: string, context: DialogueContext): string | undefined {
  const clock = clockNow(context)
  if (!clock) return undefined
  const { now, offset } = clock
  let value = text.trim().replace(/^[，,：:\s]+/u, '').replace(/(?:前(?:停(?:止)?|结束|收工)|(?:停(?:止)?|结束|收工)|为止)$/u, '').trim()
  value = value.replace(/^(?:截止(?:到)?|一直到|做到|到)\s*/u, '')
  let instant: number
  const relative = /^(半|[0-9零〇一二两三四五六七八九十]+)(小时|分钟)后$/u.exec(value)
  if (relative) {
    const amount = relative[1] === '半' && relative[2] === '小时' ? 0.5 : integer(relative[1]!)
    if (amount === undefined || amount <= 0) return undefined
    instant = now + amount * (relative[2] === '小时' ? 3_600_000 : 60_000)
  } else {
    const absolute = /^(今晚|今天晚上|晚上|明早|明天早上|明天上午|明天|早上|上午|下午|今天)?\s*([0-9零〇一二两三四五六七八九十]+)(?::([0-9]{2})|[点时](?:(半)|([0-9零〇一二两三四五六七八九十]+)分?)?)$/u.exec(value)
    if (!absolute) return undefined
    const qualifier = absolute[1] ?? ''
    let hour = integer(absolute[2]!)
    const minute = absolute[4] ? 30 : absolute[3] !== undefined ? Number(absolute[3]) : integer(absolute[5] ?? '0')
    if (hour === undefined || minute === undefined || hour > 23 || minute > 59) return undefined
    if (['今晚', '今天晚上', '晚上', '下午'].includes(qualifier)) {
      if (hour >= 1 && hour <= 11) hour += 12
      else if (hour === 0) return undefined
    }
    if (['明早', '明天早上', '明天上午', '早上', '上午'].includes(qualifier) && hour >= 12) return undefined
    const wall = new Date(now + offset * 60_000)
    const day = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate())
    instant = day + hour * 3_600_000 + minute * 60_000 - offset * 60_000
    if (qualifier.startsWith('明')) instant += 86_400_000
    else if (instant <= now) instant += 86_400_000 // Next future clock occurrence, never a past deadline.
  }
  if (!Number.isFinite(instant) || instant <= now || instant - now > MAX_SHIFT) return undefined
  return formatInstant(instant, offset)
}

function taskIntent(value: string, context: DialogueContext): DialogueIntent | undefined {
  const aliases = context.repositories.filter(name => !/^(?:mate-one(?:-|$)|legacy(?:-|$))/i.test(name))
  const candidates = new Map<string, string[]>()
  for (const alias of aliases) for (const token of [alias, ...(alias.startsWith('mate-') ? [alias.slice(5)] : [])]) {
    candidates.set(token, [...new Set([...(candidates.get(token) ?? []), alias])])
  }
  let ambiguous = false
  let normalized = value.replace(/https?:\/\/[^\s<>"'`，。；！？、（）【】)\]}]+|[A-Za-z][A-Za-z0-9_.-]*/gu, (token, at: number) => {
    if (/^https?:\/\//.test(token)) return token // URL authorization stays with the strict proposal parser.
    if (at > 0 && /[A-Za-z0-9_./@%:\-]/.test(value[at - 1]!)) return token
    const matches = candidates.get(token)
    if (matches?.length === 1) return matches[0]!
    if (matches && matches.length > 1) ambiguous = true
    else if (candidates.has(token.toLowerCase()) || /^(?:mate-|legacy(?:-|$))/i.test(token)
      || (token.includes('-') && !['read-only', 'open-issue'].includes(token))) ambiguous = true
    return token
  })
  if (ambiguous) return undefined
  normalized = normalized.replace(/^继续(?:处理|做)/u, '处理')
  // A numeric issue is accepted only adjacent to one explicit unambiguous repository name.
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
    const expression = new RegExp(`(?<![A-Za-z0-9_./@%:-])${escaped(alias)}\\s*(?:的\\s*|(?:issue|问题|工单)\\s*#?)([1-9][0-9]{0,9})(?![A-Za-z0-9])(?:号)?`, 'gu')
    normalized = normalized.replace(expression, `${alias}#$1 `)
  }
  const proposal = parseNightProposal(normalized, context.repositories)
  if (!proposal) return undefined
  const relevant = context.tasks.filter(live)
  let matches: DialogueTask[]
  if (proposal.issueRefs?.length) {
    matches = relevant.filter(task => proposal.issueRefs!.every(ref => {
      const alias = ref.slice(0, ref.lastIndexOf('#'))
      if (!task.repositories.includes(alias)) return false
      if (new RegExp(`(?<![A-Za-z0-9_./@%:-])${escaped(ref)}(?![A-Za-z0-9])`, 'u').test(task.text)) return true
      const parsed = parseNightProposal(task.text, context.repositories)
      return parsed?.issueRefs?.includes(ref) === true
    }))
  } else matches = relevant.filter(task => proposal.repositories.length === task.repositories.length && proposal.repositories.every(repo => task.repositories.includes(repo)))
  if (matches.length > 1) return undefined
  const matched = matches[0]
  if (matched && matched.access !== proposal.access) return undefined // Do not reinterpret a read task as a write continuation.
  return { kind: 'task', text: value, repositories: proposal.repositories, access: proposal.access,
    ...(proposal.issueRefs?.length ? { issueRefs: proposal.issueRefs } : {}), ...(matched ? { taskId: matched.id } : {}) }
}

export function parseDialogue(text: string, context: DialogueContext): DialogueIntent | undefined {
  if (typeof text !== 'string' || text.length > 12_000 || !text.trim() || BAD_TEXT.test(text) || !context || !Array.isArray(context.repositories)
    || !aliasesValid(context.repositories) || !Array.isArray(context.tasks) || context.tasks.length > 10_000) return undefined
  const value = text.trim()
  if (/[\n\r]/u.test(value) && value.split(/[\n\r]+/u).some(line => {
    const part = line.trim().replace(/[\s，,。！？!?]/gu, '')
    return part.length <= 16 && /^(?:确认|可以|好|同意|没问题|就这样|继续吧|行|确认开始|确认执行|确认提交|算了|不用了|取消这个|先不要|不对|开始吧?|开工吧?|动手吧?|跑吧|启动吧?|停一下|先停|暂停|收工|我要接手|允许提交|可以提交|提交吧|保存代码|可以验证|跑测试)$/u.test(part)
  })) return undefined
  if (EXPLICIT.test(value) || /(?:\n|[；;])\s*(?:确认|可以提交|允许提交|开始吧?|开工|暂停|先停|接班|交接)(?:[\s。！？!?]|$)/u.test(value) || /```|~~~|^\s*>/mu.test(value) || /[`“”‘’「」『』"]/u.test(value) || /^'/u.test(value)) return undefined
  const short = value.replace(/[。！？!?]+$/u, '').trim()
  if (short.length <= 16) {
    const compact = short.replace(/[\s，,]/gu, '')
    if (/^(?:确认|可以|好|同意|没问题|就这样|继续吧|行|确认开始|确认执行|确认提交)$/u.test(compact)) return { kind: 'confirm' }
    if (/^(?:算了|不用了|取消这个|先不要|不对)$/u.test(compact)) return { kind: 'decline' }
    if (/^(?:停一下|先停|先停一下|暂停|先暂停|暂停一下|停下|先别做了)$/u.test(compact)) return { kind: 'pause' }
    if (/^(?:收工|我要接手|我来接手|我要接班|接班|交接|结束夜班|白天人工)$/u.test(compact)) return { kind: 'handoff' }
    // Status phrasing is open-ended in Chinese; accept common shapes rather than an exact list.
    if (/^(?:(?:当前|现在|目前)?(?:状态|进度|进展|情况|进行|执行)(?:怎么样|如何|到哪了|呢)?|(?:现在|目前|当前)?怎么样(?:了|呢)?|任务(?:情况|进度|状态)?(?:怎么样|如何|到哪了)?(?:了|呢)?|到哪了|做完没|做好没|好了没|在做什么|现在做到哪了|跑到哪了)$/u.test(compact)) return { kind: 'status' }
    if (/^(?:可以恢复|已核查|已经核查|已核查可以恢复|已经核查可以恢复)$/u.test(compact)) return { kind: 'recover' }
    if (/^(?:允许提交|可以提交|提交吧|保存代码|可以验证|跑测试)$/u.test(compact)) {
      const queued = context.tasks.filter(task => task.state === 'queued')
      const approved = queued.filter(task => task.approved)
      const choices = approved.length ? approved : queued
      if (choices.length !== 1) return undefined
      return { kind: 'allow-commit', taskId: choices[0]!.id }
    }
  }
  const go = /^(?:请\s*)?(开始吧?|开工吧?|动手吧?|跑吧|启动吧?|继续处理|继续做)(.*)$/u.exec(short)
  if (go) {
    const suffix = go[2]!.trim().replace(/^[，,：:\s]+/u, '').trim()
    if (!suffix) return { kind: 'go' }
    const parsed = deadline(suffix, context)
    if (parsed) return { kind: 'go', deadline: parsed }
    // Only the task-continuation phrases may be interpreted as scoped tasks.
    // A malformed start deadline is never discarded or converted to permission.
    if (!['继续处理', '继续做'].includes(go[1]!)) return undefined
  }
  return taskIntent(value, context)
}
