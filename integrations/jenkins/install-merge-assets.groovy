// Install a NEW public gate version only; no credentials, job edits, triggers or existing-asset overwrite.
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import jenkins.model.Jenkins
import java.nio.file.*
import java.nio.file.attribute.PosixFilePermissions
import java.nio.channels.FileChannel
import java.security.MessageDigest

def stage='input'
try {
  def j=Jenkins.get();j.checkPermission(Jenkins.ADMINISTER)
  String encoded=['__INPUT_JSON_BASE64__'].join('')
  if(encoded.length()>300000)throw new IllegalStateException('input')
  def input=new JsonSlurper().parseText(new String(encoded.decodeBase64(),'UTF-8'))
  def require={boolean ok->if(!ok)throw new IllegalStateException('precondition')}
  def exact={v,keys->v instanceof Map && v.keySet()==keys as Set}
  def digest={byte[] b->MessageDigest.getInstance('SHA-256').digest(b).encodeHex().toString()}
  require(exact(input,['apply','files']) && input.apply instanceof Boolean && input.files instanceof List && input.files.size()==2)
  final Path root=Paths.get('/var/lib/jenkins/superagent-nightshift/assets')
  final Path destination=root.resolve('merge-v2')
  final Set names=['publisher-hook.py','nightshift-gate.py'] as Set
  final Set perms=PosixFilePermissions.fromString('rw-------')
  final Set dirPerms=PosixFilePermissions.fromString('rwx------')
  def owner=Files.getOwner(j.rootDir.toPath(),LinkOption.NOFOLLOW_LINKS)
  Path cursor=root
  while(cursor!=null) {
    require(!Files.isSymbolicLink(cursor) && Files.isDirectory(cursor,LinkOption.NOFOLLOW_LINKS) && cursor.toRealPath()==cursor)
    def mode=Files.getPosixFilePermissions(cursor,LinkOption.NOFOLLOW_LINKS)
    require(!mode.contains(java.nio.file.attribute.PosixFilePermission.GROUP_WRITE) && !mode.contains(java.nio.file.attribute.PosixFilePermission.OTHERS_WRITE))
    cursor=cursor.parent
  }
  require(Files.getOwner(root)==owner && Files.getPosixFilePermissions(root)==dirPerms)
  Map decoded=[:];List manifest=[]
  input.files.each {row->
    require(exact(row,['name','sha256','base64']) && names.contains(row.name) && !decoded.containsKey(row.name))
    require(row.sha256 instanceof String && row.sha256==~ /[0-9a-f]{64}/ && row.base64 instanceof String && row.base64.length()<140000 && row.base64==~ /[A-Za-z0-9+\/=]+/)
    byte[] bytes=row.base64.decodeBase64();require(bytes.length>100 && bytes.length<=100000 && digest(bytes)==row.sha256)
    def text=java.nio.charset.StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
    require(text.startsWith('#!/usr/bin/env python3') && !text.contains('\u0000'))
    decoded[row.name]=bytes;manifest<<[name:row.name,sha256:row.sha256,size:bytes.length]
  }
  require(decoded.keySet()==names);manifest.sort{it.name}
  def verify={->
    require(Files.isDirectory(destination,LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(destination) && destination.toRealPath()==destination && Files.getOwner(destination)==owner && Files.getPosixFilePermissions(destination)==dirPerms)
    def stream=Files.list(destination);Set installed=[] as Set
    try {stream.iterator().each{p->installed.add(p.fileName.toString())}} finally {stream.close()}
    require(installed==(names+['complete.json','intent.json'] as Set))
    manifest.each{row->def p=destination.resolve(row.name);require(Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(p) && Files.getOwner(p)==owner && Files.getPosixFilePermissions(p)==perms && Files.getAttribute(p,'unix:nlink')==1 && digest(Files.readAllBytes(p))==row.sha256)}
    byte[] expectedReceipt=JsonOutput.toJson([version:2,files:manifest]).getBytes('UTF-8')
    ['intent.json','complete.json'].each{name->
      def p=destination.resolve(name)
      require(Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(p) && Files.getOwner(p)==owner && Files.getPosixFilePermissions(p)==perms && Files.getAttribute(p,'unix:nlink')==1 && Files.size(p)==expectedReceipt.length)
      FileChannel.open(p,[StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS] as Set).withCloseable{channel->
        def buffer=java.nio.ByteBuffer.allocate(expectedReceipt.length+1)
        while(buffer.hasRemaining() && channel.read(buffer)>=0){}
        require(buffer.position()==expectedReceipt.length && Arrays.equals(Arrays.copyOf(buffer.array(),buffer.position()),expectedReceipt))
      }
    }
  }
  def syncDir={Path p->FileChannel.open(p,StandardOpenOption.READ).withCloseable{it.force(true)}}
  def writeNew={Path p,byte[] bytes->Files.newByteChannel(p,[StandardOpenOption.WRITE,StandardOpenOption.CREATE_NEW] as Set,PosixFilePermissions.asFileAttribute(perms)).withCloseable{channel->def buf=java.nio.ByteBuffer.wrap(bytes);while(buf.hasRemaining())channel.write(buf);((FileChannel)channel).force(true)};require(Files.getOwner(p)==owner);syncDir(p.parent)}
  stage='preflight'
  if(Files.exists(destination,LinkOption.NOFOLLOW_LINKS)) {verify();println(JsonOutput.toJson([status:'verified',alreadyInstalled:true,files:manifest]));return null}
  if(!input.apply){println(JsonOutput.toJson([status:'dry_run',target:destination.toString(),files:manifest,overwrites:false]));return null}
  stage='intent';Files.createDirectory(destination,PosixFilePermissions.asFileAttribute(dirPerms));syncDir(root)
  byte[] receipt=JsonOutput.toJson([version:2,files:manifest]).getBytes('UTF-8')
  writeNew(destination.resolve('intent.json'),receipt)
  stage='assets';manifest.each{row->writeNew(destination.resolve(row.name),(byte[])decoded[row.name])}
  stage='complete';writeNew(destination.resolve('complete.json'),receipt);verify()
  println(JsonOutput.toJson([status:'installed',target:destination.toString(),files:manifest,overwrites:false]))
} catch(Throwable ignored) {println(JsonOutput.toJson([status:'blocked',stage:stage,reason:'merge_assets_precondition_or_partial_install']))}
return null
