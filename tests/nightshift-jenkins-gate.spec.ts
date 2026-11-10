/** Offline only: stdlib Python, temp files, fixed synthetic HMAC keys; no Jenkins/GitLab/deploy calls. */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const gate = fileURLToPath(new URL('../integrations/jenkins/nightshift-gate.py', import.meta.url))
const key = Buffer.from('offline-fixture-key-not-a-real-secret-0123456789abcdef', 'ascii')
const sha = 'a'.repeat(40)
const roots: string[] = []
const tempParent = realpathSync(tmpdir())
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }
interface Payload {
  version: number; taskId: string; grantId: string; operationId: string; projectId: number
  sourceSha: string; environment: string; jobs: string[]; destinationId: string
  issuedAt: string; notBefore: string; expiresAt: string
  freezeWindows: { from: string; until: string }[]; keyId: string; nonce: string; buildId?: string
  targetSha?: string; expectedTreeSha?: string; validationProfile?: string
}
interface Envelope { payload: Payload; signature: string }
interface Context { job: string; build_id: string; source_sha: string; project_id: number; destination_id: string; environment: string; key_id: string
  approved_source_sha?: string | null; target_sha?: string | null; tree_sha?: string | null; parents?: string[] | null
  verification_source_sha?: string | null; verification_profile?: string | null; verification_passed?: boolean | number | string | null
}
function payload(overrides: Partial<Payload> = {}): Payload {
  return {
    version: 1, taskId: 'task-13', grantId: 'grant-01', operationId: 'operation-01',
    projectId: 480, sourceSha: sha, environment: 'test', jobs: ['test/folder/release-app'],
    destinationId: 'k8s-test:mate-v2', issuedAt: '2026-11-10T00:00:00Z',
    notBefore: '2026-11-10T00:01:00Z', expiresAt: '2026-11-10T02:00:00Z',
    freezeWindows: [], keyId: 'jenkins-test-v1', nonce: 'N'.repeat(43), ...overrides,
  }
}
function context(overrides: Partial<Context> = {}): Context {
  return { job: 'test/folder/release-app', build_id: 'jenkins-125', source_sha: sha, project_id: 480,
    destination_id: 'k8s-test:mate-v2', environment: 'test', key_id: 'jenkins-test-v1', ...overrides }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}
