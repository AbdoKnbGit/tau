/**
 * Gemini Lane — Native Agent Loop + Provider-Shim Entry
 *
 * Two entry points:
 *
 *   1. streamAsProvider(params) — single-turn, provider-shim-compatible.
 *      Used by src/lanes/provider-bridge.ts. claude.ts owns the outer
 *      turn-orchestration loop; the lane handles one native API call
 *      per invocation.
 *
 *   2. run(context) — future lane-owns-loop mode. Not currently wired;
 *      scaffold preserved for the Phase-2 migration where each lane owns
 *      its full agent loop (per the architecture plan).
 *
 * Both paths speak Gemini's native REST API directly:
 *   - POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *   - Native functionDeclarations, not Anthropic tools schema
 *   - Native thinkingConfig with thinkingBudget: -1 (dynamic)
 *   - Native safetySettings (all OFF)
 *   - Native cache (cachedContent field when available)
 *
 * References:
 *   - google-gemini/gemini-cli packages/core/src/core/geminiChat.ts
 *   - google-gemini/gemini-cli packages/core/src/agent/event-translator.ts
 */

import { randomUUID } from 'crypto'
import type {
  AnthropicStreamEvent,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  LaneProviderCallParams,
  NormalizedUsage,
} from '../types.js'
import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import {
  getRegistrationByNativeName,
  buildGeminiFunctionDeclarations,
  GEMINI_TOOL_REGISTRY,
} from './tools.js'
import {
  applyAntigravityPrefixPad,
  paceAntigravityAgentRequest,
  recordAntigravityCacheRead,
  writeAntigravityCacheDebugEntry,
} from './antigravity_cache.js'
import { geminiApi, TAU_STABLE_SESSION_ID_FIELD } from './api.js'
import { getOrCreateCacheWithUsage, invalidateCache } from '../../services/api/providers/gemini_cache.js'
import {
  ANTIGRAVITY_MODEL_IDS,
  resolveAntigravityWireModel,
} from '../../services/api/providers/gemini_code_assist.js'
import {
  sanitizeSchemaForLane,
  appendStrictParamsHint,
  GEMINI_TOOL_USAGE_RULES,
} from '../shared/mcp_bridge.js'

// ─── Constants ───────────────────────────────────────────────────

const MAX_TURNS = 100

function uncachedInputTokens(promptTokens: number, cacheReadTokens: number): number {
  return Math.max(0, promptTokens - cacheReadTokens)
}

// ─── Gemini Native Message Types ─────────────────────────────────

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiPart =
  | { text: string }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { id?: string; name: string; response: { content: string } } }
  | { thought: boolean; text: string }
  | { inlineData: { mimeType: string; data: string } }

// ─── The Lane Implementation ─────────────────────────────────────

export class GeminiLane implements Lane {
  readonly name = 'gemini'
  readonly displayName = 'Google Gemini (Native)'

  private _healthy = true

  supportsModel(model: string): boolean {
    const m = model.toLowerCase()
    return m.startsWith('gemini-') || m.startsWith('gemma-')
  }

