import { spawn, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ReleaseRepository } from './contracts.ts'

/** Host-only credential value. Never serialize into Pi policy, logs, results, argv or environment. */
export interface ReleaseCredential { token: string; userId: number; username: string; projectId: number; expiresAt: string }
export interface GitCommandResult { code: number | null; stdout: string }
export type GitCommandRunner = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }) => Promise<GitCommandResult>
export interface GitPushOptions { tempRoot: string; /** Tests only; never populated from model/config input. */ runGit?: GitCommandRunner }
export interface GitPushRequest { repository: ReleaseRepository; credential: ReleaseCredential; sha: string; sourceBranch: string; expectedRemoteSha?: string; signal: AbortSignal; assertAuthorized: () => void }
const within = (root: string, path: string) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)) }
export const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
export function validSourceBranch(value: string): boolean { return /^(?:sdd|agent)\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,180}$/.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) }
function fail(message: string): never { throw new Error(message) }

export async function readReleaseCredential(repository: ReleaseRepository): Promise<ReleaseCredential> {
  const path = repository.credentialFile
  if (!isAbsolute(path) || await realpath(path) !== path || within(repository.root, path)) fail('Release credential path must be canonical and outside the repository')
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await fd.stat()
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024 || (process.getuid && info.uid !== process.getuid())) fail('Release credential file must be owner-only mode 0600')
    let value: unknown
    try { value = JSON.parse(await fd.readFile('utf8')) } catch { fail('Invalid release credential file') }
    const credential = value as Partial<ReleaseCredential> | null
    if (!credential || typeof credential.token !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(credential.token) || credential.userId !== repository.expectedUserId || credential.username !== repository.expectedUsername || credential.projectId !== repository.projectId || typeof credential.expiresAt !== 'string' || !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) fail('Release credential identity/project/expiry mismatch')
    return credential as ReleaseCredential
  } finally { await fd.close() }
}

/** No remote/config path comes from the checkout. HTTP is an explicit, unsafe operator exception. */
export function releaseOrigin(repository: ReleaseRepository): URL {
  let url: URL
  try { url = new URL(repository.apiOrigin) } catch { fail('Invalid release API origin') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.host !== repository.host || !['https:', 'http:'].includes(url.protocol)) fail('Release origin must match the exact pinned host without credentials or path')
  if (url.protocol === 'http:' && repository.allowInsecureHttp !== true) fail('Plaintext HTTP credentials are disabled; explicit operator transport approval is required')
  if (!Number.isSafeInteger(repository.projectId) || repository.projectId <= 0 || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(repository.projectPath) || repository.projectPath.split('/').some(part => part === '.' || part === '..' || part.endsWith('.git'))) fail('Invalid pinned project route')
  return url
}
export function releaseRemoteUrl(repository: ReleaseRepository): string { return new URL(`${repository.projectPath.split('/').map(encodeURIComponent).join('/')}.git`, releaseOrigin(repository)).href }
const SAFE = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat', '-c', 'core.sshCommand=/usr/bin/false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false', '-c', 'push.recurseSubmodules=no', '-c', 'push.followTags=false', '-c', 'push.gpgSign=false', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'http.proxy=', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never', '-c', 'protocol.ssh.allow=never']
const defaultRunGit: GitCommandRunner = (args, options) => new Promise((resolveResult, reject) => {
  if (options.signal.aborted) { reject(new Error('Git transport cancelled')); return }
  if (process.platform === 'win32') { reject(new Error('Isolated Git transport requires POSIX process groups')); return }
  const spawnOptions: SpawnOptions = { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  const child = spawn('/usr/bin/git', args, spawnOptions)
  let output = ''; let bytes = 0; let timedOut = false; let aborted = false; let failed = false
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* close/group check remains authoritative */ } } }
  const hardTimer = setTimeout(() => { kill(); child.stdout?.destroy(); child.stderr?.destroy(); reject(new Error('Git process-group shutdown unverified; remote outcome may be unknown')) }, 62_000)
  const timer = setTimeout(() => { timedOut = true; kill() }, 60_000)
  const abort = () => { aborted = true; kill() }; options.signal.addEventListener('abort', abort, { once: true })
  child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 1024 * 1024) output += chunk.toString('utf8'); else kill() })
  child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) kill() })
  child.once('error', () => { failed = true })
  child.once('close', code => {
    clearTimeout(timer); clearTimeout(hardTimer); options.signal.removeEventListener('abort', abort)
    let groupGone = !child.pid
    if (child.pid) {
      try { process.kill(-child.pid, 0); kill() }
      catch (error) { groupGone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
    }
    if (!groupGone || failed || timedOut || aborted || bytes > 1024 * 1024) reject(new Error('Git transport failed or interrupted; remote outcome may be unknown'))
    else resolveResult({ code, stdout: output })
  })
})

