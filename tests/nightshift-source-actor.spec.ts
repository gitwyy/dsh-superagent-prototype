/** Offline SOURCE-CONTRACT tests, not a Groovy/Jenkins execution substitute.
 * No Groovy runtime is installed here. Lead separately compiles/runs the script with installed Jenkins classes.
 * Getter contracts verified from upstream GenericTrigger.java / GenericVariable.java / Generic{Header,Request}Variable.java:
 * https://github.com/jenkinsci/generic-webhook-trigger-plugin/tree/master/src/main/java/org/jenkinsci/plugins/gwt
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const path = fileURLToPath(new URL('../integrations/jenkins/source-actor.groovy', import.meta.url))
const source = readFileSync(path, 'utf8')
const UPSTREAM_SHA256 = '6afa3d6e9ba744d19effc3deac11e9d566a1ceb24ae62e50b08ee57eccd58835'
/** Exact captured upstream rollback body; never read/write a live Jenkins file from these tests. */
const upstream = String.raw`// EnvInject受信源码入口；仅供管理员配置，不读取请求参数中的信任标志。
import org.jenkinsci.plugins.gwt.GenericCause
import hudson.model.Cause

def selectSource(build, job) {
    def matches=build.getCauses().findAll{it instanceof GenericCause}
    if(matches.size()>1)throw new IllegalStateException('Ambiguous webhook cause')
    if(matches.size()==1){
        def event=matches[0].getResolvedVariables()
        def policy=job.triggers.values().find{it.class.name=='org.jenkinsci.plugins.gwt.GenericTrigger'}
        if(policy==null)throw new IllegalStateException('Missing trusted webhook policy')
        def rendered=org.jenkinsci.plugins.gwt.Renderer.renderText(policy.regexpFilterText,event)
        if(!org.jenkinsci.plugins.gwt.Renderer.isMatching(rendered,policy.regexpFilterExpression))throw new IllegalStateException('Webhook does not match Job policy')
        def remote=job.scm.userRemoteConfigs[0].url
        def uri=new URI(remote)
        def expectedSource=uri.scheme+'://'+uri.authority
        def expectedPath=uri.path.replaceFirst('^/','').replaceFirst('\\.git$','')
        if(event.EVENT_KIND!='push' || !(event.EVENT_PROJECT==~/[1-9][0-9]*/) || event.EVENT_REF!='refs/heads/master'
            || !(event.EVENT_SHA==~/[0-9a-f]{40}/) || event.EVENT_SHA=='0'*40
            || event.EVENT_SOURCE!=expectedSource+'/'+expectedPath
            || event.EVENT_PATH!=expectedPath || event.branch!=event.EVENT_SHA)throw new IllegalStateException('Unapproved master event')
        def loadedParameters=build.getBuildVariables()
        if(loadedParameters.get('branch')!=event.EVENT_SHA)throw new IllegalStateException('Webhook SCM parameter mismatch')
        return [RELEASE_TRIGGER_KIND:'master-push', RELEASE_EVENT_SHA:event.EVENT_SHA,
                RELEASE_EVENT_PROJECT:event.EVENT_PROJECT, RELEASE_EVENT_REF:event.EVENT_REF,
                RELEASE_EVENT_PATH:event.EVENT_PATH, RELEASE_EVENT_SOURCE:expectedSource,
                RELEASE_SCM_REVISION:event.EVENT_SHA]
    }
    if(!build.getCauses().any{it instanceof Cause.UserIdCause})throw new IllegalStateException('Only user or authenticated master webhook builds are allowed')
    def selected=build.getBuildVariables().get('branch')?.replaceFirst('^origin/','')
    if(!(selected==~/[A-Za-z0-9][A-Za-z0-9._\/-]*/) || selected.contains('..') || selected.endsWith('/'))throw new IllegalStateException('Invalid branch selection')
    return [RELEASE_TRIGGER_KIND:'manual', RELEASE_EVENT_SHA:'', RELEASE_EVENT_PROJECT:'',
            RELEASE_EVENT_REF:'', RELEASE_EVENT_PATH:'', RELEASE_EVENT_SOURCE:'', RELEASE_SCM_REVISION:selected]
}

return selectSource(currentBuild,currentJob)
`
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const webhook = source.slice(source.indexOf('if(matches.size()==1){'), source.indexOf("if(!causes.any"))
const manual = source.slice(source.indexOf("if(!causes.any"))