  // ── Provider-shim-compatible single-turn entry ──────────────────

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, max_tokens, thinking, signal, sessionId } = params

    // Normalize system → plain string.
    const systemText =
      typeof system === 'string'
        ? system
        : (system ?? []).map(b => b.text).join('\n\n')

    // Cache discipline: split stable (cache-eligible) from volatile
    // (per-turn) sections at the Tau `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`
    // marker. Everything before the marker is stable prefix (tools list,
    // agent persona, instructions); everything after is volatile
    // (git status, env, memory) and must live INSIDE the conversation
    // as a leading user message — not in systemInstruction when we're
    // using cachedContents — so the cache key stays byte-identical
    // across turns. If the caller passed flat text without the marker,
    // we fall back to treating the whole thing as stable (no regression).
    const split = splitSystemAtBoundary(systemText)
    const volatileText = split.volatileText

    // Build id→native-name map across the whole conversation so
    // tool_result blocks can find their original Gemini function name.
    const toolUseIdToNative = buildToolUseIdToNativeMap(messages)

    // Convert Anthropic-format messages → Gemini native contents.
    // If we have volatile content, inject it as a leading user message
    // (this is the correct slot per Google's `cachedContents` design:
    // the cache key hashes only the stable systemInstruction+tools,
    // and volatile bits ride the `contents[]` array which is not
    // cache-keyed).
    const contents = convertHistoryToGemini(messages, toolUseIdToNative)
    if (volatileText) {
      contents.unshift({
        role: 'user',
        parts: [{ text: volatileText }],
      })
    }

    // Build function declarations: prefer the native schema from our
    // registry for tools that match; pass through provider-shaped tools
    // for anything we don't recognize (MCP tools, custom tools).
    const functionDeclarations = buildLaneFunctionDeclarations(tools)

    // Antigravity prompts below the backend's ~16,384-token implicit-cache
    // minimum can never produce a cache entry — pad the stable system slot
    // over it so the second call is a cache hit. Sized from turn-stable
    // inputs (system + tools) so the pad is byte-identical across a
    // conversation's turns.
    //
    // Applies to BOTH Gemini and Claude models on Antigravity: Claude is
    // resold through the same cloudcode-pa Gemini wire protocol and shares
    // the same per-account implicit cache, so it has the identical 16,384
    // chunk minimum + async-commit instability. Google-path Gemini and
    // every other provider are untouched. See antigravity_cache.ts for the
    // measured cache semantics.
    const isAntigravityModel = ANTIGRAVITY_MODEL_IDS.has(model.toLowerCase())
    const stableText = isAntigravityModel
      ? applyAntigravityPrefixPad(
        split.stableText,
        JSON.stringify(functionDeclarations).length,
      )
      : split.stableText

    // Map thinkingBudget from Anthropic-format thinking param.
    const thinkingBudget = resolveThinkingBudget(thinking)

    // Try to place the stable portion of the request (system + tools) into
    // Google's cachedContents API. On a hit, the model sees cache_read
    // input tokens at ~25% of the normal rate — meaningful win when the
    // same system+tools are re-used across turns of a session.
    //
    // Cache is API-key-path only today (OAuth proxy doesn't expose it).
    // Use ONLY the stable slot for the cache body — volatile content
    // rides the leading user message (see contents.unshift above) so the
    // cache-key hash stays identical across turns.
    const cacheSystemInstruction = { parts: [{ text: stableText }] }
    const cacheTools = functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined

    let cacheName: string | null = null
    let cacheWriteTokens = 0
    if (geminiApi.supportsServerCache(model)) {
      const apiKey = geminiApi.getApiKey()
      if (apiKey) {
        try {
          const cache = await getOrCreateCacheWithUsage({
            model,
            baseUrl: geminiApi.cacheBaseUrl,
            apiKey,
            systemInstruction: cacheSystemInstruction,
            tools: cacheTools,
          })
          cacheName = cache?.cacheName ?? null
          cacheWriteTokens = cache?.createdTokens ?? 0
        } catch {
          cacheName = null
          cacheWriteTokens = 0
        }
      }
    }

    // When we ARE using a cache, the systemInstruction is already inside
    // the cache body — don't duplicate it inline. When we're NOT caching,
    // send the stable slot inline as systemInstruction; the volatile
    // slot is already in the leading user message above.
    const request = buildGeminiRequest({
      model,
      contents,
      systemText: stableText,
      functionDeclarations,
      maxOutputTokens: max_tokens,
      thinkingBudget,
      cacheName,
    })
    if (isAntigravityModel) {
      request[TAU_STABLE_SESSION_ID_FIELD] = stableAntigravitySessionId(sessionId, messages)
      if (process.env.TAU_CACHE_DEBUG) {
        writeAntigravityCacheDebugEntry(model, request, sessionId)
      }
      // Hold an agent's second request until its first cache write has had
      // time to commit (~8-22s async) — without this, fast tool loops
      // re-pay the full prompt cold on every turn. Agent sessions only
      // (gated inside by the tau-agent- prefix); the main thread's human
      // cadence already clears the commit window. Both Gemini and Claude
      // on Antigravity hit the same async-commit backend.
      await paceAntigravityAgentRequest(sessionId, signal)
    }

    // Track usage across the stream.
    let promptTokens = 0
    let inputTokens = 0
    let outputTokens = 0
    let thinkingTokens = 0
    let cacheReadTokens = 0

    // Stream state per turn.
    const messageId = `gemini-${Date.now()}`
    let thinkingText = ''
    let responseText = ''
    let blockIndex = 0
    let inBlock: 'thinking' | 'text' | null = null
    let messageStartEmitted = false
    const toolCalls: Array<{
      implId: string
      nativeName: string
      input: Record<string, unknown>
      anthropicToolUseId: string
      nativeArgs: Record<string, unknown>
      thoughtSignature?: string
    }> = []

    // Accumulator for a streaming function call. Gemini splits function
    // calls across SSE chunks: the first chunk carries the name with
    // (often empty) args, and later chunks carry more args with an empty
    // name as continuation deltas. Emitting a tool_use per chunk produces
    // the `{}` → "Received input: {}" tool-integrity bug that bit us when
    // the server decided to split. We accumulate until the call is known
    // complete — when a new named call starts, text/thinking resumes, or
    // the stream ends — then emit one atomic tool_use block.
    //
    // args can come through as either an object (proto-json Struct) or a
    // JSON string (some serialization paths), so we buffer both: object
    // fragments get merged; string fragments get concatenated and parsed
    // at commit time. This mirrors the string/object fork in gemini-cli's
    // parseToolArguments().
    let currentCall: {
      nativeName: string
      args: Record<string, unknown>
      argsString: string
      thoughtSignature?: string
      blockIndex: number
      anthropicToolUseId: string
      anthropicToolUseIdFromServer: boolean
    } | null = null

    function mergeArgsIntoCurrent(raw: unknown): void {
      if (!currentCall) return
      if (typeof raw === 'string') {
        currentCall.argsString += raw
        return
      }
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        Object.assign(currentCall.args, raw as Record<string, unknown>)
      }
    }

    function finalizeCurrentArgs(): Record<string, unknown> {
      if (!currentCall) return {}
      let merged: Record<string, unknown> = { ...currentCall.args }
      if (currentCall.argsString.length > 0) {
        try {
          const parsed = JSON.parse(currentCall.argsString)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            merged = { ...merged, ...(parsed as Record<string, unknown>) }
          }
        } catch {
          // Malformed concatenation — drop silently; downstream validation
          // surfaces the missing-field error with the object we did
          // manage to assemble.
        }
      }
      return merged
    }

    // Emit the accumulated tool call as the THREE-event sequence the
    // Anthropic Messages streaming IR requires for tool_use blocks:
    //   1. content_block_start with EMPTY input: {}
    //   2. content_block_delta with input_json_delta.partial_json
    //      carrying the full args as a JSON string
    //   3. content_block_stop
    //
    // The downstream consumer (claude.ts / query.ts) accumulates the
    // partial_json string across deltas and JSON.parse()s it at stop.
    // If we emit content_block_start with input pre-filled (and no
    // input_json_delta), the accumulator stays empty — the final input
    // the shared tool layer sees is `{}` and EVERY tool call reports
    // its required params missing. That is exactly the regression the
    // legacy gemini_to_anthropic adapter's structure avoided.
    function* commitCurrentCall(): Generator<AnthropicStreamEvent, void> {
      if (!currentCall) return
      const nativeArgs = finalizeCurrentArgs()
      const reg = getRegistrationByNativeName(currentCall.nativeName)
      const implId = reg?.implId ?? currentCall.nativeName
      const adaptedInput = reg ? reg.adaptInput(nativeArgs) : nativeArgs

      toolCalls.push({
        implId,
        nativeName: currentCall.nativeName,
        input: adaptedInput,
        anthropicToolUseId: currentCall.anthropicToolUseId,
        nativeArgs,
        thoughtSignature: currentCall.thoughtSignature,
      })

      yield {
        type: 'content_block_start',
        index: currentCall.blockIndex,
        content_block: {
          type: 'tool_use',
          id: currentCall.anthropicToolUseId,
          name: implId,
          input: {}, // placeholder — real args arrive via input_json_delta
          // Stash the thought signature so we can thread it back on the
          // next turn (Antigravity + thinking-enabled models need this
          // for multi-turn reasoning coherence).
          ...(currentCall.thoughtSignature && {
            _gemini_thought_signature: currentCall.thoughtSignature,
          }),
        },
      }
      yield {
        type: 'content_block_delta',
        index: currentCall.blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(adaptedInput ?? {}),
        },
      }
      yield { type: 'content_block_stop', index: currentCall.blockIndex }
      currentCall = null
    }

    // Defer message_start until the first chunk arrives so we can fold
    // cache-hit and input-token numbers into the initial usage block —
    // Anthropic's AnthropicMessage.usage carries cache_read_input_tokens
    // only on the initial message_start, so emitting it blank first loses
    // the data. Mirrors the gemini_to_anthropic legacy adapter pattern.
    const emitMessageStart = () => {
      if (messageStartEmitted) return
      messageStartEmitted = true
      const cacheUsage = {
        ...(cacheReadTokens > 0 && {
          cache_read_input_tokens: cacheReadTokens,
        }),
        ...(cacheWriteTokens > 0 && {
          cache_creation_input_tokens: cacheWriteTokens,
        }),
      }
      return {
        type: 'message_start' as const,
        message: {
          id: messageId,
          type: 'message' as const,
          role: 'assistant' as const,
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0,
            ...cacheUsage,
          },
        },
      }
    }

    try {
      const stream = geminiApi.streamGenerateContent(request, signal)

      for await (const chunk of stream) {
        if (signal.aborted) break

        // Fold usage FIRST so message_start (emitted on first chunk) sees
        // the correct cache-hit numbers before any blocks flow.
        if (chunk.usageMetadata) {
          const u = chunk.usageMetadata
          promptTokens = u.promptTokenCount ?? promptTokens
          outputTokens = u.candidatesTokenCount ?? outputTokens
          thinkingTokens = u.thoughtsTokenCount ?? thinkingTokens
          cacheReadTokens = u.cachedContentTokenCount ?? cacheReadTokens
          inputTokens = uncachedInputTokens(promptTokens, cacheReadTokens)
          if (isAntigravityModel) {
            recordAntigravityCacheRead(sessionId, cacheReadTokens, promptTokens)
          }
        }

        if (!messageStartEmitted) {
          const ev = emitMessageStart()
          if (ev) yield ev
        }

        for (const candidate of chunk.candidates ?? []) {
          for (const part of (candidate.content?.parts ?? []) as any[]) {
            // ── Thinking part ──
            if (part.thought === true && typeof part.text === 'string') {
              // A text/thinking part ends any tool-call accumulation.
              if (currentCall) {
                yield* commitCurrentCall()
              }
              if (inBlock === 'text') {
                yield { type: 'content_block_stop', index: blockIndex }
                blockIndex++
                inBlock = null
                responseText = ''
              }
              if (inBlock !== 'thinking') {
                yield {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'thinking', thinking: '' },
                }
                inBlock = 'thinking'
              }
              thinkingText += part.text
              yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'thinking_delta', thinking: part.text },
              }
              continue
            }

            // ── Text part ──
            if (typeof part.text === 'string' && part.thought !== true) {
              if (currentCall) {
                yield* commitCurrentCall()
              }
              if (inBlock === 'thinking') {
                yield { type: 'content_block_stop', index: blockIndex }
                blockIndex++
                inBlock = null
                thinkingText = ''
              }
              if (inBlock !== 'text') {
                yield {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'text', text: '' },
                }
                inBlock = 'text'
              }
              responseText += part.text
              yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: part.text },
              }
              continue
            }

            // ── Function call part ──
            //
            // Gemini can split one logical tool call across multiple SSE
            // chunks. The first carries the name (and usually empty or
            // partial args); the rest carry more args with an empty name
            // as continuation deltas. CLIProxyAPI calls out the same
            // quirk in gemini_claude_response.go: "Handle streaming split/
            // delta where name might be empty in subsequent chunks." We
            // accumulate here and commit below (at a state transition or
            // stream end) so the downstream tool_use block always carries
            // the complete input.
            if (part.functionCall) {
              const fc = part.functionCall as {
                id?: string
                name?: string
                args?: unknown
              }
              // thoughtSignature lives at Part level (sibling of functionCall),
              // not inside functionCall. Server emits camelCase on the
              // generativelanguage response; Code Assist emits snake_case.
              const thoughtSignature =
                (part as { thoughtSignature?: string; thought_signature?: string }).thoughtSignature
                ?? (part as { thought_signature?: string }).thought_signature

              const name = typeof fc.name === 'string' ? fc.name : ''

              if (name === '' && currentCall) {
                // Continuation of the in-progress call — merge more args.
                mergeArgsIntoCurrent(fc.args)
                if (thoughtSignature && !currentCall.thoughtSignature) {
                  currentCall.thoughtSignature = thoughtSignature
                }
                // Late-arriving id (Antigravity → Claude occasionally splits
                // the id across chunks) — backfill onto the in-progress call.
                if (typeof fc.id === 'string' && fc.id && !currentCall.anthropicToolUseIdFromServer) {
                  currentCall.anthropicToolUseId = fc.id
                  currentCall.anthropicToolUseIdFromServer = true
                }
                continue
              }

              // New named call — commit any pending, close open text/
              // thinking block, and start fresh.
              if (currentCall) {
                yield* commitCurrentCall()
              }
              if (inBlock !== null) {
                yield { type: 'content_block_stop', index: blockIndex }
                blockIndex++
                inBlock = null
                responseText = ''
                thinkingText = ''
              }

              // Prefer the server-supplied id (Antigravity/Claude emits
              // `functionCall.id` carrying Claude's original tool_use.id —
              // preserving it keeps the id round-trip intact so the next
              // turn's tool_result references an id Claude actually issued).
              // Fall back to a synthetic toolu_gem_<uuid> when absent — that
              // covers pure Gemini, which never emits ids.
              const serverId = typeof fc.id === 'string' && fc.id ? fc.id : null
              const anthropicToolUseId = serverId ?? `toolu_gem_${randomUUID()}`
              currentCall = {
                nativeName: name,
                args: {},
                argsString: '',
                thoughtSignature,
                blockIndex,
                anthropicToolUseId,
                anthropicToolUseIdFromServer: serverId !== null,
              }
              blockIndex++
              mergeArgsIntoCurrent(fc.args)
              continue
            }
          }
        }
      }
    } catch (err: any) {
      // If the server says the cached content doesn't exist (404 or
      // specific string), invalidate so the next call builds fresh.
      if (
        cacheName
        && err
        && typeof err.body === 'string'
        && (err.status === 404 || /cachedContent/i.test(err.body))
      ) {
        invalidateCache(cacheName)
      }
      // Make sure message_start is emitted so downstream assembly works.
      if (!messageStartEmitted) {
        const ev = emitMessageStart()
        if (ev) yield ev
      }
      if (err?.name === 'AbortError' || signal.aborted) {
        // Drop any in-flight tool call accumulator — its args are
        // incomplete, so emitting it would give the model a garbage
        // tool_use block on the next turn. The turn ends here.
        currentCall = null
        // Close any open block and signal abort.
        if (inBlock !== null) {
          yield { type: 'content_block_stop', index: blockIndex }
        }
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: outputTokens,
            input_tokens: inputTokens,
            ...(cacheReadTokens > 0 && {
              cache_read_input_tokens: cacheReadTokens,
            }),
            ...(cacheWriteTokens > 0 && {
              cache_creation_input_tokens: cacheWriteTokens,
            }),
          },
        }
        yield { type: 'message_stop' }
        return {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cacheReadTokens,
          cache_write_tokens: cacheWriteTokens,
          thinking_tokens: thinkingTokens,
        }
      }
      // Non-abort errors: same rationale as abort — an incomplete tool
      // call shouldn't surface. Drop the accumulator before surfacing
      // the error text block.
      currentCall = null
      // Surface other errors as a text block + end.
      if (inBlock !== null) {
        yield { type: 'content_block_stop', index: blockIndex }
        blockIndex++
      }
      yield {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      }
      // Prompt-too-long errors must surface with the Claude-Code signal
      // prefix un-wrapped so query.ts reactive compact recognizes them
      // via isPromptTooLongMessage(msg). GeminiApiError.message already
      // starts with "Prompt is too long (Gemini N)" in that case.
      const isPTL = (err as { isPromptTooLong?: boolean } | null)?.isPromptTooLong === true

      // Auth-stale 403 that survived the one-shot re-onboard retry means
      // the token itself is bad (account lost Antigravity access, scopes
      // were revoked, or refresh expired). A raw "Gemini API error 403:
      // The caller does not have permission" isn't actionable — replace
      // with a concrete next-step message so the user knows to run /provider.
      const errKind = (err as { kind?: string } | null)?.kind
      const isTerminalAuth = errKind === 'auth-stale'
        || errKind === 'non-retryable'
        || (err?.status === 401 || err?.status === 403)
      const isQuotaOrCapacity = errKind === 'retryable-quota'
        || errKind === 'terminal-quota'
        || err?.status === 429
      const errText = isPTL
        ? (err?.message ?? String(err))
        : isTerminalAuth
          ? buildAuthErrorMessage(err, model)
          : isQuotaOrCapacity
            ? buildQuotaErrorMessage(err, model)
            : `\n\nGemini API error (model: ${model}): ${err?.message ?? String(err)}`
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: errText },
      }
      yield { type: 'content_block_stop', index: blockIndex }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: outputTokens,
          input_tokens: inputTokens,
          ...(cacheReadTokens > 0 && {
            cache_read_input_tokens: cacheReadTokens,
          }),
          ...(cacheWriteTokens > 0 && {
            cache_creation_input_tokens: cacheWriteTokens,
          }),
        },
      }
      yield { type: 'message_stop' }
      return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        thinking_tokens: thinkingTokens,
      }
    }

    // Make sure message_start was emitted (edge case: empty response).
    if (!messageStartEmitted) {
      const ev = emitMessageStart()
      if (ev) yield ev
    }

    // Commit any pending tool call — the stream ended without a state
    // transition to force emission. This is the common case when a
    // response is just one tool call: all the chunks are functionCall
    // parts and the only trigger to commit is end-of-stream.
    if (currentCall) {
      yield* commitCurrentCall()
    }

    // Close final open block.
    if (inBlock !== null) {
      yield { type: 'content_block_stop', index: blockIndex }
    }

    // Decide stop reason: if we emitted tool_use blocks, the model wants to
    // run tools; otherwise it finished its turn.
    const stopReason: 'tool_use' | 'end_turn' =
      toolCalls.length > 0 ? 'tool_use' : 'end_turn'

    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      // Fold end-of-stream usage into message_delta. Gemini delivers
      // usageMetadata only in the final chunk, so message_start was emitted
      // with zeros. updateUsage (claude.ts) picks these up via its > 0 guard
      // — without this, cache_read_input_tokens always displays as 0 on the
      // CLI / Google-account path even when Gemini reports a cache hit.
      usage: {
        output_tokens: outputTokens,
        input_tokens: inputTokens,
        ...(cacheReadTokens > 0 && {
          cache_read_input_tokens: cacheReadTokens,
        }),
        ...(cacheWriteTokens > 0 && {
          cache_creation_input_tokens: cacheWriteTokens,
        }),
      },
    }
    yield { type: 'message_stop' }

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      thinking_tokens: thinkingTokens,
    }
  }

  // ── Lane-owns-loop mode (future Phase-2 migration) ─────────────

  async *run(context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    // Lane-owns-loop isn't wired into the query pipeline yet. For now this
    // delegates to streamAsProvider so the interface stays usable if called.
    const { model, messages, systemParts, mcpTools, signal, maxTokens } = context

    // Synthesize a system string from SystemPromptParts.
    const systemText = assembleSystemFromParts(systemParts)

    // Aggregate lane-native tool defs + MCP tools in provider-tool shape.
    const allTools = [
      ...GEMINI_TOOL_REGISTRY.map(r => ({
        name: r.implId,
        description: r.nativeDescription,
        input_schema: r.nativeSchema,
      })),
      ...mcpTools,
    ]

    const totalUsage: NormalizedUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      thinking_tokens: 0,
    }

    let currentMessages = messages
    let turnCount = 0

    while (turnCount < MAX_TURNS) {
      if (signal.aborted) return { stopReason: 'aborted', usage: totalUsage }
      turnCount++

      const collectedToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

      const gen = this.streamAsProvider({
        model,
        messages: currentMessages,
        system: systemText,
        tools: allTools,
        max_tokens: maxTokens,
        signal,
      })

      // Forward events while collecting tool_use blocks for execution.
      let done = false
      let stopReason: 'end_turn' | 'tool_use' = 'end_turn'
      while (!done) {
        const next = await gen.next()
        if (next.done) {
          const u = next.value
          totalUsage.input_tokens += u.input_tokens
          totalUsage.output_tokens += u.output_tokens
          totalUsage.cache_read_tokens += u.cache_read_tokens
          totalUsage.cache_write_tokens += u.cache_write_tokens
          totalUsage.thinking_tokens += u.thinking_tokens
          done = true
          break
        }
        const ev = next.value
        yield ev
        if (
          ev.type === 'content_block_start'
          && ev.content_block?.type === 'tool_use'
          && ev.content_block.id
          && ev.content_block.name
        ) {
          collectedToolUses.push({
            id: ev.content_block.id,
            name: ev.content_block.name,
            input: (ev.content_block.input ?? {}) as Record<string, unknown>,
          })
        }
        if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'tool_use') {
          stopReason = 'tool_use'
        }
      }

      if (stopReason !== 'tool_use' || collectedToolUses.length === 0) {
        return { stopReason: 'end_turn', usage: totalUsage }
      }

      // Execute tools via the shared layer and feed results back.
      const toolResultBlocks = await Promise.all(
        collectedToolUses.map(async tu => {
          try {
            const result = await context.executeTool(tu.name, tu.input)
            return {
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content),
              is_error: result.isError,
            }
          } catch (e: any) {
            return {
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: `Error: ${e?.message ?? String(e)}`,
              is_error: true,
            }
          }
        }),
      )

      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant',
          content: collectedToolUses.map(tu => ({
            type: 'tool_use',
            id: tu.id,
            name: tu.name,
            input: tu.input,
          })),
        },
        { role: 'user', content: toolResultBlocks },
      ]
    }

    return { stopReason: 'max_turns', usage: totalUsage }
  }

  async listModels(providerFilter?: string): Promise<ModelInfo[]> {
    return geminiApi.listModels(providerFilter)
  }

  resolveModel(model: string): string {
    return model
  }

  smallFastModel(): string {
    // CLI-OAuth flash-lite is the cheapest Gemini model we can reach
    // on any auth path. API-key users could pay for the same via the
    // Studio endpoint; OAuth users get it free on the Code Assist pool.
    return 'gemini-2.5-flash-lite'
  }

  isHealthy(): boolean {
    return this._healthy
  }

  setHealthy(healthy: boolean): void {
    this._healthy = healthy
  }

  dispose(): void {
    // No resources to release yet. When we add cachedContent lifetime
    // management we'll clean up here.
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function resolveThinkingBudget(
  thinking: LaneProviderCallParams['thinking'] | undefined,
): number {
  // -1 = dynamic (Gemini picks per-turn). 0 = off. positive integer = cap.
  if (!thinking || thinking.type === 'adaptive') return -1
  if (thinking.type === 'disabled') return 0
  if (thinking.type === 'enabled') return thinking.budget_tokens ?? -1
  return -1
}

/**
 * Build the right shape of `thinkingConfig` for the target model.
 *
 * Gemini 3.x Antigravity models advertise LEVEL-based thinking ("low",
 * "medium", "high") via the model registry — sending `thinkingBudget` on
 * them defaults to "high" thinking regardless of user intent, because the
 * server ignores the int and falls back to its model-default level. That
 * made `gemini-3.1-pro-low` just as slow as `-pro-high` (the root cause
 * of the "cancer latency" the user reported).
 *
 * Rule: when the model name has an explicit `-high` / `-low` / `-medium`
 * suffix (Antigravity convention), emit `thinkingLevel` in that level.
 * Otherwise, keep the legacy integer `thinkingBudget` path for 2.x models
 * and non-suffixed flash/lite variants.
 */
function resolveThinkingConfig(
  model: string,
  thinkingBudget: number,
): Record<string, unknown> {
  const lower = model.toLowerCase()
  // Match explicit suffix first — the suffix encodes the user's choice.
  let level: 'low' | 'medium' | 'high' | null = null
  const levelMatch = lower.match(/^gemini-\d+(?:\.\d+)?-(?:pro|flash)-(high|medium|low)$/)
  if (levelMatch) level = levelMatch[1] as 'low' | 'medium' | 'high'
  else if (/^gemini-3(?:\.\d+)?-flash$/.test(lower)) level = 'low' // Antigravity flash defaults to "low"

  if (level) {
    return {
      thinkingLevel: level,
      includeThoughts: thinkingBudget !== 0,
    }
  }
  // Legacy integer budget for 2.x, preview-flash-lite, etc.
  return {
    thinkingBudget,
    includeThoughts: thinkingBudget !== 0,
  }
}

/**
 * @deprecated Used by the lane-owns-loop `run()` scaffold only. The
 * real path (`streamAsProvider`) already receives a pre-assembled
 * `system` string from `query.ts`. When `run()` is wired end-to-end
 * in Phase 2 of the redesign this flattens the split only for lanes
 * that can't carry a separate cache surface; Gemini proper should
 * instead call `assembleGeminiSystemPrompt` and place `stable` in
 * `systemInstruction` / cachedContents, `volatile` inline as the
 * leading user message.
 */
function assembleSystemFromParts(parts: {
  memory?: string
  environment?: string
  gitStatus?: string
  toolsAddendum?: string
  mcpIntro?: string
  skillsContext?: string
  customInstructions?: string
}): string {
  const sections: string[] = []
  if (parts.customInstructions) sections.push(parts.customInstructions)
  if (parts.toolsAddendum) sections.push(parts.toolsAddendum)
  if (parts.mcpIntro) sections.push(parts.mcpIntro)
  if (parts.skillsContext) sections.push(`Skills:\n${parts.skillsContext}`)
  if (parts.memory) sections.push(`Context:\n${parts.memory}`)
  if (parts.environment) sections.push(parts.environment)
  if (parts.gitStatus) sections.push(`Git status:\n${parts.gitStatus}`)
  return sections.join('\n\n')
}

// Build a map of tool_use_id → native tool name by scanning the history
// for tool_use blocks. Some blocks emit an implId as their name, others may
// already carry the native name. We record both candidates keyed by id.
function buildToolUseIdToNativeMap(
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        // Resolve the block's name → native name. If name is an implId, look
        // up the first native registration; otherwise treat it as already-native.
        const native = implIdToNative(block.name) ?? block.name
        map.set(block.id, native)
      }
    }
  }
  return map
}

