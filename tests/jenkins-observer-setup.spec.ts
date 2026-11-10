/** Offline source/fixture contracts and JDK↔Node crypto interoperability ONLY.
 * These tests do NOT execute Groovy against Jenkins and do not prove live ACL/save semantics.
 * No live API, tokens, credentials, business repositories, builds or deployments.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const setup = readFileSync(fileURLToPath(new URL('../integrations/jenkins/observer-setup.groovy', import.meta.url)), 'utf8')
const rollback = readFileSync(fileURLToPath(new URL('../integrations/jenkins/observer-rollback.groovy', import.meta.url)), 'utf8')
const inventorySource = readFileSync(fileURLToPath(new URL('../integrations/jenkins/observer-inventory.groovy', import.meta.url)), 'utf8')
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const jsonHash = (value: unknown) => sha256(JSON.stringify(value))
const jobs = [
  'mate-account', 'mate-agent-core', 'mate-agent-portal', 'mate-customer-core', 'mate-customer-portal',
  'mate-customer-wechat', 'mate-data-center', 'mate-data-center-export', 'mate-gateway',
  'mate-manage-core', 'mate-manage-portal', 'mate-manage-web', 'mate-pay-channel', 'mate-policy-core',
  'mate-policy-task', 'mate-recon', 'mate-settle', 'mate-terminal', 'mate-three-server', 'mate-trade',
]
const allNames = [...jobs, 'mate-lib-deploy', 'mate-one', 'mate-one-brand-image', 'mate-one/mate-one-dev-h2',
  'mate-one/mate-one-images', 'mate-one/mate-one-portal', 'mate-one/mate-one-web-images'].sort()
const grants = [
  { permission: 'hudson.model.Hudson.Administer', type: 'EITHER', sid: 'admin' },
  { permission: 'hudson.model.Hudson.Administer', type: 'EITHER', sid: 'wyy' },
  { permission: 'hudson.model.Hudson.Read', type: 'EITHER', sid: 'authenticated' },
]
function fixture() {
  return {
    schema: 1, coreVersion: '2.568.2', matrixVersion: '3.2.10', folderVersion: '6.1100.ve9eed61d16c4',
    strategyClass: 'hudson.security.GlobalMatrixAuthorizationStrategy', realmClass: 'hudson.security.HudsonPrivateSecurityRealm',
    allowsSignup: false, userIdStrategyClass: 'jenkins.model.IdStrategy$CaseInsensitive', globalGrants: structuredClone(grants),
    observerId: 'superagent-v2-observer', observerExists: false,
    admins: [{ id: 'admin', exists: true, localLogin: true, administer: true },
      { id: 'wyy', exists: true, localLogin: false, administer: null }],
    items: allNames.map(fullName => ({ fullName, className: fullName === 'mate-one' ? 'com.cloudbees.hudson.plugins.folder.Folder' : 'hudson.model.FreeStyleProject',
      parentName: fullName.includes('/') ? 'mate-one' : '', kind: fullName === 'mate-one' ? 'folder' : 'job', jobAcls: [] as unknown[], folderAcls: [] as unknown[] })),
    nodes: [{ name: '', builtIn: true, className: 'hudson.model.Hudson', acls: [] as unknown[] }],
  }
}
const expectedFixtureSha = '0577568d9f47763e7dec9e99a3071e8104598fbeca813c210c468db92118ed30'
function projection(source: string) {
  const start = source.indexOf('def strategy = j.getAuthorizationStrategy()')
  const end = source.indexOf('// END IDENTICAL INVENTORY PROJECTION')
  return source.slice(start, end >= 0 ? end : source.indexOf('String json='))
    .replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')
}
function ordered(source: string, ...fragments: string[]) {
  let last = -1
  for (const fragment of fragments) {
    const index = source.indexOf(fragment, last + 1)
    expect(index, `missing or out of order: ${fragment}`).toBeGreaterThan(last)
    last = index
  }
}
function setupAccepts(value: ReturnType<typeof fixture>, list = jobs) {
  // Fixture model only. Paired with source assertions; not a Groovy execution seam.
  return jsonHash(value) === expectedFixtureSha && list.length === 20 && new Set(list).size === 20 &&
    list.every(name => /^mate-[a-z0-9-]{1,80}$/.test(name) && !name.startsWith('mate-one') && name !== 'mate-lib-deploy' &&
      !/(?:^|-)(?:prod|production)(?:-|$)/.test(name) && value.items.some(x => x.fullName === name && x.kind === 'job' && x.parentName === '')) &&
    value.items.every(x => x.jobAcls.length === 0 && x.folderAcls.length === 0) && value.nodes.every(x => x.acls.length === 0)
}

describe('Jenkins observer inventory and fail-closed fixture contract (not live execution)', () => {
  it('reproduces the exact reviewed 27-item inventory SHA and wyy nonlogin state', () => {
    const value = fixture()
    expect(value.items).toHaveLength(27)
    expect(jobs).toHaveLength(20)
    expect(jsonHash(value)).toBe(expectedFixtureSha)
    expect(value.admins[1]).toEqual({ id: 'wyy', exists: true, localLogin: false, administer: null })
    expect(setupAccepts(value)).toBe(true)
  })
  it.each([['setup', setup], ['rollback', rollback]])('%s uses the identical deterministic inventory projection', (_name, source) => {
    expect(projection(source)).toBe(projection(inventorySource))
    expect(source).toContain('getAllProperties().findAll')
    expect(source).toContain('getNodeProperties().findAll')
    expect(source).toContain('([j]+j.getNodes())')
    expect(source).not.toContain('getGrantedPermissions()')
  })
  it.each(['job', 'folder', 'node'])('rejects dormant or duplicate %s ACLs even outside allowlist', kind => {
    const value = fixture(), extra = { grants: [{ sid: 'authenticated', permission: 'hudson.model.Item.Build' }] }
    if (kind === 'job') value.items.find(x => x.fullName === 'mate-lib-deploy')!.jobAcls.push(extra, extra)
    if (kind === 'folder') value.items.find(x => x.fullName === 'mate-one')!.folderAcls.push(extra)
    if (kind === 'node') value.nodes[0]!.acls.push(extra)
    expect(setupAccepts(value)).toBe(false)
    expect(setup).toContain('it.jobAcls == [] && it.folderAcls == []')
    expect(setup).toContain('before.nodes.every { it.acls == [] }')
  })
  it.each(['extra-grant', 'typed-grant-drift', 'signup', 'version', 'observer-exists', 'admin-lost'])('CAS denies %s fixture drift', scenario => {
    const value = fixture()
    if (scenario === 'extra-grant') value.globalGrants.push({ permission: 'hudson.model.Item.Build', sid: 'authenticated', type: 'EITHER' })
    if (scenario === 'typed-grant-drift') value.globalGrants[0]!.type = 'USER'
    if (scenario === 'signup') value.allowsSignup = true
    if (scenario === 'version') value.coreVersion = '2.589'
    if (scenario === 'observer-exists') value.observerExists = true
    if (scenario === 'admin-lost') value.admins[0]!.administer = false
    expect(setupAccepts(value)).toBe(false)
  })
  it.each(['mate-lib-deploy', 'mate-one-brand-image', 'mate-one/mate-one-dev-h2', 'mate-prod', 'mate-missing', 'mate-trade'])('rejects wrong/duplicate route %s rather than prefix expansion', name => {
    const list = [...jobs]; list[0] = name
    expect(setupAccepts(fixture(), list)).toBe(false)
  })
  it('requires exact 20 input jobs; scripts do not invent their names', () => {
    expect(setupAccepts(fixture(), jobs.slice(1))).toBe(false)
    expect(setupAccepts(fixture(), [...jobs, 'mate-extra'])).toBe(false)
    for (const source of [setup, rollback]) {
      expect(source).toMatch(/jobs(?:\.size\(\)|\.size\(\))\s*==\s*20|input\.jobs\.size\(\) == 20/)
      expect(source).toContain("it.startsWith('mate-one')")
      expect(source).not.toContain("'mate-data-center-export'")
    }
  })
})

describe('Jenkins observer setup and rollback structural safety contract', () => {
  it.each([setup, rollback])('defaults apply off, exact JSON input schema, fixed observer, safe response', source => {
    expect(source.match(/__INPUT_JSON_BASE64__/g)).toHaveLength(1)
    expect(source).toMatch(/input\.apply\s*==\s*true/)
    expect(source).toMatch(/input\.apply instanceof Boolean/)
    expect(source).toContain('superagent-v2-observer')
    expect(source).toMatch(/catch\s*\(Throwable ignored\)/)
    expect(source).toContain("reason:'precondition_or_operation_failed'")
    expect(source).not.toMatch(/print(?:ln)?\([^\n]*(?:plainValue|password|payload|input|error)/)
    expect(source.trimEnd().endsWith('return null')).toBe(true)
    expect(source).not.toMatch(/new URL|\.openConnection\(|buildWithParameters|scheduleBuild|\.execute\(/)
  })
  it('validates public key and crypto provider before any mutable filesystem/Jenkins operations', () => {
    ordered(setup, "new X509EncodedKeySpec(spki)", "publicKey.modulus.bitLength() >= 2048", "wrap.doFinal(new byte[32])", "stage='reserve'", 'Files.createDirectory', "job.addProperty", 'j.setAuthorizationStrategy', 'createAccount', 'generateNewToken')
    expect(setup).toContain('publicKey.publicExponent == BigInteger.valueOf(65537)')
  })
  it('checks both legacy-token settings BEFORE mutations and again before account/token creation', () => {
    expect(setup).toContain('import jenkins.security.apitoken.ApiTokenPropertyConfiguration')
    expect(setup).toContain('config.isTokenGenerationOnCreationEnabled()')
    expect(setup).toContain('config.isCreationOfLegacyTokenEnabled()')
    expect(setup).toContain('requiredTokenPolicy=[tokenGenerationOnCreationEnabled:false,creationOfLegacyTokenEnabled:false]')
    ordered(setup, 'require(tokenPolicy() == requiredTokenPolicy)', 'def inventory =', "stage='reserve'", 'require(tokenPolicy() == requiredTokenPolicy)', 'Files.createDirectory')
    ordered(setup, "intent('strategy-intent'", 'require(tokenPolicy() == requiredTokenPolicy)', 'j.setAuthorizationStrategy')
    ordered(setup, "intent('user-intent'", 'require(tokenPolicy() == requiredTokenPolicy)', 'require(User.getById(observerId,false) == null)', '.createAccount(observerId,password)')
    ordered(setup, "intent('token-intent'", 'require(tokenPolicy() == requiredTokenPolicy)', '.generateNewToken(')
    expect(setup).toContain('tokenPolicy:requiredTokenPolicy')
    expect(rollback).toContain('prepared.tokenPolicy==[tokenGenerationOnCreationEnabled:false,creationOfLegacyTokenEnabled:false]')
    for (const source of [setup, rollback]) expect(source).not.toMatch(/setTokenGenerationOnCreationEnabled|setCreationOfLegacyTokenEnabled/)
  })
  it('contains no mutation in initial dry-run success branch', () => {
    const start = setup.indexOf('if (!apply) {')
    const end = setup.indexOf('} else {', start)
    expect(start).toBeGreaterThan(0)
    const branch = setup.slice(start, end)
    expect(branch).toContain("status:'dry_run'")
    expect(branch).not.toMatch(/createDirectory|writeNew|receipt\(|addProperty|setAuthorization|\.save\(|createAccount|generateNewToken/)
  })
  it('claims exclusive private operation dir and uses durable create-new files, never deletes state', () => {
    expect(setup).toContain('Files.createDirectory(operationDir,')
    for (const source of [setup, rollback]) {
      expect(source).toContain('StandardOpenOption.CREATE_NEW')
      expect(source).toContain('channel.force(true)')
      expect(source).toContain('LinkOption.NOFOLLOW_LINKS')
      expect(source).toContain('Files.isSymbolicLink')
      expect(source).toContain('Files.getOwner')
      expect(source).toContain("'unix:nlink'")
      expect(source).toContain("'rw-------'")
      expect(source).toContain("'rwx------'")
      expect(source).not.toMatch(/Files\.delete|deleteIfExists|\.delete\(\)|deleteRecursive|createDirectories/)
    }
  })
  it('backs up authorization only, journals before each mutation, explicit save after setter', () => {
    expect(setup).toContain('Jenkins.XSTREAM2.toXML(old)')
    expect(setup).not.toMatch(/toXML\((?:j|user)\)/)
    ordered(setup, "'authorization-before.xml'", "receipt('prepared.json'", "intent('job-intent'", 'job.addProperty', "intent('strategy-intent'", 'j.setAuthorizationStrategy(next)', 'j.save()', "intent('user-intent'", '.createAccount(observerId,password)', "intent('token-intent'", '.generateNewToken(', "intent('token-saved'")
  })
  it('preserves typed global grants and nonlogin wyy without touching its password', () => {
    expect(setup).toContain('next.add(permission,new PermissionEntry(entry.type,entry.sid))')
    expect(setup).toContain("[id:'wyy',exists:true,localLogin:false,administer:null]")
    expect(setup).toContain('require(before.globalGrants == expectedGrants')
    expect(setup).not.toMatch(/getById\('wyy'[^\n]*impersonate2/)
    expect(rollback).not.toMatch(/getById\('wyy'[^\n]*impersonate2/)
    expect(setup.match(/\.createAccount\(/g)).toHaveLength(1)
    ordered(setup, 'User.getById(observerId,false) == null', "intent('user-intent'", '.createAccount(observerId,password)')
    expect(setup).toContain('it.id.equalsIgnoreCase(observerId)')
  })
  it('verifies all items and nodes as actual observer, before minting token', () => {
    expect(setup).toContain('def auth = u.impersonate2()')
    expect(setup).toContain('acl.hasPermission2(auth,Item.READ) == jobs.contains(item.getFullName())')
    expect(setup).toContain('acl.hasPermission2(auth,Item.DISCOVER) == jobs.contains(item.getFullName())')
    for (const id of ['Item.Build', 'Item.Configure', 'Item.Create', 'Item.Delete', 'Item.Workspace', 'Item.Cancel', 'Computer.Configure', 'Computer.Create', 'Computer.Delete', 'Computer.Connect', 'Computer.Disconnect', 'Computer.Build']) expect(setup).toContain(id)
    ordered(setup, "intent('user-saved'", 'verifyObserver()', "intent('token-intent'", 'generateNewToken')
    expect(setup).toContain('!j.getACL().hasPermission2(auth,Jenkins.MANAGE)')
  })
  it('returns only saved ciphertext on exact successful replay; unknown operations never mint again', () => {
    ordered(setup, 'if (Files.exists(operationDir', "resolve('rollback-intent.json')", "readJson(operationDir.resolve('complete.json'))", 'done.requestHash == requestHash', 'done.keyFingerprint == keyFingerprint', 'done.postInventorySha256 == jsonHash(before)', "readJson(operationDir.resolve('envelope.json'))")
    expect(setup).toContain('digest(Files.readAllBytes(operationDir.resolve(\'envelope.json\'))) == done.envelopeSha256')
    expect(setup.match(/\.generateNewToken\(/g)).toHaveLength(1)
    expect(setup).toContain("replayTokens[0].name == 'nightshift-observer:'+operation")
    expect(setup).toContain('!replayTokens[0].isExpired()')
  })
  it('rollback requires complete receipt, exact current post hash and known typed reconstruction', () => {
    ordered(rollback, "readJson('prepared.json')", "readJson('complete.json')", 'done.postInventorySha256==input.expectedPostInventorySha256', 'jsonHash(current)==input.expectedPostInventorySha256', "writeNew('rollback-intent.json'", 'tokenProperty.revokeToken(done.tokenUuid)', 'new GlobalMatrixAuthorizationStrategy()', 'j.setAuthorizationStrategy(restored)', 'j.save()', 'job.removeProperty(props[0])', "writeNew('rollback-complete.json'")
    expect(rollback).toContain('new PermissionEntry(AuthorizationType.valueOf(row.type),row.sid)')
    expect(rollback).toContain('props.size()==1')
    expect(rollback).toContain('require(inventory()==expected)')
    expect(rollback).not.toMatch(/fromXML|\.delete\(|deleteRecursive|createAccount|generateNewToken|revokeAllTokens/)
  })
  it('rollback preserves newly created user and refuses automatic replay after incomplete rollback', () => {
    expect(rollback).toContain("require(!Files.exists(dir.resolve('rollback-intent.json')")
    expect(rollback).toContain("'rollback-complete.json'")
    expect(rollback).toContain('afterRollback.observerExists=true')
    expect(rollback).toContain('userPreserved:true')
  })
})

const javaCrypto = String.raw`
import java.io.*;
import java.util.*;
import java.security.*;
import java.security.spec.*;
import javax.crypto.*;
import javax.crypto.spec.*;
public class EnvelopeFixture {
 public static void main(String[] args) throws Exception {
  BufferedReader in=new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
  byte[] spki=Base64.getDecoder().decode(in.readLine());
  byte[] plain=Base64.getDecoder().decode(in.readLine());
  byte[] aad=Base64.getDecoder().decode(in.readLine());
  PublicKey publicKey=KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(spki));
  SecureRandom random=new SecureRandom();
  OAEPParameterSpec oaep=new OAEPParameterSpec("SHA-256","MGF1",MGF1ParameterSpec.SHA256,PSource.PSpecified.DEFAULT);
  Cipher wrap=Cipher.getInstance("RSA/ECB/OAEPPadding");
  wrap.init(Cipher.ENCRYPT_MODE,publicKey,oaep,random);
  KeyGenerator aes=KeyGenerator.getInstance("AES"); aes.init(256,random);
  SecretKey key=aes.generateKey();
  byte[] iv=new byte[12]; random.nextBytes(iv);
  Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
  cipher.init(Cipher.ENCRYPT_MODE,key,new GCMParameterSpec(128,iv),random);
  cipher.updateAAD(aad);
  byte[] encrypted=cipher.doFinal(plain);
  for(byte[] value:new byte[][]{wrap.doFinal(key.getEncoded()),iv,encrypted,aad})
   System.out.println(Base64.getEncoder().encodeToString(value));
 }
}
`
describe('offline JDK RSA-OAEP SHA256/MGF1 SHA256 + AES256GCM caller interoperability', () => {
  it('Node decrypts JDK ciphertext; wrong key/hash/AAD/tag fail and stdout contains no token', () => {
    const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'jenkins-observer-crypto-'))
    try {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 65537 })
      const spki = publicKey.export({ type: 'spki', format: 'der' })
      const fingerprint = sha256(spki), operation = 'offline-operation-01'
      const aad = Buffer.from(`nightshift-observer-v1:${operation}:${fingerprint}`, 'utf8')
      const payload = { username: 'superagent-v2-observer', token: '11' + 'a'.repeat(32), expiresDate: '2026-12-10', tokenUuid: 'offline-token-uuid' }
      const source = join(root, 'EnvelopeFixture.java'); writeFileSync(source, javaCrypto)
      const result = spawnSync('java', [source], { encoding: 'utf8', timeout: 20_000, maxBuffer: 128_000,
        input: [spki.toString('base64'), Buffer.from(JSON.stringify(payload)).toString('base64'), aad.toString('base64')].join('\n') + '\n',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', JAVA_HOME: process.env.JAVA_HOME ?? '' } })
      if (result.error) throw result.error
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).not.toContain(payload.token)
      const [wrapped, iv, encrypted, actualAad] = result.stdout.trim().split(/\r?\n/).map(x => Buffer.from(x, 'base64'))
      expect(wrapped).toHaveLength(384); expect(iv).toHaveLength(12); expect(actualAad).toEqual(aad)
      const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped!)
      expect(key).toHaveLength(32)
      const decrypt = (blob: Buffer, auth: Buffer) => {
        const decipher = createDecipheriv('aes-256-gcm', key, iv!)
        decipher.setAAD(auth); decipher.setAuthTag(blob.subarray(-16))
        return Buffer.concat([decipher.update(blob.subarray(0, -16)), decipher.final()])
      }
      expect(JSON.parse(decrypt(encrypted!, aad).toString())).toEqual(payload)
      expect(() => privateDecrypt({ key: privateKey, oaepHash: 'sha1' }, wrapped!)).toThrow()
      expect(() => decrypt(encrypted!, Buffer.from('different-operation'))).toThrow()
      const changed = Buffer.from(encrypted!); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
      expect(() => decrypt(changed, aad)).toThrow()
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
      expect(() => privateDecrypt({ key: other.privateKey, oaepHash: 'sha256' }, wrapped!)).toThrow()
      expect(setup).toContain("new OAEPParameterSpec('SHA-256','MGF1',MGF1ParameterSpec.SHA256,PSource.PSpecified.DEFAULT)")
      expect(setup).toContain('new GCMParameterSpec(128,iv)')
      expect(setup).toContain('cipher.updateAAD(aad)')
      expect(setup).toContain("algorithm:'RSA-OAEP-256+A256GCM'")
      expect(setup).toContain('wrappedKey:b64(wrap.doFinal(aesKey.encoded)),iv:b64(iv),ciphertext:b64(ciphertext),aad:b64(aad)')
    } finally {
      // Remove only this exact disposable offline test directory.
      if (resolve(root) !== root || dirname(root) !== parent || !root.startsWith(join(parent, 'jenkins-observer-crypto-'))) throw new Error('Unsafe cleanup target')
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
