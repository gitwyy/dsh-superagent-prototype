import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { RepositoryActions } from '../src/nightshift/contracts.ts'

const actionsPath = fileURLToPath(new URL('../resources/nightshift-actions.mjs', import.meta.url))
const guardPath = fileURLToPath(new URL('../resources/nightshift-guard.mjs', import.meta.url))
const { createActions, runProcess } = await import(actionsPath)
const { createGuard } = await import(guardPath)
const roots: string[] = []
const processGroups: number[] = []
afterEach(() => {
  for (const pgid of processGroups.splice(0)) { try { process.kill(-pgid, 'SIGKILL') } catch { /* disposable group already gone */ } }
  for (const root of roots.splice(0)) {
    if (dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-actions-test-')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
function fixture(script = 'process.exit(0)') {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'nightshift-actions-test-'))); roots.push(root)
  const workspace = resolve(root, 'workspace'); const repo = resolve(workspace, 'app'); const home = resolve(root, 'home'); const stateDir = resolve(root, 'state')
  mkdirSync(repo, { recursive: true }); mkdirSync(home); mkdirSync(stateDir)
  const env = { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (args: string[], input?: string) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })
  git(['init', '-q', '-b', 'sdd/task'])
  writeFileSync(resolve(repo, 'source.txt'), 'original\n'); writeFileSync(resolve(repo, 'validate.cjs'), script); writeFileSync(resolve(repo, '.gitignore'), 'dist/\n')
  git(['add', '--', 'source.txt', 'validate.cjs', '.gitignore'])
  const tree = git(['write-tree']).trim()
  const head = git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor Fixture <fixture@invalid> 1 +0000\ncommitter Fixture <fixture@invalid> 1 +0000\n\nfixture baseline\n`).trim()
  git(['update-ref', 'refs/heads/sdd/task', head]) // Raw fixture object, never git commit.
  const executable = realpathSync(process.execPath)
  const config: RepositoryActions = { validations: { check: { executable, executableSha256: sha(readFileSync(executable)), args: ['validate.cjs'], timeoutSeconds: 5, pinnedFiles: { 'validate.cjs': sha(script) } } }, requiredValidations: ['check'], author: { name: 'Approved Author', email: 'approved@invalid' }, targetBranch: 'master' }
  const policy = { runId: 'run-test', taskId: 'task-test', workspace, approved: true, access: 'write', actions: ['validate', 'commit', 'publish'], actionApprovalId: 'approval-message', repositoryMap: { app: repo }, repositoryActions: { app: config }, baseline: { app: { head, branch: 'sdd/task' } }, stateDir, piHome: home }
  const guard = createGuard({ runId: policy.runId, workspace, repositories: [repo], piHome: home, access: 'write', approved: true })
  return { root, workspace, repo, home, stateDir, git, head, config, policy, guard }
}
function fakeClose(code = 0) {
  // The commit effect is simulated, but process lifetime is real and independently
  // grouped; pid-less event emitters cannot prove that a writer has stopped.
  return spawn(process.execPath, ['-e', `process.exit(${code})`], { detached: true, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('host-owned action process groups', { timeout: 10_000 }, () => {
  const processOptions = (signal?: AbortSignal, timeoutMs = 3000) => ({ cwd: realpathSync(tmpdir()), env: { PATH: '/usr/bin:/bin' }, signal, timeoutMs, capture: true })
  it('does not complete at parent exit while a same-group grandchild remains', async () => {
    let pgid = 0
    const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore',detached:false});c.unref();process.stdout.write(String(c.pid));`
    const result = await runProcess(process.execPath, ['-e', script], processOptions(), (executable: string, args: string[], options: SpawnOptions) => {
      expect(options.detached).toBe(true); const child = spawn(executable, args, options); pgid = child.pid!; processGroups.push(pgid); return child
    })
    expect(result.writerStopped).toBe(true)
    expect(result.spawnError).toBe(true) // lingering-child cleanup must never produce a passing validation
    expect(() => process.kill(-pgid, 0)).toThrow()
    expect(() => process.kill(Number(result.stdout), 0)).toThrow()
  })
  it('kills the owned group on abort and preserves host liveness', async () => {
    const abort = new AbortController(); let pgid = 0
    const promise = runProcess(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},30000)'], processOptions(abort.signal), (executable: string, args: string[], options: SpawnOptions) => {
      const child = spawn(executable, args, options); pgid = child.pid!; processGroups.push(pgid)
      child.stdout!.once('data', () => abort.abort()); return child
    })
    const result = await promise
    expect(result).toMatchObject({ aborted: true, writerStopped: true })
    expect(() => process.kill(-pgid, 0)).toThrow(); expect(() => process.kill(process.pid, 0)).not.toThrow()
  })
  it('rejects unproven group exit after a hard cap, swallowing signal errors only', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 1234567, stdout: new PassThrough(), stderr: new PassThrough() })
    const promise = runProcess('/fixture', [], processOptions(undefined, 20), () => { queueMicrotask(() => child.emit('close', 0)); return child }, { groupExists: () => true, signalGroup: () => { throw new Error('simulated EPERM') }, graceMs: 5, finalWaitMs: 20 })
    await expect(promise).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false, pgid: 1234567 })
  })
  it('rejects a pid-less fake close rather than claiming writerStopped', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    await expect(runProcess('/fixture', [], processOptions(undefined, 20), () => { queueMicrotask(() => child.emit('close', 0)); return child }, { graceMs: 5, finalWaitMs: 20 })).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false })
  })
  it('accepts an explicit fake process-group proof seam and reports actual spawn errors safely', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 1234567, stdout: new PassThrough(), stderr: new PassThrough() })
    expect(await runProcess('/fixture', [], processOptions(), () => { queueMicrotask(() => child.emit('close', 0)); return child }, { groupExists: () => false })).toMatchObject({ code: 0, writerStopped: true })
    expect(await runProcess('/definitely/not/a/real/executable', [], processOptions())).toMatchObject({ spawnError: true, writerStopped: true })
  })
})

