/**
 * Cloudflare Workers AI transformer.
 *
 * Workers AI exposes an OpenAI-compatible endpoint at:
 *   https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1
 *
 * The model catalog is live-first because Cloudflare adds and retires rows
 * frequently. staticCatalog() is only a fallback when /models is unavailable.
 */

import type { ModelInfo } from '../../../services/api/providers/base_provider.js'
import {
  getCloudflareRequestEffort,
  isCloudflareGlm52EffortModel,
  isCloudflareGptOssEffortModel,
  type CloudflareWireEffort,
} from '../../../utils/model/cloudflareThinking.js'
import type { HeaderContext, Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

type CloudflareFallbackModel = {
  id: string
  name: string
  tags?: readonly string[]
  supportsToolCalling?: boolean
}

const FALLBACK_MODELS: readonly CloudflareFallbackModel[] = [
  {
    id: '@cf/moonshotai/kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    tags: ['tools', 'reasoning', 'recommended'],
  },
  {
    id: '@cf/zai-org/glm-5.2',
    name: 'GLM 5.2',
    tags: ['tools', 'reasoning', 'recommended'],
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    name: 'GPT-OSS 120B',
    tags: ['tools', 'reasoning', 'recommended'],
  },
  {
    id: '@cf/openai/gpt-oss-20b',
    name: 'GPT-OSS 20B',
    tags: ['tools', 'reasoning', 'fast'],
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    name: 'Llama 4 Scout 17B 16E Instruct',
    tags: ['tools', 'fast'],
  },
  {
    id: '@cf/moonshotai/kimi-k2.6',
    name: 'Kimi K2.6',
    tags: ['tools', 'reasoning', 'recommended'],
  },
  {
    id: '@cf/moonshotai/kimi-k2.5',
    name: 'Kimi K2.5',
    tags: ['tools', 'reasoning'],
  },
  {
    id: '@cf/zai-org/glm-4.7-flash',
    name: 'GLM 4.7 Flash',
    tags: ['tools', 'reasoning', 'fast'],
  },
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    name: 'Gemma 4 26B A4B IT',
    tags: ['tools', 'reasoning'],
  },
  {
    id: '@cf/nvidia/nemotron-3-120b-a12b',
    name: 'Nemotron 3 120B A12B',
    tags: ['tools', 'reasoning'],
  },
  {
    id: '@cf/ibm-granite/granite-4.0-h-micro',
    name: 'Granite 4.0 H Micro',
    tags: ['tools', 'fast'],
  },
  {
    id: '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
    name: 'Gemma SEA-LION V4 27B IT',
  },
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    name: 'Qwen3 30B A3B FP8',
    tags: ['tools', 'reasoning'],
  },
  {
    id: '@cf/google/gemma-3-12b-it',
    name: 'Gemma 3 12B IT',
  },
  {
    id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    name: 'Mistral Small 3.1 24B Instruct',
    tags: ['tools'],
  },
  {
    id: '@cf/qwen/qwq-32b',
    name: 'QwQ 32B',
    tags: ['reasoning'],
  },
  {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    name: 'Qwen2.5 Coder 32B Instruct',
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    name: 'DeepSeek R1 Distill Qwen 32B',
    tags: ['reasoning'],
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    name: 'Llama 3.3 70B Instruct FP8 Fast',
    tags: ['tools', 'fast'],
  },
  {
    id: '@cf/meta/llama-3.2-11b-vision-instruct',
    name: 'Llama 3.2 11B Vision Instruct',
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    name: 'Llama 3.2 3B Instruct',
    tags: ['fast'],
  },
  {
    id: '@cf/meta/llama-3.2-1b-instruct',
    name: 'Llama 3.2 1B Instruct',
    tags: ['fast'],
  },
  {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8',
    name: 'Llama 3.1 8B Instruct FP8',
    tags: ['fast'],
  },
]

function fallbackCatalog(): ModelInfo[] {
  const override = process.env.CLOUDFLARE_WORKERS_AI_MODELS?.trim()
  if (override) {
    return override
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(id => ({
        id,
        name: id,
        provider: 'Cloudflare Workers AI',
      }))
  }

  return FALLBACK_MODELS.map(model => ({
    id: model.id,
    name: model.name,
    provider: 'Cloudflare Workers AI',
    ...(model.tags ? { tags: model.tags } : {}),
    ...(model.supportsToolCalling !== undefined
      ? { supportsToolCalling: model.supportsToolCalling }
      : {}),
  }))
}

function ensureChatTemplateKwargs(body: OpenAIChatRequest): Record<string, unknown> {
  const bag = (body as any).chat_template_kwargs
  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    return bag as Record<string, unknown>
  }
  const next: Record<string, unknown> = {}
  ;(body as any).chat_template_kwargs = next
  return next
}

function applyCloudflareThinkingEffort(
  body: OpenAIChatRequest,
  effort: CloudflareWireEffort,
): void {
  if (isCloudflareGlm52EffortModel(body.model)) {
    const kwargs = ensureChatTemplateKwargs(body)
    kwargs.enable_thinking = true
    kwargs.clear_thinking = false
    kwargs.reasoning_effort = effort === 'max' ? 'max' : 'high'
    if (effort === 'high') {
      body.reasoning_effort = 'high'
    } else {
      delete body.reasoning_effort
    }
    return
  }

  if (isCloudflareGptOssEffortModel(body.model)) {
    const normalized = effort === 'max' ? 'high' : effort
    body.reasoning_effort = normalized
    body.reasoning = { effort: normalized }
  }
}

export const cloudflareTransformer: Transformer = {
  id: 'cloudflare',
  displayName: 'Cloudflare Workers AI',
  defaultBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',

  buildHeaders(_apiKey: string, ctx?: HeaderContext): Record<string, string> {
    return ctx?.sessionId ? { 'x-session-affinity': ctx.sessionId } : {}
  },

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (ctx.sessionId) {
      body.prompt_cache_key = ctx.sessionId
      body.user = ctx.sessionId
    }

    const effort = getCloudflareRequestEffort(body.model)
    if (effort) {
      applyCloudflareThinkingEffort(body, effort)
    }
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict'])
  },

  contextExceededMarkers(): string[] {
    return [
      'context length',
      'context_length_exceeded',
      'prompt is too long',
      'maximum context',
      'token limit',
      'too long',
    ]
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return '@cf/openai/gpt-oss-20b'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },

  preferLiveModelCatalog(): boolean {
    return true
  },

  staticCatalog(): ModelInfo[] {
    return fallbackCatalog()
  },
}