// ─── History Conversion ──────────────────────────────────────────
//
// Anthropic-IR ProviderMessage[] → Gemini native GeminiContent[].
// Handles the shared-impl-name ↔ native-name mapping transparently.

function convertHistoryToGemini(
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
  toolUseIdToNative: Map<string, string>,
): GeminiContent[] {
  const contents: GeminiContent[] = []

  for (const msg of messages) {
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []

    if (typeof msg.content === 'string') {
      if (msg.content.length > 0) parts.push({ text: msg.content })
    } else {
      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            if (block.text) parts.push({ text: block.text })
            break
          case 'tool_use':
            if (block.name) {
              const nativeName = implIdToNative(block.name) ?? block.name
              const nativeInput = implToNativeInput(block.name, block.input ?? {})
              // thoughtSignature lives on the Part (sibling of functionCall),
              // NOT inside functionCall — the proto has it at Part level.
              // Only emit when we captured a real one from the prior turn;
              // the server rejects placeholder/synthetic values.
              // Carry block.id on functionCall.id — Antigravity's Gemini→
              // Anthropic bridge uses it to populate tool_use.id on the
              // request it forwards to Claude. Without it Claude rejects
              // with "messages.N.content.M.tool_use.id: Field required".
              const fc: GeminiPart = {
                functionCall: {
                  ...(block.id ? { id: block.id } : {}),
                  name: nativeName,
                  args: nativeInput,
                },
                ...(block._gemini_thought_signature && {
                  thoughtSignature: block._gemini_thought_signature,
                }),
              }
              parts.push(fc)
            }
            break
          case 'tool_result': {
            const id = block.tool_use_id ?? ''
            const nativeName = (id && toolUseIdToNative.get(id)) ?? 'unknown'
            // Split content into text (→ functionResponse.content) and
            // image parts (→ sibling inlineData Parts). Gemini natively
            // handles multimodal function responses via adjacent
            // inlineData parts — stringifying base64 images into a text
            // JSON blob would dump raw bytes into the model's context.
            const { text, images } = splitToolResultContent(block.content)
            // Carry tool_use_id on functionResponse.id so Antigravity can
            // round-trip Claude's tool_use_id → tool_result matching.
            parts.push({
              functionResponse: {
                ...(id ? { id } : {}),
                name: nativeName,
                response: { content: text },
              },
            })
            for (const img of images) {
              parts.push({ inlineData: img })
            }
            break
          }
          case 'thinking':
            if (block.thinking) parts.push({ thought: true, text: block.thinking })
            break
        }
      }
    }

    if (parts.length > 0) contents.push({ role, parts })
  }

  return contents
}

