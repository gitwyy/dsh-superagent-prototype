/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { sameName } from './infra/text.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  nightshiftConfig: s.string().default('').description('Absolute local JSON configuration for dedicated fixed-workspace nightshift mode; empty preserves ordinary ticket execution.'),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  nightshiftConfig?: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, nightshiftConfig, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, ...(nightshiftConfig ? { nightshiftConfig } : {}), promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** The fields setup reads: `url` names the instance (scheme and host), `project` is `namespace/project`, `cli` the agent's glab wrapper. */
export const GitlabAccountsSchema = z.object({
  url: z.string().trim().default(''),
  project: z.string().trim().default(''),
  cli: z.string().trim().default(''),
})
/** The GitLab Source's configuration, which its kind validates: one instance watches one project. */
export const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observeMergeRequests: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict()
  .refine(config => config.url === '' || /^https?:\/\/[^/\s]+\/?$/.test(config.url), { path: ['url'], message: 'http(s)://host' })
  .refine(config => config.project === '' || /^([A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(config.project), { path: ['project'], message: 'namespace/project' })
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape),
  gitlab: ['url', 'project', 'cli'], feishu: Object.keys(FeishuBotSchema.shape) }

export type Vcs = 'github' | 'gitlab'
export interface GithubAccount { cli: string; login: string; noreply: string }
/**
 * A resolved GitLab account and its pilot project. `pushAllowed` and `mergeAllowed` say what the agent's project role allows
 * on the project's default branch, so a role that must open a merge request for a person to merge is told so.
 */
export interface GitlabAccount {
  cli: string
  /** The instance URL without a trailing slash, such as `http://gitlab.example.com`. */
  url: string
  scheme: 'http' | 'https'
  /** The instance host, with its port when it has one. */
  host: string
  /** GitLab's canonical `path_with_namespace`, which may differ from the configured path after a rename. */
  project: string
  projectId: number
  login: string
  userId: number
  commitEmail: string
  defaultBranch: string
  /** The agent's GitLab access level on the project: 30 is Developer, 40 Maintainer, 50 Owner. */
  accessLevel: number
  pushAllowed: boolean
  mergeAllowed: boolean
  /** Merge checks the project requires, such as `pipeline` and `discussions`. */
  mergeChecks: string[]
  webUrl: string
}
export interface Deployment extends Machine {
  /** The VCS this deployment works through: GitLab when its Source is enabled, otherwise GitHub. */
  vcs: Vcs
  /** Canonical project path: GitHub's `owner/name`, or the GitLab project's `path_with_namespace`. */
  repository: string
  github?: GithubAccount
  gitlab?: GitlabAccount
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[], stderr?: boolean) => Promise<string>
/**
 * Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` or `glab`
 * wrapper script reaches the real binary. `stderr` also returns the command's standard error, for CLIs that report their
 * status there (such as `glab auth status`).
 */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return (argv, stderr = false) => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), undefined, stderr)
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, vcs: 'github', repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const DEVELOPER = 30
const GitlabUser = z.object({ id: z.number().int().positive(), username: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  commit_email: z.string().nullish(), email: z.string().nullish() })
const GitlabAccess = z.looseObject({ access_level: z.number().int().nullish() })
const GitlabProject = z.looseObject({
  id: z.number().int().positive(),
  path_with_namespace: z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/),
  default_branch: z.string().nullish(),
  web_url: z.string().default(''),
  permissions: z.looseObject({ project_access: GitlabAccess.nullish(), group_access: GitlabAccess.nullish() }).nullish(),
  only_allow_merge_if_pipeline_succeeds: z.boolean().default(false),
  only_allow_merge_if_all_discussions_are_resolved: z.boolean().default(false),
})
const GitlabBranchAccess = z.looseObject({ access_level: z.number().int().nullish(), user_id: z.number().int().nullish() })
const GitlabProtectedBranch = z.looseObject({ name: z.string(),
  push_access_levels: z.array(GitlabBranchAccess).default([]), merge_access_levels: z.array(GitlabBranchAccess).default([]) })
