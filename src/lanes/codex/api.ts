/**
 * Codex Lane — Responses API Client
 *
 * Mirrors codex-rs's HTTP Responses path exactly so prompt-cache hits land
 * and token accounting reflects the native client. Specifically:
 *
 *   - POST <base>/responses with `ResponsesApiRequest` shape — NO
 *     `previous_response_id` on HTTP (that's WS-only in codex-rs).
 *   - `store` defaults to false; only true for Azure-wire endpoints.
 *   - Cache routing via body `prompt_cache_key` + header `session_id`,
 *     both set to the stable conversation id.
 *   - Auth: Bearer (API key OR ChatGPT OAuth access token). ChatGPT lane
 *     auto-selects `https://chatgpt.com/backend-api/codex` base URL.
 *   - Standard codex-rs headers: `originator`, `User-Agent`,
 *     `x-client-request-id`. `ChatGPT-Account-ID` only when decoded from
 *     an accompanying JWT (never empty string).
 *
 * Reference:
 *   codex-rs/codex-api/src/common.rs            (ResponsesApiRequest shape)
 *   codex-rs/codex-api/src/endpoint/responses.rs (HTTP path + headers)
 *   codex-rs/codex-api/src/requests/headers.rs  (session_id header)
 *   codex-rs/codex-api/src/auth.rs              (ChatGPT-Account-ID)
 *   codex-rs/login/src/auth/default_client.rs   (originator, User-Agent)
 *   codex-rs/model-provider-info/src/lib.rs     (ChatGPT base URL)
 *   codex-rs/core/src/client.rs                 (store/include flags)
 */

// ─── Types ───────────────────────────────────────────────────────

export type CodexInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'developer' | 'system'; content: CodexContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'custom_tool_call'; call_id: string; name: string; input: string }
  | { type: 'custom_tool_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; id?: string; summary?: Array<{ type: 'summary_text'; text: string }>; content?: Array<{ type: 'reasoning_text'; text: string }> }

export type CodexContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

export interface CodexReasoningConfig {
  /** "minimal" | "low" | "medium" | "high" | "xhigh" controls thinking intensity. */
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  /** "auto" | "concise" | "detailed" — controls summary verbosity. */
  summary?: 'auto' | 'concise' | 'detailed'
}

export type CodexToolSpec =
  | {
      type: 'function'
      name: string
      description: string
      parameters: Record<string, unknown>
      strict?: boolean
    }
  | {
      // Codex's freeform tool variant — used by apply_patch. Payload is raw
      // text, not JSON-wrapped arguments.
      type: 'custom'
      name: string
      description: string
      format: { type: 'text' }
    }

export interface CodexResponsesRequest {
  model: string
  instructions: string
  input: CodexInputItem[]
  tools?: CodexToolSpec[]
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string }
  parallel_tool_calls?: boolean
  reasoning?: CodexReasoningConfig
  // codex-rs mirrors this directly — defaults to Azure-only. NOT
  // `previous_response_id`; that field is WebSocket-only in codex-rs.
  store?: boolean
  stream?: boolean
  include?: string[]
  prompt_cache_key?: string
  text?: { format?: 'markdown' | 'plaintext' }
  service_tier?: 'auto' | 'default' | 'flex' | 'priority'
  /**
   * Per codex-rs `ResponsesApiRequest.client_metadata` — carries
   * `x-codex-installation-id` in the body so the backend aggregates the
   * call against the installation's cache + quota bucket. Native codex
   * sends this on every call; omitting it lands us in a default
   * "unknown client" partition.
   * Ref: codex-rs/codex-api/src/common.rs (ResponsesApiRequest)
   *      codex-rs/core/src/client.rs (build_responses_request)
   */
  client_metadata?: Record<string, string>
}

// ─── SSE Event Types ─────────────────────────────────────────────