function sign(value = payload()): Envelope {
  return { payload: value, signature: createHmac('sha256', key).update(canonical(value)).digest('hex') }
}
function temp() {
  const root = mkdtempSync(join(tempParent, 'nightshift-jenkins-gate-')); roots.push(root)
  chmodSync(root, 0o700)
  const state = join(root, 'state'); mkdirSync(state, { mode: 0o700 })
  return { root, state }
}
function fixture(value = payload()) {
  const { root, state } = temp()
  const ticketPath = join(root, 'ticket.json'), keyPath = join(root, 'key.bin')
  writeFileSync(ticketPath, JSON.stringify(sign(value)), { mode: 0o600 })
  writeFileSync(keyPath, key, { mode: 0o600 })
  const args = ['--ticket', ticketPath, '--key-file', keyPath, '--job', value.jobs[0]!,
    '--build-id', 'jenkins-125', '--source-sha', value.sourceSha, '--project-id', String(value.projectId),
    '--destination', value.destinationId, '--environment', value.environment, '--key-id', value.keyId, '--state-dir', state]
  return { root, state, ticketPath, keyPath, args, value }
}
function changed(args: string[], flag: string, value: string) {
  const result = [...args]; result[result.indexOf(flag) + 1] = value; return result
}
// Test-only import seam freezes the module's default trusted clock before invoking
// its REAL main/argparse/filesystem path. Production CLI has no clock argument or
// env override. This keeps happy-path tests valid even during the retained freeze.
const cliDriver = String.raw`
import importlib.util, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location("nightshift_gate", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = g
spec.loader.exec_module(g)
g.admit.__defaults__ = (lambda: datetime(2026, 11, 10, 1, 0, 0, tzinfo=timezone.utc),)
sys.exit(g.main(sys.argv[2:]))
`
function cli(args: string[], wallClock = false) {
  const command = wallClock ? ['-I', '-B', gate, ...args] : ['-I', '-B', '-c', cliDriver, gate, ...args]
  const result = spawnSync('python3', command, { encoding: 'utf8', env, timeout: 10_000, maxBuffer: 128_000 })
  if (result.error) throw result.error
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, result: JSON.parse(result.stdout) as Record<string, any> }
}
const driver = String.raw`
import importlib.util, json, sys
from datetime import datetime
spec = importlib.util.spec_from_file_location("nightshift_gate", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = g
spec.loader.exec_module(g)
data = json.load(sys.stdin)
key = bytes.fromhex(data["key"])
try:
    if type(data['context'].get('parents')) is list and not data.get('mutableParents'):
        data['context']['parents'] = tuple(data['context']['parents'])
    ctx = g.GateContext(**data["context"]) if not data.get("untypedContext") else data["context"]
    now = datetime.fromisoformat(data["now"].replace("Z", "+00:00"))
    mode = data.get("mode", "validate")
    if mode == "validate":
        result = g.validate(data["ticket"], key, ctx, now)
    elif mode == 'prepare':
        result = g.validate_preparation(data['ticket'], key, ctx, now)
    else:
        samples = iter([datetime.fromisoformat(v.replace("Z", "+00:00")) for v in data.get("samples", [data["now"], data["now"]])])
        if data.get("failFsync"):
            def fail(*args):
                raise OSError("SYNTHETIC_SECRET_ERROR_MUST_NOT_ESCAPE")
            g.os.fsync = fail
        result = g.admit(data["ticket"], key, ctx, data["state"], lambda: next(samples))
    print(json.dumps(result))
except g.GateDenied as e:
    print(json.dumps({"allowed": False, "reason": str(e)}))
`
function pure(options: { ticket?: unknown; context?: Context; now?: string; key?: Buffer; mode?: string; state?: string; samples?: string[]; failFsync?: boolean; untypedContext?: boolean; mutableParents?: boolean } = {}) {
  const input = { ticket: sign(), context: context(), now: '2026-11-10T01:00:00Z', ...options, key: (options.key ?? key).toString('hex') }
  const result = spawnSync('python3', ['-I', '-B', '-c', driver, gate], {
    input: JSON.stringify(input), encoding: 'utf8', env, timeout: 10_000, maxBuffer: 128_000,
  })
  if (result.error) throw result.error
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout) as Record<string, any>
}
function markers(value: Payload, ctx = context()) {
  const digest = (v: string[]) => createHash('sha256').update(canonical(v)).digest('hex')
  return [`nonce-${digest([ctx.key_id, value.nonce])}.json`, `operation-${digest([value.operationId, ctx.job])}.json`]
}
function denied(result: Record<string, any>, reason?: string) {
  expect(result.allowed).toBe(false)
  if (reason) expect(result.reason).toBe(reason)
  expect(result).not.toHaveProperty('valid')
}
function cliDenied(args: string[], reason?: string) {
  const result = cli(args)
  expect(result.code).toBe(1)
  expect(result.stderr).toBe('')
  expect(result.stdout).not.toContain(key.toString())
  denied(result.result, reason)
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Only exact test-created canonical directories; never a configured live path.
    if (resolve(root) !== root || dirname(root) !== tempParent || !root.startsWith(join(tempParent, 'nightshift-jenkins-gate-'))) throw new Error('Unsafe cleanup target')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Jenkins gate signed typed pure validation', () => {
  it('accepts JS-signed canonical payload but pure validation is NOT admission', () => {
    const result = pure()
    expect(result).toMatchObject({ valid: true, projectId: 480, environment: 'test', job: context().job,
      buildId: 'jenkins-125', admissionOnly: true, postAdmissionCancellation: false,
      admissionDeadline: '2026-11-10T02:00:00.000000Z' })
    expect(result).not.toHaveProperty('allowed')
    expect(result).not.toHaveProperty('signature')
    expect(result).not.toHaveProperty('nonce')
  })
  it('accepts preprod only with exact trusted context and a 64-character SHA', () => {
    const source = 'b'.repeat(64)
    expect(pure({ ticket: sign(payload({ environment: 'preprod', sourceSha: source })), context: context({ environment: 'preprod', source_sha: source }) }).valid).toBe(true)
  })
  it('ignores wire property order, not canonical signed meaning', () => {
    const ordered = Object.fromEntries(Object.entries(payload()).reverse()) as unknown as Payload
    expect(pure({ ticket: sign(ordered) }).valid).toBe(true)
  })
  it.each(['taskId', 'grantId', 'operationId', 'projectId', 'sourceSha', 'environment', 'jobs', 'destinationId', 'issuedAt', 'notBefore', 'expiresAt', 'freezeWindows', 'keyId', 'nonce'])('HMAC binds %s', field => {
    const signed = sign()
    const changes: Record<string, unknown> = { taskId: 'another', grantId: 'another', operationId: 'another', projectId: 481,
      sourceSha: 'b'.repeat(40), environment: 'preprod', jobs: ['other/job'], destinationId: 'other-destination',
      issuedAt: '2026-11-10T00:00:01Z', notBefore: '2026-11-10T00:01:01Z', expiresAt: '2026-11-10T02:00:01Z',
      freezeWindows: [{ from: '2026-11-10T03:00:00Z', until: '2026-11-10T04:00:00Z' }], keyId: 'other', nonce: 'B'.repeat(43) }
    ;(signed.payload as unknown as Record<string, unknown>)[field] = changes[field]
    denied(pure({ ticket: signed }), 'invalid_signature')
  })
  it.each<Partial<Context>>([
    { job: 'test/folder/other' }, { build_id: '../125' }, { source_sha: 'b'.repeat(40) }, { project_id: 481 },
    { destination_id: 'other' }, { environment: 'preprod' }, { key_id: 'other' },
  ])('denies wrong actual target context %j', change => { denied(pure({ context: context(change) })) })
  it('requires typed context, real positive integer project ID and aware trusted clock', () => {
    denied(pure({ untypedContext: true }), 'invalid_context')
    denied(pure({ context: context({ project_id: true as unknown as number }) }), 'invalid_context')
    denied(pure({ now: '2026-11-10T01:00:00' }), 'invalid_clock')
  })
  it('requires optional signed build ID when supplied; otherwise first build is bindable', () => {
    expect(pure({ context: context({ build_id: 'different-first-build' }) }).valid).toBe(true)
    expect(pure({ ticket: sign(payload({ buildId: 'jenkins-125' })) }).valid).toBe(true)
    denied(pure({ ticket: sign(payload({ buildId: 'jenkins-126' })) }), 'context_mismatch')
    const signed = sign(); signed.payload.buildId = 'jenkins-125'
    denied(pure({ ticket: signed }), 'invalid_signature')
  })
  it.each(['prod', 'production', 'TEST', 'test-prod', 'preproduction', '', 'test\n'])('rejects production/unknown alias %j even when signed', environment => {
    denied(pure({ ticket: sign(payload({ environment })), context: context({ environment }) }))
  })
  it.each([
    { version: true }, { version: 2 }, { projectId: true }, { projectId: 0 }, { projectId: -1 }, { projectId: 1.5 },
    { projectId: Number.MAX_SAFE_INTEGER + 1 }, { taskId: '' }, { taskId: '../task' }, { taskId: '中文' },
    { taskId: 'x'.repeat(129) }, { sourceSha: 'a'.repeat(39) }, { sourceSha: 'A'.repeat(40) },
    { nonce: 'short' }, { nonce: 'x/'.repeat(20) }, { jobs: [] }, { jobs: ['test/folder/release-app', 'other'] },
    { jobs: ['../job'] }, { jobs: ['test//job'] }, { jobs: ['test/job '] }, { jobs: ['test/*'] },
    { buildId: 125 }, { freezeWindows: null }, { freezeWindows: [{ from: '2026-11-10T00:00:00Z' }] },
    { freezeWindows: [{ from: '2026-11-10T02:00:00Z', until: '2026-11-10T01:00:00Z' }] },
    { freezeWindows: Array.from({ length: 65 }, () => ({ from: '2026-11-10T03:00:00Z', until: '2026-11-10T04:00:00Z' })) },
    { unexpected: 'no-extension' },
  ])('fails closed on signed malformed payload %j', change => {
    denied(pure({ ticket: sign({ ...payload(), ...change } as Payload) }))
  })
  it.each(['payload', 'signature'])('requires exact envelope field %s', field => {
    const value = sign() as unknown as Record<string, unknown>; delete value[field]
    denied(pure({ ticket: value }), 'malformed_ticket')
  })
  it('rejects absent field, unknown envelope field, bad signature or wrong/weak keys', () => {
    const value = payload() as unknown as Record<string, unknown>; delete value.grantId
    denied(pure({ ticket: sign(value as unknown as Payload) }), 'malformed_ticket')
    denied(pure({ ticket: { ...sign(), extra: 1 } }), 'malformed_ticket')
    denied(pure({ ticket: { ...sign(), signature: 'G'.repeat(64) } }), 'invalid_signature')
    denied(pure({ ticket: { ...sign(), signature: '0'.repeat(64) } }), 'invalid_signature')
    denied(pure({ key: Buffer.alloc(32, 9) }), 'invalid_signature')
    denied(pure({ key: Buffer.alloc(31) }), 'invalid_key')
    denied(pure({ key: Buffer.alloc(4097) }), 'invalid_key')
  })
})

