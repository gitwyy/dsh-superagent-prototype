/** GitLab polling loops: pending todos, observed stream changes, default-branch and merge request CI, Ticket merge requests, and subscribed Threads. */
import { type Thread } from '../core/index.ts'
import type { GitlabAccount, GitlabConfig } from '../deployment.ts'
import { type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollFailure, pollThreads as pollEach } from './poll.ts'
import { health, type SourceContext } from './host.ts'
import { ciFact, pipelineFailures, pipelineFingerprint, pipelineSummary, pipelineUnfinished, readThread, type GitlabThreadRead }
  from './gitlab-read.ts'
import { branchCiTrigger, gitlabThreadKey, IssueSchema, issueTrigger, JobSchema, type GitlabIssue, type GitlabJob, type GitlabKind,
  type GitlabMergeRequest, MergeRequestSchema, mergeRequestCiTrigger, mergeRequestTrigger, noteTrigger, type GitlabProject,
  PipelineSchema, SOURCE, TodoSchema, type GitlabTodo, isTodoRequest, todoTarget, todoTrigger, type GitlabRetry } from './gitlab-trigger.ts'
import { mergeRequestsOf, observeMergeRequest, readMergeRequest, type MergeRequest } from './gitlab-pull.ts'

const RETRY_WINDOW_MS = 24 * 3600_000
/**
 * How far before its todo the Issue or merge request body or note a mention todo points at may have been recorded. GitLab
 * creates the todo just after the message it mentions (observed 0.4–1.3 s), so a read driven by the todo accepts messages
 * from shortly before it; each Trigger's deterministic ID still deduplicates an overlap with the observed streams.
 */
const TODO_TOLERANCE_MS = 60_000
/** The resolved project the Source watches, with what a poll needs from the account setup verified. */
interface Project extends GitlabProject { login: string; defaultBranch: string }
function project(ctx: SourceContext): Project {
  const gitlab: GitlabAccount | undefined = ctx.deployment.gitlab
  if (!gitlab) throw new Error('The GitLab Source has no working GitLab account')
  return { projectId: gitlab.projectId, project: gitlab.project, webUrl: gitlab.webUrl, login: gitlab.login, defaultBranch: gitlab.defaultBranch }
}
/** The primary thread key of a default-branch CI Thread. */
const ciThread = (branch: string): string => `${SOURCE}:ci:${branch}`

/** One polling round's shared state: what was already read, what failed, and how many unreadable items were skipped. */
interface Round {
  started: string; signal?: AbortSignal | undefined
  threads: Map<string, Promise<GitlabThreadRead>>; mrs: Map<number, Promise<MergeRequest>>; observed: Set<number>
  read: Set<string>; failures: string[]; tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, threads: new Map(), mrs: new Map(),
  observed: new Set(), read: new Set(), failures: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)

/**
 * Runs GitLab rounds until stopped. Setup restarts dsh-superagent once it resolves the account, so nothing is polled before;
 * after `failuresBeforeError` consecutive failed polls the Source reports an error, and a single interruption stays quiet.
 */
