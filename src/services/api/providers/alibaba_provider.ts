/**
 * Alibaba Cloud Model Studio provider — OpenAI-compatible chat completions.
 *
 * Primary routing uses the shared openai-compat lane. This legacy shim exists
 * for CLAUDEX_NATIVE_LANES=off and other fallback paths, and mirrors the lane
 * transformer's two Model-Studio-specific quirks: the per-model output cap and
 * the per-model thinking fields (`enable_thinking` / `reasoning_effort`), both
 * read from the catalogue rather than assumed.
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
  ALIBABA_DEFAULT_BASE_URL,
  alibabaMaxOutputTokens,
  alibabaModelCatalog,
  recordAlibabaLiveModels,
} from '../../../utils/model/alibabaCatalog.js'
import { resolveAlibabaThinkingFields } from '../../../utils/model/alibabaThinking.js'

export class AlibabaProvider extends OpenAIProvider {
  readonly name = 'alibaba'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? ALIBABA_DEFAULT_BASE_URL,
      extraHeaders: config.extraHeaders,
    })
  }

  protected override finalizeChatCompletionsBody(
    body: Record<string, unknown>,
    model: string,
    _params: ProviderRequestParams,
    _messages: OpenAIMessage[],
    _tools: OpenAITool[] | undefined,
  ): void {
    if (typeof body.max_tokens === 'number') {
      body.max_tokens = Math.min(
        Math.max(1, body.max_tokens),
        alibabaMaxOutputTokens(model),
      )
    }

    // Only fields the row published — an `enable_thinking` on a model that
    // does not take one is a 400.
    const thinking = resolveAlibabaThinkingFields(model)
    delete body.enable_thinking
    delete body.reasoning_effort
    delete body.thinking_budget
    if (thinking.enable_thinking !== undefined) {
      body.enable_thinking = thinking.enable_thinking
    }
    if (thinking.reasoning_effort !== undefined) {
      body.reasoning_effort = thinking.reasoning_effort
    }

    delete body.store
    delete body.thinking
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const data = (await response.json()) as { data?: Array<{ id?: string }> }
      const ids = (data.data ?? [])
        .map(row => row.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      if (ids.length === 0) throw new Error('empty catalog')
      recordAlibabaLiveModels(ids)
      return alibabaModelCatalog()
    } catch {
      // `/models` is auth-gated and carries ids only; the catalogue is what
      // describes them either way, so falling back keeps /models useful.
      return alibabaModelCatalog()
    }
  }
}
