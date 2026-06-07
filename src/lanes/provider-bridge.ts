/**
 * Lane → Provider Bridge
 *
 * Wraps any registered Lane as a BaseProvider so the existing
 * provider-shim layer in src/services/api/providers/providerShim.ts
 * can swap in a native lane transparently.
 *
 * This is the Phase-1 wire-up: claude.ts owns the turn-orchestration
 * loop, and each turn goes through the lane's streamAsProvider() which
 * makes ONE native API call with:
 *   - The model's native tool schemas (what it was trained on)
 *   - The caller's system prompt forwarded as-is
 *   - The native auth, native cache, native streaming shape
 *   - Native reasoning knobs
 *
 * When we migrate to Phase-2 (each lane owns its full agent loop) the
 * intercept will move higher up (out of provider-shim and into the
 * query dispatcher) but this bridge can stay as the single-turn entry
 * for tools like session-title generation that only need one API call.
 */

import type {
  AnthropicMessage,
  AnthropicStreamEvent,
  AnthropicContentBlock,
  BaseProvider,
  ModelInfo,
  ProviderRequestParams,
  ProviderStreamResult,
} from '../services/api/providers/base_provider.js'
import { buildProviderStreamResult } from '../services/api/providers/base_provider.js'
import type { Lane } from './types.js'
import { getSessionId } from '../bootstrap/state.js'

export class LaneBackedProvider implements BaseProvider {
  readonly name: string

  /**
   * `providerHint` is the original APIProvider name the shim was built
   * for (e.g. "groq", "openrouter"). It flows through to lane.listModels()
   * so shared lanes like openai-compat can filter their catalog by
   * sub-provider instead of returning the union of everything they host.
   */
  constructor(
    private readonly lane: Lane,
    private readonly providerHint?: string,
  ) {
    this.name = lane.name
  }

  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const controller = new AbortController()
    // If the caller never passed a signal, we synthesize one so the
    // ProviderStreamResult's abort() still takes effect.
    const callerSignal = (params as any).signal as AbortSignal | undefined
    if (callerSignal) {
      callerSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const lane = this.lane
    const providerHint = this.providerHint
    const resolvedModel = lane.resolveModel(params.model)
    const explicitSessionId =
      typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? params.sessionId
        : undefined
    const sessionId =
      providerHint === 'copilot'
      || providerHint === 'openrouter'
      || providerHint === 'agentrouter'
      || providerHint === 'opencode'
      || providerHint === 'moonshot'
      || providerHint === 'mistral'
      || providerHint === 'antigravity'
        ? explicitSessionId ?? getSessionId()
        : undefined

    if (typeof lane.streamAsProvider !== 'function') {
      throw new Error(
        `Lane "${lane.name}" does not implement streamAsProvider() yet — `
        + 'native-lane mode is not available for this provider. '
        + 'Unset CLAUDEX_NATIVE_LANES to fall back to the legacy provider.',
      )
    }

    const streamAsProvider = lane.streamAsProvider.bind(lane)

    // Async iterable that calls the lane and forwards events verbatim.
    const events = (async function* (): AsyncIterable<AnthropicStreamEvent> {
      const gen = streamAsProvider({
        model: resolvedModel,
        messages: params.messages,
        system: params.system ?? '',
        tools: params.tools ?? [],
        max_tokens: params.max_tokens,
        temperature: params.temperature,
        stop_sequences: params.stop_sequences,
        thinking: params.thinking,
        signal: controller.signal,
        ...(sessionId ? { sessionId } : {}),
        providerHint: providerHint,
      })
      for await (const ev of gen) {
        yield ev
      }
      // The generator's return value (NormalizedUsage) is not part of the
      // Anthropic IR — it's surfaced through the usage fields on the
      // assembled AnthropicMessage below (via the message_start / delta
      // events the lane already emitted).
    })()

    return buildProviderStreamResult(events, controller)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    // Non-streaming path: drain the stream and build the final message.
    const streamResult = await this.stream({ ...params, stream: false })
    return assembleFinalMessage(streamResult, this.lane.resolveModel(params.model))
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.lane.listModels(this.providerHint)
  }

