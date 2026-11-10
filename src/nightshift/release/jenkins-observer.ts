/** Read-only evidence overlay for existing merge-triggered Jenkins builds. Never triggers or retries jobs. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { releaseMarker, type DeploymentRoute, type ReleaseRepository, type ReleaseRequest, type ReleaseScope, type RemoteSnapshot } from './contracts.ts'

export interface JenkinsObservationContext { repository: ReleaseRepository; scope: ReleaseScope; request: ReleaseRequest }
export type JenkinsAttestedTarget =
  | { kind: 'java'; project: string; sourceInstance: string; namespace: string; deployment: string; jenkinsUrl?: string; ref?: string; mode?: string; publisherFingerprint?: string }
  | { kind: 'web'; service: string; config: { uid: string; sha256: string }; sourceUrl: string; branch?: string; profile?: string; buildConfigSha256?: string }
/** Host-owned route proof; never constructed from model arguments or untrusted Jenkins artifacts. */
export interface JenkinsDeploymentAttestation {
  expiresAt: string
  /** Trusted lower bound preceding this task's receipted source creation, never the later MR signing time. */
  notBefore?: string
  configSha256: Record<string, string>
  deadline: string
  remoteDeadlineEnforced: boolean
  destinationId: string
  targets: Record<string, JenkinsAttestedTarget>
}
export interface JenkinsObserverOptions {
  attest?: (context: JenkinsObservationContext) => JenkinsDeploymentAttestation | undefined | Promise<JenkinsDeploymentAttestation | undefined>
  fetch?: typeof fetch
  timeoutMs?: number
  maxBodyBytes?: number
}
type Json = Record<string, unknown>
type Deployment = NonNullable<RemoteSnapshot['deployment']>
type BuildFact = NonNullable<Deployment['builds']>[number]
interface Credential { username: string; token: string; expiresAt: string }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\0\r\n]/.test(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
function must(condition: unknown): asserts condition { if (!condition) throw new Error('Jenkins evidence unavailable or conflicting') }
function object(value: unknown): Json { must(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Json }
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN
  const local = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23) return NaN
  return Date.parse(value)
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function jobPath(job: string): string {
  must(text(job) && job.length <= 300)
  const parts = job.split('/')
  must(parts.every(part => /^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(part) && part !== '.' && part !== '..' && part.trim() === part))
  return parts.map(part => `/job/${encodeURIComponent(part)}`).join('')
}
async function credential(path: string): Promise<Credential> {
  must(isAbsolute(path) && await realpath(path) === path)
  const before = await lstat(path)
  must(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && (before.mode & 0o777) === 0o600 && before.size <= 16_384
    && (!process.getuid || before.uid === process.getuid()))
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    must(stat.ino === before.ino && stat.dev === before.dev && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size <= 16_384)
    const buffer = Buffer.alloc(16_385), result = await file.read(buffer, 0, buffer.length, 0)
    must(result.bytesRead <= 16_384)
    const value = object(JSON.parse(buffer.subarray(0, result.bytesRead).toString('utf8')))
    must(exactKeys(value, ['username', 'token', 'expiresAt']) && text(value.username) && !value.username.includes(':') && text(value.token) && instant(value.expiresAt) > Date.now())
    return value as unknown as Credential
  } finally { await file.close() }
}

