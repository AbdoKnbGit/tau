import { getCompatRequestEffort } from '../../../utils/model/compatEffort.js'
import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

export const requestyTransformer: Transformer = {
  id: 'requesty',
  displayName: 'Requesty',
  defaultBaseUrl: 'https://router.requesty.ai/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested > 8192 ? 8192 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    enableRequestyAutoCaching(body)
    applyOpenAIReasoningEffort(body, ctx)
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'pattern', 'format', 'default'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_window', 'context_length_exceeded', 'prompt is too long', 'maximum context', 'token limit']
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

function enableRequestyAutoCaching(body: OpenAIChatRequest): void {
  body.requesty = {
    ...(body.requesty ?? {}),
    auto_cache: body.requesty?.auto_cache ?? true,
  }
}

function applyOpenAIReasoningEffort(
  body: OpenAIChatRequest,
  ctx: TransformContext,
): void {
  const effort = getCompatRequestEffort('requesty', body.model, ctx.effortValue)
  if (effort) body.reasoning_effort = effort
  else delete body.reasoning_effort
}
