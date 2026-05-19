/**
 * OpenAI-Compatible Lane — Agent Loop + Provider-Shim Entry
 *
 * Handles every provider that speaks OpenAI Chat Completions:
 *   - DeepSeek     (reasoner → `reasoning_content` → thinking; max_tokens 8192 cap)
 *   - Groq         (strip cache_control / $schema / null function_call; `reasoning` → thinking; fake_stream when JSON mode)
 *   - NVIDIA NIM   (strip stream_options; per-model param filtering)
 *   - Ollama       (no API key; Ollama-specific params; strip stream_options)
 *   - OpenRouter   (cache_control only for Claude / Gemini; relocate to last content block for 4-breakpoint Anthropic cap)
 *   - Mistral      (strip $id / $schema / additionalProperties / strict; tool_choice "required" → "any")
 *   - Generic long-tail (Fireworks, Together, Deepinfra, xAI, etc.)
 *
 * Per-provider quirks are consolidated in the transform helpers at the
 * bottom — adding a new provider is ~20 lines. The reference transformer
 * files this mirrors: claude-code-router/packages/core/src/transformer,
 * litellm/llms/<provider>/chat/transformation.py.
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  LaneProviderCallParams,
  NormalizedUsage,
} from '../types.js'
import { OPENAI_COMPAT_TOOL_REGISTRY, selectEditToolSet } from './tools.js'
import {
  appendStrictParamsHint,
  OPENAI_COMPAT_TOOL_USAGE_RULES,
} from '../shared/mcp_bridge.js'
import { getTransformer, type ProviderId } from './transformers/index.js'
import { resolveEditFormat } from './capabilities.js'
import {
  formatCopilotModelUnsupportedMessage,
  formatCopilotQuotaExceededMessage,
  isCopilotModelUnsupportedError,
  isCopilotQuotaExceededError,
} from '../../utils/model/copilotAccount.js'
import {
  toOpenRouterModelInfo,
  type OpenRouterCatalogModel,
} from '../../utils/model/openrouterCatalog.js'
import { isMoonshotThinkingModel } from '../../utils/model/moonshotCatalog.js'
import { recordProviderModelContextWindows } from '../../utils/model/contextWindows.js'

// ─── Provider Detection ──────────────────────────────────────────

type ProviderType =
  | 'deepseek'
  | 'groq'
  | 'glm'
  | 'moonshot'
  | 'minimax'
  | 'mistral'
  | 'nim'
  | 'ollama'
  | 'lmstudio'
  | 'openrouter'
  | 'agentrouter'
  | 'cline'
  | 'iflow'
  | 'kilocode'
  | 'copilot'
  | 'generic'

function detectProvider(model: string, baseUrl: string): ProviderType {
  const b = baseUrl.toLowerCase()
  const m = model.toLowerCase()
  if (b.includes('deepseek')) return 'deepseek'
  if (b.includes('bigmodel') || b.includes('zhipu')) return 'glm'
  if (b.includes('moonshot') || b.includes('kimi')) return 'moonshot'
  if (b.includes('minimax')) return 'minimax'
  if (b.includes('groq')) return 'groq'
  if (b.includes('mistral')) return 'mistral'
  if (b.includes('integrate.api.nvidia')) return 'nim'
  if (b.includes('lmstudio') || b.includes('lm-studio')) return 'lmstudio'
  if (b.includes('localhost') || b.includes('127.0.0.1') || b.includes('0.0.0.0') || b.includes(':11434')) return 'ollama'
  if (b.includes('agentrouter.org')) return 'agentrouter'
  if (b.includes('openrouter')) return 'openrouter'
  if (b.includes('cline.bot')) return 'cline'
  if (b.includes('iflow.cn') || b.includes('apis.iflow')) return 'iflow'
  if (b.includes('kilocode.ai') || b.includes('kilo.ai')) return 'kilocode'
  if (b.includes('githubcopilot.com')) return 'copilot'
  if (m.includes('deepseek')) return 'deepseek'
  if (m.startsWith('glm-')) return 'glm'
  if (m.startsWith('kimi-') || m.includes('moonshot')) return 'moonshot'
  if (m.startsWith('minimax-') || m.includes('minimax')) return 'minimax'
  if (m.startsWith('llama') || m.startsWith('mixtral') || m.startsWith('gemma')) return 'groq'
  if (m.startsWith('mistral-') || m.startsWith('magistral-') || m.startsWith('codestral-')) return 'mistral'
  // qwen removed — handled by the dedicated Qwen lane (src/lanes/qwen/).
  return 'generic'
}

function isLocalBaseUrl(baseUrl: string): boolean {
  const b = baseUrl.toLowerCase()
  return b.includes('localhost') || b.includes('127.0.0.1') || b.includes('0.0.0.0') || b.includes(':11434')
}

// ─── OpenAI Chat Completions Message Shape ───────────────────────

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null | Array<{ type: string; text?: string; image_url?: unknown; cache_control?: { type: string } }>
  reasoning_content?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
  // OpenRouter / DeepSeek reasoning fields come back on the delta; no input field.
}

interface OpenAIChatRequest {
  model: string
  messages: OpenAIChatMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  // Reasoning knobs — provider-specific. Passed through when supported.
  reasoning_effort?: 'low' | 'medium' | 'high'
  reasoning?: { effort?: string }
  thinking?: { type: 'enabled' } | { type: 'disabled' }
  extra_body?: Record<string, unknown>
  // OpenRouter extensions:
  transforms?: string[]
  models?: string[]
  route?: string
  prompt_cache_key?: string
  prompt_cache_retention?: '24h'
  /**
   * OpenRouter-native detailed-usage flag. When set, the gateway returns
   * cache_discount and per-breakpoint hit counts on the final stream
   * chunk so implicit-cache hits (DeepSeek, OpenAI gpt-5/4.1 on OR) are
   * actually visible in our usage parsing instead of looking like 0.
   */
  usage?: { include?: boolean }
}

interface CompatCatalogModel extends OpenRouterCatalogModel {
  owned_by?: string
  max_context_length?: number
  capabilities?: {
    completion_chat?: boolean
    function_calling?: boolean
    vision?: boolean
  }
}

interface LmStudioNativeModel {
  type?: string
  key?: string
  display_name?: string
  context_length?: number
  max_context_length?: number
  selected_variant?: string
  variants?: string[]
  loaded_instances?: Array<{
    id?: string
    config?: {
      context_length?: number
    }
  }>
  capabilities?: {
    trained_for_tool_use?: boolean
    vision?: boolean
  }
}

type LmStudioModelInfo = ModelInfo & {
  lmStudioAliases?: string[]
  lmStudioLoadedContextWindow?: number
  lmStudioMaxContextWindow?: number
}

// ─── Lane Implementation ─────────────────────────────────────────

export class OpenAICompatLane implements Lane {
  readonly name = 'openai-compat'
  readonly displayName = 'OpenAI-Compatible (DeepSeek, GLM, Moonshot, MiniMax, Groq, Mistral, NIM, Ollama, LM Studio, OpenRouter, ...)'

  private configs = new Map<string, { apiKey: string; baseUrl: string }>()
  private _healthy = true

  registerProvider(name: string, apiKey: string, baseUrl: string): void {
    this.configs.set(name, { apiKey, baseUrl })
    this.invalidateModelCache(name)
  }

  unregisterProvider(name: string): void {
    this.configs.delete(name)
    this.invalidateModelCache(name)
  }

  invalidateModelCache(providerFilter?: string): void {
    if (providerFilter) {
      _modelsCacheByProvider.delete(providerFilter)
      _modelsCacheByProvider.delete('__all__')
      return
    }
    _modelsCacheByProvider.clear()
  }