async function copyLocalObjects(root: string, bare: string, signal: AbortSignal): Promise<void> {
  const objects = resolve(root, '.git/objects')
  if (await realpath(resolve(root, '.git')) !== resolve(root, '.git') || !(await lstat(resolve(root, '.git'))).isDirectory() || await realpath(objects) !== objects) fail('Linked/symlink Git directories are unsupported for transport')
  for (const file of ['info/alternates', 'info/http-alternates']) { try { await lstat(resolve(objects, file)); fail('Git object alternates are forbidden') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  let files = 0; let bytes = 0
  for (const entry of await readdir(objects, { withFileTypes: true })) {
    signal.throwIfAborted()
    if (entry.name === 'info') continue
    if (!entry.isDirectory() || (entry.name !== 'pack' && !/^[a-f0-9]{2}$/.test(entry.name))) fail('Unsupported Git object directory')
    const destination = resolve(bare, 'objects', entry.name); await mkdir(destination, { recursive: true, mode: 0o700 })
    for (const file of await readdir(resolve(objects, entry.name), { withFileTypes: true })) {
      signal.throwIfAborted()
      const expected = entry.name === 'pack' ? /^pack-[a-f0-9]{40}\.(?:pack|idx|rev|bitmap)$/ : /^[a-f0-9]{38}$/
      if (!file.isFile() || !expected.test(file.name)) fail('Unsupported or linked Git object file')
      const source = resolve(objects, entry.name, file.name); const info = await lstat(source)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('Unsafe Git object file')
      bytes += info.size; files++
      if (bytes > 512 * 1024 * 1024 || files > 50_000) fail('Repository object export exceeds transport budget')
      await copyFile(source, resolve(destination, file.name), constants.COPYFILE_EXCL)
    }
  }
}

export interface LocalCommitEvidence { treeSha: string; parents: string[] }
/** Read immutable commit/tree identity in a fresh credential-free bare repository.
 * Never invoke Git inside the business checkout or consult its config/replacements.
 */
export async function readLocalCommitEvidence(options: GitPushOptions, repository: ReleaseRepository, sha: string, signal: AbortSignal): Promise<LocalCommitEvidence> {
  if (!isSha(sha) || await realpath(repository.root) !== repository.root || !isAbsolute(options.tempRoot) || within(repository.root, options.tempRoot)) fail('Invalid local commit evidence scope')
  await mkdir(options.tempRoot, { recursive: true, mode: 0o700 })
  if (await realpath(options.tempRoot) !== options.tempRoot || (await lstat(options.tempRoot)).mode & 0o077) fail('Git evidence temp root must be canonical and private')
  const temp = await mkdtemp(resolve(options.tempRoot, 'evidence-'))
  const bare = resolve(temp, 'repo.git'); const home = resolve(temp, 'home')
  await mkdir(home, { mode: 0o700 })
  const env = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '' }
  const run = options.runGit ?? defaultRunGit
  const call = async (args: string[]) => {
    signal.throwIfAborted()
    const result = await run([...SAFE, ...args], { cwd: temp, env, signal })
    if (result.code !== 0) fail('Local immutable commit/tree evidence could not be verified')
    return result.stdout
  }
  try {
    await call(['init', '--bare', '--template=', bare])
    await copyLocalObjects(repository.root, bare, signal)
    const prefix = [`--git-dir=${bare}`]
    if ((await call([...prefix, 'cat-file', '-t', sha])).trim() !== 'commit') fail('Release SHA is not a local commit')
    await call([...prefix, 'fsck', '--strict', '--no-reflogs', '--connectivity-only', sha])
    const commit = await call([...prefix, 'cat-file', 'commit', sha])
    const headers = commit.split('\n\n', 1)[0]!.split('\n')
    const trees = headers.filter(line => line.startsWith('tree ')).map(line => line.slice(5))
    const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7))
    if (trees.length !== 1 || !isSha(trees[0]) || !parents.every(isSha) || (await call([...prefix, 'cat-file', '-t', trees[0]])).trim() !== 'tree') fail('Malformed immutable commit/tree evidence')
    return { treeSha: trees[0], parents }
  } finally {
    if (dirname(temp) !== options.tempRoot || !temp.startsWith(`${options.tempRoot}${sep}evidence-`) || await realpath(temp) !== temp) fail('Evidence cleanup namespace changed; manual recovery required')
    await rm(temp, { recursive: true, force: false })
  }
}

/** Export exact local objects without executing checkout config, upload-pack, filters,
 * hooks, or alternates. The isolated bare repository is the only Git cwd/config.
 * Same-UID processes are outside this confidentiality boundary; this is not a sandbox.
 */
