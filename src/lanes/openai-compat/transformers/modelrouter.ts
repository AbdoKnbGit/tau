import { getCompatRequestEffort } from '../../../utils/model/compatEffort.js'
import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

const MODELROUTER_TIER_MODELS = new Set(['economy', 'standard', 'premium', 'auto'])

const MODELROUTER_PINNED_MODELS: Array<{ id: string; name: string; provider: string }> = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google' },
  { id: 'gpt-4.1-mini', name: 'GPT 4.1 Mini', provider: 'OpenAI' },
  { id: 'o4-mini', name: 'o4-mini', provider: 'OpenAI' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'Anthropic' },
  { id: 'grok-3-mini-beta', name: 'Grok 3 Mini Beta', provider: 'xAI' },
  { id: 'nvidia.nemotron-nano-3-30b', name: 'Nemotron Nano 3 30B', provider: 'Bedrock' },
  { id: 'nvidia.nemotron-nano-9b-v2', name: 'Nemotron Nano 9B v2', provider: 'Bedrock' },
  { id: 'zai.glm-4.7-flash', name: 'GLM 4.7 Flash', provider: 'Bedrock' },
  { id: 'qwen.qwen3-32b-v1:0', name: 'Qwen3 32B', provider: 'Bedrock' },
  { id: 'openai.gpt-oss-120b-1:0', name: 'GPT OSS 120B', provider: 'Bedrock' },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', provider: 'Groq' },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B', provider: 'Groq' },
  { id: 'llama3.1-8b', name: 'Llama 3.1 8B', provider: 'Cerebras' },
  { id: 'qwen-3-235b-a22b-instruct-2507', name: 'Qwen 3 235B A22B Instruct', provider: 'Cerebras' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google' },
  { id: 'gpt-4.1', name: 'GPT 4.1', provider: 'OpenAI' },
  { id: 'gpt-5.3-chat-latest', name: 'GPT 5.3 Chat Latest', provider: 'OpenAI' },
  { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', provider: 'OpenAI' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT 5.1 Codex Mini', provider: 'OpenAI' },
  { id: 'o3', name: 'o3', provider: 'OpenAI' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic' },
  { id: 'grok-3-beta', name: 'Grok 3 Beta', provider: 'xAI' },
  { id: 'zai.glm-4.7', name: 'GLM 4.7', provider: 'Bedrock' },
  { id: 'deepseek.v3.2', name: 'DeepSeek V3.2', provider: 'Bedrock' },
  { id: 'mistral.mistral-large-3-675b-instruct', name: 'Mistral Large 3 675B Instruct', provider: 'Bedrock' },
  { id: 'moonshotai.kimi-k2.5', name: 'Kimi K2.5', provider: 'Bedrock' },
  { id: 'minimax.minimax-m2.1', name: 'MiniMax M2.1', provider: 'Bedrock' },
  { id: 'qwen.qwen3-next-80b-a3b', name: 'Qwen3 Next 80B A3B', provider: 'Bedrock' },
  { id: 'us.meta.llama4-maverick-17b-instruct-v1:0', name: 'Llama 4 Maverick 17B', provider: 'Bedrock' },
  { id: 'us.meta.llama4-scout-17b-instruct-v1:0', name: 'Llama 4 Scout 17B', provider: 'Bedrock' },
  { id: 'mistral.devstral-2-123b', name: 'Devstral 2 123B', provider: 'Bedrock' },
  { id: 'qwen.qwen3-coder-480b-a35b-v1:0', name: 'Qwen3 Coder 480B A35B', provider: 'Bedrock' },
  { id: 'nvidia.nemotron-super-3-120b', name: 'Nemotron Super 3 120B', provider: 'Bedrock' },
  { id: 'qwen.qwen3-235b-a22b-2507-v1:0', name: 'Qwen3 235B A22B', provider: 'Bedrock' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', provider: 'Google' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'Anthropic' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'Anthropic' },
  { id: 'gpt-5.4', name: 'GPT 5.4', provider: 'OpenAI' },
  { id: 'zai.glm-5', name: 'GLM 5', provider: 'Bedrock' },
]

const MODELROUTER_ALIASES = new Map<string, string>([
  ['claude-3-5-haiku', 'claude-haiku-4-5'],
  ['claude-3-5-haiku-20241022', 'claude-haiku-4-5'],
  ['anthropic/claude-3-5-haiku', 'claude-haiku-4-5'],
  ['anthropic/claude-3-5-haiku-20241022', 'claude-haiku-4-5'],
  ['claude-haiku-4.5', 'claude-haiku-4-5'],
  ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
  ['anthropic/claude-haiku-4-5', 'claude-haiku-4-5'],
  ['anthropic/claude-haiku-4.5', 'claude-haiku-4-5'],
  ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
  ['anthropic/claude-sonnet-4-6', 'claude-sonnet-4-6'],
  ['claude-opus-4.7', 'claude-opus-4-7'],
  ['anthropic/claude-opus-4-7', 'claude-opus-4-7'],
  ['claude-opus-4.6', 'claude-opus-4-6'],
  ['anthropic/claude-opus-4-6', 'claude-opus-4-6'],
  ['gpt-oss-120b', 'openai.gpt-oss-120b-1:0'],
  ['openai/gpt-oss-120b', 'openai.gpt-oss-120b-1:0'],
  ['openai.gpt-oss-120b', 'openai.gpt-oss-120b-1:0'],
  ['deepseek-v3.2', 'deepseek.v3.2'],
  ['deepseek/deepseek-v3.2', 'deepseek.v3.2'],
  ['glm-4.7-flash', 'zai.glm-4.7-flash'],
  ['glm-4.7', 'zai.glm-4.7'],
  ['glm-5', 'zai.glm-5'],
  ['gemini-3.1-pro', 'gemini-3.1-pro-preview'],
  ['mistral-large-3', 'mistral.mistral-large-3-675b-instruct'],
  ['mistral-large', 'mistral.mistral-large-3-675b-instruct'],
  ['kimi-k2.5', 'moonshotai.kimi-k2.5'],
  ['moonshot/kimi-k2.5', 'moonshotai.kimi-k2.5'],
  ['minimax-m2.1', 'minimax.minimax-m2.1'],
  ['qwen3-32b', 'qwen.qwen3-32b-v1:0'],
  ['qwen/qwen3-32b', 'qwen.qwen3-32b-v1:0'],
  ['qwen3-coder', 'qwen.qwen3-coder-480b-a35b-v1:0'],
  ['nemotron-super-3-120b', 'nvidia.nemotron-super-3-120b'],
  ['nemotron-nano-3-30b', 'nvidia.nemotron-nano-3-30b'],
  ['nemotron-nano-9b-v2', 'nvidia.nemotron-nano-9b-v2'],
])

export const modelRouterTransformer: Transformer = {
  id: 'modelrouter',
  displayName: 'Model Router',
  defaultBaseUrl: 'https://api.lxg2it.com/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested > 8192 ? 8192 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    body.model = normalizeModelRouterModel(body.model)
    stripRoutingHintsForPinnedModel(body)
    applyOpenAIReasoningEffort(body, ctx)
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'pattern', 'format', 'default'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'maximum context', 'token limit']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    if (m.includes('gpt-5') || m.includes('claude') || m.includes('gemini-3') || m.includes('gemini-2.5')) {
      return 'apply_patch'
    }
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'claude-haiku-4-5'
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    if (isAnthropicModelRouterModel(normalizeModelRouterModel(model))) return 'last-only'
    return 'none'
  },

  staticCatalog() {
    return MODELROUTER_PINNED_MODELS.map(model => ({ ...model }))
  },

  preferLiveModelCatalog(): boolean {
    return true
  },

  filterModelCatalog(models) {
    const byId = new Map<string, { id: string; name?: string }>()
    for (const model of models) byId.set(model.id, model)
    for (const model of MODELROUTER_PINNED_MODELS) {
      if (!byId.has(model.id)) byId.set(model.id, model)
    }
    return [...byId.values()]
  },
}

