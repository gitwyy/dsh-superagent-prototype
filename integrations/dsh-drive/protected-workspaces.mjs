/** Cross-entry exclusion for workspaces owned by the fixed-session nightshift controller.
 * Not an OS sandbox: manual editors/other programs must obey handoff discipline.
 * Drive cannot safely share the nightshift lock until its descendant lifecycle is upgraded,
 * so an enrolled physical workspace is denied at this entry in BOTH day and night modes.
 */
import { readFileSync, realpathSync, lstatSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, dirname, resolve, join, sep } from 'node:path'
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('Workspace boundary requires an absolute path')
  try { return realpathSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(canonical(parent), relative(parent, path))
  }
}
export const registryPath = () => join(homedir(), '.dsh', 'state', 'mate-v2-nightshift-workspace-locks', 'managed-workspaces.json')
/** Reads only local operator-owned metadata; never follows a missing/broken registry silently. */
export function assertDriveWorkspaceAllowed(workspace, file = registryPath()) {
  let info
  try { info = lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024) throw new Error('Invalid managed-workspace registry; refusing drive')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  if (!doc || doc.version !== 1 || !Array.isArray(doc.workspaces)) throw new Error('Invalid managed-workspace registry; refusing drive')
  const target = canonical(workspace)
  for (const entry of doc.workspaces) {
    if (!entry || typeof entry.owner !== 'string' || !entry.owner || !Array.isArray(entry.repositories)) throw new Error('Invalid managed-workspace entry; refusing drive')
    for (const root of [entry.workspace, ...entry.repositories]) {
      const physical = canonical(root)
      if (inside(physical, target) || inside(target, physical)) {
        throw new Error(`Workspace belongs to ${entry.owner}; use its private-message handoff/controller, not drive: ${physical}`)
      }
    }
    // A different line may alias an owned repo through new/<name>; do not silently exempt it.
    for (const candidate of [join(target, 'new'), join(target, 'legacy')]) {
      if (!existsSync(candidate)) continue
      const candidates = [candidate, ...readdirSync(candidate).map(name => join(candidate, name))]
      for (const item of candidates) {
        const actual = canonical(item)
        for (const root of [entry.workspace, ...entry.repositories]) {
          const physical = canonical(root)
          if (inside(physical, actual) || inside(actual, physical)) throw new Error('Drive workspace aliases a managed repository root')
        }
      }
    }
  }
}
