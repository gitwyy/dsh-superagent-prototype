/** Host-owned release admission. Local shutdown and accepted remote work are deliberately separate facts. */
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { MergePlan, CandidateEvidence, ReleaseGrant, ReleaseOperation, ReleasePolicy, ReleaseRepository, ReleaseRequest, ReleaseResult, ReleaseScope, ReleaseAuthority, ReleaseTransport, RemoteSnapshot } from './contracts.ts'
import { releaseMarker } from './contracts.ts'
import { ReleaseJournal, type ReleaseIntent } from './journal.ts'

const name = z.string().min(1).max(512)
const oid = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const positive = z.number().int().positive().safe()
const action = z.enum(['push', 'create_mr', 'merge', 'deploy'])
const operationAction = z.enum(['push', 'create_mr', 'prepare_merge', 'merge', 'deploy'])
const mergePlanSchema = z.strictObject({ version: z.literal(2), sourceSha: oid, targetSha: oid, expectedTreeSha: oid, ciSha256: sha256, validationProfile: z.literal('full-verify') })
const environment = z.enum(['test', 'preprod'])
const branch = z.string().max(240).regex(/^(?![./-])(?!.*(?:\.\.|@\{|\/\/|[\s~^:?*\[\\]))(?!.*(?:\.lock)(?:\/|$))(?!.*[/.]$)[\w./-]+$/)
const sourceBranch = branch.refine(value => /^(agent|sdd)\//.test(value), 'source must be task-owned agent/ or sdd/ branch')
const dateTime = z.string().refine(value => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  const date = Date.parse(value)
  const local = value.slice(0, 10), normalized = new Date(`${local}T00:00:00Z`)
  return Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60
    && Number.isFinite(date) && Number.isFinite(normalized.getTime()) && normalized.toISOString().slice(0, 10) === local
}, 'explicit-zone ISO timestamp required')
const unique = <T>(values: T[]) => new Set(values).size === values.length
const absolute = name.refine(isAbsolute, 'absolute host path required')
const routeSchema = z.strictObject({ kind: z.literal('jenkins'), id: name, jobs: z.array(name).min(1).refine(unique), origin: z.url(), expectedConfigSha256: z.record(name, sha256), destinationId: name, remoteDeadlineEnforced: z.boolean(), credentialRef: name })
const repositorySchema = z.strictObject({ alias: name, root: absolute, projectId: positive, projectPath: name, host: name, apiOrigin: z.url(), allowInsecureHttp: z.boolean().optional(), expectedUserId: positive, expectedUsername: name, credentialFile: absolute, targetBranch: branch, mergeMode: z.enum(['ff', 'merge-commit']).optional(), ciSha256: sha256, requiredJobs: z.array(name).min(1).refine(unique), mergeTriggersDeploy: z.boolean(), pushHasNoRemoteJobs: z.boolean().optional(), triggerPolicy: z.strictObject({ reviewedAt: dateTime, expiresAt: dateTime, productionExcluded: z.boolean(), fingerprint: name }), environments: z.strictObject({ test: routeSchema.optional(), preprod: routeSchema.optional() }) })
const policySchema = z.strictObject({ version: z.literal(1), enabled: z.boolean(), allowedActions: z.array(action).refine(unique).optional(), repositories: z.record(name, repositorySchema), freezeWindows: z.array(z.strictObject({ from: dateTime, until: dateTime }).refine(window => Date.parse(window.until) > Date.parse(window.from))), maxGrantSeconds: positive.max(43_200) })
const scopeSchema = z.strictObject({ repository: name, sourceBranch, targetBranch: branch, baseSha: oid, environment: environment.optional(), actions: z.array(action).min(1).refine(unique) }).refine(scope => scope.sourceBranch !== scope.targetBranch)
const grantSchema = z.strictObject({ id: name, taskId: name, ownerId: name, approvalMessageId: name, issuedAt: dateTime, expiresAt: dateTime, policyDigest: sha256, scopes: z.array(scopeSchema).min(1).refine(scopes => unique(scopes.map(scope => scope.repository))) })
export { policySchema as ReleasePolicySchema, scopeSchema as ReleaseScopeSchema, grantSchema as ReleaseGrantSchema }
const requestSchema = z.strictObject({ taskId: name, repository: name, action: operationAction, sha: oid, title: z.string().trim().min(1).max(200).optional(), description: z.string().max(20_000).optional() })
const candidateSchema = z.strictObject({ taskId: name, repository: name, sha: oid, treeSha: oid, baseSha: oid, sourceBranch, clean: z.boolean(), commitReceiptId: name, validated: z.boolean(), validationReceiptIds: z.array(name).min(1).refine(unique), ciSha256: sha256, changedProtectedPaths: z.array(name) })
const snapshotSchema = z.strictObject({
  identity: z.strictObject({ id: positive, username: name }),
  project: z.strictObject({ id: positive, path: name, defaultBranch: branch, pipelineRequired: z.boolean(), fastForwardOnly: z.boolean().optional(), mergeMethod: z.enum(['ff', 'merge', 'rebase_merge']).optional() }),
  sourceSha: oid.optional(), targetSha: oid, targetCiSha256: sha256, productionExcluded: z.boolean(), triggerPolicyFingerprint: name,
  mergeRequest: z.strictObject({ iid: positive, sourceProjectId: positive, targetProjectId: positive, sourceBranch: branch, targetBranch: branch, sha: oid, state: z.enum(['opened', 'merged', 'closed']), authorId: positive, draft: z.boolean(), conflicts: z.boolean(), mergeable: z.boolean(), approved: z.boolean(), unresolvedDiscussions: z.number().int().nonnegative(), mergeCommitSha: oid.optional(), mergeCommitVerified: z.boolean().optional(), mergeTreeSha: oid.optional(), mergeParents: z.array(oid).optional(), marker: name }).optional(),
  preparation: z.strictObject({ plan: mergePlanSchema, metadataDigest: sha256, operationId: name, expiresAt: dateTime, verified: z.boolean() }).optional(),
  pipeline: z.strictObject({ id: positive, sha: oid, status: name, jobs: z.array(z.strictObject({ name, status: name, allowFailure: z.boolean() })) }).optional(),
  deployment: z.strictObject({ routeId: name, sourceSha: oid, approvedSourceSha: oid.optional(), mergePlan: mergePlanSchema.optional(), fullVerification: z.strictObject({ sha: oid, treeSha: oid, profile: z.literal('full-verify'), passed: z.boolean() }).optional(), state: z.enum(['absent', 'queued', 'running', 'succeeded', 'failed', 'unknown']), ids: z.array(name).refine(unique), destinationId: name, artifactDigest: name.optional(), healthy: z.boolean(), remoteDeadlineEnforced: z.boolean(), configSha256: z.record(name, sha256).optional(), deadline: dateTime.optional(), awaitingWebhook: z.boolean().optional(), builds: z.array(z.strictObject({ job: name, id: name, sha: oid, destinationId: name, state: z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown']), artifactDigest: name.optional(), healthy: z.boolean() })).optional() }).optional(),
})

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
/** Includes identity, CI/route pins, freeze intervals and deadline policy, not just repository aliases. */
export function policyDigest(policy: ReleasePolicy): string { return digest(policySchema.parse(policy)) }
function requireThat(condition: unknown, detail: string): asserts condition { if (!condition) throw new Error(detail) }
const now = () => new Date().toISOString()
const blocked = (detail: string, remoteActive = false): ReleaseResult => ({ status: 'blocked', detail, remoteIds: [], remoteActive })
const operationResult = (intent: ReleaseIntent): ReleaseResult => ({ status: intent.operation.state, operationId: intent.operation.id, detail: intent.operation.detail, remoteIds: [...intent.operation.remoteIds], remoteActive: intent.remoteActive })
interface Admission { grant: ReleaseGrant; scope: ReleaseScope; repository: ReleaseRepository; deadline: string }
export interface ReleaseCoordinator {
  execute(request: ReleaseRequest, signal: AbortSignal): Promise<ReleaseResult>
  prepareMerge(request: Pick<ReleaseRequest, 'taskId' | 'repository' | 'sha'>, signal: AbortSignal): Promise<ReleaseResult>
  reconcile(operationId: string, signal: AbortSignal): Promise<ReleaseResult>
  operations(taskId?: string): ReleaseOperation[]
  remoteActive(taskId?: string): boolean
  close(): Promise<void>
}
export function createReleaseCoordinator(policy: ReleasePolicy, dbPath: string, authority: ReleaseAuthority, transport: ReleaseTransport): ReleaseCoordinator {
  return new Coordinator(policy, dbPath, authority, transport)
}

/** Serializes release mutations and persists their uncertainty before any transport side effect can begin. */
class Coordinator implements ReleaseCoordinator {
  private readonly policy: ReleasePolicy
  private readonly digest: string
  private readonly journal: ReleaseJournal
  private serial: Promise<void> = Promise.resolve()
  private readonly stopping = new AbortController()
  private closing = false
  private closed = false
  private closePromise?: Promise<void>
  private fault = false
  private readonly volatile = new Map<string, ReleaseIntent>()
  private closedOperations: ReleaseOperation[] = []
  private closedActiveTasks: string[] = []

  constructor(policy: ReleasePolicy, dbPath: string, private readonly authority: ReleaseAuthority, private readonly transport: ReleaseTransport) {
    this.policy = policySchema.parse(structuredClone(policy))
    this.digest = policyDigest(this.policy)
    for (const [alias, repository] of Object.entries(this.policy.repositories)) {
      requireThat(repository.alias === alias, 'Repository alias does not match policy key')
      const origin = new URL(repository.apiOrigin)
      requireThat(origin.origin === repository.apiOrigin && !origin.username && !origin.password && origin.host === repository.host, 'API origin/host must be exact and credential-free')
      requireThat(origin.protocol === 'https:' || (origin.protocol === 'http:' && repository.allowInsecureHttp === true), 'HTTPS required without explicit insecure transport consent')
      for (const route of Object.values(repository.environments)) {
        const url = new URL(route.origin)
        requireThat(url.origin === route.origin && !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && repository.allowInsecureHttp === true)), 'Deployment route origin is not explicitly admitted')
        requireThat(canonical(Object.keys(route.expectedConfigSha256).sort()) === canonical([...route.jobs].sort()), 'Every exact deployment job must have a configuration hash')
      }
    }
    this.journal = new ReleaseJournal(dbPath)
    this.fault = this.journal.localWriterUnknown()
  }
  private schedule<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work)
    this.serial = result.then(() => {}, () => {})
    return result
  }
  private records(): ReleaseIntent[] {
    const rows = new Map(this.journal.intents().map(intent => [intent.operation.id, intent]))
    for (const [id, intent] of this.volatile) rows.set(id, structuredClone(intent))
    return [...rows.values()]
  }
  operations(taskId?: string): ReleaseOperation[] {
    const rows = this.closed ? this.closedOperations : this.records().map(intent => intent.operation)
    return structuredClone(rows.filter(operation => !taskId || operation.taskId === taskId))
  }
  remoteActive(taskId?: string): boolean {
    if (this.fault) return true // Also an unresolved local merge-object writer: never acknowledge safe handoff.
    const tasks = this.closed ? this.closedActiveTasks : this.records().filter(intent => intent.remoteActive).map(intent => intent.operation.taskId)
    return taskId ? tasks.includes(taskId) : tasks.length > 0
  }
  private active(repository?: string): boolean { return this.records().some(intent => (!repository || intent.operation.repository === repository) && intent.remoteActive) }
  private grant(request: ReleaseRequest, signal: AbortSignal, previous?: Admission): Admission {
    requireThat(!this.closing && !this.fault && !signal.aborted && this.policy.enabled, 'Release dispatch is disabled, stopping, aborted or storage-faulted')
    const authorizedAction = request.action === 'prepare_merge' ? 'merge' : request.action
    requireThat(this.policy.allowedActions === undefined || this.policy.allowedActions.includes(authorizedAction), 'This release action is temporarily disabled by the operator policy')
    const grant = grantSchema.parse(this.authority.grant(request.taskId))
    requireThat(grant.taskId === request.taskId && grant.policyDigest === this.digest && this.authority.isAuthorized(grant.ownerId) === true, 'Task owner/grant/policy authorization no longer matches')
    const time = Date.now(), issued = Date.parse(grant.issuedAt), expires = Date.parse(grant.expiresAt)
    requireThat(issued <= time && expires > time && expires > issued && expires - issued <= this.policy.maxGrantSeconds * 1000, 'Release grant is expired, future-dated or exceeds its maximum duration')
    const activeDeadline = dateTime.parse(this.authority.activeDeadline(request.taskId))
    requireThat(Date.parse(activeDeadline) > time, 'Task is inactive or its writer/shift deadline expired')
    for (const window of this.policy.freezeWindows) requireThat(!(Date.parse(window.from) <= time && time < Date.parse(window.until)), 'Release mutations are frozen')
    const deadline = new Date(Math.min(expires, Date.parse(activeDeadline), ...this.policy.freezeWindows.filter(window => Date.parse(window.from) > time).map(window => Date.parse(window.from)))).toISOString()
    const scope = grant.scopes.find(item => item.repository === request.repository)
    const repository = this.policy.repositories[request.repository]
    requireThat(scope && repository && scope.actions.includes(authorizedAction) && scope.targetBranch === repository.targetBranch, 'Exact repository/action/target scope is missing')
    requireThat(repository.triggerPolicy.productionExcluded === true && Date.parse(repository.triggerPolicy.reviewedAt) <= time && Date.parse(repository.triggerPolicy.expiresAt) > time, 'Production exclusion/trigger-policy attestation is absent or expired')
    if (authorizedAction === 'deploy' || (authorizedAction === 'merge' && repository.mergeTriggersDeploy)) {
      requireThat((this.policy.allowedActions === undefined || this.policy.allowedActions.includes('deploy')) && scope.actions.includes('deploy') && scope.environment && repository.environments[scope.environment], 'Deploy action/environment/route must be explicitly preauthorized')
    }
    if (previous) requireThat(canonical(previous.grant) === canonical(grant), 'Grant was replaced or modified while evidence was pending')
    return { grant, scope, repository, deadline }
  }
  private async candidate(request: ReleaseRequest, admission: Admission): Promise<CandidateEvidence> {
    const evidence = candidateSchema.parse(await this.authority.candidate(request.taskId, request.repository, request.sha))
    requireThat(evidence.taskId === request.taskId && evidence.repository === request.repository && evidence.sha === request.sha
      && evidence.baseSha === admission.scope.baseSha && evidence.sourceBranch === admission.scope.sourceBranch
      && evidence.clean === true && evidence.validated === true && evidence.changedProtectedPaths.length === 0
      && evidence.ciSha256 === admission.repository.ciSha256, 'Candidate receipt/head/tree/lineage/validation/CI evidence does not match the exact authorized source')
    return evidence
  }
  private common(snapshot: RemoteSnapshot, repository: ReleaseRepository): void {
    requireThat(snapshot.identity.id === repository.expectedUserId && snapshot.identity.username === repository.expectedUsername, 'Remote identity numeric ID/username mismatch')
    requireThat(snapshot.project.id === repository.projectId && snapshot.project.path === repository.projectPath && snapshot.project.defaultBranch === repository.targetBranch && snapshot.project.pipelineRequired === true, 'Remote project identity/default branch/pipeline requirement mismatch')
    requireThat(snapshot.targetCiSha256 === repository.ciSha256 && snapshot.productionExcluded === true && snapshot.triggerPolicyFingerprint === repository.triggerPolicy.fingerprint, 'Remote CI or production exclusion attestation drifted')
  }
  private mr(snapshot: RemoteSnapshot, request: ReleaseRequest, scope: ReleaseScope, repository: ReleaseRepository): NonNullable<RemoteSnapshot['mergeRequest']> {
    const mr = snapshot.mergeRequest
    requireThat(mr && mr.sourceProjectId === repository.projectId && mr.targetProjectId === repository.projectId
      && mr.sourceBranch === scope.sourceBranch && mr.targetBranch === scope.targetBranch && mr.sha === request.sha
      && mr.authorId === repository.expectedUserId && mr.marker === releaseMarker(request.taskId, request.repository, request.sha), 'MR identity/source/target/head/owner/marker mismatch')
    return mr
  }
  private pipeline(snapshot: RemoteSnapshot, request: ReleaseRequest, repository: ReleaseRepository): void {
    const pipeline = snapshot.pipeline
    requireThat(pipeline && pipeline.sha === request.sha && pipeline.status === 'success', 'Required pipeline is not successful for the exact candidate SHA')
    for (const name of repository.requiredJobs) {
      const matches = pipeline.jobs.filter(job => job.name === name)
      requireThat(matches.length === 1 && matches[0]!.status === 'success' && matches[0]!.allowFailure === false, `Required job is missing, ambiguous or not a strict success: ${name}`)
    }
  }
  private preparation(snapshot: RemoteSnapshot, intent: ReleaseIntent, current: boolean): NonNullable<RemoteSnapshot['preparation']> {
    const preparation = snapshot.preparation
    requireThat(intent.operation.mergePlan && preparation?.verified === true && preparation.operationId === intent.operation.id
      && canonical(preparation.plan) === canonical(intent.operation.mergePlan) && Date.parse(preparation.expiresAt) <= Date.parse(intent.deadline)
      && (!intent.preparationDigest || preparation.metadataDigest === intent.preparationDigest)
      && (!intent.preparationExpiresAt || preparation.expiresAt === intent.preparationExpiresAt), 'Immutable merge preparation metadata does not match its durable intent')
    if (current) requireThat(intent.operation.state === 'succeeded' && !intent.remoteActive && !!intent.preparationDigest
      && Date.parse(preparation.expiresAt) > Date.now() && snapshot.targetSha === intent.operation.mergePlan.targetSha, 'Prepared target/deadline is stale; a new explicit task/grant is required')
    return preparation
  }
  private merged(snapshot: RemoteSnapshot, request: ReleaseRequest, admission: Admission, candidate: CandidateEvidence, plan?: MergePlan): string | undefined {
    const mr = this.mr(snapshot, request, admission.scope, admission.repository)
    if (mr.state !== 'merged' || mr.mergeCommitVerified !== true || !mr.mergeCommitSha || snapshot.targetSha !== mr.mergeCommitSha) return undefined
    if (admission.repository.mergeMode === 'merge-commit') {
      if (!plan || snapshot.project.mergeMethod !== 'merge' || canonical(mr.mergeParents) !== canonical([plan.targetSha, plan.sourceSha])
        || mr.mergeTreeSha !== plan.expectedTreeSha || plan.sourceSha !== request.sha || plan.ciSha256 !== admission.repository.ciSha256) return undefined
    } else if (snapshot.project.fastForwardOnly !== true || mr.mergeCommitSha !== request.sha || mr.mergeTreeSha !== candidate.treeSha) return undefined
    return mr.mergeCommitSha
  }
  private route(snapshot: RemoteSnapshot, request: ReleaseRequest, admission: Admission, requireAbsent: boolean, candidate: CandidateEvidence, plan?: MergePlan): void {
    const { repository, scope, deadline } = admission
    const route = scope.environment && repository.environments[scope.environment]
    const deployment = snapshot.deployment
    const ordinary = repository.mergeMode === 'merge-commit'
    const deployedSha = requireAbsent ? request.sha : this.merged(snapshot, request, admission, candidate, plan)
    requireThat(deployedSha, 'Exact merged commit parents/tree/target proof is unavailable')
    if (ordinary) requireThat(plan && deployment?.approvedSourceSha === request.sha && canonical(deployment.mergePlan) === canonical(plan), 'Deployment must bind approved source S to immutable merged plan')
    requireThat(scope.actions.includes('deploy') && route && route.remoteDeadlineEnforced === true && deployment
      && deployment.routeId === route.id && deployment.destinationId === route.destinationId && deployment.sourceSha === deployedSha
      && deployment.remoteDeadlineEnforced === true && deployment.configSha256
      && canonical(deployment.configSha256) === canonical(route.expectedConfigSha256)
      && deployment.deadline && Date.parse(deployment.deadline) <= Date.parse(deadline), 'Exact deployment route/config/destination/remote deadline evidence is missing')
    if (requireAbsent) requireThat(deployment.state === 'absent' && deployment.ids.length === 0 && Date.parse(deployment.deadline) > Date.now(), 'Deployment was already dispatched or remote deadline is expired')
    else if (deployment.state !== 'absent') {
      requireThat(deployment.builds && deployment.builds.length === deployment.ids.length && unique(deployment.builds.map(build => build.job))
        && deployment.builds.every(build => route.jobs.includes(build.job) && build.sha === deployedSha && build.destinationId === route.destinationId)
        && canonical(deployment.builds.map(build => build.id).sort()) === canonical([...deployment.ids].sort()), 'Deployment sibling job/build/SHA/destination mapping is incomplete or conflicting')
      if (deployment.awaitingWebhook === true) {
        const mr = this.mr(snapshot, request, scope, repository)
        requireThat(deployment.state === 'unknown' && !deployment.healthy && deployment.builds.length < route.jobs.length
          && deployment.builds.every(build => ['queued', 'running', 'succeeded'].includes(build.state)) && Date.parse(deployment.deadline) > Date.now()
          && mr.state === 'merged' && mr.sha === request.sha && mr.mergeCommitSha === deployedSha
          && mr.mergeCommitVerified === true && snapshot.targetSha === deployedSha, 'Webhook wait is not backed by exact merged identity and an unexpired signed deadline')
      } else requireThat(canonical(deployment.builds.map(build => build.job).sort()) === canonical([...route.jobs].sort()), 'Deployment evidence does not cover every exact configured sibling job')
    }
  }
  private preconditions(snapshot: RemoteSnapshot, request: ReleaseRequest, admission: Admission, candidate: CandidateEvidence, plan?: MergePlan, preparation?: ReleaseIntent): void {
    this.common(snapshot, admission.repository)
    const { scope, repository } = admission
    const ordinary = repository.mergeMode === 'merge-commit'
    if (request.action === 'merge' && !ordinary) requireThat(snapshot.targetSha === scope.baseSha, 'Target branch drifted from the explicitly admitted base')
    if (request.action === 'push') {
      requireThat(!snapshot.sourceSha || snapshot.sourceSha === scope.baseSha, 'Remote source frontier is unrelated/already published; no overwrite, force-push or unjournaled replay allowed')
      return
    }
    requireThat(snapshot.sourceSha === request.sha, 'Remote source ref is not the exact validated candidate')
    if (request.action === 'create_mr') {
      requireThat(!snapshot.mergeRequest, 'An MR already exists; do not create or adopt an unjournaled duplicate')
      requireThat(!!request.title, 'MR creation requires a bounded explicit title')
      return
    }
    requireThat(ordinary ? snapshot.project.mergeMethod === 'merge' : snapshot.project.fastForwardOnly === true, 'Remote project merge mode differs from the pinned policy')
    const mr = this.mr(snapshot, request, scope, repository)
    this.pipeline(snapshot, request, repository)
    if (request.action === 'merge' || request.action === 'prepare_merge') {
      requireThat(mr.state === 'opened' && !mr.draft && !mr.conflicts && mr.mergeable === true && mr.approved === true && mr.unresolvedDiscussions === 0, 'MR is not freshly approved, conflict-free, discussion-resolved and immediately mergeable')
      if (request.action === 'prepare_merge') requireThat(ordinary, 'Internal merge preparation is only supported for pinned ordinary merge mode')
      if (plan) requireThat(plan.sourceSha === request.sha && plan.targetSha === snapshot.targetSha && plan.ciSha256 === repository.ciSha256, 'Merge-plan source/target/CI drift; do not refresh or re-sign automatically')
      if (request.action === 'merge' && ordinary) {
        requireThat(preparation && plan, 'Ordinary merge requires a verified separately journaled preparation')
        this.preparation(snapshot, preparation, true)
      }
      if (request.action === 'merge' && repository.mergeTriggersDeploy) this.route(snapshot, request, admission, true, candidate, plan)
    } else {
      requireThat(this.merged(snapshot, request, admission, candidate, plan), 'Deployment requires verified exact merged parents/tree/target')
      requireThat(repository.mergeTriggersDeploy && scope.actions.includes('merge'), 'Deploy is observation-only for a previously authorized webhook-triggering merge')
      this.route(snapshot, request, admission, false, candidate, plan)
      requireThat(snapshot.deployment!.awaitingWebhook !== true && snapshot.deployment!.state !== 'absent' && snapshot.deployment!.ids.length > 0, 'All exact webhook-created deployment IDs must be available before adoption')
    }
  }

  prepareMerge(request: Pick<ReleaseRequest, 'taskId' | 'repository' | 'sha'>, signal: AbortSignal): Promise<ReleaseResult> {
    return this.execute({ ...request, action: 'prepare_merge' }, signal)
  }
  execute(raw: ReleaseRequest, signal: AbortSignal): Promise<ReleaseResult> {
    let request: ReleaseRequest
    try { request = requestSchema.parse(structuredClone(raw)) } catch { return Promise.resolve(blocked('Release request is malformed; no side effect dispatched')) }
    const combined = AbortSignal.any([signal, this.stopping.signal])
    return this.schedule(async () => {
      if (this.closed) return blocked('Release coordinator is closed', true)
      let intent: ReleaseIntent | undefined
      let sent = false
      try {
        const suppliedGrant = grantSchema.safeParse(this.authority.grant(request.taskId))
        if (suppliedGrant.success) {
          const prior = this.records().find(intent => intent.operation.taskId === request.taskId && intent.operation.grantId === suppliedGrant.data.id && intent.operation.repository === request.repository && intent.operation.action === request.action && intent.operation.sha === request.sha)
          if (prior) return operationResult(prior)
        }
        let admission = this.grant(request, combined)
        let key = digest({ taskId: request.taskId, grantId: admission.grant.id, action: request.action, repository: request.repository, sha: request.sha })
        const matches = (row: ReleaseIntent) => row.operation.taskId === request.taskId && row.operation.grantId === admission.grant.id && row.operation.repository === request.repository && row.operation.sha === request.sha
        const rows = this.records(), ordinary = admission.repository.mergeMode === 'merge-commit'
        const parentMerge = request.action === 'deploy' ? rows.find(row => matches(row) && row.operation.action === 'merge' && ['accepted', 'succeeded', 'unknown'].includes(row.operation.state)) : undefined
        requireThat(request.action !== 'deploy' || parentMerge, 'Deployment adoption requires the exact same task/grant/SHA journaled merge')
        if (request.action === 'prepare_merge') requireThat(ordinary && !rows.some(row => matches(row) && row.operation.action === 'merge'), 'Preparation cannot follow a merge attempt or use legacy FF policy')
        const preparation = ordinary && ['merge', 'deploy'].includes(request.action)
          ? rows.find(row => matches(row) && row.operation.action === 'prepare_merge') : undefined
        if (ordinary && request.action === 'merge') requireThat(preparation?.operation.state === 'succeeded' && !preparation.remoteActive && preparation.operation.mergePlan, 'A separately readback-verified preparation is required before ordinary merge')
        requireThat(!rows.some(row => row.remoteActive && row.operation.repository === request.repository && row.operation.id !== parentMerge?.operation.id), 'Repository has unresolved or active remote effects; reconcile them before dispatching another action')
        let candidate = await this.candidate(request, admission)
        admission = this.grant(request, combined, admission)
        let plan = request.action === 'deploy' ? parentMerge?.operation.mergePlan : preparation?.operation.mergePlan
        const operation: ReleaseOperation = { id: randomUUID(), logicalKey: key, grantId: admission.grant.id, taskId: request.taskId, repository: request.repository, action: request.action, sha: request.sha,
          ...(plan ? { mergePlan: structuredClone(plan), preparationId: request.action === 'deploy' ? parentMerge!.operation.preparationId : preparation!.operation.id } : {}),
          policyDigest: this.digest, state: 'prepared', createdAt: now(), updatedAt: now(), remoteIds: [], detail: '已记录远端操作意图，尚未派发。' }
        const observe = () => this.transport.observe({ repository: structuredClone(admission.repository), scope: structuredClone(admission.scope), request: structuredClone(request), operation: structuredClone(operation) }, combined)
        let snapshot = snapshotSchema.parse(await observe())
        admission = this.grant(request, combined, admission)
        if (request.action === 'prepare_merge') {
          this.preconditions(snapshot, request, admission, candidate)
          requireThat(this.transport.planMerge, 'Host merge-object planner is unavailable')
          plan = mergePlanSchema.parse(await this.transport.planMerge({ repository: structuredClone(admission.repository), scope: structuredClone(admission.scope), request: structuredClone(request), candidate: structuredClone(candidate), snapshot: structuredClone(snapshot) }, combined))
          admission = this.grant(request, combined, admission)
          requireThat(plan.sourceSha === request.sha && plan.targetSha === snapshot.targetSha && plan.ciSha256 === admission.repository.ciSha256, 'Planner did not bind exact source/target/CI')
          key = digest({ taskId: request.taskId, grantId: admission.grant.id, action: request.action, repository: request.repository, sha: request.sha, targetSha: plan.targetSha, expectedTreeSha: plan.expectedTreeSha, policyDigest: this.digest })
          operation.logicalKey = key; operation.mergePlan = structuredClone(plan)
          snapshot = snapshotSchema.parse(await observe()) // Recheck T after asynchronous Git object preparation, never re-plan.
          admission = this.grant(request, combined, admission)
        }
        const rechecked = await this.candidate(request, admission)
        requireThat(canonical(candidate) === canonical(rechecked), 'Candidate receipt changed while remote evidence was pending')
        candidate = rechecked
        admission = this.grant(request, combined, admission)
        this.preconditions(snapshot, request, admission, candidate, plan, preparation)
        intent = { operation, request, repository: admission.repository, grant: admission.grant, scope: admission.scope, candidate, deadline: admission.deadline, remoteActive: false }
        this.journal.atomic(() => this.journal.insert(intent!))
        admission = this.grant(request, combined, admission)
        this.preconditions(snapshot, request, admission, candidate, plan, preparation)
        intent.deadline = admission.deadline
        if (request.action === 'deploy') {
          const actualMergedSha = snapshot.mergeRequest!.mergeCommitSha!
          requireThat(!parentMerge!.mergedSha || parentMerge!.mergedSha === actualMergedSha, 'Deployment cannot switch the already verified actual merged commit')
          intent.mergedSha = actualMergedSha
          const builds = Object.fromEntries(snapshot.deployment!.builds!.map(build => [build.job, build.id]))
          if (parentMerge!.deploymentIds) requireThat(parentMerge!.deploymentIds.every(id => snapshot.deployment!.ids.includes(id)) && Object.entries(parentMerge!.deploymentBuilds ?? {}).every(([job, id]) => builds[job] === id), 'Webhook deployment IDs/job mapping changed from the parent merge observation')
          intent.deploymentIds = [...snapshot.deployment!.ids]; intent.deploymentBuilds = builds
          // Merge already triggered the webhook. Deploy permission permits observing/adopting it, never a second trigger.
          intent.operation.state = 'accepted'; intent.operation.remoteIds = [...snapshot.deployment!.ids]; intent.remoteActive = true
          intent.operation.updatedAt = now(); intent.operation.detail = '已接管对应合并触发的部署核查；未新增触发，尚未证明完成。'
          this.journal.atomic(() => this.journal.save(intent!))
          return operationResult(intent)
        }
        intent.operation.state = 'dispatching'; intent.operation.updatedAt = now(); intent.operation.detail = '远端派发中；本地停止不代表远端停止。'; intent.remoteActive = true
        this.journal.atomic(() => this.journal.save(intent!))
        // No await between final live authorization and the one allowed external mutation.
        sent = true
        const accepted = await this.transport.dispatch({ ...structuredClone(admission), assertAuthorized: () => {
          this.journal.assertOwned()
          const live = this.grant(request, combined, admission)
          requireThat(Date.parse(live.deadline) >= Date.parse(intent!.deadline), 'Live task/shift deadline was shortened after dispatch preparation')
        }, operation: structuredClone(intent.operation), request: structuredClone(request), candidate: structuredClone(candidate), snapshot: structuredClone(snapshot) }, combined)
        requireThat(accepted && Array.isArray(accepted.remoteIds) && accepted.remoteIds.every(id => typeof id === 'string' && id.length > 0) && unique(accepted.remoteIds) && typeof accepted.detail === 'string', 'Malformed dispatch acceptance; remote effect unknown')
        intent.operation.state = 'accepted'; intent.operation.remoteIds = [...accepted.remoteIds]; intent.operation.updatedAt = now()
        intent.operation.detail = '远端已接受；尚未证明操作或部署完成。'
        this.journal.atomic(() => this.journal.save(intent!))
        return operationResult(intent)
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'NIGHTSHIFT_WRITER_UNKNOWN') {
          this.fault = true
          try { this.journal.markLocalWriterUnknown() } catch { /* Keep in-memory fault; transport retains its durable namespace marker. */ }
          throw error // Local planner process ownership must remain leased; never downgrade to a safe blocked result.
        }
        if (!intent) return blocked(error instanceof z.ZodError ? 'Malformed or incomplete release evidence' : error instanceof Error ? error.message : 'Release admission failed', this.active(request.repository))
        const uncertain = sent || (request.action === 'deploy' && this.active(request.repository))
        intent.operation.state = uncertain ? 'unknown' : 'failed'; intent.remoteActive = uncertain; intent.operation.updatedAt = now()
        intent.operation.detail = uncertain ? '远端派发或已有部署接管期间证据/持久化中断，结果 unknown；禁止重试，只能核查。' : '派发前检查/持久化失败，未发送远端操作。'
        try { this.journal.atomic(() => this.journal.save(intent!)) }
        catch { this.fault = true; this.volatile.set(intent.operation.id, structuredClone(intent)) }
        return operationResult(intent)
      }
    })
  }

  reconcile(operationId: string, signal: AbortSignal): Promise<ReleaseResult> {
    const combined = AbortSignal.any([signal, this.stopping.signal])
    return this.schedule(async () => {
      if (this.closed || this.closing || combined.aborted || this.fault) return blocked('Read-only reconciliation is stopped or requires local writer recovery', true)
      const intent = this.volatile.get(operationId) ?? this.journal.get(operationId)
      if (!intent) return blocked('Unknown release operation ID')
      // Sealed completion is historical evidence, not a claim about today's target/environment.
      // New mutations still require fresh target/CI/route evidence; never resurrect completed effects.
      if (['succeeded', 'failed'].includes(intent.operation.state) && !intent.remoteActive) return operationResult(intent)
      try {
        // Reconciliation uses the immutable original context and never needs a renewed mutation grant.
        const observedOperation = structuredClone(intent.operation)
        if (intent.repository.mergeMode === 'merge-commit' && !observedOperation.mergePlan) {
          const priorPreparation = this.records().find(row => row.operation.action === 'prepare_merge' && row.operation.taskId === intent.operation.taskId
            && row.operation.grantId === intent.operation.grantId && row.operation.repository === intent.operation.repository && row.operation.sha === intent.operation.sha
            && row.operation.state === 'succeeded' && row.operation.mergePlan && row.preparationDigest)
          if (priorPreparation) { observedOperation.mergePlan = structuredClone(priorPreparation.operation.mergePlan!); observedOperation.preparationId = priorPreparation.operation.id }
        }
        const snapshot = snapshotSchema.parse(await this.transport.observe({ repository: structuredClone(intent.repository), scope: structuredClone(intent.scope), request: structuredClone(intent.request), operation: observedOperation }, combined))
        requireThat(!combined.aborted && !this.closing, 'Read-only reconciliation was interrupted')
        this.common(snapshot, intent.repository)
        const { request, repository, scope } = intent
        let proved = false, failed = false, remoteActive = true
        const pipelineActive = !snapshot.pipeline
          ? !(request.action === 'push' && repository.pushHasNoRemoteJobs === true)
          : snapshot.pipeline.sha !== request.sha || !['success', 'failed', 'canceled', 'skipped'].includes(snapshot.pipeline.status)
        const pinDeployment = () => {
          const deployment = snapshot.deployment!
          if (deployment.state === 'absent') return
          const builds = Object.fromEntries(deployment.builds!.map(build => [build.job, build.id]))
          if (intent.deploymentBuilds) requireThat(Object.entries(intent.deploymentBuilds).every(([job, id]) => builds[job] === id), 'Previously observed webhook job disappeared or changed IDs; a retry/replacement is not the admitted operation')
          if (intent.deploymentIds) requireThat(intent.deploymentIds.every(id => deployment.ids.includes(id)), 'Previously observed webhook build IDs disappeared')
          // A partial sibling set may grow monotonically, but no known job/ID can disappear or be replaced.
          intent.deploymentIds = [...deployment.ids]; intent.deploymentBuilds = builds
        }
        const deployed = () => {
          const deployment = snapshot.deployment!
          const ready = deployment.state === 'succeeded' && deployment.healthy === true && !!deployment.builds?.length
            && deployment.builds.every(build => build.state === 'succeeded' && build.healthy === true && /^sha256:[a-f0-9]{64}$/.test(build.artifactDigest ?? ''))
          if (ready && repository.mergeMode === 'merge-commit') requireThat(deployment.fullVerification?.passed === true
            && deployment.fullVerification.sha === deployment.sourceSha && deployment.fullVerification.treeSha === intent.operation.mergePlan?.expectedTreeSha
            && deployment.fullVerification.profile === 'full-verify', 'Actual merged commit M lacks successful full verification before deployment')
          return ready
        }
        if (request.action === 'prepare_merge') {
          this.mr(snapshot, request, scope, repository)
          const proof = this.preparation(snapshot, intent, false)
          intent.preparationDigest = proof.metadataDigest; intent.preparationExpiresAt = proof.expiresAt
          intent.operation.state = 'succeeded'; intent.remoteActive = false; intent.operation.updatedAt = now()
          intent.operation.detail = '已核实独立合并准备元数据；这不代表合并或部署完成，目标变更将阻止合并。'
          this.journal.atomic(() => this.journal.save(intent)); this.volatile.delete(operationId)
          return operationResult(intent)
        }
        if (request.action === 'push') proved = snapshot.sourceSha === request.sha
        else if (request.action === 'create_mr') { const mr = this.mr(snapshot, request, scope, repository); proved = ['opened', 'merged', 'closed'].includes(mr.state) }
        else if (request.action === 'merge') {
          const mr = this.mr(snapshot, request, scope, repository)
          const mergedSha = this.merged(snapshot, request, { repository, scope, grant: intent.grant, deadline: intent.deadline }, intent.candidate, intent.operation.mergePlan)
          proved = !!mergedSha
          if (mr.state === 'merged' && repository.mergeMode === 'merge-commit') requireThat(mergedSha, 'Actual ordinary merge parents/tree differ from the immutable prepared plan')
          if (mergedSha) { requireThat(!intent.mergedSha || intent.mergedSha === mergedSha, 'Actual merged commit changed for this logical source operation'); intent.mergedSha = mergedSha }
          if (snapshot.deployment?.awaitingWebhook) requireThat(proved && repository.mergeTriggersDeploy, 'Webhook wait cannot replace verified merged source/tree evidence')
          if (proved && repository.mergeTriggersDeploy) {
            this.route(snapshot, request, { repository, scope, grant: intent.grant, deadline: intent.deadline }, false, intent.candidate, intent.operation.mergePlan)
            pinDeployment()
            proved = deployed()
            failed = snapshot.deployment!.state === 'failed' || snapshot.deployment!.builds?.some(build => build.state === 'failed') === true
          }
        } else {
          this.route(snapshot, request, { repository, scope, grant: intent.grant, deadline: intent.deadline }, false, intent.candidate, intent.operation.mergePlan)
          const deployment = snapshot.deployment!
          requireThat(!intent.mergedSha || deployment.sourceSha === intent.mergedSha, 'Deployment readback changed the immutable actual merged commit')
          requireThat(deployment.ids.length > 0 && (intent.operation.remoteIds.length === 0 || intent.operation.remoteIds.every(id => deployment.ids.includes(id))), 'Deployment readback is not linked to the originally accepted remote IDs')
          pinDeployment()
          proved = deployed()
          failed = deployment.state === 'failed' || deployment.builds?.some(build => build.state === 'failed') === true
          if (intent.operation.remoteIds.length === 0) intent.operation.remoteIds = [...deployment.ids]
        }
        if (failed) proved = false
        if (proved) remoteActive = pipelineActive
        // A configured environment can produce a provisional unknown route before any merge exists.
        // That is not deployment activity belonging to a push/MR; their own pipeline still gates progress.
        const deploymentRelevant = request.action === 'merge' || request.action === 'deploy'
          || (!!snapshot.deployment?.ids.length && this.records().some(other => other.operation.action === 'merge'
            && other.operation.taskId === intent.operation.taskId && other.operation.grantId === intent.operation.grantId
            && other.operation.repository === request.repository && other.operation.sha === request.sha
            && (['dispatching', 'accepted', 'succeeded', 'unknown'].includes(other.operation.state) || other.remoteActive)))
        if (deploymentRelevant && snapshot.deployment && ['queued', 'running', 'unknown', 'failed'].includes(snapshot.deployment.state)) remoteActive = true
        intent.operation.state = failed ? 'failed' : proved ? 'succeeded' : intent.operation.state === 'accepted' ? 'accepted' : 'unknown'
        intent.remoteActive = remoteActive
        intent.operation.updatedAt = now()
        intent.operation.detail = failed ? '远端部署失败；可能已产生部分影响，不能认定安全或自动重试。' : proved ? (remoteActive ? '已核实该操作完成，但远端流水线/部署仍活动或未证明停止。' : '已核实该操作及已观察远端活动终态。') : '只读核查尚未证明最终结果；不重试远端操作。'
        this.journal.atomic(() => this.journal.save(intent))
        this.volatile.delete(operationId)
        return operationResult(intent)
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'NIGHTSHIFT_WRITER_UNKNOWN') {
          this.fault = true
          try { this.journal.markLocalWriterUnknown() } catch { /* Transport recovery marker is retained independently. */ }
          throw error
        }
        intent.operation.state = 'unknown'; intent.remoteActive = true; intent.operation.updatedAt = now(); intent.operation.detail = '只读核查证据缺失/冲突；远端结果 unknown，禁止自动重试。'
        try { this.journal.atomic(() => this.journal.save(intent)) }
        catch { this.fault = true; this.volatile.set(intent.operation.id, structuredClone(intent)) }
        return operationResult(intent)
      }
    })
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.stopping.abort()
    return this.closePromise = (async () => {
      // A transport that ignores abort keeps ownership reserved rather than racing a closed database.
      await this.serial
      const records = this.records()
      this.closedOperations = records.map(intent => intent.operation)
      this.closedActiveTasks = [...new Set(records.filter(intent => intent.remoteActive).map(intent => intent.operation.taskId))]
      this.journal.close()
      this.closed = true
    })()
  }
}
