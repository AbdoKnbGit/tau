/**
 * LXD API provider -- OpenAI-compatible chat completions (api.lxds.org).
 *
 * Primary routing uses the shared openai-compat lane. This legacy shim
 * exists for CLAUDEX_NATIVE_LANES=off and other fallback paths.
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ModelInfo, ProviderConfig, ProviderRequestParams } from './base_provider.js'
import { resolveLxdRequestEffort, supportsLxdEffortSelection } from '../../../utils/model/lxdThinking.js'
import type { OpenAIMessage } from '../adapters/anthropic_to_openai.js'
import { preserveToolCallReasoning } from './reasoning_history.js'
import {
  filterLxdModelCatalog,
  lxdStaticCatalog,
  recordLxdCatalog,
  type LxdCatalogRow,
} from '../../../utils/model/lxdCatalog.js'

export class LxdProvider extends OpenAIProvider {
  readonly name = 'lxd'

  protected override finalizeChatCompletionsBody(
    body: Record<string, unknown>, model: string, params: ProviderRequestParams,
  ): void {
    const effort = resolveLxdRequestEffort(model, params.effortValue)
    if (effort) body.reasoning_effort = effort
    else delete body.reasoning_effort
    if (supportsLxdEffortSelection(model)) {
      body.messages = preserveToolCallReasoning(body.messages as OpenAIMessage[], params.messages)
    }
  }

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.lxds.org/v1',
      extraHeaders: config.extraHeaders,
    })
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      // /v1/models is public on LXD, but send auth anyway so a key-scoped
      // catalog (model allowlists are a per-key setting) is honored.
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const data = (await response.json()) as { data?: LxdCatalogRow[] }
      const rows = data.data ?? []
      recordLxdCatalog(rows)
      const chatRows = filterLxdModelCatalog(rows)
      if (chatRows.length === 0) throw new Error('no chat models returned')

      return chatRows.map(row => ({
        id: row.id!,
        name: row.name ?? row.id!,
        contextWindow: row.context_length,
        supportsToolCalling: row.capabilities?.tools ?? true,
        tags: row.capabilities?.reasoning ? ['reasoning'] : undefined,
      }))
    } catch {
      // Curated fallback so /models still works offline or when the relay
      // is having a moment.
      return lxdStaticCatalog()
    }
  }
}
