/** GitLab outbound channel: posts notes on an Issue or merge request, into one of its discussions, or inline at a diff note's place. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { DiscussionSchema, marker, MergeRequestSchema, NoteSchema, type GitlabKind, type GitlabNote } from './gitlab-trigger.ts'

/** The Issue or merge request a Channel address names. */
function target(address: Record<string, string>): { kind: GitlabKind; iid: number } | undefined {
  const kind = address.kind === 'merge_request' ? 'merge_request' : address.kind === 'issue' ? 'issue' : undefined
  const iid = Number(address.iid)
  return kind && Number.isInteger(iid) && iid > 0 ? { kind, iid } : undefined
}
/** The file and line a diff note Trigger kept on its address, which an inline reply lands on. */
function place(address: Record<string, string>): { path: string; line: number; side?: 'old' } | undefined {
  const line = Number(address.line)
  if (!address.path || !Number.isInteger(line) || line <= 0) return undefined
  return { path: address.path, line, ...(address.side === 'old' ? { side: 'old' as const } : {}) }
}
/** True when the Issue or merge request is locked against new notes, which no retry can change. */
const locked = (error: unknown): boolean => error instanceof CliError && error.code === 403 && /lock/i.test(error.message)
/** True when GitLab answers that the discussion or conversation does not exist (a deleted issue or merge request, or lost access). */
const missing = (error: unknown): boolean => error instanceof CliError && error.code === 404
const objectPath = (kind: GitlabKind, iid: number): string => kind === 'issue' ? `issues/${iid}` : `merge_requests/${iid}`
/**
 * The `position` a new inline diff note needs, built from the merge request's `diff_refs`, or undefined while GitLab still
 * prepares the merge request and reports none.
 */
export async function diffPosition(commands: Commands, iid: number, at: { path: string; line: number; side?: 'old' }):
  Promise<Record<string, string | number> | undefined> {
  const refs = (await commands.gitlabApi(MergeRequestSchema, `merge_requests/${iid}`)).diff_refs
  if (!refs) return undefined
  return { position_type: 'text', base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha,
    old_path: at.path, new_path: at.path, ...at.side === 'old' ? { old_line: at.line } : { new_line: at.line } }
}
/** Posts a new inline diff note on the merge request at `at`; false when GitLab has not prepared the merge request's diff refs yet. */
async function replyInline(commands: Commands, iid: number, text: string, at: { path: string; line: number; side?: 'old' }): Promise<boolean> {
  const position = await diffPosition(commands, iid, at)
  if (!position) return false
  await commands.gitlabPost(z.unknown(), `merge_requests/${iid}/discussions`, { body: text, position })
  return true
}
/**
 * Posts a note on an Issue or merge request, a reply in one of its discussions, or a new inline diff note where the reply's
 * address kept a diff note's file and line, with an embedded HTML marker so a retried send finds the note instead of posting it
 * twice. A 404 is told apart from a lost project by reading the project once.
 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitlab = commands.deployment.gitlab
  if (!gitlab) throw new Error('The GitLab Source has no working CLI')
  const reply = target(message.channel.address)
  if (!reply) throw new Error('Missing GitLab reply target')
  const base = objectPath(reply.kind, reply.iid)
  const token = marker(message.id)
  const mine = (note: GitlabNote): boolean => sameName(note.author?.username ?? '', gitlab.login) && (note.body ?? '').includes(token)
  const conversation = `${base}/notes`
  const discussionId = message.channel.address.discussionId
  const at = place(message.channel.address)
  // GitLab's notes list accepts `only_comments`/`only_system` for `activity_filter`, not `all`; the marker is on a comment.
  const posted = (): Promise<GitlabNote[]> => commands.gitlabApi(z.array(NoteSchema),
    `${conversation}?per_page=100&sort=desc&activity_filter=only_comments`)
  try {
    // Retained Channel addresses name their discussion; one GitLab no longer finds falls back to the conversation.
    const retained = discussionId
      ? await commands.gitlabApi(DiscussionSchema, `${base}/discussions/${encodeURIComponent(discussionId)}`)
        .catch((error: unknown) => { if (missing(error)) return undefined; throw error })
      : undefined
    if (retained?.notes.some(mine)) return 'sent'
    if (retained) {
      await commands.gitlabApi(z.unknown(), `${base}/discussions/${encodeURIComponent(discussionId!)}/notes`, '--method', 'POST',
        '-f', `body=${message.text}\n\n${token}`)
      return 'sent'
    }
    if ((await posted()).some(mine)) return 'sent'
    // A diff note's reply keeps its line: a new inline discussion, and only a merge request GitLab still prepares falls back.
    if (at && reply.kind === 'merge_request' && await replyInline(commands, reply.iid, `${message.text}\n\n${token}`, at)) return 'sent'
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
/**
 * Resolves or reopens one discussion of an Issue or merge request with `PUT …/discussions/:id?resolved=true`, which GitLab
 * accepts only for a resolvable thread: a review thread the ticket settled. The GitLab skill has the worker run the same call
 * through glab, so this is the behavior the skill's command must reproduce.
 */
export async function resolveGitlabDiscussion(commands: Commands, kind: GitlabKind, iid: number, discussionId: string,
  resolved: boolean): Promise<void> {
  await commands.gitlabApi(z.unknown(), `${objectPath(kind, iid)}/discussions/${encodeURIComponent(discussionId)}?resolved=${resolved}`,
    '--method', 'PUT')
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
