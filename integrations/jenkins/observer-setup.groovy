// OFFLINE-AUTHORED administrative script. DRY RUN by default; Lead owns live review/execution.
// Substitute ONE base64 public JSON input. Never put password/token/private key in input.
// State is append-only: incomplete/unknown operations MUST NOT be automatically replayed.
// Jenkins saves are NOT a multi-object transaction; serialize operator security edits.
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import hudson.model.AbstractItem
import hudson.model.Item
import hudson.model.Job
import hudson.model.User
import hudson.security.AuthorizationMatrixProperty
import hudson.security.HudsonPrivateSecurityRealm
import hudson.security.GlobalMatrixAuthorizationStrategy
import hudson.security.ProjectMatrixAuthorizationStrategy
import hudson.security.Permission
import jenkins.model.Jenkins
import jenkins.security.ApiTokenProperty
import jenkins.security.apitoken.ApiTokenPropertyConfiguration
import org.jenkinsci.plugins.matrixauth.AuthorizationMatrixNodeProperty
import org.jenkinsci.plugins.matrixauth.PermissionEntry
import org.jenkinsci.plugins.matrixauth.inheritance.InheritParentStrategy
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.nio.channels.FileChannel
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.KeyFactory
import java.security.SecureRandom
import java.security.interfaces.RSAPublicKey
import java.security.spec.X509EncodedKeySpec
import java.security.spec.MGF1ParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import java.time.LocalDate