function stableAntigravitySessionId(
  sessionId: string | undefined,
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
): string {
  const source = sessionId?.trim() || firstUserTextFromMessages(messages)
  return stableNegativeHash(source || JSON.stringify(messages.map(msg => msg.role)))
}

function firstUserTextFromMessages(
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
): string {
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    const text = msg.content
      .map(block => block.type === 'text' ? block.text ?? '' : '')
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  return ''
}

function stableNegativeHash(text: string): string {
  let hash = 0
  for (const ch of text) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  }
  return `-${Math.abs(hash).toString()}`
}

/**
 * Split a tool_result block's content into text + image parts.
 *
 * Gemini accepts `inlineData` parts alongside `functionResponse` in the
 * same user turn; that is the native way to hand an image back to the
 * model. The legacy stringifier dumped image blocks into JSON, which
 * meant base64 bytes hit the model as text tokens (useless + expensive).
 *
 * Input shapes:
 *   - string                                              → all text
 *   - Array<{type:'text',text}|{type:'image',source:{...}}>
 *   - Array of bare `{text}` blocks (legacy)
 */
function splitToolResultContent(content: unknown): {
  text: string
  images: Array<{ mimeType: string; data: string }>
} {
  if (typeof content === 'string') {
    return { text: content, images: [] }
  }
  if (!Array.isArray(content)) {
    return { text: JSON.stringify(content ?? ''), images: [] }
  }
  const texts: string[] = []
  const images: Array<{ mimeType: string; data: string }> = []
  for (const b of content as any[]) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text)
      continue
    }
    if (b.type === 'image' && b.source && typeof b.source === 'object') {
      // Anthropic image source shape: { type: 'base64', media_type, data }
      // Map into Gemini inlineData: { mimeType, data }. Bail on URL-only
      // sources (Gemini doesn't fetch); stringify so the user sees something.
      const src = b.source as {
        type?: string
        media_type?: string
        mediaType?: string
        data?: string
        url?: string
      }
      const mimeType = src.media_type ?? src.mediaType ?? 'image/png'
      if (typeof src.data === 'string' && src.data.length > 0) {
        images.push({ mimeType, data: src.data })
        continue
      }
      if (src.url) {
        texts.push(`[image url: ${src.url}]`)
        continue
      }
      texts.push(`[image attached: ${mimeType}]`)
      continue
    }
    // Bare {text} legacy block or unknown shape.
    if (typeof b.text === 'string') {
      texts.push(b.text)
      continue
    }
    texts.push(JSON.stringify(b))
  }
  return { text: texts.join('\n'), images }
}

