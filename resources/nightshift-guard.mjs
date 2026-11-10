/** Pi 1.5 extension. A narrow tool policy, NOT an OS sandbox.
 * Only this explicit extension is loaded: untrusted extensions can act at import time.
 * Builtin bash creates detached groups and honors user command prefixes, so it is
 * replaced, not filtered. Our git children remain in the supervised Pi group.
 * No network, commits, external messaging, build scripts, subagents or arbitrary shell.
 */
import { execFileSync, spawn } from 'node:child_process'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { callNightHost } from './nightshift-client.mjs'

const TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'night_action', 'night_release']
const MAX_FILE = 1024 * 1024
const MAX_OUTPUT = 32 * 1024
const SAFE_GIT = ['--no-replace-objects', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'diff.submodule=short', '-c', 'log.showSignature=false', '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', '-c', 'credential.helper=']
const inside = (root, path) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)) }
const deniedPart = part => ['.git', '.pi', '.ssh', '.aws', '.config', '.superagent-nightshift.lock', 'node_modules'].includes(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || /(?:^|[._-])(credentials?|secrets?|tokens?)(?:[._-]|$)/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part)
const textResult = text => ({ content: [{ type: 'text', text: String(text).slice(0, MAX_OUTPUT) }], details: {} })
const string = description => ({ type: 'string', description })
const number = { type: 'integer', minimum: 1, maximum: 10000 }
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })

export function createGuard(policy) {
  if (!policy || typeof policy.runId !== 'string' || !isAbsolute(policy.workspace) || !Array.isArray(policy.repositories) || !policy.repositories.length) throw new Error('Invalid nightshift policy')
  const roots = policy.repositories.map(repo => {
    if (!isAbsolute(repo) || realpathSync(repo) !== repo || !inside(policy.workspace, repo)) throw new Error('Invalid repository root')
    return repo
  })
  const registered = (policy.registry ?? roots).map(root => {
    if (!isAbsolute(root) || realpathSync(root) !== root || !inside(policy.workspace, root)) throw new Error('Invalid registered repository')
    return root
  }).sort((a, b) => b.length - a.length)
  const readRoots = (policy.readOnlyRoots ?? []).map(root => {
    if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error('Invalid harness root')
    return root
  })
  const gitEnv = { PATH: '/usr/bin:/bin', HOME: policy.piHome, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  // Read only the parent index: never ask status to inspect nested worktrees/configs.
  // This also catches uninitialized gitlinks and directories whose .git was removed.
  const gitlinks = new Map(roots.map(root => {
    let index
    try {
      index = execFileSync('/usr/bin/git', [...SAFE_GIT, '-C', root, 'ls-files', '--stage', '-z'], {
        env: gitEnv, shell: false, timeout: 5_000, maxBuffer: 8 * MAX_FILE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch { throw new Error('Cannot verify repository gitlink boundaries') }
    const links = index.split('\0').filter(entry => entry.startsWith('160000 ')).map(entry => {
      const tab = entry.indexOf('\t')
      if (tab < 0) throw new Error('Invalid gitlink index entry')
      const path = resolve(root, entry.slice(tab + 1))
      if (!inside(root, path) || path === root) throw new Error('Invalid gitlink path')
      return path
    })
    return [root, links]
  }))
  function checkedPath(input, write = false) {
    if (typeof input !== 'string' || input.includes('\0') || input.length > 4096) throw new Error('Invalid path')
    const path = resolve(policy.workspace, input)
    const owner = registered.find(root => inside(root, path))
    const root = owner && roots.includes(owner) ? owner : (!owner && !write ? readRoots.find(root => inside(root, path)) : undefined)
    if (!root) throw new Error('Path is outside the approved repository scope')
    if ((gitlinks.get(root) ?? []).some(link => inside(link, path))) throw new Error('Submodule gitlinks require a separate registered and approved repository scope')
    const parts = relative(root, path).split(sep).filter(Boolean)
    if (parts.some(deniedPart)) throw new Error('Protected metadata or credential path')
    // Reject every existing symlink and hard-linked file, even links within a repo.
    let cursor = root
    for (const part of ['', ...parts]) {
      cursor = part ? resolve(cursor, part) : cursor
      try {
        const info = lstatSync(cursor)
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink > 1)) throw new Error('Symlinks, hardlinks and special files are not allowed')
        if (cursor !== root && info.isDirectory() && existsSync(resolve(cursor, '.git'))) throw new Error('Nested Git repositories need a separate explicit task scope')
      } catch (error) { if (error.code !== 'ENOENT') throw error; if (!write) throw new Error('Path does not exist') }
    }
    if (write && !(policy.access === 'write' && policy.approved === true)) throw new Error('Scoped write approval required')
    if (write && /(^|\/)(?:\.gitlab(?:\/|-ci)|\.github\/|Jenkinsfile|Dockerfile|\.mvn\/|\.npmrc|\.yarnrc|\.gitmodules|\.gitattributes|deploy(?:\/|\.)|release(?:\/|\.))/i.test(relative(root, path))) throw new Error('Release control-plane changes require a separate operator-reviewed task')
    return { path, root }
  }
  async function gitRaw(root, args, signal) {
    return await new Promise((resolveResult, reject) => {
      // No shell, no detached process. Inputs only come from the grammar below.
      const child = spawn('/usr/bin/git', [...SAFE_GIT, '-C', root, ...args], { env: gitEnv, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; let overflow = false
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      const abort = () => child.kill('SIGKILL')
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > MAX_FILE) { overflow = true; child.kill('SIGKILL') } })
      child.stderr.resume() // Never forward config/credential-bearing diagnostics.
      child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Git failed to start')) })
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort)
        if (code !== 0 || overflow || signal?.aborted) reject(new Error('Guarded git operation failed'))
        else resolveResult(output)
      })
    })
  }
  async function git(root, args, signal) {
    const keys = await gitRaw(root, ['config', '--no-includes', '--name-only', '--list'], signal)
    if (keys.split('\n').some(key => /^(?:include\.path|includeif\..+\.path|filter\..+\.(?:clean|smudge|process)|core\.worktree|core\.sshcommand)$/i.test(key))) throw new Error('Executable Git filters/SSH or mutable includes/worktree configuration is unsupported')
    return gitRaw(root, args, signal)
  }
  async function writable(path, signal) {
    const checked = checkedPath(path, true)
    const branch = (await git(checked.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).trim()
    if (!/^(?:sdd|agent)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) throw new Error('Writes require an sdd/ or agent/ branch; master/main and detached HEAD are protected')
    return checkedPath(path, true)
  }
  function read(path) {
    const checked = checkedPath(path)
    const fd = openSync(checked.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink > 1 || info.size > MAX_FILE) throw new Error('Read requires a regular file of at most 1 MiB')
      const value = readFileSync(fd, 'utf8')
      if (value.includes('\0')) throw new Error('Binary files are not supported')
      return value
    } finally { closeSync(fd) }
  }
  function files(root) {
    const result = []; let visits = 0
    function walk(path) {
      if (++visits > 2000 || result.length >= 500) return
      const checked = checkedPath(path)
      if (lstatSync(checked.path).isFile()) { result.push(checked.path); return }
      for (const entry of readdirSync(checked.path).sort()) {
        if (deniedPart(entry)) continue
        const next = resolve(checked.path, entry)
        try { checkedPath(next); if (lstatSync(next).isDirectory()) walk(next); else if (lstatSync(next).isFile()) result.push(next) } catch { /* omit protected links */ }
        if (++visits > 2000 || result.length >= 500) return
      }
    }
    walk(root)
    return result
  }
  // Lexer supports plain/single-quoted words only, no escapes, expansion or shell operators.
  function words(command) {
    if (typeof command !== 'string' || command.length > 4096 || /[\n\r\0]/.test(command)) throw new Error('Unsupported command grammar')
    const result = []; let index = 0
    while (index < command.length) {
      while (command[index] === ' ') index++
      if (index === command.length) break
      let word = ''
      if (command[index] === "'") {
        const end = command.indexOf("'", ++index)
        if (end < 0) throw new Error('Unclosed quote')
        word = command.slice(index, end); index = end + 1
        if (index < command.length && command[index] !== ' ') throw new Error('Unsupported concatenation')
      } else {
        while (index < command.length && command[index] !== ' ') word += command[index++]
        if (!/^[a-zA-Z0-9_./:@=-]+$/.test(word)) throw new Error('Shell operators and expansions are not supported')
      }
      result.push(word)
    }
    return result
  }
  async function bash(input, signal) {
    const argv = words(input.command)
    if (argv[0] !== 'git' || argv[1] !== '-C' || argv.length < 4) throw new Error('Only git -C <approved-repo> with the documented operations is supported')
    const { path, root } = checkedPath(argv[2])
    if (path !== root || !roots.includes(root)) throw new Error('Git requires an exact approved repository root')
    const args = argv.slice(3)
    let operation
    if (args.join(' ') === 'status --short') operation = ['status', '--short', '--untracked-files=all', '--ignore-submodules=all']
    else if (args.join(' ') === 'branch --show-current') operation = ['branch', '--show-current']
    else if (args.join(' ') === 'log -5 --oneline') operation = ['log', '-5', '--oneline', '--no-decorate']
    else if (args[0] === 'diff' && args[1] === '--' && args.length === 3) {
      const file = checkedPath(resolve(root, args[2]))
      if (file.root !== root || !lstatSync(file.path).isFile()) throw new Error('Diff requires one approved regular file, not a directory')
      operation = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--', relative(root, file.path)]
    } else if (args.length === 3 && args[0] === 'switch' && args[1] === '-c' && /^(?:sdd|agent)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(args[2])) {
      checkedPath(root, true)
      if (args[2].includes('..') || args[2].endsWith('/') || args[2].endsWith('.lock')) throw new Error('Invalid branch name')
      if ((await git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'], signal)).trim()) throw new Error('Branch creation requires a clean worktree')
      // Creates a new branch from current HEAD only: no target checkout, hooks, merge or remote.
      operation = ['switch', '--no-guess', '--no-recurse-submodules', '-c', args[2]]
    } else throw new Error('Command is not allowlisted; builds, network, commit, merge, push, deploy and messaging are disabled')
    return textResult(await git(root, operation, signal))
  }
  async function execute(tool, input, signal) {
    if (!TOOLS.includes(tool)) throw new Error('Unknown, MCP and subagent tools are disabled')
    if (tool === 'bash') return bash(input, signal)
    if (tool === 'read') {
      const lines = read(input.path).split('\n')
      const start = Math.max(0, (input.offset ?? 1) - 1)
      return textResult(lines.slice(start, start + Math.min(input.limit ?? 200, 1000)).map((line, i) => `${start + i + 1}: ${line}`).join('\n'))
    }
    if (tool === 'ls') {
      const { path } = checkedPath(input.path)
      return textResult(readdirSync(path).filter(entry => { try { checkedPath(resolve(path, entry)); return true } catch { return false } }).slice(0, 200).join('\n'))
    }
    if (tool === 'find' || tool === 'grep') {
      const { path } = checkedPath(input.path)
      if (typeof input.pattern !== 'string' || input.pattern.length > 200) throw new Error('Pattern must be at most 200 characters')
      const hits = []
      // Literal substring matching avoids regexp backtracking and glob traversal surprises.
      for (const file of files(path)) {
        if (tool === 'find') { if (relative(path, file).includes(input.pattern)) hits.push(relative(policy.workspace, file)) }
        else {
          let content
          try { content = read(file) } catch { continue }
          content.split('\n').forEach((line, i) => { if (line.includes(input.pattern) && hits.length < 100) hits.push(`${relative(policy.workspace, file)}:${i + 1}: ${line.slice(0, 300)}`) })
        }
        if (hits.length >= 100) break
      }
      return textResult(`${hits.slice(0, 100).join('\n')}\n[Bounded search: at most 500 files / 100 matches; protected paths omitted.]`)
    }
    const { path } = await writable(input.path, signal)
    let content = input.content
    if (tool === 'edit') {
      if (typeof input.oldText !== 'string' || input.oldText.length === 0 || typeof input.newText !== 'string') throw new Error('Edit requires nonempty oldText and newText')
      const old = read(path)
      const at = old.indexOf(input.oldText)
      if (at < 0 || old.indexOf(input.oldText, at + 1) >= 0) throw new Error('oldText must match exactly once')
      content = old.slice(0, at) + input.newText + old.slice(at + input.oldText.length)
    }
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE || content.includes('\0')) throw new Error('Write requires text of at most 1 MiB')
    mkdirSync(dirname(path), { recursive: true })
    checkedPath(path, true)
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink > 1) throw new Error('Write target must be a regular non-hardlinked file')
      // Truncation is delayed until after validating the opened descriptor.
      ftruncateSync(fd, 0); writeFileSync(fd, content, 'utf8'); fsyncSync(fd)
    } finally { closeSync(fd) }
    return textResult('File updated; no build, commit or deployment was performed.')
  }
  return { checkedPath, execute }
}

