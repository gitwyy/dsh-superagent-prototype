/** Local source gate only: disposable Git objects/files; no tests/build scripts or network executed. */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const script = fileURLToPath(new URL('../resources/nightshift-source-check.py', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) { if (dirname(root) !== realpathSync(tmpdir()) || !root.split('/').at(-1)?.startsWith('nightshift-source-test-')) throw new Error('Unsafe fixture cleanup'); rmSync(root, { recursive: true, force: false }) } })
function fixture() {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'nightshift-source-test-'))); roots.push(root)
  const repo = resolve(root, 'repo'); const home = resolve(root, 'home'); mkdirSync(repo); mkdirSync(home)
  const env = { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (args: string[], input?: string) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { env, encoding: 'utf8', input })
  git(['init', '-q', '-b', 'sdd/source'])
  writeFileSync(resolve(repo, 'source.txt'), 'original\n'); writeFileSync(resolve(repo, '.gitlab-ci.yml'), 'reviewed: true\n'); writeFileSync(resolve(repo, '.gitignore'), 'dist/\n')
  git(['add', '.']); const tree = git(['write-tree']).trim()
  const head = git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor Fixture <fixture@invalid> 1 +0000\ncommitter Fixture <fixture@invalid> 1 +0000\n\nfixture\n`).trim()
  git(['update-ref', 'refs/heads/sdd/source', head])
  return { root, repo, home, git, env, head }
}
function check(f: ReturnType<typeof fixture>, args: string[] = [], cwd = f.repo) {
  const run = spawnSync('/usr/bin/python3', ['-I', '-B', script, ...args], { cwd, env: { ...f.env, GIT_EXTERNAL_DIFF: '/must/not/run', NODE_OPTIONS: '--require /must/not/run' }, encoding: 'utf8', timeout: 15000, maxBuffer: 128_000 })
  if (run.error) throw run.error
  expect(run.stderr).toBe('')
  return { code: run.status, output: run.stdout, value: JSON.parse(run.stdout) }
}
describe('operator-pinned local source gate', () => {
  it('passes ordinary changes without claiming tests/compilation or executing failing test code', () => {
    const f = fixture(); const marker = resolve(f.root, 'EXECUTED')
    writeFileSync(resolve(f.repo, 'test_local.py'), `raise RuntimeError('unit test fails if executed')\nopen(${JSON.stringify(marker)},'w').write('bad')\n`)
    writeFileSync(resolve(f.repo, 'Thing.java'), 'this is not compilable Java, but is ordinary UTF-8 source\n')
    writeFileSync(resolve(f.repo, 'data.json'), '{"ok":true}\n'); writeFileSync(resolve(f.repo, 'data.xml'), '<root><item/></root>\n')
    mkdirSync(resolve(f.repo, 'dist')); writeFileSync(resolve(f.repo, 'dist/ignored.json'), '{broken')
    const out = check(f)
    expect(out).toMatchObject({ code: 0, value: { source_gate: 'passed', tests_executed: false, compilation_executed: false, changed_files: 4, full_validation: 'required_same_sha_gitlab_mr_pipeline' } })
    expect(existsSync(marker)).toBe(false); expect(out.output).not.toContain('test_local.py')
  })
  it.each([['bad.json', '{bad'], ['bad.xml', '<root>'], ['bad.py', 'if :\n'], ['duplicate.json', '{"a":1,"a":2}'], ['entity.xml', '<!DOCTYPE a [<!ENTITY b "secret">]><a>&b;</a>']])('rejects bounded syntax only for %s', (name, text) => {
    const f = fixture(); writeFileSync(resolve(f.repo, name!), text!)
    const out = check(f); expect(out.code).toBe(1); expect(out.value.tests_executed).toBe(false); expect(out.output).not.toContain(text)
  })
  it('checks staged blob syntax even if the working copy was subsequently fixed', () => {
    const f = fixture(); writeFileSync(resolve(f.repo, 'data.json'), '{broken'); f.git(['add', '--', 'data.json']); writeFileSync(resolve(f.repo, 'data.json'), '{}\n')
    expect(check(f).value.reason).toBe('changed_source_syntax')
  })
  it('rejects conflict markers and whitespace errors without printing source content', () => {
    const f = fixture(); writeFileSync(resolve(f.repo, 'source.txt'), '<<<<<<< SECRET_CONFLICT\n')
    const conflict = check(f); expect(conflict.code).toBe(1); expect(conflict.output).not.toContain('SECRET_CONFLICT')
    writeFileSync(resolve(f.repo, 'source.txt'), 'secret trailing spaces   \n')
    const spaces = check(f); expect(spaces.code).toBe(1); expect(spaces.output).not.toContain('secret trailing')
  })
  it.each(['.gitlab-ci.yml', '.github/workflows/a.yml', 'scripts/test.py', 'deploy/config.json', 'Dockerfile', 'Jenkinsfile', '.env.local', 'secret.key'])('rejects changed control/secret path %s', name => {
    const f = fixture(); mkdirSync(dirname(resolve(f.repo, name)), { recursive: true }); writeFileSync(resolve(f.repo, name), 'private contents')
    expect(check(f).value.reason).toBe('protected_control_or_secret_path')
  })
  it('rejects symlinks and hardlinks rather than following external source', () => {
    const f = fixture(); const outside = resolve(f.root, 'outside.txt'); writeFileSync(outside, 'secret')
    symlinkSync(outside, resolve(f.repo, 'alias.txt')); expect(check(f).value.reason).toBe('source_link_or_special_file')
    const other = fixture(); linkSync(resolve(other.repo, 'source.txt'), resolve(other.repo, 'hard.txt'))
    expect(check(other).value.reason).toBe('source_hardlink')
  })
  it('rejects included/filter Git config before potentially side-effectful diff', () => {
    const f = fixture(); const marker = resolve(f.root, 'FILTER_EXECUTED')
    f.git(['config', 'filter.evil.clean', `touch '${marker}'; cat`]); writeFileSync(resolve(f.repo, '.git/info/attributes'), '*.txt filter=evil\n'); writeFileSync(resolve(f.repo, 'source.txt'), 'modified\n')
    expect(check(f).value.reason).toBe('unsafe_git_configuration'); expect(existsSync(marker)).toBe(false)
    const other = fixture(); other.git(['config', 'include.path', '/not/a/real/config'])
    expect(check(other).value.reason).toBe('unsafe_git_configuration')
  })
  it('does not run repository fsmonitor/hooks, external diff, or Python code', () => {
    const f = fixture(); const marker = resolve(f.root, 'SIDE_EFFECT')
    const evil = resolve(f.root, 'evil'); writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(evil, 0o700)
    f.git(['config', 'core.fsmonitor', evil]); f.git(['config', 'diff.external', evil]); f.git(['config', 'core.hooksPath', f.root])
    writeFileSync(resolve(f.repo, 'source.txt'), 'changed\n')
    expect(check(f).code).toBe(0); expect(existsSync(marker)).toBe(false)
  })
  it('requires no arguments, exact cwd repository root and bounded ordinary text', () => {
    const f = fixture(); expect(check(f, ['--run-tests']).value.reason).toBe('arguments_not_supported')
    mkdirSync(resolve(f.repo, 'nested')); expect(check(f, [], resolve(f.repo, 'nested')).code).toBe(1)
    writeFileSync(resolve(f.repo, 'large.txt'), 'x'.repeat(1024 * 1024 + 1)); expect(check(f).code).toBe(1)
    const binary = fixture(); writeFileSync(resolve(binary.repo, 'binary.bin'), Buffer.from([0, 1])); expect(check(binary).value.reason).toBe('binary_source_unsupported')
    expect(readFileSync(script, 'utf8').split('\n')[0]).toBe('#!/usr/bin/python3')
  })
})
