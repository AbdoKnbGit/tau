/**
 * LXD API provider -- OpenAI-compatible chat completions (api.lxds.org).
 *
 * Primary routing uses the shared openai-compat lane. This legacy shim
 * exists for CLAUDEX_NATIVE_LANES=off and other fallback paths.
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ModelInfo, ProviderConfig } from './base_provider.js'
import {
  filterLxdModelCatalog,
  lxdStaticCatalog,
  recordLxdCatalog,
  type LxdCatalogRow,
} from '../../../utils/model/lxdCatalog.js'

export class LxdProvider extends OpenAIProvider {
  readonly name = 'lxd'

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
