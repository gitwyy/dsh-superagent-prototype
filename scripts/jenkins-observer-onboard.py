#!/usr/bin/env python3
"""Private operator caller for reviewed observer Groovy. Dry-run by default.
Admin auth is loaded by the existing trusted helper in memory. New observer token
is returned encrypted RSA-OAEP/AES-GCM and stored owner-only; no plaintext stdout.
No builds, deployments, role plugin installation or personal credential changes.
"""
import argparse
import base64
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def exclusive(path, content):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(content);f.flush();os.fsync(f.fileno())

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--private-dir',required=True);p.add_argument('--inventory',required=True);p.add_argument('--routes',required=True)
    p.add_argument('--apply',action='store_true');p.add_argument('--operation-id',default='observer-20261110-v1')
    args=p.parse_args();root=Path(args.private_dir)
    if not root.is_absolute() or root.resolve()!=root:raise RuntimeError('Canonical absolute private path required')
    root.mkdir(parents=True,mode=0o700,exist_ok=True)
    if root.stat().st_mode & 0o077:raise RuntimeError('Private directory must be0700')
    private_path=root/'onboarding-rsa.pem'
    if private_path.exists():
        if private_path.is_symlink() or private_path.stat().st_mode & 0o077:raise RuntimeError('Unsafe private key path')
        key=serialization.load_pem_private_key(private_path.read_bytes(),password=None)
    else:
        key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
        exclusive(private_path,key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    public=key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
    with open(args.inventory) as f:inventory=json.load(f)
    with open(args.routes) as f:routes=json.load(f)
    jobs=sorted(r['job'] for r in routes)
    if len(jobs)!=20 or len(set(jobs))!=20:raise RuntimeError('Exact20 approved jobs required')
    request={'apply':args.apply,'operationId':args.operation_id,'expectedInventorySha256':inventory['inventorySha256'],
             'observerId':'superagent-v2-observer','jobs':jobs,'expiresDate':'2026-12-10','rsaPublicKeySpki':base64.b64encode(public).decode()}
    path=Path(__file__).resolve().parent.parent/'integrations/jenkins/observer-setup.groovy'
    code=path.read_text();placeholder='__INPUT_JSON_BASE64__'
    if code.count(placeholder)!=1:raise RuntimeError('Unexpected setup script')
    code=code.replace(placeholder,base64.b64encode(json.dumps(request,separators=(',',':')).encode()).decode())
    spec=importlib.util.spec_from_file_location('jenkins_operator','/Code/youke-mate/refactor/mate-pi/scripts/jenkins-tool.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper);helper.load_env()
    origin=os.environ.get('JENKINS_URL',helper.DEFAULT_URL).rstrip('/')
    if origin!='http://192.168.77.179:8080':raise RuntimeError('Operator endpoint changed; review transport first')
    req=urllib.request.Request(origin+'/scriptText',data=urllib.parse.urlencode({'script':code}).encode(),headers={'Authorization':helper.build_auth_header(),'Content-Type':'application/x-www-form-urlencoded'},method='POST')
    with urllib.request.urlopen(req,timeout=60) as response:raw=response.read(2*1024*1024)
    try:result=json.loads(raw)
    except ValueError:
        # Source is nonsecret; fixed class/line diagnostics only, no exception body or script dump.
        raise RuntimeError('Groovy response invalid; compile/runtime diagnostic must be inspected separately') from None
    if result.get('status') not in ('dry_run','complete'):
        print(json.dumps({k:result.get(k) for k in ['status','operationId','stage','reason','automaticReplay']}));raise SystemExit(1)
    metadata={k:result.get(k) for k in ['status','operationId','stage','inventorySha256','requestHash','keyFingerprint','tokenUuid'] if k in result}
    if args.apply:
        envelope=result.get('envelope');expected_fp=hashlib.sha256(public).hexdigest()
        if not envelope or envelope.get('version')!=1 or envelope.get('algorithm')!='RSA-OAEP-256+A256GCM' or envelope.get('operationId')!=args.operation_id or envelope.get('keyFingerprint')!=expected_fp:raise RuntimeError('Encrypted token envelope identity mismatch')
        aad=('nightshift-observer-v1:'+args.operation_id+':'+expected_fp).encode()
        if base64.b64decode(envelope['aad'],validate=True)!=aad:raise RuntimeError('Envelope AAD mismatch')
        aes=key.decrypt(base64.b64decode(envelope['wrappedKey'],validate=True),padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
        secret=json.loads(AESGCM(aes).decrypt(base64.b64decode(envelope['iv'],validate=True),base64.b64decode(envelope['ciphertext'],validate=True),aad))
        if secret.get('username')!='superagent-v2-observer' or secret.get('expiresDate')!='2026-12-10' or secret.get('tokenUuid')!=result.get('tokenUuid'):raise RuntimeError('Decrypted identity mismatch')
        credential={'username':secret['username'],'token':secret['token'],'expiresAt':'2026-12-10T00:00:00Z'}
        dest=root/'observer.json'
        if dest.exists():
            if dest.is_symlink() or dest.stat().st_mode & 0o077 or json.loads(dest.read_text())!=credential:raise RuntimeError('Private credential collision; do not overwrite')
        else:exclusive(dest,json.dumps(credential,indent=2).encode())
        metadata['credentialFile']=str(dest);metadata['plaintextTokenPrinted']=False
    evidence=root/('apply-result.json' if args.apply else 'dry-run-result.json')
    if evidence.exists():
        if evidence.is_symlink():raise RuntimeError('Evidence path changed')
        old=json.loads(evidence.read_text())
        if old!=metadata:raise RuntimeError('Evidence differs; preserve previous operation before rerun')
    else:exclusive(evidence,json.dumps(metadata,indent=2).encode())
    print(json.dumps(metadata))

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('Observer onboarding stopped: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);sys.exit(1)
