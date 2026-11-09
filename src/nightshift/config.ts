/** Explicit local-file configuration for the fixed-workspace execution mode. Not model-editable settings. */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { NightConfig } from './contracts.ts'

const absolute = z.string().min(1).refine(isAbsolute, 'absolute path required')
const iso = z.string().datetime({ offset: true })
export const NightConfigSchema = z.object({
  enabled: z.boolean().default(false),
  acceptAfter: iso.optional(),
  workspace: absolute,
  stateDir: absolute,
  piExecutable: absolute,
  piHome: absolute,
  sessionFile: absolute,
  harnessRoot: absolute.optional(),
  lockRoot: absolute.optional(),
  repositories: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), absolute),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxTaskSeconds: z.number().int().min(10).max(14400).default(1800),
  freezeWindows: z.array(z.object({ from: iso, until: iso }).strict()
    .refine(w => Date.parse(w.from) < Date.parse(w.until), 'freeze end must follow start')).default([]),
}).strict()
export function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))
}
/** Read configuration without executing setup scripts or changing the business workspace. */
export function loadNightConfig(file: string): NightConfig {
  if (!isAbsolute(file)) throw new Error('Nightshift config path must be absolute')
  const c = NightConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  const workspace = realpathSync(c.workspace)
  if (!statSync(workspace).isDirectory()) throw new Error('Nightshift workspace is not a directory')
  const stateDir = resolve(c.stateDir), sessionFile = resolve(c.sessionFile)
  // Existing ancestors must be canonical too: a state dir through a workspace symlink is still inside it.
  const canonicalTarget = (path: string): string => {
    try { return realpathSync(path) } catch {
      const parent = dirname(path)
      if (parent === path) return path
      return resolve(canonicalTarget(parent), relative(parent, path))
    }
  }
  if (inside(workspace, canonicalTarget(stateDir)) || inside(workspace, canonicalTarget(sessionFile))) {
    throw new Error('Nightshift state/session must be outside the business workspace')
  }
  const repositories: Record<string, string> = {}
  for (const [name, path] of Object.entries(c.repositories)) {
    if (name === 'mate-one-platform' || name.startsWith('legacy')) throw new Error(`Excluded repository: ${name}`)
    const canonical = realpathSync(path)
    const parts = relative(workspace, canonical).split('/')
    if (!inside(workspace, canonical) || parts.includes('legacy') || parts.includes('legacy-kaola') || parts.includes('mate-one-platform')) {
      throw new Error(`Repository outside v2 boundary: ${name}`)
    }
    repositories[name] = canonical
  }
  if (!Object.keys(repositories).length) throw new Error('Nightshift requires an explicit repository allowlist')
  const executable = realpathSync(c.piExecutable)
  if (!statSync(executable).isFile()) throw new Error('piExecutable is not a file')
  return { ...c, workspace, stateDir: canonicalTarget(stateDir), sessionFile: canonicalTarget(sessionFile),
    piExecutable: c.piExecutable, piHome: realpathSync(c.piHome), repositories,
    ...(c.harnessRoot ? { harnessRoot: realpathSync(c.harnessRoot) } : {}),
    ...(c.lockRoot ? { lockRoot: canonicalTarget(c.lockRoot) } : {}) }
}