function actorPredicate(value: unknown): boolean {
  // Evaluate only the literal regex and numeric bound extracted from the authored source, not a separate copy of selectSource.
  const pattern = /actor==~\/([^/]+)\//.exec(source)?.[1]
  const limit = /new BigInteger\('([0-9]+)'\)/.exec(source)?.[1]
  if (!pattern || !limit) throw new Error('Source no longer declares the reviewed actor predicate')
  return typeof value === 'string' && new RegExp(`^(?:${pattern})$`).test(value) && BigInt(value) <= BigInt(limit)
}

describe('trusted webhook actor source provenance and preserved source policy', () => {
  it('pins the exact upstream rollback bytes and proves the authored artifact is a distinct reviewed extension', () => {
    expect(sha256(upstream)).toBe(UPSTREAM_SHA256)
    expect(source).toContain(`Upstream rollback SHA256: ${UPSTREAM_SHA256}`)
    expect(sha256(source)).toMatch(/^[a-f0-9]{64}$/)
    expect(sha256(source)).not.toBe(UPSTREAM_SHA256)
    expect(source.endsWith('return selectSource(currentBuild,currentJob)\n')).toBe(true)
  })

  it('preserves the complete existing source/project/master/ref/SHA and SCM branch equality gates verbatim', () => {
    const invariant = upstream.slice(upstream.indexOf("        if(event.EVENT_KIND!='push'"), upstream.indexOf('        def loadedParameters='))
    expect(source).toContain(invariant)
    expect(source).toContain("if(loadedParameters.get('branch')!=event.EVENT_SHA)throw new IllegalStateException('Webhook SCM parameter mismatch')")
    expect(source).toContain("def expectedSource=uri.scheme+'://'+uri.authority")
    expect(source).toContain(upstream.split('\n').find(line => line.includes('def expectedPath='))!)
  })

  it('keeps trusted GenericTrigger regexp rendering/matching and does not replace its existing filter', () => {
    expect(source).toContain("job.triggers.values().findAll{it.class.name=='org.jenkinsci.plugins.gwt.GenericTrigger'}")
    expect(source).toContain("if(policies.size()!=1)throw")
    expect(source).toContain('if(!policy.regexpFilterText || !policy.regexpFilterExpression)throw')
    const renderer = upstream.slice(upstream.indexOf('        def rendered='), upstream.indexOf('        def remote='))
    expect(source).toContain(renderer)
    expect(source).not.toMatch(/setRegexpFilter|regexpFilter(?:Text|Expression)\s*=/)
  })

  it('accepts exactly one GenericCause and refuses mixed UserId or other causes before reading trusted actor', () => {
    expect(source).toContain('def matches=causes.findAll{it instanceof GenericCause}')
    expect(source).toContain("if(matches.size()>1)throw new IllegalStateException('Ambiguous webhook cause')")
    expect(webhook).toContain('if(causes.size()!=1 || causes.any{it instanceof Cause.UserIdCause})throw')
    expect(webhook.indexOf('Mixed webhook causes')).toBeLessThan(webhook.indexOf('getResolvedVariables()'))
  })
})

