/**
 * MiniMax AI provider -- OpenAI-compatible chat completions.
 *
 * Primary routing uses the shared openai-compat lane. This legacy shim
 * exists for CLAUDEX_NATIVE_LANES=off and other fallback paths.
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ProviderConfig } from './base_provider.js'

export class MiniMaxProvider extends OpenAIProvider {
  readonly name = 'minimax'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.minimax.io/v1',
      extraHeaders: config.extraHeaders,
    })
  }
}
