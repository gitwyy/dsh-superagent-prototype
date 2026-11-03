import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Engine, type Assessor, type Executor, type OutboundMessage, type Ticket, type Trigger } from '../src/core/index.ts'
import { Commands, commandError, gitlabItems } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { executorTools } from '../src/app/tools/executor.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SOURCE, gitlabKind } from '../src/sources/gitlab.ts'
import { gitlabThreadContext, readGitlab, readGitlabRepositoryPath, pipelineFailures, pipelineFingerprint, pipelineSummary, ciFact,
  pipelineRunning } from '../src/sources/gitlab-read.ts'
import { resolveGitlabDiscussion } from '../src/sources/gitlab-channel.ts'
import { claimMergeRequest, mergeRequestEndNotices, mergeRequestOf, mergeRequestsOf, mergeStatusFact, observeMergeRequest, ticketBranch }
  from '../src/sources/gitlab-pull.ts'
import { branchCiTrigger, descriptionMessageId, gitlabChannel, gitlabPage, gitlabThread, gitlabThreadKey, hasMarker, issueTrigger,
  issueTriggerId, isBot, mentions, mergeRequestCiTrigger, mergeRequestTrigger, noteMessageId, noteTrigger, noteTriggerId, todoTarget,
  todoTrigger, TODO_ACTIONS } from '../src/sources/gitlab-trigger.ts'
import { pollRound, pollThreads, runGitlab } from '../src/sources/gitlab-loops.ts'
import { approvals, BOT, branch as branchFixture, diffNote, discussion, gitlabAccount, gitlabDeployment, issue, job, mergeRequest, note,
  person, pipeline, projectRef, systemNote, todo, treeEntry, WEB } from './fixtures/gitlab.ts'

const opened: Store[] = []
const directory = () => mkdtempSync(join(tmpdir(), 'gitlab-source-'))
function host(overrides: Partial<SourceContextDeps> = {}, config: Record<string, unknown> = {}) {
  const store = new Store(join(directory(), 'db.sqlite'))
  opened.push(store)
  const settings = SettingsSchema.parse({ policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' },
    sources: { gitlab: { enabled: true, config: { url: 'http://gitlab.example.com', project: 'acme/widgets', cli: '/bin/false', ...config } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = gitlabDeployment()
  sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: 'gitlab', health: ['gitlab'] })
  return { ...value, ...context, health: board.all, store, engine, commands, receive, executor, sources, board }
}
const refused = (code: number, message: string) => commandError({ stderr: `glab: HTTP ${code}`, stdout: JSON.stringify({ message }), code: 1 })
/** Stubs `glab api` against project `acme/widgets`, returning the API paths it was asked for and the JSON bodies it sent. */
function gitlab(h: ReturnType<typeof host>, routes: Record<string, unknown>, shared = false) {
  const calls: string[][] = []
  const bodies: unknown[] = []
  const answer = async (_program: string, args: string[]): Promise<string> => {
    calls.push(args)
    const inputAt = args.indexOf('--input')
    if (inputAt >= 0) bodies.push(JSON.parse(readFileSync(args[inputAt + 1]!, 'utf8')) as unknown)
    const path = args[1]!.replace(/^projects\/acme%2Fwidgets\/?/, '').split('?')[0]!
    const route = routes[path]
    const value = typeof route === 'function' ? (route as (args: string[]) => unknown)(args) : route
    if (value instanceof Error) throw value
    if (value === undefined) {
      if (args.includes('--paginate')) return '[]'
      throw refused(404, `404 Not found: ${path}`)
    }
    // A raw answer, such as a repository file's text, is returned as printed; everything else is JSON.
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  // A read bound to an abort signal goes through a Commands built by `withSignal`, so those tests stub the prototype.
  if (shared) vi.spyOn(Commands.prototype, 'run').mockImplementation(answer)
  else vi.spyOn(h.commands, 'run').mockImplementation(answer)
  return { calls, bodies, paths: (): string[] => calls.map(args => args[1]!.replace(/^projects\/acme%2Fwidgets\/?/, '').split('?')[0]!) }
}
const executed = (name: string) => ({ name, directory: `/w/${name}`, assignment: '' })
const openTicket = (id: string): Ticket => ({ id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '',
  basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'alice' }, scope: '' }, channels: [],
  assignments: [{ id: `a-${id}`, state: 'running', createdAt: '' }], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: `source-${id}`, triggerIds: [] } })