export type CodexStreamEvent =
  | { type: 'response.created'; response: { id: string } }
  | { type: 'response.in_progress'; response: { id: string } }
  | { type: 'response.output_item.added'; output_index: number; item: CodexOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: CodexOutputItem }
  | { type: 'response.output_text.delta'; item_id: string; output_index: number; content_index: number; delta: string }
  | { type: 'response.output_text.done'; item_id: string; output_index: number; content_index: number; text: string }
  | { type: 'response.reasoning_summary_text.delta'; item_id: string; output_index: number; summary_index: number; delta: string }
  | { type: 'response.reasoning_text.delta'; item_id: string; output_index: number; content_index: number; delta: string }
  | { type: 'response.reasoning_summary_part.added'; item_id: string; output_index: number; summary_index: number; part: { type: 'summary_text'; text: string } }
  | { type: 'response.function_call_arguments.delta'; item_id: string; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.done'; item_id: string; output_index: number; arguments: string }
  | { type: 'response.custom_tool_call_input.delta'; item_id: string; output_index: number; delta: string }
  | { type: 'response.custom_tool_call_input.done'; item_id: string; output_index: number; input: string }
  | { type: 'response.completed'; response: { id: string; usage: CodexUsage } }
  | { type: 'response.failed'; response: { id: string; error: { code: string; message: string } } }
  | { type: 'response.incomplete'; response: { id: string; incomplete_details?: { reason: string } } }
  | { type: string; [key: string]: unknown }

export type CodexOutputItem =
  | { type: 'message'; id: string; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations?: unknown[] }> }
  | { type: 'reasoning'; id: string; summary?: Array<{ type: 'summary_text'; text: string }>; content?: Array<{ type: 'reasoning_text'; text: string }> }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'custom_tool_call'; id: string; call_id: string; name: string; input: string }

export interface CodexUsage {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  prompt_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number }
  completion_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
  total_tokens?: number
  cached_tokens?: number
  cached_input_tokens?: number
  prompt_cache_hit_tokens?: number
  cache_read_input_tokens?: number
  cache_read_tokens?: number
  cache_hit_tokens?: number
  cache_creation_input_tokens?: number
  cache_write_input_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
}

// ─── Client ──────────────────────────────────────────────────────

// Signal prefix for claudex reactive-compact (must match the string in
// services/api/errors.ts — duplicated to avoid the transitive import
// issue with utils/messages.ts).
const CODEX_PROMPT_TOO_LONG_PREFIX = 'Prompt is too long'

export class CodexApiError extends Error {
  readonly isPromptTooLong: boolean

  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs?: number,
  ) {
    // Recognize the signals OpenAI emits for context-window overflow.
    // The Responses API surfaces 400 "context_length_exceeded" (structured
    // error.code) plus a free-text message. Also match the Chat-Completions
    // variant in case the gateway translates.
    const ptl = /context_length_exceeded|maximum context length|prompt is too long|token limit/i
      .test(body)
    const head = ptl
      ? `${CODEX_PROMPT_TOO_LONG_PREFIX} (Codex ${status})`
      : `OpenAI Responses API error ${status}`
    super(`${head}: ${body.slice(0, 200)}`)
    this.name = 'CodexApiError'
    this.isPromptTooLong = ptl
  }

  get isRateLimited(): boolean { return this.status === 429 }
  get isAuth(): boolean { return this.status === 401 || this.status === 403 }
  get isRetryable(): boolean {
    if (this.status === 400) return false
    return this.status === 429 || this.status === 499 || (this.status >= 500 && this.status < 600)
  }
}

const DEFAULT_ORIGINATOR = 'codex_cli_rs'
const DEFAULT_API_BASE_URL = 'https://api.openai.com/v1'
const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
/**
 * Default version string baked into the User-Agent. Kept in step with the
 * latest upstream `codex-rs` release so the backend's user-agent-based
 * feature gates treat claudex-codex identically to native codex. Override
 * via the `CLAUDEX_CODEX_VERSION` env var if upstream drifts.
 */
const DEFAULT_CODEX_VERSION = '0.47.0'

// Build a codex-rs-style User-Agent. Format mirrors get_codex_user_agent:
//   `codex_cli_rs/<build_ver> (<os_type> <os_version>; <arch>) <terminal_ua>`
// The backend uses this for client segmentation / routing; drifting from
// native shape can land us on a different pool than native codex clients
// (which affects quota bucket + cache routing on chatgpt.com). Evaluated
// once per process.
// Ref: codex-rs/login/src/auth/default_client.rs get_codex_user_agent
let USER_AGENT_CACHE: string | null = null
function getCodexUserAgent(): string {
  if (USER_AGENT_CACHE) return USER_AGENT_CACHE
  const ver = process.env.CLAUDEX_CODEX_VERSION ?? DEFAULT_CODEX_VERSION
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os')
  const osType = process.platform === 'darwin' ? 'Mac OS'
    : process.platform === 'linux' ? 'Linux'
    : process.platform === 'win32' ? 'Windows'
    : os.type()
  const osVersion = os.release() // e.g. "10.0.19045" on Win10, "23.5.0" on macOS.
  // Node's process.arch is `x64` / `arm64`; native codex-rs uses os_info
  // crate which returns `x86_64` / `arm64`. Map for parity.
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  const terminal = `${DEFAULT_ORIGINATOR}/${ver}`
  USER_AGENT_CACHE = `${DEFAULT_ORIGINATOR}/${ver} (${osType} ${osVersion}; ${arch}) ${terminal}`
  return USER_AGENT_CACHE
}