  private getConfigForModel(
    model: string,
    providerHint?: string,
  ): { apiKey: string; baseUrl: string; provider: ProviderType } | null {
    // Provider-selection wins. The shim was built for a specific
    // sub-provider (the user picked it from /models), and the same model
    // ID can live on multiple hosts (`openai/gpt-oss-120b` is on both
    // Groq and OpenRouter). When the hint names a registered config, use
    // it directly — don't fall through to the model-name heuristics.
    if (providerHint) {
      if (!this.configs.has(providerHint)) return null
      const c = this.configs.get(providerHint)!
      return { ...c, provider: providerHint as ProviderType }
    }

    const m = model.toLowerCase()

    // Explicit routing: model prefix → provider config
    if (m.includes('deepseek') && this.configs.has('deepseek')) {
      const c = this.configs.get('deepseek')!
      return { ...c, provider: 'deepseek' }
    }
    if (m.startsWith('glm-') && this.configs.has('glm')) {
      const c = this.configs.get('glm')!
      return { ...c, provider: 'glm' }
    }
    if ((m.startsWith('kimi-') || m.includes('moonshot')) && this.configs.has('moonshot')) {
      const c = this.configs.get('moonshot')!
      return { ...c, provider: 'moonshot' }
    }
    if ((m.startsWith('minimax-') || m.includes('minimax')) && this.configs.has('minimax')) {
      const c = this.configs.get('minimax')!
      return { ...c, provider: 'minimax' }
    }
    if ((m.startsWith('llama') || m.startsWith('mixtral') || m.startsWith('gemma')) && this.configs.has('groq')) {
      const c = this.configs.get('groq')!
      return { ...c, provider: 'groq' }
    }
    if ((m.startsWith('mistral-') || m.startsWith('magistral-') || m.startsWith('codestral-')) && this.configs.has('mistral')) {
      const c = this.configs.get('mistral')!
      return { ...c, provider: 'mistral' }
    }
    // Qwen routing moved to the dedicated Qwen lane. Compat never sees qwen-*.
    // `openai/gpt-oss-*` is intentionally NOT pinned to Groq here —
    // the same ID is hosted on both Groq and OpenRouter; the provider
    // hint above is the authoritative signal for picking one. This
    // slash-qualified fallback only fires when the hint didn't match
    // any registered config (e.g. a direct call without a shim).
    if (this.configs.has('openrouter') && m.includes('/')) {
      const c = this.configs.get('openrouter')!
      return { ...c, provider: 'openrouter' }
    }
    if (this.configs.has('nim') && this.configs.has('nim')) {
      const c = this.configs.get('nim')!
      return { ...c, provider: 'nim' }
    }
    if (this.configs.has('ollama')) {
      const c = this.configs.get('ollama')!
      return { ...c, provider: 'ollama' }
    }
    if (this.configs.has('lmstudio')) {
      const c = this.configs.get('lmstudio')!
      return { ...c, provider: 'lmstudio' }
    }
    // Fallback: first registered config.
    const first = this.configs.values().next().value
    if (!first) return null
    return { ...first, provider: detectProvider(model, first.baseUrl) }
  }

  supportsModel(model: string): boolean {
    const m = model.toLowerCase()
    // Everything that isn't Claude, Gemini, Qwen, or native OpenAI
    // (each handled by its own dedicated lane).
    return !(
      m.startsWith('claude-') || m.includes('anthropic') ||
      m.startsWith('gemini-') || m.startsWith('gemma-') ||
      m.startsWith('qwen') || m === 'coder-model' ||
      m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') ||
      m.startsWith('o4') || m.startsWith('o5') || m.startsWith('codex-') ||
      m.startsWith('gpt-5-codex')
    )
  }

