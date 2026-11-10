/** Immutable host-issued HMAC metadata for Jenkins' one-write admission gate. Never consumes a remote ticket. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DeploymentRoute, DispatchContext, MergePlan } from './contracts.ts'

export interface DeploymentTicketOptions { keyId: string; keyFile: string; stateDir: string; freezeWindows: { from: string; until: string }[] }
export interface DeploymentTickets {
  metadata(context: DispatchContext): Promise<string>
  verify(context: DispatchContext, description: string): Promise<void>
  /** Read-only signed facts, including expired tickets; never admission, consumption or renewal. */
  evidence(taskId: string, repository: string, sha: string): Promise<DeploymentTicketEvidence | undefined>
}
export interface DeploymentTicketEvidence {
  deadline: string; sourceNotBefore: string; operationId: string; policyDigest: string; jobTickets: Record<string, DeploymentEnvelope>
  mergePlan?: MergePlan; metadata?: string; metadataDigest?: string
}
interface PayloadFields {
  taskId: string; grantId: string; operationId: string; projectId: number; sourceSha: string
  environment: 'test' | 'preprod'; jobs: [string]; destinationId: string; issuedAt: string; notBefore: string
  expiresAt: string; freezeWindows: { from: string; until: string }[]; keyId: string; nonce: string
}
type Payload = PayloadFields & ({ version: 1 } | { version: 2; targetSha: string; expectedTreeSha: string; validationProfile: 'full-verify' })
export interface DeploymentEnvelope { payload: Payload; signature: string }
type Envelope = DeploymentEnvelope
interface Identity { taskId: string; grantId: string; repository: string; sha: string }
interface TicketRecord { version: 1 | 2; identity: Identity; bindingHash: string; policyDigest: string; sourceNotBefore: string; operationId: string; metadata: string; mergePlan?: MergePlan }
interface Admitted { identity: Identity; bindingHash: string; route: DeploymentRoute; projectId: number; environment: 'test' | 'preprod'; sourceNotBefore: string; deadline: number; windows: { from: string; until: string }[]; mergePlan?: MergePlan; preparationId?: string }
const PREFIX = '<!-- superagent-deploy-v1\n', SUFFIX = '\n-->'
const RETAINED = { from: '2026-11-12T00:00:00+08:00', until: '2026-11-14T00:00:00+08:00' }
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const HASH = /^[a-f0-9]{64}$/
const MAX_BYTES = 256 * 1024
const MAX_METADATA_BYTES = 32 * 1024
const PAYLOAD_KEYS = ['version', 'taskId', 'grantId', 'operationId', 'projectId', 'sourceSha', 'environment', 'jobs', 'destinationId', 'issuedAt', 'notBefore', 'expiresAt', 'freezeWindows', 'keyId', 'nonce']
const PLAN_KEYS = ['version', 'sourceSha', 'targetSha', 'expectedTreeSha', 'ciSha256', 'validationProfile']
function validPlan(plan: MergePlan | undefined): plan is MergePlan {
  return !!plan && exactKeys(plan, PLAN_KEYS) && plan.version === 2 && SHA.test(plan.sourceSha) && SHA.test(plan.targetSha)
    && plan.sourceSha !== plan.targetSha && SHA.test(plan.expectedTreeSha) && HASH.test(plan.ciSha256) && plan.validationProfile === 'full-verify'
}
function payloadMatchesPlan(payload: Payload, plan?: MergePlan): boolean {
  return plan ? payload.version === 2 && exactKeys(payload, [...PAYLOAD_KEYS, 'targetSha', 'expectedTreeSha', 'validationProfile'])
    && payload.sourceSha === plan.sourceSha && payload.targetSha === plan.targetSha && payload.expectedTreeSha === plan.expectedTreeSha && payload.validationProfile === plan.validationProfile
    : payload.version === 1 && exactKeys(payload, PAYLOAD_KEYS)
}
function exactKeys(value: object, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function requireSafe(condition: unknown): asserts condition { if (!condition) throw new Error('Deployment ticket evidence invalid, expired or unavailable') }
function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value) }
function ascii(value: string): boolean { return /^[\x20-\x7e]*$/.test(value) }
/** Python json.dumps(sort_keys=True,separators=(',',':'),ensure_ascii=True), restricted to ASCII/no floats. */
function canonical(value: unknown): string {
  if (typeof value === 'string') { requireSafe(/^[\x00-\x7e]*$/.test(value)); return JSON.stringify(value) }
  if (typeof value === 'number') { requireSafe(Number.isSafeInteger(value)); return String(value) }
  if (typeof value === 'boolean' || value === null) return JSON.stringify(value)
  if (Array.isArray(value)) {
    requireSafe(Object.keys(value).length === value.length && Object.keys(value).every((key, index) => key === String(index)))
    return `[${value.map(canonical).join(',')}]`
  }
  requireSafe(value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
  const entries = Object.entries(value)
  for (const [key] of entries) requireSafe(ascii(key) && !['__proto__', 'prototype', 'constructor'].includes(key))
  return `{${entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
function time(value: unknown): number {
  requireSafe(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !value.endsWith('-00:00'))
  if (!value.endsWith('Z')) { const h = Number(value.slice(-5, -3)), m = Number(value.slice(-2)); requireSafe(h <= 14 && m < 60 && (h < 14 || m === 0)) }
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`), result = Date.parse(value)
  requireSafe(Number.isFinite(result) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10)
    && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60)
  return result
}
function job(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/ -]{0,255}$/.test(value) && value === value.trim()
    && value.split('/').every(part => !!part && part !== '.' && part !== '..' && part === part.trim())
}
function pathSafe(path: string): void { requireSafe(isAbsolute(path) && resolve(path) === path && !path.startsWith('//') && !path.includes('\0')) }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) }
async function directory(path: string, privateLeaf = false): Promise<void> {
  pathSafe(path)
  requireSafe(await realpath(path) === path)
  let current = path
  for (;;) {
    const stat = await lstat(current), mode = stat.mode & 0o7777
    requireSafe(stat.isDirectory() && !stat.isSymbolicLink() && (!process.getuid || stat.uid === 0 || stat.uid === process.getuid()))
    requireSafe((mode & 0o022) === 0 || (stat.uid === 0 && (mode & 0o1000) !== 0))
    if (current === path && privateLeaf) requireSafe((mode & 0o777) === 0o700 && (!process.getuid || stat.uid === process.getuid()))
    const parent = dirname(current); if (parent === current) return; current = parent
  }
}
async function privateFile(path: string, limit: number): Promise<Buffer> {
  pathSafe(path); await directory(dirname(path))
  const before = await lstat(path)
  requireSafe(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && (before.mode & 0o777) === 0o600
    && before.size <= limit && (!process.getuid || before.uid === process.getuid()))
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    requireSafe(stat.ino === before.ino && stat.dev === before.dev && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size <= limit)
    const buffer = Buffer.alloc(limit + 1), read = await file.read(buffer, 0, buffer.length, 0)
    requireSafe(read.bytesRead <= limit)
    const after = await file.stat(), live = await lstat(path)
    requireSafe(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.nlink === 1 && live.ino === stat.ino && live.dev === stat.dev)
    return buffer.subarray(0, read.bytesRead)
  } finally { await file.close() }
}
async function ensureDirectory(path: string): Promise<void> {
  pathSafe(path)
  try { await directory(path, true); return } catch (error) {
    try { await lstat(path); throw error } catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe }
  }
  const parent = dirname(path)
  await directory(parent)
  try { await mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await directory(path, true)
  const parentFile = await open(parent, constants.O_RDONLY)
  try { await parentFile.sync() } finally { await parentFile.close() }
}
function block(envelopes: Envelope[]): string { return `${PREFIX}${canonical(envelopes)}${SUFFIX}` }
function extract(description: string): string {
  requireSafe(typeof description === 'string' && Buffer.byteLength(description) <= 40 * 1024)
  const starts = [...description.matchAll(/<!--\s*superagent-deploy-v1/g)]
  requireSafe(starts.length === 1)
  const start = starts[0]!.index!, end = description.indexOf(SUFFIX, start)
  requireSafe(end >= 0 && description.slice(start).startsWith(PREFIX))
  return description.slice(start, end + SUFFIX.length)
}

