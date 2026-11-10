/** Offline publisher tests: fake GitLab GET, fixed synthetic HMAC, temp output only. */
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hook = fileURLToPath(new URL('../integrations/jenkins/publisher-hook.py', import.meta.url))
const patcher = fileURLToPath(new URL('../integrations/jenkins/patch-publishers.py', import.meta.url))
const captured = '/Volumes/ExtendData/Work/temp/nightshift-validation/jenkins-live-source'
const roots: string[] = []
function temp() { const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'nightshift-publisher-test-'))); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) { if (dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-publisher-test-')) throw new Error('Unsafe fixture cleanup'); rmSync(root, { recursive: true, force: false }) } })
const driver = String.raw`
import importlib.util,sys,json,hmac,hashlib,os
from pathlib import Path
from datetime import datetime,timezone
s=importlib.util.spec_from_file_location('publisher_hook',sys.argv[1]);m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)
root=Path(sys.argv[2]);scenario=sys.argv[3]
m.ROOT=root;m.ASSETS=root/'assets';m.ROUTES=root/'routes.json';m.KEY=root/'signing.key';m.STATE=root/'replay';m.PREPARED=root/'prepared'
for p in (m.ASSETS,m.STATE,m.PREPARED,root/'read-credentials'):p.mkdir(mode=0o700)
key=b'offline-test-key-never-live-0123456789abcdef';m.KEY.write_bytes(key);m.KEY.chmod(0o600)
origin='http://gitlab.yk.ykgtxy.com';sha='a'*40
payload=dict(version=1,taskId='task-1',grantId='grant-1',operationId='create-mr-1',projectId=451,sourceSha=sha,environment='test',jobs=['mate-workspace'],destinationId='test:workspace',issuedAt='2026-11-10T00:00:00Z',notBefore='2026-11-10T00:00:00Z',expiresAt='2026-11-10T02:00:00Z',freezeWindows=[],keyId='test-key',nonce='N'*43)
g=m.load_gate()
v2=scenario.startswith('v2-')
merged='b'*40;target_sha='c'*40;tree='d'*40
if v2:payload.update(version=2,targetSha=target_sha,expectedTreeSha=tree,validationProfile='full-verify')
ticket=dict(payload=payload,signature=hmac.new(key,g.canonical(payload),hashlib.sha256).hexdigest())
env=dict(RELEASE_TRIGGER_KIND='master-push',RELEASE_EVENT_ACTOR='95',RELEASE_EVENT_PROJECT='451',RELEASE_EVENT_PATH='payment/refactor/mate-workspace',RELEASE_EVENT_SHA=sha,RELEASE_EVENT_REF='refs/heads/master',RELEASE_EVENT_SOURCE=origin,JOB_NAME='mate-workspace',BUILD_NUMBER='123')
if v2:env['RELEASE_EVENT_SHA']=merged
routes=dict(version=1,keyId='test-key',gitlabOrigin=origin,keyFile=str(m.KEY),stateDir=str(m.STATE),projects={'451':dict(botUserId=95,path='payment/refactor/mate-workspace',readCredentialFile=str(root/'read-credentials/451.json'),jobs={'mate-workspace':dict(destinationId='test:workspace',namespace='mate-backend',deployment='mate-workspace',container='app')})})
m.ROUTES.write_text(json.dumps(routes));m.ROUTES.chmod(0o600)
credential=root/'read-credentials/451.json';credential.write_text(json.dumps(dict(projectId=451,token='TEST-READ-ONLY-TOKEN',expiresAt='2026-12-01T00:00:00Z')));credential.chmod(0o600)
if scenario=='human':env['RELEASE_EVENT_ACTOR']='12';m.ROUTES.unlink();m.KEY.unlink();credential.unlink()
if scenario=='manual':env={'RELEASE_TRIGGER_KIND':'manual'};m.ROUTES.unlink();m.KEY.unlink();credential.unlink()
if scenario=='missing':env.pop('RELEASE_EVENT_ACTOR')
if scenario=='wrong-bot':env['RELEASE_EVENT_ACTOR']='96'
if scenario=='wrong-job':env['JOB_NAME']='other'
if scenario=='wrong-signature':ticket['signature']='0'*64
if scenario=='expired-read-credential':credential.write_text(json.dumps(dict(projectId=451,token='TEST-READ-ONLY-TOKEN',expiresAt='2026-11-01T00:00:00Z')))
if scenario=='malformed-read-expiry':credential.write_text(json.dumps(dict(projectId=451,token='TEST-READ-ONLY-TOKEN',expiresAt='2026-12-01')))
if scenario=='freeze':payload.update(issuedAt='2026-11-12T00:00:00+08:00',notBefore='2026-11-12T00:00:00+08:00',expiresAt='2026-11-12T02:00:00+08:00');ticket['signature']=hmac.new(key,g.canonical(payload),hashlib.sha256).hexdigest()
envelopes=[ticket,ticket] if scenario=='duplicate-ticket' else [ticket]
description='nightshift:task-1:mate-workspace:'+sha+'\n'+m.BLOCK_OPEN+json.dumps(envelopes)+m.BLOCK_CLOSE
if scenario=='duplicate-block':description+='\n'+m.BLOCK_OPEN+json.dumps([ticket])+m.BLOCK_CLOSE
mr=dict(iid=9,author=dict(id=95),source_project_id=451,target_project_id=451,state='merged',merge_commit_sha=merged if v2 else sha,sha=sha,target_branch='master',source_branch='sdd/task',description=description)
commit=dict(id=merged,parent_ids=[target_sha,sha])
if scenario=='v2-wrong-mr-source':mr['sha']='e'*40
if scenario=='v2-reversed-api-parents':commit['parent_ids']=[sha,target_sha]
if scenario=='v2-extra-api-parent':commit['parent_ids'].append('e'*40)
if scenario=='v2-missing-api-parent':commit.pop('parent_ids')
if scenario=='v2-wrong-api-id':commit['id']='e'*40
if scenario=='v2-api-tree-lie':commit['tree_id']='f'*40
if scenario=='v2-m-equals-s':env['RELEASE_EVENT_SHA']=sha;mr['merge_commit_sha']=sha;commit['id']=sha
if scenario=='v2-wrong-signature':ticket['signature']='0'*64;mr['description']='nightshift:task-1:mate-workspace:'+sha+'\n'+m.BLOCK_OPEN+json.dumps([ticket])+m.BLOCK_CLOSE
calls=[]
def getter(o,path,token):
    assert o==origin and token=='TEST-READ-ONLY-TOKEN';calls.append(path)
    if path.endswith('/451'):return dict(id=451,path_with_namespace='payment/refactor/mate-workspace',default_branch='master'),None
    if '/repository/commits/' in path and '/merge_requests?' in path:return [mr,mr] if scenario=='ambiguous-mr' else [mr],''
    if '/repository/commits/' in path and v2:return commit,None
    if path.endswith('/merge_requests/9'):return mr,None
    raise AssertionError('unexpected route')
now=datetime(2026,11,10,1,0,0,tzinfo=timezone.utc)
if scenario=='freeze':now=datetime.fromisoformat('2026-11-12T01:00:00+08:00')
try:
    target=dict(namespace='mate-backend',deployment='mate-workspace',container='app')
    if scenario.startswith('prepare-target-'):target[scenario.removeprefix('prepare-target-')]='wrong-target'
    if scenario=='missing-route-target':
        del routes['projects']['451']['jobs']['mate-workspace']['namespace'];m.ROUTES.write_text(json.dumps(routes))
    prepared=m.prepare(env,trusted_target=target,routes_file=m.ROUTES,getter=getter,now=now)
    assert not list(m.STATE.iterdir()),'prepare consumed replay intent'
    if prepared['mode']=='nightshift':
        expected={k:prepared[k] for k in ('job','buildId','sourceSha','projectId','environment')}
        expected['target']=dict(target)
        if scenario.startswith('admit-target-'):expected['target'][scenario.removeprefix('admit-target-')]='wrong-target'
        if scenario=='tampered-prepared-target':
            prepared['target']=dict(target,container='wrong-target');expected['target']=dict(prepared['target'])
        if scenario=='wrong-build':expected['buildId']='124'
        if scenario=='expired':now=datetime(2026,11,10,3,0,0,tzinfo=timezone.utc)
        proof=dict(sha=merged,parents=[target_sha,sha],treeSha=tree,verification=dict(source=merged,profile='full-verify',passed=True)) if v2 else None
        if scenario=='v2-no-proof':proof=None
        if scenario=='v2-wrong-local-sha':proof['sha']=sha
        if scenario=='v2-wrong-local-tree':proof['treeSha']='e'*40
        if scenario=='v2-reversed-local-parents':proof['parents']=[sha,target_sha]
        if scenario=='v2-extra-proof-field':proof['untrusted']=True
        if scenario=='v2-missing-verification':proof.pop('verification')
        if scenario=='v2-source-audit':proof['verification']['source']=sha
        if scenario=='v2-failed-audit':proof['verification']['passed']=False
        if scenario=='v2-string-passed':proof['verification']['passed']='true'
        if scenario=='v2-package-only':proof['verification']['profile']='package-only'
        if scenario=='v2-wrong-plan':prepared['expectedTreeSha']='e'*40
        if scenario=='v2-stripped-plan':prepared.pop('ticketVersion')
        if scenario=='v2-tampered-snapshot':
            p=Path(prepared['contextPath']);doc=json.loads(p.read_text());doc['context']['expectedTreeSha']='e'*40;prepared['expectedTreeSha']='e'*40;p.write_text(json.dumps(doc))
        if scenario=='v2-tampered-signed-plan':
            p=Path(prepared['contextPath']);doc=json.loads(p.read_text());doc['ticket']['payload']['expectedTreeSha']='e'*40;doc['context']['expectedTreeSha']='e'*40;prepared['expectedTreeSha']='e'*40;proof['treeSha']='e'*40;p.write_text(json.dumps(doc))
        if scenario=='v2-expired':now=datetime(2026,11,10,3,0,0,tzinfo=timezone.utc)
        if scenario=='v2-valid':
            try:m.admit_prepared(prepared,expected,now=now)
            except Exception:pass
            else:raise AssertionError('V2 no-proof default allowed')
            assert not list(m.STATE.iterdir()),'failed proof consumed intent'
        result=m.admit_prepared(prepared,expected,commit_proof=proof,now=now)
        replay=False
        try:m.admit_prepared(prepared,expected,commit_proof=proof,now=now)
        except Exception:replay=True
        assert replay,'same-build admission replay allowed'
        print(json.dumps(dict(ok=True,prepared=prepared,result=result,calls=calls,markers=len(list(m.STATE.iterdir())),mounts=m.deploy_mount_args(prepared))))
    else:print(json.dumps(dict(ok=True,prepared=prepared,calls=calls,markers=0,mounts=m.deploy_mount_args(prepared))))
except Exception as e:
    print(json.dumps(dict(ok=False,error=type(e).__name__,reason=str(e),calls=calls,markers=len(list(m.STATE.iterdir())))))
`
function scenario(name: string) {
  const result = spawnSync('python3', ['-I', '-B', '-c', driver, hook, temp(), name], { encoding: 'utf8', timeout: 10_000, maxBuffer: 128_000 })
  if (result.status !== 0) throw new Error(`Python fixture failed ${result.stderr}`)
  return JSON.parse(result.stdout)
}

describe('offline Jenkins publisher hook', () => {
  it('mounts no private controller binding for manual/human but requires it for bot actors', () => {
    const root = temp(); const assets = resolve(root, 'assets'); mkdirSync(assets)
    const extracted = spawnSync('python3', ['-I', '-B', '-c', String.raw`import importlib.util,sys
s=importlib.util.spec_from_file_location('patcher',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(m.controller_mounts().replace('/var/lib/jenkins/superagent-nightshift',sys.argv[2]))`, patcher, root], { encoding: 'utf8' })
    expect(extracted.status).toBe(0)
    const run = (kind: string, actor: string) => spawnSync('/bin/bash', ['-c', `set -euo pipefail; args=(); RELEASE_TRIGGER_KIND=${kind}; RELEASE_EVENT_ACTOR=${actor};\n${extracted.stdout}\nprintf '%s\\n' "\${args[@]}"`], { encoding: 'utf8' })
    for (const [kind, actor] of [['manual', "''"], ['master-push', '12']]) {
      const result = run(kind!, actor!); expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('/assets'); expect(result.stdout).not.toContain('signing.key'); expect(result.stdout).not.toContain('routes.json'); expect(result.stdout).not.toContain('/replay')
    }
    expect(run('master-push', "''").status).toBe(1)
    expect(run('master-push', '95').status).toBe(1) // private bot setup not provisioned
    for (const name of ['prepared', 'replay', 'read-credentials']) mkdirSync(resolve(root, name))
    writeFileSync(resolve(root, 'routes.json'), '{}'); writeFileSync(resolve(root, 'signing.key'), 'fake')
    const bot = run('master-push', '95'); expect(bot.status, bot.stderr).toBe(0)
    expect(bot.stdout).toContain('signing.key'); expect(bot.stdout).toContain('read-credentials')
  })
  it('validates prepare without consuming and admits once only at patch boundary', () => {
    const out = scenario('valid')
    expect(out.ok).toBe(true); expect(out.result.allowed).toBe(true); expect(out.markers).toBe(2)
    expect(out.prepared).toMatchObject({ mode: 'nightshift', actorId: 95, projectId: 451, buildId: '123', destinationId: 'test:workspace' })
    expect(JSON.stringify(out)).not.toContain('TEST-READ-ONLY-TOKEN'); expect(JSON.stringify(out)).not.toContain('offline-test-key')
    expect(out.calls).toHaveLength(3); expect(out.calls[1]).toContain('/repository/commits/' + 'a'.repeat(40) + '/merge_requests')
    expect(out.mounts.join(' ')).not.toContain('read-credentials'); expect(out.mounts.join(' ')).not.toContain('routes.json')
  })
  it.each(['human', 'manual'])('preserves trusted %s jobs without reading API credentials or HMAC key', name => {
    const out = scenario(name); expect(out.ok).toBe(true); expect(out.prepared.mode).toBe(name); expect(out.calls).toEqual([]); expect(out.markers).toBe(0)
    expect(out.mounts.join(' ')).not.toContain('signing.key')
  })
  it.each(['missing', 'wrong-bot', 'wrong-job', 'wrong-signature', 'duplicate-ticket', 'duplicate-block', 'ambiguous-mr', 'wrong-build', 'expired', 'freeze', 'missing-route-target', 'prepare-target-namespace', 'prepare-target-deployment', 'prepare-target-container', 'admit-target-namespace', 'admit-target-deployment', 'admit-target-container', 'tampered-prepared-target', 'expired-read-credential', 'malformed-read-expiry'])('rejects %s before write admission', name => {
    const out = scenario(name); expect(out.ok).toBe(false); expect(out.markers).toBe(0)
    expect(JSON.stringify(out)).not.toContain('TEST-READ-ONLY-TOKEN')
    if (name.startsWith('prepare-target-') || name.includes('read-') || name === 'missing-route-target') expect(out.calls).toEqual([])
  })
})

describe('offline v2 ordinary-merge publisher proof', () => {
  it('prepares without invented tree/tests then admits exact local merge+full-verify evidence', () => {
    const out = scenario('v2-valid')
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(out.prepared).toMatchObject({ sourceSha: 'b'.repeat(40), ticketVersion: 2, approvedSourceSha: 'a'.repeat(40),
      targetSha: 'c'.repeat(40), expectedTreeSha: 'd'.repeat(40), parents: ['c'.repeat(40), 'a'.repeat(40)],
      validationProfile: 'full-verify', proofPending: true })
    expect(out.prepared).not.toHaveProperty('verificationPassed')
    expect(out.calls).toHaveLength(4)
    expect(out.calls[3]).toBe('/api/v4/projects/451/repository/commits/' + 'b'.repeat(40))
    expect(out.result.mergeVerification).toEqual({ version: 2, sourceSha: 'a'.repeat(40), deployedSha: 'b'.repeat(40),
      targetSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), parents: ['c'.repeat(40), 'a'.repeat(40)], profile: 'full-verify', passed: true })
    expect(out.markers).toBe(2)
    expect(out.mounts.join(' ')).not.toContain('read-credentials')
    expect(JSON.stringify(out)).not.toContain('TEST-READ-ONLY-TOKEN')
  })
  it('does not pretend GitLab commit API tree_id is an actual local Git proof', () => {
    const out = scenario('v2-api-tree-lie')
    expect(out.ok).toBe(true)
    expect(out.result.mergeVerification.treeSha).toBe('d'.repeat(40))
    expect(out.result.mergeVerification.treeSha).not.toBe('f'.repeat(40))
  })
  it.each(['v2-wrong-mr-source', 'v2-reversed-api-parents', 'v2-extra-api-parent', 'v2-missing-api-parent',
    'v2-wrong-api-id', 'v2-m-equals-s', 'v2-wrong-signature', 'v2-no-proof', 'v2-wrong-local-sha',
    'v2-wrong-local-tree', 'v2-reversed-local-parents', 'v2-extra-proof-field', 'v2-missing-verification',
    'v2-source-audit', 'v2-failed-audit', 'v2-string-passed', 'v2-package-only', 'v2-wrong-plan',
    'v2-stripped-plan', 'v2-tampered-snapshot', 'v2-tampered-signed-plan', 'v2-expired'])('denies %s before consuming write admission', name => {
    const out = scenario(name)
    expect(out.ok, JSON.stringify(out)).toBe(false)
    expect(out.markers).toBe(0)
    expect(out).not.toHaveProperty('result.mergeVerification')
    expect(JSON.stringify(out)).not.toContain('TEST-READ-ONLY-TOKEN')
  })
  it('v1 golden route retains actual==approved source and no v2 verification artifact', () => {
    const out = scenario('valid')
    expect(out.ok).toBe(true)
    expect(out.calls).toHaveLength(3)
    expect(out.result).not.toHaveProperty('mergeVerification')
    expect(out.prepared).not.toHaveProperty('ticketVersion')
  })
})

// Live source is a private read-only capture, deliberately not vendored into the package.
// These two integration checks run when that exact reviewed capture is available.
describe.skipIf(!existsSync(resolve(captured, 'manifest.json')))('exact hashed offline publisher patch preparation', () => {
  it('patches current captured sources into a new directory without changing input bytes', () => {
    const before = readFileSync(resolve(captured, 'manifest.json'), 'utf8'); const root = temp(); const output = resolve(root, 'prepared')
    const run = spawnSync('python3', ['-I', '-B', patcher, '--source', captured, '--output', output], { encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    const manifest = JSON.parse(readFileSync(resolve(output, 'patch-manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ preparedOnly: true, deployReady: false })
    for (const item of manifest.outputs) expect(createHash('sha256').update(readFileSync(resolve(output, item.file))).digest('hex')).toBe(item.sha256)
    const java = readFileSync(resolve(output, 'mate-java-release.py'), 'utf8')
    expect(java.indexOf('nightshift_hook().admit_prepared')).toBeLessThan(java.indexOf('        attempted_patch = True'))
    expect(java).toContain("trusted_target=dict(namespace=cfg['DEPLOY_NAMESPACE'], deployment=cfg['DEPLOYMENT'], container=cfg['APP_CONTAINER'])")
    expect(java).toContain("target=dict(namespace=cfg['DEPLOY_NAMESPACE'], deployment=cfg['DEPLOYMENT'], container=cfg['APP_CONTAINER'])")
    const web = readFileSync(resolve(output, 'mate-web-deploy.py'), 'utf8')
    expect(web.indexOf('        patch_admission(request)')).toBeLessThan(web.indexOf('nightshift_hook().admit_prepared'))
    expect(web.indexOf('nightshift_hook().admit_prepared')).toBeLessThan(web.indexOf("receipt.update(result='unknown'"))
    expect(web).toContain("target=dict(namespace=before['metadata']['namespace'], deployment=before['metadata']['name'], container=contract['container'])")
    const controller = readFileSync(resolve(output, 'decoded-mate-web-release.py'), 'utf8')
    expect(controller).toContain("if stage == 'deploy':\n        args += nightshift_hook().deploy_mount_args")
    expect(controller).toContain('remote_head(meta, env)')
    expect(controller).toContain("trusted_target=dict(namespace='mate-frontend', deployment=meta['service'], container=cfg['services'][meta['service']]['container'])")
    const mounts = spawnSync('python3', ['-I', '-B', '-c', String.raw`
import importlib.util,sys,json
from pathlib import Path
root=Path(sys.argv[1])
def load(name,file):
 s=importlib.util.spec_from_file_location(name,root/file);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
h=load('actual_hook','publisher-hook.py')
w=load('patched_web','decoded-mate-web-release.py')
j=load('patched_java','mate-java-release.py')
# Exercise actual pinned loader against the generated assets via a test-only Path mapping.
for module in (w,j):
 module.Path=lambda value: root/'publisher-hook.py' if value=='/var/lib/jenkins/superagent-nightshift/assets/merge-v2/publisher-hook.py' else Path(value)
 actual=module.nightshift_hook();module.Path=Path
 assert actual.admit_prepared({'version':1,'mode':'manual'},{})['allowed']
 module.nightshift_hook=lambda actual=actual:actual
wc={'build_tool':'fake-builder','deploy_tool':'fake-deployer'}
jc={'DEPLOY_TOOL':'registry/mate-deploy/worker@sha256:'+'a'*64,'BUILD_TOOL':'registry/mate-deploy/worker@sha256:'+'b'*64,'REGISTRY_HOST':'registry','BUILD_MEMORY':'1g','BUILD_CPUS':'1','DOCKER_SOCKET_GID':'1','REGISTRY_CA_FILE':'/trusted/ca','BUILD_TIMEZONE':'UTC'}
paths={key:Path('/trusted/'+key) for key in ('script','config','work','repo','settings','harbor_auth','kube','source_auth','askpass','identity')}
for mode in ('manual','human','nightshift'):
 prepared={'version':1,'mode':mode,'actorId':95 if mode=='nightshift' else 12,'contextPath':str(h.PREPARED/('a'*64+'.json'))}
 wc['NIGHTSHIFT_PREPARED']=prepared;jc['NIGHTSHIFT_PREPARED']=json.dumps(prepared)
 if mode!='nightshift':assert h.admit_prepared(prepared,{})==dict(allowed=True,gated=False,mode=mode)
 for stage in ('verify','preflight','deploy'):
  command=w.worker(wc,stage,Path('/attempt'),Path('/trusted/script.py'),Path('/trusted/config.json'),Path('/attempt/private'),Path('/trusted/kube'))
  joined=' '.join(command)
  assert (str(h.ASSETS) in joined)==(stage=='deploy')
  assert ('signing.key' in joined)==(stage=='deploy' and mode=='nightshift')
  assert ('/replay' in joined)==(stage=='deploy' and mode=='nightshift')
  assert 'read-credentials' not in joined and 'routes.json' not in joined
 for stage in ('verify','image','deploy'):
  command=j.stage_command(stage,jc,paths,{})
  joined=' '.join(command)
  assert (str(h.ASSETS) in joined)==(stage=='deploy')
  assert ('signing.key' in joined)==(stage=='deploy' and mode=='nightshift')
  assert ('/replay' in joined)==(stage=='deploy' and mode=='nightshift')
  assert 'read-credentials' not in joined and 'routes.json' not in joined
print('worker mount separation passed')
`, output], { encoding: 'utf8' })
    expect(mounts.status, mounts.stderr).toBe(0)
    expect(readFileSync(resolve(output, 'mate-java-release.sh'), 'utf8')).toContain('RELEASE_EVENT_SOURCE RELEASE_EVENT_ACTOR')
    for (const file of ['mate-java-release.sh', 'mate-web-build-push.sh']) expect(spawnSync('/bin/bash', ['-n', resolve(output, file)]).status).toBe(0)
    expect(readFileSync(resolve(captured, 'manifest.json'), 'utf8')).toBe(before)
    expect(spawnSync('python3', ['-I', '-B', patcher, '--source', captured, '--output', output], { encoding: 'utf8' }).status).toBe(1)
  })
  it('refuses source drift and never emits partially patched output', () => {
    const root = temp(); const source = resolve(root, 'capture'); mkdirSync(source)
    for (const file of ['manifest.json', 'mate-java-release.sh', 'mate-java-release.py', 'mate-web-build-push.sh', 'mate-web-deploy.py']) cpSync(resolve(captured, file), resolve(source, file))
    writeFileSync(resolve(source, 'mate-web-deploy.py'), readFileSync(resolve(source, 'mate-web-deploy.py'), 'utf8') + '\n# drift\n')
    const output = resolve(root, 'out')
    expect(spawnSync('python3', ['-I', '-B', patcher, '--source', source, '--output', output]).status).toBe(1)
    expect(existsSync(output)).toBe(false)
  })
})
