/**
 * GLM provider for BigModel's OpenAI-compatible API.
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ModelInfo, ProviderConfig } from './base_provider.js'

const GLM_MODELS: ModelInfo[] = [
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
]

export class GlmProvider extends OpenAIProvider {
  readonly name = 'glm'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
      extraHeaders: config.extraHeaders,
    })
    this.optimizePayload = false
  }

  async listModels(): Promise<ModelInfo[]> {
    return GLM_MODELS.map(model => ({ ...model, tags: model.tags ? [...model.tags] : undefined }))
  }

  resolveModel(claudeModel: string): string {
    return normalizeGlmModelId(super.resolveModel(claudeModel))
  }
}

function normalizeGlmModelId(model: string): string {
  const trimmed = model.trim()
  return /^glm-/i.test(trimmed) ? trimmed.toLowerCase() : model
}
