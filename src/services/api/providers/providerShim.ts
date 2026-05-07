/**
 * Provider Shim Factory
 *
 * Returns a duck-typed object that matches the Anthropic SDK interface
 * so that claude.ts, withRetry.ts, and the full agent loop work unchanged.
 *
 * Critical call patterns from claude.ts that we must support:
 *
 *   // Streaming (line ~1822):
 *   const result = await anthropic.beta.messages
 *     .create({ ...params, stream: true }, { signal, headers })
 *     .withResponse()
 *   // result = { data: AsyncIterable<StreamEvent>, request_id, response }
 *   stream = result.data
 *   for await (const part of stream) { ... }
 *
 *   // Non-streaming (line ~864):
 *   return await anthropic.beta.messages.create(params, { signal, timeout })
 *
 * The withRetry wrapper expects getClient() → Promise<Anthropic>.
 */

import type { APIProvider } from '../../../utils/model/providers.js'
import {
  getProviderApiKey,
  getProviderBaseUrl,
  getProviderAuthMethod,
  getProviderOAuthToken,
} from '../../../utils/auth.js'
import { loadProviderKey } from '../auth/api_key_manager.js'
import { getOpenAISessionToken } from '../auth/openai_oauth.js'
import {
  getClineOAuthToken,
  getIFlowApiKey, getIFlowOAuthToken,
  getKiloCodeOAuthToken, getKiloCodeOrgId,
  getCopilotOAuthToken,
  getKiroOAuthToken,
  getValidCursorOAuthToken,
  getCursorMachineId,
} from '../auth/oauth_services.js'
import type {
  BaseProvider,
  AnthropicStreamEvent,
  AnthropicMessage,
  ProviderStreamResult,
} from './base_provider.js'
import { OpenAIProvider } from './openai_provider.js'
import { GeminiProvider } from './gemini_provider.js'
import { OpenRouterProvider } from './openrouter_provider.js'
import { GroqProvider } from './groq_provider.js'
import { NimProvider } from './nim_provider.js'
import { DeepSeekProvider } from './deepseek_provider.js'
import { GlmProvider } from './glm_provider.js'
import { MoonshotProvider } from './moonshot_provider.js'
import { MiniMaxProvider } from './minimax_provider.js'
import { OllamaProvider } from './ollama_provider.js'
import { sanitizeProviderMessagesForNonCursorTransport } from './sanitizeProviderMessages.js'
import { warmupCodeAssist } from './gemini_code_assist.js'
import { initLanes, getLane } from '../../../lanes/index.js'
import { LaneBackedProvider } from '../../../lanes/provider-bridge.js'

// Lazy-init lanes once per process. Reads env-vars AND stored credentials
// (the ones /login writes to provider-keys.json) so users who authenticated
// interactively get lane-routing without having to export env vars.
let _lanesInitialized = false

function normalizeOllamaApiKey(apiKey: string | null | undefined): string | null {
  const key = apiKey?.trim()
  return key && key !== 'ollama' ? key : null
}