export async function runGitlab(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  if (!ctx.deployment.gitlab) { ctx.report('gitlab', health('paused', 'sourceOff')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
/**
 * One polling round: pending todos, the observed issue and merge request streams with their comments, the merge requests of
 * open Tickets, the default branch's CI, and subscribed Threads. Each step and each thread fails independently so every step
 * runs before the round fails.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const todos = await pollTodos(ctx, round).then(value => ({ value }), (error: unknown) => ({ error }))
  await pollStreams(ctx, round)
  await pollTicketMergeRequests(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if ('error' in todos) throw todos.error
  if (signal?.aborted) return 60
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report('gitlab', { state: 'ready', detail: `${todos.value} todos; next poll ≥ 60s${skipped}`, at: round.started })
  return 60
}
/**
 * Reads the agent's pending todos, which GitLab fills for mentions, assignments and review requests but not for ordinary
 * replies, and reads each todo's Issue or merge request since the todo. A mention todo accepts the body and notes it
 * mentions from shortly before the todo, since GitLab records the notification after the message; each Trigger keeps a
 * deterministic ID, so a read the observed streams also made is a no-op. The first round records the newest todo as a
 * baseline; todos older than it are never read. Failed reads are retried for a day, and this Source never marks todos done.
 * @returns how many todos the round read.
 */
async function pollTodos(ctx: SourceContext, round: Round): Promise<number> {
  const commands = ctx.commands.withSignal(round.signal)
  // The project filter keeps the list to this Source's project; the ids stay GitLab's global sequence either way.
  const listed = await commands.gitlabPages(TodoSchema, `todos?state=pending&project_id=${project(ctx).projectId}&per_page=100`, round.tally)
  const newest = listed.reduce((max, todo) => Math.max(max, todo.id), 0)
  const stored = ctx.state.get(KV.gitlab.todos)
  if (!stored) {
    // Baseline: every pending todo already exists, and reading them all would answer old requests again.
    ctx.state.set(KV.gitlab.todos, { maxId: newest, startedAt: round.started })
    return 0
  }
  const retries = { ...ctx.state.get(KV.gitlab.retries) }
  const todos = new Map<number, GitlabTodo>()
  for (const [id, retry] of Object.entries(retries)) todos.set(Number(id), retry.todo)
  for (const todo of listed) if (todo.id > stored.maxId) todos.set(todo.id, todo)
  const projectInfo = project(ctx)
  let read = 0
  // Oldest first, so a round that stops early leaves its cursor before what it did not read.
  for (const todo of [...todos.values()].sort((a, b) => a.id - b.id)) {
    if (stopped(ctx, round)) return read
    const target = todoTarget(todo, projectInfo, projectInfo.login)
    if (!target) { delete retries[String(todo.id)]; continue }
    try {
      // Only a mention todo's body or note may have been recorded before the todo; an assignment or review request keeps its rule.
      const mention = target.action === 'mentioned' || target.action === 'directly_addressed'
      await intake(ctx, round, { kind: target.kind, iid: target.iid, since: target.since, body: true,
        ...mention ? { toleranceMs: TODO_TOLERANCE_MS } : {} })
      // An assignment or review request exists only as the notification, so the todo itself carries it.
      if (isTodoRequest(target.action)) await ctx.receive(todoTrigger(todo, target, projectInfo, projectInfo.login))
      delete retries[String(todo.id)]
      read += 1
    } catch (error) {
      if (stopped(ctx, round)) return read
      const previous = retries[String(todo.id)]
      const retry: GitlabRetry = { todo, failedAt: previous?.failedAt ?? round.started, attempts: (previous?.attempts ?? 0) + 1 }
      // Abandon a read that kept failing for a day, so one unreadable todo does not hold Source health in error.
      if (Date.parse(round.started) - Date.parse(retry.failedAt) < RETRY_WINDOW_MS) {
        retries[String(todo.id)] = retry
        round.failures.push(`todo ${todo.id}: ${String(error)}`)
      } else delete retries[String(todo.id)]
    }
  }
  ctx.atomic(() => {
    ctx.state.set(KV.gitlab.todos, { maxId: Math.max(newest, stored.maxId), startedAt: stored.startedAt })
    ctx.state.set(KV.gitlab.retries, retries)
  })
  return read
}
/** The repository-wide streams the Source observes: new Issues and new merge requests, their comments read per thread. */
const STREAMS = [
  { id: 'issues', observed: (config: GitlabConfig) => config.observeIssues || config.observeComments },
  { id: 'merge_requests', observed: (config: GitlabConfig) => config.observeMergeRequests || config.observeComments },
] as const
/** Polls the observed streams (each from when it was switched on) and the default branch's CI; each fails independently. */
async function pollStreams(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    if (!stream.observed(config)) { ctx.state.set(KV.gitlab.stream(stream.id), undefined); continue }
    try { await readStream(ctx, round, stream.id, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
  // Switching CI observation off clears the failure baseline but keeps the revision counter, so future Trigger IDs stay unique.
  if (!config.observeCi) {
    const seen = ctx.state.get(KV.gitlab.branchCi)
    ctx.state.set(KV.gitlab.branchCi, seen && { revision: seen.revision })
    return
  }
  try { await pollBranchCi(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`default branch CI: ${String(error)}`) }
}
/**
 * Reads one observed stream since its cursor, oldest first. A body Trigger is emitted only for an Issue or merge request
 * created after its switch was turned on, whereas new notes of any updated thread reach the Source while comments are
 * observed. The cursor steps to five seconds before the round by `cursorAt`, and deterministic Trigger IDs deduplicate overlap.
 */
async function readStream(ctx: SourceContext, round: Round, id: 'issues' | 'merge_requests', config: GitlabConfig): Promise<void> {
  const name = KV.gitlab.stream(id)
  const stored = ctx.state.get(name)
  const kind: GitlabKind = id === 'issues' ? 'issue' : 'merge_request'
  const bodies = kind === 'issue' ? config.observeIssues : config.observeMergeRequests
  const started = stored?.started ?? round.started
  // Items earlier than the polling horizon are ignored, so a long pause cannot replay a month of history.
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  const commands = ctx.commands.withSignal(round.signal)
  const path = `${id}?scope=all&state=all&order_by=updated_at&sort=asc&updated_after=${encodeURIComponent(since)}&per_page=100`
  const projectInfo = project(ctx)
  const items: (GitlabIssue | GitlabMergeRequest)[] = kind === 'issue'
    ? await commands.gitlabPages(IssueSchema, path, round.tally)
    : await commands.gitlabPages(MergeRequestSchema, path, round.tally)
  for (const item of items.sort((a, b) => (a.updated_at ?? '').localeCompare(b.updated_at ?? ''))) {
    // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    if (item.author && sameName(item.author.username, projectInfo.login)) continue
    const created = Date.parse(item.created_at ?? '')
    const fresh = Number.isFinite(created) && created >= Math.max(Date.parse(started), horizon)
    if (bodies && fresh) {
      await ctx.receive(kind === 'issue' ? issueTrigger(item as GitlabIssue, projectInfo, projectInfo.login)
        : mergeRequestTrigger(item as GitlabMergeRequest, projectInfo, projectInfo.login))
      describeThread(ctx, kind, item.iid, item.title, item.web_url ?? undefined)
    }
    if (config.observeComments) await intake(ctx, round, { kind, iid: item.iid, since, object: item, body: false })
  }
  ctx.state.set(name, { since: cursorAt(round.started), started })
}
/** Polls the default branch's newest pipeline and reports a change of its failing jobs; a pipeline that stays pending is no change. */
async function pollBranchCi(ctx: SourceContext, round: Round): Promise<void> {
  const previous = ctx.state.get(KV.gitlab.branchCi)
  const revision = previous?.revision ?? 0
  const branchName = project(ctx).defaultBranch
  if (!branchName) { ctx.state.set(KV.gitlab.branchCi, { revision }); return }
  const commands = ctx.commands.withSignal(round.signal)
  const pipelines = await commands.gitlabPages(PipelineSchema,
    `pipelines?ref=${encodeURIComponent(branchName)}&order_by=updated_at&sort=desc&per_page=5`, round.tally)
  const pipeline = [...pipelines].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0]
  if (!pipeline) { ctx.state.set(KV.gitlab.branchCi, { branch: branchName, failures: [], revision }); return }
  const jobs: GitlabJob[] = await commands.gitlabPages(JobSchema, `pipelines/${pipeline.id}/jobs?per_page=100`, round.tally)
  const snapshot = { pipeline, jobs }
  const failures = pipelineFailures(snapshot)
  const known = previous?.branch === branchName ? previous.failures : undefined
  // Retain previous failures while the new pipeline is still running, so recovery is reported only once it finishes.
  const now = failures.length || !pipelineUnfinished(pipeline) ? failures : known ?? failures
  let next = revision
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    next += 1
    await ctx.receive(branchCiTrigger(branchName, pipeline, next, pipelineSummary(snapshot, branchName, `gitlab/pipelines/${pipeline.id}/jobs`),
      pipeline.web_url ?? ''))
    ctx.threads.describe(ciThread(branchName), { label: `CI on ${branchName}`, facts: { ci: ciFact(snapshot) } })
  }
  ctx.state.set(KV.gitlab.branchCi, { branch: branchName, failures: now, revision: next })
}
/** Reads and observes each open Ticket's merge requests, and polls the head pipeline of each still open; the read is shared within the round. */
export async function pollTicketMergeRequests(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket => mergeRequestsOf(ticket, true)))]
  for (const iid of iids) {
    if (stopped(ctx, round)) return
    try {
      const mr = await mergeRequest(ctx, round, iid)
      await observe(ctx, round, mr)
      if (mr.state === 'opened') await pollMergeRequestCi(ctx, round, mr)
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`!${iid}: ${String(error)}`) }
  }
}
/** Reads one merge request at most once per round. */
function mergeRequest(ctx: SourceContext, round: Round, iid: number): Promise<MergeRequest> {
  let read = round.mrs.get(iid)
  if (!read) { read = readMergeRequest(ctx, iid, round.signal); round.mrs.set(iid, read) }
  return read
}
/**
 * Polls an open merge request's head pipeline, which GitLab reports as the merge request's `head_pipeline` or, when it names
 * none, the newest the merge request lists. A pipeline that is created, pending, waiting, preparing, scheduled or manual has
 * not failed and never becomes a Trigger; only a failure, and a recovery once the pipeline finished clean, do, each with the
 * revision that keeps its ID distinct. The first observation only records the baseline.
 */
