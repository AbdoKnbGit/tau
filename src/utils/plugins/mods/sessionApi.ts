import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  getOriginalCwd,
  getTotalCostUSD,
  getTotalDuration,
  getIsInteractive,
} from '../../../bootstrap/state.js'
import type { ModRecord } from './runtime.js'
import { getModSessionBinding, runWhenModTurnIdle } from './sessionState.js'

const MAX_BYTES = 4 * 1024 * 1024
const isRecord = (value: unknown): value is ModRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The git repository the session runs in, read from the working copy now
 * (not the session's cached HEAD watcher, which a short run must not start). */
export async function readSessionRepo(): Promise<ModRecord | null> {
  const [{ findGitRoot, gitExe }, { execFileNoThrowWithCwd }] = await Promise.all([
    import('../../git.js'),
    import('../../execFileNoThrow.js'),
  ])
  const root = findGitRoot(getOriginalCwd())
  if (!root) return null
  const read = await execFileNoThrowWithCwd(gitExe(), ['config', '--get', 'remote.origin.url'], { cwd: root })
    .catch(() => ({ code: 1, stdout: '' }))
  const remote = read.code === 0 && read.stdout.trim() ? read.stdout.trim() : null
  // owner/repo from the usual remote spellings (https, ssh, scp-like).
  const match = remote?.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)
  return { root, remote, internal: false, name: match?.[1] ?? null }
}

/** The context window's fill, the plan limits and the cost, as the status
 * line has them. Nothing is sent to count them. */
export async function readSessionUsage(): Promise<ModRecord> {
  const binding = getModSessionBinding()
  const { getMainLoopModel } = await import('../../model/model.js')
  const model = binding?.getModel() ?? getMainLoopModel()
  const [{ getCurrentUsage }, { getContextWindowForModel, calculateContextPercentages }, { getRawUtilization }] =
    await Promise.all([import('../../tokens.js'), import('../../context.js'), import('../../../services/claudeAiLimits.js')])
  const usage = getCurrentUsage([...(binding?.getMessages() ?? [])])
  const window = getContextWindowForModel(model)
  const { used } = calculateContextPercentages(usage, window)
  const tokens = usage
    ? usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
    : undefined
  const raw = getRawUtilization() as Record<string, { utilization?: number; resets_at?: number } | undefined>
  const rateLimits = Object.entries(raw).flatMap(([kind, value]) =>
    value && typeof value.utilization === 'number'
      ? [{
          kind,
          percentUsed: Math.round(value.utilization * 100),
          ...(typeof value.resets_at === 'number'
            ? { resetsAt: new Date(value.resets_at * 1000).toISOString() }
            : {}),
        }]
      : [])
  return {
    startedAt: new Date(Date.now() - getTotalDuration()).toISOString(),
    context: {
      ...(tokens !== undefined ? { tokens } : {}),
      window,
      ...(used !== null ? { percent: used } : {}),
    },
    rateLimits,
    cost: { usd: getTotalCostUSD() },
  }
}

// Credentials stay in this process: a mod holds only an opaque handle that
// http.fetch spends against first-party Anthropic hosts over https.
const authorizations = new Map<string, () => Promise<{ name: string; value: string } | null>>()
const FIRST_PARTY = /^(?:api\.anthropic\.com|claude\.ai|api\.claude\.ai)$/i

export async function authorizeSession(): Promise<ModRecord | null> {
  const [{ getAPIProvider }, auth] = await Promise.all([
    import('../../model/providers.js'),
    import('../../auth.js'),
  ])
  if (getAPIProvider() !== 'firstParty') return null
  const key = auth.getAnthropicApiKey()
  const tokens = key ? null : auth.getClaudeAIOAuthTokens()
  if (!key && !tokens?.accessToken) return null
  const handle = 'auth_' + randomUUID()
  authorizations.set(handle, async () => {
    const current = auth.getAnthropicApiKey()
    if (current) return { name: 'x-api-key', value: current }
    const token = auth.getClaudeAIOAuthTokens()?.accessToken
    return token ? { name: 'authorization', value: `Bearer ${token}` } : null
  })
  return { handle, kind: key ? 'api-key' : 'bearer' }
}

/** How the session is signed in, for a mod the organization's managed
 * settings install; any other mod is refused. No request is made. */
export async function readSessionIdentity(isManaged: boolean): Promise<ModRecord> {
  if (!isManaged)
    return { deny: 'only a mod installed by managed settings can read the session identity' }
  const [{ getAPIProvider }, auth] = await Promise.all([
    import('../../model/providers.js'),
    import('../../auth.js'),
  ])
  const provider = getAPIProvider()
  const kind = provider !== 'firstParty'
    ? provider
    : auth.getAnthropicApiKey()
      ? 'api-key'
      : auth.getClaudeAIOAuthTokens()?.accessToken
        ? 'oauth'
        : 'none'
  return { kind, isVerified: false }
}

