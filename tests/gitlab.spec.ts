import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Trigger } from '../src/core/index.ts'
import { GitlabConfigSchema, SETUP_FIELDS, resolveGitlab, type Deployment, type GitlabAccount, type Machine, type Probe }
  from '../src/deployment.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { Setup } from '../src/app/setup.ts'
import { ExecutorConfigSchema, SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SOURCE, gitlabKind } from '../src/sources/gitlab.ts'
import { agentVariables, credentialHelper, verifyEnvironment, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { SetupError } from '../src/setup.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const exec = promisify(execFile)
// Setup spawns CLI subprocesses and git, which can take several seconds when the suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
let dir: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...testMachine({ stateDir: join(dir, 'state') }), ...overrides })
/** Runs commands as worker shells do, locally: the stand-ins first on PATH, then the system's tools. */
const probes = (): Probe => async (argv, stderr = false) => {
  const { stdout, stderr: error } = await exec(argv[0]!, argv.slice(1), { env: { PATH: [join(dir, 'bin'), '/usr/bin', '/bin'].join(':'), HOME: dir } })
  return stdout + (stderr ? error : '')
}
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

const user = (overrides: Record<string, unknown> = {}) => ({ id: 92, username: 'bot', commit_email: 'bot@example.com', ...overrides })
const project = (overrides: Record<string, unknown> = {}) => ({ id: 7, path_with_namespace: 'acme/widgets', default_branch: 'main',
  web_url: 'http://gitlab.example.com/acme/widgets', permissions: { project_access: { access_level: 40 }, group_access: null },
  only_allow_merge_if_pipeline_succeeds: false, only_allow_merge_if_all_discussions_are_resolved: false, ...overrides })
const protectedBranches = (push = 40, merge = 40) => [{ name: 'main', push_access_levels: [{ access_level: push }], merge_access_levels: [{ access_level: merge }] }]
interface Fake { user?: Record<string, unknown>; project?: Record<string, unknown>; branches?: unknown[]; authAs?: string
  fail?: 'auth' | 'user' | 'project' | 'branches' }
/** A glab stand-in that answers the setup probes for gitlab.example.com, and refuses any call that names another host. */
function glab(file: string, options: Fake = {}): string {
  const account = options.user ?? user()
  const repository = options.project ?? project()
  const authAs = options.authAs ?? String(account.username)
  const branches = options.branches ?? protectedBranches()
  const answer = (name: NonNullable<Fake['fail']>, failure: string, body: string): string =>
    options.fail === name ? `${failure} >&2; exit 1` : `echo '${body}'`
  return program(file, [
    'case "$*" in',
    `  "auth status --hostname gitlab.example.com") ${options.fail === 'auth' ? 'echo "glab: not logged in to gitlab.example.com" >&2; exit 1'
      : `echo '  Logged in to gitlab.example.com as ${authAs} (%s)' >&2`} ;;`,
    `  "api user --hostname gitlab.example.com") ${answer('user', 'echo "HTTP 401"', JSON.stringify(account))} ;;`,
    `  "api projects/"*"/protected_branches --hostname gitlab.example.com") ${answer('branches', 'echo "HTTP 403"', JSON.stringify(branches))} ;;`,
    `  "api projects/"*" --hostname gitlab.example.com") ${answer('project', 'echo "HTTP 404"', JSON.stringify(repository))} ;;`,
    '  *) echo "unexpected glab call: $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n'))
}
const resolve = (config: Record<string, unknown>) => resolveGitlab(machine(), config, probes(), [join(dir, 'bin'), '/usr/bin', '/bin'].join(':'))

const account = (overrides: Partial<GitlabAccount> = {}): GitlabAccount => ({ cli: join(dir, 'bin', 'glab-bot'), url: 'http://gitlab.example.com',
  scheme: 'http', host: 'gitlab.example.com', project: 'acme/widgets', projectId: 7, login: 'bot', userId: 92,
  commitEmail: 'bot@example.com', defaultBranch: 'main', accessLevel: 40, pushAllowed: true, mergeAllowed: true, mergeChecks: [],
  webUrl: 'http://gitlab.example.com/acme/widgets', ...overrides })
const gitlabDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({ ...machine(), vcs: 'gitlab', repository: 'acme/widgets',
  gitlab: account(), ...overrides })
/** A SubprocessRuntime answering `runAsWorker`'s `git config` reads from `answers`. */
const subprocess = (answers: Record<string, string>): SubprocessRuntime => ({
  spawn: ({ argv }: { argv: readonly string[] }) => {
    const text = answers[argv.join(' ')] ?? ''
    const reader = () => ({ readFrom: () => ({ text, nextOffset: 0, lossy: false }) })
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(), stderr: reader() } }
  },
}) as unknown as SubprocessRuntime
const helperOf = (key: string, cli: string) => `file:${workerGitConfig(dir)}\0${credentialHelper(cli)}\0`
/** A SubprocessRuntime that starts real processes, so Setup's probes and verifyEnvironment run as they do in production. */
const spawnSubprocess = (): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: process.env })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
const setupWith = () => new Setup({ context: { subprocess: spawnSubprocess(), logger: { warn: vi.fn() } } as unknown as Context,
  machine: machine(), lifetime: new AbortController().signal, restart: vi.fn() })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitlab-'))
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'state'), { recursive: true })
  glab(join(dir, 'bin', 'glab-bot'))
  vi.stubEnv('PATH', [join(dir, 'bin'), '/usr/bin', '/bin'].join(':'))
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