describe('Jenkins gate deadline and retained freeze boundaries', () => {
  it.each([
    ['2026-11-09T23:59:59Z', 'future_ticket'], ['2026-11-10T00:00:00Z', 'not_yet_valid'],
    ['2026-11-10T00:00:59.999999Z', 'not_yet_valid'], ['2026-11-10T02:00:00Z', 'expired'],
    ['2026-11-10T02:00:00.000001Z', 'expired'],
  ])('rejects at %s with %s', (now, reason) => { denied(pure({ now }), reason) })
  it.each(['2026-11-10T00:01:00Z', '2026-11-10T01:59:59.999999Z', '2026-11-10T09:00:00+08:00'])('allows valid instant %s', now => {
    expect(pure({ now }).valid).toBe(true)
  })
  it.each(['2026-11-10', '2026-11-10T00:00:00', '2026-11-10T00:00:00-00:00', '2026-11-10T00:00:00+24:00',
    '2026-11-10T00:00:00+08:60', '2026-11-10T00:00:00+14:01', '2026-02-30T00:00:00Z',
    '2026-11-10T00:00:60Z', '2026-11-10T00:00:00.1234567Z'])('rejects ambiguous/malformed timestamp %s', issuedAt => {
    denied(pure({ ticket: sign(payload({ issuedAt })) }), 'malformed_time')
  })
  it.each([
    { issuedAt: '2026-11-10T00:02:00Z' }, { expiresAt: '2026-11-10T00:01:00Z' },
    { expiresAt: '2026-11-10T12:00:00.000001Z' },
  ])('rejects invalid ordering/overlong authorization %j', change => {
    denied(pure({ ticket: sign(payload(change)) }), 'invalid_window')
  })
  it('permits at most 12h, never a permanent grant', () => {
    expect(pure({ ticket: sign(payload({ expiresAt: '2026-11-10T12:00:00Z' })) }).valid).toBe(true)
  })
  const frozen = () => sign(payload({ freezeWindows: [{ from: '2026-11-10T01:00:00Z', until: '2026-11-10T01:30:00Z' }] }))
  it('reports next freeze as the effective admission deadline even when ticket lasts longer', () => {
    expect(pure({ ticket: frozen(), now: '2026-11-10T00:59:59.999999Z' }).admissionDeadline).toBe('2026-11-10T01:00:00.000000Z')
    denied(pure({ ticket: frozen(), now: '2026-11-10T01:00:00Z' }), 'frozen')
    denied(pure({ ticket: frozen(), now: '2026-11-10T01:29:59.999999Z' }), 'frozen')
    expect(pure({ ticket: frozen(), now: '2026-11-10T01:30:00Z' }).valid).toBe(true)
  })
  it('cannot omit or override the retained Nov12-Nov14 +08 freeze', () => {
    const before = sign(payload({ issuedAt: '2026-11-11T22:00:00+08:00', notBefore: '2026-11-11T22:00:00+08:00', expiresAt: '2026-11-12T02:00:00+08:00' }))
    expect(pure({ ticket: before, now: '2026-11-11T23:59:59.999999+08:00' }).admissionDeadline).toBe('2026-11-11T16:00:00.000000Z')
    denied(pure({ ticket: before, now: '2026-11-12T00:00:00+08:00' }), 'frozen')
    const end = sign(payload({ issuedAt: '2026-11-13T22:00:00+08:00', notBefore: '2026-11-13T22:00:00+08:00', expiresAt: '2026-11-14T02:00:00+08:00' }))
    denied(pure({ ticket: end, now: '2026-11-13T23:59:59.999999+08:00' }), 'frozen')
    expect(pure({ ticket: end, now: '2026-11-14T00:00:00+08:00' }).valid).toBe(true)
  })
})