  // ── Provider-shim-compatible single-turn entry ──────────────────

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, max_tokens, thinking, temperature, stop_sequences, signal, sessionId, providerHint } = params

    const cfg = this.getConfigForModel(model, providerHint)
    if (!cfg) {
      throw new Error(`No provider configured for model "${model}". Run /provider to connect a provider, or /models to pick a different model.`)
    }

    const provider = cfg.provider
    const isLocal = isLocalBaseUrl(cfg.baseUrl)
    const cacheSessionId =
      provider === 'copilot' || provider === 'openrouter' || provider === 'agentrouter' || provider === 'moonshot' || provider === 'mistral'
        ? sessionId
        : undefined

    // Assemble system text. We keep it simple for Phase-1 (caller's text).
    const rawSystemText = typeof system === 'string'
      ? system
      : (system ?? []).map(b => b.text).join('\n\n')

    // Per-model tool filter: small-tier models (e.g. Groq Llama on free
    // TPM) get a curated subset so the request fits the budget.
    const transformerForTools = getTransformer(provider as ProviderId)
    const filteredTools = transformerForTools.filterTools?.(model, tools) ?? tools

    // Tool conversion → OpenAI function tools with per-provider schema
    // cleanup (strip $schema / $id / additionalProperties / strict etc.).
    // Every function tool gets the STRICT PARAMETERS description hint,
    // plus function.strict: true when the provider honors it.
    const openaiTools = buildOpenAITools(filteredTools, provider)

    // Prepend OPENAI_COMPAT_TOOL_USAGE_RULES to the system message when
    // tools are present — in-context reminder of schema authority for
    // providers that don't enforce `strict: true` server-side (Mistral,
    // generic long-tail). Small-tier models (Groq Llama free TPM) can
    // opt out via `skipToolUsagePreamble` to save input tokens.
    const skipPreamble = transformerForTools.skipToolUsagePreamble?.(model) ?? false
    const systemText = openaiTools.length > 0 && !skipPreamble
      ? (rawSystemText
          ? `${OPENAI_COMPAT_TOOL_USAGE_RULES}\n${rawSystemText}`
          : OPENAI_COMPAT_TOOL_USAGE_RULES)
      : rawSystemText

    // History conversion → OpenAI Chat Completions messages.
    const chatMessages = convertHistoryToOpenAI(messages, systemText, provider, model)

    // Build request body with per-provider quirks applied.
    const body = applyProviderRequestQuirks(
      {
        model,
        messages: chatMessages,
        stream: true,
        stream_options: { include_usage: true },
        // OpenRouter / AgentRouter: surface detailed usage including
        // cache_discount. Mirrors the Kilo lane's body. Without this flag
        // the cache_read / cache_write fields aren't populated on those
        // gateways, which is what made every call look like a cold miss
        // even when the upstream actually had a cache hit.
        ...((provider === 'openrouter' || provider === 'agentrouter') && { usage: { include: true } }),
        // Ollama and LM Studio expose local OpenAI-compatible tool calling.
        // Keep generic localhost endpoints on the old gate unless they are
        // explicitly selected as one of these local providers.
        tools: openaiTools.length > 0 && (provider === 'ollama' || provider === 'lmstudio' || !isLocal) ? openaiTools : undefined,
        tool_choice: openaiTools.length > 0 && (provider === 'ollama' || provider === 'lmstudio' || !isLocal) ? 'auto' : undefined,
        max_tokens: clampMaxTokens(provider, max_tokens),
        temperature: temperature ?? (isLocal ? 0.7 : undefined),
        stop: stop_sequences?.length ? stop_sequences : undefined,
      },
      provider,
      thinking,
      cacheSessionId,
    )

    // Ollama branch: skip the OpenAI-compat /v1 path entirely and use
    // the native /api/chat endpoint so we can set num_ctx + keep_alive.
    // The /v1 shim ignores those, so the model runs at its default 4096
    // context (everything beyond gets truncated and prefilled fresh each
    // turn — that was the latency cancer). Other providers stay on /v1
    // unchanged.
    if (provider === 'ollama') {
      const ollamaUsage = yield* streamOllamaNative(cfg, body, model, signal)
      return ollamaUsage
    }

    // Headers per-provider.
    const headers = buildRequestHeaders(provider, cfg.apiKey, model, cacheSessionId)

    // Fire request.
    const url = normalizeBaseUrl(cfg.baseUrl) + '/chat/completions'

    const messageId = `compat-${Date.now()}`
    let messageStartEmitted = false
    let inputTokens = 0
    let outputTokens = 0
    let reportedCachedInputTokens = 0
    let cacheWriteTokens = 0
    let reasoningTokens = 0

    const cacheReadTokens = () =>
      cacheWriteTokens > 0
        ? Math.max(0, reportedCachedInputTokens - cacheWriteTokens)
        : reportedCachedInputTokens

    // Content-block state.
    let currentBlockIndex = 0
    let inTextBlock = false
    let inThinkingBlock = false
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string; anthropicIndex: number }>()
    let emittedAnyToolUse = false
    let emittedAnyAssistantOutput = false

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
            ...(cacheReadTokens() > 0 && { cache_read_input_tokens: cacheReadTokens() }),
            ...(cacheWriteTokens > 0 && { cache_creation_input_tokens: cacheWriteTokens }),
          },
        },
      }
    }

    if (provider === 'lmstudio') {
      const contextMessage = await getLmStudioContextPreflightMessage(cfg, model, body).catch(() => null)
      if (contextMessage) {
        const mst = emitMessageStart()
        if (mst) yield mst
        yield* emitErrorText(contextMessage)
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }
        yield { type: 'message_stop' }
        return blankUsage(inputTokens, outputTokens, cacheReadTokens(), reasoningTokens)
      }
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (err: any) {
      if (!messageStartEmitted) {
        const mst = emitMessageStart()
        if (mst) yield mst
      }
      const message = err?.message ?? String(err)
      const detail = provider === 'lmstudio'
        ? `LM Studio server unreachable at ${normalizeBaseUrl(cfg.baseUrl)} (${message}). Start the LM Studio local server and retry.`
        : message
      yield* emitErrorText(`${provider} API connection error: ${detail}`)
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }
      yield { type: 'message_stop' }
      return blankUsage(inputTokens, outputTokens, cacheReadTokens(), reasoningTokens)
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      if (!messageStartEmitted) {
        const mst = emitMessageStart()
        if (mst) yield mst
      }
      const isCopilotModelUnsupported =
        provider === 'copilot'
        && response.status === 400
        && isCopilotModelUnsupportedError(errText)
      const isCopilotQuotaExceeded =
        provider === 'copilot'
        && response.status === 402
        && isCopilotQuotaExceededError(errText)

      if (isCopilotModelUnsupported) {
        yield* emitErrorText(formatCopilotModelUnsupportedMessage(model))
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }
        yield { type: 'message_stop' }
        return blankUsage(inputTokens, outputTokens, cacheReadTokens(), reasoningTokens)
      }

      if (isCopilotQuotaExceeded) {
        yield* emitErrorText(formatCopilotQuotaExceededMessage())
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }
        yield { type: 'message_stop' }
        return blankUsage(inputTokens, outputTokens, cacheReadTokens(), reasoningTokens)
      }

      // Detect prompt-too-long / context-window-exceeded per the
      // transformer's known markers. Emit with the "Prompt is too long"
      // prefix claude.ts reactive-compact text-matches against —
      // otherwise Flash / smaller models 400 on oversized turns and
      // the user has to `/compact` manually.
      const transformer = getTransformer(provider as ProviderId)
      const markers = transformer.contextExceededMarkers()
      const lowered = errText.toLowerCase()
      const isPromptTooLong = markers.some(m => lowered.includes(m.toLowerCase()))
      yield* emitErrorText(formatProviderHttpError(provider, response.status, errText, isPromptTooLong))
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }
      yield { type: 'message_stop' }
      return blankUsage(inputTokens, outputTokens, cacheReadTokens(), reasoningTokens)
    }

    if (!response.body) {
      throw new Error('OpenAI-compat: empty response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      reading: while (true) {
        const { done, value } = await reader.read()
        if (!done) {
          buffer += decoder.decode(value, { stream: true })
        } else {
          buffer += decoder.decode()
        }

        const lines = buffer.split('\n')
        buffer = done ? '' : (lines.pop() ?? '')

        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line) continue
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') break reading
          if (!payload) continue

          let chunk: any
          try {
            chunk = JSON.parse(payload)
          } catch { continue }

          // Apply per-provider response normalization (reasoning field
          // renames etc.) so downstream IR emission is uniform.
          chunk = applyProviderResponseQuirks(chunk, provider)

          // Stream-level usage (present on final chunk for most providers).
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? inputTokens
            outputTokens = chunk.usage.completion_tokens ?? outputTokens
            reportedCachedInputTokens =
              chunk.usage.prompt_tokens_details?.cached_tokens
              ?? (provider === 'moonshot' ? chunk.usage.cached_tokens : undefined)
              ?? chunk.usage.prompt_cache_hit_tokens
              ?? reportedCachedInputTokens
            cacheWriteTokens =
              provider === 'copilot' || provider === 'openrouter' || provider === 'agentrouter'
                ? (
                    chunk.usage.prompt_tokens_details?.cache_write_tokens
                    ?? chunk.usage.cache_write_tokens
                    ?? cacheWriteTokens
                  )
                : 0
            reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens

            // AgentRouter forwards Anthropic responses verbatim, so the
            // usage block on Claude rows often arrives in Anthropic-native
            // shape: `cache_read_input_tokens` and
            // `cache_creation_input_tokens` are additive (separate from
            // each other and from `prompt_tokens`'s OpenAI total), not
            // the OpenAI subtractive `cached_tokens` (which already
            // includes writes). Without this fold we read 0 for both
            // and surface cache_hit=0% even when upstream is hitting
            // the cache hard — the smoking gun is the latency drop
            // without the percentage moving. Pure response read; does
            // not touch the outbound request shape.
            if (provider === 'agentrouter') {
              const arRead = typeof chunk.usage.cache_read_input_tokens === 'number'
                ? chunk.usage.cache_read_input_tokens
                : undefined
              const arWrite = typeof chunk.usage.cache_creation_input_tokens === 'number'
                ? chunk.usage.cache_creation_input_tokens
                : undefined
              if (arRead !== undefined || arWrite !== undefined) {
                // Re-encode into the OpenAI subtractive convention the rest
                // of the lane assumes: cached_total = read + write, and
                // cache_write is its own bucket.
                cacheWriteTokens = arWrite ?? 0
                reportedCachedInputTokens = (arRead ?? 0) + (arWrite ?? 0)
              }
            }
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue
          const delta = choice.delta ?? {}

          if (!messageStartEmitted && (delta.content || delta.tool_calls || delta.reasoning_content || delta.thinking)) {
            const mst = emitMessageStart()
            if (mst) yield mst
          }

          // Reasoning / thinking content. We normalize into a thinking
          // block that claude.ts can render. Providers disagree: some
          // stream reasoning_content (DeepSeek reasoner), some stream
          // reasoning (Groq / OpenRouter), some stream thinking (already
          // normalized).
          const thinkingDelta: string | undefined =
            delta.thinking ?? delta.reasoning_content ?? delta.reasoning
          if (typeof thinkingDelta === 'string' && thinkingDelta.length > 0) {
            emittedAnyAssistantOutput = true
            if (inTextBlock) {
              yield { type: 'content_block_stop', index: currentBlockIndex }
              currentBlockIndex++
              inTextBlock = false
            }
            if (!inThinkingBlock) {
              yield {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: { type: 'thinking', thinking: '' },
              }
              inThinkingBlock = true
            }
            yield {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'thinking_delta', thinking: thinkingDelta },
            }
          }

          // Text content.
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            emittedAnyAssistantOutput = true
            if (inThinkingBlock) {
              yield { type: 'content_block_stop', index: currentBlockIndex }
              currentBlockIndex++
              inThinkingBlock = false
            }
            if (!inTextBlock) {
              yield {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              inTextBlock = true
            }
            yield {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'text_delta', text: delta.content },
            }
          }

          // Tool-call deltas. OpenAI-style tool_calls arrive piece-by-piece
          // indexed by position. We accumulate args until finish_reason
          // signals completion.
          if (Array.isArray(delta.tool_calls)) {
            if (delta.tool_calls.length > 0) emittedAnyAssistantOutput = true
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              let buf = toolCallBuffers.get(idx)
              if (!buf) {
                // Close any currently-open text/thinking block.
                if (inTextBlock || inThinkingBlock) {
                  yield { type: 'content_block_stop', index: currentBlockIndex }
                  currentBlockIndex++
                  inTextBlock = false
                  inThinkingBlock = false
                }
                buf = {
                  id: tc.id ?? `call_${idx}`,
                  name: tc.function?.name ?? '',
                  args: '',
                  anthropicIndex: currentBlockIndex,
                }
                currentBlockIndex++
                toolCallBuffers.set(idx, buf)
                emittedAnyToolUse = true
              }
              if (tc.id) buf.id = tc.id
              if (tc.function?.name) buf.name = tc.function.name
              if (typeof tc.function?.arguments === 'string') buf.args += tc.function.arguments
            }
          }

          // finish_reason signals completion of this choice's output.
          const finishReason = choice.finish_reason
          if (finishReason) {
            // Close open text / thinking blocks.
            if (inTextBlock || inThinkingBlock) {
              yield { type: 'content_block_stop', index: currentBlockIndex }
              inTextBlock = false
              inThinkingBlock = false
            }

            // Emit final tool_use blocks with the accumulated arguments.
            for (const buf of toolCallBuffers.values()) {
              const implId = normalizeToolName(buf.name)
              let input: Record<string, unknown>
              try {
                input = buf.args ? JSON.parse(buf.args) : {}
              } catch {
                input = { _raw: buf.args }
              }
              const anthropicToolUseId = buf.id.startsWith('toolu_') ? buf.id : `toolu_compat_${buf.id}`
              // Three-event sequence: start (empty input) + input_json_delta
              // (args as JSON string) + stop. claude.ts's accumulator reads
              // partial_json, not the inline input field — inline input gets
              // dropped and every tool sees `{}`.
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
                  partial_json: JSON.stringify(input ?? {}),
                },
              }
              yield { type: 'content_block_stop', index: buf.anthropicIndex }
            }
            toolCallBuffers.clear()
          }
        }

        if (done) break
      }
    } finally {
      reader.releaseLock()
    }

    if (provider === 'lmstudio' && !emittedAnyAssistantOutput) {
      const fallback = await fetchLmStudioNonStreamingCompletion(cfg, body, model, signal).catch(() => null)
      const textOnlyFallback = !fallback?.text?.trim() && !fallback?.thinking?.trim() && !(fallback?.toolCalls?.length)
        ? await fetchLmStudioNonStreamingCompletion(cfg, body, model, signal, true).catch(() => null)
        : null
      const recovered = textOnlyFallback ?? fallback
      const fallbackText = recovered?.text?.trim()
      const fallbackThinking = recovered?.thinking?.trim()
      const fallbackToolCalls = recovered?.toolCalls ?? []
      if (fallbackText || fallbackThinking || fallbackToolCalls.length > 0) {
        inputTokens = recovered?.usage?.prompt_tokens ?? inputTokens
        outputTokens = recovered?.usage?.completion_tokens ?? outputTokens
        reasoningTokens = recovered?.usage?.completion_tokens_details?.reasoning_tokens ?? reasoningTokens

        if (!messageStartEmitted) {
          const mst = emitMessageStart()
          if (mst) yield mst
        }

        if (fallbackThinking) {
          yield {
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: { type: 'thinking', thinking: '' },
          }
          yield {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'thinking_delta', thinking: fallbackThinking },
          }
          yield { type: 'content_block_stop', index: currentBlockIndex }
          currentBlockIndex++
        }

        if (fallbackText) {
          yield {
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: { type: 'text', text: '' },
          }
          yield {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'text_delta', text: fallbackText },
          }
          yield { type: 'content_block_stop', index: currentBlockIndex }
          currentBlockIndex++
        }

        for (const toolCall of fallbackToolCalls) {
          const toolName = toolCall.function?.name
          if (!toolName) continue
          const implId = normalizeToolName(toolName)
          let input: Record<string, unknown>
          try {
            input = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {}
          } catch {
            input = { _raw: toolCall.function?.arguments ?? '' }
          }
          const toolId = toolCall.id?.startsWith('toolu_') ? toolCall.id : `toolu_compat_${toolCall.id ?? `lmstudio_${currentBlockIndex}`}`
          yield {
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: {
              type: 'tool_use',
              id: toolId,
              name: implId,
              input: {},
            },
          }
          yield {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(input ?? {}),
            },
          }
          yield { type: 'content_block_stop', index: currentBlockIndex }
          currentBlockIndex++
          emittedAnyToolUse = true
        }

        const stopReason: 'tool_use' | 'end_turn' = emittedAnyToolUse ? 'tool_use' : 'end_turn'
        yield {
          type: 'message_delta',
          delta: { stop_reason: stopReason },
          usage: {
            output_tokens: outputTokens,
            input_tokens: inputTokens,
          },
        }
        yield { type: 'message_stop' }
        return blankUsage(inputTokens, outputTokens, cacheReadTokens(), reasoningTokens)
      }

      if (!signal?.aborted) {
        if (!messageStartEmitted) {
          const mst = emitMessageStart()
          if (mst) yield mst
        }
        const contextMessage = await getLmStudioContextPreflightMessage(cfg, model, body).catch(() => null)
        yield* emitErrorText(contextMessage ?? 'LM Studio returned an empty response. Check LM Studio logs for the selected local model and retry.')
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }
        yield { type: 'message_stop' }
        return blankUsage(inputTokens, outputTokens, cacheReadTokens(), reasoningTokens)
      }
    }

    if (!messageStartEmitted) {
      const mst = emitMessageStart()
      if (mst) yield mst
    }

    const stopReason: 'tool_use' | 'end_turn' = emittedAnyToolUse ? 'tool_use' : 'end_turn'
    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: {
        output_tokens: outputTokens,
        // OpenAI-style `prompt_tokens` is total (fresh + cached). Split
        // into fresh + cache_read to match Anthropic's additive buckets.
        input_tokens: Math.max(0, inputTokens - cacheReadTokens() - cacheWriteTokens),
        ...(cacheReadTokens() > 0 && { cache_read_input_tokens: cacheReadTokens() }),
        ...(cacheWriteTokens > 0 && { cache_creation_input_tokens: cacheWriteTokens }),
      },
    }
    yield { type: 'message_stop' }

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens(),
      cache_write_tokens: cacheWriteTokens,
      thinking_tokens: reasoningTokens,
    }
  }

  // ── Lane-owns-loop (Phase-2, not wired yet) ─────────────────────

  async *run(_context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    throw new Error('OpenAICompatLane.run (lane-owns-loop) is not wired yet — use streamAsProvider via LaneBackedProvider.')
  }

  async listModels(providerFilter?: string): Promise<ModelInfo[]> {
    // Query /v1/models on every configured provider in parallel, cache
    // per-provider for 5 minutes. Errors on individual providers don't
    // block the rest — a slow Ollama install shouldn't delay Groq's list.
    //
    // When `providerFilter` is given, only that sub-provider is queried
    // and returned, so /models groq only shows Groq models (not the
    // union of every compat provider's catalog).
    const now = Date.now()
    const cacheKey = providerFilter ?? '__all__'
    const cached = _modelsCacheByProvider.get(cacheKey)
    if (cached && now - cached.at < MODELS_CACHE_TTL_MS) {
      return cached.models
    }
    const entries = Array.from(this.configs.entries())
      .filter(([name]) => !providerFilter || name === providerFilter)
    const results = await Promise.allSettled(entries.map(async ([providerName, cfg]) => {
      if (providerName === 'lmstudio') {
        const openAIModels = await listLmStudioOpenAIModels(cfg)
        if (openAIModels.length > 0) return openAIModels
        const nativeModels = await listLmStudioNativeModels(cfg)
        if (nativeModels.length > 0) return nativeModels
      }

      const transformer = getTransformer(providerName as ProviderId)
      // Most compat providers either want a fully-curated catalog or a
      // direct pass-through from `/models`. Copilot is the main exception:
      // its live catalog changes often enough that we want fresh data, but
      // still need a fallback when `/models` is unavailable.
      const fixed = transformer.staticCatalog?.() ?? []
      const preferLiveCatalog = transformer.preferLiveModelCatalog?.() ?? false
      if (!preferLiveCatalog && fixed.length > 0) return fixed
      try {
        const url = `${normalizeBaseUrl(cfg.baseUrl)}/models`
        const headers: Record<string, string> = { 'Accept': 'application/json' }
        if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
        const extra = transformer.buildHeaders?.(cfg.apiKey) ?? {}
        for (const [k, v] of Object.entries(extra)) {
          // Reuse provider-specific auth/catalog headers (e.g. Copilot's
          // editor-version / integration-id) but keep the GET request's
          // Accept as JSON rather than the streaming default.
          if (k.toLowerCase() === 'accept') continue
          headers[k] = v
        }
        const resp = await fetch(url, { headers, method: 'GET' })
        if (resp.ok) {
          const data = await resp.json() as { data?: CompatCatalogModel[] }
          const raw = (data.data ?? [])
            .map(m => toCompatCatalogModel(providerName, m))
            .filter((model): model is ModelInfo => model !== null)
          // Per-provider catalog filter: e.g. Groq hides whisper/preview
          // models so `/models` only shows chat-capable production IDs.
          const filtered = transformer.filterModelCatalog?.(raw) ?? raw
          if (filtered.length > 0) return filtered
        }
      } catch {
        // Fall back to the curated list below.
      }
      return fixed
    }))
    const out: ModelInfo[] = []
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      // filterModelCatalog declares `name?: string` so the union with
      // staticCatalog widens; backfill from id when the upstream omitted it.
      for (const m of r.value) out.push({ ...m, name: m.name ?? m.id })
    }
    const hasIncompleteLmStudioContext =
      providerFilter === 'lmstudio'
      && out.length > 0
      && out.some(model => typeof model.contextWindow !== 'number' || model.contextWindow <= 0)
    if (!hasIncompleteLmStudioContext) {
      _modelsCacheByProvider.set(cacheKey, { models: out, at: now })
    }
    return out
  }

  resolveModel(model: string): string {
    return model
  }

  smallFastModel(): string | null {
    // Compat lane: no universal fast model — provider-specific hints
    // live in each transformer. The caller passes the currently-
    // configured model to resolveSmallFastModel() below to get a
    // provider-appropriate fast model when present.
    return null
  }

  isHealthy(): boolean {
    return this._healthy
  }

  setHealthy(healthy: boolean): void {
    this._healthy = healthy
  }

  dispose(): void {}
}

