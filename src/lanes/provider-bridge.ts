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
import {
  providerUsesStableRequestSession,
  resolveProviderRequestSessionId,
} from '../services/api/cacheAffinity.js'
import type { Lane } from './types.js'
import { getSessionId } from '../bootstrap/state.js'
import { filterProviderToolsForLane } from './tool_filter.js'
import { prefetchMediaText } from './shared/media_extract.js'
import { decideImageSupport } from './shared/vision_capability.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { createRetryableConnectionError } from '../services/api/transport_error.js'
import { isAntigravityModelId } from '../services/api/providers/gemini_code_assist.js'

/**
 * Lanes whose wire format always carries attachments natively. Their
 * screenshots and PDFs must never be replaced by OCR text: looking at the
 * pixels beats reading a transcript of them.
 *
 * Note this is about the LANE's transport, not the model. Within
 * openai-compat the answer is per-model (Kimi and Qwen-VL see, Devstral does
 * not), so that lane asks `modelAcceptsImages` instead of appearing here.
 *
 * Cline and KiloCode used to be listed here and should not have been. They are
 * routers: the transport takes an image_url part, then hands it to whatever
 * upstream model the user selected, which may not read images at all. Treating
 * the lane as sighted meant never resolving OCR or a description for them, so
 * KiloCode returned `404 No endpoints found that support image input` and Cline
 * dropped the image silently and let the model invent what it showed. Both now
 * decide per-model, exactly like openai-compat.
 */
const LANES_WITH_NATIVE_MEDIA = new Set(['gemini', 'codex'])
import type { APIProvider } from '../utils/model/providers.js'
import type { QuerySource } from '../constants/querySource.js'

const DEFAULT_NATIVE_FIRST_EVENT_TIMEOUT_MS = 300_000
const ITERATOR_CLEANUP_TIMEOUT_MS = 1_000

