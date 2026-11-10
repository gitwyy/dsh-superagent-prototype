import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isSha, releaseRemoteUrl, releaseOrigin, validSourceBranch, type ReleaseCredential } from './git-transport.ts'
import type { CandidateEvidence, MergePlan, ReleaseRepository, ReleaseRequest, ReleaseScope, RemoteSnapshot } from './contracts.ts'

export interface MergeGitResult { code: number | null; stdout: Buffer | string }
export type MergeGitRunner = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }) => Promise<MergeGitResult>
export interface MergeObjectsOptions {
  tempRoot: string
  /** Host/test seams only: never accept these values from the model or repository. */
  runGit?: MergeGitRunner
  gitExecutable?: string
}
export interface MergeCommitEvidence { treeSha: string; parents: string[] }
const MAX_OUTPUT = 8 * 1024 * 1024
const MAX_OBJECT_BYTES = 512 * 1024 * 1024
const MAX_OBJECT_FILES = 50_000
const SAFE = ['--no-replace-objects', '--literal-pathspecs', '--no-pager',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat',
  '-c', 'core.sshCommand=/usr/bin/false', '-c', 'credential.helper=', '-c', 'credential.useHttpPath=true',
  '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'http.proxy=', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=20',
  '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never', '-c', 'protocol.ssh.allow=never',
  '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'fetch.writeCommitGraph=false',
  '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.unpackLimit=0',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'maintenance.autoDetach=false',
  '-c', 'diff.external=', '-c', 'diff.submodule=short', '-c', 'log.showSignature=false',
  '-c', 'merge.renormalize=false', '-c', 'merge.renames=true']
const inside = (root: string, path: string) => { const value = relative(root, path); return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)) }
function fail(reason: string): never { throw new Error(reason) }
const RECOVERY_FILE = 'merge-process-unknown.json'
const activeRoots = new Set<string>()
function writerUnknown(pgid?: number) {
  return Object.assign(new Error('Merge credential process shutdown is unverified; manual recovery required'), { code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false as const, ...(Number.isSafeInteger(pgid) && pgid! > 1 ? { pgid } : {}) })
}
/** Read-only startup/preflight gate. Marker presence is never stale-stolen or
 * auto-cleared based on PID reuse; operator reconciliation must remove it. */
export async function assertMergeProcessesStopped(tempRoot: string): Promise<void> {
  if (activeRoots.has(tempRoot)) throw writerUnknown()
  await assertNoRetainedMergeProcesses(tempRoot)
}
async function assertNoRetainedMergeProcesses(tempRoot: string): Promise<void> {
  if (!isAbsolute(tempRoot) || resolve(tempRoot) !== tempRoot) throw writerUnknown()
  let fd: Awaited<ReturnType<typeof open>> | undefined
  try {
    fd = await open(resolve(tempRoot, RECOVERY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await fd.stat()
    if (!info.isFile() || info.size > 16 * 1024 || info.nlink !== 1 || (info.mode & 0o077)) throw writerUnknown()
    let value: { pgid?: number }
    try { value = JSON.parse(await fd.readFile('utf8')) as typeof value } catch { throw writerUnknown() }
    throw writerUnknown(value.pgid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if ((error as { code?: string }).code === 'NIGHTSHIFT_WRITER_UNKNOWN') throw error
      throw writerUnknown()
    }
  } finally { await fd?.close() }
  // A host crash can happen before an UNKNOWN result/marker is written while a
  // detached credential process still lives. Any retained operation namespace is
  // sufficient to fail closed; neither PID liveness nor marker absence is proof.
  try { if ((await readdir(tempRoot)).some(name => name.startsWith('merge-objects-'))) throw writerUnknown() }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw writerUnknown() }
}
async function persistUnknown(tempRoot: string, temporary: string, repository: string, pgid?: number): Promise<void> {
  const file = await open(resolve(tempRoot, RECOVERY_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(JSON.stringify({ version: 1, code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false, pgid, temporary, repository, at: new Date().toISOString() }) + '\n'); await file.sync() }
  finally { await file.close() }
  const directory = await open(tempRoot, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
function buffer(value: Buffer | string): Buffer { return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8') }
function branch(value: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,180}$/.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) }

/** Only a pinned Git process runs here, in its own group; diagnostics never escape.
 * Unknown shutdown retains the private namespace. This is not a same-UID sandbox.
 */
function processRunner(executable: string): MergeGitRunner {
  return (args, options) => new Promise((resolveResult, reject) => {
    if (process.platform === 'win32' || options.signal.aborted) { reject(new Error('Merge object inspection cancelled or unsupported')); return }
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let bytes = 0; const chunks: Buffer[] = []; let interrupted = false; let spawnError = false; let closed = false; let code: number | null = null; let done = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (callback: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); if (!done) callback() }, ms); timers.add(timer) }
    const cleanup = () => { done = true; for (const timer of timers) clearTimeout(timer); options.signal.removeEventListener('abort', abort) }
    const gone = () => { if (!child.pid) return spawnError; try { process.kill(-child.pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' } }
    const finish = () => {
      if (done || !closed || !gone()) return false
      cleanup()
      if (interrupted || spawnError || bytes > MAX_OUTPUT) reject(new Error('Merge object inspection failed or interrupted'))
      else resolveResult({ code, stdout: Buffer.concat(chunks) })
      return true
    }
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* final probe is authoritative */ } } }
    let stopping = false
    const stop = () => {
      interrupted = true
      if (stopping || done) return
      stopping = true; kill()
      const probe = () => { if (!finish()) later(probe, 25) }; later(probe, 25)
      later(() => { if (finish()) return; cleanup(); child.stdout.resume(); child.stderr.resume(); reject(writerUnknown(child.pid)) }, 2000)
    }
    const abort = () => stop()
    options.signal.addEventListener('abort', abort, { once: true })
    later(stop, 60_000)
    child.stdout.on('data', (chunk: Buffer) => { if (done) return; bytes += chunk.length; if (bytes <= MAX_OUTPUT) chunks.push(chunk); else stop() })
    child.stderr.on('data', (chunk: Buffer) => { if (done) return; bytes += chunk.length; if (bytes > MAX_OUTPUT) stop() })
    child.once('error', () => { spawnError = true })
    child.once('close', value => { closed = true; code = value; if (!finish()) stop() })
    if (options.signal.aborted) stop()
  })
}

