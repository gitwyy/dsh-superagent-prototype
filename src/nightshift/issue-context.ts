/** Host-side, read-only GitLab issue context injected into the task text.
 * The worker never gains network or GitLab tools: the operator's configured
 * project read credential is used here, output is bounded, and failure is non-fatal.
 */
import { readReleaseCredential, releaseOrigin, type ReleaseCredential } from './release/git-transport.ts'
import type { ReleaseRepository } from './release/contracts.ts'

export interface IssueContextOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  /** Total characters of the returned block. */
  maxChars?: number
  /** Most recent comments to include, newest first. */
  maxComments?: number
}

const text = (value: unknown): string => typeof value === 'string' ? value : ''
const clean = (value: string) => value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

/** Read one issue's title/state/body and a few comments. Returns undefined when unavailable. */
export async function readIssueContext(repository: ReleaseRepository, issue: number,
  signal: AbortSignal = AbortSignal.timeout(8_000), options: IssueContextOptions = {}): Promise<string | undefined> {
  if (!Number.isSafeInteger(issue) || issue <= 0) return undefined
  const maxChars = Math.max(500, Math.min(options.maxChars ?? 6_000, 8_000))
  const maxComments = Math.max(0, Math.min(options.maxComments ?? 3, 5))
  let credential: ReleaseCredential
  try { credential = await readReleaseCredential(repository) } catch { return undefined }
  if (!Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) return undefined
  const origin = releaseOrigin(repository)
  const fetchImpl = options.fetch ?? fetch
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 8_000)])
  const request = async (path: string) => {
    const response = await fetchImpl(new URL(path, origin), {
      headers: { 'PRIVATE-TOKEN': credential.token, Accept: 'application/json' }, redirect: 'error', signal: timeout,
    })
    if (!response.ok || response.redirected) throw new Error('issue context request failed')
    return response.json() as Promise<Record<string, unknown>>
  }
  try {
    const base = `/api/v4/projects/${repository.projectId}`
    const issueData = await request(`${base}/issues/${issue}`)
    const title = clean(text(issueData.title)).slice(0, 300)
    const state = clean(text(issueData.state)).slice(0, 20)
    const webUrl = text(issueData.web_url)
    const body = clean(text(issueData.description))
    if (!title) return undefined
    const header = `[Issue #${issue}｜${state}] ${title}${webUrl ? `\n${webUrl}` : ''}`
    const blocks = [header]
    const budget = () => maxChars - blocks.join('\n\n').length
    if (body) blocks.push(body.slice(0, Math.max(200, budget() - 200)))
    if (maxComments > 0) {
      try {
        const notes = await request(`${base}/issues/${issue}/notes?sort=desc&order_by=created_at&per_page=${maxComments}`)
        const list = Array.isArray(notes) ? notes : []
        for (const note of list.slice(0, maxComments)) {
          const system = note && typeof note === 'object' && (note as { system?: unknown }).system === true
          const noteText = clean(text((note as { body?: unknown })?.body))
          if (system || !noteText) continue
          const remaining = budget() + 120
          if (remaining <= 120) break
          blocks.push(`— 评论：${noteText.slice(0, Math.min(800, remaining))}`)
        }
      } catch { /* comments are optional */ }
    }
    return blocks.join('\n\n').slice(0, maxChars)
  } catch { return undefined }
}
