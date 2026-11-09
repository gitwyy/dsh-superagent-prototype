/** Explicit local action broker. Pinned validation recipes execute trusted operator
 * code with normal same-user OS permissions: this is NOT a sandbox. Recipes must
 * not daemonize/detach or access ambient credentials; pinning is not code review.
 * Model arguments can select a configured recipe, never supply executable/argv/env.
 * Publication intentionally fails closed until dedicated identity/helper proof exists.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const GIT = '/usr/bin/git'
const MAX_CAPTURE = 8 * 1024 * 1024
const MAX_SOURCE = 64 * 1024 * 1024
const SAFE_GIT = ['--literal-pathspecs', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'diff.submodule=short', '-c', 'log.showSignature=false', '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'maintenance.autoDetach=false', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never']
const inside = (root, path) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)) }
const hash = value => createHash('sha256').update(value).digest('hex')
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value)
const branchAllowed = value => typeof value === 'string' && /^(?:sdd|agent)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) && !value.includes('..') && !value.endsWith('.lock')
const safeEnvKeys = new Set(['CI', 'NODE_ENV', 'TZ', 'NO_COLOR', 'FORCE_COLOR', 'PYTHONHASHSEED'])
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && !item.includes('\0') && item.length <= 4096)
const nulList = value => value.split('\0').filter(Boolean)
class Denied extends Error {}
const deny = message => { throw new Denied(message) }

function canonicalOutside(path, workspace) {
  if (!isAbsolute(path) || path !== resolve(path) || inside(workspace, path)) deny('Action state path must be absolute and outside the workspace')
  let cursor = path
  const missing = []
  while (!existsSync(cursor)) { missing.push(cursor); const parent = dirname(cursor); if (parent === cursor) deny('Cannot resolve action state path'); cursor = parent }
  if (realpathSync(cursor) !== cursor) deny('Action state path must not traverse symlinks')
  for (const item of missing.reverse()) mkdirSync(item, { mode: 0o700 })
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) deny('Invalid action state directory')
  return path
}
function fileBytes(path, max = MAX_SOURCE) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.size > max) deny('Action source must be a bounded regular non-hardlinked file')
    return { bytes: readFileSync(fd), mode: info.mode & 0o111 }
  } finally { closeSync(fd) }
}
function cleanEnvironment(home) {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: 'C', LC_ALL: 'C', CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: '' }
}

/** A fixed-argv runner. Waits for close (not exit); never emits raw child output.
 * Children stay in the Pi group; the supervising runner owns group shutdown.
 * A trusted recipe that detaches cannot be contained by this mechanism.
 */
function runProcess(executable, args, options, spawnProcess) {
  return new Promise(resolveResult => {
    if (options.signal?.aborted) { resolveResult({ code: null, aborted: true, stdout: '', outputBytes: 0 }); return }
    let child
    try { child = spawnProcess(executable, args, { cwd: options.cwd, env: options.env, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { resolveResult({ code: null, spawnError: true, stdout: '', outputBytes: 0 }); return }
    let stdout = ''; let outputBytes = 0; let timedOut = false; let overflow = false; let spawnError = false; let aborted = false
    const kill = () => { try { child.kill('SIGKILL') } catch { /* close/group supervisor remains authoritative */ } }
    const timer = setTimeout(() => { timedOut = true; kill() }, options.timeoutMs)
    const abort = () => { aborted = true; kill() }
    options.signal?.addEventListener('abort', abort, { once: true })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      outputBytes += chunk.length
      if (options.capture && stream === child.stdout && outputBytes <= MAX_CAPTURE) stdout += chunk.toString('utf8')
      if (outputBytes > MAX_CAPTURE) { overflow = true; kill() }
    })
    child.once('error', () => { spawnError = true })
    child.once('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      resolveResult({ code, stdout, outputBytes, timedOut, overflow, spawnError, aborted })
    })
  })
}

/** Capture a clean baseline at guard construction, BEFORE the model can edit.
 * options.spawnProcess is solely a test seam, not exposed in policy or tool input.
 */