describe('Jenkins gate single-use durable admission', () => {
  it('writes immutable HMAC-bound intent receipts and denies same/different-build repeats', () => {
    const { state } = temp(), ticket = sign()
    const result = pure({ mode: 'admit', state, ticket })
    expect(result.allowed).toBe(true)
    expect(readdirSync(state).sort()).toEqual(markers(ticket.payload).sort())
    const snapshots = readdirSync(state).map(name => readFileSync(join(state, name), 'utf8'))
    for (const name of readdirSync(state)) {
      const path = join(state, name), text = readFileSync(path, 'utf8')
      const { receipt, signature } = JSON.parse(text)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(receipt.state).toBe('intent')
      expect(receipt.metadata).toMatchObject({ buildId: 'jenkins-125', job: context().job, sourceSha: sha, destinationId: context().destination_id })
      expect(signature).toBe(createHmac('sha256', key).update('nightshift-gate-receipt-v1\0').update(canonical(receipt)).digest('hex'))
      expect(text).not.toContain(key.toString())
    }
    denied(pure({ mode: 'admit', state, ticket }), 'replay_or_unknown')
    denied(pure({ mode: 'admit', state, ticket, context: context({ build_id: 'jenkins-126' }) }), 'replay_or_unknown')
    expect(readdirSync(state).map(name => readFileSync(join(state, name), 'utf8'))).toEqual(snapshots)
  })
  it('blocks same operation/job even if a signer reissues another nonce, grant or key ID', () => {
    const { state } = temp()
    expect(pure({ mode: 'admit', state }).allowed).toBe(true)
    const ticket = sign(payload({ nonce: 'B'.repeat(43), grantId: 'grant-02', keyId: 'rotated-key' }))
    denied(pure({ mode: 'admit', state, ticket, context: context({ key_id: 'rotated-key' }) }), 'replay_or_unknown')
  })
  it('blocks nonce reuse even under a different operation ID', () => {
    const { state } = temp()
    expect(pure({ mode: 'admit', state }).allowed).toBe(true)
    denied(pure({ mode: 'admit', state, ticket: sign(payload({ operationId: 'other-operation' })) }), 'replay_or_unknown')
  })
  it('allows an independently signed job ticket under same operation with unique nonce', () => {
    const { state } = temp()
    expect(pure({ mode: 'admit', state }).allowed).toBe(true)
    expect(pure({ mode: 'admit', state, ticket: sign(payload({ jobs: ['second-job'], nonce: 'B'.repeat(43) })), context: context({ job: 'second-job' }) }).allowed).toBe(true)
  })
  it('never consumes intent on a failed signature or wrong context', () => {
    const { state } = temp()
    denied(pure({ mode: 'admit', state, key: Buffer.alloc(32) }))
    denied(pure({ mode: 'admit', state, context: context({ project_id: 481 }) }))
    expect(readdirSync(state)).toEqual([])
  })
  it.each(['nonce', 'operation'])('existing %s intent is unknown: empty/tampered receipts never unblock', kind => {
    const { state } = temp(), name = markers(payload()).find(name => name.startsWith(`${kind}-`))!
    writeFileSync(join(state, name), '', { mode: 0o600 })
    denied(pure({ mode: 'admit', state }), 'replay_or_unknown')
    writeFileSync(join(state, name), '{"allowed":true,"signature":"forged"}')
    denied(pure({ mode: 'admit', state }), 'replay_or_unknown')
  })
  it('fsync failure burns the claimed nonce and never emits permission', () => {
    const { state } = temp()
    denied(pure({ mode: 'admit', state, failFsync: true }), 'state_unavailable')
    expect(readdirSync(state)).toHaveLength(1)
    denied(pure({ mode: 'admit', state }), 'replay_or_unknown')
  })
  it('expiry while fsync/claiming denies and burns intent rather than admitting using stale time', () => {
    const { state } = temp()
    denied(pure({ mode: 'admit', state, samples: ['2026-11-10T01:59:59.999999Z', '2026-11-10T02:00:00Z'] }), 'expired')
    expect(readdirSync(state)).toHaveLength(2)
    denied(pure({ mode: 'admit', state }), 'replay_or_unknown')
  })
  it('a freeze crossed while claiming denies; thaw is not permission to retry consumed intent', () => {
    const { state } = temp(), ticket = sign(payload({ freezeWindows: [{ from: '2026-11-10T01:00:00Z', until: '2026-11-10T01:30:00Z' }] }))
    denied(pure({ mode: 'admit', state, ticket, samples: ['2026-11-10T00:59:59.999999Z', '2026-11-10T01:00:00Z'] }), 'frozen')
    denied(pure({ mode: 'admit', state, ticket, now: '2026-11-10T01:30:00Z' }), 'replay_or_unknown')
  })
  it('a disk stall spanning an entire signed freeze still cannot resume admission at thaw', () => {
    const { state } = temp(), ticket = sign(payload({ freezeWindows: [{ from: '2026-11-10T01:00:00Z', until: '2026-11-10T01:30:00Z' }] }))
    denied(pure({ mode: 'admit', state, ticket, samples: ['2026-11-10T00:59:59Z', '2026-11-10T01:30:00Z'] }), 'window_elapsed')
    denied(pure({ mode: 'admit', state, ticket, now: '2026-11-10T01:30:00Z' }), 'replay_or_unknown')
  })
  it('a regressing clock between intent and final check is denied', () => {
    const { state } = temp()
    denied(pure({ mode: 'admit', state, samples: ['2026-11-10T01:00:00Z', '2026-11-10T00:59:59Z'] }), 'clock_regressed')
  })
  it('admits only once across racing independent Python processes', async () => {
    const f = fixture()
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<{ code: number | null; stdout: string; stderr: string }>((yes, no) => {
      const child = spawn('python3', ['-I', '-B', '-c', cliDriver, gate, ...f.args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', no); child.on('close', code => yes({ code, stdout, stderr }))
    })))
    expect(results.filter(r => r.code === 0)).toHaveLength(1)
    expect(results.filter(r => JSON.parse(r.stdout).allowed === true)).toHaveLength(1)
    expect(results.every(r => r.stderr === '')).toBe(true)
    expect(readdirSync(f.state)).toHaveLength(2)
  })
  it('advertises no post-admission cancellation, not deployment completion or a rollback promise', () => {
    const { state } = temp()
    const result = pure({ mode: 'admit', state })
    expect(result).toMatchObject({ allowed: true, admissionOnly: true, postAdmissionCancellation: false })
    expect(result).not.toHaveProperty('deployed')
    expect(result).not.toHaveProperty('remoteDeadlineEnforced')
  })
})

