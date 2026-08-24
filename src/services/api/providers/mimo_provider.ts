/**
 * Xiaomi MiMo provider -- OpenAI-compatible chat completions.
 *
 * Primary routing uses the shared openai-compat lane. This legacy shim
 * exists for CLAUDEX_NATIVE_LANES=off and other fallback paths, and mirrors
 * the lane transformer's three MiMo-specific quirks: the `api-key` auth
 * header, the `max_completion_tokens` output field, and the low/medium/high
 * `reasoning_effort` ladder.
 */

import { OpenAIProvider } from './openai_provider.js'
import type {
  ModelInfo,
  ProviderConfig,
  ProviderRequestParams,
} from './base_provider.js'
import type {
  OpenAIMessage,
  OpenAITool,
} from '../adapters/anthropic_to_openai.js'
import {
  mimoMaxOutputTokens,
  mimoModelCatalog,
  mimoStaticCatalog,
  recordMimoCatalog,
  type MimoCatalogRow,
} from '../../../utils/model/mimoCatalog.js'
import {
  resolveMimoRequestEffort,
  supportsMimoEffortSelection,
} from '../../../utils/model/mimoThinking.js'

export class MimoProvider extends OpenAIProvider {
  readonly name = 'mimo'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.xiaomimimo.com/v1',
      extraHeaders: config.extraHeaders,
    })
  }

  /** MiMo reads a bare `api-key` header, not `Authorization: Bearer`. */
  protected override _headers(_model?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
      ...this.extraHeaders,
    }
  }

  protected override finalizeChatCompletionsBody(
    body: Record<string, unknown>,
    model: string,
    _params: ProviderRequestParams,
    _messages: OpenAIMessage[],
    _tools: OpenAITool[] | undefined,
  ): void {
    if (typeof body.max_tokens === 'number') {
      body.max_completion_tokens = Math.min(
        Math.max(1, body.max_tokens),
        mimoMaxOutputTokens(model),
      )
      delete body.max_tokens
    }
    if (supportsMimoEffortSelection(model)) {
      body.reasoning_effort = resolveMimoRequestEffort(model)
    }
    delete body.store
    delete body.stream_options
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const data = (await response.json()) as { data?: MimoCatalogRow[] }
      const rows = data.data ?? []
      if (rows.length === 0) throw new Error('empty catalog')
      recordMimoCatalog(rows)
      return mimoModelCatalog()
    } catch {
      // `/v1/models` is auth-gated and the curated list is the documented
      // surface anyway, so falling back keeps /models useful either way.
      return mimoStaticCatalog()
    }
  }
}