function _ensureLanesInitialized(): void {
  if (_lanesInitialized) return
  _lanesInitialized = true
  try {
    // Dual Gemini OAuth: the CLI token covers free-tier flash/lite models,
    // Antigravity covers Gemini 3.x pro/flash. Stored separately so both can
    // coexist — the lane routes per-model via executorForModel.
    const cliOAuthToken = _readStoredGeminiToken('gemini_oauth_cli') ?? undefined
    const antigravityOAuthToken = _readStoredGeminiToken('gemini_oauth_antigravity') ?? undefined
    // Phase 4 OAuth providers — the stored OAuth token IS the lane's
    // bearer credential (iFlow is the odd one: chat uses a derived apiKey
    // pulled from the userinfo endpoint during OAuth, stashed at meta.apiKey).
    const iflowChatKey = getIFlowApiKey() ?? getIFlowOAuthToken() ?? undefined
    const kilocodeToken = getKiloCodeOAuthToken() ?? undefined
    const kilocodeOrgId = getKiloCodeOrgId() ?? null
    // Copilot's stored token IS the internal Copilot API token (not the GH
    // OAuth token). When it expires, refreshCopilotOAuth re-mints via the
    // stored GH refresh token. The session-cached lane snapshot is stale-
    // tolerant: 401s here surface as "/login github-copilot" prompts.
    const copilotToken = getCopilotOAuthToken() ?? undefined
    // Kiro: accessToken is the AWS SSO OIDC bearer; profileArn lives in
    // the stored meta for social-login users and defaults in the lane for
    // Builder-ID users (who don't get one back from the token endpoint).
    const kiroToken = getKiroOAuthToken() ?? undefined
    const kiroProfileArn = _readStoredKiroProfileArn() ?? undefined
    // Cursor: accessToken comes from browser login (or a legacy manual
    // import). machineId is optional — the lane derives it from the
    // token when absent.
    const cursorToken = getValidCursorOAuthToken() ?? undefined
    const cursorMachineId = getCursorMachineId() ?? undefined
    const ollamaApiKey = normalizeOllamaApiKey(getProviderApiKey('ollama'))
    initLanes({
      geminiApiKey: getProviderApiKey('gemini') ?? undefined,
      geminiCliOAuthToken: cliOAuthToken,
      geminiAntigravityOAuthToken: antigravityOAuthToken,
      openaiApiKey: getProviderApiKey('openai') ?? undefined,
      openaiBaseUrl: process.env.OPENAI_BASE_URL ?? getProviderBaseUrl('openai'),
      deepseekApiKey: getProviderApiKey('deepseek') ?? undefined,
      glmApiKey: getProviderApiKey('glm') ?? undefined,
      glmBaseUrl: getProviderBaseUrl('glm'),
      moonshotApiKey: getProviderApiKey('moonshot') ?? undefined,
      moonshotBaseUrl: getProviderBaseUrl('moonshot'),
      minimaxApiKey: getProviderApiKey('minimax') ?? undefined,
      minimaxBaseUrl: getProviderBaseUrl('minimax'),
      groqApiKey: getProviderApiKey('groq') ?? undefined,
      mistralApiKey: process.env.MISTRAL_API_KEY,
      nimApiKey: getProviderApiKey('nim') ?? undefined,
      ollamaApiKey: ollamaApiKey ?? undefined,
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? getProviderBaseUrl('ollama'),
      openrouterApiKey: getProviderApiKey('openrouter') ?? undefined,
      agentrouterApiKey: getProviderApiKey('agentrouter') ?? undefined,
      qwenApiKey: process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY,
      iflowApiKey: iflowChatKey,
      kilocodeApiKey: kilocodeToken,
      kilocodeOrgId: kilocodeOrgId,
      copilotApiKey: copilotToken,
      kiroApiKey: kiroToken,
      kiroProfileArn: kiroProfileArn,
      cursorApiKey: cursorToken,
      cursorMachineId: cursorMachineId,
    })
  } catch {
    // Lane init failure must not break the legacy provider path.
    // The dispatcher will report the lane as unhealthy and the shim
    // falls through to the existing provider implementation.
  }
}

// Map each shim provider name to the native lane it should route to.
// - Anthropic-native providers (claude-*) don't dispatch through a lane.
// - `openai` → codex lane (Responses API, apply_patch).
// - `gemini` → gemini lane.
// - DeepSeek / Groq / NIM / Ollama / OpenRouter → openai-compat lane.
function _laneNameForProvider(provider: APIProvider): string {
  switch (provider) {
    case 'openai':      return 'codex'
    case 'gemini':      return 'gemini'
    // Antigravity rides the same lane as Gemini — the lane's
    // executorForModel() sends gemini-3-* to cloudcode-pa via the
    // antigravity OAuth pool. Lane picks the right executor and creds
    // per-model, the provider split is purely a UX surface.
    case 'antigravity': return 'gemini'
    case 'deepseek':
    case 'glm':
    case 'moonshot':
    case 'minimax':
    case 'groq':
    case 'nim':
    case 'ollama':
    case 'openrouter':
    case 'agentrouter':
      return 'openai-compat'
    case 'cline':
      return 'cline'
    // Phase 4 / Phase 5 OAuth-backed OpenAI-compat providers — share
    // the lane; each gets its own model catalog + base URL branch.
    // Copilot is OAI-compat at the wire level (just needs special headers
    // + the internal token from the github→copilot exchange).
    case 'iflow':
    case 'copilot':
      return 'openai-compat'
    // Kilo has its own lane (native Kilo Gateway wire + subscription-
    // aware catalog). Not compat — matches Kilo CLI behavior.
    case 'kilocode':
      return 'kilo'
    // Kiro has its own lane (CodeWhisperer EventStream) — not compat.
    case 'kiro':
      return 'kiro'
    // Cursor has its own lane (ConnectRPC protobuf) — not compat.
    case 'cursor':
      return 'cursor'
    default:
      return provider as string
  }
}

