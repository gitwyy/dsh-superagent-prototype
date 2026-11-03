/** Normalizes GitLab todos, issues, merge requests, notes, discussions, and pipelines into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type ThreadRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** The two things a project thread can be; their IIDs collide, so a Thread id always names its kind. */
export type GitlabKind = 'issue' | 'merge_request'
/** The project a Trigger belongs to, as setup resolved it. */
export interface GitlabProject { projectId: number; project: string; webUrl?: string }
/** What a pending todo can tell the Source: a mention or direct address, or a request no note carries. */
export const TODO_ACTIONS = ['mentioned', 'directly_addressed', 'assigned', 'review_requested'] as const
export type TodoAction = typeof TODO_ACTIONS[number]
/** Actions GitLab records only as a notification; the todo becomes the Trigger, because no note carries them. */
const REQUEST_ACTIONS: ReadonlySet<string> = new Set(['assigned', 'review_requested'])
const same = (value: string, expected: string): boolean => sameName(value, expected)

/** Thread of an Issue or a merge request, whose key is `gitlab:issue:<iid>` or `gitlab:merge_request:<iid>`. */
export const gitlabThread = (kind: GitlabKind, iid: number): ThreadRef => ({ source: SOURCE, id: `${kind}:${iid}` })
/** Stable key of a GitLab thread, the same the Engine stores subscriptions, follows and Channels by. */
export const gitlabThreadKey = (kind: GitlabKind, iid: number): string => `${SOURCE}:${kind}:${iid}`
/** The web page of an Issue or merge request, built from the project when the payload names none. */
export const gitlabPage = (kind: GitlabKind, iid: number, project?: Pick<GitlabProject, 'webUrl'>): string =>
  project?.webUrl ? `${project.webUrl}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}` : ''
/** Message id of a note in a thread's context reader; the description's is `<kind>:<iid>`. */
export const noteMessageId = (noteId: number): string => `note:${noteId}`
export const descriptionMessageId = (kind: GitlabKind, iid: number): string => `${kind}:${iid}`
/** The hidden HTML comment that marks a reply the channel posted, so a retried send finds it instead of posting twice. */
export const marker = (messageId: string): string => `<!-- dsh-superagent:${messageId} -->`
export const hasMarker = (text: string, messageId: string): boolean => text.includes(marker(messageId))
/** Where a diff note sits in its merge request's diff; an inline reply keeps the place so it lands on the same line. */
export interface GitlabPlace { path: string; line?: number; side?: 'new' | 'old' }
/**
 * GitLab's reply address: an Issue's or merge request's conversation, one of its discussions when known, and a diff note's
 * file and line when the Trigger came from one, which a reply needs to open a new inline thread on the same place.
 */
export const gitlabChannel = (kind: GitlabKind, iid: number, project: string, url?: string, discussionId?: string,
  place?: GitlabPlace): ChannelRef =>
  ({ source: SOURCE, thread: gitlabThreadKey(kind, iid), address: { project, kind, iid: String(iid),
    ...(url ? { url } : {}), ...(discussionId ? { discussionId } : {}),
    ...(place ? { path: place.path, ...place.line != null ? { line: String(place.line) } : {}, ...place.side ? { side: place.side } : {} } : {}) } })

export const GitlabUserSchema = z.looseObject({ id: z.number().optional(), username: z.string(), name: z.string().nullish(),
  bot: z.boolean().nullish(), state: z.string().nullish() })
export type GitlabUser = z.infer<typeof GitlabUserSchema>
/**
 * True when GitLab reports an account as automated. Nested authors in issues, merge requests and notes omit `bot`, so the
 * agent's own login and the shapes service and project bots use are recognized too, as the API contract requires.
 */
export const isBot = (user: Pick<GitlabUser, 'username' | 'bot'>, agent: string): boolean =>
  same(user.username, agent) || user.bot === true || /(?:^|[_-])bot(?:[_-]|$)/i.test(user.username) || /service[_-]?account/i.test(user.username)
