/** Offline HMAC metadata tests; Python gate.validate is pure and never consumes or contacts Jenkins. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createDeploymentTickets, type DeploymentEnvelope, type DeploymentTicketOptions } from '../src/nightshift/release/deployment-tickets.ts'
import type { DispatchContext, MergePlan } from '../src/nightshift/release/contracts.ts'

const roots: string[] = [], SHA = 'a'.repeat(40), BASE = 'b'.repeat(40), HASH = 'c'.repeat(64), JOB = 'test/app'
const NOW = new Date('2026-11-10T04:00:00Z')
const key = Buffer.alloc(32, 42)
const gate = fileURLToPath(new URL('../integrations/jenkins/nightshift-gate.py', import.meta.url))
const future = (milliseconds = 60_000) => new Date(Date.now() + milliseconds).toISOString()
function canonical(value: unknown): string { return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value) }
function envelopes(metadata: string): DeploymentEnvelope[] { return JSON.parse(metadata.slice('<!-- superagent-deploy-v1\n'.length, -'\n-->'.length)) }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-deploy-tickets-'))); roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo, { mode: 0o700 })
  const keyFile = join(root, 'key.bin'); writeFileSync(keyFile, key, { mode: 0o600 })
  const options: DeploymentTicketOptions = { keyId: 'jenkins-test-v1', keyFile, stateDir: join(root, 'tickets'), freezeWindows: [] }
  const scope = { repository: 'app', sourceBranch: 'agent/task-1', targetBranch: 'master', baseSha: BASE, actions: ['push', 'create_mr', 'merge', 'deploy'] as const, environment: 'test' as const }
  const context: DispatchContext = {
    deadline: future(90_000), assertAuthorized: vi.fn(),
    request: { taskId: 'task-1', repository: 'app', action: 'create_mr', sha: SHA, title: 'Approved change' },
    operation: { id: 'create-operation', logicalKey: HASH, grantId: 'grant-1', taskId: 'task-1', repository: 'app', action: 'create_mr', sha: SHA, policyDigest: HASH, state: 'dispatching', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), remoteIds: [], detail: 'prepared' },
    repository: { alias: 'app', root: repo, projectId: 445, projectPath: 'payment/refactor/app', host: 'git.example.test', apiOrigin: 'https://git.example.test', expectedUserId: 9, expectedUsername: 'bot', credentialFile: join(root, 'git-key'), targetBranch: 'master', ciSha256: HASH, requiredJobs: ['unit'], mergeTriggersDeploy: true, triggerPolicy: { reviewedAt: future(-1000), expiresAt: future(3600_000), productionExcluded: true, fingerprint: 'reviewed' }, environments: { test: { kind: 'jenkins', id: 'test-route', jobs: [JOB], origin: 'https://jenkins.example.test', expectedConfigSha256: { [JOB]: HASH }, destinationId: 'test:namespace:app', remoteDeadlineEnforced: true, credentialRef: join(root, 'reader') } } },
    scope: { ...scope, actions: [...scope.actions] },
    grant: { id: 'grant-1', taskId: 'task-1', ownerId: 'owner', approvalMessageId: 'dm-1', issuedAt: future(-1000), expiresAt: future(60_000), policyDigest: HASH, scopes: [{ ...scope, actions: [...scope.actions] }] },
    candidate: { taskId: 'task-1', repository: 'app', sha: SHA, treeSha: BASE, baseSha: BASE, sourceBranch: 'agent/task-1', clean: true, commitReceiptId: 'receipt', validated: true, validationReceiptIds: ['validation'], ciSha256: HASH, changedProtectedPaths: [] },
    snapshot: { identity: { id: 9, username: 'bot' }, project: { id: 445, path: 'payment/refactor/app', defaultBranch: 'master', pipelineRequired: true }, sourceSha: SHA, targetSha: BASE, targetCiSha256: HASH, productionExcluded: true, triggerPolicyFingerprint: 'reviewed' },
  }
  const signer = createDeploymentTickets(options)
  const merge = () => ({ ...context, request: { ...context.request, action: 'merge' as const }, operation: { ...context.operation, id: 'merge-operation', action: 'merge' as const } })
  return { root, repo, options, context, signer, merge }
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-deploy-tickets-')) throw new Error(`Unsafe cleanup ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})
const python = String.raw`
import importlib.util,json,sys
from datetime import datetime
spec=importlib.util.spec_from_file_location('nightshift_gate',sys.argv[1]); g=importlib.util.module_from_spec(spec);sys.modules[spec.name]=g;spec.loader.exec_module(g)
data=json.load(sys.stdin); results=[]
for ticket in data['tickets']:
 p=ticket['payload']; ctx=g.GateContext(job=p['jobs'][0],build_id='fixture-build-1',source_sha=p['sourceSha'],project_id=p['projectId'],destination_id=p['destinationId'],environment=p['environment'],key_id=p['keyId'])
 try: results.append(g.validate(ticket,bytes.fromhex(data['key']),ctx,datetime.fromisoformat(data['now'].replace('Z','+00:00'))))
 except g.GateDenied as e: results.append({'denied':str(e)})
print(json.dumps(results))
`

describe('immutable host deployment ticket issuance', () => {
  it('signs one exact envelope per job accepted by real pure Python validation, never local admission', async () => {
    const h = fixture(), route = h.context.repository.environments.test!
    route.jobs.push('test/worker'); route.expectedConfigSha256['test/worker'] = HASH
    const metadata = await h.signer.metadata(h.context), tickets = envelopes(metadata)
    expect(tickets).toHaveLength(2)
    for (const [index, ticket] of tickets.entries()) {
      expect(Object.keys(ticket.payload)).toHaveLength(15)
      expect(ticket.payload).toMatchObject({ version: 1, taskId: 'task-1', grantId: 'grant-1', operationId: 'create-operation', projectId: 445, sourceSha: SHA, jobs: [route.jobs[index]], environment: 'test', expiresAt: h.context.grant.expiresAt, keyId: h.options.keyId })
      expect(Buffer.from(ticket.payload.nonce, 'base64url')).toHaveLength(32)
      expect(ticket.signature).toBe(createHmac('sha256', key).update(canonical(ticket.payload)).digest('hex'))
    }
    const results = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', python, gate], { input: JSON.stringify({ tickets, key: key.toString('hex'), now: NOW.toISOString() }), encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }))
    expect(results).toHaveLength(2)
    expect(results.every((result: Record<string, unknown>) => result.valid === true && result.admissionOnly === true && result.postAdmissionCancellation === false && result.allowed === undefined)).toBe(true)
    expect(readdirSync(h.options.stateDir)).toHaveLength(1)
    expect(metadata).not.toContain(key.toString('hex'))
    await expect(h.signer.verify(h.merge(), `human MR prose\n${metadata}\nmore prose`)).resolves.toBeUndefined()
  })

  it('returns identical signed nonces/expiry across repeat calls and process reconstruction without renewal', async () => {
    const h = fixture(), first = await h.signer.metadata(h.context)
    vi.setSystemTime(Date.now() + 1000)
    h.context.deadline = future(120_000)
    h.context.operation.id = 'different-create-attempt'
    expect(await h.signer.metadata(h.context)).toBe(first)
    expect(await createDeploymentTickets(h.options).metadata(h.context)).toBe(first)
    expect(envelopes(first)[0]!.payload.operationId).toBe('create-operation')
    expect(readdirSync(h.options.stateDir)).toHaveLength(1)
  })

  it('caps expiry to current shift and next explicit or retained freeze', async () => {
    const h = fixture(); h.context.deadline = future(20_000)
    expect(envelopes(await h.signer.metadata(h.context))[0]!.payload.expiresAt).toBe(h.context.deadline)
    const custom = fixture(); custom.options.freezeWindows = [{ from: future(10_000), until: future(30_000) }]
    const metadata = await createDeploymentTickets(custom.options).metadata(custom.context)
    expect(envelopes(metadata)[0]!.payload.expiresAt).toBe(future(10_000))
    vi.setSystemTime(new Date('2026-11-11T15:59:50Z'))
    const retained = fixture()
    expect(envelopes(await retained.signer.metadata(retained.context))[0]!.payload.expiresAt).toBe('2026-11-11T16:00:00.000Z')
  })

  it.each(['retained-freeze', 'custom-freeze', 'expired', 'future-grant', 'over-12h', 'revoked', 'wrong-phase', 'reserved-description'] as const)('does not issue %s tickets', async invalid => {
    if (invalid === 'retained-freeze') vi.setSystemTime(new Date('2026-11-12T00:00:00Z'))
    const h = fixture()
    if (invalid === 'custom-freeze') { h.options.freezeWindows = [{ from: future(-1000), until: future(1000) }]; h.signer = createDeploymentTickets(h.options) }
    if (invalid === 'expired') h.context.deadline = future(-1)
    if (invalid === 'future-grant') h.context.grant.issuedAt = future(1000)
    if (invalid === 'over-12h') h.context.grant.expiresAt = future(43_200_000)
    if (invalid === 'revoked') h.context.assertAuthorized = () => { throw new Error('PRIVATE_SECRET_ERROR') }
    if (invalid === 'wrong-phase') h.context.request.action = 'push'
    if (invalid === 'reserved-description') h.context.request.description = '<!-- superagent-deploy-v1\n[]\n-->'
    await expect(h.signer.metadata(h.context)).rejects.toThrow('metadata unavailable')
    expect(existsSync(h.options.stateDir) ? readdirSync(h.options.stateDir) : []).toEqual([])
  })

  it.each(['missing-deploy', 'production', 'unknown-job', 'duplicate-job', 'unicode-job', 'route-key', 'scope-repo', 'project-id', 'prototype'] as const)('rejects %s scope or policy substitution', async invalid => {
    const h = fixture(), route = h.context.repository.environments.test!
    if (invalid === 'missing-deploy') h.context.scope.actions = ['create_mr', 'merge']
    if (invalid === 'production') (h.context.scope as { environment: string }).environment = 'production'
    if (invalid === 'unknown-job') route.jobs.push('test/unpinned')
    if (invalid === 'duplicate-job') route.jobs.push(JOB)
    if (invalid === 'unicode-job') route.jobs[0] = 'test/发布'
    if (invalid === 'route-key') Object.defineProperty(route, '__proto__', { value: { polluted: true }, enumerable: true })
    if (invalid === 'scope-repo') h.context.scope.repository = 'other'
    if (invalid === 'project-id') h.context.repository.projectId = 1.5
    if (invalid === 'prototype') Object.setPrototypeOf(h.context.scope, { malicious: true })
    await expect(h.signer.metadata(h.context)).rejects.toThrow()
  })

  it('does nothing for repositories without automatic deployment and never exposes key material', async () => {
    const h = fixture(); h.context.repository.mergeTriggersDeploy = false
    expect(await h.signer.metadata(h.context)).toBe('')
    await expect(h.signer.verify(h.merge(), 'ordinary MR')).resolves.toBeUndefined()
    expect(existsSync(h.options.stateDir)).toBe(false)
  })
})

describe('merge verification and read-only stored evidence', () => {
  it.each(['missing', 'duplicate', 'tampered-signature', 'wrong-nonce', 'wrong-order', 'extra-field', 'wrong-phase', 'expired', 'shorter-deadline', 'policy-drift', 'route-drift', 'freeze-drift', 'forged-key'] as const)('refuses %s metadata instead of replacing or renewing it', async invalid => {
    const h = fixture(), original = await h.signer.metadata(h.context), context = h.merge()
    let metadata = original, signer = h.signer
    if (invalid === 'missing') metadata = 'no metadata'
    if (invalid === 'duplicate') metadata += `\n${original}`
    if (invalid === 'tampered-signature') { const parsed = envelopes(original); parsed[0]!.signature = '0'.repeat(64); metadata = `<!-- superagent-deploy-v1\n${canonical(parsed)}\n-->` }
    if (invalid === 'wrong-nonce') { const parsed = envelopes(original); parsed[0]!.payload.nonce = 'x'.repeat(43); metadata = `<!-- superagent-deploy-v1\n${canonical(parsed)}\n-->` }
    if (invalid === 'wrong-order') metadata = `<!-- superagent-deploy-v1\n${JSON.stringify(envelopes(original), null, 2)}\n-->`
    if (invalid === 'extra-field') { const parsed = envelopes(original); (parsed[0]!.payload as unknown as Record<string, unknown>).extra = true; metadata = `<!-- superagent-deploy-v1\n${canonical(parsed)}\n-->` }
    if (invalid === 'wrong-phase') (context as DispatchContext).request.action = 'create_mr'
    if (invalid === 'expired') vi.setSystemTime(Date.now() + 60_000)
    if (invalid === 'shorter-deadline') context.deadline = future(1000)
    if (invalid === 'policy-drift') { context.grant.policyDigest = 'f'.repeat(64); context.operation.policyDigest = context.grant.policyDigest }
    if (invalid === 'route-drift') context.repository.environments.test!.expectedConfigSha256[JOB] = 'f'.repeat(64)
    if (invalid === 'freeze-drift') signer = createDeploymentTickets({ ...h.options, freezeWindows: [{ from: future(5000), until: future(10_000) }] })
    if (invalid === 'forged-key') writeFileSync(h.options.keyFile, Buffer.alloc(32, 99))
    await expect(signer.verify(context, metadata)).rejects.toThrow('verification failed')
    const file = readdirSync(h.options.stateDir)[0]!
    expect(JSON.parse(readFileSync(join(h.options.stateDir, file), 'utf8')).metadata).toBe(original)
  })

  it('will not mint new metadata after expiry, policy change, or a partial existing immutable record', async () => {
    const h = fixture(), original = await h.signer.metadata(h.context)
    h.context.grant.policyDigest = h.context.operation.policyDigest = 'f'.repeat(64)
    await expect(h.signer.metadata(h.context)).rejects.toThrow()
    h.context.grant.policyDigest = h.context.operation.policyDigest = HASH
    vi.setSystemTime(Date.now() + 60_000)
    await expect(h.signer.metadata(h.context)).rejects.toThrow()
    expect(envelopes(original)[0]!.payload.nonce).toHaveLength(43)
    vi.setSystemTime(NOW)
    const path = join(h.options.stateDir, readdirSync(h.options.stateDir)[0]!); writeFileSync(path, '{')
    await expect(h.signer.metadata(h.context)).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{')
  })

  it('provides public signed facts after expiry for read-only observation, not a refreshed capability', async () => {
    const h = fixture(), metadata = await h.signer.metadata(h.context)
    const first = await h.signer.evidence('task-1', 'app', SHA)
    expect(first).toMatchObject({ deadline: h.context.grant.expiresAt, sourceNotBefore: h.context.grant.issuedAt, operationId: 'create-operation', policyDigest: HASH })
    expect(Date.parse(first!.sourceNotBefore)).toBeLessThan(Date.parse(first!.jobTickets[JOB]!.payload.notBefore))
    expect(first!.jobTickets[JOB]).toEqual(envelopes(metadata)[0])
    vi.setSystemTime(Date.now() + 120_000)
    expect(await createDeploymentTickets(h.options).evidence('task-1', 'app', SHA)).toEqual(first)
    expect(await h.signer.evidence('other-task', 'app', SHA)).toBeUndefined()
    expect(JSON.stringify(first)).not.toContain(h.options.keyFile)
  })

  it('rejects stored sourceNotBefore later than signed issuance rather than hiding pre-sign builds', async () => {
    const h = fixture(); await h.signer.metadata(h.context)
    const path = join(h.options.stateDir, readdirSync(h.options.stateDir)[0]!), record = JSON.parse(readFileSync(path, 'utf8'))
    record.sourceNotBefore = future(1)
    writeFileSync(path, canonical(record))
    await expect(h.signer.evidence('task-1', 'app', SHA)).rejects.toThrow()
    await expect(h.signer.verify(h.merge(), record.metadata)).rejects.toThrow()
  })

  it('rejects ambiguous grants instead of choosing newest evidence', async () => {
    const h = fixture(); await h.signer.metadata(h.context)
    h.context.grant.id = h.context.operation.grantId = 'grant-2'; h.context.operation.id = 'create-operation-2'
    await h.signer.metadata(h.context)
    await expect(h.signer.evidence('task-1', 'app', SHA)).rejects.toThrow('ambiguous')
  })

  it('retains a revoked-after-fsync ticket unchanged and never renews its nonce or expiry', async () => {
    const h = fixture(); let calls = 0
    h.context.assertAuthorized = () => { if (++calls >= 4) throw new Error('revoked after durable issuance') }
    await expect(h.signer.metadata(h.context)).rejects.toThrow('metadata unavailable')
    expect(readdirSync(h.options.stateDir)).toHaveLength(1)
    const path = join(h.options.stateDir, readdirSync(h.options.stateDir)[0]!), stored = JSON.parse(readFileSync(path, 'utf8'))
    h.context.assertAuthorized = () => {}
    expect(await h.signer.metadata(h.context)).toBe(stored.metadata)
    expect(envelopes(stored.metadata)[0]!.payload.expiresAt).toBe(h.context.grant.expiresAt)
  })

  it('checks live revocation after async storage/key reads, with no external consumption', async () => {
    const h = fixture(); let calls = 0
    h.context.assertAuthorized = () => { if (++calls >= 2) throw new Error('revoked') }
    await expect(h.signer.metadata(h.context)).rejects.toThrow()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(readdirSync(h.options.stateDir)).toEqual([])
  })
})

describe('ordinary merge immutable V2 preparation', () => {
  function ordinary() {
    const h = fixture(), plan: MergePlan = { version: 2, sourceSha: SHA, targetSha: BASE, expectedTreeSha: 'd'.repeat(40), ciSha256: HASH, validationProfile: 'full-verify' }
    h.context.repository.mergeMode = 'merge-commit'
    h.context.request.action = h.context.operation.action = 'prepare_merge'
    h.context.operation.id = 'prepare-operation'; h.context.operation.mergePlan = plan
    const merge = (): DispatchContext => ({ ...h.context, request: { ...h.context.request, action: 'merge' }, operation: { ...h.context.operation, id: 'merge-operation', action: 'merge', preparationId: 'prepare-operation' } })
    return { ...h, plan, merge }
  }

  it('signs exact18-field V2 payload in the legacy delimiter and binds sidecar plan+prep identity', async () => {
    const h = ordinary(), metadata = await h.signer.metadata(h.context), ticket = envelopes(metadata)[0]!
    expect(metadata.startsWith('<!-- superagent-deploy-v1\n')).toBe(true)
    expect(Object.keys(ticket.payload)).toHaveLength(18)
    expect(ticket.payload).toMatchObject({ version: 2, sourceSha: SHA, targetSha: BASE, expectedTreeSha: h.plan.expectedTreeSha, validationProfile: 'full-verify', operationId: 'prepare-operation' })
    expect(ticket.signature).toBe(createHmac('sha256', key).update(canonical(ticket.payload)).digest('hex'))
    await expect(h.signer.verify(h.merge(), metadata)).resolves.toBeUndefined()
    const evidence = await h.signer.evidence('task-1', 'app', SHA)
    expect(evidence).toMatchObject({ mergePlan: h.plan, metadata, metadataDigest: createHash('sha256').update(metadata).digest('hex'), operationId: 'prepare-operation' })
    expect(await createDeploymentTickets(h.options).metadata(h.context)).toBe(metadata)
    vi.setSystemTime(Date.now() + 120_000)
    expect(await h.signer.evidence('task-1', 'app', SHA)).toEqual(evidence)
    await expect(h.signer.metadata(h.context)).rejects.toThrow()
  })

  it('emits a V2 envelope accepted by pure Python validation only for proven actual M/full verification', async () => {
    const h = ordinary(), tickets = envelopes(await h.signer.metadata(h.context))
    const script = python.replace("p=ticket['payload']; ctx=g.GateContext(job=p['jobs'][0],build_id='fixture-build-1',source_sha=p['sourceSha'],project_id=p['projectId'],destination_id=p['destinationId'],environment=p['environment'],key_id=p['keyId'])", "p=ticket['payload']; ctx=g.GateContext(job=p['jobs'][0],build_id='fixture-build-1',source_sha='e'*40,project_id=p['projectId'],destination_id=p['destinationId'],environment=p['environment'],key_id=p['keyId'],approved_source_sha=p['sourceSha'],target_sha=p['targetSha'],tree_sha=p['expectedTreeSha'],parents=(p['targetSha'],p['sourceSha']),verification_source_sha='e'*40,verification_profile='full-verify',verification_passed=True)")
    const result = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', script, gate], { input: JSON.stringify({ tickets, key: key.toString('hex'), now: NOW.toISOString() }), encoding: 'utf8', timeout: 10_000 }))
    expect(result[0]).toMatchObject({ valid: true, approvedSourceSha: SHA, deployedSha: 'e'.repeat(40) })
  })

  it.each(['create-mr', 'missing-plan', 'source', 'target', 'tree', 'ci', 'profile', 'extra', 'prep-id', 'stale-target', 'downgrade'] as const)('never replaces or re-signs a prepared ticket after %s drift', async invalid => {
    const h = ordinary(), metadata = await h.signer.metadata(h.context)
    if (invalid === 'create-mr') h.context.request.action = h.context.operation.action = 'create_mr'
    if (invalid === 'missing-plan') delete h.context.operation.mergePlan
    if (invalid === 'source') h.plan.sourceSha = 'f'.repeat(40)
    if (invalid === 'target') h.plan.targetSha = h.context.snapshot.targetSha = 'f'.repeat(40)
    if (invalid === 'tree') h.plan.expectedTreeSha = 'f'.repeat(40)
    if (invalid === 'ci') h.plan.ciSha256 = 'f'.repeat(64)
    if (invalid === 'profile') (h.plan as { validationProfile: string }).validationProfile = 'package-only'
    if (invalid === 'extra') Object.assign(h.plan, { generation: 2 })
    if (invalid === 'prep-id') h.context.operation.id = 'new-prepare'
    if (invalid === 'stale-target') h.context.snapshot.targetSha = 'f'.repeat(40)
    if (invalid === 'downgrade') delete h.context.repository.mergeMode
    await expect(h.signer.metadata(h.context)).rejects.toThrow()
    const files = readdirSync(h.options.stateDir)
    expect(files).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(h.options.stateDir, files[0]!), 'utf8')).metadata).toBe(metadata)
  })

  it('rejects mismatched merge preparation IDs and sidecar tree tampering', async () => {
    const h = ordinary(), metadata = await h.signer.metadata(h.context), context = h.merge()
    context.operation.preparationId = 'wrong-prepare'
    await expect(h.signer.verify(context, metadata)).rejects.toThrow()
    const path = join(h.options.stateDir, readdirSync(h.options.stateDir)[0]!), record = JSON.parse(readFileSync(path, 'utf8'))
    record.mergePlan.expectedTreeSha = 'f'.repeat(40); writeFileSync(path, canonical(record))
    await expect(h.signer.evidence('task-1', 'app', SHA)).rejects.toThrow()
  })
})

describe('private durable key and record filesystem boundaries', () => {
  it.each(['key-permissions', 'key-symlink', 'key-hardlink', 'key-length', 'state-symlink', 'state-permissions', 'repo-key', 'repo-state'] as const)('rejects %s without unsafe replacement', async invalid => {
    const h = fixture()
    if (invalid === 'key-permissions') chmodSync(h.options.keyFile, 0o644)
    if (invalid === 'key-symlink') { const alias = join(h.root, 'key-alias'); symlinkSync(h.options.keyFile, alias); h.options.keyFile = alias }
    if (invalid === 'key-hardlink') linkSync(h.options.keyFile, join(h.root, 'key-hardlink'))
    if (invalid === 'key-length') writeFileSync(h.options.keyFile, Buffer.alloc(33))
    if (invalid === 'state-symlink') { const actual = join(h.root, 'actual'); mkdirSync(actual, { mode: 0o700 }); symlinkSync(actual, h.options.stateDir) }
    if (invalid === 'state-permissions') mkdirSync(h.options.stateDir, { mode: 0o755 })
    if (invalid === 'repo-key') { h.options.keyFile = join(h.repo, 'key'); writeFileSync(h.options.keyFile, key, { mode: 0o600 }) }
    if (invalid === 'repo-state') h.options.stateDir = join(h.repo, 'tickets')
    await expect(createDeploymentTickets(h.options).metadata(h.context)).rejects.toThrow('metadata unavailable')
  })

  it('uses exclusive immutable records under concurrent issuers and never silently overwrites partial winners', async () => {
    const h = fixture(), one = createDeploymentTickets(h.options), two = createDeploymentTickets(h.options)
    const results = await Promise.allSettled([one.metadata(h.context), two.metadata(h.context)])
    const successful = results.filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
    expect(successful.length).toBeGreaterThan(0)
    expect(new Set(successful.map(result => result.value)).size).toBe(1)
    expect(readdirSync(h.options.stateDir)).toHaveLength(1)
    expect(await one.metadata(h.context)).toBe(successful[0]!.value)
  })
})
