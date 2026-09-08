/**
 * OpenRouter provider — extends OpenAIProvider with OpenRouter-specific headers.
 *
 * OpenRouter is an API aggregator that routes to multiple model providers.
 * It uses the OpenAI-compatible API with extra headers for ranking/attribution.
 *
 * Base URL: https://openrouter.ai/api/v1
 * Auth: Bearer token (sk-or-...)
 * Extra headers: HTTP-Referer, X-OpenRouter-Title,
 * X-OpenRouter-Categories (for app rankings)
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ModelInfo, ProviderConfig, ProviderRequestParams } from './base_provider.js'
import type { OpenAIMessage, OpenAITool } from '../adapters/anthropic_to_openai.js'
import {
  toOpenRouterModelInfo,
  OPENROUTER_ALLOWLIST,
  type OpenRouterCatalogModel,
} from '../../../utils/model/openrouterCatalog.js'
import { resolveOpenRouterVirtualModelId } from '../../../utils/model/openrouterAliases.js'
import { normalizeOpenRouterGPTToolSchemas } from '../../../utils/model/openrouterStrictSchema.js'
import {
  getOpenRouterReasoningMeta,
  recordOpenRouterCatalogPayload,
} from '../../../utils/model/openrouterReasoningCatalog.js'
import { resolveOpenRouterReasoningField } from '../../../utils/model/openrouterThinking.js'

export class OpenRouterProvider extends OpenAIProvider {
  readonly name = 'openrouter'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: 'https://openrouter.ai/api/v1',
      extraHeaders: {
        // OpenRouter uses these for app rankings and attribution.
        'HTTP-Referer': process.env.OPENROUTER_REFERER ?? 'https://github.com/AbdoKnbGit/tau',
        'X-OpenRouter-Title': process.env.OPENROUTER_TITLE ?? 'Tau',
        'X-OpenRouter-Categories': process.env.OPENROUTER_CATEGORIES ?? 'cli-agent',
        'X-Title': process.env.OPENROUTER_TITLE ?? 'Tau',
        ...(config.extraHeaders ?? {}),
      },
    })
    // OpenRouter passes cache_control through to underlying providers
    // (Anthropic, Google, etc.) enabling prompt caching.
    this.preserveCacheControl = true
  }

  protected override _headers(model?: string): Record<string, string> {
    const headers = super._headers(model)
    if (model) headers['x-session-id'] = this.cacheSessionKeyForModel(model)
    return headers
  }

  protected override cacheSessionKeyForModel(_model: string): string {
    return normalizeOpenRouterSessionId(this.cacheSessionKey)
  }

  override resolveModel(model: string): string {
    return resolveOpenRouterVirtualModelId(super.resolveModel(model))
  }

  /**
   * OpenRouter routes to frontier models (Claude, GPT-4, Gemini, etc.)
   * that fully support tool calling, agents, MCP servers, and plugins.
   * Skip the payload optimization that strips tools down to core-only —
   * send the full tool set so all claudex features work.
   */
  protected optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    return params
  }

  protected override finalizeChatCompletionsBody(
    body: Record<string, unknown>,
    model: string,
    params: ProviderRequestParams,
    messages: OpenAIMessage[],
    tools: OpenAITool[] | undefined,
  ): void {
    applyOpenRouterReasoning(body, model, params.thinking)
    const sessionKey = this.cacheSessionKeyForModel(model)
    body.session_id = sessionKey
    body.prompt_cache_key = sessionKey
    body.usage = {
      ...(isRecord(body.usage) ? body.usage : {}),
      include: true,
    }
    const retention = resolveOpenRouterCacheRetention()
    if (retention === 'long') body.prompt_cache_retention = '24h'
    else delete body.prompt_cache_retention

    moveOpenRouterVolatileSystemTail(messages)
    applyOpenRouterMessageCacheBreakpoints(messages, model)
    normalizeOpenRouterGPTToolSchemas(tools, model)
    applyOpenRouterToolCacheBreakpoint(tools, model)
    applyOpenRouterContextCompressionPlugin(body)
  }

  /**
   * OpenRouter exposes a unified `reasoning` field that every upstream
   * provider (Anthropic, OpenAI, Google, DeepSeek, etc.) respects via
   * their native reasoning surface. We always map the /thinking toggle
   * through this, rather than overriding reasoning_effort, so every
   * thinking-capable model routed via OpenRouter behaves consistently.
   */
  protected modelSupportsReasoningEffort(_model: string): boolean {
    // We return true so the base OpenAIProvider branch runs and
    // `reasoning_effort` is set. OpenRouter accepts both
    // `reasoning_effort` and `reasoning: { effort }`; models that don't
    // reason quietly ignore the flag.
    return true
  }

  /**
   * OpenRouter has its own model list endpoint with richer metadata
   * including pricing, context length, and provider info.
   */
  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    })

    if (!response.ok) return []

    const payload = await response.json()
    // The same document states each row's reasoning ladder. Recording it here
    // means the common path costs no extra request.
    recordOpenRouterCatalogPayload(payload)
    const data = payload as { data: OpenRouterCatalogModel[] }

    return (data.data ?? [])
      .filter(m => {
        if (typeof m.id !== 'string') return false
        // Strip :free suffix for allowlist lookup
        const baseId = m.id.replace(/:free$/, '')
        return OPENROUTER_ALLOWLIST.has(baseId) || OPENROUTER_ALLOWLIST.has(m.id)
      })
      .map(toOpenRouterModelInfo)
      .filter((model): model is ModelInfo => model !== null)
  }
}