const message = (channel: Trigger['channel'], id = 'stable-operation'): OutboundMessage => ({ id, channel: channel!, text: 'Done', kind: 'reply' })

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { for (const store of opened.splice(0)) store.close(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('gitlab triggers', () => {
  it('builds the issue body Trigger on the issue thread, deterministically and with a reply channel', () => {
    const trigger = issueTrigger(issue(3, { author: person(), description: '@Agent-Bot please fix the login' }), projectRef(), 'agent-bot')
    expect(trigger).toMatchObject({ source: SOURCE, threads: [{ source: SOURCE, id: 'issue:3' }], actor: { source: SOURCE, id: 'wangyangyang' },
      human: true, addressed: 'mention', url: `${WEB}/-/issues/3`,
      channel: { source: SOURCE, thread: 'gitlab:issue:3', address: { project: 'acme/widgets', kind: 'issue', iid: '3' } },
      meta: { kind: 'issue', iid: 3, projectId: 7 } })
    expect(trigger.id).toBe(issueTriggerId(480, 3, '2026-11-03T02:12:56.800Z'))
    expect(issueTrigger(issue(3, { author: person() }), projectRef(), 'agent-bot').id).toBe(trigger.id)
    // An Issue the agent opened is not a request to it, and the same IID on a merge request is a different thread.
    expect(issueTrigger(issue(3, { author: { username: 'agent-bot' } }), projectRef(), 'agent-bot').human).toBe(false)
    expect(gitlabThread('issue', 3)).toEqual({ source: SOURCE, id: 'issue:3' })
    expect(gitlabThreadKey('merge_request', 3)).toBe('gitlab:merge_request:3')
    expect(gitlabPage('merge_request', 3, projectRef())).toBe('http://gitlab.example.com/acme/widgets/-/merge_requests/3')
  })
  it('builds a merge request body Trigger naming the merge request thread', () => {
    const trigger = mergeRequestTrigger(mergeRequest(1, { author: person('carol') }), projectRef(), 'agent-bot')
    expect(trigger).toMatchObject({ threads: [{ source: SOURCE, id: 'merge_request:1' }], actor: { source: SOURCE, id: 'carol' }, human: true,
      channel: { thread: 'gitlab:merge_request:1', address: { kind: 'merge_request', iid: '1' } }, meta: { kind: 'merge_request', iid: 1, mrAuthor: 'carol' } })
    expect(trigger.addressed).toBeUndefined()
  })
  it('turns a note into a Trigger, and skips system notes and the agent\'s own', () => {
    const trigger = noteTrigger(note(27722, '@agent-bot take this', { author: person('carol') }),
      { kind: 'issue', iid: 3, webUrl: 'http://gitlab.example.com/acme/widgets/-/issues/3', discussionId: 'd1' }, projectRef(), 'agent-bot')!
    expect(trigger).toMatchObject({ threads: [{ source: SOURCE, id: 'issue:3' }], actor: { source: SOURCE, id: 'carol' }, human: true,
      addressed: 'mention', url: 'http://gitlab.example.com/acme/widgets/-/issues/3#note_27722',
      channel: { thread: 'gitlab:issue:3', address: { kind: 'issue', iid: '3', discussionId: 'd1' } },
      meta: { kind: 'note', targetKind: 'issue', iid: 3, noteId: 27722, discussionId: 'd1' } })
    expect(trigger.id).toBe(noteTriggerId(480, 27722, '2026-09-09T00:00:02Z'))
    expect(noteTrigger(systemNote(2, 'assigned to @wangyangyang'), { kind: 'issue', iid: 3 }, projectRef(), 'agent-bot')).toBeUndefined()
    expect(noteTrigger(note(3, '@agent-bot', { author: { username: 'agent-bot' } }), { kind: 'issue', iid: 3 }, projectRef(), 'agent-bot')).toBeUndefined()
    expect(noteTrigger(note(4, ''), { kind: 'issue', iid: 3 }, projectRef(), 'agent-bot')).toBeUndefined()
    // Another bot's comment is received as an automated message; the Policy's bot list decides whether it becomes a candidate.
    expect(noteTrigger(note(5, 'fyi', { author: { username: BOT } }), { kind: 'merge_request', iid: 1 }, projectRef(), 'agent-bot'))
      .toMatchObject({ human: false, threads: [{ source: SOURCE, id: 'merge_request:1' }] })
  })
  it('starts a diff note with its file and line, and gives an edited note a new version', () => {
    const diff = noteTrigger(note(27738, 'Use the theme token', { type: 'DiffNote',
      position: { new_path: 'src/render.ts', new_line: 43, position_type: 'text' } }), { kind: 'merge_request', iid: 1 }, projectRef(), 'agent-bot')!
    expect(diff.text).toBe('src/render.ts:43\n\nUse the theme token')
    expect(diff.meta).toMatchObject({ path: 'src/render.ts', line: 43, noteType: 'DiffNote', targetKind: 'merge_request' })
    // The reply address keeps the diff note's place, so a reply can land inline on the same line.
    expect(diff.channel?.address).toMatchObject({ project: 'acme/widgets', kind: 'merge_request', iid: '1', path: 'src/render.ts', line: '43', side: 'new' })
    const old = noteTrigger(note(27739, 'Removed line', { type: 'DiffNote', position: { old_path: 'src/render.ts', old_line: 7 } }),
      { kind: 'merge_request', iid: 1 }, projectRef(), 'agent-bot')!
    expect(old.channel?.address).toMatchObject({ path: 'src/render.ts', line: '7', side: 'old' })
    const first = noteTrigger(note(6, 'x', { updated_at: '2026-09-09T00:00:01Z' }), { kind: 'issue', iid: 3 }, projectRef(), 'agent-bot')!
    const edited = noteTrigger(note(6, 'x', { updated_at: '2026-09-09T00:00:02Z' }), { kind: 'issue', iid: 3 }, projectRef(), 'agent-bot')!
    expect(edited.id).not.toBe(first.id)
  })
  it('recognizes GitLab\'s user-name character set in a mention, and automated accounts by the contract\'s heuristics', () => {
    expect(mentions('@agent-bot please', 'agent-bot')).toBe(true)
    expect(mentions('@Agent-Bot please', 'agent-bot')).toBe(true)
    expect(mentions('mail@agent-bot.example', 'agent-bot')).toBe(false)
    expect(mentions('x@agent-bot', 'agent-bot')).toBe(false)
    expect(mentions('@agent-bot.example hi', 'agent-bot')).toBe(false)
    expect(mentions('@alice.smith hi', 'alice.smith')).toBe(true)
    expect(isBot({ username: BOT }, 'agent-bot')).toBe(true)
    expect(isBot({ username: 'release-bot' }, 'agent-bot')).toBe(true)
    expect(isBot({ username: 'agent-bot' }, 'agent-bot')).toBe(true)
    expect(isBot({ username: 'alice' }, 'agent-bot')).toBe(false)
    expect(isBot({ username: 'alice', bot: true }, 'agent-bot')).toBe(true)
  })
  it('maps the four todo actions to the thread they ask to read, and drops other projects, actions and self-actions', () => {
    const own = { project: { id: 7 }, target: { iid: 3, project_id: 7 } }
    const mentioned = todo(3800, 'mentioned', { target_url: '/-/issues/3#note_27722', target: { iid: 3, project_id: 7 } })
    expect(todoTarget(mentioned, projectRef(), 'agent-bot')).toEqual({ todoId: 3800, action: 'mentioned', kind: 'issue', iid: 3,
      since: '2026-11-03T02:12:33.347Z' })
    expect(todoTarget(todo(3801, 'directly_addressed', own), projectRef(), 'agent-bot')).toMatchObject({ kind: 'issue', iid: 3 })
    expect(todoTarget(todo(3802, 'assigned', { ...own, target_type: 'MergeRequest', target_url: '/-/merge_requests/2',
      target: { iid: 2, project_id: 7 } }), projectRef(), 'agent-bot')).toMatchObject({ action: 'assigned', kind: 'merge_request', iid: 2 })
    expect(todoTarget(todo(3803, 'review_requested', { ...own, target_type: 'MergeRequest', target: { iid: 2, project_id: 7 } }), projectRef(), 'agent-bot'))
      .toMatchObject({ action: 'review_requested', kind: 'merge_request' })
    expect(TODO_ACTIONS).toEqual(['mentioned', 'directly_addressed', 'assigned', 'review_requested'])
    // Another project's todo, an action the Source does not receive, and a todo the agent caused itself are not read.
    expect(todoTarget(todo(3804, 'mentioned', { project: { id: 9 }, target: { iid: 3, project_id: 9 } }), projectRef(), 'agent-bot')).toBeUndefined()
    expect(todoTarget(todo(3805, 'build_failed', own), projectRef(), 'agent-bot')).toBeUndefined()
    expect(todoTarget(todo(3806, 'mentioned', { ...own, author: { username: 'agent-bot' } }), projectRef(), 'agent-bot')).toBeUndefined()
    expect(todoTarget(todo(3807, 'mentioned', { target: {} }), projectRef(), 'agent-bot')).toBeUndefined()
  })
  it('builds the Trigger for an assignment, which has no note to carry it and is not a mention', () => {
    const target = todoTarget(todo(3810, 'assigned', { target: { iid: 2, project_id: 7, title: 'Login fails',
      web_url: 'http://gitlab.example.com/acme/widgets/-/issues/2' }, project: { id: 7 } }), projectRef(), 'agent-bot')!
    const trigger = todoTrigger(todo(3810, 'assigned', { target: { iid: 2, project_id: 7, title: 'Login fails' }, project: { id: 7 } }), target,
      projectRef(), 'agent-bot')
    expect(trigger).toMatchObject({ threads: [{ source: SOURCE, id: 'issue:2' }], actor: { source: SOURCE, id: 'wangyangyang' }, human: true,
      text: '#2 Login fails was assigned to you', meta: { kind: 'issue', iid: 2, todoId: 3810, action: 'assigned' } })
    expect(trigger.addressed).toBeUndefined()
    expect(trigger.channel?.thread).toBe('gitlab:issue:2')
  })
  it('finds the thread and note a query names, without guessing the project', () => {
    expect(gitlabKind.find!('#12')).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!('!12')).toEqual({ threads: ['gitlab:merge_request:12'], terms: [] })
    expect(gitlabKind.find!('http://gitlab.example.com/acme/widgets/-/issues/3#note_27722'))
      .toEqual({ threads: ['gitlab:issue:3'], terms: ['27722'] })
    expect(gitlabKind.find!('http://gitlab.example.com/acme/widgets/-/merge_requests/1'))
      .toEqual({ threads: ['gitlab:merge_request:1'], terms: [] })
    expect(gitlabKind.find!('something else')).toEqual({ threads: [], terms: [] })
  })
  it('keeps the hidden reply marker recognizable in a note body', () => {
    expect(hasMarker(`Done\n\n<!-- dsh-superagent:msg-1 -->`, 'msg-1')).toBe(true)
    expect(hasMarker('Done', 'msg-1')).toBe(false)
  })
})

describe('gitlab thread context and reads', () => {
  const issueRoutes = () => ({
    'issues/3': issue(3, { author: person('wangyangyang'), description: 'Fix the login', created_at: '2026-09-08T00:00:00Z' }),
    'issues/3/discussions': [
      discussion('d1', [note(1, 'first', { author: person('carol'), created_at: '2026-09-09T00:00:01Z' }),
        note(2, 'second', { author: person('carol'), created_at: '2026-09-09T00:00:02Z' })]),
      discussion('d2', [systemNote(3, 'assigned to @wangyangyang'), note(4, '@agent-bot please',
        { author: person('carol'), created_at: '2026-09-09T00:00:04Z' })]),
    ],
  })
  it('reads an issue conversation: its description first, then each note with what it answers, without system notes', async () => {
    const h = host()
    gitlab(h, issueRoutes())
    const trigger = issueTrigger(issue(3, { author: person() }), projectRef(), 'agent-bot')
    expect(gitlabThreadContext.messageId(trigger)).toBe(descriptionMessageId('issue', 3))
    const thread = await gitlabThreadContext.read(h.commands, trigger, 'thread', undefined, {})
    expect(thread.messages.map(item => item.id)).toEqual(['issue:3', 'note:1', 'note:2', 'note:4'])
    expect(thread.messages[0]).toMatchObject({ from: 'wangyangyang', text: '[probe] mentioned-bot\n\nFix the login',
      at: '2026-09-08T00:00:00Z' })
    expect(thread.messages[1]).toMatchObject({ from: 'carol', text: 'first' })
    expect(thread.messages[2]!.reply_to).toBe('note:1')
    expect(thread.messages[3]!.reply_to).toBeUndefined()
    expect(thread.next).toBeUndefined()
    const root = await gitlabThreadContext.read(h.commands, trigger, 'root', undefined, {})
    expect(root.messages.map(item => item.id)).toEqual(['issue:3'])
  })
  it('uses the note as the Trigger\'s message, reads one more page while discussions remain, and answers a record by its discussion', async () => {
    const h = host()
    const many = Array.from({ length: 100 }, (_, index) => discussion(`d${index}`,
      [note(index + 10, `note ${index}`, { author: person('carol'), created_at: '2026-09-09T00:00:10Z' })]))
    gitlab(h, { ...issueRoutes(), 'issues/3/discussions': many,
      'issues/3/discussions/d0': discussion('d0', [note(10, '@agent-bot', { author: person('carol') })]) })
    const page = await gitlabThreadContext.read(h.commands, issueTrigger(issue(3, { author: person() }), projectRef(), 'agent-bot'), 'thread', undefined, {})
    expect(page.next).toBe('2')
    // A note reads as its discussion: its first note is its root and parent.
    const trigger = noteTrigger(note(10, '@agent-bot', { author: person('carol') }), { kind: 'issue', iid: 3, discussionId: 'd0' }, projectRef(), 'agent-bot')!
    expect(gitlabThreadContext.messageId(trigger)).toBe(noteMessageId(10))
    const discussionPage = await gitlabThreadContext.read(h.commands, trigger, 'parent', undefined, {})
    expect(discussionPage.status).toBe('discussion_thread')
    expect(discussionPage.messages.map(item => item.text)).toEqual(['@agent-bot'])
  })
  it('reads a merge request diff note with its discussion', async () => {
    const h = host()
    gitlab(h, { 'merge_requests/1/discussions/d9': discussion('d9', [
      note(5, 'Use the theme token', { author: person('carol'), type: 'DiffNote',
        position: { new_path: 'src/render.ts', new_line: 43, position_type: 'text' }, created_at: '2026-09-09T00:00:05Z' }),
      note(6, 'Agreed', { author: person('dave'), created_at: '2026-09-09T00:00:06Z' })]) })
    const trigger = noteTrigger(note(6, 'Agreed', { author: person('dave') }), { kind: 'merge_request', iid: 1, discussionId: 'd9',
      webUrl: 'http://gitlab.example.com/acme/widgets/-/merge_requests/1' }, projectRef(), 'agent-bot')!
    const thread = await gitlabThreadContext.read(h.commands, trigger, 'thread', undefined, {})
    expect(thread.messages.map(item => item.id)).toEqual(['note:5', 'note:6'])
    expect(thread.messages[0]).toMatchObject({ text: 'src/render.ts:43\n\nUse the theme token', path: 'src/render.ts', line: 43 })
    expect(thread.messages[1]!.reply_to).toBe('note:5')
    expect((await gitlabThreadContext.read(h.commands, trigger, 'parent', undefined, {})).messages.map(item => item.id)).toEqual(['note:5'])
  })
  it('serves the gitlab resources: an issue, a merge request with its merge facts, a page of notes, and a pipeline\'s jobs', async () => {
    const h = host()
    gitlab(h, {
      'issues/3': issue(3, { author: person(), labels: ['bug'], description: 'Fix the login' }),
      'merge_requests/1': mergeRequest(1, { author: person(), state: 'opened', detailed_merge_status: 'preparing', diff_refs: null,
        head_pipeline: pipeline(100, 'pending', { sha: '4ee36fa7' }) }),
      'issues/3/discussions': [discussion('d1', [note(1, 'first', { author: person('carol'), created_at: '2026-09-09T00:00:01Z' })])],
      'pipelines/100': pipeline(100, 'pending'),
      'pipelines/100/jobs': [job(1, 'test', 'pending'), job(2, 'build', 'pending', { allow_failure: true })],
    })
    expect(await readGitlab(h.commands, 'gitlab/issues/3')).toMatchObject({ iid: 3, title: '[probe] mentioned-bot', state: 'closed',
      labels: ['bug'], from: 'wangyangyang' })
    expect(await readGitlab(h.commands, 'gitlab/merge_requests/1')).toMatchObject({ iid: 1, state: 'opened',
      detailed_merge_status: 'preparing', head_pipeline: { id: 100, status: 'pending', sha: '4ee36fa7' } })
    expect(await readGitlab(h.commands, 'gitlab/issues/3/notes/1')).toMatchObject({ messages: [{ id: 'note:1', text: 'first' }] })
    expect(await readGitlab(h.commands, 'gitlab/pipelines/100/jobs')).toMatchObject({ jobs: [{ id: 1, name: 'test', status: 'pending' },
      { id: 2, name: 'build', status: 'pending', allow_failure: true }] })
    await expect(readGitlab(h.commands, 'gitlab/nothing')).rejects.toThrow('Use gitlab/issues/<iid>')
  })
  it('summarizes a pipeline from its jobs: failed ones, running ones, otherwise passed; a pending pipeline is never a failure', () => {
    const pending = { pipeline: pipeline(9, 'pending', { sha: 'abc1234def' }), jobs: [job(1, 'test', 'pending'), job(2, 'build', 'created')] }
    expect(pipelineFailures(pending)).toEqual([])
    expect(pipelineRunning(pending)).toEqual(['test', 'build'])
    expect(ciFact(pending)).toEqual({ label: { zh: 'CI 进行中', en: 'CI running' }, value: '2' })
    const failed = { pipeline: pipeline(9, 'failed', { sha: 'abc1234def' }), jobs: [job(1, 'test', 'failed'), job(2, 'docs', 'failed', { allow_failure: true }),
      job(3, 'build', 'success')] }
    expect(pipelineFailures(failed)).toEqual(['test'])
    expect(ciFact(failed)).toEqual({ label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true })
    expect(pipelineSummary(failed, 'main', 'gitlab/pipelines/9/jobs')).toBe('CI failed 1/3 on main at abc1234: test\nRead gitlab/pipelines/9/jobs for every job.')
    expect(pipelineFingerprint(failed)).toBe('9:failed:test')
    expect(pipelineFingerprint(pending)).not.toBe(pipelineFingerprint(failed))
    expect(pipelineSummary({ pipeline: pipeline(9, 'success', { sha: 'abc1234def' }), jobs: [job(1, 'test', 'success')] }, 'main', 'read'))
      .toMatch(/^CI passed 1\/1 on main at abc1234/)
    // A failed pipeline whose failures are all allowed still counts as one failed pipeline, not a pass.
    expect(pipelineFailures({ pipeline: pipeline(9, 'failed'), jobs: [job(1, 'docs', 'failed', { allow_failure: true })] })).toEqual(['pipeline'])
  })
  it('reads a merge request CI trigger as the merge request\'s conversation, not as a default-branch pipeline', async () => {
    const h = host()
    gitlab(h, { 'merge_requests/1': mergeRequest(1, { author: person() }), 'merge_requests/1/discussions': [] })
    const trigger = mergeRequestCiTrigger(mergeRequest(1, { author: person() }), pipeline(102, 'failed'), projectRef(), 1, 'CI failed')
    const read = await gitlabThreadContext.read(h.commands, trigger, 'thread', undefined, {})
    expect(read.messages.map(item => item.id)).toEqual(['merge_request:1'])
    expect(read.status).toBeUndefined()
  })
})

describe('gitlab repository and approval reads', () => {
  it('reads the project\'s default branch, a raw file, a directory listing and its branches', async () => {
    const h = host()
    gitlab(h, {
      'repository/files/src%2Fapp.ts/raw': 'export const value = 1\n',
      'repository/tree': [treeEntry('render.ts'), treeEntry('app.ts'), treeEntry('.env'), treeEntry('node_modules', 'tree')],
      'repository/branches': [branchFixture('main'), branchFixture('agent/fix-title', { protected: false })],
      'repository/branches/agent%2Ffix-title': branchFixture('agent/fix-title', { protected: false, default: false }),
    })
    expect(await readGitlab(h.commands, 'gitlab/repository')).toMatchObject({ project: 'acme/widgets', project_id: 7,
      default_branch: 'main', ref: 'main' })
    expect(await readGitlab(h.commands, 'gitlab/repository/files/src/app.ts')).toEqual({ path: 'src/app.ts', ref: 'main',
      content: 'export const value = 1\n' })
    expect(await readGitlab(h.commands, 'gitlab/repository/tree/src')).toEqual({ path: 'src', ref: 'main', entries: ['app.ts', 'render.ts'] })
    expect(await readGitlab(h.commands, 'gitlab/repository/branches')).toMatchObject({ default_branch: 'main',
      branches: [{ name: 'main', default: true, protected: true, commit: { short_id: '4ee36fa7' } },
        { name: 'agent/fix-title', default: false, protected: false }] })
    expect(await readGitlab(h.commands, 'gitlab/repository/branches/agent/fix-title'))
      .toMatchObject({ name: 'agent/fix-title', default: false, protected: false })
    // The same reads answer the assessment's file and directory resources, as GitHub's repository reads do.
    expect(await readGitlabRepositoryPath(h.commands, 'src/app.ts', 'file')).toBe('export const value = 1\n')
    expect(await readGitlabRepositoryPath(h.commands, 'src', 'directory')).toBe('app.ts\nrender.ts')
    await expect(readGitlab(h.commands, 'gitlab/repository/files/.env')).rejects.toThrow('Only non-hidden repository source paths are available')
    await expect(readGitlab(h.commands, 'gitlab/repository/nope')).rejects.toThrow('Use gitlab/repository')
  })
  it('reads approvals, and reports the 403/404 a GitLab without approvals answers as unsupported without failing', async () => {
    const h = host()
    gitlab(h, { 'merge_requests/1/approvals': approvals(1) })
    expect(await readGitlab(h.commands, 'gitlab/merge_requests/1/approvals')).toEqual({ supported: true, approvals_required: 0,
      approvals_left: 0, approved: false, approved_by: [] })
    gitlab(h, { 'merge_requests/1/approvals': approvals(1, { approvals_required: 2, approvals_left: 1, approved_by: [{ user: person('carol') }] }) })
    expect(await readGitlab(h.commands, 'gitlab/merge_requests/1/approvals')).toMatchObject({ supported: true, approvals_required: 2,
      approvals_left: 1, approved_by: ['carol'] })
    gitlab(h, { 'merge_requests/1/approvals': refused(404, '404 Not Found') })
    expect(await readGitlab(h.commands, 'gitlab/merge_requests/1/approvals')).toEqual({ supported: false })
    gitlab(h, { 'merge_requests/1/approvals': refused(403, '403 Forbidden') })
    expect(await readGitlab(h.commands, 'gitlab/merge_requests/1/approvals')).toEqual({ supported: false })
    await expect(readGitlab(h.commands, 'gitlab/issues/1/approvals')).rejects.toThrow('Approvals require a merge request')
    await expect(readGitlab(h.commands, 'gitlab/merge_requests/1/approvals/1')).rejects.toThrow('Approvals do not take a page number')
  })
})

describe('gitlab channel', () => {
  const address = (overrides: Record<string, string> = {}) => gitlabChannel('issue', 3, 'acme/widgets', undefined, undefined).address
  it('posts a note with the hidden marker, pre-checks only comment notes, and finds an earlier post instead of posting twice', async () => {
    const h = host()
    const routes: Record<string, unknown> = { 'issues/3/notes': [note(1, 'Done\n\n<!-- dsh-superagent:stable-operation -->', { author: { username: 'agent-bot' } })] }
    const sent = gitlab(h, routes)
    // A reply with no retained discussion pre-checks the conversation; GitLab rejects `activity_filter=all` with HTTP 400.
    expect(await h.sources.send(message({ source: SOURCE, thread: 'gitlab:issue:3', address: address() }), h.commands)).toBe('sent')
    expect(sent.calls.map(args => args[1])).toEqual(['projects/acme%2Fwidgets/issues/3/notes?per_page=100&sort=desc&activity_filter=only_comments'])
    routes['issues/3/notes'] = []
    expect(await h.sources.send(message({ source: SOURCE, thread: 'gitlab:issue:3', address: address() }), h.commands)).toBe('sent')
    // The pre-check lists comments again, then the note is posted without any GET-only query parameter.
    expect(sent.calls.map(args => args[1])).toEqual([
      'projects/acme%2Fwidgets/issues/3/notes?per_page=100&sort=desc&activity_filter=only_comments',
      'projects/acme%2Fwidgets/issues/3/notes?per_page=100&sort=desc&activity_filter=only_comments',
      'projects/acme%2Fwidgets/issues/3/notes'])
    expect(h.commands.run).toHaveBeenLastCalledWith('/path/agent-glab', ['api', 'projects/acme%2Fwidgets/issues/3/notes', '--hostname', 'gitlab.example.com',
      '--method', 'POST', '-f', 'body=Done\n\n<!-- dsh-superagent:stable-operation -->'])
    expect(sent.calls.flatMap(args => args).join(' ')).not.toContain('activity_filter=all')
  })
  it('replies in a discussion, or in the conversation when GitLab no longer finds it', async () => {
    const h = host()
    gitlab(h, { 'merge_requests/1/discussions/d1': discussion('d1', [note(1, 'root', { author: person('carol') })]),
      'merge_requests/1/discussions/d1/notes': {}, 'merge_requests/1/notes': [] })
    const channel = gitlabChannel('merge_request', 1, 'acme/widgets', undefined, 'd1')
    expect(await h.sources.send(message(channel), h.commands)).toBe('sent')
    expect(h.commands.run).toHaveBeenLastCalledWith('/path/agent-glab', ['api', 'projects/acme%2Fwidgets/merge_requests/1/discussions/d1/notes',
      '--hostname', 'gitlab.example.com', '--method', 'POST', '-f', expect.stringContaining('Done')])
    gitlab(h, { 'merge_requests/1/discussions/gone': refused(404, '404 Not Found'), 'merge_requests/1/notes': [] })
    expect(await h.sources.send(message(gitlabChannel('merge_request', 1, 'acme/widgets', undefined, 'gone')), h.commands)).toBe('sent')
    expect(h.commands.run).toHaveBeenLastCalledWith('/path/agent-glab', ['api', 'projects/acme%2Fwidgets/merge_requests/1/notes',
      '--hostname', 'gitlab.example.com', '--method', 'POST', '-f', expect.stringContaining('Done')])
  })
  it('drops a reply to a locked or missing Issue, and keeps a retry when the project itself no longer reads', async () => {
    const h = host()
    gitlab(h, { 'issues/3/notes': refused(403, 'This discussion is locked') })
    expect(await h.sources.send(message({ source: SOURCE, thread: 'gitlab:issue:3', address: address() }), h.commands)).toBe('gone')
    gitlab(h, { 'issues/3/notes': refused(404, '404 Not found'), '': { id: 7, path_with_namespace: 'acme/widgets' } })
    expect(await h.sources.send(message({ source: SOURCE, thread: 'gitlab:issue:3', address: address() }), h.commands)).toBe('gone')
    gitlab(h, { 'issues/3/notes': refused(404, '404 Not found'), '': refused(404, '404 Project Not Found') })
    await expect(h.sources.send(message({ source: SOURCE, thread: 'gitlab:issue:3', address: address() }), h.commands)).rejects.toThrow('404')
  })
  it('links an address to its page, and allows replies only to a known kind of this project', () => {
    const links = { repository: 'acme/widgets', gitlab: gitlabAccount() }
    expect(gitlabKind.channel!.link(address(), links)).toEqual({ url: 'http://gitlab.example.com/acme/widgets/-/issues/3',
      label: { zh: 'GitLab #3', en: 'GitLab #3' } })
    expect(gitlabKind.channel!.link(gitlabChannel('merge_request', 1, 'acme/widgets').address, links))
      .toEqual({ url: 'http://gitlab.example.com/acme/widgets/-/merge_requests/1',
        label: { zh: 'GitLab 合并请求 !1', en: 'Merge request !1 on GitLab' } })
    expect(gitlabKind.channel!.link({ ...address(), url: 'http://kept.example/3' }, links).url).toBe('http://kept.example/3')
    expect(gitlabKind.channel!.link(address(), {}).url).toBe('')
    const config = gitlabKind.schema.parse({ url: 'http://gitlab.example.com', project: 'acme/widgets' })
    expect(gitlabKind.channel!.allowed!(address(), config)).toBe(true)
    expect(gitlabKind.channel!.allowed!({ ...address(), kind: 'pipeline' }, config)).toBe(false)
    expect(gitlabKind.channel!.allowed!({ ...address(), project: 'other/project' }, config)).toBe(false)
    expect(gitlabKind.channel!.allowed!({ ...address(), iid: '0' }, config)).toBe(false)
  })
})

describe('gitlab inline diff notes and discussion resolve', () => {
  const inline = () => gitlabChannel('merge_request', 1, 'acme/widgets', undefined, undefined,
    { path: 'src/render.ts', line: 43, side: 'new' })
  it('opens an inline discussion at the diff note place, with the merge request\'s diff refs as its position', async () => {
    const h = host()
    const sent = gitlab(h, {
      'merge_requests/1': mergeRequest(1, { diff_refs: { base_sha: 'aab075ae', start_sha: 'aab075ae', head_sha: '4ee36fa7' } }),
      'merge_requests/1/notes': [],
      'merge_requests/1/discussions': {},
    })
    expect(await h.sources.send(message(inline()), h.commands)).toBe('sent')
    expect(sent.bodies).toEqual([{ body: 'Done\n\n<!-- dsh-superagent:stable-operation -->',
      position: { position_type: 'text', base_sha: 'aab075ae', start_sha: 'aab075ae', head_sha: '4ee36fa7',
        old_path: 'src/render.ts', new_path: 'src/render.ts', new_line: 43 } }])
    expect(h.commands.run).toHaveBeenLastCalledWith('/path/agent-glab', ['api', 'projects/acme%2Fwidgets/merge_requests/1/discussions',
      '--hostname', 'gitlab.example.com', '--method', 'POST', '-H', 'Content-Type: application/json', '--input', expect.stringContaining('.json')])
    // A retried send finds its marker in the conversation and posts nothing.
    const retried = gitlab(h, { 'merge_requests/1/notes': [note(1, 'Done\n\n<!-- dsh-superagent:stable-operation -->',
      { author: { username: 'agent-bot' } })] })
    expect(await h.sources.send(message(inline()), h.commands)).toBe('sent')
    expect(retried.bodies).toEqual([])
  })
  it('replies in a retained discussion, and keeps a conversation note while GitLab prepares the merge request', async () => {
    const h = host()
    gitlab(h, { 'merge_requests/1/discussions/d9': discussion('d9', [diffNote(5, 'Use the token', { author: person('carol') })]),
      'merge_requests/1/discussions/d9/notes': {}, 'merge_requests/1/notes': [] })
    const retained = gitlabChannel('merge_request', 1, 'acme/widgets', undefined, 'd9', { path: 'src/render.ts', line: 43 })
    expect(await h.sources.send(message(retained), h.commands)).toBe('sent')
    expect(h.commands.run).toHaveBeenLastCalledWith('/path/agent-glab', ['api', 'projects/acme%2Fwidgets/merge_requests/1/discussions/d9/notes',
      '--hostname', 'gitlab.example.com', '--method', 'POST', '-f', expect.stringContaining('Done')])
    // A merge request GitLab still prepares has no diff_refs: the reply falls back to a conversation note, and nothing throws.
    const preparing = gitlab(h, { 'merge_requests/1': mergeRequest(1, { diff_refs: null }), 'merge_requests/1/notes': [] })
    expect(await h.sources.send(message(inline()), h.commands)).toBe('sent')
    expect(preparing.bodies).toEqual([])
    expect(h.commands.run).toHaveBeenLastCalledWith('/path/agent-glab', ['api', 'projects/acme%2Fwidgets/merge_requests/1/notes',
      '--hostname', 'gitlab.example.com', '--method', 'POST', '-f', expect.stringContaining('Done')])
  })
  it('resolves and reopens a discussion, and names the discussion and its resolution in the read', async () => {
    const h = host()
    gitlab(h, { 'merge_requests/1/discussions/d9': discussion('d9', [diffNote(5, 'Use the token', { author: person('carol') })]),
      'merge_requests/1/discussions': [discussion('d9', [diffNote(5, 'Use the token', { author: person('carol') }),
        note(6, 'Agreed', { author: person('dave'), created_at: '2026-11-03T02:16:56.000Z' })])] })
    await resolveGitlabDiscussion(h.commands, 'merge_request', 1, 'd9', true)
    expect(h.commands.run).toHaveBeenLastCalledWith('/path/agent-glab',
      ['api', 'projects/acme%2Fwidgets/merge_requests/1/discussions/d9?resolved=true', '--hostname', 'gitlab.example.com', '--method', 'PUT'])
    await resolveGitlabDiscussion(h.commands, 'merge_request', 1, 'd9', false)
    expect(h.commands.run).toHaveBeenLastCalledWith('/path/agent-glab',
      ['api', 'projects/acme%2Fwidgets/merge_requests/1/discussions/d9?resolved=false', '--hostname', 'gitlab.example.com', '--method', 'PUT'])
    expect(await readGitlab(h.commands, 'gitlab/merge_requests/1/discussions/1')).toMatchObject({ messages: [
      { id: 'note:5', discussion: 'd9', resolvable: true, resolved: false, path: 'src/render.ts', line: 43 },
      { id: 'note:6', discussion: 'd9', reply_to: 'note:5' }] })
  })
})

describe('gitlab merge request CI', () => {
  const head = (id: number, status: string) => mergeRequest(9, { author: { username: 'agent-bot' }, source_project_id: 7,
    source_branch: 'agent/fix-title', state: 'opened', head_pipeline: pipeline(id, status, { ref: 'agent/fix-title' }) })
  const ticketed = () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t1'), execution: executed('fix-title'), follows: [{ thread: 'gitlab:merge_request:9', own: true }] })
    h.store.threads.save({ key: 'gitlab:merge_request:9', ref: { source: SOURCE, id: 'merge_request:9' }, createdAt: '',
      subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
    return h
  }
  it('reports a head pipeline failure and its recovery, and never treats a pending, created or running pipeline as actionable', async () => {
    const h = ticketed()
    const routes: Record<string, unknown> = { todos: [], 'merge_requests/9': head(100, 'pending'),
      'merge_requests/9/pipelines': [pipeline(100, 'pending')],
      'pipelines/100/jobs': [job(1, 'test', 'pending'), job(2, 'docs', 'failed', { allow_failure: true })] }
    gitlab(h, routes)
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitlab.ci(9))).toEqual({ fingerprint: '100:pending:', failures: [], revision: 0 })
    // A new pipeline that is only created, then one still running, changes nothing an agent should answer.
    for (const [id, status] of [[101, 'created'], [102, 'running']] as const) {
      routes['merge_requests/9'] = head(id, status)
      routes['merge_requests/9/pipelines'] = [pipeline(id, status)]
      routes[`pipelines/${id}/jobs`] = [job(1, 'test', status)]
      await pollRound(h)
    }
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitlab.ci(9))).toEqual({ fingerprint: '102:running:', failures: [], revision: 0 })
    // Its failure is the first actionable change.
    routes['merge_requests/9'] = head(103, 'failed')
    routes['merge_requests/9/pipelines'] = [pipeline(103, 'failed')]
    routes['pipelines/103/jobs'] = [job(1, 'test', 'failed'), job(2, 'build', 'success')]
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({
      threads: [{ source: SOURCE, id: 'merge_request:9' }], actor: { source: SOURCE, id: '' }, human: false,
      text: expect.stringContaining('CI failed 1/2 on !9'),
      meta: { ci: true, kind: 'merge_request', iid: 9, revision: 1, pipelineId: 103, sha: expect.any(String) } })])
    expect(h.store.threads.get('gitlab:merge_request:9')!.meta.facts).toMatchObject({ ci: { label: { zh: 'CI 失败', en: 'CI failed' },
      value: '1', problem: true } })
    // A new pipeline is only pending for now: the reported failure is retained until that pipeline finishes.
    routes['merge_requests/9'] = head(104, 'pending')
    routes['merge_requests/9/pipelines'] = [pipeline(104, 'pending')]
    routes['pipelines/104/jobs'] = [job(1, 'test', 'pending')]
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.store.get(KV.gitlab.ci(9))).toEqual({ fingerprint: '104:pending:', failures: ['test'], revision: 1 })
    // Its finished clean run recovers the failure, and the same pipeline read again is no change.
    routes['merge_requests/9'] = head(105, 'success')
    routes['merge_requests/9/pipelines'] = [pipeline(105, 'success')]
    routes['pipelines/105/jobs'] = [job(1, 'test', 'success')]
    await pollRound(h)
    expect(h.receive.mock.calls[1]![0]).toMatchObject({ meta: expect.objectContaining({ revision: 2 }),
      text: expect.stringContaining('CI passed 1/1 on !9') })
    expect(h.store.get(KV.gitlab.ci(9))).toEqual({ fingerprint: '105:success:', failures: [], revision: 2 })
    h.receive.mockClear()
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
  })
  it('keeps a distinct deterministic ID for each reported change', () => {
    const mr = mergeRequest(9, { author: { username: 'agent-bot' } })
    const first = mergeRequestCiTrigger(mr, pipeline(103, 'failed'), projectRef(), 1, 'CI failed')
    expect(mergeRequestCiTrigger(mr, pipeline(103, 'failed'), projectRef(), 1, 'CI failed').id).toBe(first.id)
    expect(mergeRequestCiTrigger(mr, pipeline(104, 'success'), projectRef(), 2, 'CI passed').id).not.toBe(first.id)
    expect(first.id).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('gitlab merge request binding', () => {
  it('binds an open agent merge request on the ticket\'s branch, and ends the ticket when it merges', async () => {
    const h = host()
    const ticket = { ...openTicket('t1'), execution: executed('fix-title') }
    h.store.tickets.save(ticket)
    const mr = mergeRequest(9, { author: { username: 'agent-bot' }, source_project_id: 7, source_branch: 'agent/fix-title', web_url: 'http://gitlab.example.com/acme/widgets/-/merge_requests/9' })
    expect(claimMergeRequest(h, 't1', mr)).toBeUndefined()
    expect(mergeRequestOf(h.store.tickets.get('t1')!)).toBe(9)
    expect(h.store.threads.get('gitlab:merge_request:9')?.subscriptions).toEqual(['t1'])
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:merge_request:9', own: true }])
    expect(await observeMergeRequest(h, { ...mr, state: 'merged', merged_at: '2026-09-02T00:00:00Z', merge_commit_sha: 'bf48d64d' })).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-02T00:00:00.000Z' } })
    expect(h.store.threads.get('gitlab:merge_request:9')!.meta).toMatchObject({ kind: 'merge_request', iid: 9, state: 'merged',
      mergedAt: '2026-09-02T00:00:00Z', mergeCommitSha: 'bf48d64d' })
    expect(h.store.threads.get('gitlab:merge_request:9')!.meta.facts).toMatchObject({ mergeStatus: { label: { zh: '合并请求', en: 'Merge request' },
      value: { zh: '已合并', en: 'merged' } } })
  })
  it('refuses a merge request from another author, another project, or another ticket\'s thread', () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t1'), execution: executed('fix-title') })
    h.store.tickets.save({ ...openTicket('t2'), execution: executed('other') })
    expect(ticketBranch({ execution: executed('fix-title') }, 'agent/fix-title')).toBe(true)
    expect(ticketBranch({ execution: executed('fix-title') }, 'agent/fix-title-2')).toBe(false)
    expect(claimMergeRequest(h, 't1', mergeRequest(9, { author: person('carol'), source_branch: 'agent/fix-title' })))
      .toContain('does not belong to this ticket')
    expect(claimMergeRequest(h, 't1', mergeRequest(9, { author: { username: 'agent-bot' }, source_project_id: 99,
      source_branch: 'agent/fix-title' }))).toContain('does not belong')
    // The source merge request binds without branch or author rules, as GitHub's source pull request does.
    const source = { id: 'source-t1', source: SOURCE } as Trigger
    h.store.triggers.save({ ...source, threads: [{ source: SOURCE, id: 'issue:3' }], actor: { source: SOURCE, id: 'alice' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'please fix', meta: { kind: 'merge_request', iid: 2 } })
    h.store.tickets.save({ ...h.store.tickets.get('t1')!, origin: { triggerId: 'source-t1', triggerIds: ['source-t1'] } })
    expect(claimMergeRequest(h, 't1', mergeRequest(2, { author: person('carol'), state: 'opened' }))).toBeUndefined()
    // A merge request that another open ticket follows cannot bind to this one.
    expect(claimMergeRequest(h, 't2', mergeRequest(2, { author: { username: 'agent-bot' }, source_project_id: 7,
      source_branch: 'agent/other' }))).toBe('Merge request already belongs to another active ticket')
  })
  it('observes an open agent merge request and auto-binds it to the single ticket on its branch', async () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t1'), execution: executed('fix-title') })
    const mr = mergeRequest(9, { author: { username: 'agent-bot' }, source_project_id: 7, source_branch: 'agent/fix-title' })
    expect(await observeMergeRequest(h, mr)).toBe(false)
    expect(mergeRequestOf(h.store.tickets.get('t1')!)).toBe(9)
    // A preparing merge request is normal, not a problem.
    expect(mergeStatusFact(mergeRequest(9, { detailed_merge_status: 'preparing' })))
      .toEqual({ label: { zh: '可合并状态', en: 'Merge status' }, value: 'preparing' })
    expect(mergeStatusFact(mergeRequest(9, { detailed_merge_status: 'conflict' })).problem).toBe(true)
    expect(mergeStatusFact(mergeRequest(9, { state: 'closed' }))).toMatchObject({ value: { zh: '已关闭', en: 'closed' } })
  })
  it('writes the terminal notice in the request\'s language, once', async () => {
    const h = host()
    const channel = { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }
    const ticket: Ticket = { ...openTicket('t1'), channels: [channel], follows: [{ thread: 'gitlab:merge_request:9', own: true,
      closed: { at: '2026-09-02T00:00:00Z', outcome: 'merged' } }], ended: { at: '2026-09-02T00:00:01Z', by: 'executor', outcome: 'merged' } }
    const notices = mergeRequestEndNotices(ticket, '请修一下', gitlabAccount())
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', channel, text: '[合并请求 !9](http://gitlab.example.com/acme/widgets/-/merge_requests/9) 已合并。' })])
    expect(mergeRequestEndNotices(ticket, '请修一下', gitlabAccount()).map(notice => notice.id)).toEqual(notices.map(notice => notice.id))
    const closed = { ...ticket, ended: { ...ticket.ended!, outcome: 'closed' as const },
      follows: [{ thread: 'gitlab:merge_request:9', own: true, closed: { at: '2026-09-02T00:00:00Z', outcome: 'closed' as const } }] }
    expect(mergeRequestEndNotices(closed, 'fix it', gitlabAccount())[0]!.text)
      .toBe('[MR !9](http://gitlab.example.com/acme/widgets/-/merge_requests/9) was closed without merging.')
    // A GitLab conversation already shows its own merge; no notice is queued for it.
    expect(mergeRequestEndNotices({ ...ticket, channels: [gitlabChannel('issue', 3, 'acme/widgets')] }, 'fix it', gitlabAccount())).toEqual([])
    expect(mergeRequestsOf({ follows: [{ thread: 'gitlab:merge_request:9', own: true }, { thread: 'gitlab:issue:3', own: false }] })).toEqual([9])
  })
})

describe('gitlab report binding', () => {
  it('binds a reported merge request number on a GitLab deployment, and accepts the pull request wording as an alias', async () => {
    const h = host()
    const ticket = { ...openTicket('t1'), execution: executed('fix-title') }
    h.store.tickets.save(ticket)
    gitlab(h, { 'merge_requests/9': mergeRequest(9, { author: { username: 'agent-bot' }, source_project_id: 7,
      source_branch: 'agent/fix-title' }) }, true)
    const reported = vi.fn()
    const tools = executorTools({
      engine: { report: (id, value) => { reported(id, value); return h.store.tickets.get(id)! }, reply: vi.fn(), markUnrelated: vi.fn(),
        handback: vi.fn(), followForContext: vi.fn() },
      store: { tickets: h.store.tickets, replyStatus: () => undefined, atomic: work => h.store.atomic(work) },
      sessions: { relay: vi.fn(), notify: vi.fn() }, resources: {} as never, github: h, gitlab: h, sendReplies: vi.fn(),
    }, ticket)
    const report = tools.find(tool => tool.name === 'orchestrator_report')!
    // The GitLab Schema names the merge request, and tolerates the shared prompt's pull request wording.
    expect(Object.keys((report.schema as z.ZodObject).shape)).toEqual(['state', 'summary', 'human_action', 'question_for_trigger_id',
      'mr_number', 'pr_number', 'reply_to_trigger_id'])
    expect(await report.execute({ state: 'progress', summary: 'Opened !9', mr_number: 9 }, new AbortController().signal))
      .toMatchObject({ reported: true })
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:merge_request:9', own: true }])
    await report.execute({ state: 'progress', summary: 'Still !9', pr_number: 9 }, new AbortController().signal)
    expect(reported).toHaveBeenCalledTimes(2)
  })
})

describe('gitlab polling', () => {
  it('records a baseline of pending todos and reads nothing the first time', async () => {
    const h = host()
    gitlab(h, { todos: [todo(3700, 'mentioned', { project: { id: 7 }, target: { iid: 3, project_id: 7 } })] })
    expect(await pollRound(h)).toBe(60)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitlab.todos)).toMatchObject({ maxId: 3700 })
    expect(h.health.gitlab).toMatchObject({ state: 'ready', detail: '0 todos; next poll ≥ 60s' })
  })
  it('reads the issue a new mention todo names, and takes in its new note', async () => {
    const h = host()
    gitlab(h, { todos: [todo(3700, 'mentioned', { project: { id: 7 }, target: { iid: 3, project_id: 7 } })] })
    await pollRound(h)
    h.receive.mockClear()
    const routes = {
      todos: [todo(3800, 'mentioned', { created_at: '2026-09-09T00:00:00Z', project: { id: 7 }, target: { iid: 3, project_id: 7 } })],
      'issues/3': issue(3, { author: person('wangyangyang'), created_at: '2026-08-01T00:00:00Z' }),
      'issues/3/discussions': [discussion('d1', [note(5, '@agent-bot fix it', { author: person('carol'), project_id: 480,
        created_at: '2026-09-09T00:00:05Z', updated_at: '2026-09-09T00:00:05Z' })])],
    }
    gitlab(h, routes)
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({ source: SOURCE,
      threads: [{ source: SOURCE, id: 'issue:3' }], actor: { source: SOURCE, id: 'carol' }, addressed: 'mention', text: '@agent-bot fix it',
      meta: expect.objectContaining({ kind: 'note', noteId: 5, discussionId: 'd1' }) })])
    expect(h.store.get(KV.gitlab.todos)).toMatchObject({ maxId: 3800 })
    expect(h.store.get(KV.gitlab.cursor('gitlab:issue:3'))).toBeDefined()
  })
  it('takes in an Issue body a mention todo points at even when GitLab recorded the todo just after the body', async () => {
    const h = host()
    gitlab(h, { todos: [] })
    await pollRound(h)
    h.receive.mockClear()
    // The live case: Issue #4 was created 1.3 s before the `directly_addressed` todo that points at it, and had no notes.
    const created = '2026-11-03T03:10:59.248Z', todoAt = '2026-11-03T03:11:00.553Z'
    gitlab(h, {
      todos: [todo(3791, 'directly_addressed', { created_at: todoAt, project: { id: 7 }, target: { iid: 4, project_id: 7 } })],
      'issues/4': issue(4, { author: person('carol'), created_at: created, updated_at: created,
        description: 'Please @agent-bot take a look at the greeting' }),
      'issues/4/discussions': [],
    })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({
      threads: [{ source: SOURCE, id: 'issue:4' }], actor: { source: SOURCE, id: 'carol' }, addressed: 'mention', human: true,
      text: expect.stringContaining('Please @agent-bot take a look'), meta: expect.objectContaining({ kind: 'issue', iid: 4 }) })])
    expect(h.store.get(KV.gitlab.todos)).toMatchObject({ maxId: 3791 })
    // An Issue from days before is not read again: its new mention todo brings its new note, not its old body.
    h.receive.mockClear()
    gitlab(h, {
      todos: [todo(3792, 'mentioned', { created_at: '2026-11-03T03:12:00.000Z', project: { id: 7 }, target: { iid: 5, project_id: 7 } })],
      'issues/5': issue(5, { author: person('carol'), created_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-11-03T03:12:00.000Z',
        description: 'old @agent-bot mention' }),
      'issues/5/discussions': [discussion('d', [note(9, 'please look', { author: person('carol'),
        created_at: '2026-11-03T03:12:00.000Z', updated_at: '2026-11-03T03:12:00.000Z' })])],
    })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual(['please look'])
  })
  it('takes in a note a mention todo points at even when GitLab recorded the todo just after the note', async () => {
    const h = host()
    gitlab(h, { todos: [] })
    await pollRound(h)
    h.receive.mockClear()
    // The live case: the note at 03:22:00.320 preceded the `directly_addressed` todo at 03:22:00.701 by 381 ms.
    const todoAt = '2026-11-03T03:22:00.701Z'
    gitlab(h, {
      todos: [todo(3792, 'directly_addressed', { created_at: todoAt, project: { id: 7 }, target: { iid: 5, project_id: 7 } })],
      'issues/5': issue(5, { author: person('carol'), created_at: '2026-11-03T03:21:55.628Z', updated_at: todoAt }),
      'issues/5/discussions': [discussion('d', [
        note(8, 'old discussion', { author: person('carol'), created_at: '2026-11-03T00:00:00.000Z', updated_at: '2026-11-03T00:00:00.000Z' }),
        note(9, '@agent-bot please look', { author: person('carol'), created_at: '2026-11-03T03:22:00.320Z',
          updated_at: '2026-11-03T03:22:00.320Z' })])],
    })
    await pollRound(h)
    const triggers = h.receive.mock.calls.map(([trigger]) => trigger)
    // The new Issue's body and the note just before the todo both reach the Source; the hours-old discussion does not.
    expect(triggers.map(trigger => trigger.meta.kind)).toEqual(['issue', 'note'])
    expect(triggers[1]).toMatchObject({ addressed: 'mention', text: '@agent-bot please look',
      meta: expect.objectContaining({ kind: 'note', noteId: 9, discussionId: 'd' }) })
    expect(h.store.get(KV.gitlab.todos)).toMatchObject({ maxId: 3792 })
    // An old comment on an old Issue is not re-emitted when a new mention todo arrives; only the new note is.
    h.receive.mockClear()
    gitlab(h, {
      todos: [todo(3793, 'mentioned', { created_at: '2026-11-03T03:25:00.500Z', project: { id: 7 }, target: { iid: 6, project_id: 7 } })],
      'issues/6': issue(6, { author: person('carol'), created_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-11-03T03:25:00.500Z' }),
      'issues/6/discussions': [discussion('d2', [
        note(10, 'old comment', { author: person('carol'), created_at: '2026-11-03T02:00:00.000Z', updated_at: '2026-11-03T02:00:00.000Z' }),
        note(11, '@agent-bot take a look', { author: person('carol'), created_at: '2026-11-03T03:25:00.100Z',
          updated_at: '2026-11-03T03:25:00.100Z' })])],
    })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual(['@agent-bot take a look'])
  })
  it('makes the todo itself the Trigger for an assignment or a review request', async () => {
    const h = host()
    gitlab(h, { todos: [todo(3700, 'mentioned', { project: { id: 7 }, target: { iid: 3, project_id: 7 } })] })
    await pollRound(h)
    h.receive.mockClear()
    gitlab(h, {
      todos: [todo(3801, 'assigned', { created_at: '2026-09-09T00:00:00Z', project: { id: 7 },
        target_type: 'MergeRequest', target: { iid: 2, project_id: 7, title: 'Fix it', web_url: 'http://gitlab.example.com/acme/widgets/-/merge_requests/2' } })],
      'merge_requests/2': mergeRequest(2, { author: person(), created_at: '2026-08-01T00:00:00Z' }),
      'merge_requests/2/discussions': [],
    })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({ text: '!2 Fix it was assigned to you',
      threads: [{ source: SOURCE, id: 'merge_request:2' }], meta: expect.objectContaining({ todoId: 3801, action: 'assigned' }) })])
    expect(h.receive.mock.calls[0]![0].addressed).toBeUndefined()
  })
  it('ignores another project\'s todo, an action it does not receive, and a todo the agent caused', async () => {
    const h = host()
    gitlab(h, { todos: [todo(3700, 'mentioned', { project: { id: 7 }, target: { iid: 3, project_id: 7 } })] })
    await pollRound(h)
    h.receive.mockClear()
    gitlab(h, { todos: [
      todo(3802, 'mentioned', { project: { id: 8 }, target: { iid: 3, project_id: 8 } }),
      todo(3803, 'build_failed', { project: { id: 7 }, target: { iid: 3, project_id: 7 } }),
      todo(3804, 'mentioned', { project: { id: 7 }, target: { iid: 3, project_id: 7 }, author: { username: 'agent-bot' } }),
    ] })
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitlab.todos)).toMatchObject({ maxId: 3804 })
  })
  it('retries a todo whose read failed, and abandons it after a day', async () => {
    const h = host()
    gitlab(h, { todos: [todo(3700, 'mentioned', { project: { id: 7 }, target: { iid: 3, project_id: 7 } })] })
    await pollRound(h)
    const failedRoutes = {
      todos: [todo(3810, 'mentioned', { created_at: '2026-09-09T00:00:00Z', project: { id: 7 }, target: { iid: 4, project_id: 7 } })],
      'issues/4': refused(502, 'Bad Gateway'),
    }
    gitlab(h, failedRoutes)
    await expect(pollRound(h)).rejects.toThrow('1 GitLab reads failed: todo 3810')
    expect(h.store.get(KV.gitlab.retries)).toEqual({ 3810: expect.objectContaining({ attempts: 1 }) })
    expect(h.store.get(KV.gitlab.todos)).toMatchObject({ maxId: 3810 })
    // The retry runs before new todos and clears once it reads.
    gitlab(h, { todos: [], 'issues/4': issue(4, { author: person(), created_at: '2026-08-01T00:00:00Z' }),
      'issues/4/discussions': [discussion('d', [note(7, 'still broken', { author: person('carol'), created_at: '2026-09-09T00:01:00Z' })])] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual(['still broken'])
    expect(h.store.get(KV.gitlab.retries)).toEqual({})
    // A read that failed for a day is dropped, so one unreadable todo does not hold Source health in error.
    h.store.set(KV.gitlab.retries, { 3811: { todo: todo(3811, 'mentioned', { project: { id: 7 }, target: { iid: 5, project_id: 7 } }),
      failedAt: new Date(Date.now() - 25 * 3600_000).toISOString(), attempts: 9 } })
    gitlab(h, { todos: [], 'issues/5': refused(502, 'Bad Gateway') })
    await pollRound(h)
    expect(h.store.get(KV.gitlab.retries)).toEqual({})
  })
  it('takes in a new issue from the observed stream only after its switch was turned on, and reads its comments', async () => {
    const h = host({}, { observeIssues: true, observeComments: true })
    gitlab(h, { todos: [] })
    await pollRound(h)
    const started = new Date().toISOString()
    h.receive.mockClear()
    gitlab(h, {
      todos: [],
      issues: [issue(3, { created_at: '2026-08-01T00:00:00Z', updated_at: started }), issue(4, { created_at: new Date(Date.now() + 1000).toISOString() })],
      'issues/3/discussions': [discussion('d', [note(9, 'a comment', { author: person('carol'), created_at: started })])],
      'issues/4/discussions': [],
    })
    await pollRound(h)
    const received = h.receive.mock.calls.map(([trigger]) => trigger)
    // The Issue from before the switch brings its new comment but not its body; the new Issue brings its body.
    expect(received.filter(trigger => trigger.meta.kind === 'issue').map(trigger => trigger.meta.iid)).toEqual([4])
    expect(received.filter(trigger => trigger.meta.kind === 'note').map(trigger => trigger.text)).toEqual(['a comment'])
    expect(h.store.get(KV.gitlab.stream('issues'))).toMatchObject({ started: expect.any(String), since: expect.any(String) })
  })
  it('reports a default-branch pipeline failure and its recovery, while a pending pipeline never changes anything', async () => {
    const h = host({}, { observeCi: true })
    const routes: Record<string, unknown> = { todos: [], pipelines: [pipeline(100, 'pending')], 'pipelines/100/jobs': [job(1, 'test', 'pending')] }
    gitlab(h, routes)
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitlab.branchCi)).toMatchObject({ branch: 'main', failures: [], revision: 0 })
    // A new pipeline that stays pending is no change either.
    routes.pipelines = [pipeline(101, 'pending')]
    routes['pipelines/101/jobs'] = [job(1, 'test', 'pending')]
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    routes.pipelines = [pipeline(102, 'failed')]
    routes['pipelines/102/jobs'] = [job(1, 'test', 'failed'), job(2, 'build', 'success')]
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({ threads: [{ source: SOURCE, id: 'ci:main' }],
      actor: { source: SOURCE, id: '' }, human: false, meta: { ci: true, branch: 'main', sha: '4ee36fa71cb74388b9f0d13c0d8babffaf7e19d4',
        revision: 1, pipelineId: 102 }, text: expect.stringContaining('CI failed 1/2 on main') })])
    expect(h.health.gitlab).toMatchObject({ state: 'ready' })
    routes.pipelines = [pipeline(103, 'success')]
    routes['pipelines/103/jobs'] = [job(1, 'test', 'success')]
    await pollRound(h)
    expect(h.receive.mock.calls[1]![0]).toMatchObject({ meta: expect.objectContaining({ revision: 2 }), text: expect.stringContaining('CI passed 1/1 on main') })
    expect(h.store.threads.get('gitlab:ci:main')!.meta.facts).toEqual({ ci: { label: 'CI', value: { zh: '通过', en: 'passed' } } })
    expect(branchCiTrigger('main', pipeline(103, 'success'), 2, 'CI passed', 'http://x').id).toMatch(/[0-9a-f]{32}/)
  })
  it('polls a subscribed thread from its checkpoint, skipping system and own notes', async () => {
    const h = host()
    const thread = { key: 'gitlab:issue:7', ref: { source: SOURCE, id: 'issue:7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: {} }
    h.store.threads.save(thread)
    gitlab(h, { 'issues/7': issue(7, { author: person(), created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-09T02:00:00Z' }),
      'issues/7/discussions': [discussion('d', [
        note(1, 'old', { author: person('carol'), created_at: '2026-08-01T00:00:00Z' }),
        systemNote(2, 'assigned to @wangyangyang', { created_at: '2026-09-09T01:00:00Z' }),
        note(3, 'mine', { author: { username: 'agent-bot' }, created_at: '2026-09-09T01:01:00Z' }),
        note(4, 'new', { author: person('carol'), created_at: '2026-09-09T02:00:00Z' })])] })
    await pollThreads(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual(['new'])
    expect(h.store.get(KV.gitlab.cursor('gitlab:issue:7'))).toBeDefined()
    expect(h.store.threads.get('gitlab:issue:7')!.meta).toMatchObject({ kind: 'issue', iid: 7, title: '[probe] mentioned-bot' })
    expect(h.store.threads.get('gitlab:issue:7')!.meta).not.toHaveProperty('pollError')
    // A thread GitLab no longer answers keeps its failure on the thread, and a later read clears it.
    gitlab(h, { 'issues/7': refused(404, '404 Not found') })
    await pollThreads(h)
    expect(h.store.threads.get('gitlab:issue:7')!.meta.pollError).toContain('404')
  })
  it('observes the merge requests of open tickets: binding the agent\'s own, then ending the ticket on merge', async () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t1'), execution: executed('fix-title'),
      follows: [{ thread: 'gitlab:merge_request:9', own: true }] })
    h.store.threads.save({ key: 'gitlab:merge_request:9', ref: { source: SOURCE, id: 'merge_request:9' }, createdAt: '',
      subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
    const open = mergeRequest(9, { author: { username: 'agent-bot' }, source_project_id: 7, source_branch: 'agent/fix-title' })
    gitlab(h, { todos: [], 'merge_requests/9': open })
    await pollRound(h)
    expect(h.store.threads.get('gitlab:merge_request:9')!.meta).toMatchObject({ kind: 'merge_request', iid: 9, state: 'opened',
      detailedMergeStatus: 'mergeable' })
    gitlab(h, { todos: [], 'merge_requests/9': { ...open, state: 'merged', merged_at: '2026-09-09T00:00:00Z', merge_commit_sha: 'abc' } })
    await pollRound(h)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { by: 'executor', outcome: 'merged' } })
    expect(h.store.threads.get('gitlab:merge_request:9')!.meta.facts).toMatchObject({ mergeStatus: { label: { zh: '合并请求', en: 'Merge request' },
      value: { zh: '已合并', en: 'merged' } } })
  })
  it('counts consecutive failed polls toward error health, and clears it on the next successful round', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = host()
    const failing = vi.spyOn(Commands.prototype, 'run').mockRejectedValue(refused(503, 'Service Unavailable'))
    const controller = new AbortController()
    const running = runGitlab(h, controller.signal)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.health.gitlab?.state).not.toBe('error')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.health.gitlab).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '3' } })
    failing.mockResolvedValue('[]')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.health.gitlab).toMatchObject({ state: 'ready', detail: '0 todos; next poll ≥ 60s' })
    controller.abort()
    await running
  })
  it('waits for setup before polling, and pauses when the deployment has no GitLab account', async () => {
    const pending = host({ configured: () => false })
    await runGitlab(pending, new AbortController().signal)
    expect(pending.health.gitlab).toMatchObject({ state: 'paused', code: 'setupPending' })
    const off = host({ deployment: gitlabDeployment({ gitlab: undefined, vcs: 'github', repository: '' }) })
    await runGitlab(off, new AbortController().signal)
    expect(off.health.gitlab).toMatchObject({ state: 'paused', code: 'sourceOff' })
  })
})

describe('gitlab api transport', () => {
  it('parses one page, NDJSON lines and the concatenated pages --paginate prints, flattening arrays', () => {
    expect(gitlabItems('[]')).toEqual([])
    expect(gitlabItems('')).toEqual([])
    expect(gitlabItems('[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
    expect(gitlabItems('{"id":1}\n{"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }])
    expect(gitlabItems('[{"id":1}][{"id":2}][{"id":3}]')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(gitlabItems('{"id":1}[{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
    expect(() => gitlabItems('[{"id":1}')).toThrow('not JSON')
  })
})
