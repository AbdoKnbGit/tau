import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import { recordModelVision } from '../../lanes/shared/vision_capability.js'

/**
 * Curated allowlist of OpenRouter models to show in the picker.
 * Only these model IDs (exact match, ignoring :free suffix) will appear.
 */
export const OPENROUTER_ALLOWLIST = new Set([
  // OpenAI
  'openai/gpt-5.5-pro',
  'openai/gpt-5.5',
  'openai/gpt-5.4-image-2',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-pro',
  'openai/gpt-5.4',
  'openai/gpt-5.3-chat',
  'openai/gpt-5.3-codex',
  'openai/gpt-audio',
  'openai/gpt-audio-mini',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.2-chat',
  'openai/gpt-5.2-pro',
  'openai/gpt-5.2',
  'openai/gpt-5.1-codex-max',
  'openai/gpt-5.1',
  'openai/gpt-5.1-chat',
  'openai/gpt-5.1-codex',
  'openai/gpt-5.1-codex-mini',
  'openai/gpt-oss-safeguard-20b',
  'openai/gpt-5-image-mini',
  'openai/gpt-5-image',
  'openai/gpt-5-pro',
  'openai/gpt-5-codex',
  'openai/gpt-4o-audio',
  'openai/gpt-5-chat',
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'openai/gpt-5-nano',
  'openai/gpt-oss-120b',
  // NVIDIA
  'nvidia/nemotron-3-super',
  'nvidia/nemotron-3-nano-30b-a3b',
  'nvidia/nemotron-nano-12b-2-vl',
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'nvidia/nemotron-nano-9b-v2',
  // Anthropic
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.6-fast',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-opus-4.5',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-opus-4.1',
  'anthropic/claude-opus-4',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-3.7-sonnet-thinking',
  // Google
  'google/gemma-4-26b-a4b',
  'google/gemma-4-31b',
  'google/lyria-3-pro-preview',
  'google/lyria-3-clip-preview',
  'google/gemini-3.1-flash-lite-preview',
  'google/nano-banana-2',
  'google/gemini-3.1-pro-preview-custom-tools',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3-flash-preview',
  // Z.ai
  'z-ai/glm-5.1',
  'z-ai/glm-5v-turbo',
  'z-ai/glm-5-turbo',
  'z-ai/glm-5',
  'z-ai/glm-4.7-flash',
  'z-ai/glm-4.7',
  'z-ai/glm-4.6v',
  'z-ai/glm-4.6',
  'z-ai/glm-4.5v',
  'z-ai/glm-4.5',
  'z-ai/glm-4.5-air',
  // Qwen
  'qwen/qwen-3.6-plus',
  'qwen/qwen-3.5-9b',
  'qwen/qwen-3.5-35b-a3b',
  'qwen/qwen-3.5-27b',
  'qwen/qwen-3.5-122b-a10b',
  'qwen/qwen-3.5-flash',
  'qwen/qwen-3.5-plus-2026-02-15',
  'qwen/qwen-3.5-397b-a17b',
  'qwen/qwen-3-max-thinking',
  'qwen/qwen-3-coder-next',
  'qwen/qwen-3-vl-32b-instruct',
  'qwen/qwen-3-vl-8b-thinking',
  'qwen/qwen-3-vl-8b-instruct',
  'qwen/qwen-3-vl-30b-a3b-thinking',
  'qwen/qwen-3-vl-30b-a3b-instruct',
  'qwen/qwen-3-vl-235b-a22b-thinking',
  'qwen/qwen-3-vl-235b-a22b-instruct',
  'qwen/qwen-3-max',
  'qwen/qwen-3-coder-plus',
  'qwen/qwen-3-coder-flash',
  'qwen/qwen-3-next-80b-a3b-thinking',
  'qwen/qwen-3-next-80b-a3b-instruct',
  // MoonshotAI
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2-thinking',
  'moonshotai/kimi-k2-0905',
  'moonshotai/kimi-k2-0711',
  // MiniMax
  'minimax/minimax-m2.7',
  'minimax/minimax-m2.5',
  // DeepSeek
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'nex-agi/deepseek-v3.1-nex-n1',
  'deepseek/deepseek-v3.2-speciale',
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-v3.2-exp',
  'deepseek/deepseek-v3.1-terminus',
  // inclusionAI
  'inclusionai/ling-2.6-1t',
  'inclusionai/ling-2.6-flash',
  // xAI
  'x-ai/grok-4.20-multi-agent',
  'x-ai/grok-4.20',
  'x-ai/grok-4.1-fast',
  'x-ai/grok-4-fast',
  'x-ai/grok-code-fast-1',
])

