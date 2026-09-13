/** Legacy shim shares the native provider's thinking and history contracts. */
import { OpenAIProvider } from './openai_provider.js'
import type { ProviderRequestParams } from './base_provider.js'
import { anthropicMessagesToOpenAI } from '../adapters/anthropic_to_openai.js'
import { buildDirectHistory } from '../../../lanes/openai-compat/direct_history.js'
import { getTransformer } from '../../../lanes/openai-compat/transformers/index.js'
import type { OpenAIChatRequest } from '../../../lanes/openai-compat/transformers/shared_types.js'
import { isDirectThinkingProvider } from '../../../utils/model/directProviderCatalog.js'

export class DirectChatProvider extends OpenAIProvider {
  protected finalizeChatCompletionsBody(body: Record<string, unknown>, model: string, params: ProviderRequestParams): void {
    if (!isDirectThinkingProvider(this.name)) return
    const system = typeof params.system === 'string' ? params.system : (params.system ?? []).map(b => b.text).join('\n\n')
    body.messages = buildDirectHistory(params.messages, system, this.name, model, params.sessionId,
      turns => anthropicMessagesToOpenAI(turns))
    getTransformer(this.name).transformRequest(body as unknown as OpenAIChatRequest, {
      model, isReasoning: !!params.thinking && params.thinking.type !== 'disabled',
      reasoningEffort: null, sessionId: params.sessionId,
    })
  }
}
