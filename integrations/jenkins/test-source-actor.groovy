// Read-only installed-plugin contract test. It constructs detached in-memory causes/jobs only.
import groovy.json.JsonOutput
import jenkins.model.Jenkins
import org.jenkinsci.plugins.gwt.GenericCause
import org.jenkinsci.plugins.gwt.GenericTrigger
import org.jenkinsci.plugins.gwt.GenericVariable
import hudson.model.Cause

def j=Jenkins.get();j.checkPermission(Jenkins.ADMINISTER)
String source=new String('__SOURCE_BASE64__'.decodeBase64(),'UTF-8')
def loader=new GroovyClassLoader(j.pluginManager.uberClassLoader)
def cls=loader.parseClass(source,'NightshiftActorFixture.groovy')
def parser=cls.getDeclaredConstructor().newInstance()
def trigger=new GenericTrigger([new GenericVariable('EVENT_ACTOR','$.user_id')],[],[])
trigger.setRegexpFilterText('$EVENT_KIND $EVENT_PROJECT $EVENT_REF')
trigger.setRegexpFilterExpression('^push 445 refs/heads/master$')
def job=[triggers:[test:trigger],scm:[userRemoteConfigs:[[url:'http://gitlab.yk.ykgtxy.com/payment/refactor/mate-account.git']]]]
def event=[EVENT_KIND:'push',EVENT_PROJECT:'445',EVENT_REF:'refs/heads/master',EVENT_SHA:'a'*40,EVENT_PATH:'payment/refactor/mate-account',EVENT_SOURCE:'http://gitlab.yk.ykgtxy.com/payment/refactor/mate-account',branch:'a'*40,EVENT_ACTOR:'99']
def makeCause={ e->new GenericCause('detached fixture',e,false,false,'fixture') }
def build={ causes,vars->[getCauses:{causes},getBuildVariables:{vars}] }
def passed=[]
def ok={ label,body->body();passed<<label }
def denied={ label,body->boolean failed=false;try{body()}catch(IllegalStateException expected){failed=true};assert failed;passed<<label }
ok('exact bot actor from authenticated cause') { def result=parser.selectSource(build([makeCause(event)],[branch:'a'*40]),job);assert result.RELEASE_EVENT_ACTOR=='99';assert result.RELEASE_SCM_REVISION=='a'*40 }
ok('human actor preserved') { def result=parser.selectSource(build([makeCause(event+[EVENT_ACTOR:'35'])],[branch:'a'*40]),job);assert result.RELEASE_EVENT_ACTOR=='35' }
ok('manual selection preserved') { def result=parser.selectSource(build([new Cause.UserIdCause('admin')],[branch:'origin/master']),job);assert result.RELEASE_EVENT_ACTOR=='';assert result.RELEASE_SCM_REVISION=='master' }
denied('missing actor') { parser.selectSource(build([makeCause(event+[EVENT_ACTOR:''])],[branch:'a'*40]),job) }
denied('spoofed release parameter') { parser.selectSource(build([makeCause(event)],[branch:'a'*40,RELEASE_EVENT_ACTOR:'35']),job) }
denied('mixed manual webhook causes') { parser.selectSource(build([makeCause(event),new Cause.UserIdCause('admin')],[branch:'a'*40]),job) }
denied('wrong actor extraction') { def bad=new GenericTrigger([new GenericVariable('EVENT_ACTOR','$.wrong')],[],[]);bad.setRegexpFilterText(trigger.regexpFilterText);bad.setRegexpFilterExpression(trigger.regexpFilterExpression);parser.selectSource(build([makeCause(event)],[branch:'a'*40]),job+[triggers:[test:bad]]) }
println(JsonOutput.toJson([passed:passed.size(),cases:passed,liveJobsMutated:false,buildsTriggered:false]))
return null
