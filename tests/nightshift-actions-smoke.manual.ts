/** Opt-in real Pi validation/commit smoke. Only creates a disposable repository, never business work. */
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createPiRunner } from '../src/nightshift/pi-runner.ts'
import type { NightConfig, Task } from '../src/nightshift/contracts.ts'
const home = process.env.NIGHTSHIFT_SMOKE_HOME
if (!home) throw new Error('Explicit NIGHTSHIFT_SMOKE_HOME required; no ambient credential selection')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-actions-smoke-')))
const workspace = join(root, 'repo'); mkdirSync(workspace)
const env = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', workspace, ...args], { env, encoding: 'utf8' })
git(['init', '-q', '-b', 'sdd/smoke-actions'])
writeFileSync(join(workspace, 'VALUE.txt'), 'before\n')
const script = "const fs=require('node:fs');process.exit(fs.readFileSync('VALUE.txt','utf8')==='after\\n'?0:3)"
writeFileSync(join(workspace, 'validate.cjs'), script)
git(['add', 'VALUE.txt', 'validate.cjs']); git(['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'fixture baseline'])
const initial = git(['rev-parse', 'HEAD']).trim()
const executable = realpathSync(process.execPath), sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const config: NightConfig = { enabled: true, workspace, stateDir: join(root, 'state'), sessionFile: join(root, 'state/session.jsonl'),
 piExecutable: '/Users/wangyangyang/.local/bin/pi', piHome: realpathSync(home), repositories: { fixture: workspace },
 provider: 'mate-newapi', model: 'gpt-6-astra', thinking: 'low', maxTaskSeconds: 180, freezeWindows: [],
 repositoryActions: { fixture: { author: { name: 'Nightshift Smoke', email: 'smoke@example.invalid' }, targetBranch: 'master', requiredValidations: ['check'],
 validations: { check: { executable, executableSha256: sha(readFileSync(executable)), args: ['validate.cjs'], timeoutSeconds: 10, pinnedFiles: { 'validate.cjs': sha(script) } } } } } }
const task: Task = { id: 'smoke-actions', originId: 'explicit-construction-test', ownerId: 'lead', text: 'First run night_action validate recipe check for repository fixture. The initial failure is EXPECTED (VALUE.txt is before). Then edit VALUE.txt to exactly after plus newline, rerun validation, and if passed use night_action commit with message test: scoped fixture. Do not modify validate.cjs. This is a disposable fixture. Finish with the resulting commit identifier and validation outcome.',
 repositories: ['fixture'], access: 'write', approved: true, approveMessageId: 'construction', actions: ['validate', 'commit'], actionsApproveMessageId: 'construction-actions',
 target: { source: 'feishu', chatId: 'no-send', messageId: 'no-send' }, state: 'queued', createdAt: new Date().toISOString() }
const runner = createPiRunner({ guardPath: new URL('../resources/nightshift-guard.mjs', import.meta.url).pathname, startupTimeoutMs: 30000 })
const result = await runner.run({ runId: 'real-actions-smoke', task, config, deadline: new Date(Date.now() + 180000).toISOString() }, new AbortController().signal)
const status = git(['status', '--porcelain']), head = git(['rev-parse', 'HEAD']).trim()
const report = { at: new Date().toISOString(), root, result, clean: status === '', newCommit: head !== initial, head, files: git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim() }
writeFileSync(join(root, 'evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
if (result.outcome !== 'succeeded' || !result.writerStopped || status !== '' || head === initial || report.files !== 'VALUE.txt') process.exitCode = 1
