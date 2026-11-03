/** Read-only GitLab issue, merge request, discussion, pipeline, repository, and approval inspection for assessments and workers. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { descriptionMessageId, DiscussionSchema, IssueSchema, JobSchema, MergeRequestSchema, noteMessageId, notePlace, NoteSchema,
  noteText, PipelineSchema, type GitlabIssue, type GitlabJob, type GitlabKind, type GitlabMergeRequest, type GitlabNote,
  type GitlabPipeline, GitlabUserSchema, isHuman } from './gitlab-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** Everything a polling round reads of one conversation: its Issue or merge request, its discussions, and their notes. */
export interface GitlabThreadRead { kind: GitlabKind; iid: number; object: GitlabIssue | GitlabMergeRequest
  discussions: { id: string; notes: GitlabNote[] }[]; webUrl: string }
/** One note of a conversation page, with the discussion it belongs to and the note it answers there. */
interface PageNote { note: GitlabNote; discussionId: string; replyTo?: string }
export const issuePath = (iid: number): string => `issues/${iid}`
export const mergeRequestPath = (iid: number): string => `merge_requests/${iid}`
const objectPath = (kind: GitlabKind, iid: number): string => kind === 'issue' ? issuePath(iid) : mergeRequestPath(iid)
export const notePath = (kind: GitlabKind, iid: number): string => `${objectPath(kind, iid)}/notes`
export const discussionPath = (kind: GitlabKind, iid: number): string => `${objectPath(kind, iid)}/discussions`
export const readIssue = (commands: Commands, iid: number): Promise<GitlabIssue> => commands.gitlabApi(IssueSchema, issuePath(iid))
export const readMergeRequest = (commands: Commands, iid: number): Promise<GitlabMergeRequest> =>
  commands.gitlabApi(MergeRequestSchema, mergeRequestPath(iid))
export const readPipeline = (commands: Commands, id: number): Promise<GitlabPipeline> => commands.gitlabApi(PipelineSchema, `pipelines/${id}`)
export const readPipelineJobs = (commands: Commands, id: number, tally?: Tally): Promise<GitlabJob[]> =>
  commands.gitlabPages(JobSchema, `pipelines/${id}/jobs?per_page=100`, tally)
/** An entry of a repository directory (`GET …/repository/tree`); `type` is `tree` for a directory and `blob` for a file. */
export const TreeEntrySchema = z.looseObject({ id: z.string().nullish(), name: z.string(), type: z.string().nullish(), path: z.string().nullish() })
export type GitlabTreeEntry = z.infer<typeof TreeEntrySchema>
/** A branch of the project; `commit` names its head, which a worker reads before pushing or merging. */
export const BranchSchema = z.looseObject({ name: z.string(), default: z.boolean().nullish(), protected: z.boolean().nullish(),
  merged: z.boolean().nullish(), commit: z.looseObject({ id: z.string(), short_id: z.string().nullish(), title: z.string().nullish(),
    created_at: z.string().nullish() }).nullish() })
export type GitlabBranch = z.infer<typeof BranchSchema>
/**
 * A merge request's approval state. GitLab serves it only in tiers that have approvals enabled: the endpoint answers 403 or
 * 404 elsewhere, which is "unsupported", never a failed read.
 */
export const ApprovalsSchema = z.looseObject({ id: z.number().nullish(), iid: z.number().nullish(), project_id: z.number().nullish(),
  title: z.string().nullish(), state: z.string().nullish(), approvals_required: z.number().nullish(), approvals_left: z.number().nullish(),
  approved: z.boolean().nullish(), approved_by: z.array(z.looseObject({ user: GitlabUserSchema.nullish() })).nullish() })
export type GitlabApprovals = z.infer<typeof ApprovalsSchema>
/** What a merge request's approval read found, or that this GitLab refuses to report approvals at all. */
export type ApprovalRead = { supported: false } | { supported: true; approvals_required: number; approvals_left: number;
  approved: boolean; approved_by: string[] }