describe('Jenkins gate CLI files, path boundaries and no secret output', () => {
  it('real unmodified executable denies an expired ticket and refuses a caller clock override', () => {
    const f = fixture(payload({ issuedAt: '2020-01-01T00:00:00Z', notBefore: '2020-01-01T00:00:00Z', expiresAt: '2020-01-01T01:00:00Z' }))
    const result = cli(f.args, true)
    expect(result.code).toBe(1); expect(result.stderr).toBe(''); denied(result.result, 'expired')
    const override = cli([...f.args, '--now', '2020-01-01T00:30:00Z'], true)
    expect(override.code).toBe(1); denied(override.result, 'invalid_arguments')
    expect(readdirSync(f.state)).toEqual([])
  })
  it('admits through CLI with private files once; repeats fail closed after process exit', () => {
    const f = fixture(), result = cli(f.args)
    expect(result.code).toBe(0); expect(result.stderr).toBe(''); expect(result.result.allowed).toBe(true)
    expect(result.stdout).not.toContain(key.toString())
    cliDenied(f.args, 'replay_or_unknown')
    cliDenied(changed(f.args, '--build-id', 'another-build'), 'replay_or_unknown')
  })
  it('allows private readonly files as well as 0600', () => {
    const f = fixture(); chmodSync(f.keyPath, 0o400); chmodSync(f.ticketPath, 0o400)
    expect(cli(f.args).code).toBe(0)
  })
  it.each(['ticket', 'key-file', 'state-dir'])('rejects symlink leaf for --%s', flag => {
    const f = fixture(), link = join(f.root, 'link')
    symlinkSync(flag === 'ticket' ? f.ticketPath : flag === 'key-file' ? f.keyPath : f.state, link)
    cliDenied(changed(f.args, `--${flag}`, link))
  })
  it('rejects symlink ancestors even when the final file is regular', () => {
    const f = fixture(), link = join(f.root, 'parent-link'); symlinkSync(f.root, link)
    cliDenied(changed(f.args, '--key-file', join(link, 'key.bin')))
  })
  it.each(['ticket', 'key-file'])('rejects permissive mode or hardlink for --%s', flag => {
    const f = fixture(), path = flag === 'ticket' ? f.ticketPath : f.keyPath
    chmodSync(path, 0o644); cliDenied(f.args, 'unsafe_file'); chmodSync(path, 0o600)
    linkSync(path, join(f.root, 'hard-link')); cliDenied(f.args, 'unsafe_file')
  })
  it('rejects untrusted writable ancestors and nonprivate state directory', () => {
    const f = fixture(); chmodSync(f.root, 0o770); cliDenied(f.args, 'unsafe_directory'); chmodSync(f.root, 0o700)
    chmodSync(f.state, 0o755); cliDenied(f.args, 'unsafe_directory')
  })
  it.each(['relative.json', '/tmp/../ticket.json', '//tmp/ticket.json', '/tmp//ticket.json', '/tmp/ticket.json/'])('requires canonical absolute paths %s', path => {
    const f = fixture(); cliDenied(changed(f.args, '--ticket', path), 'unsafe_path')
  })
  it('rejects missing state, state file, or special key file without blocking', () => {
    const f = fixture()
    cliDenied(changed(f.args, '--state-dir', join(f.root, 'missing')), 'unsafe_directory')
    cliDenied(changed(f.args, '--state-dir', f.ticketPath), 'unsafe_directory')
    const fifo = join(f.root, 'fifo')
    const mkfifo = spawnSync('python3', ['-I', '-B', '-c', 'import os,sys; os.mkfifo(sys.argv[1], 0o600)', fifo], { env })
    expect(mkfifo.status).toBe(0)
    cliDenied(changed(f.args, '--key-file', fifo), 'unsafe_file')
  })
  it('never follows or overwrites an intent marker symlink', () => {
    const f = fixture(), untouched = join(f.root, 'untouched')
    writeFileSync(untouched, 'unchanged', { mode: 0o600 })
    symlinkSync(untouched, join(f.state, markers(f.value)[0]!))
    cliDenied(f.args, 'replay_or_unknown'); expect(readFileSync(untouched, 'utf8')).toBe('unchanged')
  })
  it.each(['ticket', 'key-file'])('bounds reads of --%s before deserialization', flag => {
    const f = fixture()
    writeFileSync(flag === 'ticket' ? f.ticketPath : f.keyPath, Buffer.alloc(flag === 'ticket' ? 65537 : 4097))
    cliDenied(f.args, 'oversized_file')
  })
  it.each(['{', '[]', 'null', '{"payload":NaN,"signature":"x"}', '{"payload":{},"payload":{},"signature":"x"}'])('rejects malformed/duplicate/NaN JSON %j', raw => {
    const f = fixture(); writeFileSync(f.ticketPath, raw); cliDenied(f.args)
  })
  it('rejects nested duplicate keys even when parser last-write semantics would verify the HMAC', () => {
    const f = fixture(), ticket = sign(f.value)
    writeFileSync(f.ticketPath, JSON.stringify(ticket).replace('"projectId":480', '"projectId":481,"projectId":480'))
    cliDenied(f.args, 'duplicate_json_key')
  })
  it('rejects invalid UTF8, excessive nesting and missing ticket instead of a traceback', () => {
    const f = fixture(); writeFileSync(f.ticketPath, Buffer.from([0xff])); cliDenied(f.args, 'malformed_ticket')
    writeFileSync(f.ticketPath, '['.repeat(2000) + ']'.repeat(2000)); cliDenied(f.args, 'malformed_ticket')
    cliDenied(changed(f.args, '--ticket', join(f.root, 'absent')), 'unsafe_file')
  })
  it('missing arguments and invalid caller strings emit fixed denials without raw argv/key values', () => {
    const f = fixture()
    cliDenied([], 'invalid_arguments')
    cliDenied(['--help'], 'invalid_arguments')
    cliDenied([...f.args, '--help'], 'invalid_arguments')
    cliDenied([...f.args, '--project-id', '481'], 'invalid_arguments')
    cliDenied([...f.args, '--project-id=481'], 'invalid_arguments')
    cliDenied([...f.args, '--unexpected', key.toString()], 'invalid_arguments')
    cliDenied(changed(f.args, '--project-id', key.toString()), 'invalid_context')
    cliDenied(changed(f.args, '--environment', 'prod'), 'invalid_context')
    cliDenied(changed(f.args, '--key-file', join(f.root, key.toString())), 'unsafe_file')
    expect(readdirSync(f.state)).toEqual([])
  })
  it('wrong actual CLI source/project/job/destination/key/environment deny without consuming', () => {
    const f = fixture()
    for (const [flag, value] of [['--source-sha', 'b'.repeat(40)], ['--project-id', '481'], ['--job', 'other-job'], ['--destination', 'other'], ['--key-id', 'other'], ['--environment', 'preprod']]) {
      cliDenied(changed(f.args, flag!, value!), 'context_mismatch')
    }
    expect(readdirSync(f.state)).toEqual([])
  })
})

