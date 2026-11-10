// EnvInject受信源码入口；仅供管理员配置，不读取请求参数中的信任标志。
// Upstream rollback SHA256: 6afa3d6e9ba744d19effc3deac11e9d566a1ceb24ae62e50b08ee57eccd58835
// GenericTrigger#getGenericVariables / GenericVariable getters are explicit plugin APIs.
import org.jenkinsci.plugins.gwt.GenericCause
import hudson.model.Cause

def selectSource(build, job) {
    def causes=build.getCauses()
    def loadedParameters=build.getBuildVariables()
    if(loadedParameters.keySet().any{it.toString().toUpperCase(java.util.Locale.ROOT).startsWith('RELEASE_')})throw new IllegalStateException('Reserved release parameters are forbidden')
    def matches=causes.findAll{it instanceof GenericCause}
    if(matches.size()>1)throw new IllegalStateException('Ambiguous webhook cause')
    if(matches.size()==1){
        if(causes.size()!=1 || causes.any{it instanceof Cause.UserIdCause})throw new IllegalStateException('Mixed webhook causes are forbidden')
        def event=matches[0].getResolvedVariables()
        def policies=job.triggers.values().findAll{it.class.name=='org.jenkinsci.plugins.gwt.GenericTrigger'}
        if(policies.size()!=1)throw new IllegalStateException('Missing or ambiguous trusted webhook policy')
        def policy=policies[0]
        def actorVariables=policy.getGenericVariables().findAll{it.getKey()?.equalsIgnoreCase('EVENT_ACTOR')}
        if(actorVariables.size()!=1)throw new IllegalStateException('Missing or ambiguous trusted actor extraction')
        def actorVariable=actorVariables[0]
        if(actorVariable.getKey()!='EVENT_ACTOR' || actorVariable.getValue()!='$.user_id'
            || actorVariable.getExpressionType()?.toString()!='JSONPath'
            || (actorVariable.getDefaultValue()!=null && actorVariable.getDefaultValue()!='')
            || (actorVariable.getRegexpFilter()!=null && actorVariable.getRegexpFilter()!=''))throw new IllegalStateException('Untrusted webhook actor extraction')
        if((policy.getGenericRequestVariables() ?: []).any{it.getKey()?.equalsIgnoreCase('EVENT_ACTOR')}
            || (policy.getGenericHeaderVariables() ?: []).any{it.getKey()?.equalsIgnoreCase('EVENT_ACTOR')})throw new IllegalStateException('Actor parameter or header override forbidden')
        if(!policy.regexpFilterText || !policy.regexpFilterExpression)throw new IllegalStateException('Missing trusted webhook event filter')
        def rendered=org.jenkinsci.plugins.gwt.Renderer.renderText(policy.regexpFilterText,event)
        if(!org.jenkinsci.plugins.gwt.Renderer.isMatching(rendered,policy.regexpFilterExpression))throw new IllegalStateException('Webhook does not match Job policy')
        def remotes=job.scm.userRemoteConfigs
        if(remotes.size()!=1)throw new IllegalStateException('Ambiguous SCM source')
        def remote=remotes[0].url
        def uri=new URI(remote)
        if(!(uri.scheme in ['http','https']) || !uri.host || uri.userInfo || uri.query || uri.fragment)throw new IllegalStateException('Untrusted SCM source')
        def expectedSource=uri.scheme+'://'+uri.authority
        def expectedPath=uri.path.replaceFirst('^/','').replaceFirst('\\.git$','')
        def actor=event.EVENT_ACTOR
        if(!(actor instanceof String) || !(actor==~/[1-9][0-9]{0,15}/)
            || new BigInteger(actor)>new BigInteger('9007199254740991'))throw new IllegalStateException('Invalid authenticated webhook actor')
        if(event.EVENT_KIND!='push' || !(event.EVENT_PROJECT==~/[1-9][0-9]*/) || event.EVENT_REF!='refs/heads/master'
            || !(event.EVENT_SHA==~/[0-9a-f]{40}/) || event.EVENT_SHA=='0'*40
            || event.EVENT_SOURCE!=expectedSource+'/'+expectedPath
            || event.EVENT_PATH!=expectedPath || event.branch!=event.EVENT_SHA)throw new IllegalStateException('Unapproved master event')
        if(loadedParameters.get('branch')!=event.EVENT_SHA)throw new IllegalStateException('Webhook SCM parameter mismatch')
        return [RELEASE_TRIGGER_KIND:'master-push', RELEASE_EVENT_SHA:event.EVENT_SHA,
                RELEASE_EVENT_PROJECT:event.EVENT_PROJECT, RELEASE_EVENT_REF:event.EVENT_REF,
                RELEASE_EVENT_PATH:event.EVENT_PATH, RELEASE_EVENT_SOURCE:expectedSource,
                RELEASE_EVENT_ACTOR:actor, RELEASE_SCM_REVISION:event.EVENT_SHA]
    }
    if(!causes.any{it instanceof Cause.UserIdCause})throw new IllegalStateException('Only user or authenticated master webhook builds are allowed')
    def selected=loadedParameters.get('branch')?.replaceFirst('^origin/','')
    if(!(selected==~/[A-Za-z0-9][A-Za-z0-9._\/-]*/) || selected.contains('..') || selected.endsWith('/'))throw new IllegalStateException('Invalid branch selection')
    return [RELEASE_TRIGGER_KIND:'manual', RELEASE_EVENT_SHA:'', RELEASE_EVENT_PROJECT:'',
            RELEASE_EVENT_REF:'', RELEASE_EVENT_PATH:'', RELEASE_EVENT_SOURCE:'', RELEASE_EVENT_ACTOR:'', RELEASE_SCM_REVISION:selected]
}

return selectSource(currentBuild,currentJob)
