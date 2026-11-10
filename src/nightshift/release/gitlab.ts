import { createHash } from 'node:crypto'
import type { DispatchContext, ReleaseRepository, ReleaseRequest, ReleaseScope, ReleaseTransport, RemoteSnapshot } from './contracts.ts'
import { createGitPushTransport, isSha, readLocalCommitEvidence, readReleaseCredential, releaseOrigin, validSourceBranch, type GitPushOptions, type GitPushRequest, type ReleaseCredential } from './git-transport.ts'

/** API references (read against GitLab REST v4; unsupported evidence fails closed):
 * https://docs.gitlab.com/api/merge_requests/ (sha CAS, FF merge, source branch filters)
 * https://docs.gitlab.com/api/merge_request_approvals/ (approvals/current rules)
 * https://docs.gitlab.com/api/discussions/ (paginated resolvable discussion notes)
 * https://docs.gitlab.com/api/pipelines/ and /api/jobs/ (exact pipeline SHA/jobs)
 * https://docs.gitlab.com/api/repository_files/ (raw reviewed CI at immutable ref)
 * A local operator attestation covers external triggers; these APIs cannot prove
 * Jenkins destination isolation. No deployment success is inferred here.
 */
export interface GitlabTransportOptions {
  tempRoot: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxBodyBytes?: number
  /** Test seams, not policy/model capabilities. */
  push?: (request: GitPushRequest) => Promise<{ remoteIds: string[]; detail: string }>
  runGit?: GitPushOptions['runGit']
  /** Host-owned signed deployment metadata, never accepted from model descriptions. */
  deploymentTickets?: {
    metadata(context: DispatchContext): Promise<string>
    verify(context: DispatchContext, description: string): Promise<void>
  }
}
type Json = Record<string, any>
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const text = (value: unknown): value is string => typeof value === 'string'
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function reject(message: string): never { throw new Error(message) }
export function releaseMarker(taskId: string, repository: string, sha: string): string {
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(taskId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(repository) || !isSha(sha)) reject('Invalid release marker scope')
  return `nightshift:${taskId}:${repository}:${sha}`
}
function contextValid(repository: ReleaseRepository, scope: ReleaseScope, request: ReleaseRequest) {
  releaseOrigin(repository)
  releaseMarker(request.taskId, request.repository, request.sha)
  if (repository.alias !== request.repository || scope.repository !== repository.alias || scope.targetBranch !== repository.targetBranch || !validSourceBranch(scope.sourceBranch) || scope.sourceBranch === scope.targetBranch || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,180}$/.test(scope.targetBranch) || scope.targetBranch.includes('..') || !isSha(scope.baseSha)) reject('Release route or exact branch scope mismatch')
}

/** Fixed-origin bounded REST client; no redirects, retries, secret-bearing errors,
 * unbounded pagination, or model-supplied URLs. */
