#!/usr/bin/env python3
"""Restore only this ordinary-merge publisher operation's Managed contents.
Default dry-run. Leave GitLab merge_method=merge, jobs/ACLs/keys/routes and versioned
public files unchanged. Disable bot merge/deploy and reconcile all effects first.
"""
import argparse,hashlib,importlib.util,json,os,sys,urllib.request,urllib.parse
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
IDS={'mate-java-release-run','mate-java-release-runtime','mate-web-build-push','mate-web-rancher-deploy'}
def sha(x):return hashlib.sha256(x if isinstance(x,bytes) else x.encode()).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--backup',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--release-disabled',action='store_true');a=p.parse_args()
 b=Path(a.backup)
 if not b.is_absolute() or b.resolve()!=b:raise RuntimeError('Canonical receipt path required')
 if a.apply and not a.release_disabled:raise RuntimeError('Disable merge/deploy and reconcile before rollback')
 plan=json.loads((b/'plan.json').read_text())
 if len(plan['updates'])!=4 or {x['id'] for x in plan['updates']}!=IDS:raise RuntimeError('Exact4Managed operation required')
 for i in range(4):
  if not (b/('%02d-verified.json'%i)).is_file():raise RuntimeError('Incomplete operation needs explicit reconciliation')
 spec=importlib.util.spec_from_file_location('forms',ROOT/'scripts/apply-jenkins-nightshift.py');forms=importlib.util.module_from_spec(spec);spec.loader.exec_module(forms)
 spec=importlib.util.spec_from_file_location('jo','/Code/youke-mate/refactor/mate-pi/scripts/jenkins-tool.py');jo=importlib.util.module_from_spec(spec);spec.loader.exec_module(jo);jo.load_env();origin=os.environ.get('JENKINS_URL',jo.DEFAULT_URL).rstrip('/');auth=jo.build_auth_header()
 if origin!='http://192.168.77.179:8080':raise RuntimeError('Origin changed')
 def get(path):
  with urllib.request.urlopen(urllib.request.Request(origin+path,headers={'Authorization':auth}),timeout=20) as r:return r.read(3*1024*1024)
 def form(fid):
  f=forms.Form();f.feed(get('/configfiles/editConfig?id='+urllib.parse.quote(fid)).decode());return f
 # Only idle trusted jobs can change shared Managed source. Generic queue activity
 # also stops this rollback rather than guessing which users are affected.
 if json.loads(get('/queue/api/json?tree=items[id]')).get('items'):raise RuntimeError('Jenkins queue not empty')
 jobs=json.loads(get('/api/json?tree=jobs[name,lastBuild[building]]')).get('jobs',[])
 if any(j.get('lastBuild',{}).get('building') for j in jobs):raise RuntimeError('A Jenkins job is building')
 for row in plan['updates']:
  old=(b/(row['id']+'-before')).read_bytes();f=form(row['id'])
  if sha(old)!=row['beforeSha256'] or sha(f.text.get('config.content',''))!=row['afterSha256']:raise RuntimeError('Backup or current source drift; do not overwrite')
 print(json.dumps({'apply':a.apply,'verifiedManaged':4,'changedManaged':sum(x['beforeSha256']!=x['afterSha256'] for x in plan['updates']),'jobsUnchanged':True,'gitlabMergePolicyUnchanged':True,'buildsTriggered':False}),flush=True)
 if not a.apply:return
 # Each intent is exclusive. A lost response requires readback, never replay.
 for i,row in reversed(list(enumerate(plan['updates']))):
  if row['beforeSha256']==row['afterSha256']:continue
  f=form(row['id'])
  if sha(f.text.get('config.content',''))!=row['afterSha256']:raise RuntimeError('Source changed at rollback boundary')
  value=lambda key:f.inputs.get(key,[''])[0]
  cfg={'stapler-class':'org.jenkinsci.plugins.configfiles.custom.CustomConfig','id':row['id'],'name':value('config.name'),'comment':value('config.comment'),'content':(b/(row['id']+'-before')).read_text(),'providerId':'org.jenkinsci.plugins.configfiles.custom.CustomConfig$CustomConfigProvider','customizedCredentialMappings':[]}
  path=b/('%02d-rollback-intent.json'%i);fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
  with os.fdopen(fd,'w') as stream:json.dump({'id':row['id'],'sha256':row['beforeSha256']},stream);stream.flush();os.fsync(stream.fileno())
  request=urllib.request.Request(origin+'/configfiles/saveConfig',data=urllib.parse.urlencode({'json':json.dumps({'config':cfg})}).encode(),headers={'Authorization':auth,'Content-Type':'application/x-www-form-urlencoded'},method='POST')
  with urllib.request.urlopen(request,timeout=25) as response:response.read(3*1024*1024)
  if sha(form(row['id']).text.get('config.content',''))!=row['beforeSha256']:raise RuntimeError('Rollback readback failed')
 print(json.dumps({'rolledBack':True,'versionedPublicAssetsRetained':True,'buildsTriggered':False}))
if __name__=='__main__':
 try:main()
 except Exception as e:print('Rollback stopped: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);sys.exit(1)