describe('gitlab source kind', () => {
  it('fills the GitLab configuration defaults and validates the host URL, project path and poll settings', () => {
    expect(GitlabConfigSchema.parse({})).toEqual({ url: '', project: '', cli: '', pollSeconds: 60, failuresBeforeError: 3,
      observeIssues: false, observeMergeRequests: false, observeComments: false, observeCi: false })
    expect(GitlabConfigSchema.parse({ url: 'http://gitlab.example.com/', project: 'group/sub/project', cli: '/opt/glab-bot' }))
      .toMatchObject({ url: 'http://gitlab.example.com/', project: 'group/sub/project', cli: '/opt/glab-bot' })
    expect(() => GitlabConfigSchema.parse({ url: 'gitlab.example.com' })).toThrow()
    expect(() => GitlabConfigSchema.parse({ url: 'http://gitlab.example.com/api/v4' })).toThrow()
    expect(() => GitlabConfigSchema.parse({ project: 'widgets' })).toThrow()
    expect(() => GitlabConfigSchema.parse({ pollSeconds: 10 })).toThrow()
    expect(() => GitlabConfigSchema.parse({ unknown: true })).toThrow()
    // Changing setup fields restarts dsh-superagent; changing the polling interval or observation switches does not.
    expect(SETUP_FIELDS.gitlab).toEqual(['url', 'project', 'cli'])
  })
  it('declares its health entry, policy schema and admission rows, and validates a saved instance with them', () => {
    expect(gitlabKind.health).toEqual(['gitlab'])
    expect(gitlabKind.policy!.schema.parse({ allowed: [{ id: 'alice_1' }] })).toEqual({ allowed: [{ id: 'alice_1' }] })
    expect(gitlabKind.policy!.schema.parse({ allowed: [], bots: [{ id: 'project_480_bot_abc' }] })).toMatchObject({ bots: [{ id: 'project_480_bot_abc' }] })
    expect(() => gitlabKind.policy!.schema.parse({ allowed: [{ id: 'Alice Smith' }] })).toThrow()
    const config = GitlabConfigSchema.parse({ url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot',
      observeIssues: true, observeCi: true })
    const rows = gitlabKind.policy!.rows!(config)
    expect(rows.map(row => row.id)).toEqual(['issues', 'merge_requests', 'comments', 'ci'])
    expect(rows[0]).toMatchObject({ note: { zh: '全部', en: 'All' },
      cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } })
    expect(rows[1]?.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
    expect(rows[2]?.note).toEqual({ zh: '仅 @', en: '@ only' })
    // A CI change has no sender, so only the cell of an unlisted sender who did not address the agent applies.
    expect(rows[3]?.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true })
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { gitlab: { enabled: false, config } } }))
    const dispose = sources.register(gitlabKind)
    expect(sources.validate('gitlab', { enabled: true, config: {} })).toEqual({ enabled: true, config: GitlabConfigSchema.parse({}) })
    expect(() => sources.validate('gitlab', { enabled: true, config: { project: 'widgets' } })).toThrow()
    expect(sources.instances()).toEqual([{ id: 'gitlab', kind: 'gitlab', enabled: false, config, installed: true }])
    expect(sources.healthEntries(['gitlab']).size).toBe(1)
    dispose()
  })
  it('maps a trigger to observation and an admission row, and names the nine execution variables', () => {
    const config = GitlabConfigSchema.parse({ observeIssues: true, observeComments: true })
    expect(gitlabKind.scope!({ meta: { kind: 'issue' } }, config)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { kind: 'merge_request' } }, config)).toEqual({ listened: true, observed: false, row: 'merge_requests' })
    expect(gitlabKind.scope!({ meta: { kind: 'note' } }, config)).toEqual({ listened: true, observed: true, row: 'comments' })
    expect(gitlabKind.scope!({ meta: { kind: 'discussion', ci: false } }, config)).toEqual({ listened: true, observed: true, row: 'comments' })
    expect(gitlabKind.scope!({ meta: { ci: true, branch: 'main' } }, config)).toEqual({ listened: true, observed: false, row: 'ci' })
    // A merge request's head pipeline reaches its ticket but never originates a candidate, so it has no admission row.
    expect(gitlabKind.scope!({ meta: { ci: true, kind: 'merge_request', iid: 5 } }, config)).toEqual({ listened: true, observed: false })
    expect(gitlabKind.scope!({ meta: {} }, config)).toEqual({ listened: true, observed: false })
    expect(gitlabKind.environment!.variables.map(variable => variable.key)).toEqual(['DSH_SUPERAGENT_GITLAB_URL',
      'DSH_SUPERAGENT_GITLAB_PROJECT', 'DSH_SUPERAGENT_GITLAB_ACCOUNT', 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL',
      'DSH_SUPERAGENT_GITLAB_IID', 'DSH_SUPERAGENT_GITLAB_KIND', 'DSH_SUPERAGENT_GITLAB_MR_HEAD',
      'DSH_SUPERAGENT_GITLAB_PUSH_ALLOWED', 'DSH_SUPERAGENT_GITLAB_MERGE_ALLOWED'])
  })
  it('reports the resolved project and what its role may do as facts', () => {
    expect(gitlabKind.facts!(undefined)).toEqual({})
    expect(gitlabKind.facts!(gitlabDeployment())).toMatchObject({ cli: { zh: '当前账号 @bot', en: 'Current account @bot' },
      project: { zh: '项目 acme/widgets（id 7，默认分支 main）', en: 'Project acme/widgets (id 7, default branch main)' } })
    expect(gitlabKind.facts!(gitlabDeployment({ gitlab: account({ pushAllowed: false, mergeAllowed: false }) })).access)
      .toEqual({ zh: '推送默认分支 不可以，合并 不可以', en: 'Push to the default branch not allowed, merge not allowed' })
  })
})

