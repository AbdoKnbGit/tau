/**
 * Antigravity Gemini dispatch-boundary diagnostics (TAU_CACHE_DEBUG=1).
 *
 * The lane's request rows (antigravity_cache.ts) hash the prompt before the
 * Code Assist envelope exists. These rows describe what was actually sent:
 * the final serialized body after wrapping and the thought_signature rename.
 * One `dispatch` row is written per HTTP dispatch (a retry attempt or an
 * endpoint hop) and one `attempt` row when that dispatch ends, with timings,
 * outcome, usage and the connection that carried it.
 *
 * Three groups are compared with the stream's last COMPLETED dispatch, the
 * prompt the backend actually processed:
 *   - prompt: system instruction, ordered tools, tool config and every
 *     content block, giving an append-only / rewritten / truncated verdict;
 *   - identity: upstream model, project, wire session id, account, labels;
 *   - config: generationConfig and any other body field.
 * A per-request id or step counter is identity churn, never a prompt rewrite,
 * and a hash of the whole growing body is never used to judge the prefix.
 *
 * Observation only: no model call, wait, header or payload field is added,
 * and without TAU_CACHE_DEBUG nothing here runs. Rows hold hashes and opaque
 * ids only, never prompt text, credentials or whole response headers.
 */

import { createHash } from 'crypto'
import {
  antigravityBuildId,
  antigravityCacheScope,
  appendAntigravityCacheDebugRow,
  getAntigravityCacheRequestContext,
  type AntigravityCacheRequestContext,
} from './antigravity_cache.js'
import {
  observeAntigravityConnections,
  withAntigravityConnectionProbe,
  type AntigravityConnectionProbe,
} from './antigravity_connection.js'
import {
  describeAntigravityTransport,
  type AntigravityTransportProfile,
} from './antigravity_transport.js'

// Listen before the first request so early sockets can be classified too.
if (process.env.TAU_CACHE_DEBUG) observeAntigravityConnections()

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function h(value: unknown): string {
  return hashText(JSON.stringify(value) ?? 'undefined')
}

// ─── Final-body fingerprint ──────────────────────────────────────

const PROMPT_FIELDS = new Set(['contents', 'systemInstruction', 'tools', 'toolConfig'])
const IDENTITY_REQUEST_FIELDS = new Set(['sessionId', 'labels'])
const ENVELOPE_FIELDS = new Set(['model', 'userAgent', 'requestType', 'project', 'requestId', 'request'])
// Labels that intentionally change on every request of a trajectory.
const PER_REQUEST_LABELS = new Set(['last_step_index', 'last_execution_id'])

interface PromptPrint {
  system: string
  tools: string
  toolConfig: string
  toolsByName: Record<string, string>
  blocks: string[]
  /** Per-block part descriptors (kind, length, hash): no text. */
  parts: string[][]
}

interface WirePrint {
  prompt: PromptPrint
  genCfg: string
  bytes: number
  /** Flagged when it changes between completed dispatches of one stream. */
  identity: Record<string, string>
  upstreamRequestId?: string
  wireModel?: string
  wireSessionId?: string
  labels?: Record<string, string>
  otherFields: Record<string, string>
  envelopeKeys: string[]
}

function describePart(part: unknown): string {
  const p = (part ?? {}) as Record<string, any>
  const json = JSON.stringify(p) ?? ''
  const kind = typeof p.text === 'string'
    ? (p.thought === true ? 'thought' : 'text')
    : p.functionCall ? `functionCall:${String(p.functionCall.name ?? '')}`
      : p.functionResponse ? `functionResponse:${String(p.functionResponse.name ?? '')}`
        : p.inlineData ? 'inlineData'
          : 'part'
  const signed = p.thought_signature !== undefined || p.thoughtSignature !== undefined ? '+sig' : ''
  return `${kind}${signed} len=${json.length} h=${hashText(json)}`
}