function applyOpenAIReasoningEffort(
  body: OpenAIChatRequest,
  ctx: TransformContext,
): void {
  const effort = getCompatRequestEffort('modelrouter', body.model, ctx.effortValue)
  if (effort) body.reasoning_effort = effort
  else delete body.reasoning_effort
}

function normalizeModelRouterModel(model: string): string {
  const trimmed = model.trim()
  const normalized = trimmed.toLowerCase()
  if (MODELROUTER_TIER_MODELS.has(normalized)) return normalized
  return MODELROUTER_ALIASES.get(normalized) ?? trimmed
}

function isAnthropicModelRouterModel(model: string): boolean {
  const normalized = model.toLowerCase()
  return normalized.startsWith('claude-') || normalized.startsWith('anthropic/')
}

function stripRoutingHintsForPinnedModel(body: OpenAIChatRequest): void {
  if (MODELROUTER_TIER_MODELS.has(body.model.toLowerCase())) return

  const bag = body as OpenAIChatRequest & {
    prefer?: string
  }
  delete bag.prefer
  delete bag.route
  delete bag.models
  delete bag.transforms

  const extra = bag.extra_body
  if (extra && typeof extra === 'object') {
    delete extra.prefer
    delete extra.route
    delete extra.models
    delete extra.transforms
  }
}
