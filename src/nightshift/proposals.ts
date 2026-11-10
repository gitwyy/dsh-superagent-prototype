/** Deterministic task suggestions only. Never approves, starts, authorizes actions, or resolves repositories remotely. */
export interface NightProposal {
  text: string
  repositories: string[]
  access: 'read' | 'write'
  /** Canonical local display references, not fetched issue content or authority. */
  issueRefs?: string[]
}

const COMPANY_GITLAB = 'gitlab.yk.ykgtxy.com'
const ALIAS = /^[a-z][a-z0-9-]{0,99}$/
const ISSUE = /^[1-9][0-9]{0,9}$/
const EXCLUDED = /^(?:mate-one(?:-|$)|legacy(?:-|$))/i
// Malformed controls must remain rejected by the control parser, not become a differently authorized task.
const CONTROL = /入队|批准任务|开始夜班|确认恢复|预授权发布|授权动作|确认任务|取消任务|核查发布|发布状态|暂停夜班|我要接班|结束夜班|白天人工|(?:^|[\s，。；;])\/(?:status|help|pause|handoff|start|approve|enqueue|recover|cancel)\b/iu
const INTENT = /^(?:(?:请帮我|请你|请|帮我|麻烦你|麻烦|现在|今天|今晚|please)\s*)*(?:处理|修复|修改|实现|开发|接入|对接|优化|调整|补充|增加|新增|移除|删除|更新|排查|检查|查看|分析|审查|审阅|评审|调查|核对|定位|梳理|review\b|inspect\b|investigate\b|analy[sz]e\b|check\b|fix\b|implement\b|update\b|handle\b)/iu
const WRITE_INTENT = /处理|修复|修改|实现|开发|接入|对接|优化|调整|补充|增加|新增|移除|删除|更新|(?:^|[^A-Za-z])(?:fix|implement|update|handle|change|edit|remove|delete|add)(?![A-Za-z])/iu
const READ_ONLY = /只读|仅(?:排查|检查|查看|分析|审查)|read[ -]?only/iu
const NEGATED_WRITE = /(?:不要|禁止|不允许|无需|不做|不)(?:直接)?(?:修改|写入|编辑|提交|推送|合并|部署)|\b(?:do not|don't|without)\s+(?:edit|change|write|commit|push|merge|deploy)\b/giu
const URL_TOKEN = /(?:https?:\/\/|www\.)[^\s<>"'`，。；！？、（）【】)\]}]+/giu
const WORD = /[A-Za-z][A-Za-z0-9_.-]*/g
const IDENTIFIER_EDGE = /[A-Za-z0-9_./@%:\-]/
function boundary(text: string, index: number, length: number): boolean {
  return (index === 0 || !IDENTIFIER_EDGE.test(text[index - 1]!))
    && (index + length === text.length || !IDENTIFIER_EDGE.test(text[index + length]!))
}
function maskRange(value: string): string { return ' '.repeat(value.length) }

/** Suggest the explicitly named configured scope. The caller MUST persist it unapproved and require human scope confirmation. */
export function parseNightProposal(text: string, repositories: string[]): NightProposal | undefined {
  if (typeof text !== 'string' || text.length > 12_000 || !text.trim() || !Array.isArray(repositories) || repositories.length > 100) return undefined
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(text)) return undefined
  if (repositories.some(alias => typeof alias !== 'string' || !ALIAS.test(alias)) || new Set(repositories).size !== repositories.length) return undefined
  const allowed = new Set(repositories.filter(alias => !EXCLUDED.test(alias)))
  if (!allowed.size) return undefined
  const value = text.trim()
  if (CONTROL.test(value) || /(?:^|[\n；;])\s*(?:暂停|先暂停|接班|交接|状态|队列|进度|帮助|夜班帮助|现在做到哪了|\/[A-Za-z])/u.test(value)
    || /```|~~~|^\s*>/mu.test(value) || /^["'“‘「『]/u.test(value)) return undefined
  // Quoted examples and inline code cannot supply task intent or repository scope.
  let scan = value.replace(/`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/gu, maskRange)
  if (!INTENT.test(scan)) return undefined
  const selected: { alias: string; at: number }[] = [], refs: { ref: string; at: number }[] = []
  let invalid = false
  scan = scan.replace(URL_TOKEN, (raw, at: number) => {
    const urlText = raw.replace(/[.,;!?]+$/u, '')
    try {
      const url = new URL(urlText)
      const canonicalSpelling = /^https?:\/\/gitlab\.yk\.ykgtxy\.com\/payment\/refactor\/[a-z][a-z0-9-]*(?:\/-\/issues\/[1-9][0-9]{0,9})?\/?$/.test(urlText)
      if (!canonicalSpelling || !['http:', 'https:'].includes(url.protocol) || url.hostname !== COMPANY_GITLAB || url.port || url.username || url.password
        || url.search || url.hash || /%|\\/.test(urlText)) { invalid = true; return maskRange(raw) }
      const path = /^\/payment\/refactor\/([a-z][a-z0-9-]*)(?:\/-\/issues\/([1-9][0-9]{0,9}))?\/?$/.exec(url.pathname)
      if (!path || !allowed.has(path[1]!)) { invalid = true; return maskRange(raw) }
      selected.push({ alias: path[1]!, at })
      if (path[2]) refs.push({ ref: `${path[1]}#${path[2]}`, at })
    } catch { invalid = true }
    return maskRange(raw)
  })
  if (invalid) return undefined
  // Do not infer aliases from local paths, email addresses, suffixes, or unknown mate-/legacy repository names.
  for (const match of scan.matchAll(WORD)) {
    const token = match[0], at = match.index
    if (!boundary(scan, at, token.length)) continue
    if (allowed.has(token)) selected.push({ alias: token, at })
    else if (/^(?:mate-|legacy(?:-|$))/i.test(token) || repositories.some(alias => alias.toLowerCase() === token.toLowerCase())) return undefined
  }
  // Explicit repo#N references must name an exact configured alias and a positive canonical issue number.
  for (const match of scan.matchAll(/([A-Za-z][A-Za-z0-9_.-]*)#([^\s，。；！？、（）【】,;!?\]}>]*)/gu)) {
    const alias = match[1]!, number = match[2]!, at = match.index
    if (!boundary(scan, at, alias.length)) return undefined
    if (!allowed.has(alias) || !ISSUE.test(number)) return undefined
    selected.push({ alias, at }); refs.push({ ref: `${alias}#${number}`, at })
  }
  if (!selected.length) return undefined
  // Bare #84 is not assigned to an inferred repo. Require an explicit repo#84 or an exact company issue URL.
  if (/(?:^|[\s，,])#[0-9]+/u.test(scan)) return undefined
  const accessText = scan.replace(NEGATED_WRITE, maskRange)
  const writes = WRITE_INTENT.test(accessText)
  if (writes && READ_ONLY.test(accessText)) return undefined
  const scopes = [...new Set(selected.sort((a, b) => a.at - b.at).map(item => item.alias))]
  const issueRefs = [...new Set(refs.sort((a, b) => a.at - b.at).map(item => item.ref))]
  return { text: value, repositories: scopes, access: writes ? 'write' : 'read', ...(issueRefs.length ? { issueRefs } : {}) }
}
