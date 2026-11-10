/** Task-level release grants are explicit human authority; all fixtures remain local and disposable. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createController } from '../src/nightshift/controller.ts'
import { parseNightCommand } from '../src/nightshift/commands.ts'
import { loadNightConfig } from '../src/nightshift/config.ts'
import { policyDigest } from '../src/nightshift/release/coordinator.ts'
import type { ReleasePolicy, ReleaseScope } from '../src/nightshift/release/contracts.ts'
import type { Command, Incoming, NightConfig, NightController, Runner } from '../src/nightshift/contracts.ts'

const roots: string[] = [], controllers: NightController[] = []
const BASE = 'b'.repeat(40), CI = 'c'.repeat(64), JOB = 'd'.repeat(64)
let sequence = 0
const message = (actorId = 'owner'): Incoming => ({ id: `release-message-${++sequence}`, actorId, text: 'explicit direct command', at: new Date().toISOString(), direct: true, human: true, target: { source: 'feishu', chatId: 'private-owner', messageId: `feishu-${sequence}` } })
const future = (milliseconds = 60_000) => new Date(Date.now() + milliseconds).toISOString()
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-release-grants-'))); roots.push(root)
  const workspace = join(root, 'workspace'), repo = join(workspace, 'repo'), other = join(workspace, 'other'), home = join(root, 'home'), executable = join(root, 'fake-pi')
  for (const path of [repo, other, home]) mkdirSync(path, { recursive: true })
  writeFileSync(executable, 'fake executable: never launched')
  const releasePolicy: ReleasePolicy = { version: 1, enabled: true, maxGrantSeconds: 43_200, freezeWindows: [], repositories: { repo: { alias: 'repo', root: repo, projectId: 17, projectPath: 'mate/repo', host: 'git.example.test', apiOrigin: 'https://git.example.test', expectedUserId: 9, expectedUsername: 'release-bot', credentialFile: join(root, 'credential'), targetBranch: 'develop', ciSha256: CI, requiredJobs: ['unit'], mergeTriggersDeploy: true, triggerPolicy: { reviewedAt: future(-60_000), expiresAt: future(86_400_000), productionExcluded: true, fingerprint: 'reviewed' }, environments: { test: { kind: 'jenkins', id: 'test-route', jobs: ['test-job'], origin: 'https://jenkins.example.test', expectedConfigSha256: { 'test-job': JOB }, destinationId: 'test-cluster', remoteDeadlineEnforced: true, credentialRef: 'host-only' } } } } }
  const config: NightConfig = { enabled: true, workspace, stateDir: join(root, 'state'), lockRoot: join(root, 'locks'), piExecutable: executable, piHome: home, sessionFile: join(home, 'session.jsonl'), repositories: { repo, other }, maxTaskSeconds: 3600, freezeWindows: [], releasePolicy }
  const runner: Runner = { preflight: vi.fn(async () => ({ ok: true, problems: [] })), run: vi.fn(async () => ({ outcome: 'succeeded' as const, summary: 'fake stopped', writerStopped: true, evidence: [] })) }
  const create = (changes: Partial<NightConfig> = {}) => { const c = createController({ ...config, ...changes }, runner); controllers.push(c); return c }
  const scope = (): ReleaseScope => ({ repository: 'repo', sourceBranch: 'agent/task-source', targetBranch: 'develop', baseSha: BASE, actions: ['push', 'create_mr', 'merge', 'deploy'], environment: 'test' })
  const writeConfig = (value: NightConfig = config) => { const path = join(root, 'config.json'); writeFileSync(path, JSON.stringify(value)); return path }
  return { root, config, runner, releasePolicy, create, scope, writeConfig }
}
async function task(controller: NightController, approved = true, access: 'read' | 'write' = 'write', repositories = ['repo']) {
  await controller.handle(message(), { type: 'enqueue', text: 'Approved bounded source change', repositories, access })
  const id = controller.snapshot().tasks.at(-1)!.id
  if (approved) await controller.handle(message(), { type: 'approve', taskId: id })
  return id
}
async function grant(controller: NightController, id: string, scopes: ReleaseScope[], expiresAt = future(), incoming = message()) {
  await controller.handle(incoming, { type: 'authorize-release', taskId: id, scopes, expiresAt }); await drain(); return incoming
}
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close()
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || !root.startsWith(realpathSync(tmpdir()) + '/nightshift-release-grants-')) throw new Error(`Unexpected cleanup target ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('release grant controller boundary', () => {
  it('records exact owner-approved queued write scope without starting work or granting local commit actions', async () => {
    const h = fixture(), c = h.create(), id = await task(c)
    const incoming = await grant(c, id, [h.scope()])
    expect(c.snapshot().tasks[0]!.releaseGrant).toMatchObject({ taskId: id, ownerId: 'owner', approvalMessageId: incoming.id, policyDigest: policyDigest(h.releasePolicy), scopes: [h.scope()] })
    expect(c.snapshot().tasks[0]!.actions).toBeUndefined()
    expect(c.snapshot().mode).toBe('DAY_MANUAL')
    expect(h.runner.run).not.toHaveBeenCalled()
  })

  it.each(['unapproved', 'read', 'stranger', 'cancelled', 'finished', 'group', 'bot', 'disabled-policy', 'disabled-night', 'no-policy'] as const)('refuses release authority for %s task/message', async invalid => {
    const h = fixture()
    if (invalid === 'disabled-policy') h.releasePolicy.enabled = false
    if (invalid === 'disabled-night') h.config.enabled = false
    if (invalid === 'no-policy') delete h.config.releasePolicy
    const c = h.create()
    if (invalid === 'disabled-night') {
      await grant(c, 'nonexistent', [h.scope()]); expect(c.snapshot().tasks).toEqual([]); return
    }
    const id = await task(c, invalid !== 'unapproved', invalid === 'read' ? 'read' : 'write')
    if (invalid === 'cancelled') await c.handle(message(), { type: 'cancel', taskId: id })
    if (invalid === 'finished') { await c.handle(message(), { type: 'start', deadline: future() }); await drain(); expect(c.snapshot().tasks[0]!.state).toBe('succeeded') }
    const incoming = message(invalid === 'stranger' ? 'stranger' : 'owner')
    if (invalid === 'group') incoming.direct = false
    if (invalid === 'bot') incoming.human = false
    await grant(c, id, [h.scope()], future(), incoming)
    expect(c.snapshot().tasks[0]!.releaseGrant).toBeUndefined()
  })

  it.each(['expired', 'over-12h', 'local-time', 'invalid-date', 'past-freeze-start', 'crosses-freeze', 'policy-shorter'] as const)('rejects %s grant deadlines', async invalid => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
    const h = fixture(); let expiresAt = future()
    if (invalid === 'expired') expiresAt = future(-1)
    if (invalid === 'over-12h') expiresAt = future(43_200_001)
    if (invalid === 'local-time') expiresAt = '2026-11-10T01:00:00'
    if (invalid === 'invalid-date') expiresAt = '2026-02-30T01:00:00Z'
    if (invalid === 'policy-shorter') { h.releasePolicy.maxGrantSeconds = 30; expiresAt = future(31_000) }
    if (invalid === 'past-freeze-start') { h.config.freezeWindows = [{ from: future(-1000), until: future(1000) }]; expiresAt = future(2000) }
    if (invalid === 'crosses-freeze') { h.config.freezeWindows = [{ from: future(1000), until: future(2000) }]; expiresAt = future(1001) }
    h.releasePolicy.freezeWindows = h.config.freezeWindows
    const c = h.create(), id = await task(c)
    await grant(c, id, [h.scope()], expiresAt)
    expect(c.snapshot().tasks[0]!.releaseGrant).toBeUndefined()
  })

  it('accepts a grant ending exactly at freeze start and at the 12-hour upper boundary', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
    const h = fixture(), expiresAt = future(43_200_000)
    h.config.freezeWindows = h.releasePolicy.freezeWindows = [{ from: expiresAt, until: future(86_400_000) }]
    const c = h.create(), id = await task(c)
    await grant(c, id, [h.scope()], expiresAt)
    expect(c.snapshot().tasks[0]!.releaseGrant?.expiresAt).toBe(expiresAt)
  })

  it.each(['unknown-repo', 'outside-task', 'wrong-target', 'source-main', 'source-equals-target', 'missing-base', 'bad-base', 'duplicate-repo', 'unknown-action', 'merge-without-deploy', 'deploy-without-merge', 'missing-environment', 'production', 'unconfigured-environment'] as const)('rejects %s release scope', async invalid => {
    const h = fixture(), c = h.create(), id = await task(c), scope = h.scope()
    let scopes = [scope]
    if (invalid === 'unknown-repo') scope.repository = '../outside'
    if (invalid === 'outside-task') scope.repository = 'other'
    if (invalid === 'wrong-target') scope.targetBranch = 'main'
    if (invalid === 'source-main') scope.sourceBranch = 'main'
    if (invalid === 'source-equals-target') scope.sourceBranch = scope.targetBranch
    if (invalid === 'missing-base') delete (scope as Partial<ReleaseScope>).baseSha
    if (invalid === 'bad-base') scope.baseSha = 'HEAD'
    if (invalid === 'duplicate-repo') scopes = [scope, structuredClone(scope)]
    if (invalid === 'unknown-action') scope.actions = ['publish' as never]
    if (invalid === 'merge-without-deploy') scope.actions = ['merge']
    if (invalid === 'deploy-without-merge') scope.actions = ['deploy']
    if (invalid === 'missing-environment') delete scope.environment
    if (invalid === 'production') (scope as { environment: string }).environment = 'production'
    if (invalid === 'unconfigured-environment') scope.environment = 'preprod'
    await grant(c, id, scopes)
    expect(c.snapshot().tasks[0]!.releaseGrant).toBeUndefined()
  })

  it('does not retain caller-owned mutable scope data or silently expand task repository permissions', async () => {
    const h = fixture(), c = h.create(), id = await task(c), scope = h.scope(), incoming = message()
    const pending = c.handle(incoming, { type: 'authorize-release', taskId: id, scopes: [scope], expiresAt: future() })
    scope.repository = 'other'; scope.targetBranch = 'main'; scope.actions.push('push')
    await pending
    expect(c.snapshot().tasks[0]!.releaseGrant!.scopes).toEqual([h.scope()])
    expect(c.snapshot().tasks[0]!.repositories).toEqual(['repo'])
  })

  it.each(['freeze-policy', 'repository-root', 'policy-disabled'] as const)('revokes approved queued grants after %s configuration changes', async change => {
    const h = fixture(), c = h.create(), id = await task(c)
    await grant(c, id, [h.scope()]); expect(c.snapshot().tasks[0]!.releaseGrant).toBeDefined()
    await c.close()
    if (change === 'freeze-policy') h.config.freezeWindows = h.releasePolicy.freezeWindows = [{ from: '2026-11-12T00:00:00+08:00', until: '2026-11-14T00:00:00+08:00' }]
    if (change === 'repository-root') h.config.repositories.repo = h.config.repositories.other!
    if (change === 'policy-disabled') h.releasePolicy.enabled = false
    const reopened = h.create()
    expect(reopened.snapshot().mode).toBe('RECOVERY_REQUIRED')
    expect(reopened.snapshot().tasks[0]!.approved).toBe(false)
    expect(reopened.snapshot().tasks[0]!.releaseGrant).toBeUndefined()
  })

  it('persists idempotent grants but revokes them when pinned repository/policy configuration changes', async () => {
    const h = fixture(), c = h.create(), id = await task(c), incoming = message()
    await grant(c, id, [h.scope()], future(), incoming)
    const before = c.snapshot().tasks[0]!.releaseGrant!
    await grant(c, id, [h.scope()], future(120_000), incoming)
    expect(c.snapshot().tasks[0]!.releaseGrant).toEqual(before)
    await c.close()
    const reopened = h.create(); expect(reopened.snapshot().tasks[0]!.releaseGrant).toEqual(before)
    await reopened.close()
    h.releasePolicy.repositories.repo!.projectId = 18
    const changed = h.create()
    expect(changed.snapshot().mode).toBe('RECOVERY_REQUIRED')
    expect(changed.snapshot().tasks[0]).toMatchObject({ approved: false })
    expect(changed.snapshot().tasks[0]!.releaseGrant).toBeUndefined()
    await grant(changed, id, [h.scope()])
    expect(changed.snapshot().tasks[0]!.releaseGrant).toBeUndefined()
  })
})

describe('release command and host config parsing', () => {
  it('parses one bounded explicit preauthorization without treating prose or legacy publish as release scope', () => {
    const h = fixture(), scopes = [h.scope()], expires = '2026-11-10T23:00:00+08:00'
    expect(parseNightCommand(`预授权发布 task-1 截止 ${expires} | ${JSON.stringify(scopes)}`)).toEqual({ type: 'authorize-release', taskId: 'task-1', expiresAt: expires, scopes })
    expect(parseNightCommand('授权动作 task-1 发布')).toEqual({ type: 'authorize-actions', taskId: 'task-1', actions: ['publish'] })
    expect(() => parseNightCommand('请今晚帮我合并部署生产，不用问了')).toThrow()
  })

  it.each(['bad-json', 'unknown-field', 'production', 'local-time', 'too-many', 'oversized'] as const)('rejects %s command payload', invalid => {
    const h = fixture(); let scopes: unknown = [h.scope()], expires = '2026-11-10T23:00:00+08:00'
    if (invalid === 'unknown-field') scopes = [{ ...h.scope(), credentialFile: '/model-chosen' }]
    if (invalid === 'production') scopes = [{ ...h.scope(), environment: 'production' }]
    if (invalid === 'local-time') expires = '2026-11-10T23:00:00'
    if (invalid === 'too-many') scopes = Array.from({ length: 18 }, (_, i) => ({ ...h.scope(), repository: `repo-${i}` }))
    const json = invalid === 'bad-json' ? '{' : invalid === 'oversized' ? '[' + ' '.repeat(16_001) + JSON.stringify(h.scope()) + ']' : JSON.stringify(scopes)
    expect(() => parseNightCommand(`预授权发布 task-1 截止 ${expires} | ${json}`)).toThrow()
  })

  it('loads a canonical exact release allowlist and refuses alias/root/credential/freeze substitutions', () => {
    const h = fixture()
    expect(loadNightConfig(h.writeConfig()).releasePolicy?.repositories.repo!.root).toBe(h.config.repositories.repo)
    for (const change of ['alias', 'root', 'unknown-alias', 'credential', 'freeze'] as const) {
      const config = structuredClone(h.config)
      if (change === 'alias') config.releasePolicy!.repositories.repo!.alias = 'other'
      if (change === 'root') config.releasePolicy!.repositories.repo!.root = h.config.repositories.other!
      if (change === 'unknown-alias') config.releasePolicy!.repositories.outside = { ...config.releasePolicy!.repositories.repo!, alias: 'outside' }
      if (change === 'credential') config.releasePolicy!.repositories.repo!.credentialFile = join(config.workspace, 'secret')
      if (change === 'freeze') config.releasePolicy!.freezeWindows = [{ from: '2026-11-12T00:00:00+08:00', until: '2026-11-14T00:00:00+08:00' }]
      expect(() => loadNightConfig(h.writeConfig(config))).toThrow()
    }
    const alias = join(h.root, 'repo-alias'); symlinkSync(h.config.repositories.other!, alias)
    const substituted = structuredClone(h.config); substituted.releasePolicy!.repositories.repo!.root = alias
    expect(() => loadNightConfig(h.writeConfig(substituted))).toThrow('canonical repository')
  })
})