// Native lanes are ON by default — each model sees its home environment
// (native tools, native prompt, native cache, native streaming). The lane
// auto-disables itself when it can't serve the request (e.g. OAuth-only
// Gemini users fall through to legacy gemini_provider until OAuth is
// ported into the lane), so this flip is safe for all auth paths.
//
// Explicit opt-out for debugging:
//   CLAUDEX_NATIVE_LANES=off             → every lane disabled, legacy path
//   CLAUDEX_NATIVE_LANES=legacy          → same as off
//   CLAUDEX_NATIVE_LANES=-gemini,-codex  → disable specific lanes
//   CLAUDEX_NATIVE_LANES=gemini          → legacy default (named allow-list)
function _nativeLaneEnabledFor(provider: APIProvider): boolean {
  const raw = process.env.CLAUDEX_NATIVE_LANES
  if (!raw) return true  // default ON
  const normalized = raw.toLowerCase().trim()
  if (normalized === 'off' || normalized === 'legacy' || normalized === '0' || normalized === 'false') {
    return false
  }
  if (normalized === 'all' || normalized === '1' || normalized === 'true') return true
  const laneName = _laneNameForProvider(provider)
  const tokens = normalized.split(/[,\s]+/).filter(Boolean)
  // Entries prefixed with `-` opt specific lanes OUT of the default-on set.
  const disabled = new Set(tokens.filter(t => t.startsWith('-')).map(t => t.slice(1)))
  if (disabled.has(laneName) || disabled.has(provider)) return false
  const enabled = tokens.filter(t => !t.startsWith('-'))
  // No allow-list entries → default ON for any lane not explicitly disabled.
  if (enabled.length === 0) return true
  return enabled.includes(laneName) || enabled.includes(provider)
}

/**
 * Create a provider instance for the given provider type.
 * Resolves auth method (API key vs OAuth) and injects the right credentials.
 */
