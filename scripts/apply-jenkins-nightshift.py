#!/usr/bin/env python3
"""Narrow reviewed Jenkins job/Managed update. Default plan; --apply changes configuration only.
Preserves all unrelated XML/provider fields, compares exact before hashes, refuses
active/queued target jobs and records private rollback copies. Never triggers builds.
"""
import argparse,base64,copy,hashlib,importlib.util,json,os,sys,urllib.request,urllib.parse,xml.etree.ElementTree as ET
from pathlib import Path
from html.parser import HTMLParser
SRC=Path(__file__).resolve().parent.parent
SOURCE_HASH='6afa3d6e9ba744d19effc3deac11e9d566a1ceb24ae62e50b08ee57eccd58835'
MANAGED={'mate-java-release-run':'mate-java-release.sh','mate-java-release-runtime':'mate-java-release.py','mate-web-build-push':'mate-web-build-push.sh','mate-web-rancher-deploy':'mate-web-deploy.py'}
def sha(value):return hashlib.sha256(value if isinstance(value,bytes) else value.encode()).hexdigest()
def semantic(element):
 # Jenkins reindents XML during save. Ignore only formatting-only whitespace, never actual script/property values.
 return (element.tag,tuple(sorted(element.attrib.items())),element.text if element.text and element.text.strip() else '',tuple(semantic(x) for x in element))
def save(path,raw):
 fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