// Map a shared impl id → native Gemini tool name (first match wins).
// Returns undefined for unknown impls (MCP tools etc — caller treats the
// name as already-native).
const _implToNative = new Map<string, string>()
function _ensureImplMap(): void {
  if (_implToNative.size > 0) return
  for (const reg of GEMINI_TOOL_REGISTRY) {
    if (!_implToNative.has(reg.implId)) {
      _implToNative.set(reg.implId, reg.nativeName)
    }
  }
}
function implIdToNative(implOrNative: string): string | undefined {
  _ensureImplMap()
  if (_implToNative.has(implOrNative)) return _implToNative.get(implOrNative)
  // If it's already a native name, return as-is.
  const reg = getRegistrationByNativeName(implOrNative)
  if (reg) return reg.nativeName
  return undefined
}

// Translate shared-impl input → native Gemini input shape, running it
// through adaptInput's inverse where available. For most tools the shape
// is nearly identical, but some (Read offset+limit ↔ start_line+end_line)
// differ and we do the best-effort inverse here.
function implToNativeInput(
  implOrNative: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  // If the caller already sent native-name input, pass through.
  const byNative = getRegistrationByNativeName(implOrNative)
  if (byNative) return input

  // Find by impl id.
  const reg = GEMINI_TOOL_REGISTRY.find(r => r.implId === implOrNative)
  if (!reg) return input

  // Specific inverse adapters for divergent shapes.
  switch (reg.nativeName) {
    case 'read_file': {
      const offset = input.offset as number | undefined
      const limit = input.limit as number | undefined
      const out: Record<string, unknown> = { file_path: input.file_path }
      if (offset != null) {
        out.start_line = offset + 1
        if (limit != null) out.end_line = offset + limit
      }
      return out
    }
    case 'replace': {
      return {
        file_path: input.file_path,
        old_string: input.old_string,
        new_string: input.new_string,
        ...(input.replace_all != null && { allow_multiple: input.replace_all }),
      }
    }
    case 'grep_search': {
      const out: Record<string, unknown> = { pattern: input.pattern }
      if (input.path != null) out.dir_path = input.path
      if (input.glob != null) out.include_pattern = input.glob
      if (input.head_limit != null) out.total_max_matches = input.head_limit
      if (input.output_mode === 'files_with_matches') out.names_only = true
      return out
    }
    default:
      return input
  }
}

