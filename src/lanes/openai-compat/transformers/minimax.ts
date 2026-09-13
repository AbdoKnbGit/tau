/**
 * MiniMax AI OpenAI-compatible transformer.
 *
 * MiniMax's current OpenAI-compatible text endpoint is
 * https://api.minimax.io/v1/chat/completions. The public docs advertise
 * max_completion_tokens. Limits and thinking controls are model-specific.
 */

import { getDirectModelMeta } from '../../../utils/model/directProviderCatalog.js'
import { directThinkingFields } from '../../../utils/model/directProviderThinking.js'
import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import { filterMiniMaxModelCatalog } from '../../../utils/model/minimaxCatalog.js'

export const minimaxTransformer: Transformer = {
  id: 'minimax',
  displayName: 'MiniMax AI',
  defaultBaseUrl: 'https://api.minimax.io/v1',

  supportsStrictMode: () => false,

  preferLiveModelCatalog() {
    return true
  },

  filterModelCatalog(models) {
    return filterMiniMaxModelCatalog(models)
  },

  clampMaxTokens(requested: number): number {
    return Math.max(1, requested)
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    const bag = body as unknown as Record<string, unknown>
    const maxTokens = body.max_tokens
    if (typeof maxTokens === 'number') {
      bag.max_completion_tokens = Math.min(Math.max(1, maxTokens), getDirectModelMeta('minimax', ctx.model)?.maxOutputTokens ?? 32_768)
      delete bag.max_tokens
    }

    delete bag.reasoning_effort
    delete bag.reasoning
    delete bag.thinking
    Object.assign(body, directThinkingFields('minimax', ctx.model))
    // Keep MiniMax's native <think> content intact on every replay. Explicit
    // split output would require retaining its full reasoning_details objects.
    body.messages = body.messages.map(message => {
      if (message.reasoning_content === undefined) return message
      const { reasoning_content, ...rest } = message
      return { ...rest, content: `<think>${reasoning_content}</think>${typeof rest.content === 'string' ? rest.content : ''}` }
    })
    if (body.stream) body.stream_options = { include_usage: true }
    delete bag.store
    delete bag.prompt_cache_key
    delete bag.prompt_cache_retention

    if (typeof body.temperature === 'number') {
      if (body.temperature < 0) delete bag.temperature
      else if (body.temperature > 2) body.temperature = 2
    }
    if (typeof body.top_p === 'number') {
      if (body.top_p < 0) delete bag.top_p
      else if (body.top_p > 1) body.top_p = 1
    }

    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'pattern', 'format', 'default'])
  },

  contextExceededMarkers(): string[] {
    return [
      'context length',
      'context_length_exceeded',
      'prompt is too long',
      'token limit',
      'too long',
      'tokens exceed',
      'exceeded model token limit',
    ]
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'MiniMax-M2.7-highspeed'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },

  // MiniMax docs: temperature 1.0, top_p 0.95 are the recommended
  // sampling settings; top_k 20 for M2 and 40 for M2.1+ (per opencode's
  // matrix in provider/transform.ts:508). Only applied when caller
  // didn't pass an explicit value.
  defaultGenerationParams(model: string) {
    const id = model.toLowerCase()
    if (!id.startsWith('minimax-')) return undefined
    const k = ['m2.', 'm25', 'm21'].some(s => id.includes(s)) ? 40 : 20
    return { temperature: 1.0, top_p: 0.95, top_k: k }
  },
}