export function createGitPushTransport(options: GitPushOptions) {
  const run = options.runGit ?? defaultRunGit
  return async (request: GitPushRequest): Promise<{ remoteIds: string[]; detail: string }> => {
    const { repository, credential, sha, sourceBranch, expectedRemoteSha, signal } = request
    if (!isSha(sha) || (expectedRemoteSha !== undefined && !isSha(expectedRemoteSha)) || !validSourceBranch(sourceBranch) || sourceBranch === repository.targetBranch) fail('Invalid exact push SHA or source branch')
    if (credential.userId !== repository.expectedUserId || credential.projectId !== repository.projectId || credential.username !== repository.expectedUsername || Date.parse(credential.expiresAt) <= Date.now()) fail('Push credential identity mismatch')
    const remote = releaseRemoteUrl(repository)
    const root = await realpath(repository.root)
    if (root !== repository.root || !isAbsolute(options.tempRoot) || within(root, options.tempRoot)) fail('Git transport root must be outside the business repository')
    await mkdir(options.tempRoot, { recursive: true, mode: 0o700 })
    if (await realpath(options.tempRoot) !== options.tempRoot || (await lstat(options.tempRoot)).mode & 0o077) fail('Git transport temp root must be canonical and private')
    const temp = await mkdtemp(resolve(options.tempRoot, 'push-'))
    const bare = resolve(temp, 'repo.git'); const home = resolve(temp, 'home')
    await mkdir(home, { mode: 0o700 })
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_COUNT: '0', GIT_ALLOW_PROTOCOL: 'https' + (repository.allowInsecureHttp ? ':http' : '') }
    const call = async (args: string[], codeAllowed = 0) => {
      const out = await run([...SAFE, ...args], { cwd: temp, env, signal })
      if (out.code !== codeAllowed) fail('Isolated Git verification or push failed; no retry was attempted')
      return out.stdout
    }
    try {
      await call(['init', '--bare', '--template=', bare])
      await copyLocalObjects(root, bare, signal)
      const prefix = [`--git-dir=${bare}`]
      if ((await call([...prefix, 'cat-file', '-t', sha])).trim() !== 'commit') fail('Approved SHA is not a local commit')
      await call([...prefix, 'fsck', '--strict', '--no-reflogs', '--connectivity-only', sha])
      if (expectedRemoteSha && expectedRemoteSha !== sha) await call([...prefix, 'merge-base', '--is-ancestor', expectedRemoteSha, sha])
      const secret = resolve(temp, 'credential.json'); await writeFile(secret, JSON.stringify(credential), { flag: 'wx', mode: 0o600 })
      const askpass = resolve(temp, 'askpass')
      // No token in script/argv/env. Only this isolated Git child can request this fixed credential file.
      const helper = `#!${process.execPath}\n'use strict';const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(${JSON.stringify(secret)},'utf8'));if(Date.parse(c.expiresAt)<=Date.now())process.exit(1);const p=process.argv[2]||'';if(p.startsWith('Username'))process.stdout.write(c.username);else if(p.startsWith('Password'))process.stdout.write(c.token);else process.exit(1);\n`
      await writeFile(askpass, helper, { flag: 'wx', mode: 0o700 })
      env.GIT_ASKPASS = askpass; env.SSH_ASKPASS = '/usr/bin/false'
      const net = [...prefix, '-c', `protocol.${releaseOrigin(repository).protocol.slice(0, -1)}.allow=always`]
      const ref = `refs/heads/${sourceBranch}`
      const remoteRefs = (await call([...net, 'ls-remote', '--refs', remote, ref])).trim().split('\n').filter(Boolean)
      if (remoteRefs.length > 1) fail('Ambiguous remote source branch')
      const observed = remoteRefs[0]?.split(/\s+/)
      if (observed && (observed[1] !== ref || !isSha(observed[0]))) fail('Invalid remote source ref')
      if (observed?.[0] !== expectedRemoteSha) fail('Remote source branch changed since admission')
      if (expectedRemoteSha === sha) return { remoteIds: [`ref:${ref}`, `sha:${sha}`], detail: 'Exact source SHA already present; no push sent' }
      signal.throwIfAborted()
      if (typeof request.assertAuthorized !== 'function') fail('Live host authorization callback is required before push')
      request.assertAuthorized()
      // Ordinary non-force push: no tags, mirror, options, target-branch push or retries.
      await call([...net, 'push', '--porcelain', '--no-verify', '--recurse-submodules=no', '--', remote, `${sha}:${ref}`])
      return { remoteIds: [`ref:${ref}`, `sha:${sha}`], detail: 'One non-force exact-SHA push accepted; authoritative readback still required' }
    } finally {
      // Resolve the exact created namespace before deleting; never remove a computed unchecked path.
      if (dirname(temp) !== options.tempRoot || !temp.startsWith(`${options.tempRoot}${sep}push-`) || await realpath(temp) !== temp) fail('Transport cleanup namespace changed; manual recovery required')
      await rm(temp, { recursive: true, force: false })
    }
  }
}