function createProvider(provider: APIProvider): BaseProvider {
  _ensureLanesInitialized()

  // Native-lane opt-in. When set, use the LaneBackedProvider so the model
  // sees its home environment (native tools, native prompt, native cache,
  // native API). Otherwise fall through to the legacy shim path.
  if (_nativeLaneEnabledFor(provider)) {
    const laneName = _laneNameForProvider(provider)
    const lane = getLane(laneName)
    if (lane && lane.isHealthy()) {
      // Pass the provider name as a hint so shared lanes (openai-compat)
      // can filter /v1/models per-provider — otherwise /models groq
      // returns the union of every compat provider's catalog.
      return new LaneBackedProvider(lane, provider)
    }
    // Lane not registered / unhealthy → legacy path below.
  }

  const authMethod = getProviderAuthMethod(provider)
  const apiKey = getProviderApiKey(provider) ?? ''
  const baseUrl = getProviderBaseUrl(provider)

  switch (provider) {
    case 'openai': {
      if (authMethod === 'oauth') {
        const oauthToken = getProviderOAuthToken('openai') ?? ''
        const sessionToken = getOpenAISessionToken() ?? undefined
        return new OpenAIProvider({ apiKey: oauthToken, baseUrl, sessionToken })
      }
      return new OpenAIProvider({ apiKey, baseUrl })
    }
    case 'gemini': {
      if (authMethod === 'oauth') {
        // CLI-tier OAuth only — Antigravity has its own provider row.
        const cliToken = _readStoredGeminiToken('gemini_oauth_cli')
        warmupCodeAssist(cliToken ?? undefined, undefined)
        return new GeminiProvider({
          apiKey: apiKey ?? '',
          baseUrl,
          cliOAuthToken: cliToken ?? undefined,
        })
      }
      return new GeminiProvider({ apiKey, baseUrl })
    }
    case 'antigravity': {
      // Antigravity is OAuth-only, wrapping the same Gemini provider but
      // fed ONLY the antigravity OAuth token. Lane's executorForModel()
      // recognizes the gemini-3-* ids and routes them to cloudcode-pa
      // with the correct Code Assist body envelope.
      const antigravityToken = _readStoredGeminiToken('gemini_oauth_antigravity')
      warmupCodeAssist(undefined, antigravityToken ?? undefined)
      return new GeminiProvider({
        apiKey: '',
        baseUrl,
        antigravityOAuthToken: antigravityToken ?? undefined,
      })
    }
    case 'openrouter':
      return new OpenRouterProvider({ apiKey })
    case 'agentrouter':
      // Routed through the openai-compat lane (LaneBackedProvider) above.
      // We only reach this branch if the lane is unhealthy / not registered,
      // so surface a useful message rather than constructing a stub.
      throw new Error(
        'AgentRouter chat requires the openai-compat lane to be healthy. '
        + 'Run `/login` to authenticate, or check that AGENT_ROUTER_TOKEN or AGENTROUTER_API_KEY is set.',
      )
    case 'groq':
      return new GroqProvider({ apiKey })
    case 'nim':
      return new NimProvider({ apiKey, baseUrl })
    case 'deepseek':
      return new DeepSeekProvider({ apiKey, baseUrl })
    case 'glm':
      return new GlmProvider({ apiKey, baseUrl })
    case 'moonshot':
      return new MoonshotProvider({ apiKey, baseUrl })
    case 'minimax':
      return new MiniMaxProvider({ apiKey, baseUrl })
    case 'ollama':
      return new OllamaProvider({ apiKey, baseUrl })
    // Phase 4 / Phase 5 OAuth-compat providers: they're expected to reach
    // the openai-compat lane above. If we got here, the lane is unhealthy
    // (missing creds or the register step failed) — surface a useful
    // message instead of "Unknown provider".
    case 'cline':
      throw new Error(
        'Cline chat requires the cline lane to be healthy. Run `/login cline` to complete the browser login.',
      )
    case 'iflow':
    case 'copilot':
      throw new Error(
        `${provider} chat requires the openai-compat lane to be healthy. ` +
        `Run \`/login\` to authenticate, or check that the OAuth tokens were stored.`,
      )
    case 'kilocode':
      throw new Error(
        'Kilo chat requires the kilo lane to be healthy. Run `/login kilocode` to authenticate.',
      )
    case 'kiro':
      // Kiro chat routes through the dedicated kiro lane above. We only
      // reach this branch when the lane is unhealthy (no stored token).
      throw new Error(
        'Kiro chat requires the kiro lane to be healthy. Run `/login kiro` to authenticate.',
      )
    case 'cursor':
      throw new Error(
        'Cursor chat requires the cursor lane to be healthy. Run `/login cursor` to complete the browser login.',
      )
    default:
      throw new Error(`Unknown third-party provider: ${provider}`)
  }
}

/**
 * Wraps a ProviderStreamResult so that it looks like an Anthropic SDK
 * `Stream<BetaRawMessageStreamEvent>`, which is what claude.ts iterates.
 *
 * Critically, the `controller` is wired to the provider's own abort so
 * that calling `stream.controller.abort()` in claude.ts actually cancels
 * the in-flight fetch request — not just a disconnected dummy.
 */
function wrapAsAnthropicStream(
  providerStream: ProviderStreamResult,
): AsyncIterable<AnthropicStreamEvent> & { controller: AbortController } {
  const controller = new AbortController()
  const iterable = providerStream[Symbol.asyncIterator]()

  // Bridge: when claude.ts aborts the controller, propagate to provider.
  controller.signal.addEventListener('abort', () => {
    providerStream.abort()
  }, { once: true })

  return {
    controller,
    [Symbol.asyncIterator]() {
      return iterable
    },
  }
}

/**
 * Creates a `.create()` method that returns a "thenable" matching the
 * Anthropic SDK pattern: `create(params, opts).withResponse()`.
 *
 * - If params.stream === true → returns an async iterable of stream events
 *   with `.withResponse()` returning `{ data, request_id, response }`
 * - If params.stream is falsy → returns an AnthropicMessage directly
 *   with `.withResponse()` returning `{ data, request_id, response }`
 *
 * Supports opts.signal (AbortSignal) and opts.timeout (ms) from claude.ts.
 */