function toCompatCatalogModel(
  providerName: string,
  model: CompatCatalogModel,
): ModelInfo | null {
  if (providerName === 'openrouter') {
    return toOpenRouterModelInfo(model)
  }

  if (providerName === 'mistral') {
    return toMistralCatalogModel(model)
  }

  if (typeof model.id !== 'string' || model.id.length === 0) {
    return null
  }

  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name.length > 0
      ? model.name
      : model.id,
    contextWindow: model.context_length,
    ...(typeof model.owned_by === 'string' && model.owned_by.length > 0
      ? { provider: model.owned_by }
      : {}),
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

// ─── Per-lane /v1/models cache ────────────────────────────────────
// Keyed by provider filter so `/models groq` doesn't share state with
// `/models openrouter`. Unfiltered calls use the `__all__` key.

const _modelsCacheByProvider = new Map<string, { models: ModelInfo[]; at: number }>()
const MODELS_CACHE_TTL_MS = 5 * 60_000

/**
 * Resolve a small/fast model for a given main-loop model by delegating
 * to the appropriate transformer. Exported so session-title /
 * tool-use-summary callers can request the cheaper model per-provider.
 */
export function resolveCompatSmallFastModel(
  provider: ProviderType,
  model: string,
): string | null {
  return getTransformer(provider as ProviderId).smallFastModel(model)
}

function blankUsage(i: number, o: number, c: number, r: number): NormalizedUsage {
  return {
    input_tokens: i,
    output_tokens: o,
    cache_read_tokens: c,
    cache_write_tokens: 0,
    thinking_tokens: r,
  }
}

function* emitErrorText(text: string): Generator<AnthropicStreamEvent> {
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
}

interface ProviderErrorPayload {
  code?: string
  message?: string
}

function formatProviderHttpError(
  provider: ProviderType,
  status: number,
  errText: string,
  isPromptTooLong: boolean,
): string {
  if (provider === 'glm') {
    return formatGlmHttpError(status, errText, isPromptTooLong)
  }
  const headline = isPromptTooLong
    ? `Prompt is too long (${provider} ${status})`
    : `${provider} API error ${status}`
  return `${headline}: ${errText.slice(0, 500)}`
}

function formatGlmHttpError(
  status: number,
  errText: string,
  isPromptTooLong: boolean,
): string {
  if (isPromptTooLong) {
    return `Prompt is too long (glm ${status})`
  }

  const parsed = parseProviderErrorPayload(errText)
  const code = parsed?.code
  const detail = parsed?.message ?? errText.trim()
  const isInsufficientBalance =
    status === 429 &&
    (code === '1113' ||
      /余额不足|无可用资源包|请充值|\binsufficient\b|\bbalance\b|\bquota\b|\bresource package\b/i.test(
        detail,
      ))

  if (isInsufficientBalance) {
    return [
      `glm API error ${status}: BigModel balance is insufficient or no resource package is available.`,
      'Open /usage for BigModel links, recharge the account, or switch provider/model with /models.',
    ].join(' ')
  }

  const suffix = code ? ` (${code})` : ''
  const text = detail || errText
  return `glm API error ${status}${suffix}: ${text.slice(0, 500)}`
}

function parseProviderErrorPayload(raw: string): ProviderErrorPayload | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return null
    const root = value as Record<string, unknown>
    const error =
      root.error && typeof root.error === 'object'
        ? root.error as Record<string, unknown>
        : root
    const code = error.code
    const message = error.message
    return {
      code: typeof code === 'string' || typeof code === 'number' ? String(code) : undefined,
      message: typeof message === 'string' ? message : undefined,
    }
  } catch {
    return null
  }
}

