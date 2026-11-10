// OFFLINE-AUTHORED targeted rollback. Default DRY RUN. No User deletion/full config restore.
// Only complete, receipt-bound setup operations are supported automatically. Partial/unknown
// setup or rollback needs explicit reconciliation: do not overwrite concurrent administrator edits.
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
import org.jenkinsci.plugins.matrixauth.AuthorizationMatrixNodeProperty
import org.jenkinsci.plugins.matrixauth.PermissionEntry
import org.jenkinsci.plugins.matrixauth.AuthorizationType
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.nio.channels.FileChannel
import java.nio.ByteBuffer
import java.security.MessageDigest

String stage='input'
String operation=null
try {
  final String encodedInput='__INPUT_JSON_BASE64__'
  if (encodedInput.length()>8192) throw new IllegalStateException('input_size')
  def input=new JsonSlurper().parseText(new String(Base64.decoder.decode(encodedInput),'UTF-8'))
  def require={ boolean ok -> if(!ok) throw new IllegalStateException('precondition') }
  Set fields=['apply','operationId','expectedPostInventorySha256'] as Set
  require(input instanceof Map && (input.keySet()-fields).isEmpty() && (fields-['apply']-input.keySet()).isEmpty())
  require(!input.containsKey('apply') || input.apply instanceof Boolean)
  boolean apply=input.apply==true
  require(input.operationId instanceof String && input.operationId ==~ /[A-Za-z0-9][A-Za-z0-9_-]{7,79}/)
  operation=input.operationId
  require(input.expectedPostInventorySha256 instanceof String && input.expectedPostInventorySha256 ==~ /[0-9a-f]{64}/)
  final String observerId='superagent-v2-observer'
  def digest={ byte[] b -> MessageDigest.getInstance('SHA-256').digest(b).encodeHex().toString() }
  def jsonHash={ value -> digest(JsonOutput.toJson(value).getBytes('UTF-8')) }
  def cloneJson={ value -> new JsonSlurper().parseText(JsonOutput.toJson(value)) }
  def j=Jenkins.get()
  j.checkPermission(Jenkins.ADMINISTER)
  def inventory={ ->
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
  Path root=j.getRootDir().toPath().toAbsolutePath().normalize()
  def noSymlinks={ Path path -> Path p=path.root; path.each { c -> p=p.resolve(c); require(!Files.isSymbolicLink(p)) } }
  noSymlinks(root); require(Files.isDirectory(root,LinkOption.NOFOLLOW_LINKS))
  def owner=Files.getOwner(root,LinkOption.NOFOLLOW_LINKS)
  def checkPrivate={ Path path, boolean dir ->
    noSymlinks(path)
    require(dir ? Files.isDirectory(path,LinkOption.NOFOLLOW_LINKS) : Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS))
    require(Files.getOwner(path,LinkOption.NOFOLLOW_LINKS)==owner)
    require(Files.getPosixFilePermissions(path,LinkOption.NOFOLLOW_LINKS)==PosixFilePermissions.fromString(dir?'rwx------':'rw-------'))
    if(!dir) require((Files.getAttribute(path,'unix:nlink',LinkOption.NOFOLLOW_LINKS) as Number).longValue()==1L)
  }
  Path base=root.resolve('superagent-nightshift-onboarding')
  Path dir=base.resolve(operation)
  checkPrivate(base,true); checkPrivate(dir,true)
  def readJson={ String name ->
    Path p=dir.resolve(name); checkPrivate(p,false); require(Files.size(p)<=1048576)
    new JsonSlurper().parseText(new String(Files.readAllBytes(p),'UTF-8'))
  }
  def writeNew={ String name, Map value ->
    Path p=dir.resolve(name); checkPrivate(dir,true)
    def channel=FileChannel.open(p,[StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE] as Set,
        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString('rw-------')))
    try { ByteBuffer b=ByteBuffer.wrap(JsonOutput.toJson(value).getBytes('UTF-8')); while(b.hasRemaining()) channel.write(b); channel.force(true) }
    finally { channel.close() }
    checkPrivate(p,false)
    def parent=FileChannel.open(dir,StandardOpenOption.READ); try { parent.force(true) } finally { parent.close() }
  }
  synchronized(j) {
    stage='receipt'
    def prepared=readJson('prepared.json')
    def done=readJson('complete.json')
    require(prepared.schema==1 && done.schema==1 && prepared.operationId==operation && done.operationId==operation)
    require(prepared.requestHash==done.requestHash && prepared.keyFingerprint==done.keyFingerprint)
    require(prepared.tokenPolicy==[tokenGenerationOnCreationEnabled:false,creationOfLegacyTokenEnabled:false])
    // Do not change current token settings or block targeted revocation on later policy drift.
    require(prepared.request.observerId==observerId && prepared.request.operationId==operation)
    require(done.postInventorySha256==input.expectedPostInventorySha256)
    List jobs=prepared.request.jobs
    require(jobs instanceof List && jobs.size()==20 && jobs.toSet().size()==20 && jobs==jobs.toList().sort())
    require(jobs.every { it instanceof String && it ==~ /mate-[a-z0-9-]{1,80}/ &&
        !it.startsWith('mate-one') && it!='mate-lib-deploy' && !(it =~ /(?:^|-)(?:prod|production)(?:-|$)/) })
    def before=prepared.before
    def grants=[
      [permission:'hudson.model.Hudson.Administer',type:'EITHER',sid:'admin'],
      [permission:'hudson.model.Hudson.Administer',type:'EITHER',sid:'wyy'],
      [permission:'hudson.model.Hudson.Read',type:'EITHER',sid:'authenticated']]
    require(before.coreVersion=='2.568.2' && before.matrixVersion=='3.2.10' && before.globalGrants==grants &&
        before.strategyClass==GlobalMatrixAuthorizationStrategy.name && before.realmClass==HudsonPrivateSecurityRealm.name &&
        before.observerExists==false && before.allowsSignup==false)
    require(before.items.every { it.jobAcls==[] && it.folderAcls==[] } && before.nodes.every { it.acls==[] })
    Path backup=dir.resolve('authorization-before.xml')
    checkPrivate(backup,false); require(Files.size(backup)<=65536 && digest(Files.readAllBytes(backup))==prepared.backupSha256)
    // The XML is evidence ONLY. NEVER deserialize/restore arbitrary XML.
    def ownAcl=[className:'hudson.security.AuthorizationMatrixProperty',
        inheritance:'org.jenkinsci.plugins.matrixauth.inheritance.InheritParentStrategy',
        grants:[[permission:Item.READ.id,type:'USER',sid:observerId]]]
    def expected=cloneJson(before)
    expected.strategyClass=ProjectMatrixAuthorizationStrategy.name
    expected.observerExists=true
    jobs.each { name ->
      def item=expected.items.find { it.fullName==name }
      require(item!=null && item.kind=='job' && item.parentName=='' && item.className=='hudson.model.FreeStyleProject')
      item.jobAcls=[cloneJson(ownAcl)]
    }
    def afterRollback=cloneJson(before); afterRollback.observerExists=true
    def user=User.getById(observerId,false)
    require(user!=null && user.id==observerId && user.getProperty(HudsonPrivateSecurityRealm.Details.class)!=null)
    def tokenProperty=user.getProperty(ApiTokenProperty.class)
    require(tokenProperty!=null && !tokenProperty.hasLegacyToken())
    if(Files.exists(dir.resolve('rollback-complete.json'),LinkOption.NOFOLLOW_LINKS)) {
      def rolled=readJson('rollback-complete.json')
      require(rolled.operationId==operation && rolled.setupPostInventorySha256==input.expectedPostInventorySha256 &&
          rolled.inventorySha256==jsonHash(inventory()) && inventory()==afterRollback)
      require(tokenProperty.getTokenStore().getTokenListSortedByName().isEmpty())
      println(JsonOutput.toJson([status:apply?'rolled_back':'dry_run',operationId:operation,stage:'already_rolled_back',
          inventorySha256:rolled.inventorySha256,userPreserved:true]))
    } else {
      require(!Files.exists(dir.resolve('rollback-intent.json'),LinkOption.NOFOLLOW_LINKS))
      def current=inventory()
      require(jsonHash(current)==input.expectedPostInventorySha256 && current==expected)
      def tokens=tokenProperty.getTokenStore().getTokenListSortedByName()
      require(tokens.size()==1 && tokens[0].uuid==done.tokenUuid && tokens[0].name=='nightshift-observer:'+operation)
      if(!apply) {
        println(JsonOutput.toJson([status:'dry_run',operationId:operation,stage:'validated',inventorySha256:jsonHash(current),
            tokenUuid:done.tokenUuid,jobs:jobs,userPreserved:true]))
      } else {
        stage='rollback-intent'
        writeNew('rollback-intent.json',[schema:1,operationId:operation,setupPostInventorySha256:input.expectedPostInventorySha256,
            tokenUuid:done.tokenUuid])
        require(inventory()==expected)
        stage='revoke-token'
        tokenProperty.revokeToken(done.tokenUuid)
        require(tokenProperty.getTokenStore().getTokenListSortedByName().isEmpty())
        writeNew('rollback-token-revoked.json',[operationId:operation,tokenUuid:done.tokenUuid])
        require(inventory()==expected)
        stage='restore-strategy'
        def restored=new GlobalMatrixAuthorizationStrategy()
        grants.each { row ->
          def p=Permission.fromId(row.permission); require(p!=null && p.enabled)
          restored.add(p,new PermissionEntry(AuthorizationType.valueOf(row.type),row.sid))
        }
        j.setAuthorizationStrategy(restored)
        j.save()
        expected.strategyClass=GlobalMatrixAuthorizationStrategy.name
        require(inventory()==expected)
        writeNew('rollback-strategy-restored.json',[operationId:operation])
        int n=0
        jobs.each { name ->
          require(inventory()==expected)
          def job=j.getItemByFullName(name,Job.class)
          require(job!=null)
          def props=job.getAllProperties().findAll { it instanceof AuthorizationMatrixProperty }
          require(props.size()==1 && expected.items.find { it.fullName==name }.jobAcls==[ownAcl])
          stage='remove-owned-acl'
          writeNew(String.format('rollback-%03d-intent.json',++n),[operationId:operation,job:name])
          job.removeProperty(props[0])
          expected.items.find { it.fullName==name }.jobAcls=[]
          require(inventory()==expected)
          writeNew(String.format('rollback-%03d-saved.json',n),[operationId:operation,job:name])
        }
        require(inventory()==afterRollback)
        require(j.getACL().hasPermission2(User.getById('admin',false).impersonate2(),Jenkins.ADMINISTER))
        def observerAuth=user.impersonate2()
        require(j.getACL().hasPermission2(observerAuth,Jenkins.READ) &&
            !j.getACL().hasPermission2(observerAuth,Jenkins.ADMINISTER) && !j.getACL().hasPermission2(observerAuth,Jenkins.MANAGE))
        j.getAllItems(AbstractItem.class).each { require(!it.getACL().hasPermission2(observerAuth,Item.READ)) }
        // wyy typed grant remains byte-for-byte equivalent; no login/password changes.
        String finalHash=jsonHash(inventory())
        writeNew('rollback-complete.json',[schema:1,operationId:operation,
            setupPostInventorySha256:input.expectedPostInventorySha256,inventorySha256:finalHash,userPreserved:true])
        stage='complete'
        println(JsonOutput.toJson([status:'rolled_back',operationId:operation,stage:stage,inventorySha256:finalHash,userPreserved:true]))
      }
    }
  }
} catch(Throwable ignored) {
  println(JsonOutput.toJson([status:'blocked',operationId:operation,stage:stage,reason:'precondition_or_operation_failed',automaticReplay:false]))
}
return null
