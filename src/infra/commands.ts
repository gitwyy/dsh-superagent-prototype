/** Subprocess wrapper for running gh, glab, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment, GitlabAccount } from '../deployment.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/** `--input` takes a file, so each JSON body is written under a name of its own. */
const GitlabBody = { sequence: 0 }
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, the response body a
 * CLI printed to standard output, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number, readonly output?: string) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  const stdout = error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode, stdout)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode, stdout)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode, stdout)
}
/** Rewrites a failed GitLab call with the message of the JSON body glab prints to standard output, whose stderr often says only `glab: HTTP 404`. */
export function gitlabError(error: unknown): unknown {
  if (!(error instanceof CliError) || !error.output) return error
  const at = error.output.indexOf('{')
  let body: Record<string, unknown> | undefined
  try { body = at < 0 ? undefined : JSON.parse(error.output.slice(at)) as Record<string, unknown> } catch { /* Not a JSON body. */ }
  const message = body && (typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : undefined)
  return message ? new CliError(`${message}${error.code ? ` (HTTP ${error.code})` : ''}`, error.code, error.exitCode) : error
}
/**
 * Parses the JSON values glab prints for an API list: one page's array, a single object, NDJSON lines (what `--paginate
 * --output ndjson` gives as one flattened stream), or the pages `--paginate` concatenates as separate arrays.
 */
export function gitlabItems(output: string): unknown[] {
  const text = output.trim()
  if (!text) return []
  const values: unknown[] = []
  const flatten = (value: unknown): void => { if (Array.isArray(value)) values.push(...value); else values.push(value) }
  try { flatten(JSON.parse(text)); return values } catch { /* Values printed one after another are scanned below. */ }
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index]!)) index++
    if (index >= text.length) break
    const start = index
    let depth = 0
    let quoted = false
    let escaped = false
    for (; index < text.length; index++) {
      const char = text[index]!
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') quoted = true
      else if (char === '[' || char === '{') depth++
      else if (char === ']' || char === '}') { depth--; if (depth === 0) { index++; break } }
    }
    let value: unknown
    try { value = JSON.parse(text.slice(start, index)) } catch { throw new Error('glab printed output that is not JSON') }
    flatten(value)
  }
  return values
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/**
 * Executes gh, glab, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and GitLab API calls to the configured instance and project, and
 * translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  async run(program: string, args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      return stdout
    } catch (error) { throw commandError(error, program) }
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.githubCli(), args)) as T }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.githubCli(), ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** The GitHub CLI of the resolved deployment, for the GitHub Source's calls; a deployment without one reads no GitHub. */
  private githubCli(): string {
    const github = this.deployment.github
    if (!github) throw new Error('The GitHub Source has no working CLI')
    return github.cli
  }
  /**
   * Calls the GitLab API on a path within the configured project (or on one of the instance-wide endpoints), always naming
   * the instance because glab defaults to gitlab.com. With a schema, parses the JSON the call prints; without one, returns
   * its raw output (such as a repository file).
   * @throws CliError with GitLab's HTTP status as `code` and the message of its JSON error body.
   */
  async gitlabApi<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async gitlabApi(path: string, ...flags: string[]): Promise<string>
  async gitlabApi<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    // Without a schema the path is the first argument; with one, the schema is and the path follows it.
    const raw = typeof schema === 'string'
    const [path = '', ...flags] = raw ? [schema, ...rest] : rest
    const output = await this.gitlabRun(path, flags)
    return raw ? output : (schema as z.ZodType<T>).parse(JSON.parse(output))
  }
  /**
   * Fetches every page of a GitLab API list as one flat stream: `--paginate --output ndjson` prints each element on its own
   * line, whereas `--paginate` with the default output concatenates one JSON array per page.
   * @param tally - counts items that fail schema validation instead of failing the read.
   */
  async gitlabPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    return validItems(item, gitlabItems(await this.gitlabRun(path, ['--paginate', '--output', 'ndjson'])), tally)
  }
  /**
   * Sends a JSON body to a GitLab API endpoint, which arrays and nested objects require: `--raw-field` cannot express them.
   * The body goes through `--input` with an explicit JSON content type, because glab answers HTTP 415 without it.
   */
  async gitlabPost<T>(schema: z.ZodType<T>, path: string, body: unknown, ...flags: string[]): Promise<T> {
    const file = join(tmpdir(), `dsh-glab-${process.pid}-${++GitlabBody.sequence}.json`)
    await writeFile(file, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 })
    try {
      const output = await this.gitlabRun(path, ['--method', 'POST', '-H', 'Content-Type: application/json', '--input', file, ...flags])
      return schema.parse(JSON.parse(output))
    } finally { await unlink(file).catch(() => { /* The body was already sent. */ }) }
  }
  /** Runs the agent's glab wrapper and maps a GitLab failure to the message of its JSON error body. */
  private async gitlabRun(path: string, flags: string[]): Promise<string> {
    const account = this.gitlabAccount()
    return this.run(account.cli, ['api', this.gitlabPath(path), '--hostname', account.host, ...flags])
      .catch((error: unknown) => { throw gitlabError(error) })
  }
  private gitlabAccount(): GitlabAccount {
    const gitlab = this.deployment.gitlab
    if (!gitlab) throw new Error('The GitLab Source has no working CLI')
    return gitlab
  }
  /**
   * Resolves a path relative to the configured project (encoded, since a raw slash in the project path is not accepted),
   * accepts a full path for this project alone, and allows only a small allowlist of instance-wide endpoints.
   */
  private gitlabPath(path: string): string {
    if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)) throw new Error('GitLab calls are restricted to the configured instance and project')
    const account = this.gitlabAccount()
    const project = `projects/${encodeURIComponent(account.project)}`
    if (!path) return project
    if (/^(?:user|version|todos|todo\/|users\/|notification_settings|markdown)(?:[?/]|$)/.test(path)) return path
    const own = [`projects/${encodeURIComponent(account.project)}`, `projects/${account.projectId}`]
    const projectPath = (prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)
    if (own.some(projectPath)) return path
    if (path.startsWith('projects/')) throw new Error('GitLab calls are restricted to the configured project')
    return `${project}/${path}`
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