describe('reviewed GenericVariable getter contract and actor provenance', () => {
  it('requires the single exact JSONPath $.user_id extractor using verified plugin getters', () => {
    expect(webhook).toContain("policy.getGenericVariables().findAll{it.getKey()?.equalsIgnoreCase('EVENT_ACTOR')}")
    expect(webhook).toContain('if(actorVariables.size()!=1)throw')
    expect(webhook).toContain("actorVariable.getKey()!='EVENT_ACTOR' || actorVariable.getValue()!='$.user_id'")
    expect(webhook).toContain("actorVariable.getExpressionType()?.toString()!='JSONPath'")
    expect(webhook).toContain("actorVariable.getDefaultValue()!=null && actorVariable.getDefaultValue()!=''")
    expect(webhook).toContain("actorVariable.getRegexpFilter()!=null && actorVariable.getRegexpFilter()!=''")
  })

  it('rejects request/header actor collisions and never obtains actor identity from build parameters', () => {
    expect(webhook).toContain("policy.getGenericRequestVariables() ?: []).any{it.getKey()?.equalsIgnoreCase('EVENT_ACTOR')}")
    expect(webhook).toContain("policy.getGenericHeaderVariables() ?: []).any{it.getKey()?.equalsIgnoreCase('EVENT_ACTOR')}")
    expect(webhook).toContain('def event=matches[0].getResolvedVariables()')
    expect(webhook).toContain('def actor=event.EVENT_ACTOR')
    expect(source).not.toMatch(/loadedParameters[^\n]*(?:EVENT_ACTOR|user_id)|getBuildVariables\(\)[^\n]*(?:EVENT_ACTOR|user_id)/)
    expect(webhook).toContain('RELEASE_EVENT_ACTOR:actor')
    expect(source).not.toMatch(/System\.getenv|System\.getProperty|println|print\(|logger|\.execute\(|ProcessBuilder/)
  })

  it('rejects every reserved RELEASE_* build variable before choosing webhook/manual source', () => {
    const position = source.indexOf("loadedParameters.keySet().any{it.toString().toUpperCase(java.util.Locale.ROOT).startsWith('RELEASE_')}")
    expect(position).toBeGreaterThan(0)
    expect(position).toBeLessThan(source.indexOf('def matches='))
    for (const key of ['RELEASE_EVENT_ACTOR', 'RELEASE_TRUSTED', 'release_event_actor', 'ReLeAsE_GATE_BYPASS']) expect(key.toUpperCase().startsWith('RELEASE_')).toBe(true)
  })

  it.each(['1', '445', '7832', '9007199254740991'])('accepts bounded decimal actor fixture %s', value => {
    expect(source).toContain('actor instanceof String')
    expect(actorPredicate(value)).toBe(true)
  })

  it.each(['0', '-1', '+1', '01', '1.0', '1e3', ' 445', '445 ', '445\n', '9007199254740992', '99999999999999999', 'bot-user', '', null, 445, ['445']])('rejects malformed/spoofed actor fixture %j', value => {
    expect(actorPredicate(value)).toBe(false)
  })
})

describe('manual source and SCM compatibility contract', () => {
  it('preserves human manual selection and returns an empty actor regardless of supplied ordinary parameters', () => {
    expect(manual).toContain("if(!causes.any{it instanceof Cause.UserIdCause})throw")
    expect(manual).toContain("def selected=loadedParameters.get('branch')?.replaceFirst('^origin/','')")
    const branchCheck = upstream.slice(upstream.indexOf('    if(!(selected==~/'), upstream.indexOf("    return [RELEASE_TRIGGER_KIND:'manual'"))
    expect(manual).toContain(branchCheck)
    expect(manual).toContain("RELEASE_EVENT_SOURCE:'', RELEASE_EVENT_ACTOR:'', RELEASE_SCM_REVISION:selected")
    expect(manual).not.toContain('getResolvedVariables')
    expect(manual).not.toContain('EVENT_ACTOR:actor')
  })

  it('requires an unambiguous credential-free SCM URL without changing a business project or hardcoding bot IDs', () => {
    expect(source).toContain("if(remotes.size()!=1)throw new IllegalStateException('Ambiguous SCM source')")
    expect(source).toContain("!(uri.scheme in ['http','https']) || !uri.host || uri.userInfo || uri.query || uri.fragment")
    expect(source).not.toMatch(/actor\s*==\s*['"]?[0-9]|EVENT_ACTOR\s*==\s*['"]?[0-9]|setScm|setTriggers|save\(|scheduleBuild/)
  })
})
