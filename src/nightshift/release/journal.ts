/** Durable host-only remote intent journal; never replay an interrupted external mutation. */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CandidateEvidence, ReleaseGrant, ReleaseOperation, ReleaseRepository, ReleaseRequest, ReleaseScope } from './contracts.ts'

export interface ReleaseIntent {
  operation: ReleaseOperation
  request: ReleaseRequest
  repository: ReleaseRepository
  grant: ReleaseGrant
  scope: ReleaseScope
  candidate: CandidateEvidence
  deadline: string
  /** Immutable readback pin for a successful metadata-only preparation. */
  preparationDigest?: string
  preparationExpiresAt?: string
  /** Once learned, deployed commit M must never change for this logical source-S operation. */
  mergedSha?: string
  /** Side effects can remain active even when an individual push/MR operation has succeeded. */
  remoteActive: boolean
  /** Pin webhook-created sibling build identities on first observation, never adopt a retry silently. */
  deploymentIds?: string[]
  deploymentBuilds?: Record<string, string>
}
const LOCAL_WRITER_KEY = '__local_writer_unknown__'
const timestamp = () => new Date().toISOString()
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Owns one SQLite database and an exclusive, non-stealable reservation for its complete lifecycle. */
export class ReleaseJournal {
  private readonly db: DatabaseSync
  private readonly lockPath: string
  private readonly lockBody: string
  private readonly lockInode: number
  private closed = false

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('Release journal path must be absolute')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    path = existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path))
    this.lockPath = `${path}.lock`
    this.lockBody = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID(), createdAt: timestamp() })
    // No age/PID heuristic: a dead coordinator can leave accepted remote effects alive.
    const fd = openSync(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { writeFileSync(fd, this.lockBody); fsyncSync(fd) } finally { closeSync(fd) }
    this.lockInode = lstatSync(this.lockPath).ino
    syncDirectory(dirname(this.lockPath))
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path)
      chmodSync(path, 0o600)
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      if (version !== 0 && version !== 1) throw new Error(`Unsupported release journal version ${version}`)
      db.exec(`CREATE TABLE IF NOT EXISTS operation (id TEXT PRIMARY KEY, logical_key TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS safety (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;`)
      this.db = db
      this.atomic(() => {
        for (const intent of this.intents()) {
          if (intent.operation.state !== 'prepared' && intent.operation.state !== 'dispatching') continue
          const dispatched = intent.operation.state === 'dispatching'
          intent.operation.state = dispatched ? 'unknown' : 'failed'
          intent.operation.updatedAt = timestamp()
          intent.operation.detail = dispatched
            ? '进程在远端派发期间中断；结果 unknown，禁止自动重试。'
            : '进程在派发前中断；本操作已封存，未自动恢复或重试。'
          intent.remoteActive = dispatched
          this.save(intent)
        }
      })
    } catch (error) {
      db?.close()
      this.releaseLock()
      throw error
    }
  }

  assertOwned(): void {
    if (this.closed || resolve(this.lockPath) !== this.lockPath || lstatSync(this.lockPath).ino !== this.lockInode || readFileSync(this.lockPath, 'utf8') !== this.lockBody) {
      throw new Error('Release journal reservation ownership changed; refusing to dispatch or delete foreign lock')
    }
  }
  private releaseLock(): void {
    // Verify exact canonical absolute pathname, inode and token immediately before removing our own lock.
    this.assertOwned()
    unlinkSync(this.lockPath)
    syncDirectory(dirname(this.lockPath))
  }
  atomic<T>(body: () => T): T {
    this.assertOwned()
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = body(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private decode(row: Record<string, unknown> | undefined): ReleaseIntent | undefined {
    if (!row) return undefined
    const intent = JSON.parse(String(row.value)) as ReleaseIntent
    if (!intent.operation || typeof intent.operation.id !== 'string' || typeof intent.operation.logicalKey !== 'string'
      || !['push', 'create_mr', 'prepare_merge', 'merge', 'deploy'].includes(intent.operation.action)
      || !['prepared', 'dispatching', 'accepted', 'succeeded', 'failed', 'unknown'].includes(intent.operation.state)
      || typeof intent.remoteActive !== 'boolean' || !intent.request || !intent.grant || !intent.scope || !intent.repository) {
      throw new Error('Invalid persisted release intent; offline reconciliation required')
    }
    return intent
  }
  intents(): ReleaseIntent[] { return this.db.prepare('SELECT value FROM operation ORDER BY rowid').all().map(row => this.decode(row)!) }
  get(id: string): ReleaseIntent | undefined { return this.decode(this.db.prepare('SELECT value FROM operation WHERE id=?').get(id)) }
  byKey(key: string): ReleaseIntent | undefined { return this.decode(this.db.prepare('SELECT value FROM operation WHERE logical_key=?').get(key)) }
  insert(intent: ReleaseIntent): void {
    this.assertOwned()
    const operation = intent.operation
    if (this.intents().some(row => row.operation.taskId === operation.taskId && row.operation.grantId === operation.grantId
      && row.operation.repository === operation.repository && row.operation.sha === operation.sha && row.operation.action === operation.action)) {
      throw new Error('Release action already has an immutable task/grant/source intent; no new generation allowed')
    }
    this.db.prepare('INSERT INTO operation(id,logical_key,value) VALUES(?,?,?)').run(intent.operation.id, intent.operation.logicalKey, JSON.stringify(intent))
  }
  save(intent: ReleaseIntent): void {
    this.assertOwned()
    const changed = this.db.prepare('UPDATE operation SET value=? WHERE id=? AND logical_key=?').run(JSON.stringify(intent), intent.operation.id, intent.operation.logicalKey)
    if (Number(changed.changes) !== 1) throw new Error('Release journal lost immutable operation identity')
  }
  localWriterUnknown(): boolean { return !!this.db.prepare('SELECT 1 FROM safety WHERE key=?').get(LOCAL_WRITER_KEY) }
  markLocalWriterUnknown(): void {
    this.atomic(() => { this.db.prepare('INSERT OR IGNORE INTO safety(key,value) VALUES(?,?)').run(LOCAL_WRITER_KEY, timestamp()) })
  }
  close(): void {
    if (this.closed) return
    this.assertOwned()
    this.db.close()
    this.releaseLock()
    this.closed = true
  }
}
