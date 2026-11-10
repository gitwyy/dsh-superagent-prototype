/** Offline contracts + Node→JDK encrypted asset handoff only; NOT live Jenkins/Groovy execution. */
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createHash, generateKeyPairSync, randomBytes, publicEncrypt, createCipheriv, constants } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const source = readFileSync(fileURLToPath(new URL('../integrations/jenkins/install-assets.groovy', import.meta.url)), 'utf8')
const root = '/var/lib/jenkins/superagent-nightshift'
const ids = ['438', '441', '442', '443', '445', '452', '453', '454', '456', '457', '458', '459', '461', '462', '463']
const botMap = { '441': 97, '452': 98, '445': 99, '453': 100, '454': 101, '456': 102, '442': 103,
  '443': 104, '457': 105, '458': 106, '459': 107, '461': 108, '463': 109, '462': 110, '438': 111 }
const repoMap = { '441': 'mate-trade', '452': 'mate-pay-channel', '445': 'mate-account', '453': 'mate-settle',
  '454': 'mate-recon', '456': 'mate-customer', '442': 'mate-agent', '443': 'mate-terminal', '457': 'mate-manage',
  '458': 'mate-policy', '459': 'mate-data-center', '461': 'mate-gateway', '463': 'mate-manage-web',
  '462': 'mate-customer-wechat', '438': 'mate-three-server' }
const files = ['assets/publisher-hook.py', 'assets/nightshift-gate.py', 'routes.json', 'signing.key',
  ...ids.map(id => `read-credentials/${id}.json`)].sort()
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
function ordered(...fragments: string[]) {
  let last = -1
  for (const fragment of fragments) {
    const n = source.indexOf(fragment, last + 1)
    expect(n, `missing/order: ${fragment}`).toBeGreaterThan(last); last = n
  }
}
function row(relativePath: string, raw: Buffer) {
  return { relativePath, sha256: hash(raw), base64: raw.toString('base64'), mode: '0600' }
}
function fixture() {
  return { files: files.map(path => row(path, path === 'signing.key' ? Buffer.alloc(32, 7) : Buffer.from(`offline-${path}`))) }
}
function fixtureAccepts(payload: ReturnType<typeof fixture>) {
  const paths = payload.files.map(x => x.relativePath)
  return paths.length === 19 && new Set(paths).size === 19 && [...paths].sort().join('|') === files.join('|') &&
    payload.files.every(x => x.mode === '0600' && /^[0-9a-f]{64}$/.test(x.sha256) &&
      Buffer.from(x.base64, 'base64').toString('base64') === x.base64 && hash(Buffer.from(x.base64, 'base64')) === x.sha256) &&
    Buffer.from(payload.files.find(x => x.relativePath === 'signing.key')!.base64, 'base64').length === 32
}

