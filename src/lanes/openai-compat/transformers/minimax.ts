/**
 * MiniMax AI OpenAI-compatible transformer.
 *
 * MiniMax's current OpenAI-compatible text endpoint is
 * https://api.minimax.io/v1/chat/completions. The public docs advertise
 * max_completion_tokens instead of max_tokens and a 2048 output cap, so
 * this transformer keeps requests conservative.
 */

import type { ModelInfo } from '../../../services/api/providers/base_provider.js'
import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

const MINIMAX_STATIC_MODELS: ModelInfo[] = [
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax-M2.7',
    contextWindow: 204_800,
    supportsToolCalling: true,
    tags: ['recommended', 'reasoning'],
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'MiniMax-M2.7 High Speed',
    contextWindow: 204_800,
    supportsToolCalling: true,
    tags: ['fast', 'reasoning'],
  },
  {
    id: 'MiniMax-M2.5',
    name: 'MiniMax-M2.5',
    contextWindow: 204_800,
    supportsToolCalling: true,
    tags: ['reasoning'],
  },
  {
    id: 'MiniMax-M2.5-highspeed',
    name: 'MiniMax-M2.5 High Speed',
    contextWindow: 204_800,
    supportsToolCalling: true,
    tags: ['fast', 'reasoning'],
  },
  {
    id: 'MiniMax-M2.1',
    name: 'MiniMax-M2.1',
    contextWindow: 204_800,
    supportsToolCalling: true,
    tags: ['reasoning'],
  },
  {
    id: 'MiniMax-M2.1-highspeed',
    name: 'MiniMax-M2.1 High Speed',
    contextWindow: 204_800,
    supportsToolCalling: true,
    tags: ['fast', 'reasoning'],
  },
  {
    id: 'MiniMax-M2',
    name: 'MiniMax-M2',
    contextWindow: 204_800,
    supportsToolCalling: true,
    tags: ['reasoning'],
  },
]

export const minimaxTransformer: Transformer = {
  id: 'minimax',
  displayName: 'MiniMax AI',
  defaultBaseUrl: 'https://api.minimax.io/v1',

  supportsStrictMode: () => false,

  staticCatalog() {
    return MINIMAX_STATIC_MODELS.map(model => ({ ...model }))
  },

  preferLiveModelCatalog() {
    return true
  },

  filterModelCatalog(models) {
    const seen = new Set<string>()
    const filtered = models.flatMap((model) => {
      const id = model.id.trim()
      if (!isMiniMaxTextModel(id) || seen.has(id)) return []
      seen.add(id)
      return [{
        id,
        name: model.name ?? labelMiniMaxModel(id),
        contextWindow: 204_800,
        supportsToolCalling: true,
        tags: tagsForMiniMaxModel(id),
      } satisfies ModelInfo]
    })
    return filtered.length > 0 ? filtered : MINIMAX_STATIC_MODELS.map(model => ({ ...model }))
  },

  clampMaxTokens(requested: number): number {
    return Math.min(Math.max(1, requested), 2048)
  },

  transformRequest(body: OpenAIChatRequest, _ctx: TransformContext): OpenAIChatRequest {
    const bag = body as unknown as Record<string, unknown>
    const maxTokens = body.max_tokens
    if (typeof maxTokens === 'number') {
      bag.max_completion_tokens = Math.min(Math.max(1, maxTokens), 2048)
      delete bag.max_tokens
    }

    delete bag.reasoning_effort
    delete bag.reasoning
    delete bag.thinking
    delete bag.stream_options
    delete bag.store
    delete bag.prompt_cache_key
    delete bag.prompt_cache_retention

    if (typeof body.temperature === 'number') {
      if (body.temperature <= 0) delete bag.temperature
      else if (body.temperature > 1) body.temperature = 1
    }
    if (typeof body.top_p === 'number') {
      if (body.top_p <= 0) delete bag.top_p
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
}

function isMiniMaxTextModel(id: string): boolean {
  const lower = id.toLowerCase()
  return (
    lower.startsWith('minimax-m') &&
    !lower.includes('speech') &&
    !lower.includes('audio') &&
    !lower.includes('tts') &&
    !lower.includes('voice') &&
    !lower.includes('image') &&
    !lower.includes('video') &&
    !lower.includes('music') &&
    !lower.includes('embedding')
  )
}

function labelMiniMaxModel(id: string): string {
  return id.replace(/-highspeed$/i, ' High Speed')
}

function tagsForMiniMaxModel(id: string): readonly string[] {
  const tags = ['reasoning']
  if (id.toLowerCase().includes('highspeed')) tags.push('fast')
  if (id === 'MiniMax-M2.7') tags.push('recommended')
  return tags
}