export const isHuman = (user: Pick<GitlabUser, 'username' | 'bot'>, agent: string): boolean => !isBot(user, agent)
/** True when `text` mentions `login`, in GitLab's user-name character set; not inside a longer name or an e-mail address. */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9_.@-])@${escapeRegExp(login)}(?![A-Za-z0-9_.-])`, 'i').test(text)

export const IssueSchema = z.looseObject({ id: z.number().optional(), iid: z.number().int().positive(), project_id: z.number().nullish(),
  title: z.string(), description: z.string().nullish(), state: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), author: GitlabUserSchema.nullish(),
  assignees: z.array(GitlabUserSchema).nullish(), labels: z.array(z.unknown()).nullish(), web_url: z.string().nullish(),
  references: z.looseObject({ short: z.string().nullish() }).nullish() })
export type GitlabIssue = z.infer<typeof IssueSchema>
export const PipelineSchema = z.looseObject({ id: z.number().int().positive(), iid: z.number().nullish(), sha: z.string(),
  ref: z.string().nullish(), status: z.string(), source: z.string().nullish(), created_at: z.string().nullish(),
  updated_at: z.string().nullish(), web_url: z.string().nullish(), user: GitlabUserSchema.nullish(),
  detailed_status: z.looseObject({ text: z.string().nullish(), group: z.string().nullish() }).nullish() })
export type GitlabPipeline = z.infer<typeof PipelineSchema>
export const JobSchema = z.looseObject({ id: z.number().int().positive(), name: z.string(), stage: z.string().nullish(),
  status: z.string(), allow_failure: z.boolean().nullish() })
export type GitlabJob = z.infer<typeof JobSchema>
export const MergeRequestSchema = z.looseObject({ id: z.number().optional(), iid: z.number().int().positive(), project_id: z.number().nullish(),
  title: z.string(), description: z.string().nullish(), state: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), author: GitlabUserSchema.nullish(),
  source_branch: z.string().nullish(), target_branch: z.string().nullish(),
  source_project_id: z.number().nullish(), target_project_id: z.number().nullish(), sha: z.string().nullish(),
  merge_commit_sha: z.string().nullish(), squash_commit_sha: z.string().nullish(), merged_at: z.string().nullish(),
  closed_at: z.string().nullish(), merged_by: GitlabUserSchema.nullish(), reviewers: z.array(GitlabUserSchema).nullish(),
  detailed_merge_status: z.string().nullish(), merge_status: z.string().nullish(), has_conflicts: z.boolean().nullish(),
  blocking_discussions_resolved: z.boolean().nullish(), draft: z.boolean().nullish(), work_in_progress: z.boolean().nullish(),
  changes_count: z.string().nullish(), diff_refs: z.looseObject({ base_sha: z.string(), start_sha: z.string(), head_sha: z.string() }).nullish(),
  head_pipeline: PipelineSchema.nullish(), pipeline: PipelineSchema.nullish(), web_url: z.string().nullish(),
  user_notes_count: z.number().nullish(), references: z.looseObject({ short: z.string().nullish() }).nullish() })
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
/** A note of a discussion; a `DiffNote` carries the file and line it comments on, and has no `discussion_id` on this instance. */
export const NoteSchema = z.looseObject({ id: z.number().int().positive(), body: z.string().nullish(), system: z.boolean().nullish(),
  type: z.string().nullish(), author: GitlabUserSchema.nullish(), created_at: z.string().nullish(), updated_at: z.string().nullish(),
  resolvable: z.boolean().nullish(), resolved: z.boolean().nullish(),
  position: z.looseObject({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().nullish(),
    old_line: z.number().nullish(), position_type: z.string().nullish() }).nullish(),
  noteable_type: z.string().nullish(), noteable_iid: z.number().nullish(), project_id: z.number().nullish() })
export type GitlabNote = z.infer<typeof NoteSchema>
/** A discussion groups the notes of one thread; standalone notes are discussions of their own (`individual_note`). */
export const DiscussionSchema = z.looseObject({ id: z.string(), individual_note: z.boolean().nullish(), notes: z.array(NoteSchema) })
export type GitlabDiscussion = z.infer<typeof DiscussionSchema>
/** A pending notification of the agent account; `target.iid` and `target_url` name the Issue or merge request it is on. */
export const TodoSchema = z.looseObject({ id: z.number().int().positive(), action_name: z.string(), target_type: z.string(),
  target: z.looseObject({ iid: z.number().nullish(), project_id: z.number().nullish(), title: z.string().nullish(),
    description: z.string().nullish(), web_url: z.string().nullish(), author: GitlabUserSchema.nullish() }).nullish(),
  target_url: z.string().nullish(), body: z.string().nullish(), state: z.string().nullish(),
  project: z.looseObject({ id: z.number(), path_with_namespace: z.string().nullish() }).nullish(),
  author: GitlabUserSchema.nullish(), created_at: z.string().nullish(), updated_at: z.string().nullish() })
export type GitlabTodo = z.infer<typeof TodoSchema>

/** What one todo asks the Source to do: which thread to read, and the timestamp its new messages must not precede. */
export interface TodoTarget { todoId: number; action: TodoAction; kind: GitlabKind; iid: number; since: string }
/** A todo read that failed, kept so the next round reads it again; abandoned after a day, as GitHub's notification retries are. */
export interface GitlabRetry { todo: GitlabTodo; failedAt: string; attempts: number }
const KIND_OF: Readonly<Record<string, GitlabKind>> = { Issue: 'issue', MergeRequest: 'merge_request' }
/** Reads the kind and IID a todo target or URL names without trusting either alone. */
function targetOf(todo: GitlabTodo): { kind: GitlabKind; iid: number } | undefined {
  const url = todo.target_url ?? ''
  const listed = /(?:\/|-)merge_requests\/(\d+)/.exec(url) ?? /(?:\/|-)issues\/(\d+)/.exec(url)
  const kind = KIND_OF[todo.target_type] ?? (/\/merge_requests\//.test(url) ? 'merge_request' : /\/issues\//.test(url) ? 'issue' : undefined)
  const iid = todo.target?.iid ?? (listed ? Number(listed[1]) : Number.NaN)
  return kind && Number.isFinite(iid) ? { kind, iid } : undefined
}
/**
 * What a pending todo asks for, or undefined when it is none of the Source's business: another project's, an action it
 * does not receive, or one the agent itself caused (self-assignment, self-mention). Ordinary replies create no todo, which
 * is why subscribed Threads and the observed streams are polled as well.
 */
export function todoTarget(todo: GitlabTodo, project: GitlabProject, agent: string): TodoTarget | undefined {
  if (!TODO_ACTIONS.includes(todo.action_name as TodoAction)) return undefined
  const belongs = todo.project?.id === project.projectId || todo.target?.project_id === project.projectId
  if (!belongs) return undefined
  if (todo.author && same(todo.author.username, agent)) return undefined
  const target = targetOf(todo)
  if (!target) return undefined
  const since = todo.created_at ?? todo.updated_at ?? new Date().toISOString()
  return { todoId: todo.id, action: todo.action_name as TodoAction, ...target, since }
}
/** True for the todos whose request exists only as the notification, so the todo itself reaches the agent. */
export const isTodoRequest = (action: string): boolean => REQUEST_ACTIONS.has(action)

const author = (user: GitlabUser | null | undefined, agent: string, id: string) =>
  ({ actor: { source: SOURCE, id: user?.username ?? id }, human: !!user && isHuman(user, agent) })
const timeOf = (...times: (string | null | undefined)[]): string => times.find(Boolean) ?? new Date().toISOString()
const channelOf = (kind: GitlabKind, iid: number, project: GitlabProject, url?: string, discussionId?: string,
  place?: GitlabPlace): ChannelRef => gitlabChannel(kind, iid, project.project, url, discussionId, place)
/** Stable ID of a new Issue's body; an edit changes nothing, so the same body is never ingested twice. */
export const issueTriggerId = (todoProjectId: number | null | undefined, iid: number, createdAt: string | null | undefined): string =>
  key('gitlab-issue', String(todoProjectId ?? ''), String(iid), createdAt ?? '')
/** Stable ID of a new merge request's body, the same with the same inputs. */
export const mergeRequestTriggerId = (mrProjectId: number | null | undefined, iid: number, createdAt: string | null | undefined): string =>
  key('gitlab-mr', String(mrProjectId ?? ''), String(iid), createdAt ?? '')
/** Stable ID of a note; an edit gets a new `updated_at` and so a new version, as GitHub's comments do. */
export const noteTriggerId = (todoProjectId: number | null | undefined, noteId: number, version: string | null | undefined): string =>
  key('gitlab-note', String(todoProjectId ?? ''), String(noteId), version ?? '')
/** A note's text: its file and line first for a diff note, then the body. */
export function noteText(note: GitlabNote): string {
  const line = note.position?.new_line ?? note.position?.old_line
  const path = note.position?.new_path ?? note.position?.old_path
  return [path ? `${path}${line != null ? `:${line}` : ''}` : '', note.body ?? ''].filter(Boolean).join('\n\n')
}
/** The file and line a diff note comments on, for a ContextMessage. */
export function notePlace(note: GitlabNote): { path: string; line?: number } | undefined {
  const path = note.position?.new_path ?? note.position?.old_path
  if (!path) return undefined
  const line = note.position?.new_line ?? note.position?.old_line
  return { path, ...line != null ? { line } : {} }
}
/** Builds the Trigger for a newly opened Issue's title and body; callers skip the agent's own and Issues older than a cursor. */
export function issueTrigger(issue: GitlabIssue, project: GitlabProject, agent: string): Trigger {
  const body = issue.description ?? ''
  const url = issue.web_url ?? gitlabPage('issue', issue.iid, project)
  return { id: issueTriggerId(issue.project_id ?? project.projectId, issue.iid, issue.created_at), source: SOURCE,
    threads: [gitlabThread('issue', issue.iid)], ...author(issue.author, agent, ''), at: timeOf(issue.created_at, issue.updated_at),
    text: `${issue.title}\n\n${body}`, ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: channelOf('issue', issue.iid, project, url), ...(url ? { url } : {}),
    meta: { kind: 'issue', iid: issue.iid, projectId: project.projectId, project: project.project,
      ...(issue.author ? { author: issue.author.username } : {}), ...(url ? { webUrl: url } : {}) } }
}
/** Builds the Trigger for a newly opened merge request's title and description. */
export function mergeRequestTrigger(mr: GitlabMergeRequest, project: GitlabProject, agent: string): Trigger {
  const body = mr.description ?? ''
  const url = mr.web_url ?? gitlabPage('merge_request', mr.iid, project)
  return { id: mergeRequestTriggerId(mr.project_id ?? project.projectId, mr.iid, mr.created_at), source: SOURCE,
    threads: [gitlabThread('merge_request', mr.iid)], ...author(mr.author, agent, ''), at: timeOf(mr.created_at, mr.updated_at),
    text: `${mr.title}\n\n${body}`, ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: channelOf('merge_request', mr.iid, project, url), ...(url ? { url } : {}),
    meta: { kind: 'merge_request', iid: mr.iid, projectId: project.projectId, project: project.project,
      ...(mr.author ? { mrAuthor: mr.author.username, author: mr.author.username } : {}), ...(url ? { webUrl: url } : {}) } }
}
/** Where a note lives: its thread, the page its Trigger opens, and the discussion it belongs to when the read grouped it. */
export interface NoteRef { kind: GitlabKind; iid: number; webUrl?: string; discussionId?: string }
/** The side of the diff a note comments on: the new lines unless GitLab names only an old one. */
const noteSide = (note: GitlabNote): GitlabPlace['side'] | undefined =>
  note.position ? (note.position.new_line != null ? 'new' : note.position.old_line != null ? 'old' : undefined) : undefined
/**
 * Builds the Trigger for one note of an Issue or merge request. GitLab's system notes (assignment, review requests,
 * resolution, merge references) are not messages from a person, and the agent's own notes are not requests to it, so neither
 * becomes a Trigger; callers also skip notes older than their cursor.
 */
export function noteTrigger(note: GitlabNote, ref: NoteRef, project: GitlabProject, agent: string): Trigger | undefined {
  if (note.system === true) return undefined
  if (!note.author || same(note.author.username, agent)) return undefined
  const text = noteText(note)
  // An empty note without a file position says nothing; a diff note without a body still points at code the agent must read.
  if (!text) return undefined
  const url = ref.webUrl ? `${ref.webUrl}#note_${note.id}` : undefined
  const placed = notePlace(note)
  const side = noteSide(note)
  const place = placed && { ...placed, ...side ? { side } : {} }
  return { id: noteTriggerId(note.project_id ?? project.projectId, note.id, note.updated_at ?? note.created_at), source: SOURCE,
    threads: [gitlabThread(ref.kind, ref.iid)], ...author(note.author, agent, ''), at: timeOf(note.updated_at, note.created_at),
    text, ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: channelOf(ref.kind, ref.iid, project, url, ref.discussionId, place), ...(url ? { url } : {}),
    meta: { kind: 'note', targetKind: ref.kind, iid: ref.iid, projectId: project.projectId, project: project.project,
      noteId: note.id, ...(ref.webUrl ? { webUrl: ref.webUrl } : {}), ...(ref.discussionId ? { discussionId: ref.discussionId } : {}),
      ...(note.type ? { noteType: note.type } : {}), ...placed ? { path: placed.path, line: placed.line ?? null } : {},
      ...(note.resolvable ? { resolvable: true, resolved: note.resolved === true } : {}) } }
}
/**
 * Builds the Trigger for a todo whose request exists only as the notification, such as an assignment or a review request,
 * which GitLab records as a system note the Source must not read as a message. It is not `addressed`: only a mention is.
 */
