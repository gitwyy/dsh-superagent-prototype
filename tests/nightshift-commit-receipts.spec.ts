/** Actual Git-object receipt verification in disposable repositories; never uses business repositories/remotes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CommitReceipts, type CommitReceiptInput } from '../src/nightshift/release/receipts.ts'
import * as preflight from '../src/nightshift/preflight.ts'
import type { NightConfig, Task } from '../src/nightshift/contracts.ts'

const roots: string[] = [], receipts: CommitReceipts[] = []
const DIGEST = 'a'.repeat(64), VALIDATION = 'b'.repeat(64), RECIPE = 'c'.repeat(64)
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-commit-receipts-'))); roots.push(root)
  const repository = join(root, 'repo'), home = join(root, 'home'); mkdirSync(repository); mkdirSync(home)
  const config: NightConfig = { enabled: true, workspace: repository, stateDir: join(root, 'state'), lockRoot: join(root, 'locks'), piExecutable: '/fake/pi', piHome: home, sessionFile: join(home, 'session.jsonl'), repositories: { repo: repository }, maxTaskSeconds: 60, freezeWindows: [] }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', [...preflight.GIT_SAFE_ARGS, '-C', repository, ...args], { encoding: 'utf8', timeout: 5000, env: { ...preflight.workerEnvironment(config), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).trim()
  const put = (path: string, content: string) => { const target = join(repository, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content) }
  git('init', '-q'); git('checkout', '-q', '-b', 'develop')
  const ci = 'stages: [test]\nunit:\n  stage: test\n  script: echo fixture\n'
  put('.gitlab-ci.yml', ci); put('source.txt', 'base\n'); git('add', '--', '.gitlab-ci.yml', 'source.txt'); git('commit', '-q', '-m', 'fixture base')
  const base = git('rev-parse', 'HEAD'); git('checkout', '-q', '-b', 'agent/task-1')
  const task: Task = { id: 'task-1', originId: 'dm-1', ownerId: 'owner', text: 'Bounded approved fixture change', repositories: ['repo'], access: 'write', approved: true, approveMessageId: 'approve-1', target: { source: 'feishu', chatId: 'private', messageId: 'dm-1' }, state: 'running', createdAt: new Date().toISOString(), releaseGrant: { id: 'grant-1', taskId: 'task-1', ownerId: 'owner', approvalMessageId: 'release-1', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), policyDigest: DIGEST, scopes: [{ repository: 'repo', sourceBranch: 'agent/task-1', targetBranch: 'develop', baseSha: base, actions: ['push', 'create_mr'] }] } }
  const path = join(root, 'receipts.sqlite')
  const open = () => { const store = new CommitReceipts(path, config); receipts.push(store); return store }
  const store = open()
  let count = 0
  const commit = (file = 'source.txt', content = `change-${++count}\n`) => {
    const parent = git('rev-parse', 'HEAD'); put(file, content); git('add', '--', file); git('commit', '-q', '-m', `fixture change ${count}`)
    const head = git('rev-parse', 'HEAD'), treeSha = git('rev-parse', `${head}^{tree}`)
    const input: CommitReceiptInput = { taskId: task.id, runId: 'run-1', repository: 'repo', root: repository, head, parent, branch: 'agent/task-1', treeSha, sourceDigest: DIGEST, validationIds: [VALIDATION], recipePins: { unit: RECIPE } }
    return input
  }
  const close = (value = store) => { value.close(); const index = receipts.indexOf(value); if (index >= 0) receipts.splice(index, 1) }
  return { root, repository, config, git, put, ci, base, task, store, path, open, close, commit }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of receipts.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || !root.startsWith(realpathSync(tmpdir()) + '/nightshift-commit-receipts-')) throw new Error(`Unexpected fixture deletion ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('host commit receipt persistence and exact Git lineage', () => {
  it('proves a complete clean same-task linear chain and returns the actual tree/CI hash', async () => {
    const h = fixture(), first = h.commit(), second = h.commit()
    h.store.record(first); const lastId = h.store.record(second)
    expect(await h.store.candidate(h.task, 'repo', second.head)).toMatchObject({ taskId: h.task.id, repository: 'repo', sha: second.head, treeSha: second.treeSha, baseSha: h.base, sourceBranch: 'agent/task-1', clean: true, validated: true, commitReceiptId: lastId, validationReceiptIds: [VALIDATION], ciSha256: createHash('sha256').update(h.ci).digest('hex'), changedProtectedPaths: [] })
  })

  it('persists receipt identity across reopen, deduplicates exact input and refuses conflicting facts', async () => {
    const h = fixture(), input = h.commit(), id = h.store.record(input)
    expect(h.store.record(structuredClone(input))).toBe(id)
    expect(() => h.store.record({ ...input, runId: 'different-run' })).toThrow('Conflicting')
    h.close()
    const reopened = h.open()
    expect(reopened.record(input)).toBe(id)
    expect((await reopened.candidate(h.task, 'repo', input.head)).commitReceiptId).toBe(id)
  })

  it.each(['wrong-root', 'empty-task', 'empty-run', 'bad-head', 'bad-parent', 'bad-tree', 'bad-source-digest', 'branch', 'no-validations', 'bad-validation', 'no-recipes', 'bad-recipe'] as const)('rejects malformed receipt %s', invalid => {
    const h = fixture(), input = h.commit()
    if (invalid === 'wrong-root') input.root = h.root
    if (invalid === 'empty-task') input.taskId = ''
    if (invalid === 'empty-run') input.runId = ''
    if (invalid === 'bad-head') input.head = 'HEAD'
    if (invalid === 'bad-parent') input.parent = 'HEAD~1'
    if (invalid === 'bad-tree') input.treeSha = 'tree'
    if (invalid === 'bad-source-digest') input.sourceDigest = 'summary'
    if (invalid === 'branch') input.branch = 'develop'
    if (invalid === 'no-validations') input.validationIds = []
    if (invalid === 'bad-validation') input.validationIds = ['tests passed']
    if (invalid === 'no-recipes') input.recipePins = {}
    if (invalid === 'bad-recipe') input.recipePins = { test: 'latest' }
    expect(() => h.store.record(input)).toThrow('malformed')
  })

  it('does not accept a final receipt when earlier newly published commits are unreceipted', async () => {
    const h = fixture(); h.commit(); const final = h.commit(); h.store.record(final)
    await expect(h.store.candidate(h.task, 'repo', final.head)).rejects.toThrow('Unreceipted')
  })

  it('does not borrow a predecessor commit receipt from another task', async () => {
    const h = fixture(), first = h.commit(), second = h.commit()
    h.store.record({ ...first, taskId: 'other-task' }); h.store.record(second)
    await expect(h.store.candidate(h.task, 'repo', second.head)).rejects.toThrow('Unreceipted')
  })

  it.each(['claimed-parent', 'claimed-tree', 'claimed-branch'] as const)('verifies %s against actual immutable Git objects and admitted scope', async invalid => {
    const h = fixture(), input = h.commit()
    if (invalid === 'claimed-parent') input.parent = 'f'.repeat(40)
    if (invalid === 'claimed-tree') input.treeSha = h.git('rev-parse', `${h.base}^{tree}`)
    if (invalid === 'claimed-branch') input.branch = 'agent/another-task'
    h.store.record(input)
    await expect(h.store.candidate(h.task, 'repo', input.head)).rejects.toThrow(/lineage mismatch|differs from host receipt/)
  })

  it('rejects a falsely linearized merge commit even when its claimed receipt chain looks linear', async () => {
    const h = fixture()
    const first = h.commit(); h.store.record(first)
    const unrelated = h.git('commit-tree', first.treeSha, '-p', h.base, '-m', 'fixture side commit')
    const merge = h.git('commit-tree', first.treeSha, '-p', first.head, '-p', unrelated, '-m', 'fixture merge')
    h.git('update-ref', 'refs/heads/agent/task-1', merge)
    h.store.record({ ...first, head: unrelated, parent: first.head })
    h.store.record({ ...first, head: merge, parent: unrelated })
    await expect(h.store.candidate(h.task, 'repo', merge)).rejects.toThrow(/lineage mismatch|differs from host receipt/)
  })

  it('rejects a base from a different Git ancestry even if a receipt names it', async () => {
    const h = fixture(), input = h.commit()
    const unrelated = h.git('commit-tree', input.treeSha, '-m', 'fixture unrelated root')
    h.task.releaseGrant!.scopes[0]!.baseSha = unrelated
    h.store.record({ ...input, parent: unrelated })
    await expect(h.store.candidate(h.task, 'repo', input.head)).rejects.toThrow()
  })

  it('requires a nonempty newly receipted range, never treats clean baseline as publishable work', async () => {
    const h = fixture()
    await expect(h.store.candidate(h.task, 'repo', h.base)).rejects.toThrow('bounded newly receipted')
  })

  it('pins configured repository identity against mutation of the caller config', async () => {
    const h = fixture(), input = h.commit()
    h.config.repositories.repo = h.root
    expect(() => h.store.record(input)).not.toThrow()
    expect((await h.store.candidate(h.task, 'repo', input.head)).sha).toBe(input.head)
  })
})

describe('candidate HEAD/worktree readback and protected control surface', () => {
  it.each(['include.path', 'includeIf.gitdir:**.path'])('rejects actual %s filter indirection before receipt readback can execute it', async includeKey => {
    const h = fixture(), input = h.commit(); h.store.record(input)
    const marker = join(h.root, 'FILTER_MUST_NOT_RUN')
    const included = join(h.repository, 'mutable-source-config.ini')
    h.git('config', '--local', includeKey, included)
    h.put('.git/info/attributes', 'source.txt filter=receipt-probe\n')
    writeFileSync(included, `[filter "receipt-probe"]\n  clean = /usr/bin/touch '${marker}'; /bin/cat\n`)
    h.put('source.txt', 'force-index-recheck\n')
    utimesSync(join(h.repository, 'source.txt'), new Date(1000), new Date(1000))
    await expect(h.store.candidate(h.task, 'repo', input.head)).rejects.toThrow(/mutable includes|Executable Git/)
    expect(existsSync(marker)).toBe(false)
  })

  it('ignores actual refs/replace objects when proving receipt tree and parent identity', async () => {
    const h = fixture(), input = h.commit(), receiptId = h.store.record(input)
    const baselineTree = h.git('rev-parse', `${h.base}^{tree}`)
    const replacement = h.git('commit-tree', baselineTree, '-p', h.base, '-m', 'disposable replacement object')
    h.git('update-ref', `refs/replace/${input.head}`, replacement)
    const unsafeTree = execFileSync('/usr/bin/git', ['-C', h.repository, 'rev-parse', `${input.head}^{tree}`], {
      encoding: 'utf8', timeout: 5000, env: preflight.workerEnvironment(h.config),
    }).trim()
    expect(unsafeTree).toBe(baselineTree)
    expect(unsafeTree).not.toBe(input.treeSha)
    const candidate = await h.store.candidate(h.task, 'repo', input.head)
    expect(candidate).toMatchObject({ sha: input.head, treeSha: input.treeSha, baseSha: h.base, commitReceiptId: receiptId })
  })

  it.each(['missing-scope', 'outside-task', 'unknown-repo', 'stale-head', 'dirty-tracked', 'dirty-index', 'untracked', 'wrong-branch', 'detached'] as const)('rejects %s candidate', async invalid => {
    const h = fixture(), input = h.commit(); h.store.record(input)
    let repository = 'repo', sha = input.head
    if (invalid === 'missing-scope') delete h.task.releaseGrant
    if (invalid === 'outside-task') h.task.repositories = []
    if (invalid === 'unknown-repo') repository = 'outside'
    if (invalid === 'stale-head') sha = h.base
    if (invalid === 'dirty-tracked') h.put('source.txt', 'uncommitted\n')
    if (invalid === 'dirty-index') { h.put('source.txt', 'staged\n'); h.git('add', '--', 'source.txt') }
    if (invalid === 'untracked') h.put('untracked.txt', 'not approved\n')
    if (invalid === 'wrong-branch') h.git('checkout', '-q', '-b', 'agent/other')
    if (invalid === 'detached') h.git('checkout', '-q', '--detach', input.head)
    await expect(h.store.candidate(h.task, repository, sha)).rejects.toThrow()
  })

  it.each(['head', 'branch', 'dirty'] as const)('detects late %s drift during asynchronous receipt verification', async drift => {
    const h = fixture(), input = h.commit(); h.store.record(input)
    const original = preflight.safeGit
    let changed = false
    vi.spyOn(preflight, 'safeGit').mockImplementation(async (root, args, config) => {
      const output = await original(root, args, config)
      if (!changed && args[0] === 'show' && args[1] === `${input.head}:.gitlab-ci.yml`) {
        changed = true
        if (drift === 'head') { const next = h.git('commit-tree', input.treeSha, '-p', input.head, '-m', 'fixture concurrent commit'); h.git('update-ref', 'refs/heads/agent/task-1', next) }
        if (drift === 'branch') h.git('checkout', '-q', '-b', 'agent/concurrent')
        if (drift === 'dirty') h.put('source.txt', 'concurrent dirty change\n')
      }
      return output
    })
    await expect(h.store.candidate(h.task, 'repo', input.head)).rejects.toThrow('Candidate changed')
    expect(changed).toBe(true)
  })

  it.each(['.gitlab-ci.yml', 'Jenkinsfile', 'deploy/service.sh', 'release/route.json', '.github/workflows/test.yml', 'Dockerfile', '.gitmodules', '.gitattributes', '.env.test'] as const)('surfaces changed protected path %s for release admission to reject', async path => {
    const h = fixture(), input = h.commit(path, 'changed control surface\n'); h.store.record(input)
    expect((await h.store.candidate(h.task, 'repo', input.head)).changedProtectedPaths).toContain(path)
  })
})