// Build function declarations from the active tool list passed in by the
// caller. Tools matching our native registry use the native schema the
// model was trained on; unknown tools (MCP, custom) pass through with
// their provider-shaped schema, after light sanitization for Gemini.
function buildLaneFunctionDeclarations(
  tools: import('../../services/api/providers/base_provider.js').ProviderTool[],
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  const decls: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = []

  for (const tool of tools) {
    // Try to match by impl id first (how claude.ts names tools).
    const byImpl = GEMINI_TOOL_REGISTRY.find(r => r.implId === tool.name)
    if (byImpl) {
      decls.push({
        name: byImpl.nativeName,
        description: appendStrictParamsHint(byImpl.nativeDescription, byImpl.nativeSchema),
        parameters: byImpl.nativeSchema,
      })
      continue
    }

    // Maybe the caller already gave us a native name.
    const byNative = getRegistrationByNativeName(tool.name)
    if (byNative) {
      decls.push({
        name: byNative.nativeName,
        description: appendStrictParamsHint(byNative.nativeDescription, byNative.nativeSchema),
        parameters: byNative.nativeSchema,
      })
      continue
    }

    // Unknown tool — forward with its provider-shaped schema, routed
    // through the shared MCP bridge sanitizer for the 'gemini' profile.
    // Also append the STRICT PARAMETERS hint so Flash models see the
    // field-level requirement plainly in the description — Flash is
    // prone to emitting empty-args tool calls when the hint is absent.
    const parameters = sanitizeSchemaForLane(
      tool.input_schema ?? { type: 'object', properties: {} },
      'gemini',
    )
    decls.push({
      name: tool.name,
      description: appendStrictParamsHint(tool.description ?? '', parameters),
      parameters,
    })
  }

  return decls
}

