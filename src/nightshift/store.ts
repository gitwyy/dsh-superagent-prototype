/** Durable local inbox/outbox and conservative process/workspace reservations. */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { NightConfig, PendingReply, ReplyTarget, ShiftMode, Task } from './contracts.ts'

export interface PendingCheck { id: string; kind: 'start' | 'recover'; target: ReplyTarget; deadline?: string }
export interface StopRequest { id: string; target: ReplyTarget; mode: 'DAY_MANUAL' | 'NIGHT_PAUSED' }
export interface DurableState {
  version: 1
  workspace: string
  /** Bind human approval to the pinned host configuration, never just a mutable alias. */
  authorizationKey: string
  mode: ShiftMode
  deadline?: string
  activeRunId?: string
  /** False also means unknown: absence of evidence is never evidence of a stopped writer. */
  writerStopped: boolean
  pendingCheck?: PendingCheck
  stopRequests: StopRequest[]
  problems: string[]
  tasks: Task[]
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Never steal a lock, even for a dead PID: that PID may have left live children. */
class Reservation {
  private readonly body: string
  private readonly inode: number
  private released = false
  constructor(readonly path: string) {
    this.body = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID(), createdAt: new Date().toISOString() })
    let fd: number
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600) }
    catch (error) { throw new Error(`Nightshift lock unavailable: ${path}. Do not remove until the owner and all writers are independently verified stopped.`, { cause: error }) }
    try { writeFileSync(fd, this.body); fsyncSync(fd) } finally { closeSync(fd) }
    this.inode = lstatSync(path).ino
    syncDirectory(dirname(path))
  }
  assertOwned(): void {
    if (this.released || resolve(this.path) !== this.path || lstatSync(this.path).ino !== this.inode || readFileSync(this.path, 'utf8') !== this.body) {
      throw new Error(`Nightshift lock ownership changed: ${this.path}`)
    }
  }
  release(): void {
    if (this.released) return
    // Check the exact absolute pathname and ownership before unlinking. Never delete foreign locks.
    this.assertOwned()
    unlinkSync(this.path)
    this.released = true
    syncDirectory(dirname(this.path))
  }
}

/** Owns SQLite inbox/state/outbox transactions and non-stealable state/workspace process reservations. */
export class NightStore {
  private readonly db: DatabaseSync
  private readonly singleton: Reservation
  private workspaceReservation?: Reservation
  readonly workspace: string
  readonly workspaceLockPath: string
  private closed = false

  constructor(config: NightConfig) {
    if (!isAbsolute(config.workspace) || !isAbsolute(config.stateDir)) throw new Error('Nightshift workspace and stateDir must be absolute paths')
    this.workspace = realpathSync(config.workspace)
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
    const stateDir = realpathSync(config.stateDir)
    const lockRoot = config.lockRoot ?? join(homedir(), '.dsh', 'state', 'mate-v2-nightshift-workspace-locks')
    if (!isAbsolute(lockRoot)) throw new Error('Nightshift lockRoot must be absolute')
    mkdirSync(lockRoot, { recursive: true, mode: 0o700 })
    // A common per-user root makes differently configured state directories contend on workspace identity.
    this.workspaceLockPath = join(realpathSync(lockRoot), `${createHash('sha256').update(this.workspace).digest('hex')}.lock`)
    this.singleton = new Reservation(join(stateDir, 'controller.lock'))
    let db: DatabaseSync | undefined
    try {
      const path = join(stateDir, 'nightshift.sqlite')
      db = new DatabaseSync(path)
      chmodSync(path, 0o600)
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, actor TEXT NOT NULL, received TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);`)
      this.db = db
      const state = this.load()
      if (state && (state.version !== 1 || state.workspace !== this.workspace)) throw new Error('Nightshift state version/workspace identity mismatch; refusing to reuse authorization')
      const authorizationKey = createHash('sha256').update(JSON.stringify({
        workspace: this.workspace, repositories: Object.entries(config.repositories).sort(([a], [b]) => a.localeCompare(b)),
        piExecutable: config.piExecutable, piHome: config.piHome, sessionFile: config.sessionFile,
        harnessRoot: config.harnessRoot, provider: config.provider, model: config.model, thinking: config.thinking,
        repositoryActions: config.repositoryActions ?? {},
      })).digest('hex')
      if (!state) this.save({ version: 1, workspace: this.workspace, authorizationKey, mode: 'DAY_MANUAL', writerStopped: true, stopRequests: [], problems: [], tasks: [] })
      else if (state.authorizationKey !== authorizationKey) {
        // Host changes are trusted, but they do not silently inherit a person's old write approval.
        for (const task of state.tasks) if (task.state === 'queued') { task.approved = false; delete task.approveMessageId; delete task.actions; delete task.actionsApproveMessageId }
        state.authorizationKey = authorizationKey
        state.mode = 'RECOVERY_REQUIRED'
        state.problems = ['固定执行器/仓库配置已变更；排队任务授权已撤销，必须人工核查恢复。']
        this.save(state)
      }
    } catch (error) {
      db?.close()
      this.singleton.release()
      throw error
    }
  }

  acquireWorkspace(): void { this.singleton.assertOwned(); this.workspaceReservation ??= new Reservation(this.workspaceLockPath); this.workspaceReservation.assertOwned() }
  assertOwned(): void { this.singleton.assertOwned(); this.workspaceReservation?.assertOwned() }
  assertWorkspace(): void {
    this.singleton.assertOwned()
    if (!this.workspaceReservation) throw new Error('Nightshift workspace reservation is not held')
    this.workspaceReservation.assertOwned()
  }
  releaseWorkspace(): void { this.workspaceReservation?.release(); this.workspaceReservation = undefined }
  load(): DurableState | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE id=1').get()
    return row ? JSON.parse(String(row.value)) as DurableState : undefined
  }
  save(state: DurableState): void { this.db.prepare('INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(state)) }
  transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = body(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  seen(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM inbox WHERE id=?').get(id) }
  receive(id: string, actor: string, received: string): void { this.db.prepare('INSERT INTO inbox VALUES(?,?,?)').run(id, actor, received) }
  reply(id: string, target: ReplyTarget, text: string): void {
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,value) VALUES(?,?)').run(id, JSON.stringify({ id, target, text }))
  }
  pendingReplies(): PendingReply[] { return this.db.prepare('SELECT value FROM outbox WHERE sent=0 ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as PendingReply) }
  markReplySent(id: string): void { this.db.prepare('UPDATE outbox SET sent=1 WHERE id=?').run(id) }
  /** On uncertainty leave the workspace reservation on disk, including after this process exits. */
  close(writerStopped: boolean): void {
    if (this.closed) return
    if (writerStopped) this.releaseWorkspace()
    this.db.close()
    this.singleton.release()
    this.closed = true
  }
}
