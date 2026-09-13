/**
 * Moonshot AI / Kimi provider.
 *
 * Moonshot's public API speaks the OpenAI Chat Completions shape at
 * https://api.moonshot.ai/v1 with bearer-token authentication.
 */

import { listDirectProviderModels } from '../../../utils/model/directProviderCatalog.js'
import { DirectChatProvider } from './direct_chat_provider.js'
import type { ModelInfo, ProviderConfig } from './base_provider.js'
import {
  normalizeMoonshotModelId,
} from '../../../utils/model/moonshotCatalog.js'

export class MoonshotProvider extends DirectChatProvider {
  readonly name = 'moonshot'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.moonshot.ai/v1',
      extraHeaders: config.extraHeaders,
    })
    this.optimizePayload = false
  }

  async listModels(): Promise<ModelInfo[]> {
    return listDirectProviderModels('moonshot', this.baseUrl, this._headers())
  }

  resolveModel(claudeModel: string): string {
    return normalizeMoonshotModelId(super.resolveModel(claudeModel))
  }
}
