/**
 * GitLab source kind definition and Cordis plugin entry.
 * It receives the project's pending todos, the observed issue and merge request streams, the merge requests of open tickets,
 * subscribed threads and the default branch's CI, and replies in those threads as the agent account.
 */
import type { Context } from '@deepseek-ai/cordis'
import { GitlabConfigSchema, type GitlabConfig } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import { z } from 'zod'
import { sendGitlab, gitlabLink } from './gitlab-channel.ts'
import { runGitlab } from './gitlab-loops.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

export const SOURCE = 'gitlab'
const OBSERVED = { issues: 'observeIssues', merge_requests: 'observeMergeRequests', comments: 'observeComments', ci: 'observeCi' } as const
type Row = keyof typeof OBSERVED
/** The admission row a GitLab Trigger belongs to: a new issue or merge request, a note or discussion, or a default-branch pipeline change. */
function rowOf(meta: Record<string, unknown>): Row | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'merge_request') return 'merge_requests'
  return typeof meta.kind === 'string' && ['note', 'discussion', 'conversation', 'inline'].includes(meta.kind) ? 'comments' : undefined
}
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体在一个自建 GitLab 项目上的账号；接收项目里发给它的求助、已订阅工单的讨论、默认分支的 CI，以及合并请求的合并与关闭。',
    en: 'The agent\'s account on one self-hosted GitLab project; receives requests to it in the project, discussion on subscribed tickets, the default branch\'s CI, and merge request merges or closes.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'url', type: 'text', pattern: 'https?://[^/\\s]+/?', label: { zh: 'GitLab 地址', en: 'GitLab URL' },
      hint: { zh: '写作 http://主机名，不带路径；这个部署的实例 API 走 http。保存时检查智能体 CLI 在这个实例上登录的账号能否读取并推送项目，然后重启 dsh-superagent。',
        en: 'Written http://host without a path; this deployment\'s instance serves its API over http. Saving checks that the account the agent CLI is signed in to can read and push to the project, then restarts dsh-superagent.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 命名空间/项目，可以有多层命名空间。这个来源接收这个项目的事件；保存时按 GitLab 返回的路径规范化。',
        en: 'Written namespace/project, with nested namespaces allowed. This Source receives the project\'s events; saving takes the canonical path GitLab reports.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它。保存时检查账号和项目，然后重启 dsh-superagent。',
        en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through GLAB_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as glab. Saving checks the account and the project, then restarts dsh-superagent.' } },
    { key: 'access', type: 'fact', advanced: true, label: { zh: '推送与合并默认分支', en: 'Pushing and merging into the default branch' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。',
        en: 'New issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。',
        en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，Issue 和合并请求上没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。',
        en: 'Comments on issues and merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive the default branch\'s CI' },
      hint: { zh: '打开后，默认分支的 CI 失败和恢复会收到，由策略的接收表决定是否成为候选。',
        en: 'Failures of the default branch\'s CI, and its recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } }],
  // What the Source observes across the project it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = rowOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: {
    // Replies go to an Issue or merge request of this Source's project, whichever thread a retained address names.
    allowed: (address, config) => (address.kind === 'issue' || address.kind === 'merge_request') && Number(address.iid) > 0
      && (!address.project || !config.project || sameName(address.project, config.project)),
    send: sendGitlab,
    link: gitlabLink,
  },
  threadContext: gitlabThreadContext,
  // `#12` names Issue 12, `!12` merge request 12, and a page or note URL names what it points at, of this project only.
  find: query => {
    const text = query.trim()
    const named = /^([#!])(\d+)$/.exec(text)
    const page = /\/-(?:\/)?(issues|merge_requests)\/(\d+)/.exec(text)
    const kind = named?.[1] === '!' || page?.[1] === 'merge_requests' ? 'merge_request' : 'issue'
    const iid = named?.[2] ?? page?.[2]
    const note = /#note_(\d+)/.exec(text)?.[1]
    return { threads: iid ? [`${SOURCE}:${kind}:${iid}`] : [], terms: note ? [note] : [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号（例如 project_480_bot_…）的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收项目里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。',
        en: 'A comment of a bot account on this list, such as project_480_bot_…, becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the project on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、合并请求或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an issue, a merge request or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.parse(stored)
      const note = (observed: boolean) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Row, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New issues' }), row('merge_requests', { zh: '新合并请求', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_URL', description: { zh: '这个来源监听的 GitLab 实例地址，带协议；克隆和链接都用它', en: 'Base URL of the GitLab instance this Source watches, with its scheme; clones and links use it' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的 GitLab 项目，命名空间/项目。合并请求的源分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The GitLab project this Source watches, as namespace/project. A merge request whose source branch\'s last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；GitLab 操作以它进行，不用其他账号或凭据', en: 'The agent\'s GitLab account. GitLab operations use it, never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或合并请求的 IID；工单不是从 GitLab 来的时为空', en: 'IID of the issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_KIND', description: { zh: '接下工单的是 issue 还是 merge_request；从 CI 来的或不是从 GitLab 来的时为空', en: 'Whether an issue or a merge_request started the ticket; empty for CI and for tickets that did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的合并请求的 head 引用 refs/merge-requests/<IID>/head；不是合并请求时为空', en: 'Head ref refs/merge-requests/<IID>/head of the merge request that started the ticket; empty when it was not a merge request' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PUSH_ALLOWED', description: { zh: '智能体能否直接推送到默认分支；默认分支对这个角色受保护时为 false', en: 'Whether the agent may push to the default branch directly; false when that branch is protected from its role' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MERGE_ALLOWED', description: { zh: '智能体能否合并到默认分支；这个角色不能合并时为 false', en: 'Whether the agent may merge into the default branch; false when its role may not merge there' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitlab = deployment.gitlab
      const iid = trigger?.source === SOURCE ? Number(trigger.meta.iid) || 0 : 0
      // A note names its conversation in `targetKind`; an Issue or merge request Trigger names it in `kind`.
      const named = trigger?.source === SOURCE ? [trigger.meta.kind, trigger.meta.targetKind] : []
      const kind = named.find(value => value === 'issue' || value === 'merge_request') ?? ''
      return { DSH_SUPERAGENT_GITLAB_URL: gitlab?.url ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: gitlab?.project ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.commitEmail ?? '',
        DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '', DSH_SUPERAGENT_GITLAB_KIND: kind,
        DSH_SUPERAGENT_GITLAB_MR_HEAD: iid && kind === 'merge_request' ? `refs/merge-requests/${iid}/head` : '',
        DSH_SUPERAGENT_GITLAB_PUSH_ALLOWED: String(gitlab?.pushAllowed ?? false), DSH_SUPERAGENT_GITLAB_MERGE_ALLOWED: String(gitlab?.mergeAllowed ?? false) }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
    project: { zh: `项目 ${deployment.gitlab.project}（id ${deployment.gitlab.projectId}，默认分支 ${deployment.gitlab.defaultBranch || '无'}）`,
      en: `Project ${deployment.gitlab.project} (id ${deployment.gitlab.projectId}, default branch ${deployment.gitlab.defaultBranch || 'none'})` },
    access: { zh: `推送默认分支 ${deployment.gitlab.pushAllowed ? '可以' : '不可以'}，合并 ${deployment.gitlab.mergeAllowed ? '可以' : '不可以'}`,
      en: `Push to the default branch ${deployment.gitlab.pushAllowed ? 'allowed' : 'not allowed'}, merge ${deployment.gitlab.mergeAllowed ? 'allowed' : 'not allowed'}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = runGitlab(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