function createMethod(p: BaseProvider) {
  return function create(params: Record<string, unknown>, opts?: Record<string, unknown>) {
    const isStreaming = params.stream === true
    const outboundParams =
      p.name === 'cursor'
        ? params
        : sanitizeOutboundParamsForProvider(params)

    // Extract signal and timeout from opts (claude.ts passes these).
    const externalSignal = opts?.signal as AbortSignal | undefined
    const timeoutMs = opts?.timeout as number | undefined

    // Build the base promise. For non-streaming with timeout, use
    // AbortSignal.timeout() combined with any external signal.
    let basePromise: Promise<ProviderStreamResult | AnthropicMessage>
    if (isStreaming) {
      basePromise = p.stream(outboundParams as any)
    } else {
      basePromise = p.create(outboundParams as any)
      // Apply timeout for non-streaming requests (claude.ts passes
      // timeout: 120000 or 300000 for the non-streaming fallback).
      if (timeoutMs && timeoutMs > 0) {
        const timer = setTimeout(() => {}, 0) // no-op, we use race
        basePromise = Promise.race([
          basePromise,
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error(
              `Gemini API error 408: Request timed out after ${timeoutMs}ms`,
            )), timeoutMs)
            // Clean up if the request finishes first.
            basePromise.finally(() => clearTimeout(t))
          }),
        ])
        clearTimeout(timer)
      }
    }

    // If an external signal is provided and already aborted, reject now.
    if (externalSignal?.aborted) {
      basePromise = Promise.reject(new DOMException('Aborted', 'AbortError'))
    }

    // Attach .withResponse() to the promise
    const enhanced = basePromise.then((result: any) => {
      if (isStreaming) {
        // result is a ProviderStreamResult → wrap as Anthropic Stream
        return wrapAsAnthropicStream(result as ProviderStreamResult)
      }
      // result is an AnthropicMessage
      return result
    }) as Promise<any> & {
      withResponse: () => Promise<{ data: any; request_id: string | null; response: Response | null }>
    }

    // .withResponse() wraps the result in { data, request_id, response }
    enhanced.withResponse = () => {
      return basePromise.then((result: any) => {
        if (isStreaming) {
          const stream = wrapAsAnthropicStream(result as ProviderStreamResult)
          return {
            data: stream,
            request_id: null as string | null,
            response: null as Response | null,
          }
        }
        return {
          data: result,
          request_id: null as string | null,
          response: null as Response | null,
        }
      })
    }

    return enhanced
  }
}

function sanitizeOutboundParamsForProvider(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const messages = params.messages
  if (!Array.isArray(messages)) return params
  const sanitizedMessages = sanitizeProviderMessagesForNonCursorTransport(
    messages as import('./base_provider.js').ProviderMessage[],
  )
  return sanitizedMessages === messages
    ? params
    : { ...params, messages: sanitizedMessages }
}

/**
 * Creates a duck-typed object that matches enough of the Anthropic SDK
 * interface for claude.ts, withRetry.ts, and the agent loop to use
 * transparently.
 *
 * Supports:
 *   anthropic.beta.messages.create(params).withResponse()
 *   anthropic.beta.messages.create(params)  (plain)
 *   anthropic.messages.create(params)
 *   for await (const part of stream) { ... }
 */
export function createProviderShim(provider: APIProvider): unknown {
  const p = createProvider(provider)
  const create = createMethod(p)

  return {
    beta: {
      messages: {
        create,
        stream: (params: Record<string, unknown>) =>
          p.stream({ ...params, stream: true } as any),
      },
    },
    messages: {
      create,
      stream: (params: Record<string, unknown>) =>
        p.stream({ ...params, stream: true } as any),
    },
    // Expose provider metadata for diagnostics
    _provider: p,
    _providerName: p.name,
  }
}

/**
 * Get a provider instance directly (for listModels, etc.).
 */
export function getProvider(provider: APIProvider): BaseProvider {
  return createProvider(provider)
}

/**
 * Synchronously read a stored Gemini OAuth token from provider-keys.json.
 * Returns the accessToken if stored and not expired, null otherwise.
 * No async refresh — that's handled by the client.ts pre-flight.
 */
/**
 * Read a stored Gemini OAuth token synchronously from disk.
 *
 * Behavior:
 *   - Returns the access_token string when present.
 *   - If the stored blob is past its `expiresAt` timestamp, fire an
 *     async background refresh via `refreshGeminiOAuth` using the
 *     saved refresh_token; the updated token gets written back to
 *     storage and the NEXT call to this function (next request) will
 *     see the fresh token. We still return the expired token right
 *     now — the API call will 401 and the lane's retry path picks up
 *     the refreshed token from storage on re-read. Better than
 *     returning null and forcing the user to `/login` again.
 *
 * If there's no refresh token (first run, or user revoked), we return
 * null as before.
 */