export default function nightshiftGuard(pi) {
  const policy = JSON.parse(process.env.NIGHTSHIFT_POLICY ?? 'null')
  const guard = createGuard(policy)
  const host = policy.hostActions
  let ready = false
  let queue = Promise.resolve()
  const blocked = ctx => { ready = false; ctx.ui.setStatus('nightshift-guard', `${policy.runId}:blocked`) }
  pi.on('project_trust', () => ({ trusted: 'no' }))
  pi.on('session_start', (_event, ctx) => {
    if (ctx.cwd !== policy.workspace || ctx.sessionManager.getSessionFile() !== policy.sessionFile) throw new Error('Nightshift fixed workspace/session mismatch')
    pi.setActiveTools(TOOLS)
    ready = true
    ctx.ui.setStatus('nightshift-guard', `${policy.runId}:ready`)
  })
  pi.on('session_before_switch', () => ({ cancel: true }))
  pi.on('session_before_fork', () => ({ cancel: true }))
  pi.on('user_bash', (_event, ctx) => { blocked(ctx); return { result: { output: 'User shell execution disabled', exitCode: 1, cancelled: false, truncated: false } } })
  pi.on('tool_call', (event, ctx) => {
    if (!ready || !TOOLS.includes(event.toolName) || event.parentToolCallId) {
      blocked(ctx)
      return { block: true, reason: 'Nightshift permits only direct guarded tools', terminate: true }
    }
  })
  const definitions = [
    ['night_release', 'Request a host-brokered task-preauthorized push, MR creation, merge, or observation of its existing auto-deployment. Acceptance is not completion; deployment does not trigger another Jenkins build.', schema({ action: { type: 'string', enum: ['push', 'create_mr', 'merge', 'deploy'] }, repository: string('Exact task-granted repository alias'), sha: string('Exact 40-character commit SHA with host commit receipts'), title: string('Required for MR creation'), description: string('Optional MR description; system marker is added by host') }, ['action', 'repository', 'sha'])],
    ['night_action', 'Run a separately approved host-side fixed validation recipe or scoped local commit. No arbitrary commands; validation failures are evidence, not success.', schema({ action: { type: 'string', enum: ['validate', 'commit', 'publish'] }, repository: string('Task-approved repository alias'), recipe: string('Operator-configured validation name'), message: string('Commit message; only for commit'), title: string('MR title; publication currently disabled'), description: string('MR description; publication currently disabled') }, ['action', 'repository'])],
    ['read', 'Read repository text with line numbers; credential and metadata paths are excluded.', schema({ path: string('Absolute or workspace-relative file'), offset: number, limit: number }, ['path'])],
    ['ls', 'List approved repository directory entries, excluding protected paths.', schema({ path: string('Absolute or workspace-relative directory') }, ['path'])],
    ['find', 'Find repository paths by literal substring (not glob); bounded to 500 files and 100 matches.', schema({ path: string('Approved directory'), pattern: string('Literal path substring') }, ['path', 'pattern'])],
    ['grep', 'Search repository text by literal substring (not regex); bounded to 500 files and 100 matches.', schema({ path: string('Approved directory or file'), pattern: string('Literal text substring') }, ['path', 'pattern'])],
    ['bash', 'Run only git -C <repo> status --short, branch --show-current, log -5 --oneline, diff -- <file>, or approved switch -c sdd/<name>|agent/<name>. No shell, scripts, network or other commands.', schema({ command: string('Use plain or single-quoted arguments; exact repository root required') }, ['command'])],
    ['write', 'Write repository text with scoped approval on sdd/ or agent/ branches; protected files excluded.', schema({ path: string('Approved file'), content: string('UTF-8 content, at most 1 MiB') }, ['path', 'content'])],
    ['edit', 'Replace one exact text match with scoped approval on sdd/ or agent/ branches.', schema({ path: string('Approved file'), oldText: string('Nonempty text matching exactly once'), newText: string('Replacement text') }, ['path', 'oldText', 'newText'])],
  ]
  for (const [name, description, parameters] of definitions) {
    pi.registerTool({ name, label: `Guarded ${name}`, description, parameters,
      execute(_id, input, signal, _update, ctx) {
        const operation = queue.then(async () => {
          try {
            if (!ready || signal?.aborted) throw new Error('Guard not ready or operation cancelled')
            if (name === 'night_action' || name === 'night_release') {
              if (!host) throw new Error('No host action capability available')
              const result = await callNightHost(host, name === 'night_action' ? 'action' : 'release', input, signal)
              const state = result.outcome ?? result.status
              if (state === 'unknown') { ready = false; ctx.ui.setStatus('nightshift-guard', `${policy.runId}:unknown`) }
              else if (state === 'blocked') blocked(ctx)
              return { ...textResult(JSON.stringify(result)), isError: state === 'blocked' || state === 'unknown' }
            }
            return await guard.execute(name, input, signal)
          } catch (error) {
            blocked(ctx)
            return { ...textResult(`BLOCKED: ${error instanceof Error ? error.message : 'Guard validation failed'}`), isError: true }
          }
        })
        queue = operation.then(() => undefined, () => undefined)
        return operation
      },
    })
  }
}
