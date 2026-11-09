/** Night-shift boundaries. No dependency on DSH/Feishu: the adapter owns transport and authentication. */
export type ShiftMode = 'DAY_MANUAL' | 'NIGHT_RUNNING' | 'HANDOFF_PENDING' | 'NIGHT_PAUSED' | 'RECOVERY_REQUIRED'
export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'unknown'
export interface NightConfig {
  enabled: boolean
  workspace: string
  stateDir: string
  piExecutable: string
  piHome: string
  sessionFile: string
  /** Explicit installed mate-pi package path; skills/templates only, no automatic extensions. */
  harnessRoot?: string
  /** Shared canonical-workspace lock namespace, outside business repositories. */
  lockRoot?: string
  repositories: Record<string, string>
  provider?: string
  model?: string
  thinking?: string
  maxTaskSeconds: number
  freezeWindows: { from: string; until: string }[]
  /** Migration cutoff for source history: earlier messages cannot enqueue or grant work. */
  acceptAfter?: string
}
export interface ReplyTarget { source: 'feishu'; chatId: string; messageId: string }
export interface Task {
  id: string
  originId: string
  ownerId: string
  text: string
  repositories: string[]
  access: 'read' | 'write'
  approved: boolean
  approveMessageId?: string
  target: ReplyTarget
  state: TaskState
  createdAt: string
  startedAt?: string
  endedAt?: string
  runId?: string
  result?: RunResult
}
export interface RunResult {
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'unknown'
  summary: string
  /** True only once the supervised child and its process group have been verified gone. */
  writerStopped: boolean
  evidence: string[]
}
export interface RunRequest { runId: string; task: Task; deadline: string; config: NightConfig }
export interface Runner {
  /** No shell string supplied by the controller: implementation invokes the pinned executable. */
  run(request: RunRequest, signal: AbortSignal): Promise<RunResult>
  /** Check for other writers/dirty repositories before admitting a shift. Does not modify repositories. */
  preflight(config: NightConfig, tasks: Task[]): Promise<{ ok: boolean; problems: string[] }>
}
export interface Incoming {
  id: string
  actorId: string
  text: string
  at: string
  direct: boolean
  human: boolean
  target: ReplyTarget
}
export interface PendingReply { id: string; target: ReplyTarget; text: string }
export type Command =
  | { type: 'status' | 'help' | 'pause' | 'handoff' }
  | { type: 'enqueue'; text: string; repositories: string[]; access: 'read' | 'write' }
  | { type: 'approve'; taskId: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'start'; deadline: string }
  | { type: 'recover'; acknowledged: boolean }

/** Stable interface implemented by the serialized supervisor and consumed by the host adapter. */
export interface NightController {
  handle(input: Incoming, command: Command): Promise<void>
  snapshot(): { mode: ShiftMode; deadline?: string; tasks: Task[]; activeRunId?: string; problems: string[] }
  pendingReplies(): PendingReply[]
  markReplySent(id: string): void
  /** System pause/revocation stops dispatch and current work without fabricating a human command. */
  suspend(): Promise<void>
  /** Drain/stop owned work; never returns a false safe-handoff acknowledgement. */
  close(): Promise<void>
}
