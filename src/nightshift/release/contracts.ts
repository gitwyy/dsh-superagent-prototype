/** Host-owned release capability. All identities/routes come from local operator policy, never Pi arguments. */
export const releaseMarker = (taskId: string, repository: string, sha: string): string => `nightshift:${taskId}:${repository}:${sha}`
export type ReleaseAction = 'push' | 'create_mr' | 'merge' | 'deploy'
export type ReleaseEnvironment = 'test' | 'preprod'
export interface ReleaseRepository {
  alias: string
  root: string
  projectId: number
  projectPath: string
  host: string
  apiOrigin: string
  /** Explicit operator consent required; default HTTPS only. */
  allowInsecureHttp?: boolean
  expectedUserId: number
  expectedUsername: string
  credentialFile: string
  targetBranch: string
  /** Exact reviewed CI config blob SHA256 at candidate AND target; any drift blocks remote triggers. */
  ciSha256: string
  requiredJobs: string[]
  /** Merge is a remote deploy trigger for these projects; deploy grant is mandatory too. */
  mergeTriggersDeploy: boolean
  /** Attested nondefault source pushes create no server-side jobs/hooks; never inferred from missing pipeline. */
  pushHasNoRemoteJobs?: boolean
  /** Activation attestation required even for push: includes hooks/external CI, not only repository YAML. */
  triggerPolicy: { reviewedAt: string; expiresAt: string; productionExcluded: boolean; fingerprint: string }
  environments: Partial<Record<ReleaseEnvironment, DeploymentRoute>>
}
export interface DeploymentRoute {
  kind: 'jenkins'
  /** Route is preconfigured by an operator; no arbitrary job/url/parameters from Pi. */
  id: string
  jobs: string[]
  origin: string
  expectedConfigSha256: Record<string, string>
  /** Application/environment/health/rollback evidence reviewed before activation. */
  destinationId: string
  remoteDeadlineEnforced: boolean
  credentialRef: string
}
export interface ReleasePolicy {
  version: 1
  enabled: boolean
  repositories: Record<string, ReleaseRepository>
  freezeWindows: { from: string; until: string }[]
  maxGrantSeconds: number
}
export interface ReleaseScope {
  repository: string
  sourceBranch: string
  targetBranch: string
  /** Branch must descend from exactly this operator-admitted base, not unrelated existing work. */
  baseSha: string
  environment?: ReleaseEnvironment
  actions: ReleaseAction[]
}
export interface ReleaseGrant {
  id: string
  taskId: string
  ownerId: string
  approvalMessageId: string
  issuedAt: string
  expiresAt: string
  policyDigest: string
  scopes: ReleaseScope[]
}
export interface ReleaseRequest {
  taskId: string
  repository: string
  action: ReleaseAction
  /** Content identity required on every request; sourceBranch itself is not immutable. */
  sha: string
  title?: string
  description?: string
}
export interface CandidateEvidence {
  taskId: string
  repository: string
  sha: string
  treeSha: string
  baseSha: string
  sourceBranch: string
  clean: boolean
  /** Trusted host commit receipt lineage, not an LLM assertion. */
  commitReceiptId: string
  validated: boolean
  validationReceiptIds: string[]
  ciSha256: string
  changedProtectedPaths: string[]
}
export interface RemoteSnapshot {
  identity: { id: number; username: string }
  project: { id: number; path: string; defaultBranch: string; pipelineRequired: boolean; fastForwardOnly?: boolean }
  sourceSha?: string
  targetSha: string
  targetCiSha256: string
  productionExcluded: boolean
  triggerPolicyFingerprint: string
  mergeRequest?: { iid: number; sourceProjectId: number; targetProjectId: number; sourceBranch: string; targetBranch: string; sha: string; state: 'opened' | 'merged' | 'closed'; authorId: number; draft: boolean; conflicts: boolean; mergeable: boolean; approved: boolean; unresolvedDiscussions: number; mergeCommitSha?: string; mergeCommitVerified?: boolean; mergeTreeSha?: string; mergeParents?: string[]; marker: string }
  pipeline?: { id: number; sha: string; status: string; jobs: { name: string; status: string; allowFailure: boolean }[] }
  deployment?: { routeId: string; sourceSha: string; state: 'absent' | 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown'; ids: string[]; destinationId: string; artifactDigest?: string; healthy: boolean; remoteDeadlineEnforced: boolean; configSha256?: Record<string, string>; deadline?: string; builds?: { job: string; id: string; sha: string; destinationId: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown'; artifactDigest?: string; healthy: boolean }[] }
}
export interface ReleaseOperation {
  id: string
  logicalKey: string
  grantId: string
  taskId: string
  repository: string
  action: ReleaseAction
  sha: string
  policyDigest: string
  state: 'prepared' | 'dispatching' | 'accepted' | 'succeeded' | 'failed' | 'unknown'
  createdAt: string
  updatedAt: string
  remoteIds: string[]
  detail: string
}
export interface DispatchContext {
  /** Minimum grant/shift expiry and next freeze; must be enforced again at the remote write boundary. */
  deadline: string
  /** Host-owned live revocation check; invoke immediately before every mutation after awaits. Never serialize to Pi. */
  assertAuthorized(): void
  operation: ReleaseOperation
  repository: ReleaseRepository
  scope: ReleaseScope
  grant: ReleaseGrant
  candidate: CandidateEvidence
  snapshot: RemoteSnapshot
  request: ReleaseRequest
}
export interface ReleaseTransport {
  /** GET/read-only only. Must authenticate the same exact identity used by dispatch. No secrets in results. */
  observe(context: { repository: ReleaseRepository; scope: ReleaseScope; request: ReleaseRequest; operation?: ReleaseOperation }, signal: AbortSignal): Promise<RemoteSnapshot>
  /** Exactly one external mutation; no automatic retry. Accepted is not completed. */
  dispatch(context: DispatchContext, signal: AbortSignal): Promise<{ remoteIds: string[]; detail: string }>
}
export interface ReleaseAuthority {
  grant(taskId: string): ReleaseGrant | undefined
  isAuthorized(ownerId: string): boolean
  /** Current night/shift admission; missing means paused/revoked/not running. */
  activeDeadline(taskId: string): string | undefined
  candidate(taskId: string, repository: string, sha: string): Promise<CandidateEvidence>
}
export interface ReleaseResult {
  status: 'blocked' | ReleaseOperation['state']
  operationId?: string
  detail: string
  remoteIds: string[]
  remoteActive: boolean
}