/** Reads the approval state read-only, degrading to `supported: false` on the 403/404 a GitLab without approvals answers. */
export async function readMergeRequestApprovals(commands: Commands, iid: number): Promise<ApprovalRead> {
  try {
    const item = await commands.gitlabApi(ApprovalsSchema, `${mergeRequestPath(iid)}/approvals`)
    return { supported: true, approvals_required: item.approvals_required ?? 0, approvals_left: item.approvals_left ?? 0,
      approved: item.approved ?? false, approved_by: (item.approved_by ?? []).flatMap(entry => entry.user?.username ? [entry.user.username] : []) }
  } catch (error) {
    if (error instanceof CliError && (error.code === 403 || error.code === 404)) return { supported: false }
    throw error
  }
}
/** The branch repository reads use: the project's default branch, or `HEAD` when setup recorded none. */
const defaultRef = (commands: Commands): string => commands.deployment.gitlab?.defaultBranch || 'HEAD'
/** A repository path as its parts, refusing hidden entries, parent references and dependencies as GitHub's repository reads do. */
function repositoryParts(path: string): string[] {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  return parts
}
/** The API path of a directory listing, whose `path` parameter is omitted at the repository root. */
const treePath = (parts: string[], ref: string): string =>
  `${parts.length ? `repository/tree?path=${encodeURIComponent(parts.join('/'))}&ref=` : 'repository/tree?ref='}${encodeURIComponent(ref)}&per_page=100`
/**
 * Reads a non-hidden repository file's raw text or a directory's entry names (sorted, one per line) from the project's
 * default branch, as GitHub's repository reads answer; assessments use it for a GitLab deployment.
 */
