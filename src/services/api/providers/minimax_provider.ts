/**
 * MiniMax AI provider -- OpenAI-compatible chat completions.
 *
 * Primary routing uses the shared openai-compat lane. This legacy shim
 * exists for CLAUDEX_NATIVE_LANES=off and other fallback paths.
 */

import { listDirectProviderModels } from '../../../utils/model/directProviderCatalog.js'
import { DirectChatProvider } from './direct_chat_provider.js'
import type { ModelInfo, ProviderConfig } from './base_provider.js'

export class MiniMaxProvider extends DirectChatProvider {
  readonly name = 'minimax'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.minimax.io/v1',
      extraHeaders: config.extraHeaders,
    })
    this.optimizePayload = false
  }

  async listModels(): Promise<ModelInfo[]> {
    return listDirectProviderModels('minimax', this.baseUrl, this._headers())
  }
}
