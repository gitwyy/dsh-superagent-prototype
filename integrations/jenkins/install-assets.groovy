// OFFLINE-AUTHORED fixed-root installer; no builds/job config/API requests.
// Administrative transport authenticates the caller. RSA encryption protects secret delivery,
// not caller identity. Only public metadata is returned; NEVER print input/decrypted errors.
// keygen is an EXPLICIT write mode. inspect is read-only. Partial state is NEVER resumed.
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import jenkins.model.Jenkins
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.nio.channels.FileChannel
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.KeyPairGenerator
import java.security.KeyFactory
import java.security.SecureRandom
import java.security.interfaces.RSAPrivateCrtKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.security.spec.RSAPublicKeySpec
import java.security.spec.RSAKeyGenParameterSpec
import java.security.spec.MGF1ParameterSpec
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

String stage='input'
String operation=null
try {
  // Caller splits public outer base64 into <=16000-character literals to avoid JVM
  // constant-pool UTF8's 65535-byte limit: replace marker with chunks.join("','").
  final String encodedInput=['__INPUT_JSON_BASE64__'].join('')
  final int MAX_OUTER=1048576
  final int MAX_PLAIN=786432
  final int MAX_FILE=262144
  final int MAX_TOTAL_FILES=524288
  final List PROJECT_IDS=['438','441','442','443','445','452','453','454','456','457','458','459','461','462','463']
  final Map BOT_IDS=['441':97,'452':98,'445':99,'453':100,'454':101,'456':102,'442':103,
      '443':104,'457':105,'458':106,'459':107,'461':108,'463':109,'462':110,'438':111]
  final Map REPOSITORIES=['441':'mate-trade','452':'mate-pay-channel','445':'mate-account','453':'mate-settle',
      '454':'mate-recon','456':'mate-customer','442':'mate-agent','443':'mate-terminal','457':'mate-manage',
      '458':'mate-policy','459':'mate-data-center','461':'mate-gateway','463':'mate-manage-web',
      '462':'mate-customer-wechat','438':'mate-three-server']
  final String ROOT='/var/lib/jenkins/superagent-nightshift'
  final List DIRECTORIES=['assets','read-credentials','prepared','replay']
  final List FILES=(['assets/publisher-hook.py','assets/nightshift-gate.py','routes.json','signing.key']+
      PROJECT_IDS.collect { 'read-credentials/'+it+'.json' }).sort()
  def require={ boolean ok -> if(!ok) throw new IllegalStateException('precondition') }
  def b64decode={ Object text, int cap ->
    require(text instanceof String && text.length() <= ((cap+2).intdiv(3))*4 &&
        text ==~ /(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?/)
    byte[] raw=Base64.decoder.decode((String)text)
    require(raw.length<=cap && Base64.encoder.encodeToString(raw)==text)
    raw
  }
  def digest={ byte[] raw -> MessageDigest.getInstance('SHA-256').digest(raw).encodeHex().toString() }
  def parseJson={ byte[] raw, int cap ->
    require(raw.length<=cap)
    // CharsetDecoder REPORT rejects malformed UTF-8 rather than silently replacing bytes.
    String text=java.nio.charset.StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(raw)).toString()
    new JsonSlurper().parseText(text)
  }
  def exactKeys={ Object value, List names -> value instanceof Map && value.keySet()==(names as Set) }
  def input=parseJson(b64decode(encodedInput,MAX_OUTER),MAX_OUTER)
  require(input instanceof Map && input.mode in ['keygen','install','inspect'])
  require(exactKeys(input,input.mode=='install' ? ['mode','operationId','envelope'] : ['mode','operationId']))
  require(input.operationId instanceof String && input.operationId ==~ /[A-Za-z0-9][A-Za-z0-9_-]{7,79}/)
  operation=input.operationId
  String mode=input.mode
  def j=Jenkins.get()
  j.checkPermission(Jenkins.ADMINISTER)
  Path home=j.getRootDir().toPath().toAbsolutePath().normalize()
  require(home.toString()=='/var/lib/jenkins' && j.getRootDir().canonicalPath==home.toString())
  def owner=Files.getOwner(home,LinkOption.NOFOLLOW_LINKS)
  require(owner.name==System.getProperty('user.name'))
  def noSymlinks={ Path path ->
    Path p=path.root
    path.each { c ->
      p=p.resolve(c)
      require(!Files.isSymbolicLink(p))
      if(Files.exists(p,LinkOption.NOFOLLOW_LINKS)) {
        def uid=Files.getOwner(p,LinkOption.NOFOLLOW_LINKS).name
        require(uid in ['root',owner.name])
        Set perms=Files.getPosixFilePermissions(p,LinkOption.NOFOLLOW_LINKS)
        require(!perms.contains(java.nio.file.attribute.PosixFilePermission.GROUP_WRITE) &&
            !perms.contains(java.nio.file.attribute.PosixFilePermission.OTHERS_WRITE))
      }
    }
  }
  noSymlinks(home)
  def checkPrivate={ Path p, boolean dir ->
    noSymlinks(p)
    require(dir ? Files.isDirectory(p,LinkOption.NOFOLLOW_LINKS) : Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS))
    require(Files.getOwner(p,LinkOption.NOFOLLOW_LINKS)==owner)
    require(Files.getPosixFilePermissions(p,LinkOption.NOFOLLOW_LINKS)==PosixFilePermissions.fromString(dir?'rwx------':'rw-------'))
    if(!dir) require((Files.getAttribute(p,'unix:nlink',LinkOption.NOFOLLOW_LINKS) as Number).longValue()==1L)
  }
  def forceDir={ Path p -> def c=FileChannel.open(p,StandardOpenOption.READ); try { c.force(true) } finally { c.close() } }
  def mkdirNew={ Path p ->
    noSymlinks(p.parent)
    Files.createDirectory(p,PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString('rwx------')))
    checkPrivate(p,true); forceDir(p.parent)
  }
  def writeNew={ Path p, byte[] bytes ->
    checkPrivate(p.parent,true)
    def c=FileChannel.open(p,[StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE] as Set,
        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString('rw-------')))
    try { ByteBuffer b=ByteBuffer.wrap(bytes); while(b.hasRemaining()) c.write(b); c.force(true) }
    finally { c.close() }
    checkPrivate(p,false); forceDir(p.parent)
  }
  def readPrivate={ Path p, int cap ->
    checkPrivate(p,false); require(Files.size(p)<=cap)
    def before=Files.readAttributes(p,java.nio.file.attribute.BasicFileAttributes,LinkOption.NOFOLLOW_LINKS)
    byte[] data
    // Bounded channel read even if a same-owner process grows the file concurrently.
    def c=FileChannel.open(p,[StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS] as Set)
    try { ByteBuffer b=ByteBuffer.allocate(cap+1); while(b.hasRemaining() && c.read(b)>=0) { }; require(b.position()<=cap); data=Arrays.copyOf(b.array(),b.position()) }
    finally { c.close() }
    def after=Files.readAttributes(p,java.nio.file.attribute.BasicFileAttributes,LinkOption.NOFOLLOW_LINKS)
    require(before.fileKey()==after.fileKey() && before.size()==after.size() && before.lastModifiedTime()==after.lastModifiedTime())
    checkPrivate(p,false)
    data
  }
  def jsonBytes={ value -> JsonOutput.toJson(value).getBytes('UTF-8') }
  def readJson={ Path p -> parseJson(readPrivate(p,MAX_OUTER),MAX_OUTER) }
  Path onboarding=home.resolve('superagent-nightshift-asset-onboarding')
  Path op=onboarding.resolve(operation)
  Path target=Paths.get(ROOT)
  def metadata={ List rows -> rows.collect { [relativePath:it.relativePath,sha256:it.sha256,mode:'0600',size:it.size] }.sort { a,b -> a.relativePath<=>b.relativePath } }
  def verifyInstalled={ Map done ->
    require(done.schema==1 && done.operationId==operation && done.root==ROOT && done.files instanceof List)
    require(done.files.collect { it.relativePath }.sort()==FILES)
    checkPrivate(target,true)
    DIRECTORIES.each { checkPrivate(target.resolve(it),true) }
    def names={ Path p -> def stream=Files.list(p); try { stream.map { it.fileName.toString() }.toArray().toList().sort() } finally { stream.close() } }
    require(names(target)==(['assets','read-credentials','prepared','replay','routes.json','signing.key'].sort()))
    require(names(target.resolve('assets'))==['nightshift-gate.py','publisher-hook.py'])
    require(names(target.resolve('read-credentials'))==PROJECT_IDS.collect { it+'.json' }.sort())
    done.files.each { row ->
      require(row.mode=='0600' && row.sha256 instanceof String && row.sha256 ==~ /[0-9a-f]{64}/ && row.size instanceof Number && row.size>=0 && row.size<=MAX_FILE)
      byte[] bytes=readPrivate(target.resolve(row.relativePath),MAX_FILE)
      require(bytes.length==row.size && digest(bytes)==row.sha256)
    }
    metadata(done.files)
  }
  def loadKey={ ->
    checkPrivate(onboarding,true); checkPrivate(op,true)
    def ready=readJson(op.resolve('key-ready.json'))
    require(ready.schema==1 && ready.operationId==operation && ready.algorithm=='RSA-3072')
    byte[] publicBytes=readPrivate(op.resolve('public.spki.der'),4096)
    byte[] privateBytes=readPrivate(op.resolve('private.pkcs8.der'),8192)
    def kf=KeyFactory.getInstance('RSA')
    def pub=kf.generatePublic(new X509EncodedKeySpec(publicBytes))
    def priv=kf.generatePrivate(new PKCS8EncodedKeySpec(privateBytes))
    Arrays.fill(privateBytes,(byte)0)
    require(pub instanceof RSAPublicKey && priv instanceof RSAPrivateCrtKey && pub.modulus.bitLength()==3072 &&
        pub.publicExponent==BigInteger.valueOf(65537) && pub.modulus==priv.modulus && pub.publicExponent==priv.publicExponent)
    require(digest(publicBytes)==ready.keyFingerprint)
    [privateKey:priv,publicSpki:Base64.encoder.encodeToString(publicBytes),keyFingerprint:ready.keyFingerprint]
  }
  synchronized(j) {
    stage='preflight'
    if(Files.exists(onboarding,LinkOption.NOFOLLOW_LINKS)) checkPrivate(onboarding,true)
    if(mode=='keygen') {
      if(Files.exists(op,LinkOption.NOFOLLOW_LINKS)) {
        // Existing incomplete key generation is UNKNOWN; never generate a replacement.
        def key=loadKey()
        println(JsonOutput.toJson([status:'key_ready',operationId:operation,keyFingerprint:key.keyFingerprint,rsaPublicKeySpki:key.publicSpki]))
      } else {
        require(!Files.exists(target,LinkOption.NOFOLLOW_LINKS))
        def generator=KeyPairGenerator.getInstance('RSA')
        generator.initialize(new RSAKeyGenParameterSpec(3072,RSAKeyGenParameterSpec.F4),new SecureRandom())
        def pair=generator.generateKeyPair()
        stage='keygen-reserve'
        if(!Files.exists(onboarding,LinkOption.NOFOLLOW_LINKS)) mkdirNew(onboarding)
        checkPrivate(onboarding,true)
        mkdirNew(op) // atomic exclusive operation ownership, never stale stealing
        writeNew(op.resolve('keygen-intent.json'),jsonBytes([schema:1,operationId:operation]))
        stage='keygen-write'
        writeNew(op.resolve('private.pkcs8.der'),pair.private.encoded)
        writeNew(op.resolve('public.spki.der'),pair.public.encoded)
        String fingerprint=digest(pair.public.encoded)
        writeNew(op.resolve('key-ready.json'),jsonBytes([schema:1,operationId:operation,algorithm:'RSA-3072',keyFingerprint:fingerprint]))
        def verified=loadKey()
        println(JsonOutput.toJson([status:'key_ready',operationId:operation,keyFingerprint:verified.keyFingerprint,rsaPublicKeySpki:verified.publicSpki]))
      }
    } else if(mode=='inspect') {
      // No private RSA read, decryption, filesystem creation or token output in inspect.
      checkPrivate(onboarding,true); checkPrivate(op,true)
      def ready=readJson(op.resolve('key-ready.json'))
      byte[] pub=readPrivate(op.resolve('public.spki.der'),4096)
      require(ready.operationId==operation && ready.keyFingerprint==digest(pub))
      if(Files.exists(op.resolve('complete.json'),LinkOption.NOFOLLOW_LINKS)) {
        def done=readJson(op.resolve('complete.json'))
        require(done.keyFingerprint==ready.keyFingerprint)
        def files=verifyInstalled(done)
        println(JsonOutput.toJson([status:'installed',operationId:operation,keyFingerprint:ready.keyFingerprint,payloadSha256:done.payloadSha256,root:ROOT,files:files]))
      } else {
        boolean partial=Files.exists(op.resolve('prepared.json'),LinkOption.NOFOLLOW_LINKS) || Files.exists(target,LinkOption.NOFOLLOW_LINKS)
        println(JsonOutput.toJson([status:partial?'blocked':'key_ready',operationId:operation,keyFingerprint:ready.keyFingerprint,
            stage:partial?'partial_or_unknown':'awaiting_install',automaticReplay:false]))
      }
    } else {
      stage='decrypt'
      def key=loadKey()
      def envelope=input.envelope
      require(exactKeys(envelope,['version','algorithm','operationId','keyFingerprint','wrappedKey','iv','ciphertext','aad']))
      require(envelope.version instanceof Integer && envelope.version==1 && envelope.algorithm=='RSA-OAEP-256+A256GCM' &&
          envelope.operationId==operation && envelope.keyFingerprint==key.keyFingerprint)
      byte[] aad=('nightshift-assets-v1:'+operation+':'+key.keyFingerprint).getBytes('UTF-8')
      require(MessageDigest.isEqual(b64decode(envelope.aad,256),aad))
      byte[] wrapped=b64decode(envelope.wrappedKey,384); require(wrapped.length==384)
      byte[] iv=b64decode(envelope.iv,12); require(iv.length==12)
      byte[] ciphertext=b64decode(envelope.ciphertext,MAX_PLAIN+16); require(ciphertext.length>=16)
      def wrap=Cipher.getInstance('RSA/ECB/OAEPPadding')
      wrap.init(Cipher.DECRYPT_MODE,key.privateKey,new OAEPParameterSpec('SHA-256','MGF1',MGF1ParameterSpec.SHA256,PSource.PSpecified.DEFAULT))
      byte[] aesKey=wrap.doFinal(wrapped); require(aesKey.length==32)
      def cipher=Cipher.getInstance('AES/GCM/NoPadding')
      cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(aesKey,'AES'),new GCMParameterSpec(128,iv))
      cipher.updateAAD(aad)
      byte[] plain=cipher.doFinal(ciphertext); Arrays.fill(aesKey,(byte)0)
      require(plain.length<=MAX_PLAIN)
      String payloadHash=digest(plain)
      def payload=parseJson(plain,MAX_PLAIN)
      Arrays.fill(plain,(byte)0)
      require(exactKeys(payload,['files']) && payload.files instanceof List && payload.files.size()==19)
      Map decoded=[:]
      List manifest=[]
      int total=0
      payload.files.each { row ->
        require(exactKeys(row,['relativePath','sha256','base64','mode']) && row.relativePath instanceof String && FILES.contains(row.relativePath))
        require(!decoded.containsKey(row.relativePath) && row.mode=='0600' && row.sha256 instanceof String && row.sha256 ==~ /[0-9a-f]{64}/)
        byte[] bytes=b64decode(row.base64,MAX_FILE)
        total+=bytes.length; require(total<=MAX_TOTAL_FILES && digest(bytes)==row.sha256)
        decoded[row.relativePath]=bytes
        manifest << [relativePath:row.relativePath,sha256:row.sha256,mode:'0600',size:bytes.length]
      }
      require(decoded.keySet()==(FILES as Set))
      require(decoded['signing.key'].length==32)
      ['assets/publisher-hook.py','assets/nightshift-gate.py'].each { name ->
        byte[] bytes=decoded[name]; require(bytes.length>100 && bytes.length<=MAX_FILE)
        String source=java.nio.charset.StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
        require(!source.contains('\u0000') && source.startsWith('#!/usr/bin/env python3'))
      }
      def routes=parseJson(decoded['routes.json'],MAX_FILE)
      require(exactKeys(routes,['version','keyId','gitlabOrigin','keyFile','stateDir','projects']))
      require(routes.version instanceof Integer && routes.version==1 && routes.keyId=='mate-v2-20261110' &&
          routes.gitlabOrigin=='http://gitlab.yk.ykgtxy.com' && routes.keyFile==ROOT+'/signing.key' && routes.stateDir==ROOT+'/replay')
      require(routes.projects instanceof Map && routes.projects.keySet()==(PROJECT_IDS as Set))
      Set actors=[] as Set
      Set jobNames=[] as Set
      routes.projects.each { id, project ->
        require(project instanceof Map && project.botUserId instanceof Integer && project.botUserId==BOT_IDS[id] && actors.add(project.botUserId))
        require(project.path=='payment/refactor/'+REPOSITORIES[id])
        require(project.readCredentialFile==ROOT+'/read-credentials/'+id+'.json')
        require(project.jobs instanceof Map && project.jobs.size()>=1 && project.jobs.size()<=4)
        project.jobs.each { name, route ->
          require(name instanceof String && name ==~ /mate-[a-z0-9-]{1,80}/ && jobNames.add(name) &&
              !name.startsWith('mate-one') && name!='mate-lib-deploy' && !(name =~ /(?:^|-)(?:prod|production)(?:-|$)/))
          require(route instanceof Map && ['destinationId','namespace','deployment','container'].every { route[it] instanceof String })
          require(route.destinationId ==~ /[A-Za-z0-9][A-Za-z0-9._:-]{0,127}/)
          ['namespace','deployment','container'].each { field -> require(route[field].length()<=253 && route[field] ==~ /[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/) }
        }
        def credential=parseJson(decoded['read-credentials/'+id+'.json'],16384)
        require(credential instanceof Map && (credential.keySet()-(['projectId','token','tokenId','userId','expiresAt'] as Set)).isEmpty())
        require(credential.projectId instanceof Integer && credential.projectId.toString()==id &&
            credential.token instanceof String && credential.token ==~ /[\x21-\x7e]{8,4096}/)
        require(credential.expiresAt instanceof String)
        def expiry=java.time.Instant.parse(credential.expiresAt)
        require(expiry.isAfter(java.time.Instant.now()) && !expiry.isAfter(java.time.Instant.parse('2026-12-10T00:00:00Z')))
        if(credential.containsKey('tokenId')) require(credential.tokenId instanceof Integer && credential.tokenId>0)
        if(credential.containsKey('userId')) require(credential.userId instanceof Integer && credential.userId>=112 && credential.userId<=126)
      }
      require(jobNames.size()==20)
      manifest=metadata(manifest)
      stage='install-preflight'
      if(Files.exists(op.resolve('complete.json'),LinkOption.NOFOLLOW_LINKS)) {
        def done=readJson(op.resolve('complete.json'))
        require(done.payloadSha256==payloadHash && done.keyFingerprint==key.keyFingerprint && done.files==manifest)
        def files=verifyInstalled(done)
        println(JsonOutput.toJson([status:'installed',operationId:operation,keyFingerprint:key.keyFingerprint,payloadSha256:payloadHash,root:ROOT,files:files]))
      } else {
        require(!Files.exists(op.resolve('prepared.json'),LinkOption.NOFOLLOW_LINKS) && !Files.exists(target,LinkOption.NOFOLLOW_LINKS))
        stage='install-intent'
        writeNew(op.resolve('prepared.json'),jsonBytes([schema:1,operationId:operation,keyFingerprint:key.keyFingerprint,
            root:ROOT,payloadSha256:payloadHash,files:manifest]))
        mkdirNew(target) // new-root-only; never overwrite existing live assets, secrets or replay store
        DIRECTORIES.each { mkdirNew(target.resolve(it)) }
        manifest.eachWithIndex { row, i ->
          stage='write-asset'
          writeNew(op.resolve(String.format('%02d-file-intent.json',i)),jsonBytes([operationId:operation,relativePath:row.relativePath,sha256:row.sha256]))
          writeNew(target.resolve(row.relativePath),(byte[])decoded[row.relativePath])
          writeNew(op.resolve(String.format('%02d-file-saved.json',i)),jsonBytes([operationId:operation,relativePath:row.relativePath,sha256:row.sha256]))
        }
        def done=[schema:1,operationId:operation,keyFingerprint:key.keyFingerprint,root:ROOT,payloadSha256:payloadHash,files:manifest]
        def files=verifyInstalled(done)
        stage='complete'
        writeNew(op.resolve('complete.json'),jsonBytes(done))
        println(JsonOutput.toJson([status:'installed',operationId:operation,keyFingerprint:key.keyFingerprint,payloadSha256:payloadHash,root:ROOT,files:files]))
      }
      decoded.values().each { Arrays.fill((byte[])it,(byte)0) }
      decoded=null; payload=null; input=null
    }
  }
} catch(Throwable ignored) {
  // Fixed codes only; no raw exceptions, plaintext, ciphertext or secret-derived snippets.
  println(JsonOutput.toJson([status:'blocked',operationId:operation,stage:stage,reason:'precondition_or_operation_failed',automaticReplay:false]))
}
return null
