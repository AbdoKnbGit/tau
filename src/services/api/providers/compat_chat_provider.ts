/** Legacy chat fallback keeps the selected provider's reasoning contract. */
import { OpenAIProvider } from './openai_provider.js'
import type { ProviderConfig, ProviderRequestParams } from './base_provider.js'
import { getTransformer } from '../../../lanes/openai-compat/transformers/index.js'
import type { OpenAIChatRequest } from '../../../lanes/openai-compat/transformers/shared_types.js'
import type { OpenAIMessage } from '../adapters/anthropic_to_openai.js'
import { opencodeReplaysReasoningContent } from '../../../utils/model/opencodeThinking.js'
import { cloudflareReasoningContentReplayRequired } from '../../../utils/model/cloudflareThinking.js'
import { preserveToolCallReasoning } from './reasoning_history.js'

type CompatChatProviderName = 'modelrouter' | 'vercel' | 'requesty' | 'opencode'
  | 'opencodego' | 'fireworks' | 'cloudflare' | 'lmstudio'

const REASONING_FIELDS = [
  'reasoning_effort', 'reasoning', 'thinking', 'enable_thinking',
  'chat_template_args', 'thinking_config', 'reasoning_summary',
] as const

export class CompatChatProvider extends OpenAIProvider {
  readonly name: CompatChatProviderName
  private requestCacheSessionId: string | undefined

  constructor(provider: CompatChatProviderName, config: ProviderConfig) {
    super(config)
    this.name = provider
  }

  override clearCacheSession(): void {
    this.requestCacheSessionId = undefined
    super.clearCacheSession()
  }

  protected override finalizeChatCompletionsBody(
    body: Record<string, unknown>, model: string, params: ProviderRequestParams,
  ): void {
    // These fallback transports previously used OpenAIProvider directly.
    // Preserve its session-key behavior while keeping provider effort separate.
    const sessionId = params.sessionId?.trim()
    if (sessionId) this.requestCacheSessionId = sessionId
    body.prompt_cache_key = this.requestCacheSessionId ?? this.cacheSessionKey

    // Resolve the same controls as the native lane on a detached body. Only
    // reasoning fields are copied back, preserving the legacy cache prefix,
    // history, tools, and request affinity fields.
    const controls = getTransformer(this.name).transformRequest({
      model, messages: [], max_tokens: body.max_tokens,
    } as OpenAIChatRequest, {
      provider: this.name, model,
      isReasoning: !!params.thinking && params.thinking.type !== 'disabled',
      reasoningEffort: null, effortValue: params.effortValue,
    }) as unknown as Record<string, unknown>
    for (const field of REASONING_FIELDS) {
      if (controls[field] === undefined) delete body[field]
      else body[field] = controls[field]
    }
    const replay = this.name === 'opencode' || this.name === 'opencodego'
      ? opencodeReplaysReasoningContent(this.name, model)
      : this.name === 'cloudflare' && cloudflareReasoningContentReplayRequired(model)
    if (replay) {
      body.messages = preserveToolCallReasoning(body.messages as OpenAIMessage[], params.messages)
    }
  }
}
