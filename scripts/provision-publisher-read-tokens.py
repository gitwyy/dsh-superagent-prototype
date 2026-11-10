#!/usr/bin/env python3
"""Provision per-application Reporter/read_api tokens for trusted Jenkins metadata lookup.
Only the already-approved 15 runnable v2 projects. No group token, repo write,
merge, build, deploy, auth-login or keychain modification. Private 0600 outputs.
"""
import argparse,datetime,json,os,subprocess,sys
from pathlib import Path
HOST='gitlab.yk.ykgtxy.com'
NAME='superagent-v2-publisher-read-20261110'
def api(path,method='GET',data=None):
 args=['/opt/homebrew/bin/glab','api','--hostname',HOST,'--method',method,'http://'+HOST+'/api/v4/'+path]
 if data is not None:args+=['--header','Content-Type: application/json','--input','-']
 p=subprocess.run(args,input=json.dumps(data) if data is not None else None,capture_output=True,text=True,timeout=20)
 if p.returncode:raise RuntimeError('GitLab request failed; do not retry without reconciliation')
 return json.loads(p.stdout)
def save(path,value):
 fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f,indent=2);f.flush();os.fsync(f.fileno())
def main():
 p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--release-policy',required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
 root=Path(a.directory)
 if not root.is_absolute() or root.resolve()!=root:raise RuntimeError('Canonical private output required')
 with open(a.release_policy) as f:policy=json.load(f)
 repos={k:v for k,v in policy['repositories'].items() if v['mergeTriggersDeploy']}
 if len(repos)!=15 or any(v['projectPath']!='payment/refactor/'+k or v['host']!=HOST for k,v in repos.items()):raise RuntimeError('Reviewed fifteen project routes required')
 if a.apply:
  root.mkdir(mode=0o700,parents=True,exist_ok=True)
  if root.stat().st_mode & 0o077:raise RuntimeError('Output permissions unsafe')
 owner=api('user')
 if owner.get('id')!=35 or owner.get('username')!='wangyangyang':raise RuntimeError('Operator identity changed')
 for alias,r in repos.items():
  pid=r['projectId'];path=root/(str(pid)+'.json');ledger=root/(str(pid)+'.intent.json')
  tokens=api('projects/%s/access_tokens'%pid);matches=[t for t in tokens if t.get('name')==NAME and not t.get('revoked')]
  if path.exists():
   with path.open() as f:stored=json.load(f)
   if len(matches)!=1 or matches[0]['id']!=stored['tokenId'] or matches[0]['access_level']!=20 or matches[0]['scopes']!=['read_api']:raise RuntimeError('Existing readonly identity conflicts')
   print(json.dumps({'alias':alias,'projectId':pid,'tokenId':stored['tokenId'],'existing':True}));continue
  if matches or ledger.exists():raise RuntimeError('Existing remote token or intent without private receipt; reconcile '+alias)
  if not a.apply:print(json.dumps({'alias':alias,'projectId':pid,'role':20,'scopes':['read_api'],'expires':'2026-12-10'}));continue
  save(ledger,{'projectId':pid,'name':NAME,'phase':'dispatching'})
  d=api('projects/%s/access_tokens'%pid,'POST',{'name':NAME,'access_level':20,'scopes':['read_api'],'expires_at':'2026-12-10'})
  if not d.get('token') or d.get('access_level')!=20 or d.get('scopes')!=['read_api']:raise RuntimeError('Unexpected readonly token response')
  save(path,{'projectId':pid,'token':d['token'],'tokenId':d['id'],'userId':d['user_id'],'expiresAt':'2026-12-10T00:00:00Z'})
  print(json.dumps({'alias':alias,'projectId':pid,'tokenId':d['id'],'userId':d['user_id'],'role':20,'scopes':['read_api'],'expiresAt':'2026-12-10T00:00:00Z'}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as e:print('Provisioning stopped: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);sys.exit(1)
