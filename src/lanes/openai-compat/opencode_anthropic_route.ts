// Which gateway route each OpenCode Zen / Go row is served on. Keep this in a
// leaf module so routing and lazy-tool capability checks cannot drift.
//
// OpenCode's gateway passes a request body to the row's upstream untouched
// and refuses one whose route does not match that upstream's format: a
// Claude row sent to /chat/completions fails, after authentication, with a
// bare `500 Internal server error` (routes/zen/util/handler.ts, "Zen provider
// format must match request format"). So each row goes where the official
// client sends it: the default endpoint of the AI SDK that models.dev names
// in the row's `provider.npm`.
//
//   @ai-sdk/anthropic  /messages                           Claude, Qwen, MiniMax on Go
//   @ai-sdk/openai     /responses                          GPT, Grok, Muse Spark
//   @ai-sdk/google     /models/{id}:streamGenerateContent  Gemini
//   (no override)      /chat/completions                   everything else
//
// A row models.dev does not describe falls back to the families OpenCode's
// own endpoint tables list off the chat route (docs/zen.mdx, docs/go.mdx).
import { getOpencodeModelMeta } from '../../utils/model/opencodeModelsDevCatalog.js'

export type OpenCodeRoute = 'chat' | 'messages' | 'responses' | 'google' | 'systemone'

// Rows served via the gateway's Anthropic-format route whatever the
// catalogue says: live-verified there (2026-07-11), where their alibaba
// upstream caches only through cache_control breakpoints.
export const OPENCODE_ANTHROPIC_ROUTE_MODELS: ReadonlySet<string> = new Set([
  'qwen3.5-plus',
  'qwen3.6-plus',
  'qwen3.7-plus',
  'qwen3.7-max',
])

export function openCodeRouteFor(provider: string, model: string): OpenCodeRoute {
  const normalized = model.trim().toLowerCase()
  const base = normalized.endsWith('-free') ? normalized.slice(0, -5) : normalized
  if (OPENCODE_ANTHROPIC_ROUTE_MODELS.has(base)) return 'messages'
  // TypeSafe's Jev ("System One") rows are served only on /systemone, a
  // typed-decision API rather than a chat one.
  if (base.startsWith('jev-')) return 'systemone'

  const meta = getOpencodeModelMeta(provider, normalized)
  if (meta) {
    if (meta.sdk === 'anthropic') return 'messages'
    if (meta.sdk === 'openai') return 'responses'
    if (meta.sdk === 'google') return 'google'
    return 'chat'
  }
  if (base.startsWith('claude-')) return 'messages'
  if (/^gpt-\d/.test(base) || base.startsWith('grok-') || base.startsWith('muse-spark')) {
    return 'responses'
  }
  if (base.startsWith('gemini-')) return 'google'
  return 'chat'
}

/**
 * @ai-sdk/openai's test for an OpenAI reasoning model
 * (getOpenAILanguageModelCapabilities): o-series, or gpt-5 and later except
 * the undated `-chat` variants. On /responses only these carry `reasoning`;
 * the SDK drops it for Grok, Muse Spark and any other id.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  const id = model.trim().toLowerCase()
  if (/^o\d+(?:-|$)/.test(id)) return true
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(id)
  if (!match) return false
  const isChat = match[2] === undefined && (match[3]?.startsWith('chat') ?? false)
  return Number(match[1]) >= 5 && !isChat
}

export function isOpenCodeAnthropicRouteModel(
  model: string,
  provider = 'opencode',
): boolean {
  return openCodeRouteFor(provider, model) === 'messages'
}
