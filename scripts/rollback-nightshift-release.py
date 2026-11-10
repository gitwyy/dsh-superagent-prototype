#!/usr/bin/env python3
"""Plan targeted rollback of this phase's project identities/merge settings.
Default is read-only. --apply requires explicit --release-disabled acknowledgment;
operator must first stop/reconcile all active/unknown release operations. Does not
restore whole projects, modify branch protection, reset credentials or retry writes.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

HOST='gitlab.yk.ykgtxy.com'
NAME='superagent-v2-release-20261110'

def api(path,method='GET',body=None):
    args=['/opt/homebrew/bin/glab','api','--hostname',HOST,'--method',method,'http://'+HOST+'/api/v4/'+path]
    if body is not None:args+=['--header','Content-Type: application/json','--input','-']
    result=subprocess.run(args,input=json.dumps(body) if body is not None else None,capture_output=True,text=True,timeout=25)
    if result.returncode:raise RuntimeError('Rollback request failed (%s %s); stop and reconcile without retry'%(method,path))
    return json.loads(result.stdout) if result.stdout.strip() else None

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',required=True)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--release-disabled',action='store_true')
    parser.add_argument('--revoke-project-tokens',action='store_true')
    parser.add_argument('--restore-merge-method',action='store_true')
    args=parser.parse_args()
    if args.apply and (not args.release_disabled or not (args.revoke_project_tokens or args.restore_merge_method)):
        raise RuntimeError('Explicit disabled-and-reconciled release acknowledgment plus exact rollback action required')
    root=Path(args.directory)
    if not root.is_absolute() or root.resolve()!=root:raise RuntimeError('Canonical operator receipt directory required')
    owner=api('user')
    if owner.get('id')!=35 or owner.get('username')!='wangyangyang':raise RuntimeError('Provisioning owner mismatch')
    for path in sorted(root.glob('*.provision.json')):
        with path.open() as f:receipt=json.load(f)
        if receipt.get('phase')!='verified':raise RuntimeError('Incomplete provisioning receipt; manual reconciliation required')
        before=receipt['before'];pid=before['id']
        project=api('projects/'+str(pid));token=api('projects/%s/access_tokens/%s'%(pid,receipt['tokenId']))
        if project.get('path_with_namespace')!=before['path_with_namespace'] or not project['path_with_namespace'].startswith('payment/refactor/'):
            raise RuntimeError('Project mapping drift')
        if token.get('id')!=receipt['tokenId'] or token.get('user_id')!=receipt['userId'] or token.get('name')!=NAME:
            raise RuntimeError('Token identity drift; never revoke a different token')
        if args.restore_merge_method and project.get('merge_method')!='ff':raise RuntimeError('Merge method changed since provisioning; do not overwrite')
        plan={'projectId':pid,'project':project['path_with_namespace'],'tokenId':token['id'],'tokenAlreadyRevoked':token.get('revoked') is True,
              'revoke':args.revoke_project_tokens,'mergeMethod':{'current':project['merge_method'],'restore':before['merge_method']} if args.restore_merge_method else None,'apply':args.apply}
        print(json.dumps(plan),flush=True)
        if not args.apply:continue
        if args.revoke_project_tokens and not token.get('revoked'):
            api('projects/%s/access_tokens/%s'%(pid,token['id']),'DELETE')
            check=api('projects/%s/access_tokens/%s'%(pid,token['id']))
            if check.get('revoked') is not True:raise RuntimeError('Revocation readback not verified')
        if args.restore_merge_method:
            api('projects/'+str(pid),'PUT',{'merge_method':before['merge_method']})
            check=api('projects/'+str(pid))
            if check.get('merge_method')!=before['merge_method']:raise RuntimeError('Merge-method rollback readback failed')

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('Rollback stopped: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);sys.exit(1)
