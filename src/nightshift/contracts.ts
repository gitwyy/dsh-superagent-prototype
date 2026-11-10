/** Night-shift boundaries. No dependency on DSH/Feishu: the adapter owns transport and authentication. */
import type { ReleaseGrant, ReleasePolicy, ReleaseScope } from './release/contracts.ts'
export type ShiftMode = 'DAY_MANUAL' | 'NIGHT_RUNNING' | 'HANDOFF_PENDING' | 'NIGHT_PAUSED' | 'RECOVERY_REQUIRED'
export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'unknown'
export type ActionName = 'validate' | 'commit' | 'publish'
/** Local operator-owned recipes; never accepted from model arguments. Validation executes trusted code, not a sandbox. */
export interface ValidationRecipe {
  executable: string
  executableSha256: string
  args: string[]
  timeoutSeconds: number
  /** Repository-relative recipe files pinned by SHA256; refuses recipe drift. */
  pinnedFiles: Record<string, string>
  env?: Record<string, string>
}
export interface RepositoryActions {
  validations: Record<string, ValidationRecipe>
  /** All of these recipes must pass against unchanged source content before commit/publish. */
  requiredValidations: string[]
  author: { name: string; email: string }
  targetBranch: string
  remoteUrl?: string
  /** Absolute trusted glab wrapper with a dedicated identity; no token in this configuration. */
  glabExecutable?: string
  gitlabProject?: string
  gitlabHost?: string
}
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
  repositoryActions?: Record<string, RepositoryActions>
  /** Host-only release policy. Credentials and route details must never be serialized into Pi environment. */
  releasePolicy?: ReleasePolicy
  releaseRuntime?: { keyId: string; keyFile: string; ticketDir: string; attestationFile: string }
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
  /** Separately approved host-broker actions. Legacy tasks default to no actions. */
  actions?: ActionName[]
  actionsApproveMessageId?: string
  releaseGrant?: ReleaseGrant
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
  /** Remote build/deployment may outlive the local Pi group; never infer safe handoff from local exit alone. */
  remoteActive?: boolean
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
  | { type: 'authorize-actions'; taskId: string; actions: ActionName[] }
  | { type: 'authorize-release'; taskId: string; expiresAt: string; scopes: ReleaseScope[] }
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