function fingerprintWireBody(serialized: string): WirePrint | undefined {
  let envelope: Record<string, unknown>
  try {
    envelope = JSON.parse(serialized) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!envelope || typeof envelope !== 'object') return undefined
  const request = (envelope.request && typeof envelope.request === 'object'
    ? envelope.request
    : {}) as Record<string, unknown>
  const contents = Array.isArray(request.contents) ? request.contents : []
  const toolsByName: Record<string, string> = {}
  for (const entry of Array.isArray(request.tools) ? request.tools : []) {
    const decls = Array.isArray((entry as any)?.functionDeclarations)
      ? ((entry as any).functionDeclarations as Array<Record<string, any>>)
      : []
    for (const decl of decls) {
      toolsByName[typeof decl?.name === 'string' ? decl.name : '<unnamed>'] = h(decl)
    }
  }
  const rawLabels = request.labels && typeof request.labels === 'object'
    ? request.labels as Record<string, unknown>
    : undefined
  const labels = rawLabels
    ? Object.fromEntries(Object.entries(rawLabels).map(([k, v]) => [k, String(v).slice(0, 96)]))
    : undefined
  const identity: Record<string, string> = {
    wireModel: String(envelope.model ?? ''),
    userAgent: String(envelope.userAgent ?? ''),
    requestType: String(envelope.requestType ?? ''),
    project: h(envelope.project),
    wireSessionId: String(request.sessionId ?? ''),
    labelNames: labels ? Object.keys(labels).sort().join(',') : '',
  }
  for (const [name, value] of Object.entries(labels ?? {})) {
    if (!PER_REQUEST_LABELS.has(name)) identity[`label:${name}`] = value
  }
  const otherFields: Record<string, string> = {}
  for (const [key, value] of Object.entries(request)) {
    if (PROMPT_FIELDS.has(key) || IDENTITY_REQUEST_FIELDS.has(key) || key === 'generationConfig') continue
    otherFields[`request.${key}`] = h(value)
  }
  for (const [key, value] of Object.entries(envelope)) {
    if (!ENVELOPE_FIELDS.has(key)) otherFields[`envelope.${key}`] = h(value)
  }
  return {
    prompt: {
      system: h(request.systemInstruction),
      tools: h(request.tools),
      toolConfig: h(request.toolConfig),
      toolsByName,
      blocks: contents.map(h),
      parts: contents.map(block => (
        Array.isArray((block as any)?.parts) ? ((block as any).parts as unknown[]).map(describePart) : []
      )),
    },
    genCfg: h(request.generationConfig),
    bytes: serialized.length,
    identity,
    upstreamRequestId: typeof envelope.requestId === 'string' ? envelope.requestId : undefined,
    wireModel: typeof envelope.model === 'string' ? envelope.model : undefined,
    wireSessionId: typeof request.sessionId === 'string' ? request.sessionId : undefined,
    labels,
    otherFields,
    envelopeKeys: Object.keys(envelope),
  }
}

/**
 * Prompt-only verdict against the stream's last completed dispatch. Strings
 * match the pre-wrap request rows so both logs read the same way.
 */
export function compareAntigravityWirePrompt(
  prev: PromptPrint | undefined,
  cur: PromptPrint,
): { verdict: string; detail?: Record<string, unknown> } {
  if (!prev) return { verdict: 'cold' }
  if (prev.system !== cur.system) return { verdict: 'BREAK: systemInstruction' }
  if (prev.tools !== cur.tools) {
    const before = prev.toolsByName
    const after = cur.toolsByName
    return {
      verdict: 'BREAK: tools',
      detail: {
        toolsDiff: {
          added: Object.keys(after).filter(name => !(name in before)),
          removed: Object.keys(before).filter(name => !(name in after)),
          changed: Object.keys(after).filter(name => name in before && before[name] !== after[name]),
          nBefore: Object.keys(before).length,
          nAfter: Object.keys(after).length,
        },
      },
    }
  }
  if (prev.toolConfig !== cur.toolConfig) return { verdict: 'BREAK: toolConfig' }
  const shared = Math.min(prev.blocks.length, cur.blocks.length)
  for (let i = 0; i < shared; i++) {
    if (prev.blocks[i] !== cur.blocks[i]) {
      return {
        verdict: `BREAK: history block ${i}/${prev.blocks.length} rewritten`,
        detail: { rewritten: { index: i, before: prev.parts[i] ?? [], after: cur.parts[i] ?? [] } },
      }
    }
  }
  if (cur.blocks.length > prev.blocks.length) return { verdict: 'ok: clean prefix extension' }
  if (cur.blocks.length === prev.blocks.length) return { verdict: 'ok: identical prompt' }
  return { verdict: 'BREAK: history truncated' }
}

function changedKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter(key => before[key] !== after[key]).sort()
}

// ─── Per-stream state ────────────────────────────────────────────

interface StreamState {
  lastCompleted?: { print: WirePrint; account: string; completedAt: number }
  inflight: number
}

// A stream is one conversation (or agent) on one model and query source: the
// same scope the commit-window guard uses. Bounded far above any real
// session's stream count; a dropped stream's next dispatch reads as `cold`.
const MAX_TRACED_STREAMS = 1024
const _streams = new Map<string, StreamState>()
let _processInflight = 0