export function createActions(inputPolicy, guard, options = {}) {
  const policy = structuredClone(inputPolicy)
  if (!safeId(policy.runId) || !safeId(policy.taskId) || !isAbsolute(policy.workspace) || realpathSync(policy.workspace) !== policy.workspace || typeof guard?.checkedPath !== 'function') deny('Invalid action policy')
  const configured = policy.repositoryActions ?? {}
  const repositories = policy.repositoryMap ?? {}
  const receipts = new Map()
  const baselines = new Map()
  const uncertain = new Set()
  const evidence = []
  let queue = Promise.resolve()
  let home
  let auditPath
  const spawnProcess = options.spawnProcess ?? spawn
  const setupState = () => {
    if (home) return
    const state = canonicalOutside(policy.stateDir, policy.workspace)
    home = canonicalOutside(resolve(state, 'action-home'), policy.workspace)
    auditPath = resolve(state, `actions-${policy.runId}.jsonl`)
  }
  const environment = () => { setupState(); return cleanEnvironment(home) }
  function audit(record) {
    setupState()
    if (dirname(auditPath) !== resolve(policy.stateDir)) deny('Invalid action audit namespace')
    const fd = openSync(auditPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1) deny('Unsafe audit file')
      const event = { version: 1, at: new Date().toISOString(), runId: policy.runId, taskId: policy.taskId, approvalId: policy.actionApprovalId, ...record }
      writeSync(fd, JSON.stringify(event) + '\n'); fsyncSync(fd)
      evidence.push(`${record.action}:${record.repository}:${record.outcome}`)
    } finally { closeSync(fd) }
  }
  function gitSync(root, args) {
    try { return execFileSync(GIT, [...SAFE_GIT, '-C', root, ...args], { env: environment(), shell: false, encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_CAPTURE, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { deny('Read-only Git verification failed') }
  }
  function inspectGit(root) {
    const keys = gitSync(root, ['config', '--name-only', '--list']).split('\n')
    if (keys.some(key => /^filter\..+\.(?:clean|smudge|process)$/i.test(key) || /^(?:core\.sshcommand|core\.worktree|extensions\.worktreeconfig)$/i.test(key))) deny('Executable or redirected Git configuration is unsupported')
    if (gitSync(root, ['rev-parse', '--is-bare-repository']).trim() !== 'false' || realpathSync(gitSync(root, ['rev-parse', '--show-toplevel']).trim()) !== root) deny('Repository root mismatch')
    // Worktree/gitdir redirection would authorize metadata writes outside this repository.
    if (!lstatSync(resolve(root, '.git')).isDirectory() || realpathSync(resolve(root, '.git')) !== resolve(root, '.git')) deny('Linked worktrees/submodules are unsupported for broker actions')
    if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].some(name => existsSync(resolve(root, '.git', name)))) deny('An existing merge/rebase/cherry-pick operation requires manual recovery')
    return { head: gitSync(root, ['rev-parse', 'HEAD']).trim(), branch: gitSync(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() }
  }
  function checkedFile(root, name, write = false) {
    if (!name || isAbsolute(name) || name.includes('\0') || resolve(root, name) === root || !inside(root, resolve(root, name))) deny('Invalid repository-relative source path')
    const checked = guard.checkedPath(resolve(root, name), write)
    if (checked.path !== resolve(root, name) || checked.root !== root) deny('Source belongs to another repository scope')
    // Extra broker guard: metadata, CI executable hooks and auth material never become commits accidentally.
    if (name.split(/[\\/]/).some(part => /^\.git$/i.test(part) || /^\.env(?:\.|$)/i.test(part) || /^(?:credentials?|secrets?|auth)(?:\.|$)/i.test(part))) deny('Protected action source path')
    return checked.path
  }
  function sourceSnapshot(root) {
    const entries = nulList(gitSync(root, ['ls-files', '--stage', '-z']))
    const names = []
    for (const entry of entries) {
      const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]*)$/.exec(entry)
      if (!match || match[2] !== '0' || !['100644', '100755'].includes(match[1])) deny('Symlink, submodule or unresolved index entries are unsupported')
      names.push(match[3])
    }
    names.push(...nulList(gitSync(root, ['ls-files', '--others', '--exclude-standard', '-z'])))
    if (names.length > 10_000) deny('Source inventory exceeds action limit')
    const digest = createHash('sha256'); let bytes = 0
    for (const name of [...new Set(names)].sort()) {
      let path
      try { path = checkedFile(root, name) }
      catch (error) {
        // A tracked deletion is allowed only after the write guard authorizes the missing path.
        if (!existsSync(resolve(root, name))) { checkedFile(root, name, true); continue }
        throw error
      }
      const source = fileBytes(path)
      bytes += source.bytes.length
      if (bytes > MAX_SOURCE) deny('Source inventory exceeds action byte limit')
      digest.update(JSON.stringify([name, source.mode, source.bytes.length])); digest.update(source.bytes)
    }
    return { digest: digest.digest('hex'), names: [...new Set(names)] }
  }
  function staged(root) { return nulList(gitSync(root, ['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'])) }
  function configuration(alias) {
    const root = repositories[alias]
    const config = configured[alias]
    if (!Object.hasOwn(repositories, alias) || !Object.hasOwn(configured, alias) || !config || !isAbsolute(root) || realpathSync(root) !== root || !inside(policy.workspace, root)) deny('Repository actions are not configured in this task scope')
    const scoped = guard.checkedPath(root)
    if (scoped.root !== root || scoped.path !== root) deny('Repository is not in the task scope')
    return { root, config }
  }
  // Snapshot errors are retained and fail actions closed; an invalid optional broker
  // configuration must not silently grant authorization or break read-only tools.
  for (const alias of Object.keys(configured)) {
    if (!Object.hasOwn(repositories, alias)) continue
    try {
      const { root } = configuration(alias)
      const current = inspectGit(root)
      const expected = policy.baseline?.[alias]
      if (!expected || expected.head !== current.head || expected.branch !== current.branch) deny('Baseline HEAD/branch mismatch')
      if (gitSync(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])) deny('Broker must be constructed against a clean baseline')
      if (staged(root).length) deny('Preexisting staged changes are not authorized')
      sourceSnapshot(root)
      baselines.set(alias, { ...current })
    } catch (error) { baselines.set(alias, { error: error instanceof Denied ? error.message : 'Baseline verification failed' }) }
  }
  function authorized(input) {
    if (!input || typeof input !== 'object' || !['validate', 'commit', 'publish'].includes(input.action) || typeof input.repository !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.repository)) deny('Invalid action request')
    if (Object.keys(input).some(key => !['action', 'repository', 'recipe', 'message', 'title', 'description'].includes(key))) deny('Executable, arguments and environment cannot be supplied by the model')
    if (policy.approved !== true || !Array.isArray(policy.actions) || !policy.actions.includes(input.action) || !safeId(policy.actionApprovalId)) deny('Explicit scoped action approval is required')
    if (input.action !== 'validate' && policy.access !== 'write') deny('Write access is required for commit/publication')
    const { root, config } = configuration(input.repository)
    if (uncertain.has(input.repository)) deny('Previous action outcome is uncertain; manual recovery is required before retry')
    const baseline = baselines.get(input.repository)
    if (!baseline || baseline.error) deny(baseline?.error ?? 'No verified baseline')
    const current = inspectGit(root)
    if (!branchAllowed(current.branch) || current.branch === config.targetBranch) deny('Actions require an agent/ or sdd/ work branch, not the protected target')
    gitSync(root, ['merge-base', '--is-ancestor', baseline.head, current.head])
    if (staged(root).length) deny('Preexisting staged changes are not authorized')
    return { root, config, current }
  }
  function recipeConfig(root, config, name) {
    const recipe = config.validations?.[name]
    if (!safeId(name) || !Object.hasOwn(config.validations ?? {}, name) || !recipe || !isAbsolute(recipe.executable) || inside(policy.workspace, realpathSync(recipe.executable)) || !strings(recipe.args) || recipe.args.length > 64 || !Number.isFinite(recipe.timeoutSeconds) || recipe.timeoutSeconds <= 0 || recipe.timeoutSeconds > 3600) deny('Invalid or missing pinned validation recipe')
    if (!/^[a-f0-9]{64}$/i.test(recipe.executableSha256 ?? '') || hash(fileBytes(realpathSync(recipe.executable), 256 * 1024 * 1024).bytes) !== recipe.executableSha256.toLowerCase()) deny('Validation executable SHA256 pin mismatch')
    if (!recipe.pinnedFiles || !Object.keys(recipe.pinnedFiles).length) deny('Validation requires pinned recipe source files')
    for (const [name, sha] of Object.entries(recipe.pinnedFiles)) {
      if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/i.test(sha) || hash(fileBytes(checkedFile(root, name)).bytes) !== sha.toLowerCase()) deny('Validation recipe source SHA256 pin mismatch')
    }
    const env = environment()
    for (const [key, value] of Object.entries(recipe.env ?? {})) {
      if (!safeEnvKeys.has(key) || typeof value !== 'string' || value.length > 256 || value.includes('\0')) deny('Validation environment contains a disallowed variable')
      env[key] = value
    }
    return { recipe, env, pins: hash(JSON.stringify(recipe)) }
  }
  function requiredReceipts(alias, root, config, current, digest) {
    if (!Array.isArray(config.requiredValidations) || !config.requiredValidations.length) deny('Commit requires at least one configured required validation')
    for (const name of config.requiredValidations) {
      const pins = recipeConfig(root, config, name).pins
      const receipt = receipts.get(`${alias}:${name}`)
      if (!receipt || receipt.head !== current.head || receipt.branch !== current.branch || receipt.digest !== digest || receipt.pins !== pins) deny('Required validation is absent or stale for current source/HEAD/pins')
    }
  }
  async function gitMutate(root, args, signal, env = environment()) {
    return runProcess(GIT, [...SAFE_GIT, '-C', root, ...args], { cwd: root, env, signal, timeoutMs: 30_000, capture: false }, spawnProcess)
  }
  async function perform(input, signal) {
    let action = input?.action; let repository = input?.repository; let mutationStarted = false
    try {
      if (signal?.aborted) deny('Action cancelled before execution')
      const { root, config, current } = authorized(input)
      const source = sourceSnapshot(root)
      if (action === 'publish') deny('Publication disabled: dedicated pinned credential-helper and expected GitLab identity proof are not configured; no network request was attempted')
      if (action === 'validate') {
        receipts.delete(`${repository}:${input.recipe}`)
        const { recipe, env, pins } = recipeConfig(root, config, input.recipe)
        audit({ action, repository, outcome: 'started', recipe: input.recipe, head: current.head, digest: source.digest, pins })
        const run = await runProcess(realpathSync(recipe.executable), recipe.args, { cwd: root, env, signal, timeoutMs: recipe.timeoutSeconds * 1000, capture: false }, spawnProcess)
        const after = inspectGit(root)
        const afterSource = sourceSnapshot(root)
        const passed = run.code === 0 && !run.aborted && !run.timedOut && !run.overflow && !run.spawnError && current.head === after.head && current.branch === after.branch && source.digest === afterSource.digest && staged(root).length === 0
        const outcome = passed ? 'succeeded' : 'failed'
        const failure = run.spawnError ? 'recipe could not start' : run.aborted ? 'cancelled' : run.timedOut ? 'timeout' : run.overflow ? 'output limit exceeded' : run.code !== 0 ? `exit code ${run.code}` : 'source, index, branch or HEAD changed'
        audit({ action, repository, outcome, recipe: input.recipe, head: current.head, digest: source.digest, pins, exitCode: run.code, timedOut: !!run.timedOut, aborted: !!run.aborted, outputBytes: run.outputBytes })
        if (passed) receipts.set(`${repository}:${input.recipe}`, { head: current.head, branch: current.branch, digest: source.digest, pins })
        return { outcome, action, repository, passed, exitCode: run.code, summary: passed ? 'Pinned validation passed against unchanged source and HEAD.' : `Validation failed (${failure}); no passing receipt exists. Recipe output withheld because it may contain credentials.`, evidence: [...evidence] }
      }
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000 || input.message.includes('\0')) deny('Commit requires a bounded nonempty message')
      if (!config.author || typeof config.author.name !== 'string' || !config.author.name.trim() || typeof config.author.email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+$/.test(config.author.email) || /[\r\n\0<>]/.test(config.author.name)) deny('Pinned commit author is invalid')
      requiredReceipts(repository, root, config, current, source.digest)
      const changed = [...new Set([...nulList(gitSync(root, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'])), ...nulList(gitSync(root, ['ls-files', '--others', '--exclude-standard', '-z']))])].sort()
      if (!changed.length || changed.length > 200 || changed.join('').length > 64 * 1024) deny('Commit requires 1–200 explicitly enumerated changed source paths')
      for (const name of changed) checkedFile(root, name, true)
      audit({ action, repository, outcome: 'started', head: current.head, digest: source.digest, files: changed.length })
      mutationStarted = true
      const added = await gitMutate(root, ['add', '--', ...changed], signal)
      if (added.code !== 0 || added.aborted || added.timedOut || added.overflow) deny('Staging failed; index may need manual review (no reset was performed)')
      if (JSON.stringify(staged(root).sort()) !== JSON.stringify(changed) || sourceSnapshot(root).digest !== source.digest || inspectGit(root).head !== current.head) deny('Source/index/HEAD changed while staging; manual review required')
      const commitEnv = { ...environment(), GIT_AUTHOR_NAME: config.author.name, GIT_AUTHOR_EMAIL: config.author.email, GIT_COMMITTER_NAME: config.author.name, GIT_COMMITTER_EMAIL: config.author.email }
      const committed = await gitMutate(root, ['commit', '--no-gpg-sign', '--no-verify', '-m', input.message], signal, commitEnv)
      if (committed.code !== 0 || committed.aborted || committed.timedOut || committed.overflow) deny('Commit outcome requires manual review; no amend/reset/retry was attempted')
      const after = inspectGit(root)
      if (after.head === current.head || after.branch !== current.branch || gitSync(root, ['rev-parse', 'HEAD^']).trim() !== current.head || sourceSnapshot(root).digest !== source.digest || gitSync(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])) deny('Post-commit evidence is inconsistent; manual review required')
      audit({ action, repository, outcome: 'succeeded', head: after.head, parent: current.head, digest: source.digest, files: changed.length })
      return { outcome: 'succeeded', action, repository, head: after.head, summary: 'Committed only approved changed source files with pinned author and current required validations. No push or merge request was performed.', evidence: [...evidence] }
    } catch (error) {
      const summary = error instanceof Denied ? error.message : 'Action verification failed; no raw subprocess output is disclosed'
      if (mutationStarted) uncertain.add(repository)
      const outcome = mutationStarted ? 'unknown' : 'blocked'
      try { audit({ action: ['validate', 'commit', 'publish'].includes(action) ? action : 'invalid', repository: typeof repository === 'string' ? repository.slice(0, 100) : 'invalid', outcome, summary }) }
      catch { return { outcome: 'unknown', action, repository, summary: 'Action audit persistence failed; manual recovery is required', evidence: [...evidence] } }
      return { outcome, action, repository, summary, evidence: [...evidence] }
    }
  }
  return {
    evidence,
    execute(input, signal) {
      const operation = queue.then(() => perform(input, signal))
      queue = operation.then(() => undefined, () => undefined)
      return operation
    },
  }
}