function normalizeOpenRouterSessionId(sessionId: string): string {
  if (sessionId.length <= 256) return sessionId
  const hash = shortStableHash(sessionId)
  return `${sessionId.slice(0, 247)}:${hash}`
}

/**
 * Steer reasoning through OpenRouter's own per-model ladder.
 *
 * The base class puts `reasoning_effort` on the body from the OpenAI picker's
 * low/medium/high scale. That scale is not a subset of every OpenRouter row's
 * ladder — `x-ai/grok-4.20` publishes only low/high/max — so once OpenRouter
 * has described the model, the described field replaces it rather than riding
 * alongside it. Rows OpenRouter has not described keep the previous behaviour.
 */
function applyOpenRouterReasoning(
  body: Record<string, unknown>,
  model: string,
  thinking: ProviderRequestParams['thinking'],
): void {
  if (!getOpenRouterReasoningMeta(model)) return
  const enabled = !!thinking && thinking.type !== 'disabled'
  const reasoning = resolveOpenRouterReasoningField(model, {
    enabled,
    effort: reasoningEffortFromThinking(thinking),
  })
  // An off-ladder effort is a 400 whether or not a replacement is going out,
  // so the base class's value goes either way.
  delete body.reasoning_effort
  if (reasoning) body.reasoning = reasoning
}

/** Anthropic thinking budget → the low/medium/high scale, as the lane maps it. */
function reasoningEffortFromThinking(
  thinking: ProviderRequestParams['thinking'],
): 'low' | 'medium' | 'high' | null {
  if (!thinking || thinking.type === 'disabled') return null
  const budget = (thinking as { budget_tokens?: number }).budget_tokens
  if (budget == null) return 'medium'
  if (budget < 2000) return 'low'
  if (budget < 8000) return 'medium'
  return 'high'
}

const OPENROUTER_VOLATILE_CONTEXT = Symbol('openrouter volatile context')
const OPENROUTER_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

