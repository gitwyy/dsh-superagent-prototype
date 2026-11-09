import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
const { assertDriveWorkspaceAllowed } = await import(fileURLToPath(new URL('../integrations/dsh-drive/protected-workspaces.mjs', import.meta.url)))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) { if (!root.startsWith(join(realpathSync(tmpdir()), 'drive-exclusion-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) } })
function fixture() {
 const root = realpathSync(mkdtempSync(join(tmpdir(), 'drive-exclusion-'))); roots.push(root)
 const workspace = join(root, 'fixed'), repo = join(workspace, 'new/app'), other = join(root, 'other'), registry = join(root, 'managed.json')
 mkdirSync(repo, { recursive: true }); mkdirSync(other)
 writeFileSync(registry, JSON.stringify({ version: 1, workspaces: [{ owner: 'mate-v2-nightshift', workspace, repositories: [repo] }] }))
 return { root, workspace, repo, other, registry }
}
describe('drive entry exclusion for enrolled nightshift workspace', () => {
 it('denies exact, descendant and ancestor roots but allows distinct physical line', () => {
  const f = fixture()
  for (const path of [f.workspace, f.repo, join(f.repo, 'src'), f.root]) expect(() => assertDriveWorkspaceAllowed(path, f.registry)).toThrow('belongs')
  expect(() => assertDriveWorkspaceAllowed(f.other, f.registry)).not.toThrow()
 })
 it('denies canonical aliases and a line symlink to an enrolled nested repo', () => {
  const f = fixture(), alias = join(f.root, 'alias'); symlinkSync(f.workspace, alias)
  expect(() => assertDriveWorkspaceAllowed(alias, f.registry)).toThrow()
  mkdirSync(join(f.other, 'new')); symlinkSync(f.repo, join(f.other, 'new/app'))
  expect(() => assertDriveWorkspaceAllowed(f.other, f.registry)).toThrow('aliases')
 })
 it('fails closed on malformed registry or symlink replacement', () => {
  const f = fixture(); writeFileSync(f.registry, '{broken')
  expect(() => assertDriveWorkspaceAllowed(f.other, f.registry)).toThrow()
  const link = join(f.root, 'link.json'); symlinkSync(f.registry, link)
  expect(() => assertDriveWorkspaceAllowed(f.other, link)).toThrow('Invalid')
 })
 it('leaves non-enrolled installations unchanged', () => {
  const f = fixture(); expect(() => assertDriveWorkspaceAllowed(f.other, join(f.root, 'missing.json'))).not.toThrow()
 })
})
