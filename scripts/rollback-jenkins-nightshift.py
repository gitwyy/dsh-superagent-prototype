#!/usr/bin/env python3
"""Targeted configuration rollback of one fully verified publisher update operation.
Default dry-run. Does not change observer ACLs, revoke credentials, remove private
gate files, trigger builds or blanket restore a job modified by another operator.
"""
import argparse,copy,hashlib,importlib.util,json,os,sys,urllib.request,urllib.parse,xml.etree.ElementTree as ET
from pathlib import Path
from html.parser import HTMLParser

def sha(x):return hashlib.sha256(x if isinstance(x,bytes) else x.encode()).hexdigest()
def semantic(e):return(e.tag,tuple(sorted(e.attrib.items())),e.text if e.text and e.text.strip() else '',tuple(semantic(x) for x in e))
class Form(HTMLParser):
 def __init__(self):super().__init__(convert_charrefs=True);self.inputs={};self.content='';self.on=False
 def handle_starttag(self,t,a):
  a=dict(a)
  if t=='input':self.inputs.setdefault(a.get('name',''),[]).append(a.get('value',''))
  if t=='textarea' and a.get('name')=='config.content':self.on=True
 def handle_endtag(self,t):
  if t=='textarea':self.on=False
 def handle_data(self,x):
  if self.on:self.content+=x

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--backup',required=True);p.add_argument('--actor-source',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--release-disabled',action='store_true');a=p.parse_args()
 b=Path(a.backup)
 if not b.is_absolute() or b.resolve()!=b:raise RuntimeError('Canonical backup required')
 if a.apply and not a.release_disabled:raise RuntimeError('Stop/reconcile release service before applying rollback')
 plan=json.loads((b/'plan.json').read_text());actor=Path(a.actor_source).read_text()
 if sha(actor)!=plan['actorHash'] or len(plan['changes'])!=24:raise RuntimeError('Backup operation mismatch')
 for i in range(24):
  if not (b/('%02d-verified.json'%i)).is_file():raise RuntimeError('Incomplete operation needs explicit reconciliation')
 spec=importlib.util.spec_from_file_location('jo','/Code/youke-mate/refactor/mate-pi/scripts/jenkins-tool.py');jo=importlib.util.module_from_spec(spec);spec.loader.exec_module(jo);jo.load_env();origin=os.environ.get('JENKINS_URL',jo.DEFAULT_URL).rstrip('/')
 if origin!='http://192.168.77.179:8080':raise RuntimeError('Operator origin changed')
 auth=jo.build_auth_header()
 def get(path):
  with urllib.request.urlopen(urllib.request.Request(origin+path,headers={'Authorization':auth}),timeout=20) as r:return r.read(2*1024*1024)
 def post(path,data,ct):
  req=urllib.request.Request(origin+path,data=data,headers={'Authorization':auth,'Content-Type':ct},method='POST')
  with urllib.request.urlopen(req,timeout=25) as r:return r.read(2*1024*1024)
 jobs={c['name'] for c in plan['changes'] if c['kind']=='job'}
 queue=json.loads(get('/queue/api/json?tree=items[task[name]]'))
 if any(x.get('task',{}).get('name') in jobs for x in queue.get('items',[])):raise RuntimeError('Target jobs queued')
 prepared=[]
 for i,c in enumerate(plan['changes']):
  raw=(b/('%02d-%s-before'%(i,c['name']))).read_bytes()
  if sha(raw)!=c['beforeHash']:raise RuntimeError('Backup hash mismatch')
  if c['kind']=='job':
   path='/job/'+urllib.parse.quote(c['name'],safe='')+'/config.xml';current=get(path);expected=ET.fromstring(raw)
   expected.find('.//secureGroovyScript/script').text=actor
   vs=expected.find('.//org.jenkinsci.plugins.gwt.GenericTrigger/genericVariables');v=ET.SubElement(vs,'org.jenkinsci.plugins.gwt.GenericVariable');ET.SubElement(v,'key').text='EVENT_ACTOR';ET.SubElement(v,'value').text='$.user_id'
   if semantic(ET.fromstring(current))!=semantic(expected):raise RuntimeError('Job differs from owned change; do not overwrite')
   state=json.loads(get('/job/'+urllib.parse.quote(c['name'],safe='')+'/api/json?tree=lastBuild[building]'))
   if state.get('lastBuild',{}).get('building'):raise RuntimeError('Target job running')
   prepared.append((c,path,current,raw))
  elif c['kind']=='managed':
   path='/configfiles/editConfig?id='+urllib.parse.quote(c['name']);form=Form();form.feed(get(path).decode())
   if sha(form.content)!=c['afterHash']:raise RuntimeError('Managed source differs; do not overwrite')
   prepared.append((c,path,form,raw))
  else:raise RuntimeError('Unknown backup kind')
 print(json.dumps({'apply':a.apply,'ownedJobChanges':20,'ownedManagedChanges':4,'buildsTriggered':False}),flush=True)
 if not a.apply:return
 # Restore publisher content first; extra actor field can remain until source parser is restored.
 for c,path,current,raw in reversed(prepared):
  if c['kind']=='managed':
   fresh=Form();fresh.feed(get(path).decode())
   if sha(fresh.content)!=c['afterHash']:raise RuntimeError('Managed changed at rollback boundary')
   val=lambda name:fresh.inputs.get(name,[''])[0]
   config={'stapler-class':'org.jenkinsci.plugins.configfiles.custom.CustomConfig','id':c['name'],'name':val('config.name'),'comment':val('config.comment'),'content':raw.decode(),'providerId':'org.jenkinsci.plugins.configfiles.custom.CustomConfig$CustomConfigProvider','customizedCredentialMappings':[]}
   post('/configfiles/saveConfig',urllib.parse.urlencode({'json':json.dumps({'config':config})}).encode(),'application/x-www-form-urlencoded')
   verify=Form();verify.feed(get(path).decode())
   if sha(verify.content)!=c['beforeHash']:raise RuntimeError('Managed rollback readback failed')
  else:
   if semantic(ET.fromstring(get(path)))!=semantic(ET.fromstring(current)):raise RuntimeError('Job changed at rollback boundary')
   post(path,raw,'application/xml; charset=UTF-8')
   if semantic(ET.fromstring(get(path)))!=semantic(ET.fromstring(raw)):raise RuntimeError('Job rollback readback failed')
 print(json.dumps({'rolledBack':True,'observerACLsPreserved':True,'privateGateAssetsPreserved':True,'buildsTriggered':False}))
if __name__=='__main__':
 try:main()
 except Exception as e:print('Rollback stopped: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);sys.exit(1)
