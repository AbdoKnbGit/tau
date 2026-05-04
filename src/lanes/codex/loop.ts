/**
 * Codex Lane — Agent Loop + Provider-Shim Entry
 *
 * Two entry points, same pattern as the Gemini lane:
 *
 *   1. streamAsProvider(params) — single-turn, provider-shim-compatible.
 *      Used by src/lanes/provider-bridge.ts. Issues ONE Responses API
 *      call in the native idiom: POST /responses, apply_patch (freeform
 *      custom tool), reasoning {effort,summary}, stable prompt_cache_key
 *      for sticky cache routing, `store: false` except on Azure.
 *
 *   2. run(context) — future lane-owns-loop mode. Scaffolded but not
 *      wired; Phase-2 migration target.
 *
 * Native Codex patterns speak the Responses API directly. Using Chat
 * Completions on GPT-5/gpt-5-codex/o-series produces measurable quality
 * regressions on tool-heavy agent workloads — the models are post-trained
 * against response.* events, not chat.completion chunks.
 *
 * References:
 *   - codex-rs/core/src/codex.rs (agent loop)
 *   - codex-rs/core/src/client.rs (build_responses_request — store/include)
 *   - codex-rs/codex-api/src/sse/responses.rs (event shapes)
 *   - codex-rs/core/gpt-5.2-codex_prompt.md (system prompt)
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  LaneProviderCallParams,
  NormalizedUsage,
} from '../types.js'
import {
  buildCodexResponsesTools,
  getCodexRegistrationByNativeName,
  CODEX_TOOL_REGISTRY,
} from './tools.js'
import {
  appendStrictParamsHint,
  sanitizeSchemaForLane,
  CODEX_TOOL_USAGE_RULES,
} from '../shared/mcp_bridge.js'
import {
  codexApi,
  type CodexInputItem,
  type CodexContentPart,
  type CodexStreamEvent,
  type CodexReasoningConfig,
  type CodexResponsesRequest,
} from './api.js'
import {
  getOpenAIReasoningLevel,
  isReasoningLevelExplicit,
} from '../../utils/model/openaiReasoning.js'

// ─── Lane Implementation ─────────────────────────────────────────

export class CodexLane implements Lane {
  readonly name = 'codex'
  readonly displayName = 'OpenAI Codex (Native Responses API)'

  private _healthy = true

  configure(opts: { apiKey?: string; baseUrl?: string; chatgptAccessToken?: string; chatgptAccountId?: string; chatgptIdToken?: string }): void {
    codexApi.configure(opts)
    this._healthy = codexApi.isConfigured
  }

  supportsModel(model: string): boolean {
    const m = model.toLowerCase()
    return (
      m.startsWith('gpt-') ||
      m.startsWith('o1') ||
      m.startsWith('o3') ||
      m.startsWith('o4') ||
      m.startsWith('o5') ||
      m.startsWith('codex-') ||
      m.startsWith('gpt-5-codex') ||
      m.includes('openai/')
    )
  }

  // ── Provider-shim-compatible single-turn entry ──────────────────

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, max_tokens, thinking, signal } = params

    // Assemble the full system text the upstream sent us, then split it
    // into a stable (cache-eligible) prefix and a volatile (per-turn) tail
    // so the Responses API `instructions` field stays byte-identical
    // across turns. Without this split, env / git status / memory bleed
    // into `instructions` each turn → the OpenAI prompt-cache prefix hash
    // drifts → cache hits land partially or not at all (the user-reported
    // "cache hits but unstable" pattern under heavy tool-call sessions).
    //
    // We mirror the same primary-marker / regex-fallback strategy
    // gemini_provider.ts ships, since claudex doesn't emit the
    // `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker for non-firstParty
    // providers (`shouldUseGlobalCacheScope()` is firstParty-only).
    const fullSystemText = typeof system === 'string'
      ? system
      : (system ?? []).map(b => b.text).join('\n\n')
    const { stable: rawInstructions, volatile: volatileSystemText } =
      splitCodexSystemForCache(fullSystemText)

    // Build tool_use_id → native name map so function_call_output items
    // send back the correct call_id / name shape across the turn boundary.
    const toolUseIdToCallId = buildToolUseIdToCallIdMap(messages)

    // Convert Anthropic history → Responses API input items.
    const inputItems = convertHistoryToCodex(messages, toolUseIdToCallId)

    // Inject the volatile system tail as a `developer` input message
    // right before the latest user message. Two reasons this exact slot:
    //   1. The cache prefix runs through every item up to (but not
    //      including) the new turn — putting volatile content at the
    //      "fresh" boundary keeps everything before it byte-stable
    //      across turns.
    //   2. On the very first turn there is no prior history, so injecting
    //      before user1 still gives the model the env/git/memory it
    //      needs without breaking any existing cache (there isn't one
    //      yet).
    if (volatileSystemText) {
      const insertionIndex = findLastUserMessageIndex(inputItems)
      const volatileItem: CodexInputItem = {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: volatileSystemText }],
      }
      if (insertionIndex >= 0) {
        inputItems.splice(insertionIndex, 0, volatileItem)
      } else {
        // No user message in history (rare — agent loop sometimes calls
        // with assistant-only history during continuations). Append so
        // the model still sees the volatile context.
        inputItems.push(volatileItem)
      }
    }

    // Map caller-provided tools → Codex Responses format. We honor the
    // native tool registry for tools we recognize (including apply_patch
    // as a freeform custom tool) and pass through MCP / custom tools as
    // function-schema tools with sanitized parameters. Each function
    // tool gets `strict: true` (server-side schema enforcement, OpenAI's
    // equivalent of Gemini's VALIDATED mode) + the STRICT PARAMETERS
    // description hint.
    const codexTools = buildCodexToolsFromRequest(tools)

    // Prepend CODEX_TOOL_USAGE_RULES to instructions when tools are
    // present — belt-and-suspenders with `strict: true` so the model
    // treats the schema as authoritative and doesn't emit empty-args
    // function calls. The preamble is tuned to match Codex's concise
    // native prompt tone.
    const instructions = codexTools && codexTools.length > 0
      ? `${CODEX_TOOL_USAGE_RULES}\n${rawInstructions}`
      : rawInstructions

    // Map thinking param → Codex reasoning config. Anthropic's adaptive /
    // enabled with budget_tokens mapping:
    //   disabled → no reasoning field
    //   adaptive / enabled (low budget) → low
    //   enabled with mid budget → medium
    //   enabled with high budget → high
    const reasoning = resolveReasoning(thinking, model)

    // Request body must match codex-rs's `ResponsesApiRequest` wire
    // shape exactly. Native codex DOES NOT send `max_output_tokens` or
    // `temperature` — shipping them changes the serialized body and can
    // move the request to a non-cached partition on the backend (every
    // extra field contributes to the request-shape hash the server uses
    // to validate incremental cache eligibility). The server defaults
    // for output length / sampling are what gpt-5-codex is tuned on.
    // Ref: codex-rs/codex-api/src/common.rs ResponsesApiRequest
    //      codex-rs/core/src/client.rs build_responses_request
    void max_tokens
    const request: CodexResponsesRequest = {
      model,
      instructions,
      input: inputItems,
      tools: codexTools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning,
      // codex-rs sets store=true ONLY on Azure; OpenAI + ChatGPT lanes
      // run with store=false. `store: true` on non-Azure forces the
      // server to persist and diff response items, which invalidates
      // the KV cache on every tool-call turn — the dominant cause of
      // the "cache hit rate = 0" token burn.
      // Ref: codex-rs/core/src/client.rs line 873.
      store: codexApi.isAzureResponsesEndpoint,
      stream: true,
      // When reasoning is enabled, codex-rs includes
      // reasoning.encrypted_content so follow-up turns can replay the
      // model's own thinking back at it. (Ref: client.rs build_responses_request.)
      include: reasoning ? ['reasoning.encrypted_content'] : undefined,
      // Stable per-conversation cache routing hint. codex-rs sets this
      // to `conversation_id` so identical prefixes land on a KV-cache
      // warm node every turn. Must stay constant across turns — we
      // rotate only when the conversation resets (dispose()).
      prompt_cache_key: codexApi.sessionCacheKey,
    }

    // Stream state.
    let inputTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let cachedInputTokens = 0
    let messageStartEmitted = false

    const messageId = `codex-${Date.now()}`

    const emitMessageStart = () => {
      if (messageStartEmitted) return undefined
      messageStartEmitted = true
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
            ...(cachedInputTokens > 0 && {
              cache_read_input_tokens: cachedInputTokens,
              cache_creation_input_tokens: 0,
            }),
          },
        },
      }
    }

    // Track which output_index maps to which Anthropic block index, and
    // which ones are open so we know when to stop them.
    const openBlocks = new Map<number, { anthropicIndex: number; kind: 'text' | 'thinking' | 'tool_use' }>()
    let nextBlockIndex = 0
    let emittedAnyToolUse = false

    // Tool-call assembly state. Codex streams arguments as deltas, so we
    // accumulate them until output_item.done fires with the full item.
    const toolCallBuffers = new Map<number, { callId: string; name: string; args: string; isCustom: boolean; anthropicIndex: number }>()

    try {
      for await (const ev of codexApi.streamResponses(request, signal)) {
        if (signal.aborted) break

        // Some usage info can arrive on response.created / .in_progress,
        // most lands on response.completed. Emit message_start as soon
        // as we've got enough to populate it (either created or first
        // token-bearing event).
        if (ev.type === 'response.created' || ev.type === 'response.in_progress') {
          if (!messageStartEmitted) {
            const mst = emitMessageStart()
            if (mst) yield mst
          }
          continue
        }

        if (ev.type === 'response.output_item.added') {
          if (!messageStartEmitted) {
            const mst = emitMessageStart()
            if (mst) yield mst
          }
          const item = (ev as any).item as {
            type: string
            id?: string
            call_id?: string
            name?: string
          }
          const outputIndex = (ev as any).output_index as number

          if (item.type === 'message') {
            const anthropicIndex = nextBlockIndex++
            openBlocks.set(outputIndex, { anthropicIndex, kind: 'text' })
            yield {
              type: 'content_block_start',
              index: anthropicIndex,
              content_block: { type: 'text', text: '' },
            }
          } else if (item.type === 'reasoning') {
            const anthropicIndex = nextBlockIndex++
            openBlocks.set(outputIndex, { anthropicIndex, kind: 'thinking' })
            yield {
              type: 'content_block_start',
              index: anthropicIndex,
              content_block: { type: 'thinking', thinking: '' },
            }
          } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            const isCustom = item.type === 'custom_tool_call'
            const anthropicIndex = nextBlockIndex++
            toolCallBuffers.set(outputIndex, {
              callId: item.call_id ?? item.id ?? `call-${outputIndex}`,
              name: item.name ?? 'unknown',
              args: '',
              isCustom,
              anthropicIndex,
            })
            emittedAnyToolUse = true
          }
          continue
        }

        if (ev.type === 'response.output_text.delta') {
          const outputIndex = (ev as any).output_index as number
          const delta = (ev as any).delta as string
          const open = openBlocks.get(outputIndex)
          if (open && open.kind === 'text') {
            yield {
              type: 'content_block_delta',
              index: open.anthropicIndex,
              delta: { type: 'text_delta', text: delta },
            }
          }
          continue
        }

        if (ev.type === 'response.reasoning_summary_text.delta' || ev.type === 'response.reasoning_text.delta') {
          const outputIndex = (ev as any).output_index as number
          const delta = (ev as any).delta as string
          const open = openBlocks.get(outputIndex)
          if (open && open.kind === 'thinking') {
            yield {
              type: 'content_block_delta',
              index: open.anthropicIndex,
              delta: { type: 'thinking_delta', thinking: delta },
            }
          }
          continue
        }

        if (ev.type === 'response.function_call_arguments.delta' || ev.type === 'response.custom_tool_call_input.delta') {
          const outputIndex = (ev as any).output_index as number
          const delta = (ev as any).delta as string
          const buf = toolCallBuffers.get(outputIndex)
          if (buf) buf.args += delta
          continue
        }

        if (ev.type === 'response.function_call_arguments.done' || ev.type === 'response.custom_tool_call_input.done') {
          const outputIndex = (ev as any).output_index as number
          const finalPayload = ((ev as any).arguments ?? (ev as any).input) as string
          const buf = toolCallBuffers.get(outputIndex)
          if (buf && typeof finalPayload === 'string') buf.args = finalPayload
          continue
        }

        if (ev.type === 'response.output_item.done') {
          const outputIndex = (ev as any).output_index as number

          // Close text / reasoning blocks on their output_index.
          const open = openBlocks.get(outputIndex)
          if (open && open.kind !== 'tool_use') {
            yield { type: 'content_block_stop', index: open.anthropicIndex }
            openBlocks.delete(outputIndex)
            continue
          }

          // Emit tool_use block for completed tool calls. We do this on
          // output_item.done rather than piece-by-piece so the tool_use
          // block has the full input at emission time (cleaner for the
          // outer claude.ts agent loop, which expects complete inputs).
          const buf = toolCallBuffers.get(outputIndex)
          if (!buf) continue

          const reg = getCodexRegistrationByNativeName(buf.name)
          const implId = reg?.implId ?? buf.name

          // Parse args. Function calls are JSON; custom tool calls are
          // raw text (apply_patch is the canonical example). We preserve
          // the raw text by wrapping it in a { patch: text } shape for
          // apply_patch specifically — matching the native schema.
          let input: Record<string, unknown>
          if (buf.isCustom) {
            input = buf.name === 'apply_patch'
              ? { patch: buf.args }
              : { input: buf.args }
          } else {
            try {
              input = buf.args ? JSON.parse(buf.args) : {}
            } catch {
              input = { _raw: buf.args }
            }
          }

          // Pass through the lane's adaptInput — apply_patch validates
          // the patch; others may rename fields.
          const adaptedInput = reg ? reg.adaptInput(input) : input

          const anthropicToolUseId = buf.callId.startsWith('toolu_')
            ? buf.callId
            : `toolu_codex_${buf.callId}`

          // Tool-use blocks MUST emit the three-event sequence so
          // claude.ts's accumulator picks up the args: content_block_start
          // with empty input + input_json_delta carrying the JSON string
          // + content_block_stop. Embedding `input` inline on start
          // leaves the accumulator at '' and every tool sees `{}`.
          yield {
            type: 'content_block_start',
            index: buf.anthropicIndex,
            content_block: {
              type: 'tool_use',
              id: anthropicToolUseId,
              name: implId,
              input: {},
            },
          }
          yield {
            type: 'content_block_delta',
            index: buf.anthropicIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(adaptedInput ?? {}),
            },
          }
          yield { type: 'content_block_stop', index: buf.anthropicIndex }
          toolCallBuffers.delete(outputIndex)
          continue
        }

        if (ev.type === 'response.completed') {
          const usage = (ev as any).response?.usage
          if (usage) {
            inputTokens = usage.input_tokens ?? inputTokens
            outputTokens = usage.output_tokens ?? outputTokens
            cachedInputTokens = usage.input_tokens_details?.cached_tokens ?? cachedInputTokens
            reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? reasoningTokens
          }
          break
        }

        if (ev.type === 'response.failed') {
          const errMessage = (ev as any).response?.error?.message ?? 'Responses API failed'
          if (!messageStartEmitted) {
            const mst = emitMessageStart()
            if (mst) yield mst
          }
          // Surface the error as a text block so the user sees why.
          const idx = nextBlockIndex++
          yield {
            type: 'content_block_start',
            index: idx,
            content_block: { type: 'text', text: '' },
          }
          yield {
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'text_delta', text: `Codex API error: ${errMessage}` },
          }
          yield { type: 'content_block_stop', index: idx }
          break
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal.aborted) {
        if (!messageStartEmitted) {
          const mst = emitMessageStart()
          if (mst) yield mst
        }
        // Keep the prompt_cache_key intact on abort. codex-rs does the
        // same — the cache key is conversation-scoped, not turn-scoped.
        // Rotating it here would cold-start the cache on the retry.
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: outputTokens,
            // OpenAI's input_tokens is total (fresh + cached). Anthropic
            // semantic expects fresh-only here; cached lives on its own
            // field. Subtract so cost / context-meter don't double-count.
            input_tokens: Math.max(0, inputTokens - cachedInputTokens),
            ...(cachedInputTokens > 0 && {
              cache_read_input_tokens: cachedInputTokens,
              cache_creation_input_tokens: 0,
            }),
          },
        }
        yield { type: 'message_stop' }
        return {
          input_tokens: Math.max(0, inputTokens - cachedInputTokens),
          output_tokens: outputTokens,
          cache_read_tokens: cachedInputTokens,
          cache_write_tokens: 0,
          thinking_tokens: reasoningTokens,
        }
      }
      if (!messageStartEmitted) {
        const mst = emitMessageStart()
        if (mst) yield mst
      }
      const idx = nextBlockIndex++
      yield {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'text', text: '' },
      }
      // Prompt-too-long errors must surface unwrapped so reactive-compact
      // recognizes them via the "Prompt is too long" prefix.
      const isPTL = (err as { isPromptTooLong?: boolean } | null)?.isPromptTooLong === true
      const errText = isPTL
        ? (err?.message ?? String(err))
        : `Codex API error: ${err?.message ?? String(err)}`
      yield {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'text_delta', text: errText },
      }
      yield { type: 'content_block_stop', index: idx }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: outputTokens,
          // OpenAI's input_tokens is total (fresh + cached). Anthropic
          // semantic expects fresh-only here; cached lives on its own
          // field. Subtract so cost / context-meter don't double-count.
          input_tokens: Math.max(0, inputTokens - cachedInputTokens),
          ...(cachedInputTokens > 0 && {
            cache_read_input_tokens: cachedInputTokens,
            cache_creation_input_tokens: 0,
          }),
        },
      }
      yield { type: 'message_stop' }
      return {
        input_tokens: Math.max(0, inputTokens - cachedInputTokens),
        output_tokens: outputTokens,
        cache_read_tokens: cachedInputTokens,
        cache_write_tokens: 0,
        thinking_tokens: reasoningTokens,
      }
    }

    // Ensure message_start was emitted for empty-response edge case.
    if (!messageStartEmitted) {
      const mst = emitMessageStart()
      if (mst) yield mst
    }

    // Close any still-open non-tool blocks (safety net).
    for (const [, open] of openBlocks) {
      if (open.kind !== 'tool_use') {
        yield { type: 'content_block_stop', index: open.anthropicIndex }
      }
    }

    const stopReason: 'tool_use' | 'end_turn' = emittedAnyToolUse ? 'tool_use' : 'end_turn'

    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: {
        output_tokens: outputTokens,
        // OpenAI's input_tokens is total (fresh + cached). Anthropic
        // semantic expects fresh-only here; cached lives on its own
        // field. Subtract so cost / context-meter don't double-count.
        input_tokens: Math.max(0, inputTokens - cachedInputTokens),
        ...(cachedInputTokens > 0 && {
          cache_read_input_tokens: cachedInputTokens,
          cache_creation_input_tokens: 0,
        }),
      },
    }
    yield { type: 'message_stop' }

    return {
      input_tokens: Math.max(0, inputTokens - cachedInputTokens),
      output_tokens: outputTokens,
      cache_read_tokens: cachedInputTokens,
      cache_write_tokens: 0,
      thinking_tokens: reasoningTokens,
    }
  }

  // ── Lane-owns-loop (Phase-2, not wired yet) ─────────────────────

  async *run(_context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    // Future Phase-2 work. For now the bridge calls streamAsProvider directly
    // and claude.ts owns the turn-orchestration loop.
    throw new Error('CodexLane.run (lane-owns-loop) is not wired yet — use streamAsProvider via LaneBackedProvider.')
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000, supportsToolCalling: true, tags: ['recommended', 'reasoning'] },
      { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 1050000, supportsToolCalling: true, tags: ['reasoning'] },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 272000, supportsToolCalling: true, tags: ['fast', 'reasoning'] },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', contextWindow: 272000, supportsToolCalling: true, tags: ['reasoning'] },
      { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 272000, supportsToolCalling: true, tags: ['reasoning'] },
      { id: 'gpt-5', name: 'GPT-5', contextWindow: 200000, supportsToolCalling: true, tags: ['reasoning'] },
      { id: 'gpt-5-codex', name: 'GPT-5 Codex', contextWindow: 200000, supportsToolCalling: true, tags: ['reasoning'] },
      { id: 'o3', name: 'o3', contextWindow: 200000, supportsToolCalling: true },
      { id: 'o4-mini', name: 'o4-mini', contextWindow: 200000, supportsToolCalling: true },
    ]
  }

  resolveModel(model: string): string {
    return model
  }

  smallFastModel(): string {
    // Matches codex-main's current small GPT-5 family model.
    return 'gpt-5.4-mini'
  }

  isHealthy(): boolean {
    return this._healthy
  }

  setHealthy(healthy: boolean): void {
    this._healthy = healthy
  }

  dispose(): void {
    codexApi.clearChain()
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

export function resolveReasoning(
  thinking: LaneProviderCallParams['thinking'] | undefined,
  model: string,
): CodexReasoningConfig | undefined {
  // Reasoning-capable families. GPT-5 and o-series accept reasoning; most
  // classic gpt-4.x variants don't. Default to 'medium' when we're sure,
  // otherwise omit (some endpoints 400 on unknown reasoning fields).
  const m = model.toLowerCase()
  const reasoningCapable =
    m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('o5') || m.startsWith('codex-')
  if (!reasoningCapable) return undefined

  if (isReasoningLevelExplicit()) {
    return { effort: getOpenAIReasoningLevel(), summary: 'auto' }
  }

  if (!thinking || thinking.type === 'disabled') return undefined

  if (thinking.type === 'adaptive') return { effort: 'medium', summary: 'auto' }
  const budget = (thinking as any).budget_tokens as number | undefined
  const effort: CodexReasoningConfig['effort'] =
    budget == null ? 'medium' : budget < 2000 ? 'low' : budget < 8000 ? 'medium' : 'high'
  return { effort, summary: 'auto' }
}

// Walk the conversation history and map each assistant tool_use.id to a
// call_id we'll use in the Responses API function_call_output items. The
// Anthropic tool_use.id is of the form `toolu_codex_<callId>` (set by
// this lane when it emitted the tool_use); strip the prefix to recover
// the original callId. Fall back to the id itself for history items
// from other lanes.
function buildToolUseIdToCallIdMap(
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) {
        const callId = block.id.startsWith('toolu_codex_')
          ? block.id.slice('toolu_codex_'.length)
          : block.id
        map.set(block.id, callId)
      }
    }
  }
  return map
}

function convertHistoryToCodex(
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
  toolUseIdToCallId: Map<string, string>,
): CodexInputItem[] {
  const out: CodexInputItem[] = []
  // Build a name lookup for tool_result → function_call_output name.
  const callIdToName = new Map<string, string>()

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      const contentPart: CodexContentPart = msg.role === 'assistant'
        ? { type: 'output_text', text: msg.content }
        : { type: 'input_text', text: msg.content }
      out.push({ type: 'message', role: msg.role, content: [contentPart] })
      continue
    }

    // Split the content blocks into message parts and tool-call items —
    // Responses API expects tool_use / function_call_output at the
    // top-level input array, not nested inside a message item.
    const textParts: CodexContentPart[] = []
    const tailItems: CodexInputItem[] = []

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            textParts.push(msg.role === 'assistant'
              ? { type: 'output_text', text: block.text }
              : { type: 'input_text', text: block.text })
          }
          break
        case 'tool_use': {
          if (!block.id || !block.name) break
          const callId = toolUseIdToCallId.get(block.id) ?? block.id
          // Assistant-emitted tool call. Look up the native name from the
          // registry (block.name is the shared impl id).
          const reg = CODEX_TOOL_REGISTRY.find(r => r.implId === block.name)
          const nativeName = reg?.nativeName ?? block.name
          callIdToName.set(callId, nativeName)
          if (nativeName === 'apply_patch') {
            // Custom tool — payload is a raw string (the patch body).
            const rawPatch = (block.input as any)?.patch ?? ''
            tailItems.push({
              type: 'custom_tool_call',
              call_id: callId,
              name: nativeName,
              input: typeof rawPatch === 'string' ? rawPatch : JSON.stringify(rawPatch),
            })
          } else {
            // Function tool — arguments are JSON-encoded.
            const nativeInput = reg ? inverseAdapt(reg.nativeName, block.input ?? {}) : (block.input ?? {})
            tailItems.push({
              type: 'function_call',
              call_id: callId,
              name: nativeName,
              arguments: JSON.stringify(nativeInput),
            })
          }
          break
        }
        case 'tool_result': {
          const id = block.tool_use_id ?? ''
          const callId = toolUseIdToCallId.get(id) ?? id
          const isCustom = callIdToName.get(callId) === 'apply_patch'
          const output = stringifyToolResultContent(block.content)
          tailItems.push(
            isCustom
              ? { type: 'custom_tool_call_output', call_id: callId, output }
              : { type: 'function_call_output', call_id: callId, output },
          )
          break
        }
        case 'thinking':
          // Preserve prior reasoning so the model sees its own thinking in
          // the conversation history. Codex's Responses API accepts this as
          // a `reasoning` input item.
          if (block.thinking) {
            tailItems.push({
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: block.thinking }],
            })
          }
          break
      }
    }

    if (textParts.length > 0) {
      out.push({ type: 'message', role: msg.role, content: textParts })
    }
    out.push(...tailItems)
  }

  return out
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content as any[]) {
      if (b && typeof b === 'object') {
        if ('text' in b && typeof b.text === 'string') parts.push(b.text)
        else parts.push(JSON.stringify(b))
      }
    }
    return parts.join('\n')
  }
  return JSON.stringify(content ?? '')
}

// Inverse of each native adaptInput. Most are identity; a couple diverge.
function inverseAdapt(nativeName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (nativeName) {
    case 'read_file':
      return input // Codex's read_file shape matches shared Read exactly.
    case 'search_code': {
      const out: Record<string, unknown> = { pattern: input.pattern }
      if (input.path != null) out.path = input.path
      if (input.glob != null) out.include = input.glob
      return out
    }
    default:
      return input
  }
}

// Build Responses API tools from the caller-provided Anthropic-format
// tool list. Tools that match the native registry get the native schema;
// unknown tools (MCP, custom) pass through as function tools with the
// caller's schema.
function buildCodexToolsFromRequest(
  tools: import('../../services/api/providers/base_provider.js').ProviderTool[],
): CodexResponsesRequest['tools'] {
  const out: NonNullable<CodexResponsesRequest['tools']> = []
  for (const tool of tools) {
    const reg = CODEX_TOOL_REGISTRY.find(r => r.implId === tool.name)
      ?? getCodexRegistrationByNativeName(tool.name)
    if (reg) {
      if (reg.nativeName === 'apply_patch') {
        // Freeform tools can't take `strict: true` — they aren't JSON.
        // apply_patch's Lark grammar is the enforcement mechanism.
        out.push({
          type: 'custom',
          name: 'apply_patch',
          description: reg.nativeDescription,
          format: { type: 'text' },
        })
      } else {
        // strict: true tells the Responses API to server-side-enforce
        // the JSON Schema (required fields + types) against the model's
        // function call — the OpenAI equivalent of Gemini VALIDATED
        // mode. Empty-args calls get rejected before they stream back.
        out.push({
          type: 'function',
          name: reg.nativeName,
          description: appendStrictParamsHint(reg.nativeDescription, reg.nativeSchema),
          parameters: reg.nativeSchema,
          strict: true,
        })
      }
    } else {
      // Unknown tool (MCP / custom) — sanitize through the shared bridge
      // with the Codex profile + append the STRICT PARAMETERS hint so
      // the model sees the required-field summary in plain text.
      const parameters = sanitizeSchemaForLane(
        tool.input_schema ?? { type: 'object', properties: {} },
        'codex',
      )
      out.push({
        type: 'function',
        name: tool.name,
        description: appendStrictParamsHint(tool.description ?? '', parameters),
        parameters,
        strict: true,
      })
    }
  }
  return out.length > 0 ? out : undefined
}

// ─── System-prompt stable / volatile split ───────────────────────
//
// Codex's `instructions` field gets hashed into the OpenAI prompt-cache
// prefix exactly like the leading `input` items do. When env / git /
// memory bytes leak into `instructions` they shift the prefix hash
// turn-to-turn, which is the dominant cause of "cache hits but is
// unstable" with heavy tool-call sessions or model swaps.
//
// claude.ts only inserts the explicit `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`
// marker when `shouldUseGlobalCacheScope()` is true (firstParty only),
// so the codex lane has to handle the no-marker case too. The fallback
// regex set is the same one battle-tested in
// `src/services/api/providers/gemini_provider.ts:splitSystemInstruction`
// — it keys off the env block, current date, git status, and recent
// commits/branch sections that claudex's prompt builder always emits at
// the tail when a marker is absent.

const CODEX_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

const CODEX_VOLATILE_PATTERNS: readonly RegExp[] = [
  /<env>[\s\S]*?<\/env>/,                 // computeEnvInfo block
  /# Environment\b[\s\S]*?(?=\n#|$)/,    // computeSimpleEnvInfo block
  /# currentDate\n[^\n]+/,                 // "Today's date is …"
  /# gitStatus\b[\s\S]*?(?=\n#|$)/,       // claude.ts gitStatus section
  /gitStatus:[\s\S]*?(?=\n\n|\n#|$)/,    // alt key form
  /Current branch:[\s\S]*?(?=\n\n|\n#|$)/, // recent commits + branch
]

export function splitCodexSystemForCache(text: string): {
  stable: string
  volatile: string
} {
  if (!text) return { stable: '', volatile: '' }

  // Primary path: explicit boundary marker (firstParty rollouts).
  const markerIdx = text.indexOf(CODEX_DYNAMIC_BOUNDARY)
  if (markerIdx >= 0) {
    return {
      stable: text.slice(0, markerIdx).replace(/\s+$/, ''),
      volatile: text.slice(markerIdx + CODEX_DYNAMIC_BOUNDARY.length).replace(/^\s+/, ''),
    }
  }

  // Fallback: pull known volatile chunks out of the tail. We only treat
  // a match as volatile if it lands in the last 30% of the text — the
  // dynamic sections are always appended at the end of the system
  // prompt, and we don't want to accidentally strip a tool description
  // that happens to contain the word "Environment".
  const cutoff = Math.floor(text.length * 0.7)
  const matches: Array<{ start: number; end: number; text: string }> = []
  for (const pattern of CODEX_VOLATILE_PATTERNS) {
    const m = text.match(pattern)
    if (m && m.index != null && m.index >= cutoff) {
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
    }
  }
  if (matches.length === 0) return { stable: text, volatile: '' }

  // Carve from the earliest match's start to end of text. Anything
  // between matches stays attached to the volatile tail — even if it
  // doesn't itself match a known pattern, it's downstream of dynamic
  // content and therefore can't be stable.
  matches.sort((a, b) => a.start - b.start)
  const cut = matches[0]!.start
  return {
    stable: text.slice(0, cut).replace(/\s+$/, ''),
    volatile: text.slice(cut).replace(/^\s+/, ''),
  }
}

function findLastUserMessageIndex(items: CodexInputItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'message' && it.role === 'user') return i
  }
  return -1
}

// ─── Singleton ───────────────────────────────────────────────────

export const codexLane = new CodexLane()