function _readStoredGeminiToken(storageKey: string): string | null {
  try {
    const raw = loadProviderKey(storageKey)
    if (!raw) return null
    const tokens = JSON.parse(raw) as {
      accessToken?: string
      refreshToken?: string
      expiresAt?: number
    }
    const accessToken = tokens.accessToken ?? null
    const isExpired = tokens.expiresAt != null
      && Date.now() > tokens.expiresAt - 5 * 60 * 1000
    if (isExpired && tokens.refreshToken) {
      // Fire-and-forget refresh — the updated token lands in storage
      // before the request completes in most cases, and if not the 401
      // path re-reads and retries. Avoids blocking the sync boot path.
      _refreshGeminiTokenInBackground(storageKey, tokens.refreshToken)
    }
    return accessToken
  } catch {
    return null
  }
}

/**
 * Async background refresh of a stored Gemini OAuth token. Writes the
 * refreshed access_token + expires_at back via saveProviderKey, AND
 * reconfigures the in-memory Gemini API client so the next request on
 * the SAME session picks up the new token without a process restart.
 */
const _geminiRefreshInFlight = new Map<string, Promise<void>>()
function _refreshGeminiTokenInBackground(
  storageKey: string,
  refreshToken: string,
): void {
  if (_geminiRefreshInFlight.has(storageKey)) return
  const p = (async () => {
    try {
      const type = storageKey === 'gemini_oauth_cli' ? 'cli' : 'antigravity'
      // Dynamic import avoids circular deps between providerShim and
      // google_oauth (which imports from auth/api_key_manager that this
      // file transitively depends on).
      const { refreshGeminiOAuth } = await import('../auth/google_oauth.js')
      await refreshGeminiOAuth(type, refreshToken)
      // refreshGeminiOAuth() already saved the new token blob. Now push
      // it into the lane's in-memory API client so this session uses it.
      const next = loadProviderKey(storageKey)
      if (next) {
        try {
          const parsed = JSON.parse(next) as { accessToken?: string }
          if (parsed.accessToken) {
            const { geminiApi } = await import('../../../lanes/gemini/api.js')
            if (type === 'cli') {
              geminiApi.configure({ cliOAuthToken: parsed.accessToken })
            } else {
              geminiApi.configure({ antigravityOAuthToken: parsed.accessToken })
            }
          }
        } catch {
          // best-effort; the disk write succeeded which is what matters
        }
      }
    } catch {
      // Refresh failed — the access_token may simply have expired AND
      // the refresh_token may have been revoked. The next request will
      // 401 and the auth-stale path prompts the user to re-login.
    } finally {
      _geminiRefreshInFlight.delete(storageKey)
    }
  })()
  _geminiRefreshInFlight.set(storageKey, p)
}

/**
 * Read the stored Kiro profileArn (set for social-login users;
 * undefined for Builder-ID users, who get a hardcoded default in the
 * lane itself). Synchronous — used during lane init.
 */
function _readStoredKiroProfileArn(): string | null {
  try {
    const raw = loadProviderKey('kiro_oauth')
    if (!raw) return null
    const parsed = JSON.parse(raw) as { meta?: { profileArn?: string } }
    return parsed.meta?.profileArn ?? null
  } catch {
    return null
  }
}

/**
 * Reconfigure the Kiro lane's in-memory auth from whatever is currently
 * on disk. Called by /login kiro after it writes new tokens so the
 * session picks them up without a process restart.
 */
export async function reloadKiroLaneAuth(): Promise<void> {
  const accessToken = getKiroOAuthToken() ?? undefined
  const profileArn = _readStoredKiroProfileArn() ?? undefined
  const { kiroLane } = await import('../../../lanes/kiro/index.js')
  kiroLane.configure({ accessToken, profileArn })
}

/**
 * Reconfigure the Copilot provider inside the shared openai-compat lane
 * from whatever token is currently stored on disk. Called after `/login
 * copilot` and after automatic token refresh so the running session
 * stops using any stale bearer captured during lane init.
 */
