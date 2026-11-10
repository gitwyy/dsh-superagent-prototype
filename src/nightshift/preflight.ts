import { execFile } from 'node:child_process'
import { access, lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { NightConfig, Task } from './contracts.ts'

const exec = promisify(execFile)
const isMissingPath = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
export const FIXED_PATH = `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`
export const GIT = '/usr/bin/git'
export const GIT_SAFE_ARGS = ['--no-replace-objects', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'diff.submodule=short', '-c', 'log.showSignature=false', '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', '-c', 'credential.helper=']
export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Deliberately NOT {...process.env}: no host tokens, bot identities, loaders, shell hooks or shims. */
export function workerEnvironment(config: NightConfig): NodeJS.ProcessEnv {
  return {
    PATH: FIXED_PATH, HOME: config.piHome, LANG: 'en_US.UTF-8', LC_ALL: 'C',
    PI_CODING_AGENT_DIR: config.piHome, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  }
}
export async function safeGit(repo: string, args: string[], config: NightConfig): Promise<string> {
  // Config names are non-executable. Reject mutable includes before Git reads the working tree;
  // otherwise an allowed source edit could install a clean filter that status executes in the host.
  const keys = await exec(GIT, [...GIT_SAFE_ARGS, '-C', repo, 'config', '--no-includes', '--name-only', '--list'], {
    env: workerEnvironment(config), timeout: 5_000, maxBuffer: 128 * 1024, encoding: 'utf8',
  })
  if (keys.stdout.split('\n').some(key => /^(?:include\.path|includeif\..+\.path|filter\..+\.(?:clean|smudge|process)|core\.worktree|extensions\.worktreeconfig|core\.sshcommand)$/i.test(key))) {
    throw new Error('Executable Git filters/SSH or mutable includes/worktree configuration is unsupported')
  }
  const result = await exec(GIT, [...GIT_SAFE_ARGS, '-C', repo, ...args], {
    env: workerEnvironment(config), timeout: 5_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
  })
  return result.stdout
}

/** Resolve missing final components without allowing an existing symlink to hide containment. */
export async function canonicalPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Absolute path required')
  try { return await realpath(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(await canonicalPath(parent), relative(parent, path))
  }
}

export async function readJsonFile(path: string): Promise<unknown> {
  const file = await stat(path)
  if (!file.isFile() || file.size > 2 * 1024 * 1024) throw new Error('Unsafe configuration file')
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch { throw new Error('Invalid Pi configuration JSON') }
}
function commandCredential(value: unknown): boolean {
  if (typeof value === 'string') return value.trimStart().startsWith('!')
  if (Array.isArray(value)) return value.some(commandCredential)
  return value !== null && typeof value === 'object' && Object.values(value).some(commandCredential)
}
export async function validateSession(config: NightConfig): Promise<void> {
  try {
    const info = await lstat(config.sessionFile)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Session must be a regular file')
    const file = await open(config.sessionFile, 'r')
    try {
      const data = Buffer.alloc(64 * 1024)
      const { bytesRead } = await file.read(data, 0, data.length, 0)
      const end = data.subarray(0, bytesRead).indexOf(10)
      if (end < 0) throw new Error('Session header missing')
      let header: { type?: string; cwd?: string }
      try { header = JSON.parse(data.subarray(0, end).toString('utf8')) as typeof header }
      catch { throw new Error('Invalid session header JSON') }
      if (header.type !== 'session' || header.cwd !== config.workspace) throw new Error('Session cwd differs from fixed workspace')
    } finally { await file.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function validateConfig(config: NightConfig): Promise<Record<string, string>> {
  if (process.platform === 'win32') throw new Error('POSIX process-group supervision required')
  if (!Number.isFinite(config.maxTaskSeconds) || config.maxTaskSeconds <= 0) throw new Error('Invalid task budget')
  for (const path of [config.workspace, config.piHome, config.piExecutable, config.stateDir, config.sessionFile]) {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('Configuration requires absolute paths')
  }
  if (await realpath(config.workspace) !== config.workspace) throw new Error('Workspace must be canonical')
  if (!(await stat(config.workspace)).isDirectory() || !(await stat(config.piHome)).isDirectory()) throw new Error('Workspace/piHome missing')
  // Pi 1.5 runs these migrations before --no-approve/extension loading; do not
  // let legacy credential commands or package/tool moves bypass later checks.
  const homeEntries = await readdir(config.piHome)
  if (homeEntries.some(name => ['oauth.json', 'commands', 'tools'].includes(name) || name.endsWith('.jsonl'))) {
    throw new Error('Legacy Pi home requires manual offline migration before nightshift')
  }
  try {
    const keys = await readJsonFile(resolve(config.piHome, 'keybindings.json'))
    if (keys && typeof keys === 'object' && Object.keys(keys).some(key => key !== '$schema' && !key.includes('.'))) throw new Error('Legacy Pi keybindings require manual offline migration')
  } catch (error) { if (!isMissingPath(error)) throw error }
  // Pi 1.5 runs this project migration before --no-approve/extension loading.
  try {
    await lstat(resolve(config.workspace, '.pi/commands'))
    try { await lstat(resolve(config.workspace, '.pi/prompts')) }
    catch (error) { if (isMissingPath(error)) throw new Error('Pi startup would migrate project commands; manual migration required'); throw error }
  } catch (error) { if (!isMissingPath(error)) throw error }
  await access(config.piExecutable, constants.X_OK)
  if (!(await stat(config.piExecutable)).isFile()) throw new Error('Pi executable is not a file')
  for (const path of [config.stateDir, config.sessionFile, config.piHome]) {
    const canonical = await canonicalPath(path)
    if (within(config.workspace, canonical)) throw new Error('State, session and piHome must be outside the workspace')
    if (canonical !== resolve(path)) throw new Error('State/session/piHome paths must not traverse symlinks')
  }
  if (!within(config.stateDir, config.sessionFile)) throw new Error('Session must be in the owned state directory')
  if (!config.provider || !config.model) throw new Error('Explicit provider and model required; no ambient identity/model fallback')
  for (const name of ['auth.json', 'models.json', 'settings.json']) {
    try {
      const value = await readJsonFile(resolve(config.piHome, name))
      if (commandCredential(value)) throw new Error('Command-valued Pi configuration is unsupported')
      if (name === 'settings.json' && value && typeof value === 'object') {
        const settings = value as Record<string, unknown>
        if (Object.hasOwn(settings, 'apiKeys')) throw new Error('Legacy Pi API keys require manual offline migration')
        // Pi resolves configured packages BEFORE filtering --no-extensions (Pi 1.5 resource-loader).
        if (Array.isArray(settings.packages) && settings.packages.length) throw new Error('Pi packages must be empty in the dedicated nightshift piHome')
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const repositories: Record<string, string> = {}
  for (const [name, path] of Object.entries(config.repositories)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('Invalid repository name')
    const canonical = await realpath(path)
    if (!within(config.workspace, canonical) || /(^|[/\\_-])(mate-one-platform|legacy)([/\\_-]|$)/i.test(`${name}/${canonical}`)) throw new Error(`Repository excluded: ${name}`)
    if (Object.values(repositories).includes(canonical)) throw new Error('Duplicate canonical repository registry')
    const root = (await safeGit(canonical, ['rev-parse', '--show-toplevel'], config)).trim()
    if (await realpath(root) !== canonical) throw new Error(`Repository root mismatch: ${name}`)
    repositories[name] = canonical
  }
  if (!Object.keys(repositories).length) throw new Error('No repositories registered')
  await validateSession(config)
  return repositories
}

export type WriterProbe = (config: NightConfig, repositories: string[]) => Promise<string[]>
/** Best-effort OS process visibility; a candidate with unverifiable cwd fails closed. Not an OS lock. */
export const probeOtherPi: WriterProbe = async (config, repositories) => {
  const env = workerEnvironment(config)
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,command='], { env, encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })
  const problems: string[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match || Number(match[1]) === process.pid) continue
    const command = match[2]!
    if (!(command.includes(config.piExecutable) || /(?:^|[/\s])pi(?:\s|$)|pi-coding-agent[/\\].*(?:cli|rpc-entry)/.test(command))) continue
    const pid = Number(match[1])
    try {
      let cwd: string
      if (process.platform === 'linux') cwd = await realpath(`/proc/${pid}/cwd`)
      else {
        const output = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { env, timeout: 5_000, encoding: 'utf8', maxBuffer: 64 * 1024 })
        cwd = output.stdout.split('\n').find(entry => entry.startsWith('n'))?.slice(1) ?? ''
        if (!cwd) throw new Error('No cwd')
      }
      if (within(config.workspace, cwd) || repositories.some(repo => within(repo, cwd))) problems.push(`Other Pi writer in workspace (pid ${pid})`)
    } catch { problems.push(`Cannot verify other Pi process (pid ${pid})`) }
  }
  return problems
}

export async function preflight(config: NightConfig, tasks: Task[], probe: WriterProbe = probeOtherPi): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = []
  try {
    const repos = await validateConfig(config)
    for (const task of tasks) {
      if (!task.repositories.length || task.repositories.some(name => !Object.hasOwn(repos, name))) problems.push(`Invalid repository scope for task ${task.id}`)
      if (task.access === 'write' && !task.approved) problems.push(`Scoped write approval required for task ${task.id}`)
    }
    const selected = new Set(tasks.flatMap(task => task.repositories))
    for (const [name, repo] of Object.entries(repos)) {
      if (!selected.has(name) && repo !== config.workspace) continue
      // Git filters can execute even on status/diff. Reject before inspecting worktree contents.
      const keys = await safeGit(repo, ['config', '--name-only', '--list'], config)
      if (keys.split('\n').some(key => /^filter\..+\.(?:clean|smudge|process)$/i.test(key) || key.toLowerCase() === 'core.sshcommand')) {
        problems.push(`Executable Git filter/SSH configuration is unsupported: ${name}`)
        continue
      }
      const status = await safeGit(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], config)
      const entries = status.split('\0').filter(Boolean)
      // The controller exclusively owns this lock; it is not a business-worktree change.
      if (entries.some(entry => !(repo === config.workspace && entry === '?? .superagent-nightshift.lock'))) problems.push(`Dirty repository: ${name}`)
    }
    problems.push(...await probe(config, Object.values(repos)))
  } catch (error) {
    // Do not include exec stderr/config values: these can contain credentials.
    problems.push(error instanceof Error && !('cmd' in error) ? error.message : 'Preflight inspection failed')
  }
  return { ok: problems.length === 0, problems }
}