class GitlabClient {
  private readonly origin: URL
  constructor(private readonly repository: ReleaseRepository, private readonly credential: ReleaseCredential, private readonly options: GitlabTransportOptions, private readonly signal: AbortSignal) { this.origin = releaseOrigin(repository) }
  async request(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: Json, optional = false): Promise<{ value: unknown; headers: Headers } | undefined> {
    if (!path.startsWith('/api/v4/') || path.startsWith('//') || /[\r\n]/.test(path)) reject('Invalid fixed API route')
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin.origin) reject('Cross-origin API request denied')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
    const abort = () => controller.abort(); this.signal.addEventListener('abort', abort, { once: true })
    if (this.signal.aborted) abort()
    try {
      const response = await (this.options.fetch ?? fetch)(url, { method, redirect: 'manual', signal: controller.signal, headers: { 'PRIVATE-TOKEN': this.credential.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (response.status >= 300 && response.status < 400) reject('GitLab redirect denied')
      if (optional && response.status === 404) { await response.body?.cancel(); return undefined }
      if (!response.ok) { await response.body?.cancel(); reject(`GitLab ${method} request rejected (${response.status}); no retry attempted`) }
      const chunks: Uint8Array[] = []; let bytes = 0
      const reader = response.body?.getReader()
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break
        bytes += value.length
        if (bytes > (this.options.maxBodyBytes ?? 2 * 1024 * 1024)) { await reader.cancel(); reject('GitLab response exceeds bounded body limit') }
        chunks.push(value)
      }
      const raw = Buffer.concat(chunks)
      let value: unknown
      if (path.includes('/repository/files/') && path.includes('/raw?')) value = raw
      else { try { value = JSON.parse(raw.toString('utf8')) } catch { reject('GitLab returned invalid JSON') } }
      return { value, headers: response.headers }
    } catch (error) {
      if (error instanceof Error && /^(?:GitLab|Cross-origin|Invalid fixed)/.test(error.message)) throw error
      reject(`GitLab ${method} transport interrupted; outcome requires reconciliation`)
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort', abort) }
  }
  async json(path: string, optional = false): Promise<Json | undefined> {
    const result = await this.request(path, 'GET', undefined, optional)
    if (!result) return undefined
    if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) reject('GitLab object evidence is malformed')
    return result.value as Json
  }
  async list(path: string): Promise<Json[]> {
    const result: Json[] = []
    for (let page = 1; page <= 20; page++) {
      const response = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      if (!response || !Array.isArray(response.value) || response.value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) reject('GitLab list evidence is malformed')
      result.push(...response.value as Json[])
      const next = response.headers.get('x-next-page')
      if (next !== null) { if (!next) return result; if (next !== String(page + 1)) reject('GitLab pagination is inconsistent') }
      else if (response.value.length < 100) return result
    }
    reject('GitLab pagination exceeds inspection budget')
  }
}

export function createGitlabTransport(options: GitlabTransportOptions): ReleaseTransport {
  const push = options.push ?? createGitPushTransport({ tempRoot: options.tempRoot, runGit: options.runGit })
  async function inspect(repository: ReleaseRepository, scope: ReleaseScope, request: ReleaseRequest, credential: ReleaseCredential, signal: AbortSignal): Promise<RemoteSnapshot> {
    contextValid(repository, scope, request)
    const client = new GitlabClient(repository, credential, options, signal)
    const prefix = `/api/v4/projects/${repository.projectId}`
    const user = await client.json('/api/v4/user')
    if (user?.id !== credential.userId || user.username !== credential.username || user.state !== 'active') reject('GitLab authenticated identity mismatch or inactive user')
    const project = await client.json(prefix)
    if (project?.id !== repository.projectId || project.path_with_namespace !== repository.projectPath || project.default_branch !== repository.targetBranch || project.archived !== false) reject('GitLab project route/default branch/archive mismatch')
    const target = await client.json(`${prefix}/repository/branches/${encodeURIComponent(scope.targetBranch)}`)
    const source = await client.json(`${prefix}/repository/branches/${encodeURIComponent(scope.sourceBranch)}`, true)
    if (!isSha(target?.commit?.id) || target?.name !== scope.targetBranch || target.protected !== true || (source && (!isSha(source.commit?.id) || source.name !== scope.sourceBranch))) reject('GitLab branch evidence malformed or target unprotected')
    const raw = await client.request(`${prefix}/repository/files/${encodeURIComponent('.gitlab-ci.yml')}/raw?ref=${target.commit.id}`)
    if (!raw || !(raw.value instanceof Uint8Array)) reject('Target CI evidence is missing')
    const attestation = repository.triggerPolicy
    const validAttestation = attestation.productionExcluded === true && Number.isFinite(Date.parse(attestation.reviewedAt)) && Date.parse(attestation.reviewedAt) <= Date.now() && Date.parse(attestation.expiresAt) > Date.now()
    const snapshot: RemoteSnapshot = { identity: { id: user.id, username: user.username }, project: { id: project.id, path: project.path_with_namespace, defaultBranch: project.default_branch, pipelineRequired: project.only_allow_merge_if_pipeline_succeeds === true, fastForwardOnly: project.merge_method === 'ff' && project.squash_option !== 'always' }, ...(source ? { sourceSha: source.commit.id } : {}), targetSha: target.commit.id, targetCiSha256: sha256(raw.value), productionExcluded: validAttestation, triggerPolicyFingerprint: attestation.fingerprint }
    if (source && source.commit.id === request.sha) {
      const candidateCi = await client.request(`${prefix}/repository/files/${encodeURIComponent('.gitlab-ci.yml')}/raw?ref=${request.sha}`)
      if (!candidateCi || !(candidateCi.value instanceof Uint8Array) || sha256(candidateCi.value) !== repository.ciSha256) reject('Remote candidate CI differs from reviewed policy')
    }
    const marker = releaseMarker(request.taskId, request.repository, request.sha)
    const mergeRequests = await client.list(`${prefix}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(scope.sourceBranch)}`)
    if (mergeRequests.some(mr => mr.source_branch !== scope.sourceBranch) || mergeRequests.length > 1) reject('Conflicting or ambiguous merge requests for exact source branch')
    if (mergeRequests.length) {
      const item = mergeRequests[0]!
      if (!id(item.iid)) reject('Invalid merge request IID')
      const mr = await client.json(`${prefix}/merge_requests/${item.iid}`)
      const markers = text(mr?.description) ? mr.description.match(/nightshift:[a-zA-Z0-9._-]+:[a-zA-Z0-9_-]+:[a-f0-9]{40}/g) ?? [] : []
      if (!mr || mr.source_project_id !== repository.projectId || mr.target_project_id !== repository.projectId || mr.source_branch !== scope.sourceBranch || mr.target_branch !== scope.targetBranch || mr.author?.id !== repository.expectedUserId || markers.length !== 1 || markers[0] !== marker || mr.sha !== request.sha || !['opened', 'merged', 'closed'].includes(mr.state)) reject('Merge request ownership, marker, scope or SHA conflicts')
      const approvals = await client.json(`${prefix}/merge_requests/${item.iid}/approvals`)
      const ruleState = await client.json(`${prefix}/merge_requests/${item.iid}/approval_state`)
      if (!approvals || typeof approvals.approved !== 'boolean' || !Number.isSafeInteger(approvals.approvals_left) || !ruleState || !Array.isArray(ruleState.rules)) reject('Approval evidence unavailable or unsupported')
      const approved = approvals.approved === true && approvals.approvals_left === 0 && ruleState.rules.every((rule: Json) => rule.approved === true && Number.isSafeInteger(rule.approvals_required) && rule.approvals_required >= 0)
      const discussions = await client.list(`${prefix}/merge_requests/${item.iid}/discussions`)
      let unresolved = 0
      for (const discussion of discussions) {
        if (!Array.isArray(discussion.notes)) reject('Discussion notes unavailable')
        for (const note of discussion.notes) { if (note.resolvable === true && note.resolved !== true) unresolved++ }
      }
      snapshot.mergeRequest = { iid: item.iid, sourceProjectId: mr.source_project_id, targetProjectId: mr.target_project_id, sourceBranch: mr.source_branch, targetBranch: mr.target_branch, sha: mr.sha, state: mr.state, authorId: mr.author.id, draft: typeof mr.draft === 'boolean' ? mr.draft : mr.work_in_progress !== false, conflicts: mr.has_conflicts !== false, mergeable: (mr.detailed_merge_status === 'mergeable' || (!mr.detailed_merge_status && mr.merge_status === 'can_be_merged')) && mr.squash !== true && mr.squash_on_merge !== true && mr.merge_when_pipeline_succeeds !== true, approved, unresolvedDiscussions: unresolved, marker }
      if (mr.state === 'merged') {
        if (!isSha(mr.merge_commit_sha) || mr.merge_commit_sha !== request.sha || snapshot.targetSha !== request.sha || snapshot.project.fastForwardOnly !== true) reject('Merged result is not the exact admitted fast-forward SHA')
        const commit = await client.json(`${prefix}/repository/commits/${request.sha}`)
        if (commit?.id !== request.sha || !Array.isArray(commit.parent_ids) || !commit.parent_ids.every(isSha)) reject('Merged commit evidence unavailable')
        const local = await readLocalCommitEvidence({ tempRoot: options.tempRoot, runGit: options.runGit }, repository, request.sha, signal)
        if (JSON.stringify(local.parents) !== JSON.stringify(commit.parent_ids)) reject('Remote merged commit parents disagree with immutable local object')
        // Verification is set only after exact FF remote identity AND credential-free
        // local object/tree evidence; the coordinator compares this tree to its receipt.
        snapshot.mergeRequest.mergeCommitSha = request.sha; snapshot.mergeRequest.mergeTreeSha = local.treeSha; snapshot.mergeRequest.mergeParents = local.parents; snapshot.mergeRequest.mergeCommitVerified = true
      }
      if (id(mr.head_pipeline?.id)) {
        const pipeline = await client.json(`${prefix}/pipelines/${mr.head_pipeline.id}`)
        if (!pipeline || pipeline.id !== mr.head_pipeline.id || pipeline.sha !== request.sha || pipeline.project_id !== repository.projectId || pipeline.source !== 'merge_request_event') reject('Pipeline is not the exact source-SHA merge-request pipeline')
        const jobs = await client.list(`${prefix}/pipelines/${pipeline.id}/jobs?include_retried=false`)
        const bridges = await client.list(`${prefix}/pipelines/${pipeline.id}/bridges`)
        if (bridges.length) reject('Downstream pipeline provenance is unsupported')
        if (jobs.some(job => !text(job.name) || !text(job.status) || typeof job.allow_failure !== 'boolean' || (job.pipeline && job.pipeline.id !== pipeline.id))) reject('Pipeline job evidence malformed')
        snapshot.pipeline = { id: pipeline.id, sha: pipeline.sha, status: pipeline.status, jobs: jobs.map(job => ({ name: job.name, status: job.status, allowFailure: job.allow_failure })) }
      }
    }
    if (scope.environment) {
      const route = repository.environments[scope.environment]
      if (route) snapshot.deployment = { routeId: route.id, sourceSha: request.sha, state: 'unknown', ids: [], destinationId: route.destinationId, healthy: false, remoteDeadlineEnforced: false }
    }
    return snapshot
  }
  function liveBoundary(context: DispatchContext, signal: AbortSignal) {
    signal.throwIfAborted()
    if (typeof context.assertAuthorized !== 'function') reject('Live host authorization callback is required')
    context.assertAuthorized()
    if (!Number.isFinite(Date.parse(context.deadline)) || Date.now() >= Date.parse(context.deadline) || Date.now() >= Date.parse(context.grant.expiresAt)) reject('Release dispatch deadline expired')
    if (!context.scope.actions.includes(context.request.action) || context.grant.taskId !== context.request.taskId || context.candidate.taskId !== context.request.taskId || context.candidate.repository !== context.request.repository || context.candidate.sourceBranch !== context.scope.sourceBranch || context.candidate.baseSha !== context.scope.baseSha || context.candidate.sha !== context.request.sha || !context.candidate.validated || !context.candidate.clean || !context.candidate.commitReceiptId || !context.candidate.validationReceiptIds.length || context.candidate.changedProtectedPaths.length || context.candidate.ciSha256 !== context.repository.ciSha256) reject('Candidate or release capability is not admitted')
    if (context.request.action === 'merge' && context.repository.mergeTriggersDeploy && (!context.scope.actions.includes('deploy') || !context.scope.environment)) reject('Merge-triggered deployment requires a paired environment deploy grant')
  }
  return {
    async observe(context, signal) {
      contextValid(context.repository, context.scope, context.request)
      const credential = await readReleaseCredential(context.repository)
      return inspect(context.repository, context.scope, context.request, credential, signal)
    },
    async dispatch(context, signal) {
      liveBoundary(context, signal)
      if (context.request.action === 'deploy') reject('Jenkins deployment requires its separate verified transport; GitLab adapter cannot deploy')
      const credential = await readReleaseCredential(context.repository)
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(Date.parse(context.deadline), Date.parse(context.grant.expiresAt)) - Date.now()))])
      const fresh = await inspect(context.repository, context.scope, context.request, credential, boundedSignal)
      if (!fresh.productionExcluded || fresh.targetCiSha256 !== context.repository.ciSha256 || fresh.triggerPolicyFingerprint !== context.snapshot.triggerPolicyFingerprint || fresh.targetSha !== context.snapshot.targetSha) reject('Release policy, reviewed CI or target changed before dispatch')
      const { repository, scope, request } = context
      const client = new GitlabClient(repository, credential, options, boundedSignal)
      const prefix = `/api/v4/projects/${repository.projectId}`
      liveBoundary(context, boundedSignal)
      if (request.action === 'push') {
        if (fresh.sourceSha !== context.snapshot.sourceSha) reject('Remote source changed before push')
        return push({ repository, credential, sha: request.sha, sourceBranch: scope.sourceBranch, expectedRemoteSha: fresh.sourceSha, signal: boundedSignal, assertAuthorized: () => liveBoundary(context, boundedSignal) })
      }
      if (fresh.sourceSha !== request.sha) reject('Exact candidate must already be pushed')
      if (request.action === 'create_mr') {
        if (fresh.mergeRequest) return { remoteIds: [`mr:${repository.projectId}:${fresh.mergeRequest.iid}`], detail: 'Exact marked merge request already exists; no duplicate sent' }
        if (!request.title?.trim() || request.title.length > 250 || (request.description?.length ?? 0) > 8000 || /nightshift:|superagent-deploy-v1/.test(request.description ?? '')) reject('Invalid bounded merge request title/description')
        const needsTickets = repository.mergeTriggersDeploy && scope.actions.includes('merge')
        const metadata = needsTickets ? await options.deploymentTickets?.metadata(context) : ''
        if (needsTickets && (!metadata || metadata.length > 60000)) reject('Signed deployment metadata is required for merge-triggered deployment')
        liveBoundary(context, boundedSignal)
        const response = await client.request(`${prefix}/merge_requests`, 'POST', { source_branch: scope.sourceBranch, target_branch: scope.targetBranch, title: request.title, description: `${request.description ?? ''}\n\n${releaseMarker(request.taskId, request.repository, request.sha)}${metadata ? `\n\n${metadata}` : ''}`,  remove_source_branch: false, squash: false, allow_collaboration: false })
        const body = response?.value as Json | undefined
        if (!id(body?.iid)) reject('Merge request response uncertain; reconcile by marker without retry')
        return { remoteIds: [`mr:${repository.projectId}:${body.iid}`], detail: 'One merge request creation accepted; exact marked readback required' }
      }
      const mr = fresh.mergeRequest; const pipeline = fresh.pipeline
      if (fresh.project.fastForwardOnly !== true || !fresh.project.pipelineRequired || fresh.targetSha !== scope.baseSha || !mr || mr.state !== 'opened' || mr.draft || mr.conflicts || !mr.mergeable || !mr.approved || mr.unresolvedDiscussions !== 0 || !pipeline || pipeline.sha !== request.sha || pipeline.status !== 'success' || !repository.requiredJobs.length || repository.requiredJobs.some(name => pipeline.jobs.filter(job => job.name === name && job.status === 'success' && !job.allowFailure).length !== 1)) reject('Fast-forward merge gates, exact pipeline jobs or approvals are not satisfied')
      // REST sha is source CAS only; FF-only server policy supplies the target race gate.
      const finalProject = await client.json(prefix)
      const target = await client.json(`${prefix}/repository/branches/${encodeURIComponent(scope.targetBranch)}`)
      const head = await client.json(`${prefix}/merge_requests/${mr.iid}`)
      if (finalProject?.merge_method !== 'ff' || finalProject.only_allow_merge_if_pipeline_succeeds !== true || finalProject.squash_option === 'always' || target?.commit?.id !== scope.baseSha || head?.sha !== request.sha || head.state !== 'opened' || head.squash === true || head.squash_on_merge === true) reject('Source, target or merge policy drifted at final merge read')
      if (repository.mergeTriggersDeploy) {
        if (!options.deploymentTickets || typeof head.description !== 'string') reject('Signed deployment ticket verification unavailable')
        await options.deploymentTickets.verify(context, head.description)
      }
      liveBoundary(context, boundedSignal)
      await client.request(`${prefix}/merge_requests/${mr.iid}/merge`, 'PUT', { sha: request.sha, squash: false, should_remove_source_branch: false, merge_when_pipeline_succeeds: false })
      return { remoteIds: [`mr:${repository.projectId}:${mr.iid}`, `sha:${request.sha}`], detail: 'One immediate FF-only merge request accepted; exact merged-SHA readback required' }
    },
  }
}
