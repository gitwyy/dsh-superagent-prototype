/** Host composition. Pi receives only run-scoped action RPC, never release identities or credentials. */
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { NightConfig, NightController, Runner, RunRequest, RunResult, Task } from '../contracts.ts'
import { createPiRunner, type PiRunnerOptions } from '../pi-runner.ts'
import { CommitReceipts } from './receipts.ts'
import { createReleaseCoordinator, type ReleaseCoordinator } from './coordinator.ts'
import { createGitlabTransport } from './gitlab.ts'
import { createReleaseServices, type ReleaseServices } from './composite-transport.ts'
import type { ReleaseTransport, ReleaseResult, ReleaseOperation } from './contracts.ts'

export interface ManagedRunnerHost {
  snapshot(): ReturnType<NightController['snapshot']> | undefined
  isAuthorized(ownerId: string): boolean
}
export interface ManagedRunner extends Runner {
  operations(): ReleaseOperation[]
  reconcile(operationId: string, signal: AbortSignal): Promise<ReleaseResult>
  close(): Promise<void>
}
export function createManagedRunner(config: NightConfig, host: ManagedRunnerHost,
  options: PiRunnerOptions & { transport?: ReleaseTransport } = {}): ManagedRunner {
  const active = new Map<string, RunRequest>()
  const receipts = new CommitReceipts(resolve(config.stateDir, 'commit-receipts.sqlite'), config)
  let release: ReleaseCoordinator | undefined
  let services: ReleaseServices | undefined
  const task = (id: string) => host.snapshot()?.tasks.find(t => t.id === id)
  const admitted = (id: string) => {
    const run = active.get(id), state = host.snapshot(), current = task(id)
    if (!run || !state || state.mode !== 'NIGHT_RUNNING' || state.activeRunId !== run.runId || !current || current.state !== 'running'
      || !current.approved || !host.isAuthorized(current.ownerId)) return undefined
    return new Date(Math.min(Date.parse(run.deadline), Date.parse(state.deadline ?? ''))).toISOString()
  }
  try {
    if (config.releasePolicy && config.releaseRuntime && !options.transport) services = createReleaseServices(config, config.releaseRuntime)
    if (config.releasePolicy) release = createReleaseCoordinator(config.releasePolicy, resolve(config.stateDir, 'release.sqlite'), {
      grant: id => task(id)?.releaseGrant,
      isAuthorized: id => host.isAuthorized(id),
      activeDeadline: admitted,
      candidate: async (id, repository, sha) => {
        const current = task(id)
        if (!current) throw new Error('Task no longer exists')
        return receipts.candidate(current, repository, sha)
      },
    }, options.transport ?? services?.transport ?? createGitlabTransport({ tempRoot: resolve(config.stateDir, 'release-git') }))
  } catch (error) { receipts.close(); throw error }
  const runner = createPiRunner({ ...options,
    assertAuthorized: request => {
      const until = admitted(request.task.id)
      if (!until || Date.parse(until) <= Date.now()) throw new Error('Task/owner/shift execution authorization was revoked')
    },
    onCommit: receipt => { receipts.record(receipt) },
    remoteActive: id => release?.remoteActive(id) ?? false,
    release: async (request, input, signal) => {
      if (!release || !config.releasePolicy?.enabled) return { status: 'blocked', detail: 'Host release policy is not enabled', remoteIds: [], remoteActive: false }
      const prior = release.operations(request.task.id).find(op => op.repository === input.repository && op.sha === input.sha && op.action === input.action)
      let result = prior ? await release.reconcile(prior.id, signal) : await release.execute({ ...input, taskId: request.task.id }, signal)
      if (result.operationId && result.status === 'accepted') result = await release.reconcile(result.operationId, signal)
      // Managed wait is read-only; accepted mutations are never resent. Keep waiting off the LLM turn loop.
      // Ambiguity/failure exits immediately for human reconciliation; normal pipeline/rollout activity may settle.
      while (result.operationId && result.remoteActive && ['accepted', 'succeeded'].includes(result.status)) {
        const remaining = Date.parse(request.deadline) - Date.now()
        if (signal.aborted || remaining <= 0) break
        try { await delay(Math.min(10000, remaining), undefined, { signal }) } catch { break }
        result = await release.reconcile(result.operationId, signal)
      }
      return result
    },
  })
  let closed = false
  return {
    preflight: (c: NightConfig, tasks: Task[]) => runner.preflight(c, tasks),
    async run(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
      if (closed || active.size) return { outcome: 'blocked', summary: 'Managed runner is closed or busy', writerStopped: active.size === 0, evidence: [] }
      active.set(request.task.id, request)
      try {
        const result = await runner.run(request, signal)
        if (result.outcome === 'succeeded' && request.task.releaseGrant) {
          const operations = release?.operations(request.task.id) ?? []
          const missing = request.task.releaseGrant.scopes.flatMap(scope => scope.actions.filter(action =>
            !operations.some(op => op.grantId === request.task.releaseGrant!.id && op.repository === scope.repository
              && op.action === action && op.state === 'succeeded')).map(action => `${scope.repository}/${action}`))
          if (missing.length) return { ...result, outcome: release?.remoteActive(request.task.id) ? 'unknown' : 'blocked',
            remoteActive: release?.remoteActive(request.task.id) ?? false,
            summary: `模型轮次已结束，但所授权发布目标尚无完成证据：${missing.join(', ')}。不能以模型回复代替发布回执。` }
        }
        return result
      } finally { active.delete(request.task.id) }
    },
    operations: () => release?.operations() ?? [],
    reconcile: async (id, signal) => release ? release.reconcile(id, signal) : { status: 'blocked', detail: 'Release policy is absent', remoteIds: [], remoteActive: false },
    async close() { if (closed) return; if (active.size) throw new Error('Drain active local writer before closing managed runner'); await release?.close(); await services?.close(); receipts.close(); closed = true },
  }
}