export function createDeploymentTickets(options: DeploymentTicketOptions): DeploymentTickets {
  requireSafe(options && exactKeys(options, ['keyId', 'keyFile', 'stateDir', 'freezeWindows']))
  canonical(options)
  const config = structuredClone(options)
  requireSafe(id(config.keyId) && Array.isArray(config.freezeWindows) && config.freezeWindows.length <= 63)
  pathSafe(config.keyFile); pathSafe(config.stateDir)
  const windows = [...config.freezeWindows, RETAINED].map(window => {
    requireSafe(window && Object.keys(window).length === 2 && Object.hasOwn(window, 'from') && Object.hasOwn(window, 'until'))
    const from = time(window.from), until = time(window.until); requireSafe(from < until)
    return { from: new Date(from).toISOString(), until: new Date(until).toISOString() }
  }).filter((window, i, all) => all.findIndex(item => item.from === window.from && item.until === window.until) === i)
    .sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.until < b.until ? -1 : a.until > b.until ? 1 : 0)

  function admit(context: DispatchContext): Admitted {
    context.assertAuthorized()
    const { grant, scope, repository, request, operation } = context
    requireSafe(repository.mergeTriggersDeploy === true && scope.actions.includes('merge') && scope.actions.includes('deploy')
      && (scope.environment === 'test' || scope.environment === 'preprod') && scope.repository === repository.alias && request.repository === repository.alias
      && request.taskId === grant.taskId && id(request.taskId) && id(grant.id) && id(grant.ownerId) && id(grant.approvalMessageId)
      && SHA.test(request.sha) && HASH.test(grant.policyDigest) && scope.targetBranch === repository.targetBranch && scope.sourceBranch !== scope.targetBranch
      && SHA.test(scope.baseSha) && grant.scopes.filter(item => item.repository === repository.alias).length === 1
      && canonical(grant.scopes.find(item => item.repository === repository.alias)) === canonical(scope))
    requireSafe(operation.taskId === request.taskId && operation.grantId === grant.id && operation.repository === request.repository && operation.sha === request.sha
      && operation.policyDigest === grant.policyDigest && operation.action === request.action && id(operation.id)
      && Number.isSafeInteger(repository.projectId) && repository.projectId > 0)
    const mergePlan = operation.mergePlan
    const ordinary = repository.mergeMode === 'merge-commit'
    requireSafe(ordinary ? validPlan(mergePlan) && ['prepare_merge', 'merge'].includes(request.action)
      && mergePlan.sourceSha === request.sha && mergePlan.ciSha256 === repository.ciSha256
      && context.snapshot.sourceSha === request.sha && context.snapshot.targetSha === mergePlan.targetSha && context.snapshot.targetCiSha256 === mergePlan.ciSha256
      && context.candidate.sha === request.sha && context.candidate.ciSha256 === mergePlan.ciSha256
      && (request.action === 'prepare_merge' || id(operation.preparationId)) : mergePlan === undefined && request.action !== 'prepare_merge')
    const preparationId = ordinary ? request.action === 'prepare_merge' ? operation.id : operation.preparationId : undefined
    const route = repository.environments[scope.environment]
    requireSafe(route?.kind === 'jenkins' && id(route.destinationId) && route.jobs.length > 0 && route.jobs.length <= 32
      && route.jobs.every(job) && new Set(route.jobs).size === route.jobs.length && Object.keys(route.expectedConfigSha256).length === route.jobs.length
      && scope.actions.includes(request.action === 'prepare_merge' ? 'merge' : request.action) && canonical(scope.actions) === canonical([...new Set(scope.actions)])
      && route.jobs.every(name => HASH.test(route.expectedConfigSha256[name] ?? '')))
    requireSafe(!inside(repository.root, config.keyFile) && !inside(repository.root, config.stateDir))
    const now = Date.now(), issued = time(grant.issuedAt), expiry = time(grant.expiresAt)
    requireSafe(issued <= now && expiry > now && expiry - issued <= 43_200_000 && expiry > issued)
    for (const window of windows) requireSafe(!(time(window.from) <= now && now < time(window.until)))
    const deadline = Math.min(time(context.deadline), expiry, now + 43_200_000, ...windows.filter(window => time(window.from) > now).map(window => time(window.from)))
    requireSafe(deadline > now)
    const identity: Identity = { taskId: request.taskId, grantId: grant.id, repository: repository.alias, sha: request.sha }
    // Neither a policy change nor a different route/action scope creates a second identity capable of renewing the ticket.
    const bindingHash = createHash('sha256').update(canonical({ identity, policyDigest: grant.policyDigest, ownerId: grant.ownerId, approvalMessageId: grant.approvalMessageId,
      grantIssuedAt: grant.issuedAt, grantExpiresAt: grant.expiresAt, scope, projectId: repository.projectId, projectPath: repository.projectPath,
      host: repository.host, targetBranch: repository.targetBranch, route, windows, keyId: config.keyId,
      ...(mergePlan ? { mergePlan, preparationId } : {}) })).digest('hex')
    return { identity, bindingHash, route, projectId: repository.projectId, environment: scope.environment, sourceNotBefore: grant.issuedAt, deadline, windows,
      ...(mergePlan ? { mergePlan: structuredClone(mergePlan), preparationId } : {}) }
  }
  function location(identity: Identity): string { return join(config.stateDir, `${createHash('sha256').update(canonical(identity)).digest('hex')}.json`) }
  async function readRecord(path: string): Promise<TicketRecord | undefined> {
    try {
      const raw = await privateFile(path, MAX_BYTES), parsed: unknown = JSON.parse(raw.toString('utf8'))
      requireSafe(parsed && typeof parsed === 'object' && canonical(parsed) === raw.toString('utf8'))
      const record = parsed as TicketRecord
      requireSafe(exactKeys(record, ['version', 'identity', 'bindingHash', 'policyDigest', 'sourceNotBefore', 'operationId', 'metadata', ...(record.version === 2 ? ['mergePlan'] : [])])
        && (record.version === 1 || (record.version === 2 && validPlan(record.mergePlan))) && id(record.operationId) && HASH.test(record.bindingHash) && HASH.test(record.policyDigest)
        && record.identity && exactKeys(record.identity, ['taskId', 'grantId', 'repository', 'sha']) && id(record.identity.taskId) && id(record.identity.grantId) && typeof record.identity.repository === 'string' && ascii(record.identity.repository)
        && SHA.test(record.identity.sha) && typeof record.metadata === 'string' && Number.isFinite(time(record.sourceNotBefore)))
      requireSafe(record.version !== 2 || record.mergePlan!.sourceSha === record.identity.sha)
      return record
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async function key(): Promise<Buffer> { const key = await privateFile(config.keyFile, 32); requireSafe(key.length === 32); return key }
  function checked(record: TicketRecord, admitted: Admitted, key: Buffer): string {
    requireSafe(canonical(record.identity) === canonical(admitted.identity) && record.bindingHash === admitted.bindingHash && record.sourceNotBefore === admitted.sourceNotBefore
      && extract(record.metadata) === record.metadata
      && (admitted.mergePlan ? record.version === 2 && canonical(record.mergePlan) === canonical(admitted.mergePlan) && record.operationId === admitted.preparationId : record.version === 1))
    const envelopes = JSON.parse(record.metadata.slice(PREFIX.length, -SUFFIX.length)) as Envelope[]
    requireSafe(Array.isArray(envelopes) && envelopes.length === admitted.route.jobs.length && block(envelopes) === record.metadata)
    for (const [index, envelope] of envelopes.entries()) {
      requireSafe(envelope && Object.keys(envelope).length === 2 && Object.hasOwn(envelope, 'payload') && Object.hasOwn(envelope, 'signature') && HASH.test(envelope.signature))
      const payload = envelope.payload
      requireSafe(payload && payloadMatchesPlan(payload, admitted.mergePlan) && payload.taskId === admitted.identity.taskId
        && payload.grantId === admitted.identity.grantId && payload.operationId === record.operationId && payload.sourceSha === admitted.identity.sha
        && payload.projectId === admitted.projectId && payload.environment === admitted.environment
        && payload.destinationId === admitted.route.destinationId && payload.keyId === config.keyId && Array.isArray(payload.jobs) && payload.jobs.length === 1
        && payload.jobs[0] === admitted.route.jobs[index] && /^[A-Za-z0-9_-]{43}$/.test(payload.nonce) && canonical(payload.freezeWindows) === canonical(admitted.windows))
      const issued = time(payload.issuedAt), begin = time(payload.notBefore), expiry = time(payload.expiresAt), now = Date.now()
      requireSafe(time(record.sourceNotBefore) <= issued && issued <= begin && begin <= now && issued <= now && now < expiry && expiry - issued <= 43_200_000 && expiry <= admitted.deadline)
      const expected = createHmac('sha256', key).update(canonical(payload)).digest(), actual = Buffer.from(envelope.signature, 'hex')
      requireSafe(actual.length === expected.length && timingSafeEqual(actual, expected))
    }
    return record.metadata
  }
  async function generate(context: DispatchContext): Promise<string> {
    if (!context.repository.mergeTriggersDeploy) return ''
    requireSafe((context.repository.mergeMode === 'merge-commit' ? context.request.action === 'prepare_merge' : context.request.action === 'create_mr')
      && !context.request.description?.includes('superagent-deploy-v1'))
    let admission = admit(context)
    await ensureDirectory(config.stateDir)
    const secret = await key()
    try {
      admission = admit(context)
      const path = location(admission.identity), existing = await readRecord(path)
      if (existing) return checked(existing, admit(context), secret)
      const issued = new Date().toISOString(), expiry = new Date(admission.deadline).toISOString()
      const envelopes: Envelope[] = admission.route.jobs.map(job => {
        const payload: Payload = { ...(admission.mergePlan ? { version: 2 as const, targetSha: admission.mergePlan.targetSha, expectedTreeSha: admission.mergePlan.expectedTreeSha, validationProfile: admission.mergePlan.validationProfile } : { version: 1 as const }),
          taskId: admission.identity.taskId, grantId: admission.identity.grantId, operationId: context.operation.id,
          projectId: context.repository.projectId, sourceSha: context.request.sha, environment: context.scope.environment!, jobs: [job], destinationId: admission.route.destinationId,
          issuedAt: issued, notBefore: issued, expiresAt: expiry, freezeWindows: admission.windows, keyId: config.keyId, nonce: randomBytes(32).toString('base64url') }
        return { payload, signature: createHmac('sha256', secret).update(canonical(payload)).digest('hex') }
      })
      const record: TicketRecord = { version: admission.mergePlan ? 2 : 1, identity: admission.identity, bindingHash: admission.bindingHash, policyDigest: context.grant.policyDigest,
        sourceNotBefore: admission.sourceNotBefore, operationId: context.operation.id, metadata: block(envelopes), ...(admission.mergePlan ? { mergePlan: admission.mergePlan } : {}) }
      const contents = canonical(record); requireSafe(Buffer.byteLength(contents) <= MAX_BYTES && Buffer.byteLength(record.metadata) <= MAX_METADATA_BYTES)
      checked(record, admit(context), secret)
      let file
      try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const winner = await readRecord(path); requireSafe(winner); return checked(winner, admit(context), secret)
      }
      try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
      const dir = await open(config.stateDir, constants.O_RDONLY)
      try { await dir.sync() } finally { await dir.close() }
      // Revocation/expiry after durable creation burns the ticket; it never deletes or renews it.
      return checked(record, admit(context), secret)
    } finally { secret.fill(0) }
  }
  async function verify(context: DispatchContext, description: string): Promise<void> {
    if (!context.repository.mergeTriggersDeploy) return
    requireSafe(context.request.action === 'merge')
    const admission = admit(context)
    await directory(config.stateDir, true)
    const record = await readRecord(location(admission.identity)); requireSafe(record)
    const metadata = extract(description)
    const secret = await key()
    try { requireSafe(metadata === checked(record, admit(context), secret)) } finally { secret.fill(0) }
  }
  async function evidence(taskId: string, repository: string, sha: string): Promise<DeploymentTicketEvidence | undefined> {
    requireSafe(id(taskId) && typeof repository === 'string' && ascii(repository) && SHA.test(sha))
    try { await directory(config.stateDir, true) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    const files = await readdir(config.stateDir)
    requireSafe(files.length <= 10_000)
    const matches: TicketRecord[] = []
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const record = await readRecord(join(config.stateDir, name)); requireSafe(record)
      requireSafe(location(record.identity) === join(config.stateDir, name))
      if (record.identity.taskId === taskId && record.identity.repository === repository && record.identity.sha === sha) matches.push(record)
    }
    if (!matches.length) return undefined
    requireSafe(matches.length === 1)
    const record = matches[0]!, secret = await key()
    try {
      requireSafe(extract(record.metadata) === record.metadata)
      const envelopes = JSON.parse(record.metadata.slice(PREFIX.length, -SUFFIX.length)) as Envelope[]
      requireSafe(Array.isArray(envelopes) && envelopes.length > 0 && envelopes.length <= 32 && block(envelopes) === record.metadata)
      const jobTickets: Record<string, DeploymentEnvelope> = Object.create(null)
      let deadline: string | undefined
      for (const envelope of envelopes) {
        const payload = envelope.payload
        requireSafe(envelope && exactKeys(envelope, ['payload', 'signature']) && payload && payloadMatchesPlan(payload, record.mergePlan) && HASH.test(envelope.signature)
          && payload.taskId === taskId && payload.grantId === record.identity.grantId && payload.operationId === record.operationId
          && payload.sourceSha === sha && id(payload.keyId) && payload.keyId === config.keyId && id(payload.destinationId)
          && Number.isSafeInteger(payload.projectId) && payload.projectId > 0 && ['test', 'preprod'].includes(payload.environment)
          && Array.isArray(payload.jobs) && payload.jobs.length === 1 && job(payload.jobs[0]) && !Object.hasOwn(jobTickets, payload.jobs[0])
          && /^[A-Za-z0-9_-]{43}$/.test(payload.nonce) && canonical(payload.freezeWindows) === canonical(windows))
        const issued = time(payload.issuedAt), begin = time(payload.notBefore), expiry = time(payload.expiresAt)
        requireSafe(time(record.sourceNotBefore) <= issued && issued <= begin && begin < expiry && expiry - issued <= 43_200_000 && (!deadline || deadline === payload.expiresAt))
        deadline = payload.expiresAt
        const expected = createHmac('sha256', secret).update(canonical(payload)).digest(), actual = Buffer.from(envelope.signature, 'hex')
        requireSafe(actual.length === expected.length && timingSafeEqual(actual, expected))
        jobTickets[payload.jobs[0]] = structuredClone(envelope)
      }
      return { deadline: deadline!, sourceNotBefore: record.sourceNotBefore, operationId: record.operationId, policyDigest: record.policyDigest, jobTickets,
        ...(record.mergePlan ? { mergePlan: structuredClone(record.mergePlan), metadata: record.metadata, metadataDigest: createHash('sha256').update(record.metadata).digest('hex') } : {}) }
    } finally { secret.fill(0) }
  }
  return {
    async evidence(taskId, repository, sha) { try { return await evidence(taskId, repository, sha) } catch { throw new Error('Deployment ticket evidence unavailable or ambiguous') } },
    async metadata(context) { try { return await generate(context) } catch { throw new Error('Deployment ticket metadata unavailable; no automatic replacement or renewal') } },
    async verify(context, description) { try { await verify(context, description) } catch { throw new Error('Deployment ticket verification failed; merge must remain blocked') } },
  }
}