/**
 * Decode the `chatgpt_account_id` claim from a ChatGPT OAuth id_token or
 * access token JWT. Native codex extracts this from the id_token's
 * `https://api.openai.com/auth.chatgpt_account_id` claim and sends the
 * value as the `ChatGPT-Account-ID` header. Without it, requests land in
 * a different account-scoped cache/quota bucket on chatgpt.com.
 * Ref: codex-rs/login/src/token_data.rs
 *      codex-rs/login/src/server.rs (chatgpt_account_id claim path)
 */
function extractChatGPTAccountIdFromJwt(jwt: string): string | null {
  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return null
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth']
    if (auth && typeof auth === 'object') {
      const id = (auth as Record<string, unknown>).chatgpt_account_id
      if (typeof id === 'string' && id.length > 0) return id
    }
    const direct = payload['chatgpt_account_id']
    if (typeof direct === 'string' && direct.length > 0) return direct
    return null
  } catch {
    return null
  }
}

/**
 * Resolve a persistent installation id, matching codex-rs's behavior of
 * storing a UUID at `$CODEX_HOME/installation_id`. The backend uses this
 * for cache + quota aggregation; regenerating it every process defeats
 * both.
 * Ref: codex-rs/core/src/installation_id.rs resolve_installation_id
 */
let INSTALLATION_ID_CACHE: string | null = null
function resolveInstallationId(): string {
  if (INSTALLATION_ID_CACHE) return INSTALLATION_ID_CACHE
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto')

  const home = process.env.CODEX_HOME
    ?? process.env.CLAUDEX_HOME
    ?? path.join(os.homedir(), '.claudex')
  const file = path.join(home, 'installation_id')
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf-8').trim()
      // Accept anything that looks like a UUID (native codex uses strict
      // UUIDv4 but we're lenient on read). Otherwise rewrite.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
        INSTALLATION_ID_CACHE = existing.toLowerCase()
        return INSTALLATION_ID_CACHE
      }
    }
    const fresh = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(file, fresh, { encoding: 'utf-8', mode: 0o644 })
    INSTALLATION_ID_CACHE = fresh
    return INSTALLATION_ID_CACHE
  } catch {
    // Best-effort — if we can't touch disk, generate an in-process UUID
    // so we still send a stable id for the lifetime of the process.
    const fallback = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
    INSTALLATION_ID_CACHE = fallback
    return INSTALLATION_ID_CACHE
  }
}

// Azure wire-base-URL detection. Must match codex-rs's
// is_azure_responses_wire_base_url so `store` defaults correctly.
// Ref: codex-rs/codex-api/src/provider.rs
function isAzureResponsesBaseUrl(baseUrl: string): boolean {
  const b = baseUrl.toLowerCase()
  return (
    b.includes('openai.azure.')
    || b.includes('cognitiveservices.azure.')
    || b.includes('aoai.azure.')
    || b.includes('azure-api.')
    || b.includes('azurefd.')
    || b.includes('windows.net/openai')
  )
}

