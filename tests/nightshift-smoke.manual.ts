/** Explicit, opt-in live Pi smoke in a newly-created scratch repository. Not included in vitest patterns. */
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createPiRunner } from '../src/nightshift/pi-runner.ts'
import type { NightConfig, Task } from '../src/nightshift/contracts.ts'

const root = await realpath(await mkdtemp(join(tmpdir(), 'nightshift-live-smoke-')))
const workspace = join(root, 'repo')
execFileSync('/usr/bin/git', ['init', '-q', workspace], { stdio: 'pipe' })
await writeFile(join(workspace, 'SMOKE.md'), 'nightshift-read-only-fixture\n')
execFileSync('/usr/bin/git', ['-C', workspace, 'add', 'SMOKE.md'], { stdio: 'pipe' })
execFileSync('/usr/bin/git', ['-C', workspace, '-c', 'user.name=Nightshift Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'test fixture'], { stdio: 'pipe' })
const config: NightConfig = {
  enabled: true, workspace, stateDir: join(root, 'state'), piExecutable: '/Users/wangyangyang/.local/bin/pi',
  piHome: await realpath(process.env.NIGHTSHIFT_SMOKE_HOME ?? '/Code/youke-mate/refactor/.dsh-driver/pi-agent'), sessionFile: join(root, 'state', 'persistent.jsonl'),
  repositories: { fixture: workspace }, provider: process.env.NIGHTSHIFT_SMOKE_PROVIDER ?? 'deepseek', model: process.env.NIGHTSHIFT_SMOKE_MODEL ?? 'deepseek-flash', thinking: 'low', maxTaskSeconds: 90, freezeWindows: [],
  harnessRoot: await realpath('/Code/youke-mate/refactor/mate-pi'), lockRoot: join(root, 'locks'),
}
const task: Task = { id: 'smoke-read-only', originId: 'manual-construction-test', ownerId: 'lead',
  text: 'Use the read tool to read SMOKE.md in the fixture repository and reply exactly with the one line of content. Do not use any other tool or modify anything.',
  repositories: ['fixture'], access: 'read', approved: true, approveMessageId: 'construction',
  target: { source: 'feishu', chatId: 'test-no-send', messageId: 'test-no-send' }, state: 'queued', createdAt: new Date().toISOString() }
const runner = createPiRunner({ guardPath: new URL('../resources/nightshift-guard.mjs', import.meta.url).pathname, startupTimeoutMs: 30000 })
const preflight = await runner.preflight(config, [task])
console.log(JSON.stringify({ root, preflight }))
if (!preflight.ok) process.exitCode = 1
else {
  const result = await runner.run({ runId: 'live-read-only-smoke', task, config, deadline: new Date(Date.now() + 90000).toISOString() }, new AbortController().signal)
  const status = execFileSync('/usr/bin/git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' })
  const evidence = { at: new Date().toISOString(), root, result, worktreeClean: status === '' }
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
  if (result.outcome !== 'succeeded' || !result.writerStopped || status !== '') process.exitCode = 1
}
