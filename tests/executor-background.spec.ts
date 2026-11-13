/** Background cleanup must tolerate jobs that already ended and never throw at the caller. */
import { describe, expect, it, vi } from 'vitest'
import { killJobs, stopBackground } from '../src/executor/background.ts'

const job = { id: 'job-1', owner: 'session-a', status: 'running', label: 'server' }

function ctx(jobs: Record<string, unknown>) {
  return {
    get: (name: string) => name === 'jobs' ? jobs : undefined,
    agents: { get: () => undefined },
  } as never
}

function registry(kill: (id: string) => void) {
  return {
    list: vi.fn(() => [job]),
    wait: vi.fn(async () => ({ status: 'ended' })),
    kill: vi.fn((id: string) => { kill(id) }),
    events: { subscribe: () => () => {} },
  }
}

describe('worker background cleanup', () => {
  it('ignores a kill that only reports the job already ended', async () => {
    const jobs = registry(() => { throw new Error('job not found') })
    await expect(killJobs(ctx(jobs), 'session-a', 'assignment ended')).resolves.toBeUndefined()
  })
  it('still surfaces a real kill failure', async () => {
    const jobs = registry(() => { throw new Error('permission denied') })
    await expect(killJobs(ctx(jobs), 'session-a', 'assignment ended')).rejects.toThrow(/Killing the shell jobs/)
  })
  it('returns cleanup problems to its caller instead of throwing', async () => {
    const jobs = registry(() => { throw new Error('permission denied') })
    const problems = await stopBackground(ctx(jobs), 'session-a', 'assignment ended')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('permission denied')
  })
})