  resolveModel(model: string): string {
    return this.lane.resolveModel(model)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

async function assembleFinalMessage(
  stream: ProviderStreamResult,
  model: string,
): Promise<AnthropicMessage> {
  const blocks: AnthropicContentBlock[] = []
  let currentBlock: AnthropicContentBlock | null = null
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null = 'end_turn'
  let outputTokens = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let messageId = `msg-${Date.now()}`

  for await (const ev of stream) {
    switch (ev.type) {
      case 'message_start':
        if (ev.message) {
          messageId = ev.message.id
          inputTokens = ev.message.usage?.input_tokens ?? 0
          // Fold cache stats from message_start — this is the only event
          // that carries them in the Anthropic IR. Lanes emit these on
          // the first real chunk (after folding usage from the provider).
          const u = ev.message.usage as {
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          } | undefined
          if (u?.cache_read_input_tokens) cacheReadTokens = u.cache_read_input_tokens
          if (u?.cache_creation_input_tokens) cacheCreationTokens = u.cache_creation_input_tokens
        }
        break
      case 'content_block_start':
        if (ev.content_block) {
          currentBlock = { ...ev.content_block }
          blocks.push(currentBlock)
        }
        break
      case 'content_block_delta':
        if (currentBlock && ev.delta) {
          if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
            currentBlock.text = (currentBlock.text ?? '') + ev.delta.text
          } else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
            currentBlock.thinking = (currentBlock.thinking ?? '') + ev.delta.thinking
          } else if (
            ev.delta.type === 'input_json_delta'
            && typeof ev.delta.partial_json === 'string'
            && currentBlock.type === 'tool_use'
          ) {
            // Accumulate tool_use input JSON across deltas, same as the
            // Anthropic Messages streaming IR. The lanes emit input via
            // this event because that's how claude.ts reads it upstream;
            // this assembler (used for non-streaming `create()` calls)
            // was missing the matching branch, leaving every tool_use
            // block with an empty `input: {}`.
            const prev = typeof (currentBlock as any)._partialJson === 'string'
              ? (currentBlock as any)._partialJson as string
              : ''
            ;(currentBlock as any)._partialJson = prev + ev.delta.partial_json
          }
        }
        break
      case 'content_block_stop':
        // Finalize tool_use input from the accumulated partial_json string.
        if (currentBlock && currentBlock.type === 'tool_use') {
          const raw = (currentBlock as any)._partialJson
          if (typeof raw === 'string' && raw.length > 0) {
            try {
              currentBlock.input = JSON.parse(raw) as Record<string, unknown>
            } catch {
              // Malformed JSON — keep empty input, shared tool will report.
            }
          }
          delete (currentBlock as any)._partialJson
        }
        currentBlock = null
        break
      case 'message_delta':
        if (ev.delta?.stop_reason === 'tool_use') stopReason = 'tool_use'
        else if (ev.delta?.stop_reason === 'max_tokens') stopReason = 'max_tokens'
        else if (ev.delta?.stop_reason === 'end_turn') stopReason = 'end_turn'
        if (typeof ev.usage?.output_tokens === 'number') {
          outputTokens = ev.usage.output_tokens
        }
        // Fold end-of-stream usage/cache stats. OpenAI Responses and
        // OpenAI Chat only ship usage on the final event (response.completed
        // / final chunk), so message_start carried zeros and the real
        // numbers land here. Without this merge the assembler returns
        // zero cache reads for every Codex / compat turn.
        if (typeof ev.usage?.input_tokens === 'number' && ev.usage.input_tokens > 0) {
          inputTokens = ev.usage.input_tokens
        }
        if (typeof ev.usage?.cache_read_input_tokens === 'number' && ev.usage.cache_read_input_tokens > 0) {
          cacheReadTokens = ev.usage.cache_read_input_tokens
        }
        if (typeof ev.usage?.cache_creation_input_tokens === 'number' && ev.usage.cache_creation_input_tokens > 0) {
          cacheCreationTokens = ev.usage.cache_creation_input_tokens
        }
        break
    }
  }

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content: blocks,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cacheReadTokens > 0 && { cache_read_input_tokens: cacheReadTokens }),
      ...(cacheCreationTokens > 0 && { cache_creation_input_tokens: cacheCreationTokens }),
    },
  }
}