async function closeIteratorBestEffort(
  iterator: AsyncIterator<AnthropicStreamEvent>,
): Promise<void> {
  const close = iterator.return?.()
  if (!close) return

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve(close).then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, ITERATOR_CLEANUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function nativeFirstEventTimeoutMs(providerHint: string | undefined): number | null {
  const isAgentRouter = providerHint === 'agentrouter'
  const disabled =
    isEnvTruthy(process.env.CLAUDE_DISABLE_STREAM_WATCHDOG) ||
    (isAgentRouter &&
      isEnvTruthy(process.env.AGENTROUTER_DISABLE_STREAM_WATCHDOG))
  if (disabled && !isEnvTruthy(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG)) {
    return null
  }

  const configured = Number.parseInt(
    (isAgentRouter
      ? process.env.AGENTROUTER_STREAM_IDLE_TIMEOUT_MS
      : undefined) ||
      process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS ||
      '',
    10,
  )
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_NATIVE_FIRST_EVENT_TIMEOUT_MS
}

async function primeFirstProviderEvent(
  iterator: AsyncIterator<AnthropicStreamEvent>,
  controller: AbortController,
  providerHint: string | undefined,
  callerSignal?: AbortSignal,
): Promise<IteratorResult<AnthropicStreamEvent>> {
  const timeoutMs = nativeFirstEventTimeoutMs(providerHint)
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const callerAbort = new Promise<never>((_, reject) => {
    if (!callerSignal) return
    abortListener = () => reject(new DOMException('Aborted', 'AbortError'))
    if (callerSignal.aborted) {
      abortListener()
    } else {
      callerSignal.addEventListener('abort', abortListener, { once: true })
    }
  })
  const firstEvent = iterator.next()
  const watchdog = new Promise<never>((_, reject) => {
    if (timeoutMs === null) return
    timeout = setTimeout(() => {
      const timeoutError = new Error(
        `Stream idle timeout - no chunks received for ${timeoutMs}ms`,
      )
      reject(
        createRetryableConnectionError(
          'Native provider stream setup timed out',
          timeoutError,
        ),
      )
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([firstEvent, callerAbort, watchdog])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (callerSignal && abortListener) {
      callerSignal.removeEventListener('abort', abortListener)
    }
  }
}

/**
 * Should this request pull one provider event before `stream()` resolves?
 *
 * Native lanes fetch lazily, so without priming a pre-response failure is
 * raised while the caller iterates — after the shared retry controller has
 * already treated setup as successful. Antigravity is the lane where that
 * matters today: its 429 became report text instead of being retried
 * (tau#29/#30). Every other lane keeps the original lazy path, so this fix
 * cannot change the behavior of a provider that works.
 *
 * Matches `GeminiLane.streamAsProvider`'s own definition of an Antigravity
 * request, so a request routed to Antigravity by model id (rather than by an
 * explicitly selected provider row) is primed too. Resolved from the request
 * at call time — no machine, account, or install-specific state.
 */
export function laneRequestNeedsSetupPriming(
  providerHint: string | undefined,
  resolvedModel: string,
): boolean {
  return providerHint === 'antigravity' || isAntigravityModelId(resolvedModel)
}

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

  /** True when `stream()` will prime a first event for this model. */
  needsSetupPriming(model: string): boolean {
    return laneRequestNeedsSetupPriming(this.providerHint, this.lane.resolveModel(model))
  }

  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const lane = this.lane
    const providerHint = this.providerHint
    if (typeof lane.streamAsProvider !== 'function') {
      throw new Error(
        `Lane "${lane.name}" does not implement streamAsProvider() yet — `
        + 'native-lane mode is not available for this provider. '
        + 'Unset CLAUDEX_NATIVE_LANES to fall back to the legacy provider.',
      )
    }

    const resolvedModel = lane.resolveModel(params.model)
    const explicitSessionId =
      typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? params.sessionId
        : undefined
    const sessionId = resolveBridgeSessionId(
      providerHint,
      explicitSessionId,
      params.querySource,
    )

    const primeSetup = laneRequestNeedsSetupPriming(providerHint, resolvedModel)

    const controller = new AbortController()
    let closePrimedIterator: (() => void) | undefined
    // If the caller never passed a signal, we synthesize one so the
    // ProviderStreamResult's abort() still takes effect. Non-primed lanes
    // are never handed one by the shim, so this stays inert for them.
    const callerSignal = primeSetup ? params.signal : undefined
    const abortFromCaller = (): void => {
      controller.abort(callerSignal?.reason)
      closePrimedIterator?.()
    }
    let callerAbortListenerAttached = false
    if (callerSignal) {
      if (callerSignal.aborted) {
        abortFromCaller()
      } else {
        callerSignal.addEventListener('abort', abortFromCaller, { once: true })
        callerAbortListenerAttached = true
      }
    }
    const detachCallerAbortListener = (): void => {
      if (!callerSignal || !callerAbortListenerAttached) return
      callerSignal.removeEventListener('abort', abortFromCaller)
      callerAbortListenerAttached = false
    }

    const streamAsProvider = lane.streamAsProvider.bind(lane)

    // Async iterable that calls the lane and forwards events verbatim.
    const events = (async function* (): AsyncIterable<AnthropicStreamEvent> {
      const tools = filterProviderToolsForLane(lane.name, params.tools ?? [])

      // Resolve attachment text BEFORE the lane converts history, and only
      // where it is actually needed: lanes with native transport, and compat
      // models the catalog says accept images, keep sending real pixels.
      // Everything else gets OCR'd text so a screenshot or PDF is not lost.
      //
      // Runs once per attachment (memoized by content hash) and never inside
      // the converters: a network call there would slow every turn and make
      // the serialized history non-deterministic, breaking the prompt cache.
      if (!LANES_WITH_NATIVE_MEDIA.has(lane.name)) {
        await prefetchMediaText(params.messages ?? [], {
          // Thunk: consulted (and frozen) only if an unresolved image is
          // actually present, so the same answer the converter uses.
          includeImages: () => decideImageSupport(providerHint, resolvedModel) !== true,
          signal: controller.signal,
        })
      }

      const gen = streamAsProvider({
        model: resolvedModel,
        messages: params.messages,
        system: params.system ?? '',
        tools,
        max_tokens: params.max_tokens,
        temperature: params.temperature,
        stop_sequences: params.stop_sequences,
        thinking: params.thinking,
        signal: controller.signal,
        ...(sessionId ? { sessionId } : {}),
        ...(params.querySource ? { querySource: params.querySource } : {}),
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

    // Every lane except Antigravity keeps the original lazy path: the lane's
    // fetch starts when the caller first iterates, exactly as before.
    if (!primeSetup) return buildProviderStreamResult(events, controller)

    // Antigravity only. Native lanes do their fetch lazily when their async
    // generator is first advanced. Prime exactly one event before returning so
    // a pre-response 429/network/5xx rejection happens while `.withResponse()`
    // is still inside the shared withRetry operation. Once any event exists,
    // replay it unchanged and leave later failures to normal stream handling;
    // retrying after output has started could duplicate text, billing, or
    // tool calls.
    const eventIterator = events[Symbol.asyncIterator]()
    let iteratorCleanupPromise: Promise<void> | undefined
    const cleanupIterator = (): Promise<void> => {
      detachCallerAbortListener()
      iteratorCleanupPromise ??= closeIteratorBestEffort(eventIterator)
      return iteratorCleanupPromise
    }
    closePrimedIterator = () => {
      void cleanupIterator()
    }
    let firstEvent: IteratorResult<AnthropicStreamEvent>
    try {
      firstEvent = await primeFirstProviderEvent(
        eventIterator,
        controller,
        providerHint,
        callerSignal,
      )
    } catch (error) {
      controller.abort()
      const cleanup = cleanupIterator()
      // A non-cooperative provider preflight must not make Escape wait for
      // iterator cleanup. Keep cleanup best-effort in the background; other
      // setup failures still finish it before entering the retry loop.
      if (!callerSignal?.aborted) await cleanup
      throw error
    }

    if (firstEvent.done) {
      detachCallerAbortListener()
    }

    const primedEvents = (async function* (): AsyncIterable<AnthropicStreamEvent> {
      try {
        if (firstEvent.done) return
        yield firstEvent.value

        while (true) {
          const nextEvent = await eventIterator.next()
          if (nextEvent.done) return
          yield nextEvent.value
        }
      } finally {
        await cleanupIterator()
      }
    })()

    const providerStream = buildProviderStreamResult(primedEvents, controller)
    const abortProviderStream = providerStream.abort.bind(providerStream)
    providerStream.abort = (): void => {
      abortProviderStream()
      closePrimedIterator?.()
    }
    return providerStream
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

function resolveBridgeSessionId(
  providerHint: string | undefined,
  explicitSessionId: string | undefined,
  querySource: string | undefined,
): string | undefined {
  if (!providerUsesStableRequestSession(providerHint ?? '')) return undefined
  if (explicitSessionId) return explicitSessionId
  if (providerHint && querySource) {
    return resolveProviderRequestSessionId({
      provider: providerHint as APIProvider,
      rootSessionId: getSessionId(),
      querySource: querySource as QuerySource,
    })
  }
  return getSessionId()
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
          ;(currentBlock as any)._finalized = true
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

  // A tool_use block that never got its content_block_stop was dropped by the
  // lane mid-flight — the output cap cut the model off while it was still
  // writing the arguments (see lanes/shared/truncation.ts). claude.ts turns a
  // block into a message at content_block_stop and nowhere else, so this
  // assembler has to apply the same rule or the non-streaming create() path
  // would hand back a tool call the streaming path deliberately discarded.
  const finalized = blocks.filter(
    b => b.type !== 'tool_use' || (b as any)._finalized === true,
  )
  for (const b of finalized) delete (b as any)._finalized

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content: finalized,
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