function toMistralCatalogModel(model: CompatCatalogModel): ModelInfo | null {
  if (typeof model.id !== 'string' || model.id.length === 0) {
    return null
  }

  const capabilities = model.capabilities
  if (capabilities?.completion_chat === false) {
    return null
  }

  const tags: string[] = []
  if (capabilities?.function_calling === true) tags.push('tools')
  if (isMistralReasoningModelId(model.id)) tags.push('reasoning')

  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name.length > 0
      ? model.name
      : model.id,
    contextWindow: model.max_context_length ?? model.context_length,
    supportsToolCalling: capabilities?.function_calling,
    tags: tags.length > 0 ? tags : undefined,
    ...(typeof model.owned_by === 'string' && model.owned_by.length > 0
      ? { provider: model.owned_by }
      : { provider: 'Mistral' }),
  }
}

function isMistralReasoningModelId(modelId: string): boolean {
  const m = modelId.toLowerCase()
  return (
    m.includes('magistral') ||
    m.startsWith('mistral-small') ||
    m === 'mistral-medium-3-5' ||
    m === 'mistral-medium-latest'
  )
}

async function listLmStudioNativeModels(
  cfg: { apiKey: string; baseUrl: string },
): Promise<LmStudioModelInfo[]> {
  const url = `${lmStudioServerRoot(cfg.baseUrl)}/api/v1/models`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    try {
      const resp = await fetch(url, { headers, method: 'GET', signal: controller.signal })
      if (!resp.ok) continue
      const data = await resp.json() as { models?: LmStudioNativeModel[] }
      const models = (data.models ?? [])
        .map(toLmStudioNativeModelInfo)
        .filter((model): model is LmStudioModelInfo => model !== null)
      if (models.length > 0) {
        recordProviderModelContextWindows('lmstudio', models)
        return models
      }
    } catch {
      // Retry once. LM Studio can briefly reject metadata requests while
      // loading or swapping a local model.
    } finally {
      clearTimeout(timeout)
    }
  }
  return []
}

async function getLmStudioContextPreflightMessage(
  cfg: { apiKey: string; baseUrl: string },
  model: string,
  body: OpenAIChatRequest,
): Promise<string | null> {
  const info = await getLmStudioModelInfo(cfg, model)
  const loadedContextWindow = info?.lmStudioLoadedContextWindow
  if (!loadedContextWindow || loadedContextWindow <= 0) return null

  const estimatedInputTokens = estimateOpenAICompatRequestTokens(body)
  if (estimatedInputTokens < loadedContextWindow) return null

  const maxContextWindow = info.lmStudioMaxContextWindow ?? info.contextWindow
  const suggestedContextWindow = maxContextWindow
    ? Math.min(
        maxContextWindow,
        roundUpToMultiple(estimatedInputTokens + 4096, 8192),
      )
    : undefined
  const reloadHint = suggestedContextWindow && suggestedContextWindow > loadedContextWindow
    ? ` Reload it with a larger context, for example: lms unload "${model}"; lms load "${model}" -c ${suggestedContextWindow} -y --identifier "${model}".`
    : ''

  return `LM Studio has "${model}" loaded with ${formatTokenCount(loadedContextWindow)} context tokens, but Tau's agent request is about ${formatTokenCount(estimatedInputTokens)} tokens before generation. LM Studio can return an empty response in that state.${maxContextWindow ? ` This model reports up to ${formatTokenCount(maxContextWindow)} tokens available.` : ''}${reloadHint}`
}

async function getLmStudioModelInfo(
  cfg: { apiKey: string; baseUrl: string },
  modelId: string,
): Promise<LmStudioModelInfo | null> {
  const models = await listLmStudioNativeModels(cfg)
  const byId = new Map<string, LmStudioModelInfo>()
  for (const model of models) {
    byId.set(model.id, model)
    for (const alias of model.lmStudioAliases ?? []) byId.set(alias, model)
  }
  return byId.get(modelId) ?? null
}

function estimateOpenAICompatRequestTokens(body: OpenAIChatRequest): number {
  const messageChars = JSON.stringify(body.messages).length
  const toolChars = body.tools ? JSON.stringify(body.tools).length : 0
  return Math.ceil((messageChars + toolChars) / 4)
}

function roundUpToMultiple(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple
}

function formatTokenCount(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

async function fetchLmStudioNonStreamingCompletion(
  cfg: { apiKey: string; baseUrl: string },
  body: OpenAIChatRequest,
  model: string,
  signal?: AbortSignal,
  textOnly = false,
): Promise<{
  text?: string
  thinking?: string
  toolCalls?: NonNullable<OpenAIChatMessage['tool_calls']>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
} | null> {
  const headers = buildRequestHeaders('lmstudio', cfg.apiKey, model)
  const fallbackBody: OpenAIChatRequest = { ...body, stream: false }
  delete fallbackBody.stream_options
  if (textOnly) {
    delete fallbackBody.tools
    fallbackBody.tool_choice = 'none'
  }
  fallbackBody.thinking = { type: 'disabled' }

  const resp = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(fallbackBody),
    signal,
  })
  if (!resp.ok) return null

  const data = await resp.json() as {
    choices?: Array<{
      message?: {
        content?: string | null
        reasoning_content?: string
        reasoning?: string
        thinking?: string
        tool_calls?: NonNullable<OpenAIChatMessage['tool_calls']>
      }
    }>
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      completion_tokens_details?: { reasoning_tokens?: number }
    }
  }
  const message = data.choices?.[0]?.message
  if (!message) return null
  return {
    text: typeof message.content === 'string' ? message.content : undefined,
    thinking: message.thinking ?? message.reasoning_content ?? message.reasoning,
    toolCalls: message.tool_calls,
    usage: data.usage,
  }
}