async function pollMergeRequestCi(ctx: SourceContext, round: Round, mr: MergeRequest): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const previous = ctx.state.get(KV.gitlab.ci(mr.iid))
  const listed = await commands.gitlabPages(PipelineSchema, `merge_requests/${mr.iid}/pipelines?per_page=100`, round.tally)
  const newest = [...listed].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0]
  const head = mr.head_pipeline ?? newest
  if (!head) { ctx.state.set(KV.gitlab.ci(mr.iid), previous && { ...previous, fingerprint: '', failures: [] }); return }
  const jobs: GitlabJob[] = await commands.gitlabPages(JobSchema, `pipelines/${head.id}/jobs?per_page=100`, round.tally)
  const snapshot = { pipeline: head, jobs }
  const fingerprint = pipelineFingerprint(snapshot)
  if (previous?.fingerprint === fingerprint) return
  // Failures are retained while the pipeline they came from is still unresolved, so only its finished clean run recovers them.
  const failures = pipelineFailures(snapshot)
  const known = previous?.failures ?? []
  const now = failures.length || !pipelineUnfinished(head) ? failures : known
  const revision = previous?.revision ?? 0
  // The baseline reports nothing, and a pending or created pipeline changes nothing an agent should answer.
  const actionable = previous !== undefined && JSON.stringify(now) !== JSON.stringify(known)
  const next = actionable ? revision + 1 : revision
  ctx.state.set(KV.gitlab.ci(mr.iid), { fingerprint, failures: previous ? now : [], revision: next })
  if (!actionable) return
  await ctx.receive(mergeRequestCiTrigger(mr, head, project(ctx), next,
    pipelineSummary(snapshot, `!${mr.iid}`, `gitlab/merge_requests/${mr.iid}/pipelines`)))
  ctx.threads.describe(gitlabThreadKey('merge_request', mr.iid), { facts: { ci: ciFact(snapshot) } })
}
async function observe(ctx: SourceContext, round: Round, mr: MergeRequest): Promise<void> {
  if (round.observed.has(mr.iid)) return
  round.observed.add(mr.iid)
  await observeMergeRequest(ctx, mr)
}
/** Polls subscribed Issue and merge request Threads from their checkpoints; a default-branch CI Thread has no conversation. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(thread.key))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  if (thread.ref.id.startsWith('ci:')) return
  const match = /^(issue|merge_request):([1-9]\d*)$/.exec(thread.ref.id)
  if (!match) throw new Error('Subscribed thread is not a GitLab Issue or merge request')
  const kind = match[1] as GitlabKind
  const iid = Number(match[2])
  round.read.add(thread.key)
  const since = ctx.state.get(KV.gitlab.cursor(thread.key)) ?? thread.createdAt
  // A merge request's Thread also keeps its mergeability and state current.
  if (kind === 'merge_request') await observe(ctx, round, await mergeRequest(ctx, round, iid))
  await intake(ctx, round, { kind, iid, since, body: false })
}
/** A conversation read at most once per round, however many steps name it. */
function threadRead(ctx: SourceContext, round: Round, kind: GitlabKind, iid: number, object?: GitlabIssue | GitlabMergeRequest): Promise<GitlabThreadRead> {
  const key = gitlabThreadKey(kind, iid)
  let reading = round.threads.get(key)
  if (!reading) {
    reading = readThread(ctx.commands.withSignal(round.signal), kind, iid, object, round.tally)
    round.threads.set(key, reading)
  }
  return reading
}
/**
 * Reads a conversation and emits the Triggers its new body and notes make, then moves its note cursor. `toleranceMs` lets a
 * todo-driven read accept the body and notes recorded slightly before the todo that points at them, since GitLab records the
 * notification after the message it mentions; deterministic Trigger IDs make the overlap with the observed streams a no-op.
 */