export class CodexApiClient {
  private apiKey: string | null = null
  /** Populated lazily in resolvedBaseUrl() based on which auth is active. */
  private explicitBaseUrl: string | null = null
  /** ChatGPT OAuth access token (Plus/Pro/Enterprise subscribers). */
  private chatgptAccessToken: string | null = null
  /**
   * Optional `chatgpt-account-id` (org slug like `org_mine`). codex-rs
   * decodes it from the companion id_token JWT's
   * `https://api.openai.com/auth.chatgpt_account_id` claim and only
   * sends the header when present. We accept it directly — callers who
   * have the id_token can parse and forward it; if absent, the header
   * is simply omitted (matching codex-rs behavior).
   */
  private chatgptAccountId: string | null = null
  /**
   * Stable per-session identifier used as the Responses API
   * `prompt_cache_key` AND the `session_id` / `x-client-request-id`
   * headers. Per codex-rs/core/src/client.rs this value must stay
   * identical across every turn of the same conversation — it's the
   * sticky-routing hint that lets identical prefixes land on a KV-cache
   * warm node. Generated lazily; rotated by clearChain().
   */
  private cacheSessionId: string | null = null
  /**
   * Per-model frozen copy of the system prompt's volatile tail
   * (env / git status / memory / current date). The codex lane
   * unshifts this as a `developer` input item at position 0 every
   * turn so the input prefix stays byte-stable across turns.
   *
   * Why frozen: the upstream rebuilds the env block each turn with a
   * fresh timestamp, but if those bytes drift between turns the
   * prompt-cache prefix hash breaks. Freezing the first turn's copy
   * means every later turn re-emits identical bytes at position 0,
   * and the cache hits everything before the new user message.
   *
   * Trade-off: the model sees env data captured at session start.
   * Acceptable because (a) env rarely changes mid-session in
   * meaningful ways, (b) the model can run `git status` / `pwd` /
   * `date` on demand if it actually needs fresh values, and (c)
   * `clearChain()` (called on `/clear` and dispose paths) wipes the
   * map so a fresh conversation captures fresh env.
   *
   * Keyed by model so a `/models` swap inside the same session
   * doesn't re-use a different model's frozen anchor.
   */
  private frozenVolatileByModel: Map<string, string> = new Map()

  configure(opts: { apiKey?: string; baseUrl?: string; chatgptAccessToken?: string; chatgptAccountId?: string; chatgptIdToken?: string }): void {
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey
    if (opts.baseUrl) this.explicitBaseUrl = opts.baseUrl
    if (opts.chatgptAccessToken !== undefined) this.chatgptAccessToken = opts.chatgptAccessToken
    if (opts.chatgptAccountId !== undefined) this.chatgptAccountId = opts.chatgptAccountId
    // Auto-extract the account id from the id_token (preferred, carries
    // the claim natively) or from the access_token as a fallback. codex-rs
    // reads this claim from the id_token on every login/refresh and
    // caches it alongside the tokens; doing it here means callers who
    // only hand us tokens still get the ChatGPT-Account-ID header routed
    // to the right cache partition.
    if (!this.chatgptAccountId) {
      const source = opts.chatgptIdToken ?? opts.chatgptAccessToken ?? this.chatgptAccessToken
      if (source) {
        const extracted = extractChatGPTAccountIdFromJwt(source)
        if (extracted) this.chatgptAccountId = extracted
      }
    }
  }

  get isConfigured(): boolean {
    return !!(this.apiKey || this.chatgptAccessToken)
  }

  /**
   * Resolve the base URL codex-rs-style: if the caller provided one,
   * use it verbatim; otherwise pick `chatgpt.com/backend-api/codex`
   * when a ChatGPT access token is active (AuthMode::Chatgpt), else
   * the standard OpenAI API endpoint.
   * Ref: codex-rs/model-provider-info/src/lib.rs to_api_provider.
   */
  get baseUrl(): string {
    if (this.explicitBaseUrl) return this.explicitBaseUrl
    if (this.chatgptAccessToken) return CHATGPT_BASE_URL
    return DEFAULT_API_BASE_URL
  }

  /** Azure wire-base detection. Only Azure sets `store: true` by default. */
  get isAzureResponsesEndpoint(): boolean {
    return isAzureResponsesBaseUrl(this.baseUrl)
  }

  /**
   * Rotate the cache session id. Call when starting a fresh
   * conversation so stale KV-cache entries don't get routed to the
   * new turn's prefix. Also wipes the per-model frozen volatile
   * anchors so the next conversation captures fresh env data.
   */
  clearChain(): void {
    this.cacheSessionId = null
    this.frozenVolatileByModel.clear()
  }

  /**
   * Adopt the outer Tau session/conversation id as Codex's cache affinity
   * key. Native codex uses one conversation_id for `prompt_cache_key`,
   * `session_id`, and `x-client-request-id`; using Tau's session id keeps
   * those bytes stable across shim re-instantiation and resume paths.
   */
  setSessionCacheKey(sessionId: string | undefined): void {
    const trimmed = sessionId?.trim()
    if (!trimmed || this.cacheSessionId === trimmed) return
    this.cacheSessionId = trimmed
    this.frozenVolatileByModel.clear()
  }