class Form(HTMLParser):
 def __init__(self):super().__init__(convert_charrefs=True);self.inputs={};self.text={};self.current=None
 def handle_starttag(self,t,attrs):
  a=dict(attrs)
  if t=='input':self.inputs.setdefault(a.get('name',''),[]).append(a.get('value',''))
  if t=='textarea':self.current=a.get('name','');self.text[self.current]=''
 def handle_endtag(self,t):
  if t=='textarea':self.current=None
 def handle_data(self,v):
  if self.current is not None:self.text[self.current]+=v

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',required=True);p.add_argument('--prepared',required=True);p.add_argument('--job-routes',required=True);p.add_argument('--backup',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--resume',action='store_true',help='Resume only exact verified steps; unknown dispatched steps still stop');a=p.parse_args()
 source=Path(a.source);prepared=Path(a.prepared);backup=Path(a.backup)
 for x in [source,prepared,backup]:
  if not x.is_absolute() or x.resolve()!=x:raise RuntimeError('Canonical absolute paths required')
 manifest=json.loads((prepared/'patch-manifest.json').read_text());inputs={x['id']:x for x in json.loads((source/'manifest.json').read_text())}
 outputs={x['file']:x for x in manifest['outputs']}
 for file in MANAGED.values():
  if sha((prepared/file).read_bytes())!=outputs[file]['sha256']:raise RuntimeError('Prepared publisher changed')
 actor=(SRC/'integrations/jenkins/source-actor.groovy').read_text();actor_hash=sha(actor)
 jobs=json.loads(Path(a.job_routes).read_text())
 if len(jobs)!=20 or len({j['job'] for j in jobs})!=20:raise RuntimeError('Exact20 job scope required')
 spec=importlib.util.spec_from_file_location('jo','/Code/youke-mate/refactor/mate-pi/scripts/jenkins-tool.py');jo=importlib.util.module_from_spec(spec);spec.loader.exec_module(jo);jo.load_env();origin=os.environ.get('JENKINS_URL',jo.DEFAULT_URL).rstrip('/')
 if origin!='http://192.168.77.179:8080':raise RuntimeError('Operator endpoint drift')
 auth=jo.build_auth_header()
 def get(path):
  with urllib.request.urlopen(urllib.request.Request(origin+path,headers={'Authorization':auth}),timeout=20) as r:return r.read(2*1024*1024)
 def post(path,data,content_type):
  req=urllib.request.Request(origin+path,data=data,headers={'Authorization':auth,'Content-Type':content_type},method='POST')
  with urllib.request.urlopen(req,timeout=30) as r:return r.read(2*1024*1024)
 def idle():
  queue=json.loads(get('/queue/api/json?tree=items[task[name]]'))
  names={x['job'] for x in jobs}
  if any(x.get('task',{}).get('name') in names for x in queue.get('items',[])):raise RuntimeError('Target job queued; no configuration change')
  for j in jobs:
   d=json.loads(get('/job/'+urllib.parse.quote(j['job'],safe='')+'/api/json?tree=lastBuild[building],builds[building]{0,5}'))
   if d.get('lastBuild',{}).get('building') or any(b.get('building') for b in d.get('builds',[])):raise RuntimeError('Target job building; no configuration change')
 idle()
 changes=[]
 for index,j in enumerate(jobs):
  live=get('/job/'+urllib.parse.quote(j['job'],safe='')+'/config.xml')
  raw=(backup/('%02d-%s-before'%(index,j['job']))).read_bytes() if a.resume else live
  if sha(raw)!=j['sha256']:raise RuntimeError('Job changed since reviewed snapshot: '+j['job'])
  root=ET.fromstring(raw);before=ET.tostring(root)
  nodes=root.findall('.//secureGroovyScript/script');triggers=root.findall('.//org.jenkinsci.plugins.gwt.GenericTrigger')
  if len(nodes)!=1 or len(triggers)!=1 or sha(nodes[0].text or '')!=SOURCE_HASH:raise RuntimeError('Trusted parser/trigger changed')
  variables=triggers[0].find('genericVariables')
  if variables is None or any(v.findtext('key')=='EVENT_ACTOR' for v in variables):raise RuntimeError('Actor extraction already present/ambiguous')
  new=ET.SubElement(variables,'org.jenkinsci.plugins.gwt.GenericVariable');ET.SubElement(new,'key').text='EVENT_ACTOR';ET.SubElement(new,'value').text='$.user_id'
  nodes[0].text=actor
  updated=ET.tostring(root,encoding='utf-8',xml_declaration=True)
  proof=copy.deepcopy(root);proof.find('.//secureGroovyScript/script').text=ET.fromstring(raw).find('.//secureGroovyScript/script').text
  pv=proof.find('.//org.jenkinsci.plugins.gwt.GenericTrigger/genericVariables');pv.remove(next(x for x in pv if x.findtext('key')=='EVENT_ACTOR'))
  if ET.tostring(proof)!=before:raise RuntimeError('Unexpected XML semantic change')
  verified=a.resume and (backup/('%02d-verified.json'%index)).is_file()
  if verified:
   if semantic(ET.fromstring(live))!=semantic(ET.fromstring(updated)):raise RuntimeError('Previously verified job drifted')
  elif sha(live)!=sha(raw) or (a.resume and (backup/('%02d-dispatching.json'%index)).exists()):raise RuntimeError('Unverified dispatched job requires reconciliation')
  changes.append({'kind':'job','name':j['job'],'before':raw,'after':updated,'beforeHash':sha(raw),'afterHash':sha(updated),'verified':bool(verified)})
 for fid,file in MANAGED.items():
  form=Form();form.feed(get('/configfiles/editConfig?id='+urllib.parse.quote(fid)).decode())
  content=form.text.get('config.content');classes=form.inputs.get('stapler-class',[])
  if not content or sha(content)!=inputs[fid]['sha256'] or 'org.jenkinsci.plugins.configfiles.custom.CustomConfig' not in classes:raise RuntimeError('Managed input drift: '+fid)
  # These exact files must not have credential mappings; preserve their public identity fields.
  if any('credential' in key.lower() and any(values) for key,values in form.inputs.items()):raise RuntimeError('Credential mappings require explicit preservation review')
  one=lambda key: form.inputs.get(key,[None])[0]
  config={'stapler-class':'org.jenkinsci.plugins.configfiles.custom.CustomConfig','id':fid,'name':one('config.name') or one('_.name') or fid,'comment':one('config.comment') or one('_.comment') or '', 'content':(prepared/file).read_text(),'providerId':'org.jenkinsci.plugins.configfiles.custom.CustomConfig$CustomConfigProvider','customizedCredentialMappings':[]}
  changes.append({'kind':'managed','name':fid,'before':content.encode(),'after':config['content'].encode(),'beforeHash':sha(content),'afterHash':sha(config['content']),'config':config})
 print(json.dumps({'apply':a.apply,'jobs':20,'managed':4,'actorSha256':actor_hash,'changes':[{'kind':c['kind'],'name':c['name'],'beforeHash':c['beforeHash'],'afterHash':c['afterHash']} for c in changes]}),flush=True)
 if not a.apply:return
 if not a.resume:
  if backup.exists():raise RuntimeError('Backup operation already exists; reconcile, do not blindly reapply')
  backup.mkdir(mode=0o700,parents=True)
  for i,c in enumerate(changes):save(backup/('%02d-%s-before'%(i,c['name'])),c['before'])
  save(backup/'plan.json',json.dumps({'actorHash':actor_hash,'changes':[{k:v for k,v in c.items() if k not in ['before','after','config']} for c in changes]},indent=2).encode())
 else:
  prior=json.loads((backup/'plan.json').read_text())
  if prior['actorHash']!=actor_hash:raise RuntimeError('Operation source changed')
  for i,c in enumerate(changes):
   if any(prior['changes'][i].get(k)!=c[k] for k in ['kind','name','beforeHash','afterHash']):raise RuntimeError('Operation plan changed')
 # Approve ONLY the administrator-reviewed source body, never a global signature or all pending scripts.
 approve="import groovy.json.JsonOutput;import jenkins.model.Jenkins;import org.jenkinsci.plugins.scriptsecurity.scripts.ScriptApproval;import org.jenkinsci.plugins.scriptsecurity.scripts.languages.GroovyLanguage;def j=Jenkins.get();j.checkPermission(Jenkins.ADMINISTER);def s=new String('"+base64.b64encode(actor.encode()).decode()+"'.decodeBase64(),'UTF-8');def a=ScriptApproval.get();a.preapprove(s,GroovyLanguage.get());a.save();println(JsonOutput.toJson([approved:a.isScriptApproved(s,GroovyLanguage.get())]));return null"
 res=json.loads(post('/scriptText',urllib.parse.urlencode({'script':approve}).encode(),'application/x-www-form-urlencoded'))
 if res.get('approved') is not True:raise RuntimeError('Exact script approval failed')
 for i,c in enumerate(changes):
  if c.get('verified'):continue
  idle();save(backup/('%02d-dispatching.json'%i),json.dumps({'kind':c['kind'],'name':c['name']}).encode())
  if c['kind']=='job':
   path='/job/'+urllib.parse.quote(c['name'],safe='')+'/config.xml'
   if sha(get(path))!=c['beforeHash']:raise RuntimeError('Job drift at write boundary')
   post(path,c['after'],'application/xml; charset=UTF-8')
   current=ET.fromstring(get(path));expected=ET.fromstring(c['after'])
   if semantic(current)!=semantic(expected):raise RuntimeError('Post-update job differs; stop and reconcile')
  else:
   path='/configfiles/editConfig?id='+urllib.parse.quote(c['name']);f=Form();f.feed(get(path).decode())
   if sha(f.text.get('config.content',''))!=c['beforeHash']:raise RuntimeError('Managed drift at write boundary')
   post('/configfiles/saveConfig',urllib.parse.urlencode({'json':json.dumps({'config':c['config']})}).encode(),'application/x-www-form-urlencoded')
   f=Form();f.feed(get(path).decode())
   if sha(f.text.get('config.content',''))!=c['afterHash']:raise RuntimeError('Managed post-update verification failed')
  save(backup/('%02d-verified.json'%i),json.dumps({'kind':c['kind'],'name':c['name'],'afterHash':c['afterHash']}).encode())
 print(json.dumps({'configured':True,'jobs':20,'managed':4,'buildsTriggered':False,'backup':str(backup)}))
if __name__=='__main__':
 try:main()
 except Exception as e:print('Configuration stopped: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);sys.exit(1)
