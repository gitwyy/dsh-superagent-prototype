/** Host-only issue context: bounded, read-only, and never fatal to task staging. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIssueContext } from '../src/nightshift/issue-context.ts'
import type { ReleaseRepository } from '../src/nightshift/release/contracts.ts'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { if (!root.startsWith(realpathSync(tmpdir()))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) } })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'issue-context-')))
  roots.push(root)
  const credentialFile = join(root, 'credential.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(credentialFile, JSON.stringify({ token: 'read-only-fixture', userId: 95, username: 'bot', projectId: 463, expiresAt: new Date(Date.now() + 3600_000).toISOString() }), { mode: 0o600 })
  const repository: ReleaseRepository = {
    alias: 'mate-manage-web', root: join(root, 'repo'), projectId: 463, projectPath: 'payment/refactor/mate-manage-web',
    host: 'gitlab.example.test', apiOrigin: 'https://gitlab.example.test', expectedUserId: 95, expectedUsername: 'bot',
    credentialFile, targetBranch: 'master', ciSha256: 'c'.repeat(64), requiredJobs: ['verify'],
    mergeTriggersDeploy: false,
    triggerPolicy: { reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), productionExcluded: true, fingerprint: 'f' },
    environments: {},
  }
  return { root, repository, credentialFile }
}

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, redirected: false, json: async () => body }) as unknown as Response

describe('host issue context', () => {
  it('reads title, state, body and recent human comments within budget', async () => {
    const f = fixture()
    const fetchImpl = vi.fn(async (input: URL | Request) => {
      const url = String(input)
      if (url.endsWith('/issues/84')) return json({ iid: 84, title: '数据统计12页业务闭环', state: 'opened', web_url: 'https://gitlab.example.test/x/-/issues/84', description: '需要完成 12 个页面的真实查询接线。' })
      if (url.includes('/notes')) return json([{ body: '补充：先复用现有领域契约。', system: false }, { body: '系统事件', system: true }])
      return json({}, false, 404)
    })
    const context = await readIssueContext(f.repository, 84, AbortSignal.timeout(5_000), { fetch: fetchImpl as unknown as typeof fetch })
    expect(context).toContain('Issue #84')
    expect(context).toContain('数据统计12页业务闭环')
    expect(context).toContain('12 个页面的真实查询接线')
    expect(context).toContain('先复用现有领域契约')
    expect(context).not.toContain('系统事件')
    expect(context!.length).toBeLessThanOrEqual(6_000)
  })
  it('returns undefined for missing issues, bad credentials or invalid numbers instead of failing the task', async () => {
    const f = fixture()
    const missing = vi.fn(async () => json({}, false, 404))
    expect(await readIssueContext(f.repository, 84, AbortSignal.timeout(5_000), { fetch: missing as unknown as typeof fetch })).toBeUndefined()
    expect(await readIssueContext(f.repository, 0)).toBeUndefined()
    writeFileSync(f.credentialFile, JSON.stringify({ token: 'x', userId: 1, username: 'bot', projectId: 463, expiresAt: new Date(Date.now() - 1000).toISOString() }), { mode: 0o600 })
    expect(await readIssueContext(f.repository, 84)).toBeUndefined()
  })
  it('bounds a very long body and hostile content', async () => {
    const f = fixture()
    const fetchImpl = vi.fn(async (input: URL | Request) => String(input).includes('/notes')
      ? json([])
      : json({ title: 'T', state: 'opened', description: 'x'.repeat(50_000) }))
    const context = await readIssueContext(f.repository, 7, AbortSignal.timeout(5_000), { fetch: fetchImpl as unknown as typeof fetch, maxChars: 900 })
    expect(context!.length).toBeLessThanOrEqual(900)
  })
})