async function listLmStudioOpenAIModels(
  cfg: { apiKey: string; baseUrl: string },
): Promise<ModelInfo[]> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
    const resp = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/models`, {
      headers,
      method: 'GET',
    })
    if (!resp.ok) return []
    const data = await resp.json() as { data?: CompatCatalogModel[] }
    const openAIModels = (data.data ?? [])
      .map(model => toCompatCatalogModel('lmstudio', model))
      .filter((model): model is ModelInfo => model !== null)
      .filter(model => !looksLikeEmbeddingModel(model.id))

    const nativeModels = await listLmStudioNativeModels(cfg)
    if (nativeModels.length === 0) return openAIModels

    const nativeById = new Map<string, ModelInfo>()
    for (const model of nativeModels) {
      nativeById.set(model.id, model)
      const variantIds = (model as ModelInfo & { lmStudioAliases?: string[] }).lmStudioAliases ?? []
      for (const alias of variantIds) nativeById.set(alias, model)
    }
    const enriched = openAIModels
      .filter(model => nativeById.has(model.id))
      .map(model => {
        const native = nativeById.get(model.id)
        return {
          ...model,
          ...(native ?? {}),
          id: model.id,
        }
      })
    return enriched.length > 0 ? enriched : openAIModels
  } catch {
    return []
  }
}

function toLmStudioNativeModelInfo(model: LmStudioNativeModel): LmStudioModelInfo | null {
  if (model.type && model.type !== 'llm') return null
  if (typeof model.key !== 'string' || model.key.length === 0) return null

  const loaded =
    model.loaded_instances?.find(instance =>
      instance.id === model.key || instance.id?.startsWith(`${model.key}@`),
    )
    ?? model.loaded_instances?.[0]
  const contextWindow =
    model.max_context_length
    ?? model.context_length
    ?? loaded?.config?.context_length
    ?? undefined
  const loadedContextWindow = loaded?.config?.context_length
  const aliases = [
    ...(model.selected_variant ? [model.selected_variant] : []),
    ...(model.variants ?? []),
    ...(model.loaded_instances ?? []).map(instance => instance.id).filter((id): id is string => typeof id === 'string' && id.length > 0),
  ]

  return {
    id: model.key,
    name: typeof model.display_name === 'string' && model.display_name.length > 0
      ? model.display_name
      : model.key,
    ...(contextWindow ? { contextWindow } : {}),
    ...(loadedContextWindow ? { lmStudioLoadedContextWindow: loadedContextWindow } : {}),
    ...(model.max_context_length ? { lmStudioMaxContextWindow: model.max_context_length } : {}),
    ...(typeof model.capabilities?.trained_for_tool_use === 'boolean'
      ? { supportsToolCalling: model.capabilities.trained_for_tool_use }
      : {}),
    ...(aliases.length > 0 ? { lmStudioAliases: aliases } : {}),
    provider: 'LM Studio',
  }
}

function looksLikeEmbeddingModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase()
  return normalized.includes('embedding') || normalized.includes('embed')
}

function lmStudioServerRoot(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/(?:api\/)?v1$/i, '')
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function buildRequestHeaders(
  provider: ProviderType,
  apiKey: string,
  model: string,
  sessionId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  // Delegate provider-specific header additions (e.g. OpenRouter's
  // HTTP-Referer) to the transformer. Adding a new provider = one
  // buildHeaders() method in its transformer file.
  const transformer = getTransformer(provider as ProviderId)
  const extra = transformer.buildHeaders?.(apiKey, { model, sessionId }) ?? {}
  for (const [k, v] of Object.entries(extra)) headers[k] = v
  return headers
}

function normalizeToolName(rawName: string): string {
  // Tool name arrives as whatever the model called. If it matches a native
  // entry in the registry, map to shared impl id. Otherwise pass through.
  const reg = OPENAI_COMPAT_TOOL_REGISTRY.find(r => r.nativeName === rawName)
  return reg?.implId ?? rawName
}

function clampMaxTokens(provider: ProviderType, requested: number): number {
  // Per-provider ceilings live in each transformer (e.g. DeepSeek 8192).
  return getTransformer(provider as ProviderId).clampMaxTokens(requested)
}

// ─── Per-Provider Request Quirks ─────────────────────────────────
//
// Consolidates the transformations the reference transformers do. Each
// quirk has a brief comment explaining *why* (usually: a specific error
// the provider returns on non-compliant requests).

function applyProviderRequestQuirks(
  body: OpenAIChatRequest,
  provider: ProviderType,
  thinking: LaneProviderCallParams['thinking'] | undefined,
  sessionId?: string,
): OpenAIChatRequest {
  const transformer = getTransformer(provider as ProviderId)
  const isReasoning = !!(thinking && thinking.type !== 'disabled')
  const effort = resolveReasoningEffort(thinking) ?? null

  // Cache-control placement per-transformer: strip when the provider
  // doesn't honor it (DeepSeek, Groq, Mistral, NIM, Ollama, generic);
  // pass through for OpenRouter (its upstream relocates for Anthropic
  // cap compliance automatically).
  const cacheMode = transformer.cacheControlMode(body.model)
  if (cacheMode === 'none') {
    body.messages = body.messages.map(stripCacheControlFromMessage)
  } else if (cacheMode === 'last-only') {
    // Apply Anthropic's 4-breakpoint rolling cache (one for system, two
    // for the trailing user/tool messages). Without this OpenRouter ships
    // a request without a single cache_control marker, Anthropic upstream
    // never sees the prefix anchor, and every turn is billed as a cold
    // write — the user-visible "unstable cache hit" symptom. After the
    // cold write, the system breakpoint anchors a deep read and the two
    // rolling user breakpoints extend it to the latest tool result, so
    // subsequent turns hit ~100% of the prefix.
    applyLastOnlyCacheBreakpoints(body.messages)
  }

  // Let the transformer apply its provider-specific quirks. Every
  // provider implements this; adding a new one = one new file.
  transformer.transformRequest(body, {
    model: body.model,
    isReasoning,
    reasoningEffort: effort,
    sessionId,
  })

  // Groq rejects null-valued `function_call` on assistant messages;
  // always strip null tool_calls regardless of provider (the cost of
  // doing it uniformly is < 1ms, the risk of missing it per-provider
  // is a subtle 400 on certain replay flows).
  body.messages = body.messages.map(stripNullToolCall)

  // Remove undefined fields — many providers 400 on explicit `null` on
  // optional fields they don't recognize.
  const bag = body as unknown as Record<string, unknown>
  for (const k of Object.keys(bag)) {
    if (bag[k] === undefined) delete bag[k]
  }

  return body
}

function resolveReasoningEffort(
  thinking: LaneProviderCallParams['thinking'] | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (!thinking || thinking.type === 'disabled') return undefined
  if (thinking.type === 'adaptive') return 'medium'
  const budget = (thinking as any).budget_tokens as number | undefined
  if (budget == null) return 'medium'
  if (budget < 2000) return 'low'
  if (budget < 8000) return 'medium'
  return 'high'
}

function stripCacheControlFromMessage(m: OpenAIChatMessage): OpenAIChatMessage {
  if (!m.content || typeof m.content === 'string') return m
  const cleanedContent = m.content.map(part => {
    if (typeof part !== 'object' || part === null) return part
    const { cache_control: _cc, ...rest } = part as any
    return rest
  })
  return { ...m, content: cleanedContent as any }
}

/**
 * Anthropic-via-OpenRouter rolling cache: stamp ephemeral cache_control on
 * the last text block of the system message and the last two non-system
 * user/tool messages. Mirrors the Kilo lane's _applyCacheBreakpoints and
 * the strategy native Kilo CLI uses (`slice(-2)` rolling).
 *
 * Three breakpoints (system + 2 trailing) is the sweet spot for
 * Anthropic's 4-breakpoint cap: turn N's trailing breakpoint becomes
 * turn N+1's deep cache anchor, so the cached prefix walks forward
 * with the conversation instead of resetting to the system block. The
 * fourth breakpoint is intentionally left unused so OpenRouter has
 * headroom if it inserts its own (it doesn't today, but nothing in the
 * docs guarantees it won't).
 *
 * String content gets promoted to a single-element parts array so the
 * marker has somewhere to land. Empty tool results fall back to ' ' so
 * the part is well-formed without altering visible prompt content.
 *
 * Idempotent: existing markers are left untouched, so a SystemBlock that
 * arrived with cache_control already set isn't re-stamped.
 */
function applyLastOnlyCacheBreakpoints(messages: OpenAIChatMessage[]): void {
  const stampLast = (parts: Array<{ type: string; text?: string; cache_control?: { type: string } }>): void => {
    if (parts.length === 0) return
    const last = parts[parts.length - 1]
    if (last && last.type === 'text' && !last.cache_control) {
      last.cache_control = { type: 'ephemeral' }
    }
  }

  const stampTrailing = (m: OpenAIChatMessage): void => {
    if (typeof m.content === 'string') {
      const text = m.content
      m.content = [
        { type: 'text', text: text.length > 0 ? text : ' ', cache_control: { type: 'ephemeral' } },
      ]
    } else if (Array.isArray(m.content) && m.content.length > 0) {
      stampLast(m.content as any)
    }
  }

  // 1. System breakpoint — anchors the whole system-prompt-plus-tools prefix.
  const sys = messages.find((m) => m.role === 'system')
  if (sys) {
    if (typeof sys.content === 'string' && sys.content.length > 0) {
      sys.content = [{ type: 'text', text: sys.content, cache_control: { type: 'ephemeral' } }]
    } else if (Array.isArray(sys.content)) {
      stampLast(sys.content as any)
    }
  }

  // 2 & 3. Last TWO non-system user/tool breakpoints — rolling cache.
  let stamped = 0
  for (let i = messages.length - 1; i >= 0 && stamped < 2; i--) {
    const m = messages[i]!
    if (m.role !== 'user' && m.role !== 'tool') continue
    stampTrailing(m)
    stamped++
  }
}

function stripNullToolCall(m: OpenAIChatMessage): OpenAIChatMessage {
  if (!m.tool_calls) return m
  const cleaned = m.tool_calls.filter(tc => tc && tc.function && tc.function.name)
  if (cleaned.length === 0) {
    const { tool_calls: _tc, ...rest } = m
    return rest
  }
  return { ...m, tool_calls: cleaned }
}

function stripNameField(m: OpenAIChatMessage): OpenAIChatMessage {
  if (!m.name) return m
  const { name: _n, ...rest } = m
  return rest
}

function injectMagistralThinkingPrompt(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const thinkingPrompt =
    'Reason step-by-step inside <think>...</think> tags before answering. '
    + 'Emit your thinking first, then provide your final answer outside the tags.'
  const existingSystem = messages.findIndex(m => m.role === 'system')
  if (existingSystem >= 0) {
    const sys = messages[existingSystem]
    const merged = typeof sys.content === 'string'
      ? thinkingPrompt + '\n\n' + sys.content
      : thinkingPrompt
    return messages.map((m, i) => i === existingSystem ? { ...m, content: merged } : m)
  }
  return [{ role: 'system', content: thinkingPrompt }, ...messages]
}

// ─── Ollama Native /api/chat Path ────────────────────────────────
//
// The /v1/chat/completions shim ignores `keep_alive` and `options.num_ctx`,
// so the model runs at its 4096-token default and unloads after 5 minutes
// idle. Both kill latency for agent use: every turn overflows ctx and
// re-prefills from scratch, and every coffee break costs a 20s reload.
// Going direct to /api/chat lets us set both. Tools, tool_call_id, and
// the tools schema use the same shape as OpenAI's API, so this is a
// thin transport swap rather than a full re-implementation.

function safeParseObject(s: string): Record<string, unknown> {
  if (!s) return {}
  try { return JSON.parse(s) as Record<string, unknown> } catch { return {} }
}

function toOllamaMessage(m: OpenAIChatMessage): Record<string, unknown> {
  // Ollama wants flat string content; collapse OpenAI parts arrays.
  let content = ''
  if (typeof m.content === 'string') {
    content = m.content
  } else if (Array.isArray(m.content)) {
    content = m.content
      .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('\n')
  }

  const out: Record<string, unknown> = { role: m.role, content }

  if (m.tool_calls && m.tool_calls.length > 0) {
    out.tool_calls = m.tool_calls.map(tc => ({
      ...(tc.id && { id: tc.id }),
      type: 'function',
      function: {
        name: tc.function.name,
        // Ollama's /api/chat accepts arguments as object; we always have
        // a JSON string from the OpenAI conversion path so parse here.
        arguments: safeParseObject(tc.function.arguments),
      },
    }))
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id

  return out
}

async function* streamOllamaNative(
  cfg: { apiKey: string; baseUrl: string },
  body: OpenAIChatRequest,
  model: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
  const root = normalizeBaseUrl(cfg.baseUrl).replace(/\/v1$/i, '')
  const url = `${root}/api/chat`

  const numCtx = parseInt(process.env.OLLAMA_NUM_CTX ?? '16384', 10)
  const keepAlive = process.env.OLLAMA_KEEP_ALIVE ?? '30m'

  const ollamaBody: Record<string, unknown> = {
    model: body.model,
    messages: body.messages.map(toOllamaMessage),
    stream: true,
    keep_alive: keepAlive,
    options: {
      num_ctx: numCtx,
      ...(body.max_tokens != null && { num_predict: body.max_tokens }),
      ...(body.temperature !== undefined && { temperature: body.temperature }),
      ...(body.stop?.length && { stop: body.stop }),
    },
  }
  if (body.tools && body.tools.length > 0) ollamaBody.tools = body.tools

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`

  const messageId = `ollama-${Date.now()}`
  let messageStartEmitted = false
  let inputTokens = 0
  let outputTokens = 0
  let currentBlockIndex = 0
  let inTextBlock = false
  let inThinkingBlock = false
  const toolCallBuffers: Array<{ id: string; name: string; args: string; anthropicIndex: number }> = []
  let emittedAnyToolUse = false

  const emitMessageStart = (): AnthropicStreamEvent | undefined => {
    if (messageStartEmitted) return undefined
    messageStartEmitted = true
    return {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(ollamaBody),
      signal,
    })
  } catch (err: any) {
    const mst = emitMessageStart()
    if (mst) yield mst
    yield* emitErrorText(`ollama API connection error: ${err?.message ?? String(err)}`)
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
    yield { type: 'message_stop' }
    return blankUsage(0, 0, 0, 0)
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    const mst = emitMessageStart()
    if (mst) yield mst
    const lowered = errText.toLowerCase()
    const isPromptTooLong = ['context length', 'too long', 'context window'].some(m => lowered.includes(m))
    const headline = isPromptTooLong
      ? `Prompt is too long (ollama ${response.status})`
      : `ollama API error ${response.status}`
    yield* emitErrorText(`${headline}: ${errText.slice(0, 500)}`)
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
    yield { type: 'message_stop' }
    return blankUsage(0, 0, 0, 0)
  }

  if (!response.body) throw new Error('Ollama: empty response body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // /api/chat is NDJSON: each line is a complete JSON object.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        let chunk: any
        try { chunk = JSON.parse(line) } catch { continue }

        const message = chunk.message ?? {}
        const isDone = chunk.done === true

        if (typeof chunk.prompt_eval_count === 'number') inputTokens = chunk.prompt_eval_count
        if (typeof chunk.eval_count === 'number') outputTokens = chunk.eval_count

        const hasContent = typeof message.content === 'string' && message.content.length > 0
        const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0

        if (!messageStartEmitted && (hasContent || hasToolCalls)) {
          const mst = emitMessageStart()
          if (mst) yield mst
        }

        if (hasContent) {
          if (inThinkingBlock) {
            yield { type: 'content_block_stop', index: currentBlockIndex }
            currentBlockIndex++
            inThinkingBlock = false
          }
          if (!inTextBlock) {
            yield {
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: { type: 'text', text: '' },
            }
            inTextBlock = true
          }
          yield {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'text_delta', text: message.content },
          }
        }

        if (hasToolCalls) {
          if (inTextBlock || inThinkingBlock) {
            yield { type: 'content_block_stop', index: currentBlockIndex }
            currentBlockIndex++
            inTextBlock = false
            inThinkingBlock = false
          }
          for (const tc of message.tool_calls) {
            const fn = tc.function ?? {}
            const name = fn.name ?? ''
            const argsStr = typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {})
            const id = tc.id ?? `call_${toolCallBuffers.length}`
            toolCallBuffers.push({
              id,
              name,
              args: argsStr,
              anthropicIndex: currentBlockIndex,
            })
            currentBlockIndex++
            emittedAnyToolUse = true
          }
        }

        if (isDone) {
          if (inTextBlock || inThinkingBlock) {
            yield { type: 'content_block_stop', index: currentBlockIndex }
            inTextBlock = false
            inThinkingBlock = false
          }
          for (const buf of toolCallBuffers) {
            const implId = normalizeToolName(buf.name)
            let input: Record<string, unknown>
            try { input = buf.args ? JSON.parse(buf.args) : {} }
            catch { input = { _raw: buf.args } }
            const anthropicToolUseId = buf.id.startsWith('toolu_') ? buf.id : `toolu_ollama_${buf.id}`
            yield {
              type: 'content_block_start',
              index: buf.anthropicIndex,
              content_block: { type: 'tool_use', id: anthropicToolUseId, name: implId, input: {} },
            }
            yield {
              type: 'content_block_delta',
              index: buf.anthropicIndex,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(input ?? {}) },
            }
            yield { type: 'content_block_stop', index: buf.anthropicIndex }
          }
          toolCallBuffers.length = 0
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (!messageStartEmitted) {
    const mst = emitMessageStart()
    if (mst) yield mst
  }

  const stopReason: 'tool_use' | 'end_turn' = emittedAnyToolUse ? 'tool_use' : 'end_turn'
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: outputTokens, input_tokens: inputTokens },
  }
  yield { type: 'message_stop' }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    thinking_tokens: 0,
  }
}

