/**
 * DeepSeek provider — extends OpenAIProvider.
 *
 * DeepSeek uses an OpenAI-compatible API with some extensions
 * for reasoning models (R1 series).
 *
 * Base URL: https://api.deepseek.com/v1
 * Auth: Bearer token (sk-...)
 * API: OpenAI-compatible
 *
 * Available models (September 2026):
 *   - deepseek-flash                — DeepSeek V4.1 Flash
 *   - deepseek-v4-pro               — 1.6T MoE flagship (thinking by default)
 *   - deepseek-v4-flash             — 284B MoE cheap/fast row
 *   - deepseek-v4-flash-vision-exp  — experimental, accepts image input
 *
 * deepseek-chat / deepseek-reasoner / deepseek-coder were retired on
 * 2026-07-24 and now error. Send the bare alias, never a dated checkpoint.
 *
 * DeepSeek R1 reasoning:
 *   - Returns reasoning_content in the response
 *   - We strip this during normalization (Anthropic has no equivalent)
 *   - The final answer is in the regular content field
 *
 * Auth: API key only (no OAuth). Get key at https://platform.deepseek.com
 */

import { listDirectProviderModels } from '../../../utils/model/directProviderCatalog.js'
import { OpenAIProvider } from './openai_provider.js'
import { isDeepSeekV4ThinkingModel, resolveDeepSeekRequestEffort } from '../../../utils/model/deepseekThinking.js'
import type { OpenAIMessage } from '../adapters/anthropic_to_openai.js'
import { preserveToolCallReasoning } from './reasoning_history.js'
import type {
  ModelInfo,
  ProviderConfig,
  ProviderRequestParams,
  ProviderStreamResult,
  AnthropicMessage,
} from './base_provider.js'

export class DeepSeekProvider extends OpenAIProvider {
  readonly name = 'deepseek'

  protected override finalizeChatCompletionsBody(
    body: Record<string, unknown>, model: string, params: ProviderRequestParams,
  ): void {
    if (!isDeepSeekV4ThinkingModel(model)) return
    const effort = resolveDeepSeekRequestEffort(model, params.effortValue)
    body.thinking = { type: effort ? 'enabled' : 'disabled' }
    if (effort) {
      body.reasoning_effort = effort
      // Preserve the base message order and content across effort changes;
      // only attach the reasoning field required while thinking is enabled.
      body.messages = preserveToolCallReasoning(body.messages as OpenAIMessage[], params.messages)
    } else delete body.reasoning_effort
  }

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.deepseek.com/v1',
      extraHeaders: config.extraHeaders,
    })
  }

  async listModels(): Promise<ModelInfo[]> {
    return listDirectProviderModels('deepseek', this.baseUrl, this._headers())
  }

  /**
   * Override stream to handle DeepSeek-specific features:
   * - R1 reasoning models may return reasoning_content alongside content
   * - Some older endpoints use /chat/completions directly
   */
  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    return super.stream(params)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    return super.create(params)
  }
}