async function intake(ctx: SourceContext, round: Round,
  input: { kind: GitlabKind; iid: number; since: string; body: boolean; toleranceMs?: number;
    object?: GitlabIssue | GitlabMergeRequest }): Promise<void> {
  const read = await threadRead(ctx, round, input.kind, input.iid, input.object)
  const projectInfo = project(ctx)
  const floor = Date.parse(input.since) - (input.toleranceMs ?? 0)
  if (input.body) {
    const created = Date.parse(read.object.created_at ?? '')
    const user = read.object.author
    if (Number.isFinite(created) && created >= floor && user && !sameName(user.username, projectInfo.login)) {
      await ctx.receive(read.kind === 'issue' ? issueTrigger(read.object as GitlabIssue, projectInfo, projectInfo.login)
        : mergeRequestTrigger(read.object as GitlabMergeRequest, projectInfo, projectInfo.login))
    }
  }
  for (const discussion of read.discussions) {
    for (const note of discussion.notes) {
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      const timestamp = Date.parse(note.updated_at ?? note.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < floor) continue
      const trigger = noteTrigger(note, { kind: read.kind, iid: read.iid, webUrl: read.webUrl,
        ...discussion.id ? { discussionId: discussion.id } : {} }, projectInfo, projectInfo.login)
      if (trigger) await ctx.receive(trigger)
    }
  }
  nameThread(ctx, read)
  ctx.state.set(KV.gitlab.cursor(gitlabThreadKey(input.kind, input.iid)), cursorAt(round.started))
}
/** Names a Thread for people and records what later polls read from its meta. */
function describeThread(ctx: SourceContext, kind: GitlabKind, iid: number, title: string, webUrl?: string): void {
  const thread = gitlabThreadKey(kind, iid)
  const number = `${kind === 'issue' ? '#' : '!'}${iid}`
  const url = webUrl || undefined
  ctx.threads.patch(thread, { kind, iid, isMr: kind === 'merge_request', title, ...(url ? { url } : {}) })
  ctx.threads.describe(thread, { label: `${number} ${title}`, ...(url ? { url } : {}), facts: { number: { value: number } } })
}
function nameThread(ctx: SourceContext, read: GitlabThreadRead): void {
  describeThread(ctx, read.kind, read.iid, read.object.title, read.webUrl)
}