describe('GitLab setup checks', () => {
  it('reads the signed-in bot, the project and the protected default branch through glab', async () => {
    expect(await resolve({ url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' })).toEqual({
      cli: join(dir, 'bin', 'glab-bot'), url: 'http://gitlab.example.com', scheme: 'http', host: 'gitlab.example.com',
      project: 'acme/widgets', projectId: 7, login: 'bot', userId: 92, commitEmail: 'bot@example.com', defaultBranch: 'main',
      accessLevel: 40, pushAllowed: true, mergeAllowed: true, mergeChecks: [], webUrl: 'http://gitlab.example.com/acme/widgets' })
    // GitLab's canonical path wins over a renamed one the operator still has, and https keeps its scheme.
    glab(join(dir, 'bin', 'glab-bot'), { project: project({ path_with_namespace: 'acme/gadgets' }) })
    expect((await resolve({ url: 'https://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' })).project).toBe('acme/gadgets')
    expect((await resolve({ url: 'https://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' })).scheme).toBe('https')
    expect((await resolve({ url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot',
      observeCi: true, pollSeconds: 600 })).project).toBe('acme/gadgets')
  })
  it('records what the protected default branch lets the agent do, without failing a role that cannot merge', async () => {
    glab(join(dir, 'bin', 'glab-bot'), { project: project({ permissions: { project_access: { access_level: 30 }, group_access: null } }) })
    const developer = await resolve({ url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' })
    expect(developer).toMatchObject({ accessLevel: 30, pushAllowed: false, mergeAllowed: false })
    // On an unprotected default branch a Developer may push and merge; a project that requires pipeline and discussion checks says so.
    glab(join(dir, 'bin', 'glab-bot'), { project: project({ permissions: { project_access: null, group_access: { access_level: 30 } },
      only_allow_merge_if_pipeline_succeeds: true, only_allow_merge_if_all_discussions_are_resolved: true }), branches: [] })
    expect(await resolve({ url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' }))
      .toMatchObject({ accessLevel: 30, pushAllowed: true, mergeAllowed: true, mergeChecks: ['pipeline', 'discussions'] })
  })
  it('names what setup still needs, in the GitLab Source card', async () => {
    const needs = async (code: string, values: Record<string, unknown>, config: Record<string, unknown>, setup: Fake = {}) => {
      glab(join(dir, 'bin', 'glab-bot'), setup)
      await expect(resolve(config)).rejects.toEqual(setupError('gitlab', code, values))
    }
    const base = { url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' }
    await needs('gitlabUrlUnset', {}, { ...base, url: '' })
    await needs('gitlabUrlInvalid', { output: 'gitlab.example.com' }, { ...base, url: 'gitlab.example.com' })
    await needs('gitlabUrlInvalid', { output: 'http://gitlab.example.com/api/v4' }, { ...base, url: 'http://gitlab.example.com/api/v4' })
    await needs('gitlabProjectUnset', {}, { ...base, project: '' })
    await needs('gitlabCliUnset', {}, { ...base, cli: '' })
    await needs('gitlabCliMissing', { output: 'nothing-here is not an executable file on PATH' }, { ...base, cli: 'nothing-here' })
    await needs('gitlabCliSignedOut', { host: 'gitlab.example.com', output: expect.stringContaining('not logged in') }, base, { fail: 'auth' })
    await needs('gitlabCliSignedOut', { host: 'gitlab.example.com', output: expect.stringContaining('HTTP 401') }, base, { fail: 'user' })
    await needs('gitlabCliSignedOut', { host: 'gitlab.example.com', output: 'auth status reports alice; api user reports bot' }, base, { authAs: 'alice' })
    await needs('gitlabNoAccount', {}, base, { user: {} })
    await needs('gitlabProjectUnreadable', { account: 'bot', project: 'acme/widgets', output: expect.stringContaining('HTTP 404') }, base, { fail: 'project' })
    await needs('gitlabProjectUnreported', { project: 'acme/widgets' }, base, { project: {} })
    await needs('gitlabReadOnly', { account: 'bot', project: 'acme/widgets' }, base,
      { project: project({ permissions: { project_access: { access_level: 20 }, group_access: null } }) })
    await needs('gitlabBranchesUnreadable', { project: 'acme/widgets', output: expect.stringContaining('HTTP 403') }, base, { fail: 'branches' })
  })
})

describe('GitLab worker environment', () => {
  it('writes a glab shim and the GitLab host credential helper beside the GitHub ones', async () => {
    const cli = program(join(dir, 'bin', 'glab-echo'), 'echo "$GITLAB_HOST:$*"')
    const gitlab = account({ cli })
    await writeEnvironment(testDeployment({ stateDir: dir, vcs: 'gitlab', repository: 'acme/widgets', github: undefined, feishu: undefined, gitlab }), [])
    const bin = workerBin(dir)
    expect(readdirSync(bin).sort()).toEqual(['gh', 'glab', 'lark-cli'])
    expect(readFileSync(join(bin, 'gh'), 'utf8')).toContain('gh is unavailable: this installation has no GitHub account.')
    expect(readFileSync(join(bin, 'lark-cli'), 'utf8')).toContain('lark-cli is unavailable: this installation has no Feishu bot.')
    const shim = readFileSync(join(bin, 'glab'), 'utf8')
    expect(shim).toContain(`export GITLAB_HOST='gitlab.example.com'`)
    expect(shim).toContain(`exec '${cli}' "$@"`)
    // The instance is HTTP-only, so an SSH remote is rewritten to the scheme it serves, and the helper asks the agent's glab.
    const gitconfig = readFileSync(workerGitConfig(dir), 'utf8')
    expect(gitconfig).toContain(`[credential "http://gitlab.example.com"]\n\thelper = "${credentialHelper(cli)}"`)
    expect(gitconfig).toContain(`[credential "https://gitlab.example.com"]\n\thelper = "${credentialHelper(cli)}"`)
    expect(gitconfig).toContain(`[url "http://gitlab.example.com/"]\n\tinsteadOf = git@gitlab.example.com:\n\tinsteadOf = ssh://git@gitlab.example.com/`)
    expect(gitconfig).not.toContain('[credential "https://github.com"]')
    const glabCall = await exec(join(bin, 'glab'), ['api', 'user'], { env: { PATH: [bin, join(dir, 'bin'), '/usr/bin', '/bin'].join(':') } })
    expect(glabCall.stdout).toBe('gitlab.example.com:api user\n')
  })
  it('names the active VCS CLI in a blocked command message and refuses to block the commands workers need', async () => {
    const gitlab = account()
    await writeEnvironment(testDeployment({ stateDir: dir, vcs: 'gitlab', github: undefined, feishu: undefined, gitlab }),
      ['personal-glab', 'glab', 'gh', 'lark-cli', 'git'])
    expect(readdirSync(workerBin(dir))).toContain('personal-glab')
    await expect(exec(join(workerBin(dir), 'personal-glab'), [])).rejects.toMatchObject({ code: 1,
      stderr: 'personal-glab is blocked in this installation; use glab, which acts as bot.\n' })
    expect(() => ExecutorConfigSchema.parse({ blockedCommands: ['glab'] })).toThrow(/glab.*cannot be blocked/)
    expect(() => ExecutorConfigSchema.parse({ blockedCommands: ['personal-glab'] })).not.toThrow()
    // With both VCS Sources configured the message keeps naming gh, as a GitHub deployment always did.
    await writeEnvironment(testDeployment({ stateDir: dir, gitlab }), ['personal-glab'])
    await expect(exec(join(workerBin(dir), 'personal-glab'), [])).rejects.toMatchObject({ code: 1,
      stderr: 'personal-glab is blocked in this installation; use gh, which acts as agent-bot.\n' })
  })
  it('strips the operator\'s GitLab token and host variables from the agent environment', () => {
    expect(agentVariables(dir)).toMatchObject({ GITLAB_TOKEN: undefined, CI_JOB_TOKEN: undefined, GITLAB_HOST: undefined })
  })
  it('verifies the GitLab credential helper git reads, and reports a git too old to read the file', async () => {
    const gitlab = account()
    await writeEnvironment(testDeployment({ stateDir: dir, vcs: 'gitlab', github: undefined, feishu: undefined, gitlab }), [])
    const cli = join(dir, 'bin', 'glab-bot')
    const key = 'git config -z --show-origin --get-all credential.http://gitlab.example.com.helper'
    const signal = new AbortController().signal
    await expect(verifyEnvironment({ stateDir: dir, gitlab: { ...gitlab, cli } }, subprocess({ [key]: helperOf(key, cli) }), signal)).resolves.toBeUndefined()
    await expect(verifyEnvironment({ stateDir: dir, gitlab: { ...gitlab, cli: '/other/glab' } }, subprocess({ [key]: helperOf(key, cli) }), signal))
      .rejects.toMatchObject({ place: 'deployment', code: 'gitlabGitTooOld' })
    // A GitHub account stays verified too, with its own message.
    const github = { cli: '/opt/gh', login: 'agent-bot', noreply: '' }
    const githubKey = 'git config -z --show-origin --get-all credential.https://github.com.helper'
    await expect(verifyEnvironment({ stateDir: dir, github, gitlab: { ...gitlab, cli } },
      subprocess({ [key]: helperOf(key, cli), [githubKey]: helperOf(githubKey, github.cli) }), signal)).resolves.toBeUndefined()
    await expect(verifyEnvironment({ stateDir: dir, github: { ...github, cli: '/other/gh' } },
      subprocess({ [githubKey]: helperOf(githubKey, github.cli) }), signal)).rejects.toMatchObject({ place: 'deployment', code: 'gitTooOld' })
  })
})

describe('GitLab execution variables', () => {
  const settings = (enabled: boolean) => SettingsSchema.parse({ sources: { gitlab: { enabled,
    config: { url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' } } } })
  const registered = (enabled: boolean) => {
    const sources = new SourceRegistry(() => settings(enabled))
    sources.register(gitlabKind)
    return sources
  }
  const trigger = (meta: Record<string, unknown>): Trigger => ({ id: 't1', source: SOURCE, threads: [{ source: SOURCE, id: 'merge_request:3' }],
    actor: { source: SOURCE, id: 'alice' }, human: true, at: '2026-09-09T00:00:00Z', text: 'hi', meta })
  const value = (variables: ReturnType<typeof environmentOf>, key: string) => variables.find(variable => variable.key === key)

  it('passes the project, account and capabilities to a ticket only while the GitLab Source is enabled', () => {
    const deployment = gitlabDeployment()
    const environment = settings(true)
    const variables = environmentOf({ deployment, sources: registered(true), settings: environment })
    expect(value(variables, 'DSH_SUPERAGENT_GITLAB_URL')).toMatchObject({ value: 'http://gitlab.example.com', owner: 'gitlab' })
    expect(value(variables, 'DSH_SUPERAGENT_GITLAB_PROJECT')?.value).toBe('acme/widgets')
    expect(value(variables, 'DSH_SUPERAGENT_GITLAB_ACCOUNT')?.value).toBe('bot')
    expect(value(variables, 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL')?.value).toBe('bot@example.com')
    expect(value(variables, 'DSH_SUPERAGENT_GITLAB_PUSH_ALLOWED')?.value).toBe('true')
    expect(value(variables, 'DSH_SUPERAGENT_GITLAB_MERGE_ALLOWED')?.value).toBe('true')
    // Outside a ticket the origin IID and kind are empty.
    expect(value(variables, 'DSH_SUPERAGENT_GITLAB_IID')?.value).toBe('')
    expect(value(variables, 'DSH_SUPERAGENT_GITLAB_KIND')?.value).toBe('')
    expect(value(variables, 'DSH_SUPERAGENT_GITLAB_MR_HEAD')?.value).toBe('')
    const disabled = environmentOf({ deployment, sources: registered(false), settings: settings(false) })
    expect(disabled.filter(variable => variable.key.startsWith('DSH_SUPERAGENT_GITLAB_'))).toEqual([])
  })
  it('names the IID, kind and merge request head of the trigger that started a ticket', () => {
    const environment = settings(true)
    const sources = registered(true)
    const mergeRequest = environmentOf({ deployment: gitlabDeployment(), sources, settings: environment, trigger: trigger({ kind: 'merge_request', iid: 3 }) })
    expect(value(mergeRequest, 'DSH_SUPERAGENT_GITLAB_IID')?.value).toBe('3')
    expect(value(mergeRequest, 'DSH_SUPERAGENT_GITLAB_KIND')?.value).toBe('merge_request')
    expect(value(mergeRequest, 'DSH_SUPERAGENT_GITLAB_MR_HEAD')?.value).toBe('refs/merge-requests/3/head')
    const issue = environmentOf({ deployment: gitlabDeployment(), sources, settings: environment, trigger: trigger({ kind: 'issue', iid: 12 }) })
    expect(value(issue, 'DSH_SUPERAGENT_GITLAB_KIND')?.value).toBe('issue')
    expect(value(issue, 'DSH_SUPERAGENT_GITLAB_MR_HEAD')?.value).toBe('')
    const ci = environmentOf({ deployment: gitlabDeployment(), sources, settings: environment, trigger: trigger({ ci: true, branch: 'main' }) })
    expect(value(ci, 'DSH_SUPERAGENT_GITLAB_IID')?.value).toBe('')
    expect(value(ci, 'DSH_SUPERAGENT_GITLAB_KIND')?.value).toBe('')
  })
})

describe('GitLab setup', () => {
  it('resolves a GitLab-only deployment, writes the worker environment, and restores it', async () => {
    const setup = setupWith()
    const settings = SettingsSchema.parse({ sources: { gitlab: { enabled: true,
      config: { url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' } } } })
    try {
      expect(await setup.run(settings)).toBe(true)
      expect(setup.deployment).toMatchObject({ vcs: 'gitlab', repository: 'acme/widgets',
        gitlab: { project: 'acme/widgets', login: 'bot', commitEmail: 'bot@example.com', pushAllowed: true, mergeAllowed: true } })
      expect(setup.deployment.github).toBeUndefined()
      const stateDir = join(dir, 'state'), bin = workerBin(stateDir)
      expect(readdirSync(bin).sort()).toEqual(['gh', 'glab', 'lark-cli'])
      expect(readFileSync(join(bin, 'glab'), 'utf8')).toContain(`export GITLAB_HOST='gitlab.example.com'`)
      expect(readFileSync(workerGitConfig(stateDir), 'utf8')).toContain('[credential "http://gitlab.example.com"]')
      expect(process.env).toMatchObject({ GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1' })
      expect(process.env.PATH?.split(':')[0]).toBe(bin)
      // Saving the GitLab card checks the same account, project and branch before the settings are stored.
      await expect(setup.checkAccounts('source:gitlab', settings)).resolves.toBeUndefined()
    } finally { setup.restore() }
    expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(process.env.PATH?.split(':')).not.toContain(workerBin(join(dir, 'state')))
  })
  it('leaves the GitHub Source active, and writes no glab environment, while the GitLab Source is off', async () => {
    program(join(dir, 'bin', 'gh'), 'case "$*" in\n  "api user") echo \'{"login":"agent-bot","id":7}\' ;;\n  "api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}") echo \'{"name":"acme/widgets","push":true}\' ;;\n  *) exit 1 ;;\nesac')
    const setup = setupWith()
    const settings = SettingsSchema.parse({ sources: {
      github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } },
      gitlab: { enabled: false, config: { url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' } } } })
    try {
      expect(await setup.run(settings)).toBe(true)
      expect(setup.deployment).toMatchObject({ vcs: 'github', repository: 'acme/widgets', github: { login: 'agent-bot' } })
      expect(setup.deployment.gitlab).toBeUndefined()
      expect(readdirSync(workerBin(join(dir, 'state'))).sort()).toEqual(['gh', 'lark-cli'])
      expect(readFileSync(workerGitConfig(join(dir, 'state')), 'utf8')).not.toContain('gitlab.example.com')
    } finally { setup.restore() }
  })
  it('refuses a deployment that turns on both VCS Sources', async () => {
    const setup = setupWith()
    const settings = SettingsSchema.parse({ sources: {
      github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } },
      gitlab: { enabled: true, config: { url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' } } } })
    expect(await setup.run(settings)).toBe(false)
    expect(setup.problem).toMatchObject({ place: 'github', code: 'bothVcsSources' })
    expect(existsSync(workerBin(join(dir, 'state')))).toBe(false)
    expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  })
  it('waits for setup when the GitLab account or project does not check out, and changes nothing', async () => {
    glab(join(dir, 'bin', 'glab-bot'), { fail: 'project' })
    const setup = setupWith()
    const settings = SettingsSchema.parse({ sources: { gitlab: { enabled: true,
      config: { url: 'http://gitlab.example.com', project: 'acme/widgets', cli: 'glab-bot' } } } })
    expect(await setup.run(settings)).toBe(false)
    expect(setup.configured()).toBe(false)
    expect(setup.problem).toMatchObject({ place: 'gitlab', code: 'gitlabProjectUnreadable' })
    expect(() => setup.deployment).toThrow('waiting for setup')
    expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  })
})