function streamState(key: string): StreamState {
  let state = _streams.get(key)
  if (state) {
    _streams.delete(key)
  } else {
    state = { inflight: 0 }
    if (_streams.size >= MAX_TRACED_STREAMS) {
      const oldest = _streams.keys().next().value
      if (oldest !== undefined) _streams.delete(oldest)
    }
  }
  _streams.set(key, state)
  return state
}

// ─── Dispatch trace ──────────────────────────────────────────────

export type AntigravityAttemptOutcome =
  | 'completed'
  | 'http-error'
  | 'timeout'
  | 'network-error'
  | 'aborted'
  | 'abandoned'
  | 'failed'

/** Effective experiment profile of a dispatch (Phase 2 arms). */
export interface AntigravityExperimentProfile {
  trajectory: string
  transport: string
  [detail: string]: unknown
}

const BASELINE_PROFILE: AntigravityExperimentProfile = { trajectory: 'off', transport: 'baseline' }

export interface AntigravityDispatchInput {
  attempt: number
  hop: number
  /** Why the previous endpoint of this attempt was abandoned. */
  hopReason?: string
  url: string
  serialized: string
  accountEmail?: string
  profile?: AntigravityExperimentProfile
  /** The transport the dispatch actually used. */
  transport?: AntigravityTransportProfile
}

export interface AntigravityDispatchAttempt {
  /** Dispatch: stamps the time, writes the dispatch row, observes the connection. */
  send<T>(dispatch: () => Promise<T>): Promise<T>
  /** Response headers arrived. */
  headers(response: Response): void
  /** One unwrapped response chunk, or a whole unwrapped response. */
  chunk(chunk: unknown): void
  /** The Code Assist envelope around a chunk (traceId, in-band error). */
  envelope(envelope: unknown): void
  /** Read a non-streaming body, recording completion or failure. */
  readJson(response: Response, signal?: AbortSignal): Promise<unknown>
  /** The dispatch ended. Only the first call counts. */
  end(outcome: AntigravityAttemptOutcome, detail?: { status?: number; error?: unknown; errorBody?: string }): void
}

export interface AntigravityDispatchTrace {
  attempt(input: AntigravityDispatchInput): AntigravityDispatchAttempt
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 80)
  }
}

function describeError(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined) return undefined
  const e = error as { name?: unknown; code?: unknown; message?: unknown; cause?: any }
  const cause = e?.cause as { code?: unknown; message?: unknown } | undefined
  return {
    name: typeof e?.name === 'string' ? e.name : typeof error,
    ...(typeof e?.code === 'string' && { code: e.code }),
    ...(typeof cause?.code === 'string' && { causeCode: cause.code }),
    message: String(e?.message ?? error).slice(0, 120),
  }
}

// Google error bodies carry a status enum and optional reason codes; keep
// those and drop the free-text message, which can name the project.
function describeErrorBody(body: string | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    const root = Array.isArray(parsed) ? parsed[0] : parsed
    const error = (root as { error?: { status?: unknown; details?: Array<{ reason?: unknown }> } } | null)?.error
    if (!error) return undefined
    const reasons = (error.details ?? [])
      .map(detail => detail?.reason)
      .filter((reason): reason is string => typeof reason === 'string')
    return {
      ...(typeof error.status === 'string' && { status: error.status }),
      ...(reasons.length > 0 && { reasons }),
    }
  } catch {
    return undefined
  }
}

class DispatchAttempt implements AntigravityDispatchAttempt {
  private readonly probe: AntigravityConnectionProbe = { claimed: false }
  private readonly streamKey: string
  private readonly account: string
  private readonly attemptId: string
  private sent = false
  private ended = false
  private dispatchAt = 0
  private headersAt?: number
  private firstChunkAt?: number
  private firstContentAt?: number
  private status?: number
  private responseHeaders?: Record<string, string>
  private usageSeen = false
  private cacheFieldSeen = false
  private prompt?: number
  private cached?: number
  private output?: number
  private thoughts?: number
  private responseId?: string
  private modelVersion?: string
  private traceId?: string
  private inBandError?: Record<string, unknown>

  constructor(
    private readonly context: AntigravityCacheRequestContext,
    private readonly wireSessionId: string | undefined,
    private readonly input: AntigravityDispatchInput,
    private readonly print: WirePrint | undefined,
  ) {
    this.streamKey = antigravityCacheScope(
      context.sessionId ?? wireSessionId ?? '<no-session>',
      context.model,
      context.querySource,
    )
    this.account = input.accountEmail ? h(input.accountEmail.toLowerCase()) : 'active-token'
    this.attemptId = `${context.requestId}:${input.attempt}.${input.hop}`
  }

