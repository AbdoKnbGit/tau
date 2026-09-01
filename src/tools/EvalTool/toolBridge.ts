import { randomUUID } from 'crypto'
import { createServer, type Server } from 'http'

import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'

import { findToolByName, type Tool, type Tools, type ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  EVAL_BRIDGE_ALLOWED_TOOLS,
  EVAL_BRIDGE_FORBIDDEN_TOOLS,
} from './constants.js'
import type { BridgeCallRecord } from './format.js'

/**
 * The assistant message a tool call is attributed to. Derived from
 * `CanUseToolFn` rather than imported from `types/message.js`: that module does
 * not resolve in this tree (it is one of the pre-existing baseline breaks), and
 * the bridge only ever passes the value straight through.
 */
type ParentMessage = Parameters<CanUseToolFn>[3]

/**
 * Loopback HTTP bridge: `tool.<name>(args)` inside the kernel becomes a real
 * Tau tool call here.
 *
 * Permission model, stated plainly because it differs from the main loop:
 *
 *   - The cell as a whole goes through the full PreToolUse/PostToolUse hook
 *     stack and the auto-mode classifier as ONE `Eval` call. That is already
 *     how `permissions.ts` reasons about kernel code ("the classifier must see
 *     the glue", not just the inner calls).
 *   - Each individual bridged call additionally goes through `canUseTool`, so
 *     settings.json deny/ask rules and the interactive prompt still apply.
 *   - Per-call PreToolUse hooks do NOT run. Reimplementing `runToolUseInner`'s
 *     generator here would duplicate ~700 lines of permission semantics with
 *     its own drift; the allowlist below is the compensating control.
 *
 * Everything is bound to 127.0.0.1 and gated on a per-process bearer token
 * that never leaves this machine.
 */

export type { BridgeCallRecord } from './format.js'

export type BridgeRegistration = {
  tools: Tools
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  parentMessage: ParentMessage
  signal: AbortSignal
  onCall: (record: BridgeCallRecord) => void
  /** Suspends the cell deadline while a call is in flight. */
  budget: DeadlineBudget
}

/**
 * Wall-clock the cell should not be charged for.
 *
 * A bridged call can block on an interactive permission prompt, a slow Bash
 * command, or a network fetch. None of that is the cell "hanging", so the
 * deadline is suspended while at least one call is outstanding and resumes
 * when the last one returns.
 */
export class DeadlineBudget {
  #accumulated = 0
  #depth = 0
  #since = 0

  enter(): void {
    if (this.#depth === 0) this.#since = Date.now()
    this.#depth += 1
  }

  exit(): void {
    this.#depth -= 1
    if (this.#depth <= 0) {
      this.#depth = 0
      this.#accumulated += Date.now() - this.#since
    }
  }

  /** Milliseconds elapsed inside bridge calls, including one in flight. */
  pausedMs(): number {
    return this.#accumulated + (this.#depth > 0 ? Date.now() - this.#since : 0)
  }
}

export type BridgeInfo = { url: string; token: string }

const registrations = new Map<string, BridgeRegistration>()
let serverPromise: Promise<{ server: Server; info: BridgeInfo }> | null = null
const bridgeToken = randomUUID()

function bridgeableTools(tools: Tools): Tool[] {
  return tools.filter(
    tool =>
      EVAL_BRIDGE_ALLOWED_TOOLS.has(tool.name) &&
      !EVAL_BRIDGE_FORBIDDEN_TOOLS.has(tool.name),
  )
}

function textFromContent(content: unknown): { text: string; images: Array<{ mime: string; data: string }> } {
  const images: Array<{ mime: string; data: string }> = []
  if (typeof content === 'string') return { text: content, images }
  if (!Array.isArray(content)) return { text: '', images }
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const typed = block as Record<string, unknown>
    if (typed.type === 'text' && typeof typed.text === 'string') {
      parts.push(typed.text)
    } else if (typed.type === 'image' && typed.source && typeof typed.source === 'object') {
      const source = typed.source as Record<string, unknown>
      if (typeof source.data === 'string') {
        images.push({
          mime: typeof source.media_type === 'string' ? source.media_type : 'image/png',
          data: source.data,
        })
      }
    }
  }
  return { text: parts.join(''), images }
}

