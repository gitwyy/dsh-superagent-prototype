/** Host-only commit receipts. Pi-supplied text and clean worktrees are never publication authority. */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { NightConfig, Task } from '../contracts.ts'
import { safeGit } from '../preflight.ts'
import type { CandidateEvidence } from './contracts.ts'

export interface CommitReceiptInput {
  taskId: string; runId: string; repository: string; root: string
  head: string; parent: string; branch: string; treeSha: string; sourceDigest: string
  validationIds: string[]; recipePins: Record<string, string>
}
const oid = /^[a-f0-9]{40}$/
const digest = /^[a-f0-9]{64}$/
/** Receives verified host broker outputs and proves every unpublished commit belongs to the authorized task. */
export class CommitReceipts {
  private readonly db: DatabaseSync
  constructor(path: string, private readonly config: NightConfig) {
    this.config = structuredClone(config)
    if (!isAbsolute(path)) throw new Error('Absolute receipt database path required')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path); chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS commit_receipts(id TEXT PRIMARY KEY, task TEXT NOT NULL, repository TEXT NOT NULL, sha TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(task,repository,sha));')
  }
  record(input: CommitReceiptInput): string {
    if (!input.taskId || !input.runId || this.config.repositories[input.repository] !== input.root
      || ![input.head, input.parent, input.treeSha].every(x => oid.test(x)) || !digest.test(input.sourceDigest)
      || !/^(agent|sdd)\//.test(input.branch) || !input.validationIds.length || !input.validationIds.every(x => digest.test(x))
      || !Object.keys(input.recipePins).length || !Object.values(input.recipePins).every(x => digest.test(x))) throw new Error('Host commit receipt is malformed')
    const old = this.db.prepare('SELECT id,value FROM commit_receipts WHERE task=? AND repository=? AND sha=?').get(input.taskId, input.repository, input.head)
    const value = JSON.stringify(input)
    if (old) {
      if (old.value !== value) throw new Error('Conflicting commit receipt; manual recovery required')
      return String(old.id)
    }
    const id = randomUUID()
    this.db.prepare('INSERT INTO commit_receipts VALUES(?,?,?,?,?)').run(id, input.taskId, input.repository, input.head, value)
    return id
  }
  async candidate(task: Task, repository: string, sha: string): Promise<CandidateEvidence> {
    const scope = task.releaseGrant?.scopes.find(s => s.repository === repository), root = this.config.repositories[repository]
    if (!scope || !root || !task.repositories.includes(repository) || !oid.test(sha)) throw new Error('No admitted repository publication scope')
    const current = (await safeGit(root, ['rev-parse', 'HEAD'], this.config)).trim()
    const branch = (await safeGit(root, ['branch', '--show-current'], this.config)).trim()
    const status = await safeGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], this.config)
    if (current !== sha || branch !== scope.sourceBranch || status) throw new Error('Publication candidate must be the exact clean task branch HEAD')
    const tree = (await safeGit(root, ['rev-parse', `${sha}^{tree}`], this.config)).trim()
    const commits = (await safeGit(root, ['rev-list', '--reverse', `${scope.baseSha}..${sha}`], this.config)).trim().split('\n').filter(Boolean)
    if (!commits.length || commits.length > 200) throw new Error('Publication requires a bounded newly receipted commit chain')
    await safeGit(root, ['merge-base', '--is-ancestor', scope.baseSha, sha], this.config)
    let parent = scope.baseSha, lastId = ''; const validationIds: string[] = []
    for (const commit of commits) {
      const row = this.db.prepare('SELECT id,value FROM commit_receipts WHERE task=? AND repository=? AND sha=?').get(task.id, repository, commit)
      if (!row) throw new Error('Unreceipted commit in publication range')
      const receipt = JSON.parse(String(row.value)) as CommitReceiptInput
      if (receipt.root !== root || receipt.parent !== parent || receipt.branch !== branch) throw new Error('Commit receipt lineage mismatch')
      const actualParents = (await safeGit(root, ['rev-list', '--parents', '-n', '1', commit], this.config)).trim().split(' ')
      const actualTree = (await safeGit(root, ['rev-parse', `${commit}^{tree}`], this.config)).trim()
      if (actualParents.length !== 2 || actualParents[1] !== parent || actualTree !== receipt.treeSha) throw new Error('Git commit differs from host receipt')
      validationIds.push(...receipt.validationIds); lastId = String(row.id); parent = commit
    }
    const changed = (await safeGit(root, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', scope.baseSha, sha], this.config)).split('\0').filter(Boolean)
    const protectedPaths = changed.filter(p => /(^|\/)(?:\.gitlab(?:\/|-ci)|\.github\/|Jenkinsfile|Dockerfile|\.mvn\/|\.npmrc|\.yarnrc|\.gitmodules|\.gitattributes|\.pi\/|\.env(?:\.|$)|deploy(?:\/|\.)|release(?:\/|\.))/i.test(p))
    const ci = await safeGit(root, ['show', `${sha}:.gitlab-ci.yml`], this.config)
    if ((await safeGit(root, ['rev-parse', 'HEAD'], this.config)).trim() !== sha
      || (await safeGit(root, ['branch', '--show-current'], this.config)).trim() !== scope.sourceBranch
      || (await safeGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], this.config))) throw new Error('Candidate changed during receipt verification')
    return { taskId: task.id, repository, sha, treeSha: tree, baseSha: scope.baseSha, sourceBranch: branch, clean: true,
      commitReceiptId: lastId, validated: true, validationReceiptIds: [...new Set(validationIds)],
      ciSha256: createHash('sha256').update(ci).digest('hex'), changedProtectedPaths: protectedPaths }
  }
  close(): void { this.db.close() }
}