export interface OpenRouterCatalogModel {
  id?: string
  name?: string
  context_length?: number
  pricing?: Record<string, string | number | undefined>
  /**
   * OpenRouter states input modalities per model, e.g.
   * `{ input_modalities: ["text", "image"], modality: "text+image->text" }`.
   * This is the authoritative answer to "can this model see?" for the whole
   * OpenRouter catalog, so it is parsed rather than guessed at.
   */
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
    modality?: string
  }
}

/** True when OpenRouter says the model takes image input. */
export function openRouterModelAcceptsImages(
  model: OpenRouterCatalogModel,
): boolean {
  const modalities = model.architecture?.input_modalities
  if (Array.isArray(modalities)) {
    return modalities.some(m => typeof m === 'string' && m.toLowerCase() === 'image')
  }
  // Legacy field: "text+image->text".
  const legacy = model.architecture?.modality
  if (typeof legacy === 'string') {
    const input = legacy.split('->')[0] ?? ''
    return input.toLowerCase().includes('image')
  }
  return false
}

const PROVIDER_LABELS: Record<string, string> = {
  aionlabs: 'AionLabs',
  'aion-labs': 'AionLabs',
  allenai: 'AllenAI',
  anthropic: 'Anthropic',
  'arcee-ai': 'Arcee AI',
  baidu: 'Baidu',
  bytedance: 'ByteDance Seed',
  'bytedance-seed': 'ByteDance Seed',
  deepseek: 'DeepSeek',
  google: 'Google',
  inclusionai: 'inclusionAI',
  kwaipilot: 'Kwaipilot',
  liquidai: 'LiquidAI',
  liquid: 'LiquidAI',
  meta: 'Meta',
  'meta-llama': 'Meta Llama',
  minimax: 'MiniMax',
  minimaxai: 'MiniMax',
  mistral: 'Mistral',
  mistralai: 'Mistral',
  moonshotai: 'MoonshotAI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  qwen: 'Qwen',
  stepfun: 'StepFun',
  'stepfun-ai': 'StepFun',
  tencent: 'Tencent',
  upstage: 'Upstage',
  writer: 'Writer',
  'nex-agi': 'Nex AGI',
  'x-ai': 'xAI',
  xai: 'xAI',
  xiaomi: 'Xiaomi',
  'z-ai': 'Z.ai',
  zai: 'Z.ai',
}

export function toOpenRouterModelInfo(model: OpenRouterCatalogModel): ModelInfo | null {
  if (typeof model.id !== 'string' || model.id.length === 0) {
    return null
  }

  const provider = inferOpenRouterProvider(model)
  const free = isFreeOpenRouterModel(model)
  const vision = openRouterModelAcceptsImages(model)
  const tagList: string[] = []
  if (free) tagList.push('free')
  if (vision) tagList.push('vision')

  // Remember what the catalog said so request-time conversion can send real
  // images to models that accept them instead of transcribing everything.
  recordModelVision('openrouter', model.id, vision)

  return {
    id: model.id,
    name: normalizeOpenRouterModelName(model.name ?? model.id, provider, free),
    provider,
    contextWindow: model.context_length,
    ...(tagList.length > 0 ? { tags: tagList } : {}),
  }
}

export function inferProviderLabelFromModelId(id: string, fallback = 'Unknown'): string {
  const rawPrefix = id.split('/')[0]?.replace(/^~/, '').trim()
  if (!rawPrefix) return fallback

  const normalized = rawPrefix.toLowerCase()
  return PROVIDER_LABELS[normalized] ?? humanizeProviderPrefix(rawPrefix)
}

function inferOpenRouterProvider(model: OpenRouterCatalogModel): string {
  const nameProvider = parseProviderPrefixFromName(model.name)
  if (nameProvider) return nameProvider

  return inferProviderLabelFromModelId(model.id ?? '')
}

function parseProviderPrefixFromName(name?: string): string | null {
  if (!name) return null

  const match = /^([^:]{2,40}):\s+/.exec(name.trim())
  return match ? match[1]!.trim() : null
}

function normalizeOpenRouterModelName(name: string, provider: string, free: boolean): string {
  let normalized = name.trim()
  const prefix = `${provider}:`
  if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
    normalized = normalized.slice(prefix.length).trim()
  }
  if (free) {
    normalized = normalized.replace(/\s+\(free\)$/i, '').trim()
  }
  return normalized || name
}

function isFreeOpenRouterModel(model: OpenRouterCatalogModel): boolean {
  return priceValue(model.pricing?.prompt) === 0
    && priceValue(model.pricing?.completion) === 0
}

function priceValue(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function humanizeProviderPrefix(prefix: string): string {
  return prefix
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.length <= 2 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
}