function describeCall(name: string, args: Record<string, unknown>): string {
  const first =
    args.file_path ?? args.path ?? args.pattern ?? args.command ?? args.url ?? args.prompt
  const text = typeof first === 'string' ? first : ''
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

async function invoke(
  entry: BridgeRegistration,
  name: string,
  rawArgs: unknown,
): Promise<unknown> {
  if (EVAL_BRIDGE_FORBIDDEN_TOOLS.has(name)) {
    throw new Error(
      `${name} cannot be called from a kernel cell. Call it directly as a tool instead.`,
    )
  }
  if (!EVAL_BRIDGE_ALLOWED_TOOLS.has(name)) {
    const available = bridgeableTools(entry.tools)
      .map(tool => tool.name)
      .sort()
      .join(', ')
    throw new Error(
      `${name} is not available through the tool bridge. Available: ${available}`,
    )
  }
  const tool = findToolByName(bridgeableTools(entry.tools), name)
  if (!tool) {
    throw new Error(`No such tool in this session: ${name}`)
  }
  if (entry.signal.aborted) {
    throw new Error(`tool.${name}(...) aborted: the cell was interrupted.`)
  }

  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
  const parsed = tool.inputSchema.safeParse(args)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 6)
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`tool.${name}(...) got invalid arguments — ${issues}`)
  }

  const toolUseId = `eval-${name}-${randomUUID()}`
  const decision = await entry.canUseTool(
    tool,
    parsed.data as Record<string, unknown>,
    entry.toolUseContext,
    entry.parentMessage,
    toolUseId,
  )
  if (decision.behavior !== 'allow') {
    const message =
      'message' in decision && typeof decision.message === 'string'
        ? decision.message
        : 'permission denied'
    throw new Error(`tool.${name}(...) was not permitted: ${message}`)
  }

  const input = ('updatedInput' in decision && decision.updatedInput
    ? decision.updatedInput
    : parsed.data) as Record<string, unknown>

  const result = await tool.call(
    input,
    entry.toolUseContext,
    entry.canUseTool,
    entry.parentMessage,
  )
  const block = tool.mapToolResultToToolResultBlockParam(result.data, toolUseId)
  const { text, images } = textFromContent(block.content)
  if (images.length > 0) return { text, images }
  return text
}

async function handle(
  body: Record<string, unknown>,
  pathname: string,
): Promise<unknown> {
  const sessionKey = typeof body.session === 'string' ? body.session : ''
  const entry = registrations.get(sessionKey)
  if (!entry) {
    throw new Error(
      'This kernel is not attached to a running Eval call. Its bridge session has ended.',
    )
  }

  if (pathname === '/v1/tools') {
    return bridgeableTools(entry.tools)
      .map(tool => tool.name)
      .sort()
  }

  const name = typeof body.name === 'string' ? body.name : ''
  if (!name) throw new Error('Missing tool name.')
  const args = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>

  const started = Date.now()
  entry.budget.enter()
  try {
    const value = await invoke(entry, name, args)
    entry.onCall({
      name,
      detail: describeCall(name, args),
      ms: Date.now() - started,
    })
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    entry.onCall({
      name,
      detail: describeCall(name, args),
      ms: Date.now() - started,
      error: message,
    })
    throw error
  } finally {
    entry.budget.exit()
  }
}

async function startServer(): Promise<{ server: Server; info: BridgeInfo }> {
  const server = createServer((req, res) => {
    const reply = (status: number, payload: unknown) => {
      const encoded = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encoded),
      })
      res.end(encoded)
    }

    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || (pathname !== '/v1/tool' && pathname !== '/v1/tools')) {
      reply(404, { ok: false, error: 'not found' })
      return
    }
    if (req.headers.authorization !== `Bearer ${bridgeToken}`) {
      reply(403, { ok: false, error: 'forbidden' })
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      // A cell can legitimately hand a tool a large payload (a rewritten
      // file), but not an unbounded one.
      if (size > 32 * 1024 * 1024) {
        reply(413, { ok: false, error: 'request too large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        reply(400, { ok: false, error: 'invalid JSON body' })
        return
      }
      handle(body, pathname).then(
        value => reply(200, { ok: true, value }),
        error =>
          // 200 with ok:false — the kernel turns this into a ToolBridgeError
          // the cell can catch. An HTTP error status would be indistinguishable
          // from the bridge itself being down.
          reply(200, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      )
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  server.on('error', error => {
    logForDebugging(`Eval tool bridge error: ${String(error)}`, { level: 'error' })
  })
  // The bridge must never hold the event loop open at shutdown.
  server.unref()

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const info: BridgeInfo = { url: `http://127.0.0.1:${port}`, token: bridgeToken }
  logForDebugging(`Eval tool bridge listening on ${info.url}`)
  return { server, info }
}

export async function ensureToolBridge(): Promise<BridgeInfo> {
  serverPromise ??= startServer()
  try {
    return (await serverPromise).info
  } catch (error) {
    serverPromise = null
    throw error
  }
}

export function registerBridgeSession(
  sessionKey: string,
  entry: BridgeRegistration,
): () => void {
  registrations.set(sessionKey, entry)
  return () => {
    if (registrations.get(sessionKey) === entry) registrations.delete(sessionKey)
  }
}

/** Test/shutdown helper. Closes the listener and drops every registration. */
export async function disposeToolBridge(): Promise<void> {
  registrations.clear()
  const pending = serverPromise
  serverPromise = null
  if (!pending) return
  try {
    const { server } = await pending
    await new Promise<void>(resolve => server.close(() => resolve()))
  } catch {
    /* never fail a shutdown over a listener that is already gone */
  }
}