  send<T>(dispatch: () => Promise<T>): Promise<T> {
    if (this.sent) return dispatch()
    this.sent = true
    try {
      this.dispatchAt = Date.now()
      const stream = streamState(this.streamKey)
      const previous = stream.lastCompleted
      const print = this.print
      const compared = print
        ? compareAntigravityWirePrompt(previous?.print.prompt, print.prompt)
        : { verdict: 'n/a: unparsed body' }
      const identityChanges = print && previous
        ? changedKeys(
          { ...previous.print.identity, account: previous.account },
          { ...print.identity, account: this.account },
        )
        : []
      const configChanges = print && previous
        ? [
          ...(previous.print.genCfg !== print.genCfg ? ['generationConfig'] : []),
          ...changedKeys(previous.print.otherFields, print.otherFields),
        ]
        : []
      const inflight = _processInflight
      const streamInflight = stream.inflight
      _processInflight++
      stream.inflight++
      appendAntigravityCacheDebugRow({
        ts: new Date(this.dispatchAt).toISOString(),
        kind: 'dispatch',
        requestId: this.context.requestId,
        attemptId: this.attemptId,
        attempt: this.input.attempt,
        hop: this.input.hop,
        ...(this.input.hopReason && { hopReason: this.input.hopReason }),
        upstreamRequestId: print?.upstreamRequestId,
        sessionId: this.context.sessionId,
        wireSessionId: print?.wireSessionId ?? this.wireSessionId,
        querySource: this.context.querySource,
        model: this.context.model,
        wireModel: print?.wireModel,
        account: this.account,
        project: print?.identity.project,
        profile: this.input.profile ?? BASELINE_PROFILE,
        origin: hostOf(this.input.url),
        verdict: compared.verdict,
        ...compared.detail,
        ...(identityChanges.length > 0 && { identityChanges }),
        ...(configChanges.length > 0 && { configChanges }),
        system: print?.prompt.system,
        tools: print?.prompt.tools,
        toolConfig: print?.prompt.toolConfig,
        genCfg: print?.genCfg,
        nTools: print ? Object.keys(print.prompt.toolsByName).length : undefined,
        nContents: print?.prompt.blocks.length,
        bytes: print?.bytes ?? this.input.serialized.length,
        blocks: print?.prompt.blocks,
        ...(print?.labels && { labels: print.labels }),
        ...(print && Object.keys(print.otherFields).length > 0 && { otherFields: print.otherFields }),
        envelopeKeys: print?.envelopeKeys,
        ...(previous && { gapMs: this.dispatchAt - previous.completedAt }),
        ...(this.context.pacingMs !== undefined && { pacingMs: this.context.pacingMs }),
        inflight,
        streamInflight,
        transport: this.input.transport ?? describeAntigravityTransport(this.input.url),
        build: antigravityBuildId(),
      })
    } catch {
      // Diagnostics must never break the request path.
    }
    return withAntigravityConnectionProbe(this.probe, dispatch)
  }

  headers(response: Response): void {
    try {
      this.headersAt ??= Date.now()
      this.status = response.status
      const connection = response.headers.get('connection')
      const keepAlive = response.headers.get('keep-alive')
      if (connection || keepAlive) {
        this.responseHeaders = {
          ...(connection && { connection: connection.slice(0, 40) }),
          ...(keepAlive && { keepAlive: keepAlive.slice(0, 40) }),
        }
      }
    } catch {
      // Observation only.
    }
  }

  chunk(value: unknown): void {
    try {
      const now = Date.now()
      this.firstChunkAt ??= now
      const chunk = (value ?? {}) as {
        candidates?: Array<{ content?: { parts?: unknown[] } }>
        usageMetadata?: Record<string, unknown>
        responseId?: unknown
        modelVersion?: unknown
      }
      if (this.firstContentAt === undefined
        && chunk.candidates?.some(candidate => (candidate?.content?.parts?.length ?? 0) > 0)) {
        this.firstContentAt = now
      }
      const usage = chunk.usageMetadata
      if (usage) {
        this.usageSeen = true
        // Same accumulation as the lane: a later block without a field keeps
        // the earlier value.
        if (typeof usage.promptTokenCount === 'number') this.prompt = usage.promptTokenCount
        if (typeof usage.cachedContentTokenCount === 'number') {
          this.cached = usage.cachedContentTokenCount
          this.cacheFieldSeen = true
        }
        if (typeof usage.candidatesTokenCount === 'number') this.output = usage.candidatesTokenCount
        if (typeof usage.thoughtsTokenCount === 'number') this.thoughts = usage.thoughtsTokenCount
      }
      if (!this.responseId && typeof chunk.responseId === 'string') this.responseId = chunk.responseId
      if (typeof chunk.modelVersion === 'string') this.modelVersion = chunk.modelVersion
    } catch {
      // Observation only.
    }
  }