/** Bounded credentialed GET client using constructed paths only; redirects and remote-provided URLs are never followed. */
class JenkinsReader {
  private readonly authentication: string
  constructor(private readonly origin: string, private readonly credential: Credential, private readonly signal: AbortSignal, private readonly options: JenkinsObserverOptions) {
    this.authentication = `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString('base64')}`
  }
  async get(path: string, optional = false): Promise<Json | undefined> {
    must(path.startsWith('/') && !path.startsWith('//') && !/[\r\n]/.test(path))
    this.signal.throwIfAborted()
    must(instant(this.credential.expiresAt) > Date.now())
    const url = new URL(path, this.origin)
    must(url.origin === this.origin)
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
    const signal = AbortSignal.any([this.signal, controller.signal])
    try {
      const response = await (this.options.fetch ?? fetch)(url, { method: 'GET', redirect: 'manual', signal, headers: { Authorization: this.authentication, Accept: 'application/json' } })
      if (optional && response.status === 404) { await response.body?.cancel(); return undefined }
      if (!response.ok || response.status >= 300) { await response.body?.cancel(); must(false) }
      if (response.url) must(new URL(response.url).origin === this.origin)
      const chunks: Uint8Array[] = [], reader = response.body?.getReader()
      let bytes = 0
      if (reader) for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > (this.options.maxBodyBytes ?? 512 * 1024)) { await reader.cancel(); must(false) }
        chunks.push(value)
      }
      signal.throwIfAborted()
      must(instant(this.credential.expiresAt) > Date.now())
      return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
    } finally { clearTimeout(timeout) }
  }
}
function validateAttestation(value: JenkinsDeploymentAttestation, route: DeploymentRoute): void {
  must(value.notBefore === undefined || (Number.isFinite(instant(value.notBefore)) && instant(value.notBefore) <= Date.now()))
  must(instant(value.expiresAt) > Date.now() && Number.isFinite(instant(value.deadline)) && value.remoteDeadlineEnforced === true && route.remoteDeadlineEnforced === true && value.destinationId === route.destinationId)
  must(exactKeys(object(value.configSha256), route.jobs) && exactKeys(object(value.targets), route.jobs))
  for (const job of route.jobs) {
    must(hash(value.configSha256[job]) && value.configSha256[job] === route.expectedConfigSha256[job])
    const target = value.targets[job]!
    must(target && (target.kind === 'java' || target.kind === 'web'))
    if (target.kind === 'java') {
      must(text(target.project) && text(target.sourceInstance) && text(target.namespace) && text(target.deployment))
      if (target.publisherFingerprint !== undefined) must(hash(target.publisherFingerprint))
      if (target.jenkinsUrl !== undefined) { const url = new URL(target.jenkinsUrl); must(url.origin === route.origin && !url.username && !url.password && !url.search && !url.hash) }
      if (target.ref !== undefined) must(text(target.ref))
      if (target.mode !== undefined) must(text(target.mode))
    } else must(text(target.service) && text(target.config?.uid) && hash(target.config?.sha256) && text(target.sourceUrl)
      && (target.buildConfigSha256 === undefined || hash(target.buildConfigSha256)))
  }
}
/** All explicit SHA signals on a build must agree; branch names and “latest” are never content identity. */
function source(build: Json): string | undefined {
  must(Array.isArray(build.actions))
  const values: string[] = []
  for (const raw of build.actions) {
    const action = object(raw)
    if (action.lastBuiltRevision !== undefined) {
      const revision = object(action.lastBuiltRevision)
      must(sha(revision.SHA1)); values.push(revision.SHA1)
    }
    if (action.parameters !== undefined) {
      must(Array.isArray(action.parameters))
      const seen = new Set<string>()
      for (const rawParameter of action.parameters) {
        const parameter = object(rawParameter)
        must(text(parameter.name) && !seen.has(parameter.name)); seen.add(parameter.name)
        if (['branch', 'source40', 'source', 'source_sha', 'gitlabAfter'].includes(parameter.name)) {
          must(text(parameter.value))
          if (sha(parameter.value)) values.push(parameter.value)
          else if (parameter.name !== 'branch') must(false)
        }
      }
    }
  }
  must(new Set(values).size <= 1)
  return values[0]
}
function healthyRelease(release: Json): string {
  must(release.result === 'ready' && integer(release.generation) && Array.isArray(release.pods) && release.pods.length > 0 && release.pods.length <= 200
    && release.pods.every(text) && new Set(release.pods).size === release.pods.length && text(release.image))
  const image = /^\S+@(sha256:[a-f0-9]{64})$/.exec(release.image)
  must(image)
  return image[1]!
}
function javaIdentity(value: Json, context: JenkinsObservationContext, target: Extract<JenkinsAttestedTarget, { kind: 'java' }>, job: string, number: number, origin: string): void {
  const deployment = object(value.target)
  must(value.source === context.request.sha && value.source_instance === target.sourceInstance && value.project === target.project
    && value.jenkins_job === job && value.jenkins_build === String(number) && text(value.jenkins_url)
    && (target.jenkinsUrl !== undefined ? value.jenkins_url === target.jenkinsUrl : value.jenkins_url.replace(/\/$/, '') === origin)
    && deployment.namespace === target.namespace && deployment.deployment === target.deployment
    && text(value.ref) && (target.ref !== undefined ? value.ref === target.ref : [context.scope.targetBranch, `refs/heads/${context.scope.targetBranch}`, context.request.sha].includes(value.ref))
    && text(value.mode) && (target.mode === undefined || value.mode === target.mode))
}
function webIdentity(value: Json, context: JenkinsObservationContext, target: Extract<JenkinsAttestedTarget, { kind: 'web' }>): void {
  const config = object(value.config)
  must(value.service === target.service && value.source === context.request.sha && value.patch_attempted === true && value.stage === 'runtime-verification'
    && config.uid === target.config.uid && config.sha256 === target.config.sha256 && text(config.resource_version))
}
async function verifyArtifacts(reader: JenkinsReader, context: JenkinsObservationContext, target: JenkinsAttestedTarget, job: string, number: number, origin: string): Promise<string> {
  const path = `${jobPath(job)}/${number}`
  const release = await reader.get(`${path}/artifact/jenkins-evidence/release.json`, true)
  const attempt = await reader.get(`${path}/artifact/jenkins-evidence/attempt.json`, true)
  must(release && attempt)
  const artifactDigest = healthyRelease(release)
  if (target.kind === 'java') {
    javaIdentity(release, context, target, job, number, origin); javaIdentity(attempt, context, target, job, number, origin)
    must(attempt.result === 'ready' && attempt.image === release.image && text(release.before_image) && text(release.health_basis))
    if (target.publisherFingerprint) {
      const manifest = await reader.get(`${path}/artifact/jenkins-evidence/release-manifest.json`, true)
      must(manifest)
      const destination = object(manifest.target)
      must(manifest.source === context.request.sha && manifest.project === target.project && manifest.environment === context.scope.environment
        && manifest.jenkins_job === job && manifest.jenkins_build === String(number) && manifest.config_fingerprint === target.publisherFingerprint
        && destination.namespace === target.namespace && destination.deployment === target.deployment && manifest.image === release.image)
    }
  } else {
    webIdentity(release, context, target)
    must(attempt.service === target.service && attempt.source === context.request.sha && attempt.result === 'ready' && attempt.cleanup === true
      && attempt.possible_partial_update === false && text(attempt.branch) && (target.branch === undefined || attempt.branch === target.branch)
      && text(attempt.profile) && (target.profile === undefined || attempt.profile === target.profile) && attempt.url === target.sourceUrl && (text(attempt.attempt) || integer(attempt.attempt)))
    const nested = object(attempt.release), audit = object(attempt.audit), imageInputs = object(attempt.image_inputs)
    webIdentity(nested, context, target)
    must(healthyRelease(nested) === artifactDigest && nested.generation === release.generation && JSON.stringify(nested.pods) === JSON.stringify(release.pods)
      && object(nested.config).resource_version === object(release.config).resource_version
      && audit.environment === context.scope.environment && audit.service === target.service && audit.source === context.request.sha && audit.result === 'passed'
      && audit.mode === attempt.mode && ['master-auto', 'manual'].includes(String(audit.mode)) && audit.profile === attempt.profile
      && ['build-only', 'full-verify'].includes(String(audit.profile)) && audit.tests_executed === (audit.profile === 'full-verify') && hash(audit.config_sha256)
      && (target.buildConfigSha256 === undefined || audit.config_sha256 === target.buildConfigSha256)
      && imageInputs.source === context.request.sha)
  }
  return artifactDigest
}

