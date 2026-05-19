/**
 * LM Studio transformer.
 *
 * LM Studio exposes a local OpenAI-compatible API, usually at
 * http://localhost:1234/v1. Authentication is optional for local use.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

export const lmStudioTransformer: Transformer = {
  id: 'lmstudio',
  displayName: 'LM Studio (local)',
  defaultBaseUrl: 'http://localhost:1234/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    delete body.stream_options
    if (!ctx.isReasoning) {
      body.thinking = { type: 'disabled' }
    }
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context window', 'prompt is too long', 'too long']
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return null
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },
}