String stage = 'input'
String operation = null
Path operationDir = null
int sequence = 0
Closure writeNew = null
try {
  final String encodedInput = '__INPUT_JSON_BASE64__'
  if (encodedInput.length() > 32768) throw new IllegalStateException('input_size')
  def input = new JsonSlurper().parseText(new String(Base64.decoder.decode(encodedInput), 'UTF-8'))
  def require = { boolean ok -> if (!ok) throw new IllegalStateException('precondition') }
  require(input instanceof Map)
  Set fields = ['apply','operationId','expectedInventorySha256','observerId','jobs','expiresDate','rsaPublicKeySpki'] as Set
  require((input.keySet() - fields).isEmpty() && (fields - ['apply'] - input.keySet()).isEmpty())
  require(!input.containsKey('apply') || input.apply instanceof Boolean)
  boolean apply = input.apply == true
  require(input.operationId instanceof String && input.operationId ==~ /[A-Za-z0-9][A-Za-z0-9_-]{7,79}/)
  operation = input.operationId
  final String observerId = input.observerId
  require(observerId == 'superagent-v2-observer')
  require(input.expectedInventorySha256 instanceof String && input.expectedInventorySha256 ==~ /[0-9a-f]{64}/)
  require(input.jobs instanceof List && input.jobs.size() == 20 && input.jobs.toSet().size() == 20)
  require(input.jobs.every { it instanceof String && it ==~ /mate-[a-z0-9-]{1,80}/ &&
      !it.startsWith('mate-one') && it != 'mate-lib-deploy' && !(it =~ /(?:^|-)(?:prod|production)(?:-|$)/) })
  List jobs = input.jobs.toList().sort()
  require(input.expiresDate == '2026-12-10')
  LocalDate expires = LocalDate.parse(input.expiresDate)
  require(expires.isAfter(LocalDate.now()))
  require(input.rsaPublicKeySpki instanceof String && input.rsaPublicKeySpki.length() <= 4096)
  byte[] spki = Base64.decoder.decode(input.rsaPublicKeySpki)
  def publicKey = KeyFactory.getInstance('RSA').generatePublic(new X509EncodedKeySpec(spki))
  require(publicKey instanceof RSAPublicKey && publicKey.modulus.bitLength() >= 2048 &&
      publicKey.modulus.bitLength() <= 8192 && publicKey.publicExponent == BigInteger.valueOf(65537))
  def digest = { byte[] bytes -> MessageDigest.getInstance('SHA-256').digest(bytes).encodeHex().toString() }
  def jsonHash = { value -> digest(JsonOutput.toJson(value).getBytes('UTF-8')) }
  String keyFingerprint = digest(publicKey.getEncoded())
  def request = [operationId:operation,expectedInventorySha256:input.expectedInventorySha256,
      observerId:observerId,jobs:jobs,expiresDate:input.expiresDate,keyFingerprint:keyFingerprint]
  String requestHash = jsonHash(request)
  def random = new SecureRandom()
  def oaep = new OAEPParameterSpec('SHA-256','MGF1',MGF1ParameterSpec.SHA256,PSource.PSpecified.DEFAULT)
  // Initialize/test public-key encryption BEFORE any Jenkins mutation.
  def wrap = Cipher.getInstance('RSA/ECB/OAEPPadding')
  wrap.init(Cipher.ENCRYPT_MODE, publicKey, oaep, random)
  require(wrap.doFinal(new byte[32]).length == (publicKey.modulus.bitLength()+7).intdiv(8))
  def aes = KeyGenerator.getInstance('AES'); aes.init(256, random)
  def cipher = Cipher.getInstance('AES/GCM/NoPadding')
  byte[] probeIv = new byte[12]; random.nextBytes(probeIv)
  cipher.init(Cipher.ENCRYPT_MODE,aes.generateKey(),new GCMParameterSpec(128,probeIv),random)
  require(cipher.doFinal(new byte[0]).length == 16)

  def j = Jenkins.get()
  j.checkPermission(Jenkins.ADMINISTER)
  // Independent fixed precondition: retain the reviewed inventory digest unchanged.
  // Read ONLY; never silently change global token settings to make this operation pass.
  def tokenPolicy = { ->
    def config=ApiTokenPropertyConfiguration.get()
    require(config != null)
    [tokenGenerationOnCreationEnabled:config.isTokenGenerationOnCreationEnabled(),
     creationOfLegacyTokenEnabled:config.isCreationOfLegacyTokenEnabled()]
  }
  def requiredTokenPolicy=[tokenGenerationOnCreationEnabled:false,creationOfLegacyTokenEnabled:false]
  require(tokenPolicy() == requiredTokenPolicy)
  def inventory = { ->
// BEGIN IDENTICAL INVENTORY PROJECTION
    def strategy = j.getAuthorizationStrategy()
    def realm = j.getSecurityRealm()
    def loader = j.getPluginManager().uberClassLoader
    def matrixPlugin = j.getPluginManager().getPlugin('matrix-auth')
    assert matrixPlugin != null && matrixPlugin.isActive()
    assert strategy.getClass() in [GlobalMatrixAuthorizationStrategy, ProjectMatrixAuthorizationStrategy]
    def rows = { container ->
      def result = []
      container.getGrantedPermissionEntries().each { permission, entries ->
        entries.each { entry -> result << [permission:permission.getId(), type:entry.getType().name(), sid:entry.getSid()] }
      }
      result.sort { a,b -> (a.permission <=> b.permission) ?: (a.type <=> b.type) ?: (a.sid <=> b.sid) }
    }
    def projection = { p -> p == null ? null : [className:p.getClass().getName(), inheritance:p.getInheritanceStrategy().getClass().getName(), grants:rows(p)] }
    def folderPlugin = j.getPluginManager().getPlugin('cloudbees-folder')
    Class folderClass = null
    Class folderPropertyClass = null
    if (folderPlugin != null && folderPlugin.isActive()) {
      folderClass = loader.loadClass('com.cloudbees.hudson.plugins.folder.AbstractFolder')
      folderPropertyClass = loader.loadClass('com.cloudbees.hudson.plugins.folder.properties.AuthorizationMatrixProperty')
    }
    def items = j.getAllItems(AbstractItem.class).collect { item ->
      def jobAcls = item instanceof Job ? item.getAllProperties().findAll { it instanceof AuthorizationMatrixProperty }.collect { projection(it) } : []
      def folderAcls = folderClass != null && folderClass.isInstance(item) ? item.getProperties().findAll { folderPropertyClass.isInstance(it) }.collect { projection(it) } : []
      [fullName:item.getFullName(),className:item.getClass().getName(),parentName:item.getParent() instanceof AbstractItem ? item.getParent().getFullName() : '',kind:item instanceof Job ? 'job' : (folderClass != null && folderClass.isInstance(item) ? 'folder' : 'other'),jobAcls:jobAcls,folderAcls:folderAcls]
    }.sort { a,b -> a.fullName <=> b.fullName }
    def nodes = ([j]+j.getNodes()).collect { node ->
      [name:node.getNodeName(),builtIn:node.is(j),className:node.getClass().getName(),acls:node.getNodeProperties().findAll { it instanceof AuthorizationMatrixNodeProperty }.collect { projection(it) }]
    }.sort { a,b -> a.name <=> b.name }
    def admins = ['admin','wyy'].collect { id ->
      def u=User.getById(id,false)
      boolean localLogin = u!=null && u.getProperty(HudsonPrivateSecurityRealm.Details.class)!=null
      Boolean effective = null
      if (localLogin) { try { effective = strategy.getRootACL().hasPermission2(u.impersonate2(),Jenkins.ADMINISTER) } catch (org.springframework.security.core.userdetails.UsernameNotFoundException ignored) { effective = null } }
      [id:id,exists:u!=null,localLogin:localLogin,administer:effective]
    }
    def report=[schema:1,coreVersion:Jenkins.VERSION,matrixVersion:matrixPlugin.getVersion(),folderVersion:folderPlugin?.getVersion(),strategyClass:strategy.getClass().getName(),realmClass:realm.getClass().getName(),allowsSignup:realm.allowsSignup(),userIdStrategyClass:realm.getUserIdStrategy().getClass().getName(),globalGrants:rows(strategy),observerId:observerId,observerExists:User.getById(observerId,false)!=null,admins:admins,items:items,nodes:nodes]
// END IDENTICAL INVENTORY PROJECTION
    report
  }
  def expectedGrants = [
    [permission:'hudson.model.Hudson.Administer',type:'EITHER',sid:'admin'],
    [permission:'hudson.model.Hudson.Administer',type:'EITHER',sid:'wyy'],
    [permission:'hudson.model.Hudson.Read',type:'EITHER',sid:'authenticated']]
  def cloneJson = { value -> new JsonSlurper().parseText(JsonOutput.toJson(value)) }
  def ownAcl = [className:'hudson.security.AuthorizationMatrixProperty',
      inheritance:'org.jenkinsci.plugins.matrixauth.inheritance.InheritParentStrategy',
      grants:[[permission:Item.READ.id,type:'USER',sid:observerId]]]
  def permissions = { List ids -> ids.collect { id ->
    def p = Permission.fromId(id); require(p != null && p.enabled); p
  } }
  def deniedItems = permissions(['hudson.model.Item.Build','hudson.model.Item.Configure',
      'hudson.model.Item.Create','hudson.model.Item.Delete','hudson.model.Item.Workspace','hudson.model.Item.Cancel'])
  def deniedNodes = permissions(['hudson.model.Computer.Configure','hudson.model.Computer.Create',
      'hudson.model.Computer.Delete','hudson.model.Computer.Connect','hudson.model.Computer.Disconnect','hudson.model.Computer.Build'])
  def verifyObserver = { ->
    def u = User.getById(observerId,false)
    require(u != null && u.getId() == observerId && u.getProperty(HudsonPrivateSecurityRealm.Details.class) != null)
    def auth = u.impersonate2()
    require(j.getACL().hasPermission2(auth,Jenkins.READ))
    require(!j.getACL().hasPermission2(auth,Jenkins.ADMINISTER) && !j.getACL().hasPermission2(auth,Jenkins.MANAGE))
    j.getAllItems(AbstractItem.class).each { item ->
      def acl = item.getACL()
      require(acl.hasPermission2(auth,Item.READ) == jobs.contains(item.getFullName()))
      require(acl.hasPermission2(auth,Item.DISCOVER) == jobs.contains(item.getFullName()))
      deniedItems.each { require(!acl.hasPermission2(auth,it)) }
    }
    ([j]+j.getNodes()).each { node ->
      def acl = j.getAuthorizationStrategy().getACL((hudson.model.Node)node)
      deniedNodes.each { require(!acl.hasPermission2(auth,it)) }
    }
    require(j.getACL().hasPermission2(User.getById('admin',false).impersonate2(),Jenkins.ADMINISTER))
    // wyy has NO local login: preserve exact EITHER grant, NEVER reset/impersonate it here.
  }
  Path root = j.getRootDir().toPath().toAbsolutePath().normalize()
  def noSymlinks = { Path path ->
    Path part = path.root
    path.each { component -> part = part.resolve(component); require(!Files.isSymbolicLink(part)) }
  }
  noSymlinks(root)
  require(Files.isDirectory(root,LinkOption.NOFOLLOW_LINKS))
  def owner = Files.getOwner(root,LinkOption.NOFOLLOW_LINKS)
  def checkPrivate = { Path path, boolean dir ->
    noSymlinks(path)
    require((dir ? Files.isDirectory(path,LinkOption.NOFOLLOW_LINKS) : Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS)))
    require(Files.getOwner(path,LinkOption.NOFOLLOW_LINKS) == owner)
    require(Files.getPosixFilePermissions(path,LinkOption.NOFOLLOW_LINKS) == PosixFilePermissions.fromString(dir ? 'rwx------' : 'rw-------'))
    if (!dir) require((Files.getAttribute(path,'unix:nlink',LinkOption.NOFOLLOW_LINKS) as Number).longValue() == 1L)
  }
  def forceDir = { Path path -> def channel = FileChannel.open(path,StandardOpenOption.READ); try { channel.force(true) } finally { channel.close() } }
  writeNew = { Path path, byte[] bytes ->
    checkPrivate(path.parent,true)
    def channel = FileChannel.open(path, [StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE] as Set,
        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString('rw-------')))
    try { ByteBuffer b=ByteBuffer.wrap(bytes); while(b.hasRemaining()) channel.write(b); channel.force(true) }
    finally { channel.close() }
    checkPrivate(path,false); forceDir(path.parent)
  }
  def readJson = { Path path ->
    checkPrivate(path,false); require(Files.size(path) <= 1048576)
    new JsonSlurper().parseText(new String(Files.readAllBytes(path),'UTF-8'))
  }
  def receipt = { String name, Map data -> writeNew(operationDir.resolve(name),JsonOutput.toJson(data).getBytes('UTF-8')) }
  def intent = { String name, Map extra ->
    stage=name
    receipt(String.format('%03d-%s.json',++sequence,name),[schema:1,stage:name,operationId:operation]+extra)
  }
  Path base = root.resolve('superagent-nightshift-onboarding')
  operationDir = base.resolve(operation)
  synchronized(j) {
    stage='inventory'
    require(tokenPolicy() == requiredTokenPolicy)
    def before = inventory()
    if (Files.exists(base,LinkOption.NOFOLLOW_LINKS)) checkPrivate(base,true)
    if (Files.exists(operationDir,LinkOption.NOFOLLOW_LINKS)) {
      checkPrivate(operationDir,true)
      // Only a durable successful operation is replayable, and only as ciphertext retrieval.
      require(!Files.exists(operationDir.resolve('rollback-intent.json'),LinkOption.NOFOLLOW_LINKS))
      def done = readJson(operationDir.resolve('complete.json'))
      require(done.schema == 1 && done.requestHash == requestHash && done.keyFingerprint == keyFingerprint &&
          done.operationId == operation && done.postInventorySha256 == jsonHash(before))
      verifyObserver()
      def replayUser = User.getById(observerId,false)
      def replayTokens = replayUser.getProperty(ApiTokenProperty.class).getTokenStore().getTokenListSortedByName()
      require(replayTokens.size() == 1 && replayTokens[0].uuid == done.tokenUuid &&
          replayTokens[0].name == 'nightshift-observer:'+operation && !replayTokens[0].isExpired())
      def envelope = readJson(operationDir.resolve('envelope.json'))
      require(digest(Files.readAllBytes(operationDir.resolve('envelope.json'))) == done.envelopeSha256)
      println(JsonOutput.toJson([status:apply ? 'complete' : 'dry_run',operationId:operation,stage:'already_complete',
          inventorySha256:done.postInventorySha256,tokenUuid:done.tokenUuid,envelope:apply ? envelope : null]))
    } else {
      require(jsonHash(before) == input.expectedInventorySha256)
      require(before.coreVersion == '2.568.2' && before.matrixVersion == '3.2.10')
      require(before.strategyClass == GlobalMatrixAuthorizationStrategy.name && before.realmClass == HudsonPrivateSecurityRealm.name &&
          before.allowsSignup == false && before.userIdStrategyClass == 'jenkins.model.IdStrategy$CaseInsensitive')
      require(before.globalGrants == expectedGrants && before.observerExists == false)
      require(before.admins == [[id:'admin',exists:true,localLogin:true,administer:true],
          [id:'wyy',exists:true,localLogin:false,administer:null]])
      require(before.items.every { it.jobAcls == [] && it.folderAcls == [] } && before.nodes.every { it.acls == [] })
      require(jobs.every { name -> before.items.any { it.fullName == name && it.kind == 'job' && it.parentName == '' && it.className == 'hudson.model.FreeStyleProject' } })
      require(!User.getAll().any { it.id.equalsIgnoreCase(observerId) || j.securityRealm.userIdStrategy.equals(it.id,observerId) })
      def expected = cloneJson(before)
      if (!apply) {
        println(JsonOutput.toJson([status:'dry_run',operationId:operation,stage:'validated',inventorySha256:jsonHash(before),
            requestHash:requestHash,keyFingerprint:keyFingerprint,jobs:jobs,globalGrants:before.globalGrants,tokenPolicy:requiredTokenPolicy]))
      } else {
        stage='reserve'
        require(tokenPolicy() == requiredTokenPolicy)
        if (!Files.exists(base,LinkOption.NOFOLLOW_LINKS)) {
          Files.createDirectory(base,PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString('rwx------')))
          forceDir(root)
        }
        checkPrivate(base,true)
        // Atomic mkdir is the exclusive operation claim. Never delete/steal an existing claim.
        Files.createDirectory(operationDir,PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString('rwx------')))
        checkPrivate(operationDir,true); forceDir(base)
        require(inventory() == expected)
        def old = j.getAuthorizationStrategy()
        byte[] backup = Jenkins.XSTREAM2.toXML(old).getBytes('UTF-8')
        writeNew(operationDir.resolve('authorization-before.xml'),backup)
        receipt('prepared.json',[schema:1,operationId:operation,request:request,requestHash:requestHash,
            keyFingerprint:keyFingerprint,before:before,backupSha256:digest(backup),tokenPolicy:requiredTokenPolicy])
        def next = new ProjectMatrixAuthorizationStrategy()
        old.getGrantedPermissionEntries().each { permission, entries ->
          entries.each { entry -> next.add(permission,new PermissionEntry(entry.type,entry.sid)) }
        }
        jobs.each { name ->
          require(inventory() == expected)
          require(tokenPolicy() == requiredTokenPolicy)
          def job = j.getItemByFullName(name,Job.class)
          require(job != null && job.getAllProperties().findAll { it instanceof AuthorizationMatrixProperty }.isEmpty())
          intent('job-intent',[job:name])
          job.addProperty(new AuthorizationMatrixProperty([(Item.READ):([PermissionEntry.user(observerId)] as Set)],new InheritParentStrategy()))
          expected.items.find { it.fullName == name }.jobAcls = [cloneJson(ownAcl)]
          require(inventory() == expected)
          intent('job-saved',[job:name])
        }
        require(inventory() == expected)
        intent('strategy-intent',[:])
        require(tokenPolicy() == requiredTokenPolicy)
        j.setAuthorizationStrategy(next)
        j.save() // setter's saveQuietly does NOT surface persistence failure
        expected.strategyClass=ProjectMatrixAuthorizationStrategy.name
        require(inventory() == expected)
        intent('strategy-saved',[:])
        require(User.getById(observerId,false) == null && !User.getAll().any { it.id.equalsIgnoreCase(observerId) })
        intent('user-intent',[:])
        byte[] passwordBytes=new byte[48]; random.nextBytes(passwordBytes)
        String password=Base64.encoder.withoutPadding().encodeToString(passwordBytes)
        require(tokenPolicy() == requiredTokenPolicy)
        require(User.getById(observerId,false) == null)
        def user=j.getSecurityRealm().createAccount(observerId,password)
        Arrays.fill(passwordBytes,(byte)0); password=null
        require(user.id == observerId)
        expected.observerExists=true
        require(inventory() == expected)
        intent('user-saved',[:])
        verifyObserver()
        def tokenProperty=user.getProperty(ApiTokenProperty.class)
        if (tokenProperty == null) { user.addProperty(new ApiTokenProperty()); tokenProperty=user.getProperty(ApiTokenProperty.class) }
        require(tokenProperty != null && !tokenProperty.hasLegacyToken() && tokenProperty.getTokenStore().getTokenListSortedByName().isEmpty())
        require(inventory() == expected)
        intent('token-intent',[:])
        require(tokenPolicy() == requiredTokenPolicy)
        def generated=tokenProperty.generateNewToken('nightshift-observer:'+operation,expires)
        // Persist UUID immediately: subsequent failure is unknown, never an automatic second mint.
        intent('token-saved',[tokenUuid:generated.tokenUuid])
        def payload=[username:observerId,token:generated.plainValue,expiresDate:input.expiresDate,tokenUuid:generated.tokenUuid]
        byte[] plain=JsonOutput.toJson(payload).getBytes('UTF-8')
        byte[] iv=new byte[12]; random.nextBytes(iv)
        def aesKey=aes.generateKey()
        byte[] aad=('nightshift-observer-v1:'+operation+':'+keyFingerprint).getBytes('UTF-8')
        cipher.init(Cipher.ENCRYPT_MODE,aesKey,new GCMParameterSpec(128,iv),random)
        cipher.updateAAD(aad)
        byte[] ciphertext=cipher.doFinal(plain)
        Arrays.fill(plain,(byte)0); payload=null
        wrap.init(Cipher.ENCRYPT_MODE,publicKey,oaep,random)
        def b64={ byte[] b -> Base64.encoder.encodeToString(b) }
        def envelope=[version:1,algorithm:'RSA-OAEP-256+A256GCM',operationId:operation,keyFingerprint:keyFingerprint,
            wrappedKey:b64(wrap.doFinal(aesKey.encoded)),iv:b64(iv),ciphertext:b64(ciphertext),aad:b64(aad)]
        receipt('envelope.json',envelope)
        require(inventory() == expected); verifyObserver()
        def finalTokens=tokenProperty.getTokenStore().getTokenListSortedByName()
        require(finalTokens.size()==1 && finalTokens[0].uuid==generated.tokenUuid &&
            finalTokens[0].name=='nightshift-observer:'+operation && !finalTokens[0].isExpired())
        String postHash=jsonHash(inventory())
        def done=[schema:1,operationId:operation,requestHash:requestHash,keyFingerprint:keyFingerprint,
            postInventorySha256:postHash,tokenUuid:generated.tokenUuid,envelopeSha256:jsonHash(envelope)]
        generated=null
        receipt('complete.json',done)
        stage='complete'
        println(JsonOutput.toJson([status:'complete',operationId:operation,stage:stage,inventorySha256:postHash,
            tokenUuid:done.tokenUuid,envelope:envelope]))
      }
    }
  }
} catch (Throwable ignored) {
  // NEVER interpolate exception messages, user/config objects, plaintext or input.
  println(JsonOutput.toJson([status:'blocked',operationId:operation,stage:stage,reason:'precondition_or_operation_failed',
      automaticReplay:false]))
}
return null