const mergedSha = 'b'.repeat(40), targetSha = 'c'.repeat(40), treeSha = 'd'.repeat(40)
const v2Payload = (change: Partial<Payload> = {}) => payload({ version: 2, targetSha, expectedTreeSha: treeSha, validationProfile: 'full-verify', ...change })
const v2Context = (change: Partial<Context> = {}) => context({ source_sha: mergedSha, approved_source_sha: sha,
  target_sha: targetSha, tree_sha: treeSha, parents: [targetSha, sha], verification_source_sha: mergedSha,
  verification_profile: 'full-verify', verification_passed: true, ...change })

describe('v2 signed ordinary-merge admission proof', () => {
  it('retains the fixed pre-v2 golden HMAC bytes and v1 result contract', () => {
    const ticket = sign(payload())
    expect(ticket.signature).toBe('dacdbc5d4b709c3ed2de79036ea6341dd47970de92b56032ec2e7350f1332b93')
    const out = pure({ ticket })
    expect(out.version).toBe(1)
    expect(out.sourceSha).toBe(sha)
    for (const field of ['approvedSourceSha', 'deployedSha', 'parents', 'expectedTreeSha', 'treeSha', 'verificationPassed']) expect(out).not.toHaveProperty(field)
  })
  it('binds approved S, target T, actual M parents and exact tree plus full verification', () => {
    const out = pure({ ticket: sign(v2Payload()), context: v2Context() })
    expect(out).toMatchObject({ valid: true, version: 2, sourceSha: mergedSha, deployedSha: mergedSha,
      approvedSourceSha: sha, targetSha, treeSha, expectedTreeSha: treeSha, parents: [targetSha, sha],
      validationProfile: 'full-verify', verificationPassed: true, verificationSourceSha: mergedSha,
      admissionOnly: true, postAdmissionCancellation: false })
    expect(out).not.toHaveProperty('allowed')
  })
  it('controller preparation authenticates plan/parents but never claims local tree/tests succeeded', () => {
    const c = v2Context({ tree_sha: null, verification_source_sha: null, verification_profile: null, verification_passed: null })
    const out = pure({ ticket: sign(v2Payload()), context: c, mode: 'prepare' })
    expect(out).toMatchObject({ prepared: true, proofPending: true, version: 2, expectedTreeSha: treeSha })
    for (const k of ['valid', 'allowed', 'treeSha', 'verificationPassed', 'verificationSourceSha']) expect(out).not.toHaveProperty(k)
    denied(pure({ ticket: sign(v2Payload()), context: c }), 'merge_proof_required')
  })
  it.each(['targetSha', 'expectedTreeSha', 'validationProfile'])('HMAC covers v2 %s without altering v1 canonical format', field => {
    const ticket = sign(v2Payload())
    ;(ticket.payload as unknown as Record<string, unknown>)[field] = field === 'validationProfile' ? 'build-only' : 'e'.repeat(40)
    denied(pure({ ticket, context: v2Context() }))
  })
  it.each<Partial<Context>>([
    { source_sha: sha }, { source_sha: targetSha }, { source_sha: '0'.repeat(40) }, { source_sha: 'b'.repeat(64) },
    { approved_source_sha: null }, { approved_source_sha: 'e'.repeat(40) }, { target_sha: null }, { target_sha: 'e'.repeat(40) },
    { parents: null }, { parents: [sha, targetSha] }, { parents: [targetSha] }, { parents: [targetSha, sha, 'e'.repeat(40)] },
    { parents: [targetSha, targetSha] }, { parents: ['0'.repeat(40), sha] },
    { tree_sha: null }, { tree_sha: 'e'.repeat(40) }, { tree_sha: '0'.repeat(40) },
    { verification_source_sha: null }, { verification_source_sha: sha },
    { verification_profile: null }, { verification_profile: 'package-only' },
    { verification_passed: false }, { verification_passed: null }, { verification_passed: 1 }, { verification_passed: 'true' },
  ])('rejects incomplete/mismatched local proof %j without consuming intent', change => {
    const { state } = temp()
    denied(pure({ ticket: sign(v2Payload()), context: v2Context(change), mode: 'admit', state }))
    expect(readdirSync(state)).toEqual([])
  })
  it('requires immutable typed parents rather than trusting a mutable untyped list', () => {
    denied(pure({ ticket: sign(v2Payload()), context: v2Context(), mutableParents: true }), 'merge_context_mismatch')
  })
  it.each<Partial<Payload>>([
    { targetSha: sha }, { targetSha: '0'.repeat(40) }, { expectedTreeSha: '0'.repeat(40) },
    { sourceSha: '0'.repeat(40) }, { expectedTreeSha: 'd'.repeat(64) }, { validationProfile: 'package-only' },
    { validationProfile: 'FULL-VERIFY' },
  ])('rejects signed invalid merge plans %j', change => {
    denied(pure({ ticket: sign(v2Payload(change)), context: v2Context() }), 'malformed_merge_plan')
  })
  it.each(['targetSha', 'expectedTreeSha', 'validationProfile'])('fails closed on missing v2 %s', field => {
    const value = v2Payload() as unknown as Record<string, unknown>; delete value[field]
    denied(pure({ ticket: sign(value as unknown as Payload), context: v2Context() }), 'malformed_ticket')
  })
  it('does not accept extra mergeMode/preparationId or silently downgrade v2 to v1', () => {
    for (const field of ['mergeMode', 'preparationId']) {
      denied(pure({ ticket: sign({ ...v2Payload(), [field]: 'not-in-contract' }), context: v2Context() }), 'malformed_ticket')
    }
    denied(pure({ ticket: sign(v2Payload({ version: 1 })), context: v2Context() }), 'malformed_ticket')
    denied(pure({ ticket: sign(payload()), context: v2Context() }), 'context_mismatch')
  })
  it('v2 CLI has no proof parameter bypass and denies without trusted object/audit proof', () => {
    const f = fixture(v2Payload())
    cliDenied(changed(f.args, '--source-sha', mergedSha), 'merge_context_mismatch')
    expect(readdirSync(f.state)).toEqual([])
  })
  it('single-use receipt HMAC binds actual merge proof and denies retry or version downgrade', () => {
    const { state } = temp(), ticket = sign(v2Payload())
    const out = pure({ mode: 'admit', state, ticket, context: v2Context() })
    expect(out.allowed).toBe(true)
    for (const path of readdirSync(state)) {
      const receipt = JSON.parse(readFileSync(join(state, path), 'utf8'))
      expect(receipt.receipt.metadata).toMatchObject({ sourceSha: mergedSha, approvedSourceSha: sha, treeSha, parents: [targetSha, sha], verificationPassed: true })
      expect(receipt.signature).toBe(createHmac('sha256', key).update('nightshift-gate-receipt-v1\0').update(canonical(receipt.receipt)).digest('hex'))
    }
    denied(pure({ mode: 'admit', state, ticket, context: v2Context() }), 'replay_or_unknown')
    denied(pure({ mode: 'admit', state, ticket: sign(payload({ nonce: 'Z'.repeat(43) })) }), 'replay_or_unknown')
  })
  it('v2 still rechecks expiry/freeze after durable claim with no post-admission stop promise', () => {
    const { state } = temp()
    denied(pure({ mode: 'admit', state, ticket: sign(v2Payload()), context: v2Context(),
      samples: ['2026-11-10T01:59:59.999999Z', '2026-11-10T02:00:00Z'] }), 'expired')
    expect(readdirSync(state)).toHaveLength(2)
    const p = v2Payload({ issuedAt: '2026-11-12T00:00:00+08:00', notBefore: '2026-11-12T00:00:00+08:00', expiresAt: '2026-11-12T02:00:00+08:00' })
    denied(pure({ ticket: sign(p), context: v2Context(), now: '2026-11-12T01:00:00+08:00' }), 'frozen')
  })
})
