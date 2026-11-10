/** No live GitLab requests: authenticated network reads are replaced by a local fixture-only transport seam. */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { assertMergeProcessesStopped, createMergeObjects, type MergeGitRunner } from '../src/nightshift/release/merge-objects.ts'
import type { CandidateEvidence, ReleaseRepository, ReleaseRequest, ReleaseScope, RemoteSnapshot } from '../src/nightshift/release/contracts.ts'
import type { ReleaseCredential } from '../src/nightshift/release/git-transport.ts'
const roots: string[] = []
const ci = 'workflow:\n  rules: []\n'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function runGit(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, input?: string): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((done, reject) => {
    const child = spawn('/usr/bin/git', args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume(); child.on('error', reject); child.on('close', code => done({ code, stdout: Buffer.concat(chunks) })); child.stdin.end(input)
  })
}
afterEach(async () => { for (const root of roots.splice(0)) { if (dirname(root) !== await realpath(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-merge-test-') || await realpath(root) !== root) throw new Error('Unsafe fixture cleanup'); await rm(root, { recursive: true, force: false }) } })
async function fixture(mode = 'clean') {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'nightshift-merge-test-'))); roots.push(root)
  const remote = resolve(root, 'remote.git'); const repo = resolve(root, 'business'); const tempRoot = resolve(root, 'private')
  await mkdir(repo); await mkdir(tempRoot, { mode: 0o700 })
  const env = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = async (args: string[], input?: string) => { const result = await runGit(args, { cwd: root, env }, input); if (result.code !== 0) throw new Error('Fixture Git failed'); return result.stdout.toString('utf8').trim() }
  await git(['init', '--bare', '--template=', remote])
  const object = (args: string[], input?: string) => git([`--git-dir=${remote}`, ...args], input)
  const blob = (text: string) => object(['hash-object', '-w', '--stdin'], text)
  async function tree(files: Record<string, string>) {
    const lines = []
    for (const name of Object.keys(files).sort()) lines.push(`100644 blob ${await blob(files[name]!)}\t${name}\n`)
    return object(['mktree'], lines.join(''))
  }
  const makeCommit = (tree: string, parents: string[], label: string) => object(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author Fixture <fixture@invalid> 1 +0000\ncommitter Fixture <fixture@invalid> 1 +0000\n\n${label}\n`)
  const baseTree = await tree({ '.gitlab-ci.yml': ci, 'common.txt': 'base\n' }); const base = await makeCommit(baseTree, [], 'base')
  const sourceFiles = { '.gitlab-ci.yml': ci, 'common.txt': mode === 'conflict' ? 'source change\n' : 'base\n', 'source.txt': 'source\n' }
  const targetFiles: Record<string, string> = { '.gitlab-ci.yml': mode === 'ci-drift' ? 'unreviewed: true\n' : ci, 'common.txt': mode === 'conflict' ? 'target change\n' : 'base\n', 'target.txt': 'target\n' }
  if (mode === 'control-drift') targetFiles.Dockerfile = 'FROM forbidden\n'
  const sourceTree = await tree(sourceFiles); const source = await makeCommit(sourceTree, [base], 'source')
  const targetTree = await tree(targetFiles); const target = await makeCommit(targetTree, [base], 'target')
  await object(['update-ref', 'refs/heads/sdd/task', source]); await object(['update-ref', 'refs/heads/master', target])
  const repository: ReleaseRepository = { alias: 'app', root: repo, projectId: 451, projectPath: 'group/app', host: 'gitlab.invalid', apiOrigin: 'https://gitlab.invalid', expectedUserId: 95, expectedUsername: 'project_bot', credentialFile: resolve(root, 'not-used.json'), targetBranch: 'master', mergeMode: 'merge-commit', ciSha256: digest(ci), requiredJobs: ['full'], mergeTriggersDeploy: true, triggerPolicy: { reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), productionExcluded: true, fingerprint: 'review' }, environments: {} }
  const scope: ReleaseScope = { repository: 'app', sourceBranch: 'sdd/task', targetBranch: 'master', baseSha: base, actions: ['merge', 'deploy'], environment: 'test' }
  const request: ReleaseRequest = { taskId: 'task-1', repository: 'app', action: 'prepare_merge', sha: source }
  const candidate: CandidateEvidence = { taskId: 'task-1', repository: 'app', sha: source, treeSha: sourceTree, baseSha: base, sourceBranch: 'sdd/task', clean: true, commitReceiptId: 'host-receipt', validated: true, validationReceiptIds: ['validation'], ciSha256: digest(ci), changedProtectedPaths: [] }
  const snapshot: RemoteSnapshot = { identity: { id: 95, username: 'project_bot' }, project: { id: 451, path: 'group/app', defaultBranch: 'master', pipelineRequired: true, mergeMethod: 'merge' }, sourceSha: source, targetSha: target, targetCiSha256: digest(ci), productionExcluded: true, triggerPolicyFingerprint: 'review' }
  const credential: ReleaseCredential = { token: 'fixture-only-not-live', userId: 95, username: 'project_bot', projectId: 451, expiresAt: new Date(Date.now() + 3600_000).toISOString() }
  const calls: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = []
  const seam: MergeGitRunner = async (args, options) => {
    calls.push({ args: [...args], env: { ...options.env }, cwd: options.cwd })
    if (args.includes('fetch') || args.includes('ls-remote')) {
      expect(args).toContain('https://gitlab.invalid/group/app.git'); expect(options.env.GIT_ALLOW_PROTOCOL).toBe('https')
      expect(args).toContain('protocol.file.allow=never')
      const helper = await readFile(options.env.GIT_ASKPASS!, 'utf8'); expect(helper).not.toContain(credential.token)
      // Only this test seam replaces the fixed HTTPS remote with a disposable
      // local object store and explicitly permits file protocol for that call.
      const changed = args.map(value => value === 'https://gitlab.invalid/group/app.git' ? remote : value)
      const at = changed.indexOf(args.includes('fetch') ? 'fetch' : 'ls-remote')
      changed.splice(at, 0, '-c', 'protocol.file.allow=always')
      return runGit(changed, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } })
    }
    return runGit(args, options)
  }
  return { root, repo, remote, tempRoot, source, target, base, sourceTree, repository, scope, request, candidate, snapshot, credential, calls, seam, makeCommit, tree, object }
}

describe('isolated ordinary merge object planning', { timeout: 30_000 }, () => {
  it('plans divergent fresh T/S while scope base remains only source lineage base', async () => {
    const f = await fixture(); const planner = createMergeObjects({ tempRoot: f.tempRoot, runGit: f.seam })
    const plan = await planner.plan(f.repository, f.scope, f.request, f.candidate, f.snapshot, f.credential, new AbortController().signal)
    const expected = await f.tree({ '.gitlab-ci.yml': ci, 'common.txt': 'base\n', 'source.txt': 'source\n', 'target.txt': 'target\n' })
    expect(f.base).not.toBe(f.target)
    expect(plan).toEqual({ version: 2, sourceSha: f.source, targetSha: f.target, expectedTreeSha: expected, ciSha256: digest(ci), validationProfile: 'full-verify' })
    expect(f.calls.some(call => call.args.includes('merge-tree') && call.args.slice(-2).join(' ') === `${f.target} ${f.source}`)).toBe(true)
    expect(f.calls.every(call => call.cwd !== f.repo && !call.args.includes('checkout') && !call.args.includes('push') && !call.args.includes('update-ref'))).toBe(true)
    expect(JSON.stringify(f.calls)).not.toContain(f.credential.token)
    expect(await readdir(f.repo)).toEqual([]); expect(await readdir(f.tempRoot)).toEqual([])
  })
  it.each(['conflict', 'ci-drift', 'control-drift'])('fails closed for %s without remote writes or source changes', async mode => {
    const f = await fixture(mode)
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: f.seam }).plan(f.repository, f.scope, f.request, f.candidate, f.snapshot, f.credential, new AbortController().signal)).rejects.toThrow()
    expect(f.calls.some(call => call.args.includes('push'))).toBe(false); expect(await readdir(f.repo)).toEqual([])
  })
  it('keeps fetch refs/FETCH_HEAD absent and ignores all business repository configuration', async () => {
    const f = await fixture()
    await mkdir(resolve(f.repo, '.git'))
    const poison = '[include]\n path=/hostile/config\n[core]\n sshCommand=touch /must-not-execute\n'
    await writeFile(resolve(f.repo, '.git/config'), poison)
    const seam: MergeGitRunner = async (args, options) => {
      expect(options.env.SSH_AUTH_SOCK).toBeUndefined(); expect(options.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
      expect(JSON.stringify(options.env)).not.toContain(f.credential.token)
      if (args.includes('merge-tree')) {
        const bare = args.find(arg => arg.startsWith('--git-dir='))!.slice('--git-dir='.length)
        await expect(readFile(resolve(bare, 'FETCH_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readdir(resolve(bare, 'refs/heads'))).toEqual([])
        expect(await readdir(resolve(bare, 'refs/tags'))).toEqual([])
      }
      return f.seam(args, options)
    }
    expect((await createMergeObjects({ tempRoot: f.tempRoot, runGit: seam }).plan(f.repository, f.scope, f.request, f.candidate, f.snapshot, f.credential, new AbortController().signal)).targetSha).toBe(f.target)
    expect(await readFile(resolve(f.repo, '.git/config'), 'utf8')).toBe(poison)
    expect(await f.object(['rev-parse', 'refs/heads/master'])).toBe(f.target)
  })
  it('refuses a claimed base outside source ancestry while permitting divergent legitimate target', async () => {
    const f = await fixture(); f.scope.baseSha = f.target; f.candidate.baseSha = f.target
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: f.seam }).plan(f.repository, f.scope, f.request, f.candidate, f.snapshot, f.credential, new AbortController().signal)).rejects.toThrow('rejected')
    expect(f.calls.some(call => call.args.includes('merge-tree'))).toBe(false)
  })
  it('verifies authenticated source tree against the host receipt before merging', async () => {
    const f = await fixture(); f.candidate.treeSha = 'c'.repeat(40)
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: f.seam }).plan(f.repository, f.scope, f.request, f.candidate, f.snapshot, f.credential, new AbortController().signal)).rejects.toThrow('source tree')
    expect(f.calls.some(call => call.args.includes('merge-tree'))).toBe(false)
  })
  it('rejects target drift after merge planning rather than returning a stale plan', async () => {
    const f = await fixture(); let checks = 0
    const seam: MergeGitRunner = async (args, options) => {
      if (args.includes('ls-remote') && ++checks === 2) return { code: 0, stdout: `${f.source}\trefs/heads/sdd/task\n${f.base}\trefs/heads/master\n` }
      return f.seam(args, options)
    }
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: seam }).plan(f.repository, f.scope, f.request, f.candidate, f.snapshot, f.credential, new AbortController().signal)).rejects.toThrow('refs changed')
    expect(checks).toBe(2)
  })
  it('reads actual remote merge commit absent from business checkout and preserves parent ordering', async () => {
    const f = await fixture(); const mergedTree = await f.tree({ '.gitlab-ci.yml': ci, 'common.txt': 'base\n', 'source.txt': 'source\n', 'target.txt': 'target\n' })
    const merged = await f.makeCommit(mergedTree, [f.target, f.source], 'server merged')
    await f.object(['update-ref', 'refs/heads/master', merged])
    const evidence = await createMergeObjects({ tempRoot: f.tempRoot, runGit: f.seam }).readCommit(f.repository, merged, f.credential, new AbortController().signal)
    expect(evidence).toEqual({ treeSha: mergedTree, parents: [f.target, f.source] }); expect(await readdir(f.repo)).toEqual([])
    expect(f.calls.filter(call => call.args.includes('fetch'))).toHaveLength(1)
    expect(f.calls.find(call => call.args.includes('fetch'))!.args).toContain('--no-write-fetch-head')
  })
  it('checks raw commit SHA instead of trusting cat-file text from a seam or damaged object', async () => {
    const f = await fixture()
    const seam: MergeGitRunner = async (args, options) => {
      if (args.includes('cat-file') && args.includes('commit')) return { code: 0, stdout: `tree ${f.sourceTree}\n\nforged\n` }
      return f.seam(args, options)
    }
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: seam }).readCommit(f.repository, f.source, f.credential, new AbortController().signal)).rejects.toThrow('hash mismatch')
  })
  it('rejects wrong/expired credential, unsafe HTTP and revoked request without secret diagnostics', async () => {
    const f = await fixture(); const planner = createMergeObjects({ tempRoot: f.tempRoot, runGit: f.seam })
    await expect(planner.readCommit(f.repository, f.source, { ...f.credential, projectId: 999 }, new AbortController().signal)).rejects.toThrow('identity')
    await expect(planner.readCommit(f.repository, f.source, { ...f.credential, expiresAt: new Date(0).toISOString() }, new AbortController().signal)).rejects.toThrow('expiry')
    f.repository.apiOrigin = 'http://gitlab.invalid'
    await expect(planner.readCommit(f.repository, f.source, f.credential, new AbortController().signal)).rejects.toThrow('Plaintext')
    const abort = new AbortController(); abort.abort()
    await expect(planner.readCommit(f.repository, f.source, f.credential, abort.signal)).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })
  it('preserves typed process uncertainty and durable marker across retries and reopened planners', async () => {
    const f = await fixture(); let commands = 0
    const seam: MergeGitRunner = async (args, options) => {
      commands++
      if (args.includes('fetch')) throw Object.assign(new Error(f.credential.token), { code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false, pgid: 1234567 })
      return f.seam(args, options)
    }
    const planner = createMergeObjects({ tempRoot: f.tempRoot, runGit: seam })
    await expect(planner.readCommit(f.repository, f.source, f.credential, new AbortController().signal)).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false, pgid: 1234567 })
    const marker = await readFile(resolve(f.tempRoot, 'merge-process-unknown.json'), 'utf8')
    expect(marker).not.toContain(f.credential.token)
    const record = JSON.parse(marker); expect(record).toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false, pgid: 1234567, repository: 'app' })
    expect((await readdir(f.tempRoot)).some(name => name.startsWith('merge-objects-'))).toBe(true)
    const count = commands
    await expect(planner.readCommit(f.repository, f.source, f.credential, new AbortController().signal)).rejects.toMatchObject({ writerStopped: false })
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: seam }).readCommit(f.repository, f.source, f.credential, new AbortController().signal)).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', pgid: 1234567 })
    await expect(assertMergeProcessesStopped(f.tempRoot)).rejects.toMatchObject({ writerStopped: false, pgid: 1234567 })
    expect(commands).toBe(count); expect(await readFile(resolve(f.tempRoot, 'merge-process-unknown.json'), 'utf8')).toBe(marker)
  })
  it('fails closed after a host crash leaves only an operation directory and no marker', async () => {
    const f = await fixture(); const retained = resolve(f.tempRoot, 'merge-objects-crashed-before-marker')
    await mkdir(retained, { mode: 0o700 }); await writeFile(resolve(retained, 'private-evidence'), 'preserve')
    let commands = 0
    const seam: MergeGitRunner = async () => { commands++; return { code: 0, stdout: '' } }
    await expect(assertMergeProcessesStopped(f.tempRoot)).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false })
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: seam }).readCommit(f.repository, f.source, f.credential, new AbortController().signal)).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false })
    expect(commands).toBe(0); expect(await readFile(resolve(retained, 'private-evidence'), 'utf8')).toBe('preserve')
  })
  it('serializes ownership across factory instances and never calls an active root stopped', async () => {
    const f = await fixture(); let entered!: () => void; let resume!: () => void
    const started = new Promise<void>(done => { entered = done })
    const seam: MergeGitRunner = async (args, options) => {
      if (args.includes('fetch')) { entered(); await new Promise<void>(done => { resume = done }) }
      return f.seam(args, options)
    }
    const active = createMergeObjects({ tempRoot: f.tempRoot, runGit: seam }).readCommit(f.repository, f.source, f.credential, new AbortController().signal)
    await started
    await expect(assertMergeProcessesStopped(f.tempRoot)).rejects.toMatchObject({ writerStopped: false })
    let secondSpawned = false
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: async () => { secondSpawned = true; return { code: 0, stdout: '' } } }).readCommit(f.repository, f.source, f.credential, new AbortController().signal)).rejects.toMatchObject({ writerStopped: false })
    expect(secondSpawned).toBe(false); resume(); await active
    await assertMergeProcessesStopped(f.tempRoot)
    expect(await readdir(f.tempRoot)).toEqual([])
  })
  it('fails closed on malformed recovery evidence without spawning or clearing it', async () => {
    const f = await fixture(); await writeFile(resolve(f.tempRoot, 'merge-process-unknown.json'), '{incomplete', { mode: 0o600 })
    let spawned = false
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: async () => { spawned = true; return { code: 0, stdout: '' } } }).readCommit(f.repository, f.source, f.credential, new AbortController().signal)).rejects.toMatchObject({ code: 'NIGHTSHIFT_WRITER_UNKNOWN', writerStopped: false })
    expect(spawned).toBe(false); expect(await readFile(resolve(f.tempRoot, 'merge-process-unknown.json'), 'utf8')).toBe('{incomplete')
  })
  it('redacts thrown process/transport error output and refuses missing object evidence', async () => {
    const f = await fixture()
    const seam: MergeGitRunner = async (args, options) => { if (args.includes('fetch')) throw new Error(f.credential.token); return f.seam(args, options) }
    let error: unknown
    try { await createMergeObjects({ tempRoot: f.tempRoot, runGit: seam }).readCommit(f.repository, f.source, f.credential, new AbortController().signal) } catch (value) { error = value }
    expect(String(error)).not.toContain(f.credential.token); expect(String(error)).toContain('diagnostic output withheld')
    await expect(createMergeObjects({ tempRoot: f.tempRoot, runGit: f.seam }).readCommit(f.repository, 'f'.repeat(40), f.credential, new AbortController().signal)).rejects.toThrow()
  })
})
