/** Transport-shaped events -> real controller/SQLite -> supervised fake Pi child -> private reply receipts.
 * No Feishu network, business repository, real provider or fabricated production user message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { NightAdapter } from '../src/nightshift/adapter.ts'
import { createPiRunner } from '../src/nightshift/pi-runner.ts'
import { feishuTrigger } from '../src/sources/feishu-trigger.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { NightConfig } from '../src/nightshift/contracts.ts'
import type { OutboundMessage } from '../src/core/index.ts'

const roots: string[] = [], adapters: NightAdapter[] = []
afterEach(async () => {
 for (const adapter of adapters.splice(0)) await adapter.close()
 for (const root of roots.splice(0)) {
  if (dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-e2e-')) throw new Error('Unsafe fixture cleanup')
  rmSync(root, { recursive: true, force: true })
 }
})
function fixture() {
 const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-e2e-'))); roots.push(root)
 const workspace = join(root, 'repo'), stateDir = join(root, 'state'), piHome = join(root, 'pi-home')
 for (const d of [workspace, stateDir, piHome]) mkdirSync(d)
 const env = { PATH: '/usr/bin:/bin', HOME: piHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
 const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', workspace, ...args], { env, encoding: 'utf8' })
 git(['init', '-q', '-b', 'master']); writeFileSync(join(workspace, 'fixture.txt'), 'read-only\n')
 git(['add', 'fixture.txt']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline'])
 const executable = join(root, 'fake-pi')
 writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs');
const p=JSON.parse(process.env.NIGHTSHIFT_POLICY), audit=p.sessionFile+'.audit';
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(!fs.existsSync(p.sessionFile))fs.writeFileSync(p.sessionFile,JSON.stringify({type:'session',cwd:process.cwd()})+'\\n');
let buffer='',timers=[];
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
if(m.type==='get_state'){emit({type:'extension_ui_request',method:'setStatus',statusKey:'nightshift-guard',statusText:p.runId+':ready'});emit({type:'response',id:m.id,success:true,data:{sessionFile:p.sessionFile,isStreaming:false,pendingMessageCount:0,model:{provider:'fixture',id:'fixture-model'}}});}
if(m.type==='prompt'){fs.appendFileSync(audit,JSON.stringify({kind:'start',runId:p.runId,pid:process.pid,session:p.sessionFile})+'\\n');emit({type:'response',id:m.id,success:true,data:{disposition:'started'}});
if(m.message.includes('UNKNOWN')){emit({type:'extension_ui_request',method:'setStatus',statusKey:'nightshift-guard',statusText:p.runId+':unknown'});}
else if(!m.message.includes('WAIT'))timers.push(setTimeout(()=>{emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'fixture complete'}]}});emit({type:'agent_settled',aborted:false});},100));}
}});
process.stdin.on('end',()=>{for(const t of timers)clearTimeout(t);setTimeout(()=>{fs.appendFileSync(audit,JSON.stringify({kind:'stopped',runId:p.runId,pid:process.pid})+'\\n');process.exit(0)},220)});
`)
 chmodSync(executable, 0o700)
 const config: NightConfig = { enabled: true, workspace, stateDir, piHome, piExecutable: executable, sessionFile: join(stateDir, 'session.jsonl'), lockRoot: join(root, 'locks'), repositories: { fixture: workspace }, provider: 'fixture', model: 'fixture-model', maxTaskSeconds: 30, freezeWindows: [] }
 const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: [], otherChats: 'none', directMessages: true } } }, policy: { sources: { feishu: { allowed: [{ id: 'ou_owner' }] } } } })
 const replies = new Map<string, OutboundMessage>()
 const open = () => {
  const runner = createPiRunner({ guardPath: fileURLToPath(new URL('../resources/nightshift-guard.mjs', import.meta.url)), probeWriters: async () => [], startupTimeoutMs: 15000 })
  const adapter = new NightAdapter({ config, settings: () => settings, runner, health: { set() {}, get() { return undefined }, release() {} },
   outbox: { send(message) { const old = replies.get(message.id); if(old)expect(message).toEqual(old); replies.set(message.id,message) } } })
  adapters.push(adapter); return adapter
 }
 const event = (text: string, id: string, other: Record<string, unknown> = {}) => feishuTrigger({ message_id: id, chat_id: 'oc_fixture', chat_type: 'p2p', sender_id: 'ou_owner', sender_type: 'user', content: text, create_time: String(Date.now()), ...other }, 'ou_bot', 'cli_bot')!
 const audit = () => existsSync(config.sessionFile + '.audit') ? readFileSync(config.sessionFile + '.audit', 'utf8').trim().split('\n').map(s=>JSON.parse(s) as {kind:string;runId:string;pid:number;session?:string}) : []
 return {config,settings,replies,open,event,audit,git}
}
const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 18000, interval: 25 })
const deadline = () => new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/, 'Z')
async function enqueue(f: ReturnType<typeof fixture>, adapter: NightAdapter, text: string, id: string) {
 const incoming = f.event(`入队 只读 fixture | ${text}`, id)
 await adapter.receive(incoming); await adapter.receive(incoming)
 const task = adapter.snapshot().tasks.at(-1)!
 await adapter.receive(f.event(`批准任务 ${task.id}`, `approve-${id}`))
 return task
}

describe('nightshift isolated integration', {timeout: 30000}, () => {
 it('serializes transport-shaped commands, persists receipts and never replays completed tasks after reopen', async () => {
  const f=fixture(), a=f.open()
  await a.receive(f.event('状态','status'))
  await enqueue(f,a,'first read','queue1'); await enqueue(f,a,'second read','queue2')
  expect(a.snapshot().tasks).toHaveLength(2); expect(f.audit()).toEqual([])
  const start=f.event(`开始夜班 截止 ${deadline()}`,'start')
  await a.receive(start); await a.receive(start)
  await until(()=>expect(a.snapshot().tasks.map(t=>t.state)).toEqual(['succeeded','succeeded']))
  expect(f.audit().map(x=>x.kind)).toEqual(['start','stopped','start','stopped'])
  expect(new Set(f.audit().filter(x=>x.kind==='start').map(x=>x.session)).size).toBe(1)
  await a.receive(f.event('我要接班','handoff'))
  expect(a.snapshot().mode).toBe('DAY_MANUAL'); expect(f.git(['status','--porcelain'])).toBe('')
  const before=f.replies.size; await a.close()
  const reopened=f.open(); await reopened.receive(start)
  expect(reopened.snapshot().mode).toBe('DAY_MANUAL'); expect(f.audit()).toHaveLength(4)
  expect(f.replies.size).toBe(before)
  expect([...f.replies.values()].every(r=>r.channel.address.direct==='true' && r.channel.address.chatId==='oc_fixture')).toBe(true)
 })
 it('does not acknowledge safe handoff until actual fake writer exits and holds the second queued task', async () => {
  const f=fixture(), a=f.open(); await enqueue(f,a,'WAIT until cancelled','queue1'); await enqueue(f,a,'second must stay queued','queue2')
  await a.receive(f.event(`开始夜班 截止 ${deadline()}`,'start'))
  await until(()=>expect(f.audit().filter(x=>x.kind==='start')).toHaveLength(1))
  const pid=f.audit()[0]!.pid
  await a.receive(f.event('我要接班','handoff'))
  expect(a.snapshot().mode).toBe('HANDOFF_PENDING')
  expect(()=>process.kill(pid,0)).not.toThrow()
  expect([...f.replies.values()].some(r=>r.text.includes('已确认受监管写入进程退出'))).toBe(false)
  await until(()=>expect(a.snapshot().mode).toBe('DAY_MANUAL'))
  expect(()=>process.kill(pid,0)).toThrow()
  expect(a.snapshot().tasks.map(t=>t.state)).toEqual(['cancelled','queued'])
  await a.receive(f.event('状态','after-stop'))
  expect([...f.replies.values()].some(r=>r.text.includes('已确认受监管写入进程退出'))).toBe(true)
  expect(f.audit().filter(x=>x.kind==='start')).toHaveLength(1)
 })
 it('retains unknown action outcome and denies remaining queue or duplicate start despite verified process exit', async () => {
  const f=fixture(), a=f.open(); await enqueue(f,a,'UNKNOWN mutation receipt','queue1'); await enqueue(f,a,'do not dispatch','queue2')
  const start=f.event(`开始夜班 截止 ${deadline()}`,'start'); await a.receive(start)
  await until(()=>expect(a.snapshot().mode).toBe('RECOVERY_REQUIRED'))
  expect(a.snapshot().tasks.map(t=>t.state)).toEqual(['unknown','queued'])
  expect(a.snapshot().tasks[0]!.result?.writerStopped).toBe(true)
  await a.receive(start); await a.receive(f.event('我要接班','handoff'))
  expect(a.snapshot().mode).toBe('RECOVERY_REQUIRED'); expect(f.audit().filter(x=>x.kind==='start')).toHaveLength(1)
 })
})
