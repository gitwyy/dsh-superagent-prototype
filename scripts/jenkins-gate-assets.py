#!/usr/bin/env python3
"""Private operator transfer of fixed gate assets. No job/config changes or build triggers.
New signing key and read tokens are encrypted to Jenkins' operation-scoped RSA key
before transmission. Only public key and names/hashes are printed. Never send a
plaintext credential bundle through scriptText or persist it outside private dirs.
"""
import argparse,base64,hashlib,importlib.util,json,os,secrets,sys,urllib.parse,urllib.request
from pathlib import Path
from cryptography.hazmat.primitives import serialization,hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
ROOT=Path(__file__).resolve().parent.parent
REMOTE='/var/lib/jenkins/superagent-nightshift'

def private_write(path,raw):
 fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=['keygen','install','inspect']);p.add_argument('--private-dir',required=True);p.add_argument('--policy',required=True);p.add_argument('--job-routes',required=True);p.add_argument('--read-credentials',required=True);p.add_argument('--operation-id',default='assets-20261110-v1');a=p.parse_args()
 private=Path(a.private_dir)
 if not private.is_absolute() or private.resolve()!=private:raise RuntimeError('Canonical private directory required')
 private.mkdir(parents=True,mode=0o700,exist_ok=True)
 if private.stat().st_mode & 0o077:raise RuntimeError('Private directory permissions invalid')
 spec=importlib.util.spec_from_file_location('jo','/Code/youke-mate/refactor/mate-pi/scripts/jenkins-tool.py');jo=importlib.util.module_from_spec(spec);spec.loader.exec_module(jo);jo.load_env();origin=os.environ.get('JENKINS_URL',jo.DEFAULT_URL).rstrip('/')
 if origin!='http://192.168.77.179:8080':raise RuntimeError('Operator endpoint drift')
 def call(value):
  script=(ROOT/'integrations/jenkins/install-assets.groovy').read_text()
  if script.count('__INPUT_JSON_BASE64__')!=1:raise RuntimeError('Unexpected installer source')
  encoded=base64.b64encode(json.dumps(value,separators=(',',':')).encode()).decode()
  script=script.replace('__INPUT_JSON_BASE64__',"','".join(encoded[i:i+16000] for i in range(0,len(encoded),16000)))
  req=urllib.request.Request(origin+'/scriptText',data=urllib.parse.urlencode({'script':script}).encode(),headers={'Authorization':jo.build_auth_header(),'Content-Type':'application/x-www-form-urlencoded'},method='POST')
  with urllib.request.urlopen(req,timeout=45) as r:raw=r.read(2*1024*1024)
  try:d=json.loads(raw)
  except ValueError:raise RuntimeError('Installer response malformed; inspect privately, never retry install blindly') from None
  if d.get('status')=='blocked':print(json.dumps(d));raise RuntimeError('Installer refused; reconcile recorded stage')
  return d
 if a.mode in ['keygen','inspect']:
  result=call({'mode':a.mode,'operationId':a.operation_id})
  if a.mode=='keygen':
   dest=private/'server-public-key.json'
   if dest.exists():
    if json.loads(dest.read_text())!=result:raise RuntimeError('Server key changed; no silent replacement')
   else:private_write(dest,json.dumps(result,indent=2).encode())
  print(json.dumps(result));return
 with (private/'server-public-key.json').open() as f:server=json.load(f)
 with open(a.policy) as f:policy=json.load(f)
 with open(a.job_routes) as f:jobs=json.load(f)
 if len(jobs)!=20:raise RuntimeError('Twenty exact job routes required')
 keypath=private/'signing.key'
 if not keypath.exists():private_write(keypath,secrets.token_bytes(32))
 if keypath.is_symlink() or keypath.stat().st_mode & 0o077 or keypath.stat().st_size!=32:raise RuntimeError('Signing key file unsafe')
 signing=keypath.read_bytes()
 routes={'version':1,'keyId':'mate-v2-20261110','gitlabOrigin':'http://gitlab.yk.ykgtxy.com','keyFile':REMOTE+'/signing.key','stateDir':REMOTE+'/replay','projects':{}}
 files=[]
 def add(name,raw):files.append({'relativePath':name,'sha256':hashlib.sha256(raw).hexdigest(),'base64':base64.b64encode(raw).decode(),'mode':'0600'})
 for alias,r in policy['repositories'].items():
  if not r['mergeTriggersDeploy']:continue
  pid=r['projectId'];mapped=[j for j in jobs if j['scm']=='http://gitlab.yk.ykgtxy.com/'+r['projectPath']+'.git']
  if not mapped:raise RuntimeError('Missing exact app jobs')
  targets={}
  for j in mapped:
   t=j['target']
   if alias in ['mate-manage-web','mate-customer-wechat']:
    ns='mate-frontend';deployment=alias;container='manage-web' if alias=='mate-manage-web' else 'customer-wechat'
   else:ns=t['DEPLOY_NS'];deployment=t['DEPLOY_DEP'];container=t['DEPLOY_CONTAINER']
   if not all([ns,deployment,container]):raise RuntimeError('Incomplete target mapping')
   targets[j['job']]={'destinationId':'mate-v2-test-'+str(pid),'namespace':ns,'deployment':deployment,'container':container}
  routes['projects'][str(pid)]={'botUserId':r['expectedUserId'],'path':r['projectPath'],'readCredentialFile':REMOTE+'/read-credentials/'+str(pid)+'.json','jobs':targets}
  credentialPath=Path(a.read_credentials)/(str(pid)+'.json')
  if credentialPath.is_symlink() or credentialPath.stat().st_mode & 0o077:raise RuntimeError('Unsafe metadata credential file')
  credential=json.loads(credentialPath.read_text())
  if credential.get('projectId')!=pid:raise RuntimeError('Read credential project mismatch')
  add('read-credentials/'+str(pid)+'.json',json.dumps(credential,separators=(',',':')).encode())
 if len(routes['projects'])!=15:raise RuntimeError('Exactly15 app routes required')
 add('routes.json',json.dumps(routes,sort_keys=True,separators=(',',':')).encode());add('signing.key',signing)
 for name in ['publisher-hook.py','nightshift-gate.py']:add('assets/'+name,(ROOT/'integrations/jenkins'/name).read_bytes())
 payload=json.dumps({'files':files},separators=(',',':')).encode();rawpub=base64.b64decode(server['rsaPublicKeySpki'],validate=True)
 fingerprint=hashlib.sha256(rawpub).hexdigest()
 if fingerprint!=server['keyFingerprint']:raise RuntimeError('Server key fingerprint mismatch')
 public=serialization.load_der_public_key(rawpub);aes=secrets.token_bytes(32);iv=secrets.token_bytes(12);aad=('nightshift-assets-v1:'+a.operation_id+':'+fingerprint).encode()
 enc={'version':1,'algorithm':'RSA-OAEP-256+A256GCM','operationId':a.operation_id,'keyFingerprint':fingerprint,'wrappedKey':base64.b64encode(public.encrypt(aes,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))).decode(),'iv':base64.b64encode(iv).decode(),'ciphertext':base64.b64encode(AESGCM(aes).encrypt(iv,payload,aad)).decode(),'aad':base64.b64encode(aad).decode()}
 envelopePath=private/'asset-envelope.json'
 # Keep ciphertext for response-loss reconciliation; never regenerate a new install after unknown.
 if envelopePath.exists():raise RuntimeError('Install envelope already exists; inspect server receipt before any replay')
 private_write(envelopePath,json.dumps(enc,separators=(',',':')).encode())
 private_write(private/'asset-manifest.json',json.dumps({'operationId':a.operation_id,'files':[{k:v for k,v in x.items() if k!='base64'} for x in files],'routes':routes},indent=2).encode())
 result=call({'mode':'install','operationId':a.operation_id,'envelope':enc})
 private_write(private/'install-result.json',json.dumps(result,indent=2).encode());print(json.dumps(result))
if __name__=='__main__':
 try:main()
 except Exception as e:print('Asset onboarding stopped: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);sys.exit(1)