// ─── Request Builder ─────────────────────────────────────────────

interface GeminiRequestConfig {
  model: string
  contents: GeminiContent[]
  systemText: string
  functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxOutputTokens: number
  thinkingBudget: number
  /** Server-side cache name from cachedContents API (if hit). */
  cacheName?: string | null
}

function buildGeminiRequest(config: GeminiRequestConfig): Record<string, unknown> {
  const {
    model,
    contents,
    systemText,
    functionDeclarations,
    maxOutputTokens,
    thinkingBudget,
    cacheName,
  } = config

  const hasTools = functionDeclarations.length > 0
  // When tools are present, prepend the TOOL_USAGE_RULES preamble to the
  // system instruction so the model treats the schema as authoritative
  // and stops emitting empty-args tool calls. Byte cost is ~400; big
  // quality win on Flash-class models that ignore the schema otherwise.
  const systemTextWithRules = hasTools
    ? `${GEMINI_TOOL_USAGE_RULES}\n${systemText}`
    : systemText

  // Antigravity pro/flash models (gemini-3.x family) expose a LEVEL-based
  // thinking API (low/medium/high) rather than the legacy budget-int API.
  // If we send `thinkingBudget: -1` (dynamic) on these, the server defaults
  // to "high" thinking — which is why `-pro-low` was previously taking
  // just as long as `-pro-high`. Translate model name suffix → thinking
  // level to honor the user's choice.
  //
  //   gemini-3.1-pro-high → thinkingLevel: "high"
  //   gemini-3.1-pro-low  → thinkingLevel: "low"
  //   gemini-3-flash      → thinkingLevel: "low"   (flash default)
  //   (other -flash, -lite preview, 2.5 family)   → thinkingBudget (legacy)
  const thinkingConfig = resolveThinkingConfig(model, thinkingBudget)

  const request: Record<string, unknown> = {
    model,
    contents,
    generationConfig: {
      maxOutputTokens,
      topP: 0.95,
      topK: 64,
      thinkingConfig,
    },
    // Safety categories OFF — matches gemini-cli and CLIProxyAPI defaults so
    // the model behaves the same way it does in its home environment.
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
    ],
  }

  // Cache is mutually exclusive with inline system + tools — when the
  // cachedContents API holds the stable portion, reference it and omit
  // the duplicated fields. Otherwise send them inline every turn.
  if (cacheName) {
    request.cachedContent = cacheName
  } else {
    request.systemInstruction = { parts: [{ text: systemTextWithRules }] }
    if (hasTools) {
      request.tools = [{ functionDeclarations }]
      // Server-side schema enforcement — Gemini rejects calls that don't
      // match the declared schema BEFORE streaming them back, so empty-
      // args hallucinations don't reach us (and don't burn tool-result
      // retry cycles). This is the single most effective knob against
      // the Flash empty-args problem the legacy adapter fought.
      request.toolConfig = {
        functionCallingConfig: { mode: 'VALIDATED' },
      }
    }
  }

  return request
}

// ─── Auth-error message formatting ───────────────────────────────
//
// A raw "Gemini API error 403: The caller does not have permission"
// isn't actionable for the user. When the error is classified as
// auth-stale / non-retryable / 401 / 403 we rewrite it into a message
// that tells the user exactly what to do — and points at the right
// remediation surface (Antigravity account page for Antigravity
// models, /provider for OAuth refresh, /login for a fresh auth).

// Antigravity-only model ids — these route through the Antigravity
// quota pool and 403 if the user only has the Gemini-CLI OAuth token.
// Kept in sync with the routing catalog in gemini_code_assist.ts.
const ANTIGRAVITY_ONLY_MODEL_IDS = ANTIGRAVITY_MODEL_IDS

