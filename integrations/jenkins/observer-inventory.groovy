// READ ONLY. Exact ACL metadata only; no credentials/config/User object serialization.
import groovy.json.JsonOutput
import hudson.model.AbstractItem
import hudson.model.Job
import hudson.model.User
import hudson.security.AuthorizationMatrixProperty
import hudson.security.HudsonPrivateSecurityRealm
import hudson.security.GlobalMatrixAuthorizationStrategy
import hudson.security.ProjectMatrixAuthorizationStrategy
import jenkins.model.Jenkins
import org.jenkinsci.plugins.matrixauth.AuthorizationMatrixNodeProperty
import java.security.MessageDigest

final String observerId = 'superagent-v2-observer'
def j = Jenkins.get()
j.checkPermission(Jenkins.ADMINISTER)
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
String json=JsonOutput.toJson(report)
String hash=MessageDigest.getInstance('SHA-256').digest(json.getBytes('UTF-8')).encodeHex().toString()
println(JsonOutput.toJson([inventory:report,inventorySha256:hash]))
return null