/** Appends a row to the main conversation: a user-role row the model reads
 * (not shown as typed), or a notice it never reads. Text blocks only. */
export async function appendSessionRow(input: unknown): Promise<ModRecord> {
  if (!isRecord(input) || !isRecord(input.message))
    throw new Error('session.append takes { message: { type, content } }')
  const { message } = input
  if (input.agentId !== undefined)
    return { deny: 'appending to a subagent conversation is not supported' }
  if (message.type !== 'user' && message.type !== 'system')
    return { deny: 'a row is of type user or system' }
  if (!Array.isArray(message.content) || !message.content.length ||
      message.content.some(block => !isRecord(block) || block.type !== 'text' || typeof block.text !== 'string'))
    return { deny: 'a row holds text blocks only in this release' }
  const binding = getModSessionBinding()
  if (!binding?.setMessages) return { deny: 'the session keeps no conversation to append to' }
  const text = message.content.map((block: ModRecord) => block.text as string).join('\n')
  const [{ createUserMessage }, { createModNoticeMessage }] = await Promise.all([
    import('../../messages.js'),
    import('./lifecycle.js'),
  ])
  const row = message.type === 'user'
    ? createUserMessage({ content: message.content.map((block: ModRecord) => ({ type: 'text', text: block.text })), isMeta: true })
    : createModNoticeMessage(text)
  return new Promise(done => {
    const append = () => {
      const current = getModSessionBinding()
      if (current !== binding || !binding.setMessages) {
        done({ deny: 'the session changed before the row was appended' })
        return
      }
      binding.setMessages([...binding.getMessages(), row])
      done({ message: { type: message.type, content: message.content }, uuid: row.uuid })
    }
    // Never between a tool call and its result: a running turn's rows land first.
    runWhenModTurnIdle(append)
  })
}

export function readPromptBox(): ModRecord {
  return getModSessionBinding()?.readPrompt?.() ?? { text: '', cursor: 0 }
}

export function fillPromptBox(input: unknown): ModRecord {
  if (!isRecord(input) || typeof input.text !== 'string')
    throw new Error('prompt.fill takes { text, mode }')
  const mode = input.mode ?? 'replace'
  if (!['replace', 'append', 'insert'].includes(mode))
    throw new Error('prompt.fill mode is replace, append or insert')
  const binding = getModSessionBinding()
  const filled = binding?.fillPrompt?.(input.text, mode)
  const box = readPromptBox()
  return { isFilled: filled === true, text: box.text, cursor: box.cursor }
}

export function suggestPrompt(input: unknown): ModRecord {
  if (!isRecord(input) || typeof input.text !== 'string' || !input.text.trim())
    throw new Error('prompt.suggest takes { text }')
  return { isShown: getModSessionBinding()?.suggestPrompt?.(input.text) === true }
}

/**
 * The named instruction files in each directory from the walk's start down
 * to the working directory (or `of`'s directory), root first, each with the
 * files its `@` imports bring, as the engine reads CLAUDE.md.
 */
export async function readAncestors(input: unknown, resolvePath: (path: string) => string): Promise<ModRecord[]> {
  if (!isRecord(input) || !Array.isArray(input.names) || !input.names.length ||
      input.names.some(name => typeof name !== 'string' || !name.endsWith('.md') || isAbsolute(name) || name.split(/[\\/]/).includes('..')))
    throw new Error('fs.ancestors takes { names } of relative .md file names')
  const end = input.of === undefined ? getOriginalCwd() : dirname(resolvePath(String(input.of)))
  const below = input.below === undefined ? undefined : resolvePath(String(input.below))
  const directories: string[] = []
  for (let dir = resolve(end); ; dir = dirname(dir)) {
    if (below !== undefined) {
      const inside = relative(below, dir)
      // Strictly inside `below`: the directory itself is not read.
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) break
    }
    directories.unshift(dir)
    if (dirname(dir) === dir) break
  }
  const { processMemoryFile } = await import('../../claudemd.js')
  const found: ModRecord[] = []
  for (const dir of directories)
    for (const name of input.names as string[]) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      const parts = await processMemoryFile(path, 'Project', new Set(), false)
      if (!parts.length) continue
      found.push({
        dir,
        name,
        content: parts.map(part => part.content).join('\n\n'),
        parts: parts.map(part => ({ path: part.path, content: part.content })),
      })
    }
  return found
}

/** OSC 52 sequences longer than this are past what terminals take. */
const OSC52_LIMIT = 1024 * 1024

/**
 * `$.ui.copy`: the text on the clipboard of a surface the session draws on,
 * as /copy writes it (a clipboard tool, tmux's buffer, OSC 52).
 */
export async function copyForMod(event: ModRecord): Promise<ModRecord> {
  const binding = getModSessionBinding()
  const drawing = !!binding?.appendNotice && getIsInteractive()
  const surface = event.surface ?? (drawing ? 'terminal' : undefined)
  if (!drawing || surface !== 'terminal') return { isCopied: false, reason: 'no-surface' }
  const { copyClipboardText } = await import('../../../ink/termio/osc.js')
  const { sequence, path } = await copyClipboardText(String(event.text))
  if (path === 'osc52' && sequence.length > OSC52_LIMIT) return { isCopied: false, reason: 'no-clipboard' }
  if (sequence) process.stdout.write(sequence)
  return { isCopied: true }
}

