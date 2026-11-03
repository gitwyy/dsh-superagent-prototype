/**
 * Recorded GitLab API payloads, trimmed to the fields the Source reads. The shapes were observed live on the pilot project
 * (see reports/gitlab-api-contract.md, 2026-11-03); the helpers below add the ids and times a test varies.
 */
import { testMachine } from './deployment.ts'
import type { Deployment, GitlabAccount } from '../../src/deployment.ts'

export const PROJECT = { id: 480, path_with_namespace: 'wangyangyang/dsh-superagent-lab', default_branch: 'main',
  web_url: 'http://gitlab.yk.ykgtxy.com/wangyangyang/dsh-superagent-lab' }
export const WEB = PROJECT.web_url
export const BOT = 'project_480_bot_a10587187b1020b3527450e94ca2b103'
export const ALICE = 'wangyangyang'
/** One recorded issue list item (`GET projects/480/issues?per_page=1`), with the nested author GitLab omits `bot` from. */
export const recordedIssue = { id: 677, iid: 3, project_id: 480, title: '[probe] mentioned-bot', state: 'closed',
  description: 'Please note @project_480_bot_a10587187b1020b3527450e94ca2b103 — ignore this probe issue.',
  created_at: '2026-11-03T02:12:56.800Z', updated_at: '2026-11-03T02:25:02.506Z', web_url: `${WEB}/-/issues/3`,
  author: { id: 92, username: BOT, name: 'superagent-bot', state: 'active' }, labels: ['dsh-probe'], type: 'ISSUE' }
/** One recorded note of issue 3 (`GET projects/480/issues/3/notes`); there is no `discussion_id` on this instance. */
export const recordedNote = { id: 27722, type: null, body: 'self-mention probe @project_480_bot_a10587187b1020b3527450e94ca2b103',
  system: false, author: { id: 92, username: BOT, name: 'superagent-bot' }, noteable_id: 677, noteable_iid: 3,
  noteable_type: 'Issue', project_id: 480, resolvable: false, confidential: false,
  created_at: '2026-11-03T02:14:04.151Z', updated_at: '2026-11-03T02:14:04.151Z' }
/** One recorded system note, "assigned to @…", whose author is the actor rather than a person writing a message. */
export const recordedSystemNote = { id: 27726, type: null, body: 'assigned to @wangyangyang', system: true,
  author: { id: 92, username: BOT, name: 'superagent-bot' }, noteable_id: 677, noteable_iid: 3, noteable_type: 'Issue',
  project_id: 480, created_at: '2026-11-03T02:15:44.524Z', updated_at: '2026-11-03T02:15:44.524Z' }
/** A recorded todo (`GET todos?state=pending&project_id=480`), newest first, with a global id sequence. */
export const recordedTodo = { id: 3755, action_name: 'mentioned', target_type: 'Issue', state: 'pending',
  target_url: `${WEB}/-/issues/3`, body: '[probe] mentioned-bot', created_at: '2026-11-03T02:12:33.347Z',
  updated_at: '2026-11-03T02:12:33.347Z', project: { id: 480, path_with_namespace: PROJECT.path_with_namespace },
  author: { id: 92, username: BOT, name: 'superagent-bot' }, target: { iid: 3, project_id: 480, title: '[probe] mentioned-bot',
    state: 'opened', web_url: `${WEB}/-/issues/3`, author: { id: 92, username: BOT } } }
/** A recorded merge request (`GET projects/480/merge_requests/1`), including the async-preparation fields. */
export const recordedMergeRequest = { id: 5686, iid: 1, project_id: 480, state: 'merged', title: '[probe] MR contract test',
  description: 'probe', source_branch: 'probe/mr-test-1', target_branch: 'main', source_project_id: 480, target_project_id: 480,
  sha: '4ee36fa71cb74388b9f0d13c0d8babffaf7e19d4', merge_commit_sha: 'bf48d64d3560922579a4b23ffe9276e065d167b3',
  merged_at: '2026-11-03T02:18:31.386Z', detailed_merge_status: 'not_open', merge_status: 'can_be_merged',
  diff_refs: { base_sha: 'aab075ae', start_sha: 'aab075ae', head_sha: '4ee36fa7' }, has_conflicts: false,
  created_at: '2026-11-03T02:16:40.000Z', updated_at: '2026-11-03T02:18:31.386Z', web_url: `${WEB}/-/merge_requests/1`,
  author: { id: 92, username: BOT, name: 'superagent-bot' }, references: { short: '!1' } }
/** One recorded pipeline (`GET projects/480/pipelines/9933`) with a pending job list, as Auto DevOps leaves it here. */
export const recordedPipeline = { id: 9933, iid: 3, sha: '4ee36fa71cb74388b9f0d13c0d8babffaf7e19d4', ref: 'probe/mr-test-1',
  status: 'pending', source: 'push', created_at: '2026-11-03T02:16:30.000Z', updated_at: '2026-11-03T02:16:31.000Z',
  web_url: `${WEB}/-/pipelines/9933`, user: { id: 92, username: BOT } }
