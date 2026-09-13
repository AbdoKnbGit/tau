/**
 * GLM provider for BigModel's OpenAI-compatible API.
 */

import { listDirectProviderModels } from '../../../utils/model/directProviderCatalog.js'
import { DirectChatProvider } from './direct_chat_provider.js'
import type { ModelInfo, ProviderConfig } from './base_provider.js'

export class GlmProvider extends DirectChatProvider {
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
    return listDirectProviderModels('glm', this.baseUrl, this._headers())
  }

  resolveModel(claudeModel: string): string {
    return normalizeGlmModelId(super.resolveModel(claudeModel))
  }
}

function normalizeGlmModelId(model: string): string {
  const trimmed = model.trim()
  return /^glm-/i.test(trimmed) ? trimmed.toLowerCase() : model
}
