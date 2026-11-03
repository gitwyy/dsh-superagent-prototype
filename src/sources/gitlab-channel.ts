/** GitLab outbound channel: posts notes on an Issue or merge request, or into one of its discussions, under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { DiscussionSchema, marker, NoteSchema, type GitlabKind, type GitlabNote } from './gitlab-trigger.ts'

/** The Issue or merge request a Channel address names. */
function target(address: Record<string, string>): { kind: GitlabKind; iid: number } | undefined {
  const kind = address.kind === 'merge_request' ? 'merge_request' : address.kind === 'issue' ? 'issue' : undefined
  const iid = Number(address.iid)
  return kind && Number.isInteger(iid) && iid > 0 ? { kind, iid } : undefined
}
/** True when the Issue or merge request is locked against new notes, which no retry can change. */
const locked = (error: unknown): boolean => error instanceof CliError && error.code === 403 && /lock/i.test(error.message)
/** True when GitLab answers that the discussion or conversation does not exist (a deleted issue or merge request, or lost access). */
const missing = (error: unknown): boolean => error instanceof CliError && error.code === 404
/**
 * Posts a note on an Issue or merge request, or a reply in one of its discussions, with an embedded HTML marker so a retried
 * send finds the note instead of posting it twice. A 404 is told apart from a lost project by reading the project once.
 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitlab = commands.deployment.gitlab
  if (!gitlab) throw new Error('The GitLab Source has no working CLI')
  const reply = target(message.channel.address)
  if (!reply) throw new Error('Missing GitLab reply target')
  const base = reply.kind === 'issue' ? `issues/${reply.iid}` : `merge_requests/${reply.iid}`
  const token = marker(message.id)
  const mine = (note: GitlabNote): boolean => sameName(note.author?.username ?? '', gitlab.login) && (note.body ?? '').includes(token)
  const conversation = `${base}/notes`
  const discussionId = message.channel.address.discussionId
  try {
    // Retained Channel addresses name their discussion; one GitLab no longer finds falls back to the conversation.
    const retained = discussionId
      ? await commands.gitlabApi(DiscussionSchema, `${base}/discussions/${encodeURIComponent(discussionId)}`)
        .catch((error: unknown) => { if (missing(error)) return undefined; throw error })
      : undefined
    if (retained?.notes.some(mine)) return 'sent'
    if (!discussionId || retained) {
      if (!discussionId && (await commands.gitlabApi(z.array(NoteSchema), `${conversation}?per_page=100&sort=desc&activity_filter=all`)).some(mine)) return 'sent'
      const path = retained ? `${base}/discussions/${encodeURIComponent(discussionId!)}/notes` : conversation
      await commands.gitlabApi(z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${token}`)
      return 'sent'
    }
    if ((await commands.gitlabApi(z.array(NoteSchema), `${conversation}?per_page=100&sort=desc&activity_filter=all`)).some(mine)) return 'sent'
    await commands.gitlabApi(z.unknown(), conversation, '--method', 'POST', '-f', `body=${message.text}\n\n${token}`)
    return 'sent'
  } catch (error) {
    if (locked(error)) return 'gone'
    if (missing(error)) {
      // GitLab answers 404 for a missing Issue or merge request too: a project that still reads means the target is gone.
      const readable = await commands.gitlabApi(z.unknown(), '').then(() => true, () => false)
      if (readable) return 'gone'
    }
    throw error
  }
}
/** Links an address to its Issue or merge request page; without the instance's web URL, only a retained URL links. */
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const kind: GitlabKind = address.kind === 'merge_request' ? 'merge_request' : 'issue'
  const iid = address.iid ?? ''
  const page = kind === 'merge_request' ? 'merge_requests' : 'issues'
  const url = address.url ?? (links.gitlab?.webUrl && iid ? `${links.gitlab.webUrl}/-/${page}/${iid}` : '')
  return { url, label: kind === 'merge_request'
    ? { zh: `GitLab 合并请求 !${iid}`, en: `Merge request !${iid} on GitLab` }
    : { zh: `GitLab #${iid}`, en: `GitLab #${iid}` } }
}