export async function reloadCopilotLaneAuth(): Promise<void> {
  const { openaiCompatLane } = await import('../../../lanes/openai-compat/index.js')
  const accessToken = getCopilotOAuthToken() ?? undefined
  if (!accessToken) {
    openaiCompatLane.unregisterProvider('copilot')
    return
  }
  openaiCompatLane.registerProvider(
    'copilot',
    accessToken,
    'https://api.githubcopilot.com',
  )
}

/**
 * Reconfigure the Cursor lane's in-memory auth from whatever is currently
 * on disk. Called by /login cursor after it writes a fresh token so the
 * session picks it up without a process restart.
 */
export async function reloadCursorLaneAuth(): Promise<void> {
  const accessToken = getValidCursorOAuthToken() ?? undefined
  const machineId = getCursorMachineId() ?? undefined
  const { cursorLane } = await import('../../../lanes/cursor/index.js')
  cursorLane.configure({ accessToken, machineId })
}

/**
 * Refresh the Cline lane's in-memory auth hints and model cache from disk.
 * The lane also re-reads provider keys dynamically at request time, so this
 * is mainly about immediate health flips after login/logout.
 */
export async function reloadClineLaneAuth(): Promise<void> {
  const accessToken = getClineOAuthToken() ?? undefined
  const { clineLane } = await import('../../../lanes/cline/index.js')
  clineLane.configure({ oauthToken: accessToken })
  clineLane.invalidateModelCache()
}

/**
 * Reconfigure the Kilo lane's in-memory auth + orgId hint from disk and
 * drop its model cache. Called by /login kilocode after writing new
 * tokens so the session picks them up without a process restart.
 */
export async function reloadKiloLaneAuth(): Promise<void> {
  const accessToken = getKiloCodeOAuthToken() ?? null
  const orgId = getKiloCodeOrgId() ?? null
  const { kiloLane } = await import('../../../lanes/kilo/index.js')
  kiloLane.configure({ accessToken, orgId })
  kiloLane.invalidateModelCache()
}

/**
 * Reconfigure an API-key-backed provider inside the shared openai-compat
 * lane. Called after /login writes a new key so DeepSeek/NIM/OpenRouter
 * become usable immediately in the current process.
 */
export async function reloadOpenAICompatProviderAuth(provider: APIProvider): Promise<void> {
  switch (provider) {
    case 'deepseek':
    case 'glm':
    case 'moonshot':
    case 'minimax':
    case 'nim':
    case 'openrouter':
    case 'agentrouter':
    case 'ollama':
      break
    default:
      return
  }

  const { openaiCompatLane } = await import('../../../lanes/openai-compat/index.js')
  if (provider === 'ollama') {
    openaiCompatLane.registerProvider(
      'ollama',
      normalizeOllamaApiKey(getProviderApiKey('ollama')) ?? '',
      getProviderBaseUrl('ollama'),
    )
    openaiCompatLane.setHealthy(true)
    return
  }

  const apiKey = getProviderApiKey(provider)
  if (!apiKey) {
    openaiCompatLane.unregisterProvider(provider)
    return
  }

  openaiCompatLane.registerProvider(provider, apiKey, getProviderBaseUrl(provider))
  openaiCompatLane.setHealthy(true)
}

/**
 * Reconfigure the Gemini lane's in-memory API client from whatever is
 * currently on disk. Called by the /login command right after it writes
 * new tokens, so the session picks them up without a restart.
 */
export async function reloadGeminiLaneAuth(): Promise<void> {
  const cliToken = _readStoredGeminiToken('gemini_oauth_cli') ?? undefined
  const antigravityToken = _readStoredGeminiToken('gemini_oauth_antigravity') ?? undefined
  const apiKey = getProviderApiKey('gemini') ?? undefined
  const { geminiApi } = await import('../../../lanes/gemini/api.js')
  geminiApi.configure({
    apiKey,
    cliOAuthToken: cliToken,
    antigravityOAuthToken: antigravityToken,
  })
  // Mark the lane healthy now that auth is fresh. If neither token is
  // present, configure() already falls back to unhealthy via its own
  // isConfigured check — we just call setHealthy to surface the change.
  const { geminiLane } = await import('../../../lanes/gemini/loop.js')
  geminiLane.setHealthy(!!(apiKey || cliToken || antigravityToken))
}