export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = repositoryParts(path)
  const ref = defaultRef(commands)
  if (kind === 'file') return commands.gitlabApi(`repository/files/${encodeURIComponent(parts.join('/'))}/raw?ref=${encodeURIComponent(ref)}`)
  const entries = await commands.gitlabPages(TreeEntrySchema, treePath(parts, ref))
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
/** The discussions of an Issue or merge request; an issue discussions 404 falls back to its notes, grouped individually. */
export async function readDiscussions(commands: Commands, kind: GitlabKind, iid: number, tally?: Tally): Promise<{ id: string; notes: GitlabNote[] }[]> {
  try {
    const discussions = await commands.gitlabPages(DiscussionSchema, `${discussionPath(kind, iid)}?per_page=100`, tally)
    return discussions.map(discussion => ({ id: discussion.id, notes: discussion.notes }))
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 404) throw error
    const notes = await commands.gitlabPages(NoteSchema, `${notePath(kind, iid)}?per_page=100&sort=asc&order_by=created_at&activity_filter=only_comments`, tally)
    return notes.map(note => ({ id: '', notes: [note] }))
  }
}
/** Reads a conversation once: its Issue or merge request (when the caller has it already), its discussions, and their notes. */
export async function readThread(commands: Commands, kind: GitlabKind, iid: number, object?: GitlabIssue | GitlabMergeRequest,
  tally?: Tally): Promise<GitlabThreadRead> {
  const item = object ?? (kind === 'issue' ? await readIssue(commands, iid) : await readMergeRequest(commands, iid))
  const discussions = await readDiscussions(commands, kind, iid, tally)
  return { kind, iid, object: item, discussions, webUrl: item.web_url ?? '' }
}
/** The thread kind, IID, note and discussion a GitLab Trigger points at. */
export function targetOf(meta: Record<string, unknown>): { kind: GitlabKind; iid: number; noteId?: number; discussionId?: string; webUrl?: string } | undefined {
  const kind = meta.kind === 'issue' || meta.kind === 'merge_request' ? meta.kind
    : meta.targetKind === 'issue' || meta.targetKind === 'merge_request' ? meta.targetKind : undefined
  const iid = Number(meta.iid)
  if (!kind || !Number.isFinite(iid) || iid <= 0) return undefined
  const noteId = Number(meta.noteId)
  const discussionId = typeof meta.discussionId === 'string' && meta.discussionId ? meta.discussionId : undefined
  const webUrl = typeof meta.webUrl === 'string' && meta.webUrl ? meta.webUrl : undefined
  return { kind, iid, ...Number.isFinite(noteId) && noteId > 0 ? { noteId } : {}, ...discussionId ? { discussionId } : {},
    ...webUrl ? { webUrl } : {} }
}
/** The page of notes a conversation's discussions hold, in message order, each after its discussion's first note answering it. */
async function discussionPage(commands: Commands, kind: GitlabKind, iid: number, page: number, tally?: Tally) {
  try {
    const listed = await commands.gitlabApi(z.array(z.unknown()), `${discussionPath(kind, iid)}?per_page=100&page=${page}`)
    const discussions = validItems(DiscussionSchema, listed, tally)
    const notes: PageNote[] = []
    for (const discussion of discussions) {
      let first: number | undefined
      for (const note of discussion.notes) {
        if (note.system === true) continue
        notes.push({ note, discussionId: discussion.id, ...first !== undefined ? { replyTo: noteMessageId(first) } : {} })
        first ??= note.id
      }
    }
    return { notes: notes.sort((a, b) => (a.note.created_at ?? '').localeCompare(b.note.created_at ?? '')), complete: listed.length < 100 }
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 404) throw error
    const listed = await commands.gitlabApi(z.array(z.unknown()), `${notePath(kind, iid)}?per_page=100&page=${page}&sort=asc&order_by=created_at&activity_filter=only_comments`)
    const notes: PageNote[] = validItems(NoteSchema, listed, tally).map(note => ({ note, discussionId: '' }))
    return { notes, complete: listed.length < 100 }
  }
}
/** A conversation message, which also names the discussion a reply must use and whether that thread can be and is resolved. */
export interface GitlabContextMessage extends ContextMessage { discussion?: string; resolvable?: boolean; resolved?: boolean }
/** The file:line prefix of a diff note, so a reply in its discussion reads in place. */
function noteMessage(note: GitlabNote, webUrl: string, login: string, replyTo?: string, discussion?: string): GitlabContextMessage {
  const place = notePlace(note)
  return { id: noteMessageId(note.id), from: note.author?.username ?? '', at: note.created_at ?? note.updated_at ?? '',
    text: noteText(note), ...note.author && !isHuman(note.author, login) ? { bot: true as const } : {},
    ...webUrl ? { url: `${webUrl}#note_${note.id}` } : {}, ...place ?? {}, ...replyTo ? { reply_to: replyTo } : {},
    ...discussion ? { discussion } : {}, ...note.resolvable ? { resolvable: true, resolved: note.resolved === true } : {} }
}
/** The description of an Issue or merge request as a message, whose id names the description rather than a note. */
function objectMessage(object: GitlabIssue | GitlabMergeRequest, kind: GitlabKind, webUrl: string, login: string): ContextMessage {
  return { id: descriptionMessageId(kind, object.iid), from: object.author?.username ?? '', at: object.created_at ?? '',
    text: `${object.title}\n\n${object.description ?? ''}`, ...object.author && !isHuman(object.author, login) ? { bot: true as const } : {},
    ...webUrl ? { url: webUrl } : {} }
}
/** Context reader for a GitLab Trigger: the description for a root, a discussion for one of its notes, else the conversation by page. */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => {
    const target = targetOf(trigger.meta)
    return target?.noteId ? noteMessageId(target.noteId) : descriptionMessageId(target?.kind ?? 'issue', target?.iid ?? 0)
  },
  read: async (commands, trigger, part, cursor) => {
    // The default branch's CI has no conversation; its Trigger is its context. A merge request's CI does have one.
    if (trigger.meta.ci === true && typeof trigger.meta.branch === 'string') {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
    }
    const target = targetOf(trigger.meta)
    if (!target) throw new Error('The GitLab trigger names no issue or merge request')
    const login = commands.deployment.gitlab?.login ?? ''
    // A note of a discussion reads with its discussion, whose first note is its root and parent.
    if (target.noteId && part !== 'root') {
      let notes: GitlabNote[] = []
      let webUrl = target.webUrl ?? ''
      if (target.discussionId) {
        const discussion = await commands.gitlabApi(DiscussionSchema, `${discussionPath(target.kind, target.iid)}/${encodeURIComponent(target.discussionId)}`)
        notes = discussion.notes
      } else {
        const read = await readThread(commands, target.kind, target.iid)
        const discussion = read.discussions.find(item => item.notes.some(note => note.id === target.noteId))
        notes = discussion?.notes ?? []
        webUrl = read.webUrl
      }
      const visible = notes.filter(note => note.system !== true)
      if (visible.length) {
        const [first] = visible
        const messages = visible.flatMap(note => [noteMessage(note, webUrl, login, note === first ? undefined : noteMessageId(first!.id), target.discussionId)])
        const shown = part === 'parent' ? messages.slice(0, 1) : messages
        return { messages: shown, body: { status: 'discussion_thread', messages: shown }, status: 'discussion_thread' }
      }
    }
    if (part === 'root' || part === 'parent') {
      const object = target.kind === 'issue' ? await readIssue(commands, target.iid) : await readMergeRequest(commands, target.iid)
      const message = objectMessage(object, target.kind, object.web_url ?? '', login)
      return { messages: [message], body: { status: 'root', messages: [message] }, status: 'root' }
    }
    const page = Number(cursor ?? '1')
    const messages: ContextMessage[] = []
    let webUrl = target.webUrl ?? ''
    if (page === 1) {
      const object = target.kind === 'issue' ? await readIssue(commands, target.iid) : await readMergeRequest(commands, target.iid)
      webUrl = object.web_url ?? webUrl
      messages.push(objectMessage(object, target.kind, webUrl, login))
    }
    const listed = await discussionPage(commands, target.kind, target.iid, page)
    for (const { note, replyTo, discussionId } of listed.notes) {
      const message = noteMessage(note, webUrl, login, replyTo, discussionId)
      if (message.text) messages.push(message)
    }
    const next = listed.complete ? undefined : String(page + 1)
    return { messages, next, body: { messages, next_resource: next ?? null } }
  },
}
/** Check conclusions and pipeline states that count as failures; `pending` never does, since this instance runs no jobs. */
const FAILING = new Set(['failed'])
const RUNNING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'manual'])
export interface PipelineSnapshot { pipeline: GitlabPipeline; jobs: GitlabJob[] }
/** The failing jobs of a pipeline, ignoring those allowed to fail; a failed pipeline with none still counts as `pipeline`. */
export function pipelineFailures(snapshot: PipelineSnapshot): string[] {
  const failed = snapshot.jobs.filter(job => FAILING.has(job.status) && job.allow_failure !== true).map(job => job.name).sort()
  if (failed.length) return failed
  return FAILING.has(snapshot.pipeline.status) ? ['pipeline'] : []
}
export function pipelineRunning(snapshot: PipelineSnapshot): string[] {
  return snapshot.jobs.filter(job => RUNNING.has(job.status)).map(job => job.name)
}
/** True while a pipeline could still change on its own; one pending forever (Auto DevOps without runners) stays quiet. */
export const pipelineUnfinished = (pipeline: GitlabPipeline): boolean => RUNNING.has(pipeline.status)
/** Fingerprint of a pipeline and its failures: a pipeline that stays pending forever never changes it. */
export function pipelineFingerprint(snapshot: PipelineSnapshot): string {
  return `${snapshot.pipeline.id}:${snapshot.pipeline.status}:${pipelineFailures(snapshot).join(',')}`
}
export function pipelineSummary(snapshot: PipelineSnapshot, where: string, read: string): string {
  const { pipeline, jobs } = snapshot
  const failed = pipelineFailures(snapshot)
  const running = pipelineRunning(snapshot)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where || 'the pipeline'} at ${pipeline.sha.slice(0, 7)}`
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `CI failed ${failed.length}/${jobs.length} ${at}: ${names(failed)}${still}`
    : FAILING.has(pipeline.status) ? `CI failed ${at}`
      : RUNNING.has(pipeline.status) ? `CI running ${running.length}/${jobs.length} ${at}${running.length ? `: ${names(running)}` : ''}`
        : `CI passed ${jobs.length}/${jobs.length} ${at}`
  return `${line}\nRead ${read} for every job.`
}
/** The Thread fact a pipeline makes: failed jobs first, then unfinished ones, otherwise passed. */
export function ciFact(snapshot: PipelineSnapshot): ThreadFact {
  const failed = pipelineFailures(snapshot)
  if (failed.length) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(failed.length), problem: true }
  const running = pipelineRunning(snapshot)
  if (running.length) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(running.length) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}

/** One branch as the repository resource reports it, with the head commit a push or merge names. */
const branchView = (branch: GitlabBranch) => ({ name: branch.name, default: branch.default === true, protected: branch.protected === true,
  ...branch.merged === true ? { merged: true } : {},
  ...branch.commit ? { commit: { id: branch.commit.id, short_id: branch.commit.short_id ?? branch.commit.id.slice(0, 8),
    title: branch.commit.title ?? '' } } : {} })
/**
 * Serves the project's read-only repository facts: its default branch, a raw file, a directory listing, and its branches. A
 * path stays inside the project and never names a hidden entry or a dependency, as the assessment's repository reads require.
 */
async function readRepositoryResource(commands: Commands, section: string | undefined, rest: string | undefined): Promise<unknown> {
  const project = commands.deployment.gitlab
  if (!project) throw new Error('The GitLab Source has no working GitLab account')
  const ref = defaultRef(commands)
  if (!section) {
    return { project: project.project, project_id: project.projectId, default_branch: project.defaultBranch || '', ref, web_url: project.webUrl }
  }
  if (section === 'files') {
    if (!rest) throw new Error('Name the file: gitlab/repository/files/<path>')
    const parts = repositoryParts(rest)
    return { path: parts.join('/'), ref, content: await readGitlabRepositoryPath(commands, rest, 'file') }
  }
  if (section === 'tree') {
    const path = rest ? repositoryParts(rest).join('/') : ''
    const names = await readGitlabRepositoryPath(commands, path, 'directory')
    return { path: path || '.', ref, entries: names ? names.split('\n') : [] }
  }
  if (section === 'branches') {
    if (!rest) return { default_branch: project.defaultBranch || '',
      branches: (await commands.gitlabPages(BranchSchema, 'repository/branches?per_page=100')).map(branchView) }
    return branchView(await commands.gitlabApi(BranchSchema, `repository/branches/${encodeURIComponent(rest)}`))
  }
  throw new Error('Use gitlab/repository, gitlab/repository/files/<path>, gitlab/repository/tree/<path>, or gitlab/repository/branches[/<name>]')
}

/**
 * Reads an Issue, a merge request, a page of its notes or discussions, its pipelines, approvals or pipeline jobs, or the
 * project's repository files, trees and branches as model-facing messages and facts rather than raw GitLab API records; the
 * `gitlab/` resources the skills describe.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const repository = /^gitlab\/repository(?:\/([^/]+)(?:\/(.+))?)?$/.exec(resource)
  if (repository) return readRepositoryResource(commands, repository[1], repository[2])
  const jobs = /^gitlab\/pipelines\/(\d+)\/jobs$/.exec(resource)
  if (jobs) {
    const pipeline = await readPipeline(commands, Number(jobs[1]))
    const listed = await readPipelineJobs(commands, pipeline.id)
    return { pipeline: pipelineSummary({ pipeline, jobs: listed }, pipeline.ref ?? '', `gitlab/pipelines/${pipeline.id}/jobs`),
      jobs: listed.map(({ id, name, stage, status, allow_failure }) => ({ id, name, stage, status, allow_failure })) }
  }
  const pipeline = /^gitlab\/pipelines\/(\d+)$/.exec(resource)
  if (pipeline) {
    const item = await readPipeline(commands, Number(pipeline[1]))
    return { id: item.id, iid: item.iid, sha: item.sha, ref: item.ref, status: item.status, source: item.source,
      web_url: item.web_url, created_at: item.created_at, updated_at: item.updated_at }
  }
  const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|discussions|pipelines|approvals)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) {
    throw new Error('Use gitlab/issues/<iid>, gitlab/merge_requests/<iid>, or append /notes/<page>, /discussions/<page>, /pipelines or /approvals; or gitlab/pipelines/<id>[/jobs]; or gitlab/repository[...]')
  }
  const [, listed, iidText, section, pageText = '1'] = match
  const kind: GitlabKind = listed === 'issues' ? 'issue' : 'merge_request'
  const iid = Number(iidText)
  const login = commands.deployment.gitlab?.login ?? ''
  if (!section) {
    const object = kind === 'issue' ? await readIssue(commands, iid) : await readMergeRequest(commands, iid)
    const message = objectMessage(object, kind, object.web_url ?? '', login)
    if (kind === 'issue') {
      const issue = object as GitlabIssue
      const labels = Array.isArray(issue.labels) ? issue.labels.filter((label): label is string => typeof label === 'string') : []
      return { iid, title: issue.title, state: issue.state, ...labels.length ? { labels } : {}, ...message }
    }
    const mr = object as GitlabMergeRequest
    return { iid, title: mr.title, state: mr.state, ...mr.merged_at ? { merged_at: mr.merged_at } : {},
      ...mr.merge_commit_sha ? { merge_commit_sha: mr.merge_commit_sha } : {},
      ...mr.detailed_merge_status ? { detailed_merge_status: mr.detailed_merge_status } : {},
      ...mr.source_branch && mr.target_branch ? { source_branch: mr.source_branch, target_branch: mr.target_branch } : {},
      ...mr.diff_refs ? { diff_refs: mr.diff_refs } : {},
      ...mr.head_pipeline ? { head_pipeline: { id: mr.head_pipeline.id, status: mr.head_pipeline.status, sha: mr.head_pipeline.sha } } : {},
      ...mr.has_conflicts ? { has_conflicts: true } : {}, ...mr.draft ? { draft: true } : {}, ...message }
  }
  if (section === 'approvals') {
    if (kind === 'issue') throw new Error('Approvals require a merge request')
    if (match[4]) throw new Error('Approvals do not take a page number')
    // A GitLab whose tier has no approvals answers 403/404; that is reported as unsupported, not as a failed read.
    return await readMergeRequestApprovals(commands, iid)
  }
  if (section === 'pipelines') {
    if (match[4]) throw new Error('Pipelines do not take a page number')
    const pipelines = await commands.gitlabPages(PipelineSchema, `${mergeRequestPath(iid)}/pipelines?per_page=100`)
    return { pipelines: pipelines.map(item => ({ id: item.id, iid: item.iid, sha: item.sha, ref: item.ref, status: item.status,
      web_url: item.web_url, updated_at: item.updated_at })) }
  }
  const page = Number(pageText)
  const tally = { skipped: 0 }
  const listedPage = await discussionPage(commands, kind, iid, page, tally)
  const messages = listedPage.notes.flatMap(({ note, replyTo, discussionId }) => {
    const message = noteMessage(note, '', login, replyTo, discussionId)
    return message.text ? [message] : []
  })
  return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listedPage.complete ? {} : { next_resource: `gitlab/${listed}/${iid}/${section}/${page + 1}` } }
}
