#!/usr/bin/env python3
"""Install new public V2 gate files and update only four pinned existing Managed files.
Default dry-run. No keys/routes/credentials/job XML/ACL changes and no build trigger.
Stops on any unknown or partial result; an existing operation directory requires
manual readback reconciliation, never blind retry.
"""
import argparse,base64,hashlib,importlib.util,json,os,sys,urllib.request,urllib.parse
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
MANAGED={'mate-java-release-run':'mate-java-release.sh','mate-java-release-runtime':'mate-java-release.py','mate-web-build-push':'mate-web-build-push.sh','mate-web-rancher-deploy':'mate-web-deploy.py'}
def sha(x):return hashlib.sha256(x if isinstance(x,bytes) else x.encode()).hexdigest()
def save(path,data):
 fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--candidate',required=True);p.add_argument('--before',required=True);p.add_argument('--backup',required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
 candidate=Path(a.candidate);backup=Path(a.backup)
 for path in [candidate,backup]:
  if not path.is_absolute() or path.resolve()!=path:raise RuntimeError('Canonical paths required')
 manifest=json.loads((candidate/'patch-manifest.json').read_text());outputs={x['file']:x for x in manifest['outputs']};before=json.loads(Path(a.before).read_text());expected={x['id']:x['sha256'] for x in before['managed']}
 jobs=[x['job'] for x in before['jobs']]
 if len(jobs)!=20 or len(set(jobs))!=20 or set(expected)!=set(MANAGED):raise RuntimeError('Exact reviewed20jobs/4Managed required')
 for name in [*MANAGED.values(),'publisher-hook.py','nightshift-gate.py']:
  if sha((candidate/name).read_bytes())!=outputs[name]['sha256']:raise RuntimeError('Candidate file changed')
 spec=importlib.util.spec_from_file_location('forms',ROOT/'scripts/apply-jenkins-nightshift.py');forms=importlib.util.module_from_spec(spec);spec.loader.exec_module(forms)
 spec=importlib.util.spec_from_file_location('jo','/Code/youke-mate/refactor/mate-pi/scripts/jenkins-tool.py');jo=importlib.util.module_from_spec(spec);spec.loader.exec_module(jo);jo.load_env();origin=os.environ.get('JENKINS_URL',jo.DEFAULT_URL).rstrip('/')
 if origin!='http://192.168.77.179:8080':raise RuntimeError('Origin drift')
 auth=jo.build_auth_header()
 def get(path):
  with urllib.request.urlopen(urllib.request.Request(origin+path,headers={'Authorization':auth}),timeout=20) as r:return r.read(3*1024*1024)
 def post(path,data,ct):
  request=urllib.request.Request(origin+path,data=data,headers={'Authorization':auth,'Content-Type':ct},method='POST')
  with urllib.request.urlopen(request,timeout=25) as r:return r.read(3*1024*1024)
 def idle():
  queue=json.loads(get('/queue/api/json?tree=items[task[name]]'))
  if any(x.get('task',{}).get('name') in jobs for x in queue.get('items',[])):raise RuntimeError('Target queued; no changes')
  for job in jobs:
   result=json.loads(get('/job/'+urllib.parse.quote(job,safe='')+'/api/json?tree=builds[building]{0,5}'))
   if any(x.get('building') for x in result.get('builds',[])):raise RuntimeError('Target building; no changes')
 def readform(fid):
  form=forms.Form();form.feed(get('/configfiles/editConfig?id='+urllib.parse.quote(fid)).decode());return form
 idle();updates=[]
 for fid,filename in MANAGED.items():
  form=readform(fid);old=form.text.get('config.content','')
  if sha(old)!=expected[fid]:raise RuntimeError('Live Managed hash drift: '+fid)
  value=lambda key:form.inputs.get(key,[''])[0]
  if any('credential' in key.lower() and any(values) for key,values in form.inputs.items()):raise RuntimeError('Unexpected credentials mapping')
  config={'stapler-class':'org.jenkinsci.plugins.configfiles.custom.CustomConfig','id':fid,'name':value('config.name'),'comment':value('config.comment'),'content':(candidate/filename).read_text(),'providerId':'org.jenkinsci.plugins.configfiles.custom.CustomConfig$CustomConfigProvider','customizedCredentialMappings':[]}
  updates.append({'id':fid,'old':old,'beforeSha256':sha(old),'afterSha256':sha(config['content']),'config':config})
 # Public assets only. Never include signing/read credentials or private state in this request.
 payload={'apply':a.apply,'files':[{'name':name,'sha256':outputs[name]['sha256'],'base64':base64.b64encode((candidate/name).read_bytes()).decode()} for name in ['publisher-hook.py','nightshift-gate.py']]}
 script=(ROOT/'integrations/jenkins/install-merge-assets.groovy').read_text();encoded=base64.b64encode(json.dumps(payload,separators=(',',':')).encode()).decode();script=script.replace('__INPUT_JSON_BASE64__',"','".join(encoded[i:i+16000] for i in range(0,len(encoded),16000)))
 plan={'jobsUnchanged':20,'updates':[{k:u[k] for k in ['id','beforeSha256','afterSha256']} for u in updates],'assets':[{'name':x['name'],'sha256':x['sha256']} for x in payload['files']],'apply':a.apply,'buildsTriggered':False}
 if a.apply:
  if backup.exists():raise RuntimeError('Operation exists: stop and reconcile')
  backup.mkdir(mode=0o700,parents=True);save(backup/'plan.json',json.dumps(plan,indent=2).encode())
  for u in updates:save(backup/(u['id']+'-before'),u['old'].encode())
  save(backup/'assets-dispatching.json',b'{"operation":"new-public-assets"}')
 response=post('/scriptText',urllib.parse.urlencode({'script':script}).encode(),'application/x-www-form-urlencoded');asset_result=json.loads(response)
 if asset_result.get('status') not in (['installed','verified'] if a.apply else ['dry_run','verified']):raise RuntimeError('Public assets failed or partial; reconcile')
 if a.apply:save(backup/'assets-verified.json',json.dumps(asset_result,indent=2).encode())
 print(json.dumps({**plan,'assetsResult':asset_result}),flush=True)
 if not a.apply:return
 for i,u in enumerate(updates):
  idle();fresh=readform(u['id'])
  if sha(fresh.text.get('config.content',''))!=u['beforeSha256']:raise RuntimeError('Managed changed at final write boundary')
  for k in ['name','comment']:
   if fresh.inputs.get('config.'+k,[''])[0]!=u['config'][k]:raise RuntimeError('Managed identity fields changed')
  if u['beforeSha256']==u['afterSha256']:
   save(backup/('%02d-verified.json'%i),json.dumps({'id':u['id'],'afterSha256':u['afterSha256'],'unchanged':True}).encode());continue
  save(backup/('%02d-dispatching.json'%i),json.dumps({'id':u['id'],'afterSha256':u['afterSha256']}).encode())
  post('/configfiles/saveConfig',urllib.parse.urlencode({'json':json.dumps({'config':u['config']})}).encode(),'application/x-www-form-urlencoded')
  after=readform(u['id'])
  if sha(after.text.get('config.content',''))!=u['afterSha256']:raise RuntimeError('Managed readback differs; reconcile')
  save(backup/('%02d-verified.json'%i),json.dumps({'id':u['id'],'afterSha256':u['afterSha256']}).encode())
 print(json.dumps({'configured':True,'managed':4,'jobConfigChanges':0,'secretsChanged':False,'buildsTriggered':False,'backup':str(backup)}))
if __name__=='__main__':
 try:main()
 except Exception as e:print('Publisher update stopped: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);sys.exit(1)
