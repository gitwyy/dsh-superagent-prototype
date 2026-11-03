/** Merge request binding, lifecycle observation, and terminal IM notification helpers. */
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment, GitlabAccount } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { gitlabThreadKey, MergeRequestSchema, SOURCE, type GitlabMergeRequest } from './gitlab-trigger.ts'

export type MergeRequest = GitlabMergeRequest & { iid: number }
export const readMergeRequest = async (ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<MergeRequest> =>
  ({ ...await ctx.commands.withSignal(signal).gitlabApi(MergeRequestSchema, `merge_requests/${iid}`), iid })
const mergeRequestIid = (thread: string): number | undefined => {
  const match = /^gitlab:merge_request:(\d+)$/.exec(thread)
  return match ? Number(match[1]) : undefined
}
/** The merge requests a Ticket follows, by IID (`open` alone: those that have not closed). */
export const mergeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mergeRequestIid(item.thread) ?? [])
export const mergeRequestOf = (ticket: Pick<Ticket, 'follows'>): number | undefined =>
  mergeRequestsOf(ticket, true).at(-1) ?? mergeRequestsOf(ticket).at(-1)
/** True when the merge request was opened by the agent account from a branch in the configured project (not a fork). */
export const agentMergeRequest = (mr: Pick<MergeRequest, 'author' | 'source_project_id'>,
  deployment: Pick<Deployment, 'gitlab'>): boolean =>
  sameName(mr.author?.username ?? '', deployment.gitlab?.login ?? '') && mr.source_project_id === deployment.gitlab?.projectId
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string | null | undefined): boolean =>
  !!ticket.execution?.name && !!ref && ref.split('/').at(-1) === ticket.execution.name
/** The fact that says what a person still has to do with the merge request, if anything. */
export function mergeStatusFact(mr: MergeRequest): ThreadFact {
  if (mr.state === 'merged') return { label: { zh: '合并请求', en: 'Merge request' }, value: { zh: '已合并', en: 'merged' } }
  if (mr.state === 'closed') return { label: { zh: '合并请求', en: 'Merge request' }, value: { zh: '已关闭', en: 'closed' } }
  // Right after creation GitLab prepares the merge request: `checking`/`preparing` are normal, not a problem.
  const status = mr.detailed_merge_status ?? mr.merge_status ?? ''
  const problem = status === 'cannot_be_merged' || status === 'conflict' || status === 'need_rebase'
  return { label: { zh: '可合并状态', en: 'Merge status' }, value: status || { zh: '打开', en: 'opened' }, ...problem ? { problem: true as const } : {} }
}
/**
 * Validates and binds an open merge request to a Ticket when it is either the Ticket's origin merge request or an
 * agent-authored merge request on the Ticket's branch, enforcing that one merge request binds to at most one open Ticket.
 * Returns an error message when binding is rejected, or undefined when the merge request is bound or not open.
 */
export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: MergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its merge request was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && Number(source.meta.iid) === mr.iid
    && (source.meta.kind === 'merge_request' || source.meta.targetKind === 'merge_request')
  const opened = agentMergeRequest(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const login = ctx.deployment.gitlab?.login ?? 'the deployment\'s GitLab account'
    return `Merge request !${mr.iid} does not belong to this ticket: use the source merge request or one by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_number when no merge request exists`
  }
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'Merge request already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === gitlabThreadKey('merge_request', mr.iid))
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled merge request's open/merged/closed state with any bound or branch-matching Ticket, records what
 * mergeability says on its Thread, and reports the merge or close to the Engine.
 * @returns whether the merge request has ended.
 */
export async function observeMergeRequest(ctx: SourceContext, mr: MergeRequest): Promise<boolean> {
  const ended = mr.state === 'merged' || mr.state === 'closed' || !!mr.merged_at
  if (ended) closeMergeRequest(ctx, mr)
  else {
    const candidates = agentMergeRequest(mr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0] : undefined
    // A merge request the Ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === gitlabThreadKey('merge_request', mr.iid) && item.closed)
    if (ticket && (reopened || mergeRequestsOf(ticket, true).every(iid => iid === mr.iid))) claimMergeRequest(ctx, ticket.id, mr)
  }
  const thread = gitlabThreadKey('merge_request', mr.iid)
  ctx.threads.describe(thread, { facts: { mergeStatus: mergeStatusFact(mr) } })
  ctx.atomic(() => ctx.threads.patch(thread, { kind: 'merge_request', iid: mr.iid, isMr: true, state: mr.state ?? 'opened',
    ...(mr.merged_at ? { mergedAt: mr.merged_at } : {}), ...(mr.merge_commit_sha ? { mergeCommitSha: mr.merge_commit_sha } : {}),
    ...(mr.detailed_merge_status ? { detailedMergeStatus: mr.detailed_merge_status } : {}),
    ...(mr.source_branch ? { sourceBranch: mr.source_branch } : {}), ...(mr.web_url ? { url: mr.web_url } : {}) }))
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: MergeRequest, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: `merge_request:${mr.iid}` }, own)
    const thread = gitlabThreadKey('merge_request', mr.iid)
    ctx.threads.patch(thread, { kind: 'merge_request', iid: mr.iid, isMr: true, ...(mr.web_url ? { url: mr.web_url } : {}),
      ...(mr.author ? { mrAuthor: mr.author.username } : {}) })
    ctx.threads.describe(thread, { label: `!${mr.iid} ${mr.title}`, ...(mr.web_url ? { url: mr.web_url } : {}),
      facts: { number: { value: `!${mr.iid}` }, mergeStatus: mergeStatusFact(mr) } })
  })
}
/**
 * Reports a merged or closed merge request once to the open Tickets that follow it, whose end the core decides.
 * Their subscription to the merge request's Thread stays, so a later human comment there resumes the Ticket.
 */
function closeMergeRequest(ctx: SourceContext, mr: MergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mergeRequestsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: `merge_request:${mr.iid}` }, mr.state === 'merged' || !!mr.merged_at ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a Ticket ends with its merge request (selecting the
 * last-closed one it opened, else the last one it followed). The notice language follows the Ticket's source request.
 */
export function mergeRequestEndNotices(ticket: Ticket, request: string, gitlab: Pick<GitlabAccount, 'webUrl'>): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mergeRequestIid(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = mergeRequestIid(follow.thread)!
  const url = gitlab.webUrl ? `${gitlab.webUrl}/-/merge_requests/${iid}` : ''
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[合并请求 !${iid}](${url}) 已合并。` : `[合并请求 !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  // GitLab's merge request page already shows the merge or closure, so GitLab channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
