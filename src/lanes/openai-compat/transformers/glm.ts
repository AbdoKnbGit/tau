/**
 * GLM / BigModel transformer.
 *
 * BigModel's `/api/paas/v4` endpoint speaks OpenAI Chat Completions,
 * with GLM thinking controlled by `thinking.type`. The visible model-picker
 * toggle owns that setting for GLM thinking-capable models.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import {
  getGlmThinking,
  isGlmThinkingModel,
} from '../../../utils/model/glmThinking.js'

const GLM_MODELS = [
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    contextWindow: 200_000,
    supportsToolCalling: true,
    tags: ['recommended', 'reasoning'],
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    contextWindow: 200_000,
    supportsToolCalling: true,
    tags: ['fast', 'reasoning'],
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    contextWindow: 200_000,
    supportsToolCalling: true,
    tags: ['reasoning'],
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    contextWindow: 200_000,
    supportsToolCalling: true,
    tags: ['reasoning'],
  },
] as const

export const glmTransformer: Transformer = {
  id: 'glm',
  displayName: 'GLM',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',

  supportsStrictMode: () => false,

  staticCatalog() {
    return GLM_MODELS.map(model => ({ ...model, tags: [...model.tags] }))
  },

  clampMaxTokens(requested: number): number {
    return requested > 128_000 ? 128_000 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    body.model = normalizeGlmModelId(body.model)
    const thinkingEnabled = isGlmThinkingModel(ctx.model) && getGlmThinking()
    body.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' }
    delete body.stream_options
    return body
  },

  normalizeStreamDelta(): void {
    // BigModel already emits OpenAI-compatible stream deltas.
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'format', 'default'])
  },

  contextExceededMarkers(): string[] {
    return [
      'context length',
      'context_length_exceeded',
      'prompt is too long',
      'token limit',
      'too long',
      'tokens exceed',
      'exceed token',
      '上下文',
      '超过',
    ]
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'glm-5-turbo'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },
}

function normalizeGlmModelId(model: string): string {
  const trimmed = model.trim()
  return /^glm-/i.test(trimmed) ? trimmed.toLowerCase() : model
}