  envelope(value: unknown): void {
    try {
      const envelope = (value ?? {}) as { traceId?: unknown; error?: { code?: unknown; status?: unknown } }
      if (!this.traceId && typeof envelope.traceId === 'string') this.traceId = envelope.traceId
      if (envelope.error && typeof envelope.error === 'object') {
        this.inBandError = {
          ...(envelope.error.code !== undefined && { code: envelope.error.code }),
          ...(typeof envelope.error.status === 'string' && { status: envelope.error.status }),
        }
      }
    } catch {
      // Observation only.
    }
  }

  async readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
    try {
      const data = await response.json()
      this.envelope(data)
      this.chunk((data as { response?: unknown } | null)?.response)
      this.end('completed')
      return data
    } catch (err) {
      this.end(signal?.aborted ? 'aborted' : 'failed', { error: err })
      throw err
    }
  }

  end(
    outcome: AntigravityAttemptOutcome,
    detail: { status?: number; error?: unknown; errorBody?: string } = {},
  ): void {
    if (this.ended || !this.sent) return
    this.ended = true
    try {
      const endAt = Date.now()
      _processInflight = Math.max(0, _processInflight - 1)
      const stream = _streams.get(this.streamKey)
      if (stream) {
        stream.inflight = Math.max(0, stream.inflight - 1)
        if (outcome === 'completed' && this.print) {
          stream.lastCompleted = { print: this.print, account: this.account, completedAt: endAt }
        }
      }
      const since = (at: number | undefined) => at === undefined ? undefined : at - this.dispatchAt
      appendAntigravityCacheDebugRow({
        ts: new Date(endAt).toISOString(),
        kind: 'attempt',
        requestId: this.context.requestId,
        attemptId: this.attemptId,
        sessionId: this.context.sessionId,
        querySource: this.context.querySource,
        model: this.context.model,
        outcome,
        status: detail.status ?? this.status,
        ...(detail.error !== undefined && { error: describeError(detail.error) }),
        ...(detail.errorBody !== undefined && { errorBody: describeErrorBody(detail.errorBody) }),
        ...(this.inBandError && { inBandError: this.inBandError }),
        dispatchedAt: new Date(this.dispatchAt).toISOString(),
        headersMs: since(this.headersAt),
        firstChunkMs: since(this.firstChunkAt),
        firstContentMs: since(this.firstContentAt),
        totalMs: endAt - this.dispatchAt,
        usage: this.usageSeen
          ? {
            prompt: this.prompt,
            cached: this.cached ?? 0,
            // explicit: the count was present; omitted: inferred zero.
            cacheField: this.cacheFieldSeen ? 'explicit' : 'omitted',
            output: this.output,
            thoughts: this.thoughts,
          }
          : undefined,
        responseId: this.responseId,
        modelVersion: this.modelVersion,
        traceId: this.traceId,
        connection: this.probe.connection
          ? { observed: true, ...this.probe.connection }
          : { observed: false, claimed: this.probe.claimed },
        ...(this.responseHeaders && { responseHeaders: this.responseHeaders }),
      })
    } catch {
      // Diagnostics must never break the request path.
    }
  }
}

/**
 * Trace one logical request's dispatches, or undefined when diagnostics are
 * off or the request is not a tracked Antigravity Gemini call.
 */
export function startAntigravityDispatchTrace(
  request: object,
  wireSessionId: string | undefined,
): AntigravityDispatchTrace | undefined {
  if (!process.env.TAU_CACHE_DEBUG) return undefined
  const context = getAntigravityCacheRequestContext(request)
  if (!context) return undefined
  observeAntigravityConnections()
  // Hops of one attempt send the same bytes; fingerprint them once.
  let memo: { serialized: string; print: WirePrint | undefined } | undefined
  return {
    attempt(input) {
      if (memo?.serialized !== input.serialized) {
        memo = { serialized: input.serialized, print: fingerprintWireBody(input.serialized) }
      }
      return new DispatchAttempt(context, wireSessionId, input, memo.print)
    },
  }
}

// ─── Test hooks ──────────────────────────────────────────────────

export function _resetAntigravityTraceStateForTest(): void {
  _streams.clear()
  _processInflight = 0
}
