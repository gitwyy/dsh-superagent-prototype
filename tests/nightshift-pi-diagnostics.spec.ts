/** Failed Pi startups keep a redacted, owner-private cause; nothing leaks to the model or Feishu. */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPiRunner, piCommand } from '../src/nightshift/pi-runner.ts'
import type { NightConfig, Task } from '../src/nightshift/contracts.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) { if (dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('night-pi-diag-')) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) } })

function fixture(script: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'night-pi-diag-')))
  roots.push(root)
  const workspace = join(root, 'workspace'), stateDir = join(root, 'state'), piHome = join(root, 'pi-home')
  for (const directory of [workspace, stateDir, piHome]) mkdirSync(directory)
  const gitEnv = { PATH: '/usr/bin:/bin', HOME: piHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: workspace, env: gitEnv })
  writeFileSync(join(workspace, 'README.md'), 'fixture\n')
  execFileSync('/usr/bin/git', ['add', 'README.md'], { cwd: workspace, env: gitEnv })
  execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], { cwd: workspace, env: gitEnv })
  const executable = join(root, 'fake-pi')
  writeFileSync(executable, script, { mode: 0o700 }); chmodSync(executable, 0o700)
  const config: NightConfig = { enabled: true, workspace, stateDir, lockRoot: join(root, 'locks'), piHome, piExecutable: executable,
    provider: 'fixture', model: 'fixture-model',
    sessionFile: join(stateDir, 'session.jsonl'), repositories: { repo: workspace }, maxTaskSeconds: 30, freezeWindows: [] }
  const task: Task = { id: 'diag-task', originId: 'diag-origin', ownerId: 'owner', text: 'inspect only', repositories: ['repo'], access: 'read', approved: true,
    target: { source: 'feishu', chatId: 'dm', messageId: 'm' }, state: 'running', createdAt: new Date().toISOString() }
  const runner = createPiRunner({ guardPath: '/Code/github/dsh-superagent-prototype/resources/nightshift-guard.mjs', startupTimeoutMs: 4000 })
  const run = () => runner.run({ runId: 'diag-run', task, deadline: new Date(Date.now() + 20_000).toISOString(), config }, new AbortController().signal)
  return { root, config, executable, run, diagnostic: () => existsSync(join(stateDir, 'pi-diagnostics.log')) ? readFileSync(join(stateDir, 'pi-diagnostics.log'), 'utf8') : '' }
}

describe('Pi startup diagnostics', () => {
  it('records a redacted startup cause for a failed run without exposing credentials', async () => {
    const f = fixture('#!/bin/sh\necho "Failed to load extension: bad policy token=sk-abcdefghijklmnop123456" >&2\nexit 1\n')
    const result = await f.run()
    expect(['failed', 'blocked']).toContain(result.outcome)
    const diagnostic = f.diagnostic()
    expect(diagnostic).toContain('Failed to load extension: bad policy')
    expect(diagnostic).not.toContain('sk-abcdefghijklmnop123456')
  })

  it('launches a Node-shebang Pi with the current Node binary instead of trusting PATH', async () => {
    const f = fixture('#!/usr/bin/env node\nprocess.exit(0)\n')
    expect(await piCommand(f.executable)).toEqual({ command: process.execPath, prefix: [f.executable] })
    const shell = fixture('#!/bin/sh\nexit 1\n')
    expect(await piCommand(shell.executable)).toEqual({ command: shell.executable, prefix: [] })
  })
})
