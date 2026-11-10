/** Explicit local-file configuration for the fixed-workspace execution mode. Not model-editable settings. */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { NightConfig } from './contracts.ts'
import { ReleasePolicySchema } from './release/coordinator.ts'

const absolute = z.string().min(1).refine(isAbsolute, 'absolute path required')
const iso = z.string().datetime({ offset: true })
const alias = z.string().regex(/^[a-z][a-z0-9-]*$/)
const pinPath = z.string().min(1).refine(p => !isAbsolute(p) && !p.split('/').includes('..') && !p.includes('\0'), 'repository-relative pin required')
const recipe = z.object({
  executable: absolute,
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  args: z.array(z.string().max(4096)).max(64),
  timeoutSeconds: z.number().int().min(1).max(7200),
  pinnedFiles: z.record(pinPath, z.string().regex(/^[a-f0-9]{64}$/)).refine(p => Object.keys(p).length > 0, 'at least one pinned recipe file required'),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().max(4096)).optional(),
}).strict()
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
  repositories: z.record(alias, absolute),
  releasePolicy: ReleasePolicySchema.optional(),
  releaseRuntime: z.object({ keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/), keyFile: absolute, ticketDir: absolute, attestationFile: absolute }).strict().optional(),
  repositoryActions: z.record(alias, z.object({
    validations: z.record(alias, recipe),
    requiredValidations: z.array(alias).min(1),
    author: z.object({ name: z.string().min(1).max(100), email: z.string().email() }).strict(),
    targetBranch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
    remoteUrl: z.string().url().optional(),
    glabExecutable: absolute.optional(),
    gitlabProject: z.string().regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/).optional(),
    gitlabHost: z.string().regex(/^[a-zA-Z0-9.-]+(?::\d+)?$/).optional(),
  }).strict().refine(c => c.requiredValidations.every(name => Object.hasOwn(c.validations, name)), 'required validation recipe missing')).optional(),
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
  if (Object.keys(c.repositoryActions ?? {}).some(name => !Object.hasOwn(repositories, name))) throw new Error('Action configuration names an unregistered repository')
  if (c.releasePolicy) for (const [name, policy] of Object.entries(c.releasePolicy.repositories)) {
    if (policy.alias !== name || !Object.hasOwn(repositories, name) || realpathSync(policy.root) !== repositories[name]) {
      throw new Error('Release route must match an explicitly allowed canonical repository')
    }
    if (inside(workspace, canonicalTarget(policy.credentialFile))) throw new Error('Release credential must remain outside the Pi workspace')
    if (JSON.stringify(c.releasePolicy.freezeWindows) !== JSON.stringify(c.freezeWindows)) throw new Error('Release and shift freeze windows must be identical')
  }
  if (c.releaseRuntime) for (const path of [c.releaseRuntime.keyFile, c.releaseRuntime.ticketDir, c.releaseRuntime.attestationFile]) {
    if (inside(workspace, canonicalTarget(path))) throw new Error('Release runtime material must be outside the Pi workspace')
  }
  const executable = realpathSync(c.piExecutable)
  if (!statSync(executable).isFile()) throw new Error('piExecutable is not a file')
  return { ...c, workspace, stateDir: canonicalTarget(stateDir), sessionFile: canonicalTarget(sessionFile),
    piExecutable: c.piExecutable, piHome: realpathSync(c.piHome), repositories,
    ...(c.harnessRoot ? { harnessRoot: realpathSync(c.harnessRoot) } : {}),
    ...(c.lockRoot ? { lockRoot: canonicalTarget(c.lockRoot) } : {}) }
}
