#!/usr/bin/env python3
"""Provision exact project-scoped release identities after operator authorization.
No Git pushes, MR creation/merge, pipeline triggers, auth-login or keychain writes.
Dry plan by default; --apply creates 30-day Maintainer project tokens and changes
merge_method only. Credentials go to a private host directory, never stdout.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

HOST = 'gitlab.yk.ykgtxy.com'
PROJECTS = {'mate-workspace':451,'mate-base':437,'mate-trade':441,'mate-pay-channel':452,'mate-account':445,'mate-settle':453,'mate-recon':454,'mate-customer':456,'mate-agent':442,'mate-terminal':443,'mate-manage':457,'mate-policy':458,'mate-data-center':459,'mate-gateway':461,'mate-manage-web':463,'mate-customer-wechat':462,'mate-three-server':438}
NAME = 'superagent-v2-release-20261110'

def api(path, method='GET', body=None):
    args=['/opt/homebrew/bin/glab','api','--hostname',HOST,'--method',method,'http://'+HOST+'/api/v4/'+path]
    if body is not None: args += ['--header','Content-Type: application/json','--input','-']
    r=subprocess.run(args,input=json.dumps(body) if body is not None else None,capture_output=True,text=True,timeout=30)
    if r.returncode: raise RuntimeError('GitLab %s failed for %s (exit %s); no automatic retry' % (method,path,r.returncode))
    try:return json.loads(r.stdout)
    except ValueError:raise RuntimeError('GitLab response was not JSON') from None

def save_exclusive(path, value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--directory',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--allow-internal-http',action='store_true');p.add_argument('--resume-confirmed-no-effect',action='store_true',help='Only after an observed 4xx rejection and authoritative empty token list');args=p.parse_args()
    root=Path(args.directory)
    if not root.is_absolute() or root.resolve()!=root:raise RuntimeError('Absolute canonical private directory required')
    if not args.allow_internal_http:raise RuntimeError('Explicit company internal HTTP risk consent flag required')
    if args.apply:
        root.mkdir(mode=0o700,parents=True,exist_ok=True)
        if root.is_symlink() or root.stat().st_mode & 0o077:raise RuntimeError('Private directory must be 0700')
    owner=api('user')
    if owner.get('id')!=35 or owner.get('username')!='wangyangyang':raise RuntimeError('Provisioning owner identity mismatch')
    expires=(dt.datetime.now(dt.timezone.utc).date()+dt.timedelta(days=30)).isoformat()
    for alias,pid in PROJECTS.items():
        project=api('projects/'+str(pid))
        if project.get('id')!=pid or project.get('path_with_namespace')!='payment/refactor/'+alias or project.get('archived') or project.get('default_branch')!='master':raise RuntimeError('Project mapping changed: '+alias)
        if project.get('only_allow_merge_if_pipeline_succeeds') is not True:raise RuntimeError('Required CI merge gate absent: '+alias)
        token_file=root/(alias+'.json');ledger=root/(alias+'.provision.json')
        tokens=api('projects/%s/access_tokens'%pid)
        existing=[t for t in tokens if t.get('name')==NAME and not t.get('revoked')]
        before={k:project.get(k) for k in ['id','path_with_namespace','merge_method','squash_option','only_allow_merge_if_pipeline_succeeds','only_allow_merge_if_all_discussions_are_resolved']}
        if not args.apply:
            print(json.dumps({'alias':alias,'projectId':pid,'role':'Maintainer(40)','scopes':['api','write_repository'],'expiresAt':expires,'mergeMethod':{'before':project.get('merge_method'),'after':'ff'},'existingNamedTokens':len(existing),'privateFileExists':token_file.exists()}));continue
        if token_file.exists():
            info=token_file.stat()
            if token_file.is_symlink() or info.st_mode & 0o077:raise RuntimeError('Unsafe existing private credential')
            with token_file.open() as f:credential=json.load(f)
            if len(existing)!=1 or existing[0].get('id')!=credential.get('tokenId') or credential.get('projectId')!=pid:raise RuntimeError('Existing token/file mismatch; manual reconciliation required')
        else:
            if existing:raise RuntimeError('Token already exists without private credential; do not duplicate; reconcile '+alias)
            if ledger.exists() and not args.resume_confirmed_no_effect:raise RuntimeError('Previous provisioning intent exists; reconcile '+alias)
            if not ledger.exists():save_exclusive(ledger,{'phase':'creating-token','project':before,'name':NAME,'expiresAt':expires,'at':dt.datetime.now(dt.timezone.utc).isoformat()})
            # This is the only credential-creation request. Never retry after uncertainty.
            data=api('projects/%s/access_tokens'%pid,'POST',{'name':NAME,'access_level':40,'scopes':['api','write_repository'],'expires_at':expires})
            if not data.get('token') or data.get('access_level')!=40 or data.get('expires_at')!=expires:raise RuntimeError('Unexpected token response; reconcile '+alias)
            # Persist the returned token before any further remote request can fail. Username is filled using fixed bot ID lookup.
            credential={'token':data['token'],'tokenId':data['id'],'userId':data['user_id'],'username':'PENDING_IDENTITY','projectId':pid,'expiresAt':expires+'T00:00:00Z'}
            save_exclusive(token_file,credential)
        # Reading public bot identity uses operator API; no auth login or secret echo.
        bot=api('users/'+str(credential['userId']))
        if bot.get('id')!=credential['userId'] or bot.get('bot') is not True:raise RuntimeError('Provisioned identity is not a project bot')
        credential['username']=bot['username']
        # Existing file contents checked above; only its newly provisioned identity field is rewritten.
        with token_file.open('w') as f:json.dump(credential,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
        req=urllib.request.Request('http://'+HOST+'/api/v4/user',headers={'PRIVATE-TOKEN':credential['token']})
        with urllib.request.urlopen(req,timeout=15) as res:verified=json.load(res)
        if verified.get('id')!=credential['userId'] or verified.get('username')!=credential['username']:raise RuntimeError('Token authenticated identity mismatch')
        if project.get('merge_method')!='ff':api('projects/'+str(pid),'PUT',{'merge_method':'ff'})
        after=api('projects/'+str(pid))
        if after.get('merge_method')!='ff' or after.get('only_allow_merge_if_pipeline_succeeds')!=before['only_allow_merge_if_pipeline_succeeds'] or after.get('only_allow_merge_if_all_discussions_are_resolved')!=before['only_allow_merge_if_all_discussions_are_resolved']:raise RuntimeError('Post-configuration gate verification failed')
        record={'phase':'verified','before':before,'after':{k:after.get(k) for k in before},'tokenId':credential['tokenId'],'userId':credential['userId'],'username':credential['username'],'expiresAt':credential['expiresAt'],'credentialFile':str(token_file)}
        with ledger.open('w') as f:json.dump(record,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
        print(json.dumps({k:record[k] for k in ['phase','tokenId','userId','username','expiresAt','credentialFile']}),flush=True)

if __name__=='__main__':
    try:main()
    except Exception as e:
        # Never include response bodies/headers/token values in operator logs.
        print('Provisioning stopped: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);sys.exit(1)