const OPENROUTER_VOLATILE_SYSTEM_PATTERNS: readonly RegExp[] = [
  /# Session-specific guidance\b[\s\S]*?(?=\n#|$)/,
  /<env>[\s\S]*?<\/env>/,
  /# Environment\b[\s\S]*?(?=\n#|$)/,
  /# currentDate\n[^\n]+/,
  /Today's date is [^\n]+/,
  /# gitStatus\b[\s\S]*?(?=\n\n|\n#|$)/,
  /gitStatus:[\s\S]*?(?=\n\n|\n#|$)/,
  /Current branch:[\s\S]*?(?=\n\n|\n#|$)/,
  /Working directory:[\s\S]*?(?=\n\n|\n#|$)/,
  /Primary working directory:[\s\S]*?(?=\n\n|\n#|$)/,
]

type OpenRouterCacheRetention = 'none' | 'short' | 'long'
type OpenRouterContextCompressionMode = 'enabled' | 'disabled'

function moveOpenRouterVolatileSystemTail(messages: OpenAIMessage[]): void {
  const system = messages.find(message => message.role === 'system')
  const text = openAIMessageText(system)
  if (!system || !text) return

  const { stable, volatile } = splitOpenRouterSystemForCache(text)
  if (!volatile) return

  system.content = stable
  const dynamicMessage: OpenAIMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<dynamic_context>\n${volatile.trim()}\n</dynamic_context>`,
      },
    ],
  }
  ;(dynamicMessage as OpenAIMessage & { [OPENROUTER_VOLATILE_CONTEXT]?: true })[OPENROUTER_VOLATILE_CONTEXT] = true

  const last = messages[messages.length - 1]
  if (last?.role === 'user') {
    messages.splice(messages.length - 1, 0, dynamicMessage)
  } else {
    messages.push(dynamicMessage)
  }
}

function applyOpenRouterMessageCacheBreakpoints(messages: OpenAIMessage[], model = ''): void {
  if (isGeminiOnOpenRouter(model)) {
    applyGeminiOpenRouterMessageCacheBreakpoint(messages)
    return
  }

  const system = messages.find(message => message.role === 'system')
  if (system) stampOpenRouterCacheControl(system)

  let stamped = 0
  for (let i = messages.length - 1; i >= 0 && stamped < 2; i--) {
    const message = messages[i]!
    if ((message as OpenAIMessage & { [OPENROUTER_VOLATILE_CONTEXT]?: true })[OPENROUTER_VOLATILE_CONTEXT]) {
      continue
    }
    if (message.role !== 'user' && message.role !== 'tool') continue
    stampOpenRouterCacheControl(message)
    stamped++
  }
}

function applyGeminiOpenRouterMessageCacheBreakpoint(messages: OpenAIMessage[]): void {
  const last = messages[messages.length - 1]
  const start = last && (last.role === 'user' || last.role === 'tool')
    ? messages.length - 2
    : messages.length - 1

  for (let i = start; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'system') continue
    if (stampGeminiOpenRouterMessage(message)) return
  }

  const system = messages.find(message => message.role === 'system')
  if (system) stampGeminiOpenRouterMessage(system)
}

function stampGeminiOpenRouterMessage(message: OpenAIMessage): boolean {
  const before = JSON.stringify(message.content)
  stampOpenRouterCacheControl(message)
  return JSON.stringify(message.content) !== before
}

function applyOpenRouterToolCacheBreakpoint(tools: OpenAITool[] | undefined, model: string): void {
  if (!tools?.length) return
  const lastTool = tools[tools.length - 1]
  if (lastTool && !lastTool.cache_control) {
    lastTool.cache_control = { type: 'ephemeral' }
  }
}

function isGeminiOnOpenRouter(model: string): boolean {
  const id = model.toLowerCase()
  return id.startsWith('google/gemini') || id.includes('gemini-')
}

function stampOpenRouterCacheControl(message: OpenAIMessage): void {
  if (typeof message.content === 'string') {
    const text = message.content
    message.content = [
      {
        type: 'text',
        text: text.length > 0 ? text : ' ',
        cache_control: { type: 'ephemeral' },
      },
    ]
    return
  }

  if (!Array.isArray(message.content) || message.content.length === 0) return
  const last = message.content[message.content.length - 1]
  if (last && last.type === 'text' && !last.cache_control) {
    last.cache_control = { type: 'ephemeral' }
  }
}

function openAIMessageText(message: OpenAIMessage | undefined): string {
  if (!message?.content) return ''
  if (typeof message.content === 'string') return message.content
  return message.content.map(part => part.text ?? '').join('\n')
}

function splitOpenRouterSystemForCache(text: string): {
  stable: string
  volatile: string
} {
  const markerIdx = text.indexOf(OPENROUTER_DYNAMIC_BOUNDARY)
  if (markerIdx >= 0) {
    return {
      stable: text.slice(0, markerIdx).replace(/\s+$/, ''),
      volatile: text.slice(markerIdx + OPENROUTER_DYNAMIC_BOUNDARY.length).replace(/^\s+/, ''),
    }
  }

  const cutoff = Math.floor(text.length * 0.3)
  const matches: Array<{ start: number }> = []
  for (const pattern of OPENROUTER_VOLATILE_SYSTEM_PATTERNS) {
    const match = text.match(pattern)
    if (match && match.index != null && match.index >= cutoff) {
      matches.push({ start: match.index })
    }
  }
  if (matches.length === 0) return { stable: text, volatile: '' }

  matches.sort((a, b) => a.start - b.start)
  const cut = matches[0]!.start
  return {
    stable: text.slice(0, cut).replace(/\s+$/, ''),
    volatile: text.slice(cut).replace(/^\s+/, ''),
  }
}

function resolveOpenRouterCacheRetention(): OpenRouterCacheRetention {
  const raw = (
    process.env.CLAUDEX_OPENROUTER_CACHE_RETENTION
    ?? process.env.OPENROUTER_CACHE_RETENTION
    ?? ''
  ).trim().toLowerCase()

  if (raw === 'none' || raw === 'off' || raw === 'false' || raw === '0' || raw === 'disabled') {
    return 'none'
  }
  if (raw === 'long' || raw === '24h') {
    return 'long'
  }
  return 'short'
}

function resolveOpenRouterContextCompressionMode(): OpenRouterContextCompressionMode {
  const raw = (
    process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION
    ?? process.env.OPENROUTER_CONTEXT_COMPRESSION
    ?? ''
  ).trim().toLowerCase()

  if (raw === 'on' || raw === 'true' || raw === '1' || raw === 'enabled') {
    return 'enabled'
  }
  return 'disabled'
}

function applyOpenRouterContextCompressionPlugin(body: Record<string, unknown>): void {
  const mode = resolveOpenRouterContextCompressionMode()
  const plugins = Array.isArray(body.plugins)
    ? body.plugins as Array<Record<string, unknown>>
    : undefined
  const existing = plugins?.find(plugin => plugin.id === 'context-compression')

  if (mode === 'disabled') {
    if (existing) existing.enabled = false
    return
  }

  if (existing) {
    delete existing.enabled
    return
  }

  body.plugins = [...(plugins ?? []), { id: 'context-compression' }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shortStableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