  /**
   * Return the frozen volatile anchor for `model`. If the model has
   * no entry yet AND `currentText` is non-empty, this seeds the map
   * with `currentText` and returns it. On subsequent calls for the
   * same model, the originally-seeded text is returned regardless of
   * what `currentText` is now — that's the point: the leading
   * developer item must keep emitting identical bytes turn-to-turn
   * for the cache prefix to hit.
   *
   * Pure no-op when `currentText` is empty (no anchor needed).
   */
  getOrSeedFrozenVolatile(model: string, currentText: string): string {
    if (!currentText) return ''
    const cached = this.frozenVolatileByModel.get(model)
    if (cached !== undefined) return cached
    this.frozenVolatileByModel.set(model, currentText)
    return currentText
  }

  /**
   * Stable `prompt_cache_key` / `session_id` / `x-client-request-id`
   * for the current conversation. UUID v4 via `crypto.randomUUID()`
   * when available (Node ≥ 14.17), timestamp+random fallback otherwise.
   */
  get sessionCacheKey(): string {
    if (!this.cacheSessionId) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const crypto = require('crypto') as typeof import('crypto')
      this.cacheSessionId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }
    return this.cacheSessionId
  }

  /**
   * Persistent installation UUID — disk-backed under `$CODEX_HOME` (or
   * `~/.claudex`). codex-rs ships this on every call as
   * `x-codex-installation-id` in `client_metadata`; backends aggregate
   * cache + quota against it. Regenerating per-process defeats both.
   * Ref: codex-rs/core/src/installation_id.rs
   */
  get installationId(): string {
    return resolveInstallationId()
  }

  /**
   * Per-turn window id codex-rs sends as `x-codex-window-id`. Native
   * bumps the generation when the context window is compacted; we stay
   * at `0` for now since the outer loop doesn't expose that signal yet.
   * Format: `<conversation_id>:<window_generation>`.
   * Ref: codex-rs/core/src/client.rs current_window_id
   */
  get windowId(): string {
    return `${this.sessionCacheKey}:0`
  }

  /**
   * Stream a Responses API call. Yields parsed SSE events. The caller
   * is responsible for translating them into its own IR and for
   * executing any tool calls the model emits.
   *
   * Retry: initial request retried on 429/5xx with exponential backoff
   * and Retry-After support. Mid-stream errors surface to the caller.
   */
  async *streamResponses(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<CodexStreamEvent> {
    // `store` defaults to the Azure-only behavior codex-rs ships with.
    // Callers can still override by passing `store` explicitly. We also
    // inject `client_metadata.x-codex-installation-id` so the backend
    // aggregates this call against the installation's cache bucket (native
    // codex sends this on every /responses POST).
    const body: CodexResponsesRequest = {
      ...request,
      stream: true,
      store: request.store ?? this.isAzureResponsesEndpoint,
      client_metadata: {
        ...(request.client_metadata ?? {}),
        'x-codex-installation-id': this.installationId,
      },
    }

    const response = await retryWithBackoff(
      async () => {
        const resp = await fetch(`${this.baseUrl}/responses`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal,
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
          throw new CodexApiError(resp.status, errText, retryAfterMs)
        }
        if (!resp.body) throw new CodexApiError(0, 'No response body')
        return resp
      },
      { signal },
    )

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent: string | null = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          // SSE: `event: <name>` lines set the event type; `data: <payload>`
          // lines are the JSON body for the current event.
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const payload = line.slice(6).trim()
            if (payload === '[DONE]') {
              currentEvent = null
              return
            }
            if (!payload) continue
            try {
              const parsed = JSON.parse(payload)
              // The event field is authoritative; fall back to parsed.type
              // if the server omitted an explicit `event:` line.
              const type = currentEvent ?? parsed.type ?? 'unknown'
              yield { ...parsed, type } as CodexStreamEvent
            } catch {
              // Skip malformed JSON payloads rather than crashing the stream.
            }
          } else if (line.trim() === '') {
            currentEvent = null
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * Non-streaming responses call. Returns the final response body.
   * Rarely used — the agent loop always streams. Present for parity.
   */
  async createResponse(request: CodexResponsesRequest, signal?: AbortSignal): Promise<unknown> {
    const body: CodexResponsesRequest = {
      ...request,
      stream: false,
      store: request.store ?? this.isAzureResponsesEndpoint,
      client_metadata: {
        ...(request.client_metadata ?? {}),
        'x-codex-installation-id': this.installationId,
      },
    }
    return retryWithBackoff(
      async () => {
        const resp = await fetch(`${this.baseUrl}/responses`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal,
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
          throw new CodexApiError(resp.status, errText, retryAfterMs)
        }
        return resp.json()
      },
      { signal },
    )
  }

  private buildHeaders(): Record<string, string> {
    const sid = this.sessionCacheKey
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      // codex-rs: build_conversation_headers → `session_id: <conv_id>`.
      // Backend uses this for sticky cache routing so the KV-cache-warm
      // node handles every turn of the same conversation.
      'session_id': sid,
      // codex-rs: inserts `x-client-request-id: <conv_id>` on every
      // Responses POST (endpoint/responses.rs:89-91). Same id as
      // session_id — this is the client-side correlation hint.
      'x-client-request-id': sid,
      // codex-rs: build_responses_identity_headers always stamps
      // `x-codex-window-id: <conv_id>:<gen>` (client.rs:569-571). The
      // backend uses it to scope cache + context window state; requests
      // without it land in an "unknown client" partition on chatgpt.com.
      'x-codex-window-id': this.windowId,
      // codex-rs: default_headers() sets `originator: codex_cli_rs`
      // (login/src/auth/default_client.rs). Backend segments cache per
      // originator; native codex lands under this key.
      'originator': DEFAULT_ORIGINATOR,
      'User-Agent': getCodexUserAgent(),
    }
    if (this.chatgptAccessToken) {
      headers['Authorization'] = `Bearer ${this.chatgptAccessToken}`
      // codex-rs only emits ChatGPT-Account-ID when the JWT actually
      // carries chatgpt_account_id. Empty string is not equivalent —
      // some gateways treat empty as "wrong account", triggering 401 or
      // worse, misrouting cache. Skip the header when unknown.
      if (this.chatgptAccountId) headers['ChatGPT-Account-ID'] = this.chatgptAccountId
    } else if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }
    return headers
  }
}