export function todoTrigger(todo: GitlabTodo, target: TodoTarget, project: GitlabProject, agent: string): Trigger {
  const url = todo.target?.web_url ?? gitlabPage(target.kind, target.iid, project)
  const name = `${target.kind === 'issue' ? '#' : '!'}${target.iid}`
  const title = todo.target?.title ?? todo.body ?? ''
  const text = target.action === 'assigned' ? `${name} ${title} was assigned to you`.trim()
    : `Your review was requested on ${name} ${title}`.trim()
  return { id: key('gitlab-todo', String(target.todoId)), source: SOURCE, threads: [gitlabThread(target.kind, target.iid)],
    ...author(todo.author, agent, ''), at: target.since, text,
    channel: channelOf(target.kind, target.iid, project, url), ...(url ? { url } : {}),
    meta: { kind: target.kind, iid: target.iid, projectId: project.projectId, project: project.project, todoId: target.todoId,
      action: target.action, ...(title ? { title } : {}) } }
}
/** Builds a Trigger for a default-branch CI change; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(branch: string, pipeline: GitlabPipeline, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false,
    at: timeOf(pipeline.updated_at, pipeline.created_at), text: summary, ...(url ? { url } : {}),
    meta: { ci: true, branch, sha: pipeline.sha, revision, pipelineId: pipeline.id } }
}
/**
 * Builds the Trigger for a change of a merge request's head pipeline. CI has no person behind it, so its actor id is empty,
 * and the change reaches the Ticket bound to the merge request's Thread, where a reply may still be posted. Its `ci` meta
 * names no `branch`, so it is listened to without being observed: a CI change never originates a candidate, and the Policy's
 * `ci` row stays the default branch's.
 */
export function mergeRequestCiTrigger(mr: Pick<GitlabMergeRequest, 'iid' | 'web_url'>, pipeline: GitlabPipeline,
  project: GitlabProject, revision: number, summary: string): Trigger {
  const url = pipeline.web_url ?? mr.web_url ?? gitlabPage('merge_request', mr.iid, project)
  return { id: key('gitlab-ci', `mr:${mr.iid}`, String(revision)), source: SOURCE, threads: [gitlabThread('merge_request', mr.iid)],
    actor: { source: SOURCE, id: '' }, human: false, at: timeOf(pipeline.updated_at, pipeline.created_at), text: summary,
    channel: channelOf('merge_request', mr.iid, project, mr.web_url ?? undefined), ...(url ? { url } : {}),
    meta: { ci: true, kind: 'merge_request', iid: mr.iid, revision, pipelineId: pipeline.id, sha: pipeline.sha } }
}
