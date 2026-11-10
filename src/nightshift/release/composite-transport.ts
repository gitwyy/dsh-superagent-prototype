/** Host composition of exact GitLab mutations, immutable deployment tickets and read-only Jenkins evidence. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { NightConfig } from '../contracts.ts'
import type { DispatchContext, ReleaseTransport } from './contracts.ts'
import { policyDigest, ReleasePolicySchema } from './coordinator.ts'
import { createDeploymentTickets } from './deployment-tickets.ts'
import { createGitlabTransport } from './gitlab.ts'
import { overlayJenkinsObservation, type JenkinsDeploymentAttestation, type JenkinsObservationContext } from './jenkins-observer.ts'

export type ReleaseRuntimeConfig = NonNullable<NightConfig['releaseRuntime']>
export interface ReleaseServicesOptions {
  fetch?: typeof fetch
  gitlabFactory?: typeof createGitlabTransport
  observer?: typeof overlayJenkinsObservation
  ticketFactory?: typeof createDeploymentTickets
}
export interface ReleaseServices { transport: ReleaseTransport; close(): Promise<void> }
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().min(1).max(2048).refine(value => !/[\0\r\n]/.test(value))
const java = z.strictObject({ kind: z.literal('java'), project: text, sourceInstance: z.url(), namespace: text, deployment: text, jenkinsUrl: z.url().optional(), ref: text.optional(), mode: text.optional(), publisherFingerprint: hash.optional() })
const web = z.strictObject({ kind: z.literal('web'), service: text, config: z.strictObject({ uid: text, sha256: hash }), sourceUrl: z.url(), branch: text.optional(), profile: text.optional(), buildConfigSha256: hash.optional() })
const attestationSchema = z.strictObject({ version: z.literal(1), expiresAt: z.iso.datetime({ offset: true }), repositories: z.record(text, z.strictObject({
  root: text, destinationId: text, configSha256: z.record(text, hash), targets: z.record(text, z.discriminatedUnion('kind', [java, web])), remoteDeadlineEnforced: z.boolean(),
})) })
type AttestationFile = z.infer<typeof attestationSchema>
function must(value: unknown): asserts value { if (!value) throw new Error('Release service evidence is missing, expired or inconsistent') }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
async function trustedDirectory(path: string): Promise<void> {
  must(isAbsolute(path) && resolve(path) === path && await realpath(path) === path)
  let current = path
  for (;;) {
    const info = await lstat(current)
    must(info.isDirectory() && !info.isSymbolicLink() && (!process.getuid || info.uid === 0 || info.uid === process.getuid()))
    must((info.mode & 0o022) === 0 || (info.uid === 0 && (info.mode & 0o1000) !== 0))
    const parent = dirname(current); if (parent === current) return; current = parent
  }
}
async function readAttestation(path: string): Promise<AttestationFile> {
  must(isAbsolute(path) && resolve(path) === path)
  await trustedDirectory(dirname(path))
  const before = await lstat(path), permissions = before.mode & 0o777
  must(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && [0o400, 0o600].includes(permissions)
    && before.size <= 512 * 1024 && (!process.getuid || before.uid === process.getuid()))
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    must(stat.ino === before.ino && stat.dev === before.dev && stat.nlink === 1 && [0o400, 0o600].includes(stat.mode & 0o777) && stat.size <= 512 * 1024)
    const buffer = Buffer.alloc(512 * 1024 + 1), result = await file.read(buffer, 0, buffer.length, 0)
    must(result.bytesRead <= 512 * 1024)
    const after = await file.stat(), live = await lstat(path)
    must(after.ino === stat.ino && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.nlink === 1 && live.ino === stat.ino && live.dev === stat.dev)
    const parsed = attestationSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, result.bytesRead))))
    must(Date.parse(parsed.expiresAt) > Date.now())
    return parsed
  } finally { await file.close() }
}

function assertUnchangedAttestation(path: string, expected: AttestationFile): void {
  must(realpathSync(path) === path)
  let current = dirname(path)
  for (;;) {
    const stat = lstatSync(current)
    must(stat.isDirectory() && !stat.isSymbolicLink() && (!process.getuid || stat.uid === 0 || stat.uid === process.getuid())
      && ((stat.mode & 0o022) === 0 || (stat.uid === 0 && (stat.mode & 0o1000) !== 0)))
    const parent = dirname(current); if (parent === current) break; current = parent
  }
  const before = lstatSync(path)
  must(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && [0o400, 0o600].includes(before.mode & 0o777)
    && before.size <= 512 * 1024 && (!process.getuid || before.uid === process.getuid()))
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(file)
    must(stat.ino === before.ino && stat.dev === before.dev && stat.nlink === 1 && stat.size <= 512 * 1024 && [0o400, 0o600].includes(stat.mode & 0o777))
    const buffer = Buffer.alloc(512 * 1024 + 1), bytes = readSync(file, buffer, 0, buffer.length, 0)
    must(bytes <= 512 * 1024)
    const after = fstatSync(file), live = lstatSync(path)
    must(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.nlink === 1 && live.ino === stat.ino && live.dev === stat.dev)
    const actual = attestationSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))))
    must(Date.parse(actual.expiresAt) > Date.now() && canonical(actual) === canonical(expected))
  } finally { closeSync(file) }
}

export function createReleaseServices(config: NightConfig, runtime: ReleaseRuntimeConfig, options: ReleaseServicesOptions = {}): ReleaseServices {
  config = structuredClone(config); runtime = structuredClone(runtime)
  const policy = ReleasePolicySchema.parse(config.releasePolicy), digest = policyDigest(policy)
  must(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runtime.keyId))
  must(Object.keys(runtime).length === 4 && ['keyId', 'keyFile', 'ticketDir', 'attestationFile'].every(name => Object.hasOwn(runtime, name)))
  for (const path of [runtime.keyFile, runtime.ticketDir, runtime.attestationFile]) must(isAbsolute(path) && resolve(path) === path && !path.includes('\0') && !inside(config.workspace, path))
  must(canonical(config.freezeWindows) === canonical(policy.freezeWindows))
  for (const [alias, repository] of Object.entries(policy.repositories)) must(repository.alias === alias && config.repositories[alias] === repository.root)
  const lifetime = new AbortController()
  let closed = false
  const pending = new Set<Promise<unknown>>()
  const tickets = (options.ticketFactory ?? createDeploymentTickets)({ keyId: runtime.keyId, keyFile: runtime.keyFile, stateDir: runtime.ticketDir, freezeWindows: policy.freezeWindows })
  const assertOpen = () => { if (closed) throw new Error('Release services are closed'); lifetime.signal.throwIfAborted() }
  async function bound(context: JenkinsObservationContext): Promise<void> {
    assertOpen()
    const repository = policy.repositories[context.request.repository]
    must(repository && canonical(repository) === canonical(context.repository) && context.scope.repository === repository.alias && context.scope.targetBranch === repository.targetBranch)
    must(config.repositories[repository.alias] === repository.root && await realpath(repository.root) === repository.root && inside(config.workspace, repository.root))
    assertOpen()
  }
  async function localAttestation(context: JenkinsObservationContext): Promise<{ document: AttestationFile; entry: AttestationFile['repositories'][string] }> {
    await bound(context)
    const document = await readAttestation(runtime.attestationFile)
    // No alias discovery: every entry must remain inside the exact configured registry.
    for (const [alias, entry] of Object.entries(document.repositories)) {
      const repository = policy.repositories[alias]
      must(repository && repository.root === entry.root && config.repositories[alias] === entry.root && await realpath(entry.root) === entry.root)
    }
    const entry = document.repositories[context.repository.alias]
    const route = context.scope.environment && context.repository.environments[context.scope.environment]
    must(entry && route && (context.scope.environment === 'test' || context.scope.environment === 'preprod') && entry.destinationId === route.destinationId
      && entry.remoteDeadlineEnforced === true && route.remoteDeadlineEnforced === true
      && canonical(entry.configSha256) === canonical(route.expectedConfigSha256)
      && canonical(Object.keys(entry.targets).sort()) === canonical([...route.jobs].sort()))
    assertOpen(); must(Date.parse(document.expiresAt) > Date.now())
    return { document, entry }
  }
  async function attest(context: JenkinsObservationContext): Promise<JenkinsDeploymentAttestation | undefined> {
    try {
      const { document, entry } = await localAttestation(context)
      const evidence = await tickets.evidence(context.request.taskId, context.request.repository, context.request.sha)
      if (!evidence) return undefined // Before ticket issuance, absence cannot authorize merge or fabricate a deadline.
      const plan = evidence.mergePlan
      must(context.repository.mergeMode === 'merge-commit' ? plan && plan.version === 2 && plan.sourceSha === context.request.sha
        && plan.ciSha256 === context.repository.ciSha256 && plan.validationProfile === 'full-verify' : !plan)
      const route = context.repository.environments[context.scope.environment!]!
      must(evidence.policyDigest === digest && Number.isFinite(Date.parse(evidence.deadline)) && Number.isFinite(Date.parse(evidence.sourceNotBefore)) && Date.parse(evidence.sourceNotBefore) <= Date.now() && canonical(Object.keys(evidence.jobTickets).sort()) === canonical([...route.jobs].sort()))
      const grants = new Set<string>()
      for (const job of route.jobs) {
        const payload = evidence.jobTickets[job]!.payload
        must(payload.taskId === context.request.taskId && payload.sourceSha === context.request.sha && payload.projectId === context.repository.projectId
          && payload.environment === context.scope.environment && payload.destinationId === route.destinationId && payload.keyId === runtime.keyId
          && payload.operationId === evidence.operationId && payload.expiresAt === evidence.deadline && canonical(payload.jobs) === canonical([job])
          && Date.parse(evidence.sourceNotBefore) <= Date.parse(payload.issuedAt))
        must(plan ? payload.version === 2 && payload.targetSha === plan.targetSha && payload.expectedTreeSha === plan.expectedTreeSha
          && payload.validationProfile === plan.validationProfile : payload.version === 1)
        grants.add(payload.grantId)
      }
      must(grants.size === 1 && Date.parse(document.expiresAt) > Date.now()); assertOpen()
      return { expiresAt: document.expiresAt, notBefore: evidence.sourceNotBefore, configSha256: { ...entry.configSha256 }, deadline: evidence.deadline, remoteDeadlineEnforced: entry.remoteDeadlineEnforced,
        destinationId: entry.destinationId, targets: structuredClone(entry.targets), ...(plan ? { mergePlan: structuredClone(plan) } : {}) }
    } catch { return undefined }
  }
  function guarded(context: DispatchContext, document?: AttestationFile): DispatchContext {
    const assertAuthorized = context.assertAuthorized
    return { ...context, assertAuthorized: () => {
      assertOpen(); must(policy.enabled)
      if (document) assertUnchangedAttestation(runtime.attestationFile, document)
      assertAuthorized()
    } }
  }
  const gitlab = (options.gitlabFactory ?? createGitlabTransport)({ tempRoot: resolve(config.stateDir, 'release-git'), fetch: options.fetch, deploymentTickets: {
    async metadata(context) {
      await bound(context)
      if (!context.repository.mergeTriggersDeploy || (context.repository.mergeMode === 'merge-commit' && context.request.action === 'create_mr')) return ''
      const { document } = await localAttestation(context)
      return tickets.metadata(guarded(context, document))
    },
    async verify(context, description) {
      await bound(context)
      const { document } = await localAttestation(context)
      await tickets.verify(guarded(context, document), description)
    },
    async evidence(taskId, repository, sha) {
      assertOpen()
      must(policy.repositories[repository])
      const evidence = await tickets.evidence(taskId, repository, sha)
      assertOpen()
      must(!evidence || evidence.policyDigest === digest)
      return evidence
    },
  } })
  async function observe(context: Parameters<ReleaseTransport['observe']>[0], signal: AbortSignal) {
    await bound(context)
    const combined = AbortSignal.any([signal, lifetime.signal])
    combined.throwIfAborted()
    const snapshot = await gitlab.observe(structuredClone(context), combined)
    combined.throwIfAborted(); assertOpen()
    if (!context.scope.environment || context.request.action === 'prepare_merge') return snapshot
    return (options.observer ?? overlayJenkinsObservation)(context, snapshot, combined, { fetch: options.fetch, attest })
  }
  function tracked<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation(); pending.add(promise)
    void promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }
  const transport: ReleaseTransport = {
    planMerge: (context, signal) => tracked(async () => {
      const copied = structuredClone({ repository: context.repository, scope: context.scope, request: context.request, candidate: context.candidate, snapshot: context.snapshot })
      await bound(copied)
      const combined = AbortSignal.any([signal, lifetime.signal])
      combined.throwIfAborted(); assertOpen(); must(gitlab.planMerge)
      const plan = await gitlab.planMerge(copied, combined)
      combined.throwIfAborted(); assertOpen()
      return structuredClone(plan)
    }),
    observe: (context, signal) => tracked(async () => observe(structuredClone({ repository: context.repository, scope: context.scope, request: context.request, ...(context.operation ? { operation: context.operation } : {}) }), signal)),
    dispatch: (context, signal) => tracked(async () => {
      // Clone all data while preserving the deliberately host-only live callback.
      const copied = { ...structuredClone({ ...context, assertAuthorized: undefined }), assertAuthorized: context.assertAuthorized }
      await bound(copied)
      const combined = AbortSignal.any([signal, lifetime.signal])
      let next = guarded(copied)
      next.assertAuthorized(); combined.throwIfAborted()
      if (copied.request.action === 'deploy') throw new Error('Deploy is observation-only; duplicate Jenkins trigger denied')
      if (copied.repository.mergeTriggersDeploy && copied.scope.actions.includes('merge')
        && (copied.request.action === 'prepare_merge' || (copied.repository.mergeMode !== 'merge-commit' && copied.request.action === 'create_mr'))) {
        const { document } = await localAttestation(copied)
        next = guarded(copied, document)
      }
      if (copied.request.action === 'merge' && copied.repository.mergeTriggersDeploy) {
        const { document } = await localAttestation(copied)
        const snapshot = await observe({ repository: copied.repository, scope: copied.scope, request: copied.request, operation: copied.operation }, combined)
        const route = copied.repository.environments[copied.scope.environment!]!, deployment = snapshot.deployment
        must(deployment && deployment.state === 'absent' && deployment.ids.length === 0 && deployment.sourceSha === copied.request.sha
          && deployment.routeId === route.id && deployment.destinationId === route.destinationId && deployment.remoteDeadlineEnforced === true
          && canonical(deployment.configSha256) === canonical(route.expectedConfigSha256) && deployment.deadline
          && Date.parse(deployment.deadline) > Date.now() && Date.parse(deployment.deadline) <= Date.parse(copied.deadline))
        if (copied.repository.mergeMode === 'merge-commit') {
          const plan = copied.operation.mergePlan, preparation = snapshot.preparation
          must(plan && preparation?.verified === true && preparation.operationId === copied.operation.preparationId
            && canonical(preparation.plan) === canonical(plan) && snapshot.sourceSha === plan.sourceSha && snapshot.targetSha === plan.targetSha
            && snapshot.targetCiSha256 === plan.ciSha256 && Date.parse(preparation.expiresAt) > Date.now()
            && deployment.approvedSourceSha === copied.request.sha && canonical(deployment.mergePlan) === canonical(plan))
        }
        next = guarded({ ...copied, snapshot }, document)
      }
      next.assertAuthorized(); combined.throwIfAborted()
      return gitlab.dispatch(next, combined)
    }),
  }
  let closing: Promise<void> | undefined
  return { transport, close: () => {
    if (closing) return closing
    closed = true; lifetime.abort()
    return closing = (async () => { await Promise.allSettled([...pending]) })()
  } }
}