describe('fixed Jenkins asset installer source contract (not Jenkins execution)', () => {
  it('accepts only exact modes and public-input schema; never interpolates a root/private-key path', () => {
    expect(source.match(/__INPUT_JSON_BASE64__/g)).toHaveLength(1)
    expect(source).toContain("encodedInput=['__INPUT_JSON_BASE64__'].join('')")
    const large = Buffer.from('synthetic-data'.repeat(10000)).toString('base64')
    const chunks = large.match(/.{1,16000}/g)!
    expect(chunks.every(x => x.length <= 16000)).toBe(true)
    const rendered = source.replace('__INPUT_JSON_BASE64__', chunks.join("','"))
    expect(rendered).toContain(chunks.join("','"))
    expect(chunks.join('')).toBe(large)
    expect(source).toContain("input.mode in ['keygen','install','inspect']")
    expect(source).toContain("['mode','operationId','envelope'] : ['mode','operationId']")
    expect(source).toContain("ROOT='/var/lib/jenkins/superagent-nightshift'")
    expect(source).toContain("home.toString()=='/var/lib/jenkins'")
    expect(source).toContain("owner.name==System.getProperty('user.name')")
    expect(source).not.toMatch(/input\.(?:root|path|privateKey|keyFile|destination)/)
    expect(source).not.toMatch(/new URL|openConnection|\.execute\(|ProcessBuilder|scheduleBuild|buildWithParameters|setAuthorization|createAccount|generateNewToken/)
  })
  it('pins exactly15 numeric projects and exact bot/project/repository bindings', () => {
    const declared = source.match(/final List PROJECT_IDS=\[([^\]]+)\]/)![1]!.match(/\d+/g)!
    expect(declared).toEqual(ids)
    for (const [id, bot] of Object.entries(botMap)) expect(source).toContain(`'${id}':${bot}`)
    for (const [id, repo] of Object.entries(repoMap)) expect(source).toContain(`'${id}':'${repo}'`)
    expect(source).toContain('project.botUserId==BOT_IDS[id]')
    expect(source).toContain("project.path=='payment/refactor/'+REPOSITORIES[id]")
    expect(source).not.toContain("'451'"); expect(source).not.toContain("'437'")
    expect(source).toContain('jobNames.size()==20')
  })
  it('creates exclusive0700 directories and0600 files with fsync, never replaces/deletes existing state', () => {
    expect(source).toContain("DIRECTORIES=['assets','read-credentials','prepared','replay']")
    expect(source).toContain('Files.createDirectory(p,')
    expect(source).toContain('StandardOpenOption.CREATE_NEW')
    expect(source).toContain("PosixFilePermissions.fromString('rwx------')")
    expect(source).toContain("PosixFilePermissions.fromString('rw-------')")
    expect(source).toContain('c.force(true)')
    expect(source).toContain('forceDir(p.parent)')
    expect(source).not.toMatch(/TRUNCATE_EXISTING|REPLACE_EXISTING|Files\.move|Files\.delete|deleteRecursive|createDirectories/)
  })
  it('checks every ancestor, owner/mode/hardlink and bounded reads before trusting files', () => {
    for (const fragment of ['Files.isSymbolicLink', 'LinkOption.NOFOLLOW_LINKS', 'Files.getOwner', 'GROUP_WRITE', 'OTHERS_WRITE', "'unix:nlink'", 'ByteBuffer.allocate(cap+1)', 'before.fileKey()==after.fileKey()', 'before.lastModifiedTime()==after.lastModifiedTime()']) expect(source).toContain(fragment)
    expect(source).toContain('MAX_OUTER=1048576')
    expect(source).toContain('MAX_PLAIN=786432')
    expect(source).toContain('MAX_FILE=262144')
    expect(source).toContain('MAX_TOTAL_FILES=524288')
  })
  it('keygen persists private PKCS8 only under fixed operation and returns public SPKI only', () => {
    ordered("if(mode=='keygen')", 'if(Files.exists(op', 'def key=loadKey()', "status:'key_ready'", "new RSAKeyGenParameterSpec(3072,RSAKeyGenParameterSpec.F4)", "stage='keygen-reserve'", 'mkdirNew(op)', "'keygen-intent.json'", "'private.pkcs8.der'", "'public.spki.der'", "'key-ready.json'")
    expect(source).toContain('pub.modulus==priv.modulus')
    expect(source).toContain('pub.publicExponent==priv.publicExponent')
    expect(source).not.toMatch(/println\([^\n]*\b(?:privateKey|privateBytes|plain|payload|input|ciphertext|aesKey)\b/)
    expect(source).not.toMatch(/printStackTrace|ignored\.message|ignored\.toString/)
  })
  it('inspect is strictly read-only, never decrypts or loads private RSA', () => {
    const start = source.indexOf("} else if(mode=='inspect')")
    const end = source.indexOf("stage='decrypt'", start)
    const branch = source.slice(start, end)
    expect(branch).toContain('verifyInstalled(done)')
    expect(branch).not.toMatch(/loadKey\(|private\.pkcs8|writeNew\(|mkdirNew\(|doFinal\(/)
    expect(branch).toContain("partial?'blocked':'key_ready'")
  })
  it('decrypts operation/fingerprint-bound AES payload and validates every file before intent', () => {
    ordered("stage='decrypt'", "envelope.operationId==operation", 'MessageDigest.isEqual', 'wrap.doFinal(wrapped)', 'cipher.updateAAD(aad)', 'cipher.doFinal(ciphertext)', 'String payloadHash=digest(plain)', 'payload.files.each', 'decoded.keySet()==(FILES as Set)', "decoded['signing.key'].length==32", "stage='install-preflight'", "stage='install-intent'", "op.resolve('prepared.json')", 'mkdirNew(target)')
    expect(source).toContain("new OAEPParameterSpec('SHA-256','MGF1',MGF1ParameterSpec.SHA256,PSource.PSpecified.DEFAULT)")
    expect(source).toContain("new SecretKeySpec(aesKey,'AES'),new GCMParameterSpec(128,iv)")
    expect(source).toContain("'nightshift-assets-v1:'+operation+':'+key.keyFingerprint")
  })
  it('validates routes fixed key/state/origin and read-only credential metadata without actor/token conflation', () => {
    for (const fragment of ["routes.keyId=='mate-v2-20261110'", "routes.gitlabOrigin=='http://gitlab.yk.ykgtxy.com'", "routes.keyFile==ROOT+'/signing.key'", "routes.stateDir==ROOT+'/replay'", "routes.projects.keySet()==(PROJECT_IDS as Set)", "project.readCredentialFile==ROOT+'/read-credentials/'+id+'.json'", "credential.projectId.toString()==id", "credential.userId>=112 && credential.userId<=126", "expiry.isAfter(java.time.Instant.now())", "java.time.Instant.parse('2026-12-10T00:00:00Z')"]) expect(source).toContain(fragment)
    expect(source).not.toContain('credential.userId==project.botUserId')
  })
  it('completed retry returns metadata only after exact payload/hash/modes; partial retry denies', () => {
    ordered("stage='install-preflight'", "Files.exists(op.resolve('complete.json')", 'done.payloadSha256==payloadHash', 'done.files==manifest', 'verifyInstalled(done)', "status:'installed'", "!Files.exists(op.resolve('prepared.json')", '!Files.exists(target', "stage='install-intent'")
    expect(source).toContain('names(target.resolve(\'assets\'))==[\'nightshift-gate.py\',\'publisher-hook.py\']')
    expect(source).toContain('digest(bytes)==row.sha256')
    expect(source).toContain('bytes.length==row.size')
    expect(source).toContain("relativePath:it.relativePath,sha256:it.sha256,mode:'0600',size:it.size")
    expect(source).toContain("catch(Throwable ignored)")
    expect(source).toContain("reason:'precondition_or_operation_failed'")
    expect(source.trimEnd().endsWith('return null')).toBe(true)
  })
})

describe('offline asset payload whitelist fixture semantics', () => {
  it('contains exactly19 synthetic files and32-byte signing key', () => {
    expect(fixtureAccepts(fixture())).toBe(true)
    expect(files).toHaveLength(19)
  })
  it.each(['../escape', '/var/lib/jenkins/config.xml', 'assets/extra.py', 'read-credentials/451.json', 'read-credentials/437.json', 'read-credentials/999.json', 'replay/clear'])('rejects unapproved path %s', path => {
    const payload = fixture(); payload.files[0] = row(path, Buffer.from('fake'))
    expect(fixtureAccepts(payload)).toBe(false)
  })
  it.each(['duplicate', 'missing', 'extra', 'wrong-hash', 'wrong-mode', 'weak-key'])('fails closed on %s', kind => {
    const payload = fixture()
    if (kind === 'duplicate') payload.files[0] = payload.files[1]!
    if (kind === 'missing') payload.files.pop()
    if (kind === 'extra') payload.files.push(row('extra', Buffer.from('x')))
    if (kind === 'wrong-hash') payload.files[0]!.sha256 = '0'.repeat(64)
    if (kind === 'wrong-mode') payload.files[0]!.mode = '0644'
    if (kind === 'weak-key') payload.files[payload.files.findIndex(x => x.relativePath === 'signing.key')] = row('signing.key', Buffer.alloc(31))
    expect(fixtureAccepts(payload)).toBe(false)
  })
})

const javaDecrypt = String.raw`
import java.io.*;
import java.util.*;
import java.security.*;
import java.security.spec.*;
import javax.crypto.*;
import javax.crypto.spec.*;
public class AssetsDecryptFixture {
 public static void main(String[] args) {
  try {
   BufferedReader in=new BufferedReader(new InputStreamReader(System.in,"UTF-8"));
   byte[][] data=new byte[5][];
   for(int i=0;i<data.length;i++) data[i]=Base64.getDecoder().decode(in.readLine());
   PrivateKey privateKey=KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(data[0]));
   Cipher wrap=Cipher.getInstance("RSA/ECB/OAEPPadding");
   wrap.init(Cipher.DECRYPT_MODE,privateKey,new OAEPParameterSpec("SHA-256","MGF1",MGF1ParameterSpec.SHA256,PSource.PSpecified.DEFAULT));
   byte[] key=wrap.doFinal(data[1]); if(key.length!=32) throw new Exception();
   Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
   cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,data[2]));
   cipher.updateAAD(data[4]);
   byte[] plain=cipher.doFinal(data[3]);
   System.out.println(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(plain)));
  } catch(Throwable ignored) { System.out.println("DENIED"); System.exit(1); }
 }
}
`
describe('real offline Node→JDK RSA3072/OAEP256/MGF1SHA256/AES256GCM installer interop', () => {
  it('decrypts synthetic large asset payload, denies tampering/wrong AAD/OAEP hash without secret output', () => {
    const parent = realpathSync(tmpdir()), temp = mkdtempSync(join(parent, 'jenkins-assets-crypto-'))
    try {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 65537 })
      const spki = publicKey.export({ format: 'der', type: 'spki' })
      const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
      const key = randomBytes(32), iv = randomBytes(12)
      const aad = Buffer.from(`nightshift-assets-v1:offline-assets-01:${hash(spki)}`)
      const payload = fixture()
      payload.files[0] = row(payload.files[0]!.relativePath, Buffer.from('synthetic-assets-'.repeat(4000)))
      const plaintext = Buffer.from(JSON.stringify(payload))
      expect(plaintext.length).toBeGreaterThan(50_000)
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad)
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
      const wrap = (oaepHash: string) => publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash }, key)
      const wrapped = wrap('sha256')
      const path = join(temp, 'AssetsDecryptFixture.java'); writeFileSync(path, javaDecrypt)
      const run = (w = wrapped, c = ciphertext, a = aad) => {
        const result = spawnSync('java', [path], { input: [pkcs8, w, iv, c, a].map(x => x.toString('base64')).join('\n') + '\n',
          encoding: 'utf8', timeout: 20_000, maxBuffer: 128_000,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', JAVA_HOME: process.env.JAVA_HOME ?? '' } })
        if (result.error) throw result.error
        expect(result.stderr).toBe('')
        expect(result.stdout).not.toContain('synthetic-assets-')
        return result
      }
      const valid = run(); expect(valid.status).toBe(0); expect(valid.stdout.trim()).toBe(hash(plaintext))
      const damaged = Buffer.from(ciphertext); damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1
      for (const result of [run(wrapped, damaged), run(wrapped, ciphertext, Buffer.from('other-operation')), run(wrap('sha1'))]) {
        expect(result.status).toBe(1); expect(result.stdout.trim()).toBe('DENIED')
      }
    } finally {
      if (resolve(temp) !== temp || dirname(temp) !== parent || !temp.startsWith(join(parent, 'jenkins-assets-crypto-'))) throw new Error('Unsafe fixture cleanup')
      rmSync(temp, { recursive: true, force: true })
    }
  }, 30_000)
})