export const recordedJob = { id: 22368, name: 'test', stage: 'test', status: 'pending', allow_failure: false }
/** One recorded inline diff note (`GET …/merge_requests/1/discussions`), with the position and resolution flags of a review thread. */
export const recordedDiffNote = { ...recordedNote, id: 27738, type: 'DiffNote', body: 'Use the theme token', resolvable: true,
  resolved: false, created_at: '2026-11-03T02:16:50.000Z', updated_at: '2026-11-03T02:16:50.000Z',
  position: { base_sha: 'aab075ae', start_sha: 'aab075ae', head_sha: '4ee36fa7', old_path: 'src/render.ts',
    new_path: 'src/render.ts', position_type: 'text', old_line: null, new_line: 43, line_range: null } }
/** One recorded merge request approval read (`GET …/merge_requests/1/approvals`); this instance requires no approval. */
export const recordedApprovals = { id: 6001, iid: 1, project_id: 480, title: '[probe] MR contract test', state: 'opened',
  approvals_required: 0, approvals_left: 0, approved: false, approved_by: [] }
/** One recorded branch (`GET …/repository/branches`), with the head commit a push or merge names. */
export const recordedBranch = { name: 'main', default: true, protected: true, merged: false,
  commit: { id: '4ee36fa71cb74388b9f0d13c0d8babffaf7e19d4', short_id: '4ee36fa7', title: 'probe: add contract test file',
    created_at: '2026-11-03T02:16:25.000Z' } }

/** The user GitLab reports for the agent account; only `GET /user` carries `bot`. */
export const botUser = { id: 92, username: BOT, name: 'superagent-bot', bot: true }
/** An ordinary project member, whose nested user objects carry no `bot` field. */
export const person = (username = ALICE) => ({ id: 35, username, name: 'Alice', state: 'active' })
export const issue = (iid: number, overrides: Record<string, unknown> = {}) => ({ ...recordedIssue, iid, web_url: `${WEB}/-/issues/${iid}`,
  description: `Please take issue ${iid}`, ...overrides })
export const mergeRequest = (iid: number, overrides: Record<string, unknown> = {}) => ({ ...recordedMergeRequest, iid, state: 'opened',
  merged_at: null, merge_commit_sha: null, detailed_merge_status: 'mergeable', web_url: `${WEB}/-/merge_requests/${iid}`, ...overrides })
export const note = (id: number, body: string, overrides: Record<string, unknown> = {}) => {
  const created = typeof overrides.created_at === 'string' ? overrides.created_at : `2026-09-09T00:00:0${id % 10}Z`
  return { ...recordedNote, id, body, created_at: created, updated_at: created, ...overrides }
}
/** An inline diff note with its file, line and resolution flags; `overrides` may move it or resolve it. */
export const diffNote = (id: number, body: string, overrides: Record<string, unknown> = {}) => {
  const created = typeof overrides.created_at === 'string' ? overrides.created_at : `2026-11-03T02:16:5${id % 10}.000Z`
  return { ...recordedDiffNote, id, body, created_at: created, updated_at: created, ...overrides }
}
export const systemNote = (id: number, body: string, overrides: Record<string, unknown> = {}) =>
  ({ ...recordedSystemNote, id, body, ...overrides })
export const discussion = (id: string, notes: unknown[], individual = false) => ({ id, individual_note: individual, notes })
export const todo = (id: number, action: string, overrides: Record<string, unknown> = {}) => ({ ...recordedTodo, id, action_name: action,
  author: person(), ...overrides })
export const pipeline = (id: number, status: string, overrides: Record<string, unknown> = {}) =>
  ({ ...recordedPipeline, id, status, user: botUser, ...overrides })
export const job = (id: number, name: string, status: string, overrides: Record<string, unknown> = {}) =>
  ({ ...recordedJob, id, name, status, ...overrides })
/** An approval read for a merge request; `overrides` names approvers or required approvals. */
export const approvals = (iid: number, overrides: Record<string, unknown> = {}) => ({ ...recordedApprovals, iid, ...overrides })
/** An entry of a repository directory (`GET …/repository/tree`), which is a `blob` or a `tree`. */
export const treeEntry = (name: string, type: 'blob' | 'tree' = 'blob', path = name) =>
  ({ id: `sha-${name}`, name, type, path, mode: type === 'tree' ? '040000' : '100644' })
/** A branch of the project; `overrides` may make it the default or protect it. */
export const branch = (name: string, overrides: Record<string, unknown> = {}) =>
  ({ ...recordedBranch, name, default: name === 'main', protected: name === 'main', ...overrides })

/** A resolved GitLab deployment of `acme/widgets` on `gitlab.example.com`, for commands and Source contexts. */
export const gitlabAccount = (overrides: Partial<GitlabAccount> = {}): GitlabAccount => ({ cli: '/path/agent-glab',
  url: 'http://gitlab.example.com', scheme: 'http', host: 'gitlab.example.com', project: 'acme/widgets', projectId: 7,
  login: 'agent-bot', userId: 92, commitEmail: 'agent-bot@example.com', defaultBranch: 'main', accessLevel: 40,
  pushAllowed: true, mergeAllowed: true, mergeChecks: [], webUrl: 'http://gitlab.example.com/acme/widgets', ...overrides })
export const gitlabDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({ ...testMachine(),
  vcs: 'gitlab', repository: 'acme/widgets', gitlab: gitlabAccount(), ...overrides })
/** The project context a Trigger factory takes, resolved from the deployment. */
export const projectRef = (overrides: Partial<GitlabAccount> = {}) => {
  const account = gitlabAccount(overrides)
  return { projectId: account.projectId, project: account.project, webUrl: account.webUrl }
}