/** Authenticated remote-read-only merge objects. Each invocation creates a private
 * bare repo; no checkout config, hooks, refs, alternate stores, SSH agent or HOME
 * credentials are inherited. fetch imports exact immutable commits without writing
 * FETCH_HEAD or branch refs. merge-tree writes only disposable Git objects.
 * Read time/output/object inventory are bounded; disk quota is an operator duty.
 * API references: git-scm.com/docs/git-merge-tree and git-scm.com/docs/git-fetch.
 */
export function createMergeObjects(options: MergeObjectsOptions) {
  const executable = options.gitExecutable ?? '/usr/bin/git'
  if (!isAbsolute(executable) || !isAbsolute(options.tempRoot)) fail('Merge objects require pinned absolute executable and private temp root')
  const run = options.runGit ?? processRunner(executable)
  let latchedUnknown: ReturnType<typeof writerUnknown> | undefined
  type ObjectOperation<T> = (context: { fetchCommit(sha: string): Promise<MergeCommitEvidence>; call(args: string[]): Promise<Buffer>; checkRefs(scope: ReleaseScope, source: string, target: string): Promise<void> }) => Promise<T>
  async function withObjects<T>(repository: ReleaseRepository, credential: ReleaseCredential, signal: AbortSignal, operation: ObjectOperation<T>): Promise<T> {
    if (activeRoots.has(options.tempRoot)) throw writerUnknown()
    activeRoots.add(options.tempRoot) // synchronous ownership before any filesystem await
    try { return await withOwnedObjects(repository, credential, signal, operation) }
    finally { activeRoots.delete(options.tempRoot) }
  }
  async function withOwnedObjects<T>(repository: ReleaseRepository, credential: ReleaseCredential, signal: AbortSignal, operation: ObjectOperation<T>): Promise<T> {
    if (latchedUnknown) throw latchedUnknown
    await assertNoRetainedMergeProcesses(options.tempRoot)
    signal.throwIfAborted()
    const remote = releaseRemoteUrl(repository)
    if (credential.projectId !== repository.projectId || credential.userId !== repository.expectedUserId || credential.username !== repository.expectedUsername || !/^[\x21-\x7e]{8,4096}$/.test(credential.token) || !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) fail('Merge credential identity/project/expiry mismatch')
    if (!isAbsolute(repository.root) || inside(repository.root, options.tempRoot)) fail('Merge object store must be outside the business repository')
    await mkdir(options.tempRoot, { recursive: true, mode: 0o700 })
    const tempInfo = await lstat(options.tempRoot)
    if (await realpath(options.tempRoot) !== options.tempRoot || !tempInfo.isDirectory() || (tempInfo.mode & 0o077) || (process.getuid && tempInfo.uid !== process.getuid())) fail('Merge temp root must be canonical owner-private')
    const temporary = await mkdtemp(resolve(options.tempRoot, 'merge-objects-'))
    const identity = await lstat(temporary)
    const bare = resolve(temporary, 'repo.git'); const home = resolve(temporary, 'home')
    let processUnknown = false
    await mkdir(home, { mode: 0o700 })
    const protocol = releaseOrigin(repository).protocol.slice(0, -1)
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: protocol, SSH_ASKPASS: '/usr/bin/false' }
    const rawCall = async (args: string[]): Promise<Buffer> => {
      signal.throwIfAborted()
      if (Date.parse(credential.expiresAt) <= Date.now()) fail('Merge credential expired during inspection')
      let result: MergeGitResult
      try { result = await run([...SAFE, ...args], { cwd: temporary, env, signal }) }
      catch (error) {
        const evidence = error as { code?: string; pgid?: number }
        if (evidence.code === 'NIGHTSHIFT_WRITER_UNKNOWN' || evidence.code === 'MERGE_OBJECTS_PROCESS_UNKNOWN') {
          processUnknown = true; latchedUnknown = writerUnknown(evidence.pgid)
          try { await persistUnknown(options.tempRoot, temporary, repository.alias, latchedUnknown.pgid) }
          catch { /* persistence failure never downgrades local writer uncertainty */ }
          throw latchedUnknown
        }
        fail('Merge object command failed or interrupted; diagnostic output withheld')
      }
      const out = buffer(result.stdout)
      if (result.code !== 0 || out.length > MAX_OUTPUT) fail('Merge object command rejected or conflicted; diagnostic output withheld')
      return out
    }
    try {
      await rawCall(['init', '--bare', '--template=', bare])
      const secretPath = resolve(temporary, 'credential.json')
      await writeFile(secretPath, JSON.stringify(credential), { mode: 0o600, flag: 'wx' })
      const askpass = resolve(temporary, 'askpass')
      if (/[\r\n]/.test(process.execPath)) fail('Invalid host helper executable')
      const helper = `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'"'"'`)}' '${resolve(temporary, 'askpass.cjs').replace(/'/g, `'"'"'`)}' "$@"\n`
      const code = `'use strict';const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(${JSON.stringify(secretPath)},'utf8'));if(Date.parse(c.expiresAt)<=Date.now())process.exit(1);const p=process.argv[2]||'';if(p.startsWith('Username'))process.stdout.write(c.username);else if(p.startsWith('Password'))process.stdout.write(c.token);else process.exit(1);\n`
      await writeFile(resolve(temporary, 'askpass.cjs'), code, { mode: 0o600, flag: 'wx' })
      await writeFile(askpass, helper, { mode: 0o700, flag: 'wx' }); await chmod(askpass, 0o700)
      env.GIT_ASKPASS = askpass
      const call = (args: string[]) => rawCall([`--git-dir=${bare}`, ...args])
      const net = ['-c', `protocol.${protocol}.allow=always`]
      async function inventory() {
        let count = 0; let bytes = 0
        async function walk(path: string): Promise<void> {
          for (const name of await readdir(path)) {
            signal.throwIfAborted()
            const entry = resolve(path, name); const info = await lstat(entry)
            if (++count > MAX_OBJECT_FILES || info.isSymbolicLink()) fail('Merge object inventory is unsafe or oversized')
            if (info.isDirectory()) await walk(entry)
            else if (info.isFile() && info.nlink === 1) { bytes += info.size; if (bytes > MAX_OBJECT_BYTES) fail('Merge object byte budget exceeded') }
            else fail('Merge object inventory contains unsupported file type')
          }
        }
        await walk(resolve(bare, 'objects'))
      }
      async function fetchCommit(sha: string): Promise<MergeCommitEvidence> {
        if (!isSha(sha)) fail('An exact immutable commit SHA is required')
        await call([...net, 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance', '--', remote, sha])
        await inventory()
        if ((await call(['cat-file', '-t', sha])).toString().trim() !== 'commit') fail('Requested object is not a commit')
        await call(['fsck', '--strict', '--no-reflogs', '--no-dangling', sha])
        const raw = await call(['cat-file', 'commit', sha])
        if (createHash('sha1').update(Buffer.from(`commit ${raw.length}\0`)).update(raw).digest('hex') !== sha) fail('Remote commit object hash mismatch')
        const headers = raw.toString('utf8').split('\n\n', 1)[0]!.split('\n')
        const trees = headers.filter(line => line.startsWith('tree ')).map(line => line.slice(5))
        const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7))
        if (trees.length !== 1 || !isSha(trees[0]) || !parents.every(isSha) || (await call(['cat-file', '-t', trees[0]])).toString().trim() !== 'tree') fail('Remote commit tree/parent evidence malformed')
        return { treeSha: trees[0], parents }
      }
      async function checkRefs(scope: ReleaseScope, source: string, target: string) {
        const lines = (await call([...net, 'ls-remote', '--refs', remote, `refs/heads/${scope.sourceBranch}`, `refs/heads/${scope.targetBranch}`])).toString('utf8').trim().split('\n').filter(Boolean)
        const refs = new Map<string, string>()
        for (const line of lines) { const match = /^([0-9a-f]{40})\t(refs\/heads\/.+)$/.exec(line); if (!match || refs.has(match[2]!)) fail('Remote merge refs are malformed or duplicated'); refs.set(match[2]!, match[1]!) }
        if (refs.size !== 2 || refs.get(`refs/heads/${scope.sourceBranch}`) !== source || refs.get(`refs/heads/${scope.targetBranch}`) !== target) fail('Remote source/target refs changed during merge planning')
      }
      return await operation({ fetchCommit, call, checkRefs })
    } finally {
      // The unique namespace is verified before removal; retain it if child-group
      // termination is unknown, never delete credentials out from a live helper.
      if (!processUnknown) {
        if (dirname(temporary) !== options.tempRoot || !temporary.startsWith(`${options.tempRoot}${sep}merge-objects-`) || await realpath(temporary) !== temporary || (await lstat(temporary)).ino !== identity.ino) fail('Merge object cleanup ownership changed')
        await rm(temporary, { recursive: true, force: false })
      }
    }
  }
  return {
    async plan(repository: ReleaseRepository, scope: ReleaseScope, request: ReleaseRequest, candidate: CandidateEvidence, snapshot: RemoteSnapshot, credential: ReleaseCredential, signal: AbortSignal): Promise<MergePlan> {
      if (repository.alias !== request.repository || scope.repository !== repository.alias || candidate.repository !== repository.alias || candidate.taskId !== request.taskId || candidate.sha !== request.sha || candidate.baseSha !== scope.baseSha || candidate.sourceBranch !== scope.sourceBranch || !candidate.clean || !candidate.validated || !candidate.commitReceiptId || !candidate.validationReceiptIds.length || candidate.changedProtectedPaths.length || !isSha(candidate.treeSha) || !isSha(request.sha) || !isSha(scope.baseSha) || !isSha(snapshot.targetSha) || snapshot.sourceSha !== request.sha || !validSourceBranch(scope.sourceBranch) || !branch(scope.targetBranch) || scope.sourceBranch === scope.targetBranch || scope.targetBranch !== repository.targetBranch || snapshot.identity.id !== credential.userId || snapshot.identity.username !== credential.username || snapshot.project.id !== repository.projectId || snapshot.project.path !== repository.projectPath || candidate.ciSha256 !== repository.ciSha256 || snapshot.targetCiSha256 !== repository.ciSha256 || !/^[a-f0-9]{64}$/.test(repository.ciSha256)) fail('Merge planning candidate/scope/identity/CI evidence mismatch')
      return withObjects(repository, credential, signal, async ({ fetchCommit, call, checkRefs }) => {
        const source = request.sha; const target = snapshot.targetSha
        await checkRefs(scope, source, target)
        const sourceCommit = await fetchCommit(source)
        await fetchCommit(target)
        if (scope.baseSha !== source && scope.baseSha !== target) await fetchCommit(scope.baseSha)
        if (sourceCommit.treeSha !== candidate.treeSha) fail('Authenticated remote source tree differs from host commit receipt')
        await call(['merge-base', '--is-ancestor', scope.baseSha, source])
        const tree = (await call(['merge-tree', '--write-tree', '--no-messages', target, source])).toString('utf8').trim()
        if (!isSha(tree) || (await call(['cat-file', '-t', tree])).toString().trim() !== 'tree') fail('Merge-tree output is not one conflict-free tree')
        for (const revision of [source, target, tree]) {
          const ci = await call(['show', '--no-ext-diff', '--no-textconv', `${revision}:.gitlab-ci.yml`])
          if (createHash('sha256').update(ci).digest('hex') !== repository.ciSha256) fail('Merged/source/target CI differs from reviewed configuration')
        }
        // Target-side changes to executable release controls cannot silently enter
        // the merged artifact just because source-side receipts were clean.
        const changed = (await call(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', source, tree, '--'])).toString('utf8').split('\0').filter(Boolean)
        if (changed.some(path => /(^|\/)(?:\.gitlab(?:\/|-ci)|\.github\/|jenkinsfile|dockerfile|\.mvn\/|\.npmrc|\.yarnrc|\.gitmodules|\.gitattributes|\.pi\/|\.env(?:\.|$)|scripts\/|deploy(?:\/|\.)|release(?:\/|\.))/i.test(path))) fail('Target-side merge introduces changed protected release-control paths')
        await checkRefs(scope, source, target)
        return { version: 2, sourceSha: source, targetSha: target, expectedTreeSha: tree, ciSha256: repository.ciSha256, validationProfile: 'full-verify' }
      })
    },
    async readCommit(repository: ReleaseRepository, sha: string, credential: ReleaseCredential, signal: AbortSignal): Promise<MergeCommitEvidence> {
      if (!isSha(sha)) fail('An exact merged commit SHA is required')
      return withObjects(repository, credential, signal, context => context.fetchCommit(sha))
    },
  }
}
