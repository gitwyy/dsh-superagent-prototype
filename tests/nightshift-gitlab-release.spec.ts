import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { deflateSync } from 'node:zlib'
import { createGitlabTransport, releaseMarker } from '../src/nightshift/release/gitlab.ts'
import { createGitPushTransport, readLocalCommitEvidence, readReleaseCredential, releaseOrigin, type GitCommandRunner } from '../src/nightshift/release/git-transport.ts'
import type { DispatchContext, ReleaseRepository, ReleaseRequest, ReleaseScope } from '../src/nightshift/release/contracts.ts'

const exec = promisify(execFile)
const roots: string[] = []
const servers: Server[] = []
const gitObject = (type: string, body: string) => Buffer.concat([Buffer.from(`${type} ${Buffer.byteLength(body)}\0`), Buffer.from(body)])
const objectSha = (value: Buffer) => createHash('sha1').update(value).digest('hex')
const emptyTree = gitObject('tree', '')
const treeSha = objectSha(emptyTree)
const parentObject = gitObject('commit', `tree ${treeSha}\nauthor Fixture <fixture@invalid> 1 +0000\ncommitter Fixture <fixture@invalid> 1 +0000\n\nbase\n`)
const base = objectSha(parentObject)
const candidateObject = gitObject('commit', `tree ${treeSha}\nparent ${base}\nauthor Fixture <fixture@invalid> 2 +0000\ncommitter Fixture <fixture@invalid> 2 +0000\n\ncandidate\n`)
const sha = objectSha(candidateObject)
async function installCommitObjects(repo: string) {
  await exec('/usr/bin/git', ['init', '-q', repo], { env: { PATH: '/usr/bin:/bin', HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  for (const bytes of [emptyTree, parentObject, candidateObject]) {
    const oid = objectSha(bytes); const dir = resolve(repo, '.git/objects', oid.slice(0, 2))
    await mkdir(dir, { recursive: true }); await writeFile(resolve(dir, oid.slice(2)), deflateSync(bytes))
  }
}
const ci = Buffer.from('workflow:\n  rules: []\n')
const ciSha = createHash('sha256').update(ci).digest('hex')
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  for (const root of roots.splice(0)) {
    if (dirname(root) !== await realpath(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-release-test-') || await realpath(root) !== root) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: false })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'nightshift-release-test-'))); roots.push(root)
  const repo = resolve(root, 'repo'); const credentials = resolve(root, 'credential.json'); const tempRoot = resolve(root, 'transport')
  await mkdir(repo); await mkdir(tempRoot, { mode: 0o700 })
  await writeFile(credentials, JSON.stringify({ token: 'fixture-token-never-live', userId: 71, username: 'project_bot', projectId: 451, expiresAt: new Date(Date.now() + 3600_000).toISOString() }), { mode: 0o600 })
  const repository: ReleaseRepository = { alias: 'app', root: repo, projectId: 451, projectPath: 'group/app', host: 'gitlab.invalid', apiOrigin: 'https://gitlab.invalid', credentialFile: credentials, expectedUserId: 71, expectedUsername: 'project_bot', targetBranch: 'master', ciSha256: ciSha, requiredJobs: ['test'], mergeTriggersDeploy: false, triggerPolicy: { reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), productionExcluded: true, fingerprint: 'review-1' }, environments: {} }
  const scope: ReleaseScope = { repository: 'app', sourceBranch: 'sdd/task', targetBranch: 'master', baseSha: base, actions: ['push', 'create_mr', 'merge'] }
  const request: ReleaseRequest = { taskId: 'task-1', repository: 'app', action: 'merge', sha, title: 'Approved fix', description: 'A bounded change.' }
  return { root, repo, tempRoot, credentials, repository, scope, request }
}
function apiStub(f: Awaited<ReturnType<typeof fixture>>) {
  const calls: { method: string; path: string; body?: Record<string, unknown>; token?: string }[] = []
  const state = { source: sha as string | undefined, target: base, ff: true, approvals: true, unresolved: false, foreign: false, duplicate: false, pipelineSha: sha, job: 'success', jobAllowFailure: false, merged: false, mr: true, mutateFailure: false, finalTargetDrift: false, targetReads: 0, description: releaseMarker('task-1', 'app', sha), mergedSha: sha, parents: [base] }
  const mr = () => ({ iid: 9, source_project_id: 451, target_project_id: 451, source_branch: 'sdd/task', target_branch: 'master', author: { id: state.foreign ? 99 : 71 }, sha, state: state.merged ? 'merged' : 'opened', description: state.description, draft: false, has_conflicts: false, detailed_merge_status: 'mergeable', squash: false, squash_on_merge: false, head_pipeline: { id: 21 }, ...(state.merged ? { merge_commit_sha: state.mergedSha } : {}) })
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); const method = init?.method ?? 'GET'
    calls.push({ method, path: url.pathname + url.search, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), token: new Headers(init?.headers).get('PRIVATE-TOKEN') ?? undefined })
    const json = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
    const p = url.pathname
    if (method !== 'GET') {
      if (state.mutateFailure) throw new Error('fixture-token-never-live disconnected')
      if (method === 'PUT' && p.endsWith('/merge_requests/9') && init?.body) state.description = JSON.parse(String(init.body)).description
      return json(method === 'POST' ? { iid: 9 } : mr())
    }
    if (p === '/api/v4/user') return json({ id: 71, username: 'project_bot', state: 'active' })
    if (p === '/api/v4/projects/451') return json({ id: 451, path_with_namespace: 'group/app', default_branch: 'master', archived: false, only_allow_merge_if_pipeline_succeeds: true, merge_method: state.ff ? 'ff' : 'merge', squash_option: 'never' })
    if (p.endsWith('/branches/master')) { state.targetReads++; return json({ name: 'master', protected: true, commit: { id: state.finalTargetDrift && state.targetReads > 1 ? 'c'.repeat(40) : state.target } }) }
    if (p.endsWith('/branches/sdd%2Ftask')) return state.source ? json({ name: 'sdd/task', commit: { id: state.source } }) : json({}, 404)
    if (p.includes('/repository/files/')) return new Response(ci)
    if (p.endsWith('/merge_requests')) return json(state.mr ? (state.duplicate ? [mr(), mr()] : [mr()]) : [], 200, { 'x-next-page': '' })
    if (p.endsWith('/merge_requests/9')) return json(mr())
    if (p.endsWith('/approvals')) return json({ approved: state.approvals, approvals_left: state.approvals ? 0 : 1 })
    if (p.endsWith('/approval_state')) return json({ rules: [{ approvals_required: 1, approved: state.approvals }] })
    if (p.endsWith('/discussions')) return json([{ notes: [{ resolvable: true, resolved: !state.unresolved }] }], 200, { 'x-next-page': '' })
    if (p.endsWith('/pipelines/21')) return json({ id: 21, project_id: 451, sha: state.pipelineSha, source: 'merge_request_event', status: 'success' })
    if (p.endsWith('/jobs')) return json([{ name: 'test', status: state.job, allow_failure: state.jobAllowFailure, pipeline: { id: 21 } }], 200, { 'x-next-page': '' })
    if (p.endsWith('/bridges')) return json([], 200, { 'x-next-page': '' })
    if (p.includes('/repository/commits/')) return json({ id: state.merged ? state.mergedSha : sha, parent_ids: state.parents })
    throw new Error(`Unexpected fixture route ${p}`)
  }
  return { calls, state, fetcher }
}
async function dispatchContext(f: Awaited<ReturnType<typeof fixture>>, transport: ReturnType<typeof createGitlabTransport>): Promise<DispatchContext> {
  const snapshot = await transport.observe(f, new AbortController().signal)
  return { assertAuthorized: () => {}, repository: f.repository, scope: f.scope, request: f.request, snapshot, deadline: new Date(Date.now() + 60_000).toISOString(), operation: { id: 'op-1', logicalKey: 'key', grantId: 'grant-1', taskId: 'task-1', repository: 'app', action: f.request.action, sha, policyDigest: 'policy', state: 'dispatching', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), remoteIds: [], detail: '' }, grant: { id: 'grant-1', taskId: 'task-1', ownerId: 'owner', approvalMessageId: 'message', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), policyDigest: 'policy', scopes: [f.scope] }, candidate: { taskId: 'task-1', repository: 'app', sha, treeSha: 'd'.repeat(40), baseSha: base, sourceBranch: 'sdd/task', clean: true, commitReceiptId: 'receipt-1', validated: true, validationReceiptIds: ['validation-1'], ciSha256: ciSha, changedProtectedPaths: [] } }
}