// ─── Per-Provider Response Quirks ────────────────────────────────

function applyProviderResponseQuirks(chunk: any, provider: ProviderType): any {
  const choice = chunk?.choices?.[0]
  if (!choice) return chunk
  const delta = choice.delta ?? {}

  // Groq: returns `reasoning` on deltas; normalize to reasoning_content
  // for uniform downstream handling (not strictly required with our
  // thinking-delta union fallback, but keeps things tidy).
  if (provider === 'groq' && typeof delta.reasoning === 'string' && !delta.reasoning_content) {
    delta.reasoning_content = delta.reasoning
  }
  // Qwen (DashScope compatible-mode) reasoning + DashScope error handling
  // moved to src/lanes/qwen/ (dedicated lane). Compat no longer sees qwen.
  // DeepSeek already sends reasoning_content; nothing to rename.
  // OpenRouter may send either reasoning or reasoning_content depending
  // on the underlying model; the union handling in streamAsProvider
  // covers both.

  // Rebuild choice with normalized delta.
  return { ...chunk, choices: [{ ...choice, delta }] }
}

// ─── Tool Schema Sanitization ────────────────────────────────────

function buildOpenAITools(
  tools: ProviderTool[],
  provider: ProviderType,
): Array<{
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}> {
  // Transformer-driven strict mode + schema drop list. Per-provider
  // config lives in each transformer file — adding a new provider =
  // one new file; this function is provider-agnostic.
  const transformer = getTransformer(provider as ProviderId)
  const useStrict = transformer.supportsStrictMode()
  return tools.map(t => {
    const parameters = sanitizeToolSchema(
      t.input_schema ?? { type: 'object', properties: {} },
      provider,
    )
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        // Every tool description gets the STRICT PARAMETERS summary
        // appended — plain-text in-context reminder of required fields
        // + types. Backstops `strict: true` on providers that honor it
        // and does the whole job on providers that don't.
        description: appendStrictParamsHint(t.description ?? '', parameters),
        parameters,
        ...(useStrict && { strict: true }),
      },
    }
  })
}