const KEPT_ACROSS_ORIGINS = new Set(['accept', 'accept-language', 'content-type', 'user-agent'])

/**
 * `$.http.fetch`: http or https through the host's own network stack (its
 * proxy settings included), up to five redirects, thirty seconds in all, and
 * 4 MiB of request and response body. `binary` (the engine's own fetch of
 * an audio clip) answers the body as bytes, refusing one over the limit.
 */
export async function modHttpFetch(url: unknown, init: unknown, signal: AbortSignal, binary = false): Promise<ModRecord> {
  if (typeof url !== 'string') throw new Error('http.fetch requires a URL')
  const options = init === undefined ? {} : init
  if (!isRecord(options)) throw new Error('http.fetch init must be an object')
  let target = new URL(url)
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    throw new Error('http.fetch reaches http and https URLs only')
  let method = typeof options.method === 'string' ? options.method.toUpperCase() : 'GET'
  let body = options.body
  if (body !== undefined && typeof body !== 'string') throw new Error('http.fetch body must be a string')
  if (typeof body === 'string' && body.length > MAX_BYTES)
    throw new Error(`http.fetch body is over the ${MAX_BYTES}-character limit`)
  if (options.headers !== undefined && (!isRecord(options.headers) || Object.values(options.headers).some(value => typeof value !== 'string')))
    throw new Error('http.fetch headers must be strings')
  let headers: Record<string, string> = Object.fromEntries(
    Object.entries((options.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]))
  let credential: { name: string; value: string } | null = null
  if (options.auth !== undefined) {
    const resolveCredential = typeof options.auth === 'string' ? authorizations.get(options.auth) : undefined
    if (!resolveCredential) throw new Error('http.fetch auth is not a handle from $.session.authorize()')
    if (target.protocol !== 'https:' || !FIRST_PARTY.test(target.hostname))
      throw new Error('http.fetch spends an auth handle only on https to a first-party Anthropic host')
    credential = await resolveCredential()
    if (!credential) throw new Error('the session no longer holds that credential')
  }
  let dispatcher: unknown
  if (options.socketPath !== undefined) {
    if (typeof options.socketPath !== 'string' || !options.socketPath)
      throw new Error('http.fetch socketPath must be a path')
    const { Agent } = await import('undici')
    dispatcher = new Agent({ connect: { socketPath: options.socketPath } })
  }
  const timeout = AbortSignal.timeout(30_000)
  const combined = AbortSignal.any([signal, timeout])
  const origin = target.origin
  try {
    for (let redirects = 0; ; redirects++) {
      const sent = { ...headers, ...(credential && target.origin === origin ? { [credential.name]: credential.value } : {}) }
      const response = await fetch(target, {
        method,
        headers: sent,
        ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
        redirect: 'manual',
        signal: combined,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit)
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {})
        if (redirects >= 5) throw new Error('http.fetch followed five redirects')
        const next = new URL(location, target)
        if (next.protocol !== 'http:' && next.protocol !== 'https:')
          throw new Error('http.fetch redirect left http and https')
        // A different origin keeps only content negotiation headers; the
        // credential never follows a redirect off its own origin.
        if (next.origin !== target.origin)
          headers = Object.fromEntries(Object.entries(headers).filter(([key]) => KEPT_ACROSS_ORIGINS.has(key)))
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = method === 'HEAD' ? 'HEAD' : 'GET'
          body = undefined
          delete headers['content-type']
        }
        target = next
        continue
      }
      const declared = Number(response.headers.get('content-length'))
      if (method !== 'HEAD' && Number.isFinite(declared) && declared > MAX_BYTES) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`http.fetch response of ${declared} bytes is over the ${MAX_BYTES}-byte limit`)
      }
      const chunks: Buffer[] = []
      let size = 0
      if (response.body) {
        const reader = response.body.getReader()
        while (size < MAX_BYTES) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = Buffer.from(value)
          chunks.push(chunk.subarray(0, MAX_BYTES - size))
          size += chunk.byteLength
        }
        await reader.cancel().catch(() => {})
      }
      if (binary && size > MAX_BYTES)
        throw new Error(`the response is over the ${MAX_BYTES}-byte limit`)
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries([...response.headers.entries()]),
        ...(binary ? { bytes: Buffer.concat(chunks) } : { text: Buffer.concat(chunks).toString('utf8') }),
      }
    }
  } catch (error) {
    if (timeout.aborted && !signal.aborted) throw new Error('http.fetch took longer than 30 seconds')
    throw error
  } finally {
    await (dispatcher as { close?: () => Promise<void> } | undefined)?.close?.().catch(() => {})
  }
}