describe('typed GitLab release transport (local HTTP/stubs only)', () => {
  it('journals ordinary preparation separately and verifies actual remote merge parents/tree without source equality', async () => {
    const f = await fixture(); f.repository.mergeMode = 'merge-commit'; const stub = apiStub(f); stub.state.ff = false; stub.state.target = 'c'.repeat(40)
    const plan = { version: 2 as const, sourceSha: sha, targetSha: stub.state.target, expectedTreeSha: 'd'.repeat(40), ciSha256: ciSha, validationProfile: 'full-verify' as const }
    const objects = { plan: async () => plan, readCommit: async () => ({ treeSha: plan.expectedTreeSha, parents: [plan.targetSha, sha] }) }
    const transport = createGitlabTransport({ tempRoot: f.tempRoot, fetch: stub.fetcher, mergeObjects: objects })
    const ctx = await dispatchContext(f, transport); ctx.request = { ...ctx.request, action: 'prepare_merge' }; ctx.operation = { ...ctx.operation, action: 'prepare_merge', mergePlan: plan }
    expect(await transport.planMerge!({ ...f, candidate: ctx.candidate, snapshot: ctx.snapshot }, new AbortController().signal)).toEqual(plan)
    await transport.dispatch(ctx, new AbortController().signal)
    expect(stub.calls.filter(x => x.method !== 'GET').map(x => x.path)).toEqual(['/api/v4/projects/451/merge_requests/9'])
    const ready = await transport.observe(ctx, new AbortController().signal)
    expect(ready.preparation).toMatchObject({ operationId: 'op-1', plan, verified: true })
    const merge = { ...ctx, request: { ...ctx.request, action: 'merge' as const }, operation: { ...ctx.operation, id: 'merge-1', action: 'merge' as const, preparationId: 'op-1' }, snapshot: ready }
    await transport.dispatch(merge, new AbortController().signal)
    expect(stub.calls.filter(x => x.method !== 'GET').map(x => x.path)).toEqual(['/api/v4/projects/451/merge_requests/9', '/api/v4/projects/451/merge_requests/9/merge'])
    stub.state.merged = true; stub.state.mergedSha = 'e'.repeat(40); stub.state.target = stub.state.mergedSha; stub.state.parents = [plan.targetSha, sha]
    expect((await transport.observe(merge, new AbortController().signal)).mergeRequest).toMatchObject({ sha, mergeCommitSha: stub.state.mergedSha, mergeTreeSha: plan.expectedTreeSha, mergeParents: [plan.targetSha, sha], mergeCommitVerified: true })
    stub.state.parents = ['f'.repeat(40), sha]
    await expect(transport.observe(merge, new AbortController().signal)).rejects.toThrow('parents or tree differ')
  })
  it('does not mint ordinary-merge tickets during createMR and allows target advance for nonmerge writes', async () => {
    const f = await fixture(); f.repository.mergeMode = 'merge-commit'; f.repository.mergeTriggersDeploy = true; f.request.action = 'create_mr'
    const stub = apiStub(f); stub.state.ff = false; stub.state.mr = false; let signed = 0
    const transport = createGitlabTransport({ tempRoot: f.tempRoot, fetch: stub.fetcher, deploymentTickets: { metadata: async () => { signed++; return 'must-not-sign' }, verify: async () => {} } })
    const ctx = await dispatchContext(f, transport); stub.state.target = 'e'.repeat(40)
    await transport.dispatch(ctx, new AbortController().signal)
    expect(signed).toBe(0); expect(stub.calls.filter(x => x.method !== 'GET')).toHaveLength(1)
    expect(String(stub.calls.at(-1)?.body?.description)).not.toContain('superagent-deploy')
  })
  it('pins secret-file identity/mode and denies HTTP by default', async () => {
    const f = await fixture(); expect((await readReleaseCredential(f.repository)).userId).toBe(71)
    f.repository.apiOrigin = 'http://gitlab.invalid'
    expect(() => releaseOrigin(f.repository)).toThrow('Plaintext HTTP')
    f.repository.allowInsecureHttp = true; expect(releaseOrigin(f.repository).protocol).toBe('http:')
    await chmod(f.credentials, 0o644); await expect(readReleaseCredential(f.repository)).rejects.toThrow('0600')
  })
  it('observes exact identity, project, marked MR, CI, pipeline/jobs and approvals', async () => {
    const f = await fixture(); const stub = apiStub(f); const transport = createGitlabTransport({ tempRoot: f.tempRoot, fetch: stub.fetcher })
    const out = await transport.observe(f, new AbortController().signal)
    expect(out).toMatchObject({ identity: { id: 71 }, targetCiSha256: ciSha, project: { fastForwardOnly: true }, mergeRequest: { marker: `nightshift:task-1:app:${sha}`, approved: true, unresolvedDiscussions: 0 }, pipeline: { sha, status: 'success' } })
    expect(stub.calls.every(call => call.method === 'GET' && call.token === 'fixture-token-never-live')).toBe(true)
    expect(JSON.stringify(out)).not.toContain('fixture-token')
  })
  it.each(['foreign', 'duplicate', 'pipeline'])('rejects ambiguous or mismatched %s evidence', async kind => {
    const f = await fixture(); const stub = apiStub(f)
    if (kind === 'foreign') stub.state.foreign = true
    if (kind === 'duplicate') stub.state.duplicate = true
    if (kind === 'pipeline') stub.state.pipelineSha = base
    await expect(createGitlabTransport({ tempRoot: f.tempRoot, fetch: stub.fetcher }).observe(f, new AbortController().signal)).rejects.toThrow()
    expect(stub.calls.every(call => call.method === 'GET')).toBe(true)
  })
  it('performs one FF-only sha-CAS mutation and requires separate exact readback', async () => {
    const f = await fixture(); const stub = apiStub(f); const transport = createGitlabTransport({ tempRoot: f.tempRoot, fetch: stub.fetcher }); const ctx = await dispatchContext(f, transport)
    const out = await transport.dispatch(ctx, new AbortController().signal)
    expect(out.detail).toContain('readback required')
    const mutations = stub.calls.filter(call => call.method !== 'GET'); expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ method: 'PUT', body: { sha, squash: false, should_remove_source_branch: false, merge_when_pipeline_succeeds: false } })
    await installCommitObjects(f.repo)
    stub.state.merged = true; stub.state.target = sha
    expect((await transport.observe(f, new AbortController().signal)).mergeRequest).toMatchObject({ mergeCommitSha: sha, mergeTreeSha: treeSha, mergeParents: [base], mergeCommitVerified: true })
  })
  it('never verifies a merged result without matching local immutable tree/parent evidence', async () => {
    const f = await fixture(); const stub = apiStub(f); stub.state.merged = true; stub.state.target = sha
    const transport = createGitlabTransport({ tempRoot: f.tempRoot, fetch: stub.fetcher })
    await expect(transport.observe(f, new AbortController().signal)).rejects.toThrow()
    await installCommitObjects(f.repo)
    const changedParents: typeof fetch = async (input, init) => String(input).includes('/repository/commits/') ? new Response(JSON.stringify({ id: sha, parent_ids: ['c'.repeat(40)] })) : stub.fetcher(input, init)
    await expect(createGitlabTransport({ tempRoot: f.tempRoot, fetch: changedParents }).observe(f, new AbortController().signal)).rejects.toThrow('parents disagree')
    const env = { PATH: '/usr/bin:/bin', HOME: f.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    await exec('/usr/bin/git', ['-C', f.repo, 'config', 'core.fsmonitor', '/hostile/command'], { env })
    expect(await readLocalCommitEvidence({ tempRoot: f.tempRoot }, f.repository, sha, new AbortController().signal)).toEqual({ treeSha, parents: [base] })
    expect(stub.calls.every(call => call.method === 'GET')).toBe(true)
  })
  it.each(['non-ff', 'unapproved', 'discussion', 'allowed-failure', 'deadline', 'target-race'])('does not merge when %s gate fails', async kind => {
    const f = await fixture(); const stub = apiStub(f); const transport = createGitlabTransport({ tempRoot: f.tempRoot, fetch: stub.fetcher }); const ctx = await dispatchContext(f, transport)
    if (kind === 'non-ff') stub.state.ff = false
    if (kind === 'unapproved') stub.state.approvals = false
    if (kind === 'discussion') stub.state.unresolved = true
    if (kind === 'allowed-failure') stub.state.jobAllowFailure = true
    if (kind === 'deadline') ctx.deadline = new Date(0).toISOString()
    if (kind === 'target-race') { stub.state.targetReads = 0; stub.state.finalTargetDrift = true }
    await expect(transport.dispatch(ctx, new AbortController().signal)).rejects.toThrow()
    expect(stub.calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  })
  it.each(['create_mr', 'merge'] as const)('rechecks live authorization after awaited final reads for %s', async action => {
    const f = await fixture(); f.request.action = action; const stub = apiStub(f)
    if (action === 'create_mr') stub.state.mr = false
    let revoked = false; let armed = false; let mrReads = 0
    const fetcher: typeof fetch = async (input, init) => {
      const response = await stub.fetcher(input, init)
      if (armed && ((action === 'create_mr' && String(input).includes('/merge_requests?')) || (action === 'merge' && String(input).endsWith('/merge_requests/9') && ++mrReads === 2))) {
        await Promise.resolve(); revoked = true
      }
      return response
    }
    const transport = createGitlabTransport({ tempRoot: f.tempRoot, fetch: fetcher })
    const ctx = await dispatchContext(f, transport)
    ctx.assertAuthorized = () => { if (revoked) throw new Error('Host authorization revoked') }
    armed = true
    await expect(transport.dispatch(ctx, new AbortController().signal)).rejects.toThrow('revoked')
    expect(stub.calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  })
  it('creates one stable marked MR, never retries ambiguous transport loss', async () => {
    const f = await fixture(); f.request.action = 'create_mr'; const stub = apiStub(f); stub.state.mr = false
    const transport = createGitlabTransport({ tempRoot: f.tempRoot, fetch: stub.fetcher }); const ctx = await dispatchContext(f, transport)
    stub.state.mutateFailure = true
    await expect(transport.dispatch(ctx, new AbortController().signal)).rejects.toThrow('reconciliation')
    const mutation = stub.calls.filter(call => call.method === 'POST'); expect(mutation).toHaveLength(1)
    expect(mutation[0]?.body?.description).toContain(releaseMarker('task-1', 'app', sha))
    expect(JSON.stringify(mutation[0]?.body)).not.toContain('fixture-token')
  })
  it('never follows HTTP redirects or leaks token in errors (real localhost server)', async () => {
    const f = await fixture(); let calls = 0
    const server = createServer((_req, res) => { calls++; res.writeHead(302, { Location: 'http://127.0.0.1:1/steal' }); res.end() }); servers.push(server)
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address')
    f.repository.apiOrigin = `http://127.0.0.1:${address.port}`; f.repository.host = `127.0.0.1:${address.port}`; f.repository.allowInsecureHttp = true
    const transport = createGitlabTransport({ tempRoot: f.tempRoot })
    await expect(transport.observe(f, new AbortController().signal)).rejects.toThrow('redirect denied'); expect(calls).toBe(1)
  })
  it('inspects all discussion pages and keeps deploy dispatch disabled', async () => {
    const f = await fixture(); const stub = apiStub(f)
    const pages: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/discussions')) return new Response(JSON.stringify([{ notes: [{ resolvable: true, resolved: url.searchParams.get('page') === '1' }] }]), { headers: { 'x-next-page': url.searchParams.get('page') === '1' ? '2' : '' } })
      return stub.fetcher(input, init)
    }
    const transport = createGitlabTransport({ tempRoot: f.tempRoot, fetch: pages })
    expect((await transport.observe(f, new AbortController().signal)).mergeRequest?.unresolvedDiscussions).toBe(1)
    f.request.action = 'deploy'; f.scope.actions.push('deploy')
    const ctx = await dispatchContext(f, transport)
    await expect(transport.dispatch(ctx, new AbortController().signal)).rejects.toThrow('cannot deploy')
    expect(stub.calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  })
  it('aborts a stalled localhost response within the request timeout', async () => {
    const f = await fixture()
    const server = createServer((_req, _res) => {}); servers.push(server)
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address')
    f.repository.apiOrigin = `http://127.0.0.1:${address.port}`; f.repository.host = `127.0.0.1:${address.port}`; f.repository.allowInsecureHttp = true
    await expect(createGitlabTransport({ tempRoot: f.tempRoot, timeoutMs: 30 }).observe(f, new AbortController().signal)).rejects.toThrow('reconciliation')
  })
  it('bounds HTTP bodies and pagination instead of returning partial safe evidence', async () => {
    const f = await fixture()
    const tooLarge: typeof fetch = async () => new Response('x'.repeat(100))
    await expect(createGitlabTransport({ tempRoot: f.tempRoot, fetch: tooLarge, maxBodyBytes: 20 }).observe(f, new AbortController().signal)).rejects.toThrow('bounded body')
    const stub = apiStub(f)
    const badPages: typeof fetch = async (input, init) => String(input).includes('/discussions') ? new Response('[]', { headers: { 'x-next-page': '999' } }) : stub.fetcher(input, init)
    await expect(createGitlabTransport({ tempRoot: f.tempRoot, fetch: badPages }).observe(f, new AbortController().signal)).rejects.toThrow('pagination')
  })
})

describe('isolated exact-SHA Git transport (network commands stubbed)', () => {
  async function localObjects(f: Awaited<ReturnType<typeof fixture>>) {
    const env = { PATH: '/usr/bin:/bin', HOME: f.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = async (args: string[], input?: string) => {
      // Object fixture uses hash-object stdin through a non-shell child; never git commit.
      if (input !== undefined) {
        const { spawn } = await import('node:child_process')
        return new Promise<string>((resolveResult, reject) => { const child = spawn('/usr/bin/git', ['-C', f.repo, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }); let out = ''; child.stdout.on('data', x => { out += x }); child.stderr.resume(); child.on('error', reject); child.on('close', code => code === 0 ? resolveResult(out) : reject(new Error('fixture Git failed'))); child.stdin.end(input) })
      }
      return (await exec('/usr/bin/git', ['-C', f.repo, ...args], { env })).stdout
    }
    await exec('/usr/bin/git', ['init', '-q', f.repo], { env })
    const tree = (await git(['mktree'], '')).trim()
    const commit = (await git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor Fixture <fixture@invalid> 1 +0000\ncommitter Fixture <fixture@invalid> 1 +0000\n\nfixture\n`)).trim()
    // Poison checkout config; transport MUST NOT execute or consult it.
    await git(['config', 'core.hooksPath', '/nonexistent/hostile-hooks']); await git(['config', 'url.ssh://hostile/.insteadOf', 'https://'])
    return { commit, git }
  }
  it('exports objects without checkout config and sends only one nonforce fixed refspec', async () => {
    const f = await fixture(); const { commit } = await localObjects(f)
    const calls: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = []
    let secretRead = false
    const runGit: GitCommandRunner = async (args, options) => {
      calls.push({ args, env: { ...options.env }, cwd: options.cwd })
      if (args.includes('ls-remote') || args.includes('push')) {
        const helper = options.env.GIT_ASKPASS!; expect((await stat(helper)).mode & 0o777).toBe(0o700)
        const helperSource = await readFile(helper, 'utf8'); expect(helperSource).not.toContain('fixture-token')
        const response = await exec(helper, ['Password for approved endpoint'], { env: options.env })
        secretRead = response.stdout === 'fixture-token-never-live'
        return { code: 0, stdout: '' }
      }
      const out = await exec('/usr/bin/git', args, { cwd: options.cwd, env: options.env }); return { code: 0, stdout: out.stdout }
    }
    const credential = await readReleaseCredential(f.repository)
    const out = await createGitPushTransport({ tempRoot: f.tempRoot, runGit })({ repository: f.repository, credential, sha: commit, sourceBranch: 'sdd/task', signal: new AbortController().signal, assertAuthorized: () => {} })
    expect(out.detail).toContain('readback'); expect(secretRead).toBe(true)
    const push = calls.find(call => call.args.includes('push'))!
    expect(push.args.slice(push.args.indexOf('push'))).toEqual(['push', '--porcelain', '--no-verify', '--recurse-submodules=no', '--', 'https://gitlab.invalid/group/app.git', `${commit}:refs/heads/sdd/task`])
    expect(JSON.stringify(calls)).not.toContain('fixture-token'); expect(push.env.SSH_AUTH_SOCK).toBeUndefined(); expect(push.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(calls.every(call => call.cwd !== f.repo)).toBe(true)
  })
  it('rechecks host revocation after object preparation and last ls-remote before push', async () => {
    const f = await fixture(); const { commit } = await localObjects(f); const credential = await readReleaseCredential(f.repository)
    let revoked = false; let pushes = 0
    const runGit: GitCommandRunner = async (args, options) => {
      if (args.includes('ls-remote')) { await Promise.resolve(); revoked = true; return { code: 0, stdout: '' } }
      if (args.includes('push')) { pushes++; return { code: 0, stdout: '' } }
      const out = await exec('/usr/bin/git', args, { cwd: options.cwd, env: options.env }); return { code: 0, stdout: out.stdout }
    }
    await expect(createGitPushTransport({ tempRoot: f.tempRoot, runGit })({ repository: f.repository, credential, sha: commit, sourceBranch: 'sdd/task', signal: new AbortController().signal, assertAuthorized: () => { if (revoked) throw new Error('Host authorization revoked') } })).rejects.toThrow('revoked')
    expect(pushes).toBe(0)
  })
  it('rejects source drift before push and refuses object alternates', async () => {
    const f = await fixture(); const { commit } = await localObjects(f); const credential = await readReleaseCredential(f.repository)
    let pushes = 0
    const runGit: GitCommandRunner = async (args, options) => {
      if (args.includes('ls-remote')) return { code: 0, stdout: `${base}\trefs/heads/sdd/task\n` }
      if (args.includes('push')) pushes++
      const out = await exec('/usr/bin/git', args, { cwd: options.cwd, env: options.env }); return { code: 0, stdout: out.stdout }
    }
    const transport = createGitPushTransport({ tempRoot: f.tempRoot, runGit })
    await expect(transport({ repository: f.repository, credential, sha: commit, sourceBranch: 'sdd/task', signal: new AbortController().signal, assertAuthorized: () => {} })).rejects.toThrow('changed since admission')
    expect(pushes).toBe(0)
    await writeFile(resolve(f.repo, '.git/objects/info/alternates'), '/untrusted/objects\n')
    await expect(transport({ repository: f.repository, credential, sha: commit, sourceBranch: 'sdd/task', signal: new AbortController().signal, assertAuthorized: () => {} })).rejects.toThrow('alternates')
  })
})
