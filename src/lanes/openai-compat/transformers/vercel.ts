import { getCompatRequestEffort } from '../../../utils/model/compatEffort.js'
import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

export const vercelTransformer: Transformer = {
  id: 'vercel',
  displayName: 'Vercel AI Gateway',
  defaultBaseUrl: 'https://ai-gateway.vercel.sh/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested > 8192 ? 8192 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    enableVercelAutoCaching(body)
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
    if (m.includes('anthropic/') || m.includes('claude-')) return 'apply_patch'
    if (m.includes('openai/gpt-5') || m.includes('openai/o1') || m.includes('openai/o3')) return 'apply_patch'
    if (m.includes('google/gemini-3') || m.includes('google/gemini-2.5')) return 'apply_patch'
    return 'edit_block'
  },

  smallFastModel(model: string): string | null {
    const m = model.toLowerCase()
    if (m.startsWith('anthropic/')) return 'anthropic/claude-haiku-4-5'
    if (m.startsWith('openai/')) return 'openai/gpt-4o-mini'
    if (m.startsWith('google/')) return 'google/gemini-2.5-flash-lite'
    return null
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    void model
    return 'none'
  },
}

function enableVercelAutoCaching(body: OpenAIChatRequest): void {
  const current = body.providerOptions ?? {}
  const gateway = typeof current.gateway === 'object' && current.gateway !== null
    ? current.gateway
    : {}
  body.providerOptions = {
    ...current,
    gateway: {
      ...gateway,
      caching: gateway.caching ?? 'auto',
    },
  }
}

function applyOpenAIReasoningEffort(
  body: OpenAIChatRequest,
  ctx: TransformContext,
): void {
  const effort = getCompatRequestEffort('vercel', body.model, ctx.effortValue)
  if (effort) body.reasoning_effort = effort
  else delete body.reasoning_effort
}