/** Splits the configured GitLab instance URL into the address every API call and clone uses. */
function gitlabHost(url: string): { url: string; scheme: 'http' | 'https'; host: string } {
  if (!url) throw new SetupError('gitlabUrlUnset')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new SetupError('gitlabUrlInvalid', { output: url }) }
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || path || parsed.search || parsed.hash
    || parsed.username || parsed.password) throw new SetupError('gitlabUrlInvalid', { output: url })
  const scheme = parsed.protocol === 'https:' ? 'https' : 'http'
  return { url: `${scheme}://${parsed.host}`, scheme, host: parsed.host }
}
/** True when one of a protected branch's access levels lets the agent's project role through. */
const levelsAllow = (levels: readonly { access_level?: number | null | undefined }[], accessLevel: number): boolean =>
  levels.some(level => typeof level.access_level === 'number' && level.access_level > 0 && accessLevel >= level.access_level)
/**
 * Verify the agent's GitLab CLI identity, the project it may read, and what its role may do on the default branch: the
 * project must allow pushing at all (Developer or above), and the protected default branch says whether it may push to
 * that branch directly and merge into it. The canonical project path and the commit email come from GitLab itself.
 * Every call names the instance, because glab defaults to gitlab.com.
 */
export async function resolveGitlab(machine: Machine, gitlab: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<GitlabAccount> {
  const { stateDir } = machine
  const accounts = GitlabAccountsSchema.parse(gitlab ?? {})
  const { url, scheme, host } = gitlabHost(accounts.url)
  const { project } = accounts
  if (!project) throw new SetupError('gitlabProjectUnset')
  if (!accounts.cli) throw new SetupError('gitlabCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const run = (args: string[], stderr = false): Promise<string> =>
    probe(['env', 'GLAB_NO_PROMPT=1', 'GLAB_CHECK_UPDATE=false', 'NO_COLOR=1', cli, ...args], stderr)
  const flag = ['--hostname', host]
  // `glab auth status` reports on standard error; it exits non-zero when the host is not signed in.
  const status = await run(['auth', 'status', ...flag], true).catch((error: unknown) => {
    throw new SetupError('gitlabCliSignedOut', { host, output: reason(error) })
  })
  const signedIn = /Logged in to \S+ as (\S+)/.exec(status)?.[1]
  if (!signedIn) throw new SetupError('gitlabCliSignedOut', { host, output: status.trim() })
  const user = parsed(GitlabUser, await run(['api', 'user', ...flag]).catch((error: unknown) => {
    throw new SetupError('gitlabCliSignedOut', { host, output: reason(error) })
  }))
  if (!user) throw new SetupError('gitlabNoAccount', { host })
  if (!sameName(signedIn, user.username)) throw new SetupError('gitlabCliSignedOut', { host, output: `auth status reports ${signedIn}; api user reports ${user.username}` })
  const info = parsed(GitlabProject, await run(['api', `projects/${encodeURIComponent(project)}`, ...flag]).catch((error: unknown) => {
    throw new SetupError('gitlabProjectUnreadable', { account: user.username, project, output: reason(error) })
  }))
  if (!info) throw new SetupError('gitlabProjectUnreported', { project })
  const accessLevel = info.permissions?.project_access?.access_level ?? info.permissions?.group_access?.access_level ?? 0
  if (accessLevel < DEVELOPER) throw new SetupError('gitlabReadOnly', { account: user.username, project: info.path_with_namespace })
  const branches = parsed(z.array(GitlabProtectedBranch), await run(['api', `projects/${info.id}/protected_branches`, ...flag]).catch((error: unknown) => {
    throw new SetupError('gitlabBranchesUnreadable', { project: info.path_with_namespace, output: reason(error) })
  }))
  if (!branches) throw new SetupError('gitlabBranchesUnreadable', { project: info.path_with_namespace })
  const branch = info.default_branch ?? ''
  const protectedBranch = branches.find(item => item.name === branch)
  // A Developer may do everything on an unprotected branch; on a protected one only the access levels it lists apply.
  const pushAllowed = protectedBranch ? levelsAllow(protectedBranch.push_access_levels, accessLevel) : accessLevel >= DEVELOPER
  const mergeAllowed = protectedBranch ? levelsAllow(protectedBranch.merge_access_levels, accessLevel) : accessLevel >= DEVELOPER
  const mergeChecks = [...info.only_allow_merge_if_pipeline_succeeds ? ['pipeline'] : [],
    ...info.only_allow_merge_if_all_discussions_are_resolved ? ['discussions'] : []]
  return { cli, url, scheme, host, project: info.path_with_namespace, projectId: info.id, login: user.username, userId: user.id,
    commitEmail: user.commit_email ?? user.email ?? '', defaultBranch: branch, accessLevel, pushAllowed, mergeAllowed, mergeChecks, webUrl: info.web_url }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