// Strip JSON Schema fields that various providers reject. Drop lists
// are owned by each transformer (schemaDropList()); this wrapper just
// runs the walk.
function sanitizeToolSchema(schema: Record<string, unknown>, provider: ProviderType): Record<string, unknown> {
  const drop = getTransformer(provider as ProviderId).schemaDropList()

  function walk(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
        if (drop.has(k)) continue
        out[k] = walk(value)
      }
      return out
    }
    return v
  }
  return walk(schema) as Record<string, unknown>
}

// ─── History Conversion ──────────────────────────────────────────

function convertHistoryToOpenAI(
  messages: ProviderMessage[],
  systemText: string,
  provider: ProviderType = 'generic',
  model = '',
): OpenAIChatMessage[] {
  if (provider === 'deepseek' && model.toLowerCase() !== 'deepseek-reasoner') {
    return convertHistoryToOpenAIForDeepSeek(messages, systemText)
  }
  if (provider === 'moonshot' && isMoonshotThinkingModel(model)) {
    return convertHistoryToOpenAIForDeepSeek(messages, systemText)
  }
  return convertHistoryToOpenAIDefault(messages, systemText)
}

function convertHistoryToOpenAIDefault(
  messages: ProviderMessage[],
  systemText: string,
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  if (systemText) out.push({ role: 'system', content: systemText })

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      })
      continue
    }

    const texts: string[] = []
    const toolCalls: NonNullable<OpenAIChatMessage['tool_calls']> = []
    const toolResults: OpenAIChatMessage[] = []

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          if (block.text) texts.push(block.text)
          break
        case 'tool_use':
          if (block.id && block.name) {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            })
          }
          break
        case 'tool_result':
          if (block.tool_use_id) {
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string'
                ? block.content
                : stringifyToolContent(block.content),
            })
          }
          break
        case 'thinking':
          // OpenAI Chat Completions doesn't echo thinking back — skip.
          break
      }
    }

    if (texts.length > 0 || toolCalls.length > 0) {
      out.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: texts.length > 0 ? texts.join('\n') : null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      })
    }
    out.push(...toolResults)
  }

  return out
}

function convertHistoryToOpenAIForDeepSeek(
  messages: ProviderMessage[],
  systemText: string,
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  if (systemText) out.push({ role: 'system', content: systemText })

  let pendingReasoning: string | null = null
  let pendingAssistantTexts: string[] = []

  const clearPendingAssistant = () => {
    pendingReasoning = null
    pendingAssistantTexts = []
  }

  const flushPendingAssistantText = () => {
    if (pendingAssistantTexts.length > 0) {
      out.push({ role: 'assistant', content: pendingAssistantTexts.join('\n') })
    }
    clearPendingAssistant()
  }

  const appendPendingReasoning = (thinking: string) => {
    pendingReasoning = pendingReasoning
      ? `${pendingReasoning}\n${thinking}`
      : thinking
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      flushPendingAssistantText()
      out.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      })
      continue
    }

    const texts: string[] = []
    const toolCalls: NonNullable<OpenAIChatMessage['tool_calls']> = []
    const toolResults: OpenAIChatMessage[] = []
    const thinkingBlocks: string[] = []

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          if (block.text) texts.push(block.text)
          break
        case 'tool_use':
          if (block.id && block.name) {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            })
          }
          break
        case 'tool_result':
          if (block.tool_use_id) {
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string'
                ? block.content
                : stringifyToolContent(block.content),
            })
          }
          break
        case 'thinking':
          if (block.thinking) thinkingBlocks.push(block.thinking)
          break
      }
    }

    if (msg.role === 'assistant') {
      for (const thinking of thinkingBlocks) appendPendingReasoning(thinking)

      if (toolCalls.length > 0) {
        const contentParts = [...pendingAssistantTexts, ...texts]
        out.push({
          role: 'assistant',
          content: contentParts.length > 0 ? contentParts.join('\n') : null,
          // DeepSeek thinking mode requires this field on every replayed
          // assistant tool-call message. Old cross-provider history may not
          // have a thinking block, so preserve protocol shape with "".
          reasoning_content: pendingReasoning ?? '',
          tool_calls: toolCalls,
        })
        clearPendingAssistant()
      } else if (texts.length > 0) {
        pendingAssistantTexts.push(...texts)
      }

      if (toolResults.length > 0) {
        flushPendingAssistantText()
        out.push(...toolResults)
      }
      continue
    }

    flushPendingAssistantText()
    if (texts.length > 0) {
      out.push({ role: 'user', content: texts.join('\n') })
    }
    out.push(...toolResults)
  }

  flushPendingAssistantText()
  return out
}

export function _convertHistoryToOpenAIForTest(
  messages: ProviderMessage[],
  systemText: string,
  provider: ProviderType,
  model: string,
): OpenAIChatMessage[] {
  return convertHistoryToOpenAI(messages, systemText, provider, model)
}

function stringifyToolContent(content: unknown): string {
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

// ─── Singleton Export ────────────────────────────────────────────

export const openaiCompatLane = new OpenAICompatLane()