function buildAuthErrorMessage(err: any, model?: string): string {
  const status = err?.status
  const statusPrefix = status ? `Gemini ${status} ` : 'Gemini '
  const detail = (err?.body && typeof err.body === 'string')
    ? err.body.slice(0, 180).replace(/\s+/g, ' ').trim()
    : (err?.message ?? String(err))
  const normalizedModel = model?.toLowerCase()
  const isAntigravityOnly = !!normalizedModel && ANTIGRAVITY_ONLY_MODEL_IDS.has(normalizedModel)
  const wireModel = isAntigravityOnly && model ? resolveAntigravityWireModel(model) : null
  const modelLine = model ? `Model attempted: ${model}` : null
  const wireModelLine = wireModel && wireModel !== model ? `Antigravity wire model: ${wireModel}` : null

  // Antigravity-only models must stay on the Antigravity executor. Status
  // determines whether the likely problem is OAuth/account access or an
  // endpoint/wire-model rejection.

  // Detect the Google "ghost project" 403 pattern. Per gemini-cli
  // issues #24747 / #25189 / #25609, Google AI Pro/Ultra subscribers
  // sometimes get an inaccessible cloudaicompanionProject auto-bound
  // to their account; every Code Assist call then 403s. The only
  // reliable client-side mitigation is a manual project override via
  // GOOGLE_CLOUD_PROJECT.
  const looksLikeGhostProject =
    status === 403
    && /cloudaicompanion|caller does not have permission|PERMISSION_DENIED/i.test(
      typeof err?.body === 'string' ? err.body : String(err?.message ?? ''),
    )

  const lines = [
    '',
    '',
    `${statusPrefix}request failed before it reached the model.`,
    '',
    ...(modelLine ? [modelLine, ''] : []),
    ...(wireModelLine ? [wireModelLine, ''] : []),
    `Server said: ${detail}`,
    '',
  ]

  if (isAntigravityOnly) {
    if (status === 404) {
      lines.push(
        'This model only routes through the Antigravity quota pool.',
        'A 404 here means the Antigravity backend rejected the endpoint or wire model before generation started.',
        'Tau sends Gemini 3.5 Flash through the model keys returned by Antigravity quota discovery and keeps the selected thinking level.',
        'If this continues, run `/login antigravity` to refresh the Antigravity account or pick another model temporarily.',
      )
    } else {
      lines.push(
        'This model only routes through the Antigravity quota pool.',
        'Make sure the Antigravity account is connected and has access:',
        '  1. Run `/login antigravity` to refresh the Antigravity flow, or',
        '  2. Pick a different Pro model (gemini-3.1-pro-preview,',
        '     gemini-3-pro-preview, gemini-2.5-pro) which routes through',
        '     the Gemini CLI executor.',
      )
    }
  } else if (looksLikeGhostProject) {
    lines.push(
      'This is the known "ghost cloudaicompanionProject" 403 that hits',
      'Google AI Pro/Ultra subscribers (gemini-cli issues #24747, #25189,',
      '#25609). Google\'s backend auto-binds an inaccessible project ID',
      'to the account. The only reliable client-side fixes:',
      '  1. Set `GOOGLE_CLOUD_PROJECT=<your-project-id>` (or',
      '     `GEMINI_CLOUD_PROJECT`) and restart Tau — Tau will',
      '     skip the auto-discovered project and use yours instead.',
      '     (Grab a project id from console.cloud.google.com on the same',
      '     Google account you logged in with.)',
      '  2. If `/models` is also missing your Pro models, set',
      '     `GEMINI_SHOW_PRO_MODELS=true` to force-show them — Google\'s',
      '     entitlement endpoints don\'t always reflect AI Pro subscriptions.',
      '  3. Run `/provider` and reconnect — sometimes the next loadCodeAssist',
      '     returns a working project on retry.',
      '  4. As a last resort, switch to API key (set GEMINI_API_KEY and',
      '     GEMINI_SHOW_API_KEY_LOGIN=true), which uses a different endpoint.',
    )
  } else {
    lines.push(
      'What to do:',
      '  1. Run `/provider` to refresh your Gemini OAuth token, or',
      '  2. Run `/login` and re-authorize the Google account, or',
      '  3. Open https://antigravity.google.com/ to confirm the account still has access.',
      '',
      'If you have multiple Google accounts enrolled, the lane will',
      'automatically rotate to the next healthy account on the next request.',
    )
  }

  return lines.join('\n')
}

function buildQuotaErrorMessage(err: any, model?: string): string {
  const status = err?.status
  const details = err?.classification?.details
  const serverMessage = typeof details?.message === 'string'
    ? details.message
    : extractGoogleErrorMessage(err?.body)
      ?? (err?.message ?? String(err))
  const retryAfterMs = typeof err?.retryAfterMs === 'number' ? err.retryAfterMs : undefined
  const retryLine = retryAfterMs && retryAfterMs > 0
    ? `Retry after: about ${Math.ceil(retryAfterMs / 1000)} seconds`
    : null
  const modelLine = model ? `Model attempted: ${model}` : null
  const isAntigravityModel = !!model && ANTIGRAVITY_ONLY_MODEL_IDS.has(model.toLowerCase())

  const lines = [
    '',
    '',
    `${isAntigravityModel ? 'Antigravity' : 'Gemini'} request was throttled or capacity-limited${status ? ` (HTTP ${status})` : ''}.`,
    '',
    ...(modelLine ? [modelLine, ''] : []),
    `Server said: ${serverMessage}`,
    ...(retryLine ? ['', retryLine] : []),
    '',
  ]

  if (isAntigravityModel) {
    lines.push(
      'Tau retried this request and, when possible, marked the selected account/model family for rotation.',
      'This can happen even when the usage page shows remaining quota, because the backend can throttle an endpoint or request window separately.',
      'What to do:',
      '  1. Wait for the Antigravity request window or backend capacity to recover, or',
      '  2. Add/switch another Antigravity account with `/login antigravity`, or',
      '  3. Pick a non-Antigravity model for now, such as gemini-3.1-pro-preview, gemini-3-pro-preview, or gemini-2.5-pro.',
    )
  } else {
    lines.push(
      'What to do:',
      '  1. Wait for quota/capacity to recover, or',
      '  2. Switch model/account/provider and retry.',
    )
  }

  return lines.join('\n')
}

function extractGoogleErrorMessage(body: unknown): string | null {
  if (typeof body !== 'string' || !body) return null
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    const message = parsed.error?.message ?? parsed.message
    return typeof message === 'string' ? message : null
  } catch {
    return null
  }
}

// ─── System-prompt stable/volatile split ─────────────────────────
//
// Tau emits `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` as a separator
// between cacheable (stable) and per-turn (volatile) content. When the
// caller forwards a flat system string to the lane, we split on that
// marker so our `cachedContents` body sees only stable bytes and the
// cache key survives turn-to-turn. Falling back: if no marker found,
// treat the whole thing as stable — matches previous behavior, no
// regression for callers that haven't adopted the marker.

const DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

function splitSystemAtBoundary(text: string): {
  stableText: string
  volatileText: string
} {
  if (!text) return { stableText: '', volatileText: '' }
  const idx = text.indexOf(DYNAMIC_BOUNDARY)
  if (idx < 0) return { stableText: text, volatileText: '' }
  return {
    stableText: text.slice(0, idx).replace(/\s+$/, ''),
    volatileText: text.slice(idx + DYNAMIC_BOUNDARY.length).replace(/^\s+/, ''),
  }
}

// ─── Singleton Export ────────────────────────────────────────────

export const geminiLane = new GeminiLane()
