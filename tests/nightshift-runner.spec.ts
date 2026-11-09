import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPiRunner, RpcFramer } from '../src/nightshift/pi-runner.ts'
import { preflight, workerEnvironment } from '../src/nightshift/preflight.ts'
import type { NightConfig, RunRequest, Task } from '../src/nightshift/contracts.ts'

const guardPath = fileURLToPath(new URL('../resources/nightshift-guard.mjs', import.meta.url))
const guardModule: { createGuard: (policy: object) => { execute: (name: string, input: object, signal?: AbortSignal) => Promise<{ content: { text: string }[] }> }; default: (pi: unknown) => void } = await import(guardPath)
const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(() => {
  for (const child of children.splice(0)) { if (child.exitCode === null && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } } }
  for (const root of roots.splice(0)) {
    // Verify exact disposable root before recursive cleanup; never touch a configured business repo.
    if (dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-test-')) throw new Error('Unsafe test cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture(mode = 'success') {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'nightshift-test-'))); roots.push(root)
  const workspace = resolve(root, 'workspace'); const repo = resolve(workspace, 'app'); const home = resolve(root, 'pi-home'); const state = resolve(root, 'state')
  mkdirSync(repo, { recursive: true }); mkdirSync(home); mkdirSync(state)
  const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Disposable Test', GIT_AUTHOR_EMAIL: 'test@invalid', GIT_COMMITTER_NAME: 'Disposable Test', GIT_COMMITTER_EMAIL: 'test@invalid' }, encoding: 'utf8' })
  git(['init', '-q', '-b', 'master']); writeFileSync(resolve(repo, 'hello.txt'), 'hello\n'); git(['add', '.']); git(['commit', '-qm', 'fixture'])
  const executable = resolve(root, 'fake-pi')
  writeFileSync(executable, `#!${process.execPath}\n${fakePi(mode)}`); chmodSync(executable, 0o700)
  const config: NightConfig = { enabled: true, workspace, piHome: home, stateDir: state, sessionFile: resolve(state, 'session.jsonl'), piExecutable: executable, repositories: { app: repo }, provider: 'deepseek', model: 'test-model', maxTaskSeconds: 30, freezeWindows: [] }
  const task: Task = { id: 'task-test', originId: 'origin', ownerId: 'human', text: 'Review this repository', repositories: ['app'], access: 'read', approved: false, target: { source: 'feishu', chatId: 'dm', messageId: 'message' }, state: 'running', createdAt: new Date().toISOString() }
  const request: RunRequest = { runId: 'run-test', config, task, deadline: new Date(Date.now() + 30_000).toISOString() }
  const runner = createPiRunner({ guardPath, probeWriters: async () => [], shutdownGraceMs: 2_000, killGraceMs: 500, startupTimeoutMs: 15_000 })
  return { root, repo, home, state, config, task, request, runner, git }
}
function submoduleFixture() {
  const f = fixture()
  const git = (where: string, args: string[], input?: string) => execFileSync('/usr/bin/git', ['-C', where, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: f.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Disposable Test', GIT_AUTHOR_EMAIL: 'test@invalid', GIT_COMMITTER_NAME: 'Disposable Test', GIT_COMMITTER_EMAIL: 'test@invalid' }, encoding: 'utf8', input,
  })
  // The child's existing fixture commit supplies a real gitlink target, without
  // adding any new commit to either repository during this regression setup.
  const oid = f.git(['rev-parse', 'HEAD']).trim()
  const workspace = f.config.workspace
  git(workspace, ['init', '-q', '-b', 'sdd/root'])
  writeFileSync(resolve(workspace, '.gitmodules'), '[submodule "app"]\n path = app\n url = ./app\n')
  const modules = git(workspace, ['hash-object', '-w', '--stdin'], readFileSync(resolve(workspace, '.gitmodules'), 'utf8')).trim()
  git(workspace, ['update-index', '--add', '--cacheinfo', `100644,${modules},.gitmodules`])
  git(workspace, ['update-index', '--add', '--cacheinfo', `160000,${oid},app`])
  const tree = git(workspace, ['write-tree']).trim()
  // Raw disposable Git object only: no hooks or commit command is involved.
  const commit = git(workspace, ['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor Disposable Test <test@invalid> 1 +0000\ncommitter Disposable Test <test@invalid> 1 +0000\n\nfixture\n`).trim()
  git(workspace, ['update-ref', 'refs/heads/sdd/root', commit])
  git(workspace, ['config', 'submodule.recurse', 'true'])
  const marker = resolve(f.root, 'FILTER_EXECUTED')
  writeFileSync(resolve(f.repo, '.git/info/attributes'), '*.txt filter=local\n')
  f.git(['config', 'filter.local.clean', `/usr/bin/touch '${marker}'; /bin/cat`])
  writeFileSync(resolve(f.repo, 'hello.txt'), 'other\n') // Exactly the size of committed "hello\n".
  utimesSync(resolve(f.repo, 'hello.txt'), new Date(1_000), new Date(1_000))
  f.config.repositories = { workspace }
  return { ...f, marker, workspace, rootGit: (args: string[]) => git(workspace, args) }
}
function fakePi(mode: string) {
  return `
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
const policy = JSON.parse(process.env.NIGHTSHIFT_POLICY);
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
fs.writeFileSync(policy.sessionFile + '.launch', JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
let input = ''; let prompted = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
 input += chunk;
 let index;
 while ((index = input.indexOf('\\n')) >= 0) {
   const record = JSON.parse(input.slice(0, index)); input = input.slice(index + 1);
   if (record.type === 'get_state') {
     if (mode !== 'no-guard') emit({ type:'extension_ui_request', method:'setStatus', statusKey:'nightshift-guard', statusText: policy.runId + ':ready' });
     emit({ id: record.id, type:'response', command:'get_state', success:true, data:{ sessionFile:policy.sessionFile, isStreaming:false, pendingMessageCount:0, model:{ provider:'deepseek', id: mode === 'wrong-model' ? 'wrong' : 'test-model' } } });
   }
   if (record.type === 'prompt') {
     prompted = true;
     if (mode === 'descendant') {
       const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},500)'], {detached:false,stdio:'ignore'});
       child.unref(); fs.writeFileSync(policy.sessionFile + '.descendant', String(child.pid));
     }
     emit({ id: record.id, type:'response', command:'prompt', success:true, data:{ disposition: mode === 'handled' ? 'handled' : 'started' } });
     if (mode === 'ui') { emit({type:'extension_ui_request', id:'dialog', method:'confirm'}); continue; }
     if (mode === 'blocked') { emit({type:'extension_ui_request', method:'setStatus', statusKey:'nightshift-guard', statusText:policy.runId + ':blocked'}); continue; }
     if (mode === 'extension-error') { emit({type:'extension_error'}); continue; }
     if (mode === 'unknown-tool') { emit({type:'tool_execution_end', toolName:'mcp__bypass', isError:true}); continue; }
     if (mode === 'malformed') { process.stdout.write('NOT JSON\\n'); continue; }
     if (mode === 'hang') { setInterval(()=>{},10000); continue; }
     emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Safe\\u2028result'}]}});
     emit({type:'agent_end'});
     if (mode === 'early-end') { setTimeout(()=>emit({type:'agent_settled',aborted:false}),150); continue; }
     if (mode === 'parent-exit') { process.exit(0); }
     emit({type:'agent_settled',aborted:false});
   }
   if (record.type === 'extension_ui_response') fs.writeFileSync(policy.sessionFile + '.ui', JSON.stringify(record));
 }
});
process.stdin.on('end', () => {
 fs.writeFileSync(policy.sessionFile + '.end', String(prompted));
 if (mode !== 'hang') process.exit(mode === 'nonzero' ? 7 : 0);
});
`
}

 describe('RPC framing and environment', () => {
  it('splits only LF, accepts CRLF, bounds malformed/truncated records', () => {
    const parser = new RpcFramer()
    expect(parser.push('{"type":"a","text":"a\u2028b')).toEqual([])
    expect(parser.push('\u2029c"}\r\n')).toEqual([{ type: 'a', text: 'a\u2028b\u2029c' }]); parser.finish()
    expect(() => new RpcFramer().push('[]\n')).toThrow()
    const partial = new RpcFramer(); partial.push('{'); expect(() => partial.finish()).toThrow()
  })
  it('never leaks parent tokens, identity, shell hooks or bot shims', () => {
    const f = fixture()
    const env = workerEnvironment(f.config)
    expect(env.HOME).toBe(f.home)
    expect(Object.keys(env).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY'].sort())
    expect(env.PATH).not.toContain('superagent')
  })
})

describe('supervised fake Pi (never actual Pi)', { timeout: 40_000 }, () => {
  it('uses fixed cwd, explicit persistent session, restricted flags and verified group exit', async () => {
    const f = fixture(); const out = await f.runner.run(f.request, new AbortController().signal)
    expect(out.outcome).toBe('succeeded'); expect(out.writerStopped).toBe(true); expect(out.summary).toBe('Safe\u2028result')
    const launch = JSON.parse(readFileSync(f.config.sessionFile + '.launch', 'utf8'))
    expect(launch.cwd).toBe(f.config.workspace)
    expect(launch.args).toContain('--no-extensions'); expect(launch.args).toContain('--no-mcp')
    expect(launch.args[launch.args.indexOf('--session') + 1]).toBe(f.config.sessionFile)
    expect(existsSync(resolve(f.state, 'pi-runner.lock'))).toBe(false)
  })
  it('does not close stdin at agent_end; waits for settled', async () => {
    const f = fixture('early-end'); const started = Date.now()
    expect((await f.runner.run(f.request, new AbortController().signal)).outcome).toBe('succeeded')
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })
  it.each(['handled', 'wrong-model', 'blocked', 'ui', 'extension-error', 'unknown-tool'])('fails closed for %s', async mode => {
    const f = fixture(mode); const out = await f.runner.run(f.request, new AbortController().signal)
    expect(out.outcome).toBe('blocked'); expect(out.writerStopped).toBe(true)
    if (mode === 'ui') expect(JSON.parse(readFileSync(f.config.sessionFile + '.ui', 'utf8'))).toMatchObject({ cancelled: true, confirmed: false })
  })
  it.each(['malformed', 'parent-exit', 'nonzero'])('does not report success on %s', async mode => {
    const f = fixture(mode); const out = await f.runner.run(f.request, new AbortController().signal)
    expect(out.outcome).toBe('failed'); expect(out.writerStopped).toBe(true)
  })
  it('aborts and verifies group exit before cancellation acknowledgement', async () => {
    const f = fixture('hang'); f.request.deadline = new Date(Date.now() + 800).toISOString()
    const out = await f.runner.run(f.request, new AbortController().signal)
    expect(out.outcome).toBe('cancelled'); expect(out.writerStopped).toBe(true)
  })
  it('retains namespace ownership when parent exited but group state is uncertain', async () => {
    const f = fixture()
    const runner = createPiRunner({ guardPath, probeWriters: async () => [], groupExists: () => true, signalGroup: () => {}, shutdownGraceMs: 10, killGraceMs: 10 })
    const out = await runner.run(f.request, new AbortController().signal)
    expect(out).toMatchObject({ outcome: 'unknown', writerStopped: false })
    expect(existsSync(resolve(f.state, 'pi-runner.lock'))).toBe(true)
    expect((await runner.preflight(f.config, [f.task])).ok).toBe(false)
  })
  it('does not finish on parent exit while a real same-group descendant remains', async () => {
    const f = fixture('descendant')
    const runner = createPiRunner({ guardPath, probeWriters: async () => [], shutdownGraceMs: 650, killGraceMs: 100 })
    const start = Date.now(); const out = await runner.run(f.request, new AbortController().signal)
    expect(Date.now() - start).toBeGreaterThanOrEqual(500)
    expect(out.writerStopped).toBe(true)
    const descendant = Number(readFileSync(f.config.sessionFile + '.descendant', 'utf8'))
    expect(() => process.kill(descendant, 0)).toThrow()
  })
  it('loads only explicit mate-pi skill and prompt directories', async () => {
    const f = fixture(); f.config.harnessRoot = resolve(f.root, 'harness')
    mkdirSync(resolve(f.config.harnessRoot, '.pi/skills'), { recursive: true }); mkdirSync(resolve(f.config.harnessRoot, '.pi/prompts'))
    expect((await f.runner.run(f.request, new AbortController().signal)).outcome).toBe('succeeded')
    const launch = JSON.parse(readFileSync(f.config.sessionFile + '.launch', 'utf8'))
    expect(launch.args[launch.args.indexOf('--skill') + 1]).toBe(resolve(f.config.harnessRoot, '.pi/skills'))
    expect(launch.args[launch.args.indexOf('--prompt-template') + 1]).toBe(resolve(f.config.harnessRoot, '.pi/prompts'))
    const guard = guardModule.createGuard(JSON.parse(launch.env.NIGHTSHIFT_POLICY))
    writeFileSync(resolve(f.config.harnessRoot, '.pi/skills/SKILL.md'), 'useful harness guidance')
    expect((await guard.execute('read', { path: resolve(f.config.harnessRoot, '.pi/skills/SKILL.md') })).content[0]?.text).toContain('guidance')
  })
  it('rejects absent guard readiness without prompting', async () => {
    const f = fixture('no-guard')
    const runner = createPiRunner({ guardPath, probeWriters: async () => [], startupTimeoutMs: 5_000, shutdownGraceMs: 2_000, killGraceMs: 500 })
    expect((await runner.run(f.request, new AbortController().signal)).outcome).toBe('blocked')
    expect(readFileSync(f.config.sessionFile + '.end', 'utf8')).toBe('false')
  })
  it('rejects unapproved write tasks before spawning', async () => {
    const f = fixture(); f.task.access = 'write'
    expect((await f.runner.run(f.request, new AbortController().signal)).outcome).toBe('blocked')
    expect(existsSync(f.config.sessionFile + '.launch')).toBe(false)
  })
})

describe('read-only preflight', () => {
  it('rejects dirty/untracked repos and excluded repository aliases', async () => {
    const f = fixture(); writeFileSync(resolve(f.repo, 'new.txt'), 'dirty')
    expect((await preflight(f.config, [f.task], async () => [])).problems).toContain('Dirty repository: app')
    f.config.repositories = { legacy: f.repo }
    expect((await preflight(f.config, [], async () => [])).ok).toBe(false)
  })
  it('rejects session cwd override and executable credential configuration', async () => {
    const f = fixture(); writeFileSync(f.config.sessionFile, JSON.stringify({ type: 'session', cwd: f.root }) + '\n')
    expect((await preflight(f.config, [], async () => [])).ok).toBe(false)
    writeFileSync(f.config.sessionFile, JSON.stringify({ type: 'session', cwd: f.config.workspace }) + '\n')
    writeFileSync(resolve(f.home, 'auth.json'), JSON.stringify({ deepseek: { type: 'api_key', key: '!dangerous-command' } }))
    expect((await preflight(f.config, [], async () => [])).ok).toBe(false)
  })
  it('rejects legacy oauth credential migration without running its command', async () => {
    const f = fixture(); const marker = resolve(f.root, 'OAUTH_EXECUTED')
    writeFileSync(resolve(f.home, 'oauth.json'), JSON.stringify({ deepseek: { type: 'api_key', key: `!touch '${marker}'` } }))
    const check = await preflight(f.config, [f.task], async () => [])
    expect(check.ok).toBe(false); expect(check.problems.join(' ')).toContain('manual offline migration')
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(f.config.sessionFile + '.launch')).toBe(false)
  })
  it.each(['commands', 'tools', 'old.jsonl'])('rejects startup legacy migration input %s', async name => {
    const f = fixture()
    if (name.endsWith('.jsonl')) writeFileSync(resolve(f.home, name), '{}\n')
    else mkdirSync(resolve(f.home, name))
    expect((await preflight(f.config, [f.task], async () => [])).ok).toBe(false)
  })
  it('does not inspect unregistered submodule worktrees or execute their clean filters', async () => {
    const f = submoduleFixture()
    expect(existsSync(f.marker)).toBe(false)
    expect((await preflight(f.config, [], async () => [])).ok).toBe(true)
    expect(existsSync(f.marker)).toBe(false)
    // An explicitly selected child is inspected independently and rejected BEFORE status.
    f.config.repositories.app = f.repo
    const check = await preflight(f.config, [f.task], async () => [])
    expect(check.ok).toBe(false); expect(check.problems.join(' ')).toContain('Executable Git filter')
    expect(existsSync(f.marker)).toBe(false)
  })
  it('refuses configured package resolution and ambiguous process inspection', async () => {
    const f = fixture(); writeFileSync(resolve(f.home, 'settings.json'), JSON.stringify({ packages: ['npm:side-effects'] }))
    expect((await preflight(f.config, [], async () => [])).ok).toBe(false)
    writeFileSync(resolve(f.home, 'settings.json'), '{}')
    expect((await preflight(f.config, [], async () => ['Unknown writer cwd'])).ok).toBe(false)
  })
})

describe('guarded disposable repository tools', () => {
  const guard = (f: ReturnType<typeof fixture>, approved = false) => guardModule.createGuard({ runId: 'test', workspace: f.config.workspace, repositories: [f.repo], readOnlyRoots: [], piHome: f.home, access: approved ? 'write' : 'read', approved })
  it('allows scoped reading while denying traversal, credentials, symlinks and unknown routes', async () => {
    const f = fixture(); const g = guard(f)
    expect((await g.execute('read', { path: 'app/hello.txt' })).content[0]?.text).toContain('hello')
    writeFileSync(resolve(f.repo, '.env'), 'secret'); symlinkSync(resolve(f.repo, 'hello.txt'), resolve(f.repo, 'link'))
    linkSync(resolve(f.repo, 'hello.txt'), resolve(f.repo, 'hardlink'))
    for (const path of ['../pi-home/auth.json', 'app/.env', 'app/.git/config', 'app/.GIT/config', 'app/link', 'app/hardlink']) await expect(g.execute('read', { path })).rejects.toThrow()
    for (const name of ['subagent', 'mcp__lark__send', 'codemode', 'powershell']) await expect(g.execute(name, {})).rejects.toThrow()
  })
  it('requires scoped approval and a safe branch, allows narrow branch creation without hooks', async () => {
    const f = fixture(); const g = guard(f, true)
    await expect(g.execute('write', { path: 'app/hello.txt', content: 'changed' })).rejects.toThrow('branch')
    await expect(guard(f).execute('bash', { command: `git -C '${f.repo}' switch -c sdd/task` })).rejects.toThrow('approval')
    const hook = resolve(f.repo, '.git/hooks/post-checkout'); writeFileSync(hook, `#!/bin/sh\ntouch '${f.root}/HOOK_RAN'\n`); chmodSync(hook, 0o700)
    await g.execute('bash', { command: `git -C '${f.repo}' switch -c sdd/task` })
    expect(existsSync(resolve(f.root, 'HOOK_RAN'))).toBe(false)
    await g.execute('edit', { path: 'app/hello.txt', oldText: 'hello', newText: 'updated' })
    expect(readFileSync(resolve(f.repo, 'hello.txt'), 'utf8')).toBe('updated\n')
    await expect(g.execute('write', { path: 'app/.git/config', content: 'evil' })).rejects.toThrow()
  })
  it('prevents ancestor repository scope from leaking into registered or hidden nested Git repositories', async () => {
    const f = fixture()
    execFileSync('/usr/bin/git', ['-C', f.config.workspace, 'init', '-q', '-b', 'sdd/root'])
    writeFileSync(resolve(f.config.workspace, '.gitignore'), 'app/\n')
    const rootGuard = guardModule.createGuard({ runId: 'test', workspace: f.config.workspace, repositories: [f.config.workspace], registry: [f.config.workspace, f.repo], piHome: f.home, access: 'write', approved: true })
    await expect(rootGuard.execute('read', { path: 'app/hello.txt' })).rejects.toThrow('scope')
    await expect(rootGuard.execute('write', { path: 'app/new.txt', content: 'no' })).rejects.toThrow('scope')
    const hidden = guardModule.createGuard({ runId: 'test', workspace: f.config.workspace, repositories: [f.config.workspace], piHome: f.home, access: 'write', approved: true })
    await expect(hidden.execute('read', { path: 'app/hello.txt' })).rejects.toThrow('Nested')
    const both = guardModule.createGuard({ runId: 'test', workspace: f.config.workspace, repositories: [f.config.workspace, f.repo], registry: [f.config.workspace, f.repo], piHome: f.home, access: 'write', approved: true })
    expect((await both.execute('read', { path: 'app/hello.txt' })).content[0]?.text).toContain('hello')
    // The ancestor sdd branch must not authorize edits in nested master.
    await expect(both.execute('write', { path: 'app/hello.txt', content: 'no' })).rejects.toThrow('branch')
  })
  it('ignores unregistered gitlink filter effects during status and nonrecursive branch creation', async () => {
    const f = submoduleFixture()
    const g = guardModule.createGuard({ runId: 'test', workspace: f.workspace, repositories: [f.workspace], piHome: f.home, access: 'write', approved: true })
    await g.execute('bash', { command: `git -C '${f.workspace}' status --short` })
    expect(existsSync(f.marker)).toBe(false)
    await g.execute('bash', { command: `git -C '${f.workspace}' switch -c sdd/nonrecursive` })
    expect(f.rootGit(['branch', '--show-current']).trim()).toBe('sdd/nonrecursive')
    expect(f.git(['branch', '--show-current']).trim()).toBe('master')
    expect(existsSync(f.marker)).toBe(false)
    await expect(g.execute('read', { path: 'app/hello.txt' })).rejects.toThrow('gitlinks')
    await expect(g.execute('write', { path: 'app/hello.txt', content: 'no' })).rejects.toThrow('gitlinks')
  })
  it('blocks uninitialized gitlink descendants even without a nested .git marker', async () => {
    const f = submoduleFixture(); const oid = f.git(['rev-parse', 'HEAD']).trim()
    f.rootGit(['update-index', '--add', '--cacheinfo', `160000,${oid},uninitialized`])
    mkdirSync(resolve(f.workspace, 'uninitialized')); writeFileSync(resolve(f.workspace, 'uninitialized/private.txt'), 'not parent-owned')
    const g = guardModule.createGuard({ runId: 'test', workspace: f.workspace, repositories: [f.workspace], piHome: f.home, access: 'write', approved: true })
    await expect(g.execute('read', { path: 'uninitialized/private.txt' })).rejects.toThrow('gitlinks')
    await expect(g.execute('write', { path: 'uninitialized/new.txt', content: 'no' })).rejects.toThrow('gitlinks')
    expect(existsSync(resolve(f.workspace, 'uninitialized/new.txt'))).toBe(false)
    expect(existsSync(f.marker)).toBe(false)
  })
  it('permits an explicitly registered approved child without granting parent-scope access', async () => {
    const f = submoduleFixture()
    const policy = { runId: 'test', workspace: f.workspace, registry: [f.workspace, f.repo], piHome: f.home, access: 'write', approved: true }
    const rootOnly = guardModule.createGuard({ ...policy, repositories: [f.workspace] })
    await expect(rootOnly.execute('read', { path: 'app/hello.txt' })).rejects.toThrow('scope')
    const both = guardModule.createGuard({ ...policy, repositories: [f.workspace, f.repo] })
    expect((await both.execute('read', { path: 'app/hello.txt' })).content[0]?.text).toContain('other')
    await expect(both.execute('bash', { command: `git -C '${f.repo}' status --short` })).rejects.toThrow('filters')
    expect(existsSync(f.marker)).toBe(false)
  })
  it('does not let a directory diff reveal protected credential files', async () => {
    const f = fixture(); writeFileSync(resolve(f.repo, '.env'), 'SECRET=test-fixture-only\n')
    await expect(guard(f).execute('bash', { command: `git -C '${f.repo}' diff -- .` })).rejects.toThrow('regular file')
    await expect(guard(f).execute('bash', { command: `git -C '${f.repo}' diff -- .env` })).rejects.toThrow()
  })
  it('rejects git clean/smudge process configuration before invoking a filter', async () => {
    const f = fixture(); f.git(['config', 'filter.evil.clean', `touch ${f.root}/FILTER_RAN`])
    await expect(guard(f).execute('bash', { command: `git -C '${f.repo}' status --short` })).rejects.toThrow('filters')
    expect((await preflight(f.config, [f.task], async () => [])).ok).toBe(false)
    expect(existsSync(resolve(f.root, 'FILTER_RAN'))).toBe(false)
  })
  it.each(['echo hi', 'lark-cli im send', 'git -C app push', 'git -C app merge master', 'git -C app status --short; echo hi', 'git -C $(pwd) status --short', 'git -C app status --short\nrm -rf /', 'node -e evil', 'git -C app -c alias.x=!evil x', 'git -C app switch -c main'])('rejects shell or network bypass: %s', async command => {
    const f = fixture(); await expect(guard(f, true).execute('bash', { command })).rejects.toThrow()
  })
})