describe('explicit scoped action broker', { timeout: 30_000 }, () => {
  it('defaults to no actions and never accepts model executable/argv/env', async () => {
    const f = fixture(); f.policy.actions = []
    const broker = createActions(f.policy, f.guard)
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).outcome).toBe('blocked')
    f.policy.actions = ['validate']
    const allowed = createActions(f.policy, f.guard)
    expect((await allowed.execute({ action: 'validate', repository: 'app', recipe: 'check', executable: '/bin/sh' })).outcome).toBe('blocked')
    expect((await allowed.execute({ action: 'validate', repository: 'other', recipe: 'check' })).outcome).toBe('blocked')
  })
  it('requires a separate action approval identity and clean baseline', async () => {
    const f = fixture(); f.policy.actionApprovalId = ''
    expect((await createActions(f.policy, f.guard).execute({ action: 'validate', repository: 'app', recipe: 'check' })).outcome).toBe('blocked')
    f.policy.actionApprovalId = 'approval-message'; writeFileSync(resolve(f.repo, 'source.txt'), 'dirty')
    expect((await createActions(f.policy, f.guard).execute({ action: 'validate', repository: 'app', recipe: 'check' })).summary).toContain('clean baseline')
  })
  it('runs a pinned fake recipe with minimal environment and durable metadata only', async () => {
    const script = `const fs=require('node:fs'); if(process.env.HOME.includes('pi-home') || process.env.DSH_SECRET || process.env.GL_TOKEN || process.env.NODE_OPTIONS) process.exit(9); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/env.json',JSON.stringify(process.env)); console.error('SECRET_OUTPUT_SHOULD_NOT_LEAK');`
    const f = fixture(script); const calls: { executable: string; args: string[]; options: SpawnOptions }[] = []
    const broker = createActions(f.policy, f.guard, { spawnProcess(executable: string, args: string[], options: SpawnOptions) { calls.push({ executable, args, options }); return spawn(executable, args, options) } })
    writeFileSync(resolve(f.repo, 'source.txt'), 'approved change\n')
    const out = await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })
    expect(out).toMatchObject({ outcome: 'succeeded', passed: true, exitCode: 0 })
    expect(calls).toHaveLength(1); expect(calls[0]?.options).toMatchObject({ cwd: f.repo, shell: false, detached: true })
    const env = JSON.parse(readFileSync(resolve(f.repo, 'dist/env.json'), 'utf8'))
    expect(env.HOME).toBe(resolve(f.stateDir, 'action-home'))
    expect(env.GIT_AUTHOR_NAME).toBeUndefined(); expect(env.GL_TOKEN).toBeUndefined()
    const audit = readFileSync(resolve(f.stateDir, 'actions-run-test.jsonl'), 'utf8')
    expect(audit).toContain('approval-message'); expect(audit).not.toContain('SECRET_OUTPUT_SHOULD_NOT_LEAK')
    expect(JSON.stringify(out)).not.toContain('SECRET_OUTPUT_SHOULD_NOT_LEAK')
  })
  it('returns nonzero validation as failure data, never a passing receipt', async () => {
    const f = fixture('console.error("secret");process.exit(3)'); const broker = createActions(f.policy, f.guard)
    writeFileSync(resolve(f.repo, 'source.txt'), 'modified\n')
    const out = await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })
    expect(out).toMatchObject({ outcome: 'failed', passed: false, exitCode: 3 }); expect(out.summary).toContain('exit code 3')
    expect((await broker.execute({ action: 'commit', repository: 'app', message: 'fix' })).summary).toContain('validation')
  })
  it('rejects recipe and executable pin drift before invoking a process', async () => {
    const f = fixture(); const broker = createActions(f.policy, f.guard, { spawnProcess() { throw new Error('Must not execute') } })
    writeFileSync(resolve(f.repo, 'validate.cjs'), 'process.exit(1)')
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).summary).toContain('pin mismatch')
    writeFileSync(resolve(f.repo, 'validate.cjs'), 'process.exit(0)'); f.config.validations.check!.executableSha256 = '0'.repeat(64)
    expect((await createActions(f.policy, f.guard).execute({ action: 'validate', repository: 'app', recipe: 'check' })).summary).toContain('executable SHA256')
  })
  it('rejects token/loader/PATH overrides in recipe environment', async () => {
    const f = fixture(); f.config.validations.check!.env = { NODE_OPTIONS: '--require evil' }
    expect((await createActions(f.policy, f.guard).execute({ action: 'validate', repository: 'app', recipe: 'check' })).summary).toContain('environment')
  })
  it('fails validation that changes source and invalidates stale receipts', async () => {
    const f = fixture("require('node:fs').writeFileSync('source.txt','modified by validator')")
    const broker = createActions(f.policy, f.guard)
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).outcome).toBe('failed')
    expect((await broker.execute({ action: 'commit', repository: 'app', message: 'fix' })).outcome).toBe('blocked')
  })
  it('propagates unverified writer shutdown instead of downgrading it to blocked validation', async () => {
    const f = fixture()
    const broker = createActions(f.policy, f.guard, { spawnProcess() {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => child.emit('close', 0)); return child
    } })
    await expect(broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false })
  })
  it('bounds validation timeout and waits for close', async () => {
    const f = fixture('setInterval(()=>{},10000)'); f.config.validations.check!.timeoutSeconds = 0.1
    const out = await createActions(f.policy, f.guard).execute({ action: 'validate', repository: 'app', recipe: 'check' })
    expect(out).toMatchObject({ outcome: 'failed', passed: false }); expect(out.summary).toContain('timeout')
  })
  it('caps secret-bearing output and reports cancellation only after child close', async () => {
    const f = fixture("process.stdout.write('x'.repeat(9*1024*1024));setInterval(()=>{},10000)")
    const out = await createActions(f.policy, f.guard).execute({ action: 'validate', repository: 'app', recipe: 'check' })
    expect(out).toMatchObject({ outcome: 'failed', passed: false }); expect(out.summary).toContain('output limit')
    const other = fixture('setInterval(()=>{},10000)'); const controller = new AbortController()
    const broker = createActions(other.policy, other.guard, { spawnProcess(executable: string, args: string[], options: SpawnOptions) { const child = spawn(executable, args, options); setImmediate(() => controller.abort()); return child } })
    const cancelled = await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' }, controller.signal)
    expect(cancelled).toMatchObject({ outcome: 'failed', passed: false }); expect(cancelled.summary).toContain('cancelled')
  })
  it('rejects merge-state continuation and empty repository action configuration', async () => {
    const f = fixture(); const broker = createActions(f.policy, f.guard)
    writeFileSync(resolve(f.repo, '.git/MERGE_HEAD'), `${f.head}\n`)
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).summary).toContain('merge/rebase')
    const other = fixture(); other.policy.repositoryActions = {} as typeof other.policy.repositoryActions
    expect((await createActions(other.policy, other.guard).execute({ action: 'validate', repository: 'app', recipe: 'check' })).outcome).toBe('blocked')
  })
  it('rejects unsafe untracked files and symlinks rather than silently excluding them', async () => {
    const f = fixture(); const broker = createActions(f.policy, f.guard)
    writeFileSync(resolve(f.repo, '.env'), 'DO_NOT_PUBLISH')
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).outcome).toBe('blocked')
    // A separate fixture avoids deleting a protected path just for this check.
    const other = fixture(); const otherBroker = createActions(other.policy, other.guard)
    symlinkSync(resolve(other.repo, 'source.txt'), resolve(other.repo, 'alias.txt'))
    expect((await otherBroker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).outcome).toBe('blocked')
  })
  it('rejects preexisting staged changes, dirty baseline and protected branches', async () => {
    const f = fixture(); const broker = createActions(f.policy, f.guard)
    writeFileSync(resolve(f.repo, 'source.txt'), 'staged'); f.git(['add', '--', 'source.txt'])
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).summary).toContain('staged')
    const other = fixture(); const otherBroker = createActions(other.policy, other.guard)
    other.git(['symbolic-ref', 'HEAD', 'refs/heads/master']); other.git(['update-ref', 'refs/heads/master', other.head])
    expect((await otherBroker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).summary).toContain('protected')
  })
  it('enumerates approved paths and pins commit identity without executing git commit', async () => {
    const f = fixture(); const calls: { executable: string; args: string[]; options: SpawnOptions }[] = []
    const broker = createActions(f.policy, f.guard, { spawnProcess(executable: string, args: string[], options: SpawnOptions) {
      calls.push({ executable, args, options })
      if (executable === '/usr/bin/git' && args.includes('commit')) {
        // Simulate the commit boundary via raw fixture object/ref writes; never run git commit.
        const tree = f.git(['write-tree']).trim()
        const next = f.git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nparent ${f.head}\nauthor Approved Author <approved@invalid> 2 +0000\ncommitter Approved Author <approved@invalid> 2 +0000\n\nfixture action\n`).trim()
        f.git(['update-ref', 'refs/heads/sdd/task', next, f.head])
        return fakeClose()
      }
      return spawn(executable, args, options)
    } })
    writeFileSync(resolve(f.repo, 'source.txt'), 'approved\n'); writeFileSync(resolve(f.repo, '-literal.txt'), 'literal filename')
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).passed).toBe(true)
    const out = await broker.execute({ action: 'commit', repository: 'app', message: 'fix approved changes' })
    expect(out.outcome).toBe('succeeded'); expect(out.head).not.toBe(f.head)
    const add = calls.find(call => call.args.includes('add'))!
    expect(add.args.slice(add.args.indexOf('add'))).toEqual(['add', '--', '-literal.txt', 'source.txt'])
    expect(add.args).toContain('--literal-pathspecs'); expect(add.args).not.toContain('-A')
    const commit = calls.find(call => call.args.includes('commit'))!
    expect(commit.options.env).toMatchObject({ GIT_AUTHOR_NAME: 'Approved Author', GIT_COMMITTER_EMAIL: 'approved@invalid' })
    expect(commit.args).toContain('core.hooksPath=/dev/null'); expect(commit.args).toContain('--no-gpg-sign')
  })
  it('executes a real scoped local commit only in a disposable test repository', async () => {
    const f = fixture(); const broker = createActions(f.policy, f.guard)
    writeFileSync(resolve(f.repo, 'source.txt'), 'verified local commit\n')
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).passed).toBe(true)
    const out = await broker.execute({ action: 'commit', repository: 'app', message: 'test: approved disposable fixture change' })
    expect(out.outcome).toBe('succeeded')
    expect(f.git(['status', '--porcelain'])).toBe('')
    expect(f.git(['log', '-1', '--format=%an <%ae>'])).toContain('Approved Author <approved@invalid>')
    expect(f.git(['show', '--format=', '--name-only', 'HEAD']).trim()).toBe('source.txt')
  })
  it('never retries an uncertain commit result or resets the staged index', async () => {
    const f = fixture(); let commitAttempts = 0
    const broker = createActions(f.policy, f.guard, { spawnProcess(executable: string, args: string[], options: SpawnOptions) {
      if (executable === '/usr/bin/git' && args.includes('commit')) { commitAttempts++; return fakeClose(1) }
      expect(args).not.toContain('reset'); expect(args).not.toContain('--amend')
      return spawn(executable, args, options)
    } })
    writeFileSync(resolve(f.repo, 'source.txt'), 'approved\n')
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).passed).toBe(true)
    expect((await broker.execute({ action: 'commit', repository: 'app', message: 'fix' })).outcome).toBe('unknown')
    expect((await broker.execute({ action: 'commit', repository: 'app', message: 'retry' })).summary).toContain('uncertain')
    expect(commitAttempts).toBe(1); expect(f.git(['diff', '--cached', '--name-only'])).toContain('source.txt')
  })
  it('refuses stale validation after another source edit', async () => {
    const f = fixture(); const broker = createActions(f.policy, f.guard)
    writeFileSync(resolve(f.repo, 'source.txt'), 'first'); expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).passed).toBe(true)
    writeFileSync(resolve(f.repo, 'source.txt'), 'second')
    expect((await broker.execute({ action: 'commit', repository: 'app', message: 'fix' })).summary).toContain('stale')
  })
  it('fails publication closed even with an unverified glab path and remote', async () => {
    const f = fixture(); f.config.glabExecutable = '/usr/bin/false'; f.config.remoteUrl = 'https://gitlab.invalid/a/b.git'; f.config.gitlabProject = 'a/b'; f.config.gitlabHost = 'gitlab.invalid'
    const broker = createActions(f.policy, f.guard, { spawnProcess() { throw new Error('Network must never be attempted') } })
    const out = await broker.execute({ action: 'publish', repository: 'app', title: 'test', description: 'test' })
    expect(out.outcome).toBe('blocked'); expect(out.summary).toContain('no network request')
  })
  it('rejects action state inside workspace and prevents audit symlink redirection', async () => {
    const f = fixture(); f.policy.stateDir = resolve(f.repo, 'state')
    expect((await createActions(f.policy, f.guard).execute({ action: 'validate', repository: 'app', recipe: 'check' })).outcome).toBe('unknown')
    const other = fixture(); const broker = createActions(other.policy, other.guard)
    const target = resolve(other.root, 'unowned'); writeFileSync(target, 'unchanged'); symlinkSync(target, resolve(other.stateDir, 'actions-run-test.jsonl'))
    expect((await broker.execute({ action: 'validate', repository: 'app', recipe: 'check' })).outcome).toBe('unknown')
    expect(readFileSync(target, 'utf8')).toBe('unchanged')
  })
})