export async function overlayJenkinsObservation(context: JenkinsObservationContext, gitlabSnapshot: RemoteSnapshot, signal: AbortSignal, options: JenkinsObserverOptions = {}): Promise<RemoteSnapshot> {
  context = structuredClone(context)
  const result = structuredClone(gitlabSnapshot), route = context.scope.environment && context.repository.environments[context.scope.environment]
  if (!route) { delete result.deployment; return result }
  const unknown = (): RemoteSnapshot => ({ ...result, deployment: { routeId: route.id, sourceSha: context.request.sha, state: 'unknown', ids: [], destinationId: route.destinationId, healthy: false, remoteDeadlineEnforced: false } })
  try {
    must(['test', 'preprod'].includes(context.scope.environment!) && context.repository.alias === context.scope.repository && context.request.repository === context.scope.repository && sha(context.request.sha)
      && route.kind === 'jenkins' && route.jobs.length > 0 && route.jobs.length <= 100 && new Set(route.jobs).size === route.jobs.length)
    const origin = new URL(route.origin)
    must(origin.origin === route.origin && !origin.username && !origin.password && (origin.protocol === 'https:' || (origin.protocol === 'http:' && context.repository.allowInsecureHttp === true)))
    for (const job of route.jobs) jobPath(job)
    must(options.attest)
    const attestation = structuredClone(await options.attest(structuredClone(context)))
    must(attestation); validateAttestation(attestation, route)
    signal.throwIfAborted()
    const reader = new JenkinsReader(route.origin, await credential(route.credentialRef), signal, options)
    const queue = await reader.get('/queue/api/json?tree=items[id,task[name,fullName],actions[parameters[name,value]]]{0,101}')
    must(queue && Array.isArray(queue.items) && queue.items.length <= 100)
    const facts: BuildFact[] = []
    let missing = false
    for (const job of route.jobs) {
      validateAttestation(attestation, route)
      const list = await reader.get(`${jobPath(job)}/api/json?tree=builds[number,timestamp,result,building,queueId,actions[lastBuiltRevision[SHA1],parameters[name,value]]]{0,101}`)
      must(list && Array.isArray(list.builds) && list.builds.length <= 101)
      const numbers = new Set<number>(), matches: Json[] = []
      const truncated = list.builds.length === 101, lowerBound = attestation.notBefore === undefined ? undefined : instant(attestation.notBefore)
      if (truncated) must(lowerBound !== undefined)
      let previousTimestamp = Infinity
      for (const raw of list.builds) {
        const build = object(raw)
        must(integer(build.number) && !numbers.has(build.number)); numbers.add(build.number)
        // A 101st sentinel may establish a complete grant-era window, never uniqueness over unbounded history.
        // Check every returned SHA, including the sentinel, to reject an invalid source-era attestation.
        if (truncated || lowerBound !== undefined || build.timestamp !== undefined) {
          must(integer(build.timestamp) && build.timestamp <= Date.now() && build.timestamp <= previousTimestamp)
          previousTimestamp = build.timestamp
        }
        if (source(build) === context.request.sha) {
          if (lowerBound !== undefined) must((build.timestamp as number) >= lowerBound)
          matches.push(build)
        }
      }
      if (truncated) must(previousTimestamp < lowerBound!)
      const queued: Json[] = []
      for (const raw of queue.items) {
        const item = object(raw), task = object(item.task)
        const identity = task.fullName ?? task.name
        if (identity !== job) {
          // A leaf-only queue name cannot prove absence for a configured folder job.
          must(!(task.fullName === undefined && task.name === job.split('/').at(-1)))
          continue
        }
        must(integer(item.id))
        if (source(item) === context.request.sha) queued.push(item)
        else if (!source(item)) must(false) // An unidentifiable job in flight cannot establish absence.
      }
      must(matches.length <= 1 && queued.length <= 1 && !(matches.length && queued.length))
      if (queued.length) {
        facts.push({ job, id: `${job}:queue:${queued[0]!.id}`, sha: context.request.sha, destinationId: route.destinationId, state: 'queued', healthy: false }); continue
      }
      if (!matches.length) { missing = true; continue }
      const number = matches[0]!.number as number
      const build = await reader.get(`${jobPath(job)}/${number}/api/json?tree=number,timestamp,result,building,queueId,actions[lastBuiltRevision[SHA1],parameters[name,value]]`)
      must(build && build.number === number && (matches[0]!.timestamp === undefined || (build.timestamp === matches[0]!.timestamp && (build.timestamp as number) <= Date.now())) && integer(build.queueId) && build.queueId === matches[0]!.queueId && source(build) === context.request.sha && typeof build.building === 'boolean')
      const fact: BuildFact = { job, id: `${job}:queue:${build.queueId}`,  sha: context.request.sha, destinationId: route.destinationId, state: 'unknown', healthy: false }
      if (build.building) { must(build.result === null); fact.state = 'running' }
      else if (['FAILURE', 'ABORTED', 'UNSTABLE', 'NOT_BUILT'].includes(String(build.result))) fact.state = 'failed'
      else if (build.result === 'SUCCESS') {
        fact.artifactDigest = await verifyArtifacts(reader, context, attestation.targets[job]!, job, number, route.origin)
        fact.state = 'succeeded'; fact.healthy = true
      }
      facts.push(fact)
    }
    validateAttestation(attestation, route); signal.throwIfAborted()
    const mr = result.mergeRequest
    const exactOpen = mr?.state === 'opened' && mr.sha === context.request.sha && mr.sourceBranch === context.scope.sourceBranch && mr.targetBranch === context.scope.targetBranch
      && mr.sourceProjectId === context.repository.projectId && mr.targetProjectId === context.repository.projectId && mr.authorId === context.repository.expectedUserId
      && mr.marker === releaseMarker(context.request.taskId, context.request.repository, context.request.sha)
    const exactMerged = mr?.state === 'merged' && mr.sha === context.request.sha && mr.sourceBranch === context.scope.sourceBranch && mr.targetBranch === context.scope.targetBranch
      && mr.sourceProjectId === context.repository.projectId && mr.targetProjectId === context.repository.projectId && mr.authorId === context.repository.expectedUserId
      && mr.marker === releaseMarker(context.request.taskId, context.request.repository, context.request.sha) && mr.mergeCommitSha === context.request.sha
      && mr.mergeCommitVerified === true && result.targetSha === context.request.sha
    const state: Deployment['state'] = missing
      ? facts.length === 0 && exactOpen ? 'absent' : 'unknown'
      : facts.some(fact => fact.state === 'failed') ? 'failed'
        : facts.some(fact => fact.state === 'unknown') ? 'unknown'
          : facts.some(fact => fact.state === 'running') ? 'running'
            : facts.some(fact => fact.state === 'queued') ? 'queued' : exactMerged ? 'succeeded' : 'unknown'
    const awaitingWebhook = missing && exactMerged && instant(attestation.deadline) > Date.now()
      && facts.every(fact => ['queued', 'running', 'succeeded'].includes(fact.state))
    result.deployment = { routeId: route.id, sourceSha: context.request.sha, state, ids: facts.map(fact => fact.id), destinationId: route.destinationId,
      healthy: state === 'succeeded', remoteDeadlineEnforced: true, configSha256: { ...attestation.configSha256 }, deadline: attestation.deadline,
      ...(awaitingWebhook ? { awaitingWebhook: true } : {}), builds: facts }
    return result
  } catch {
    // Do not leak URL query strings, credential paths, tokens or private publisher config on any failure.
    return unknown()
  }
}