// ─── Retry Helpers (shared shape with Gemini lane's api.ts) ──────

const DEFAULT_MAX_ATTEMPTS = 5
const INITIAL_DELAY_MS = 2000
const MAX_DELAY_MS = 30_000

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'EPROTO',
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_BAD_RECORD_MAC',
])

function getNetworkErrorCode(error: unknown): string | undefined {
  let cur: unknown = error
  for (let d = 0; d < 5; d++) {
    if (typeof cur !== 'object' || cur === null) return undefined
    if ('code' in cur && typeof (cur as any).code === 'string') return (cur as any).code
    if (!('cause' in cur)) return undefined
    cur = (cur as any).cause
  }
  return undefined
}

function isRetryableTransport(error: unknown): boolean {
  if (error instanceof CodexApiError) return error.isRetryable
  const code = getNetworkErrorCode(error)
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true
  if (error instanceof Error && error.message.toLowerCase().includes('fetch failed')) return true
  return false
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const asSec = Number(value)
  if (!isNaN(asSec)) return Math.max(0, asSec * 1000)
  const asDate = Date.parse(value)
  if (!isNaN(asDate)) return Math.max(0, asDate - Date.now())
  return undefined
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const { signal } = opts
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  let attempt = 0
  let currentDelay = INITIAL_DELAY_MS

  while (attempt < DEFAULT_MAX_ATTEMPTS) {
    attempt++
    try {
      return await fn()
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err
      if (!isRetryableTransport(err) || attempt >= DEFAULT_MAX_ATTEMPTS) throw err

      const retryAfter = err instanceof CodexApiError ? err.retryAfterMs : undefined
      let waitMs: number
      if (retryAfter != null && retryAfter > 0) {
        waitMs = retryAfter + retryAfter * 0.2 * Math.random()
      } else {
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1)
        waitMs = Math.max(0, currentDelay + jitter)
      }

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, waitMs)
        const onAbort = (): void => {
          clearTimeout(t)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })

      currentDelay = Math.min(MAX_DELAY_MS, currentDelay * 2)
    }
  }
  throw new Error('Retry attempts exhausted')
}

// ─── Singleton ───────────────────────────────────────────────────

export const codexApi = new CodexApiClient()
