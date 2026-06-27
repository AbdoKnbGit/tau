/**
 * Per-provider Transformer interface for the OpenAI-compat lane.
 *
 * Every provider that speaks OpenAI Chat Completions has its own small
 * bag of quirks — Groq rejects `$schema`, Mistral needs `tool_choice:
 * "any"` instead of `"required"`, DeepSeek caps `max_tokens` at 8192,
 * NIM strips `stream_options`, OpenRouter needs a `HTTP-Referer`
 * header, and so on. The lane calls into a single `Transformer` per
 * provider so adding a new one is ~30 lines in a single file instead
 * of a 4-site grep across `loop.ts`.
 *
 * Reference: reference/claude-router-main/packages/core/src/transformer/
 *            and litellm/llms/<provider>/chat/transformation.py
 */

import type { ModelInfo } from '../../../services/api/providers/base_provider.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'

export type ProviderId =
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
  | 'modelrouter'
  | 'vercel'
  | 'requesty'
  | 'opencode'
  | 'opencodego'
  | 'fireworks'
  | 'cloudflare'
  | 'cline'
  | 'iflow'
  | 'kilocode'
  | 'copilot'
  | 'generic'

export interface TransformContext {
  /** Original model id the user asked for. */
  model: string
  /** Is the user asking for reasoning/thinking? */
  isReasoning: boolean
  /** Mapped reasoning-effort ("low" | "medium" | "high") or null. */
  reasoningEffort: 'low' | 'medium' | 'high' | null
  /** Stable claudex session id, used only by providers with cache affinity. */
  sessionId?: string
}

export interface HeaderContext {
  /** Original model id the user asked for. */
  model: string
  /** Stable claudex session id, used only by providers with cache affinity. */
  sessionId?: string
}

export interface Transformer {
  readonly id: ProviderId
  readonly displayName: string

  /** Default upstream base URL when the user hasn't overridden. */
  readonly defaultBaseUrl: string

  /**
   * Extra HTTP headers per request (auth is added separately).
   * Example: OpenRouter's HTTP-Referer + X-Title.
   */
  buildHeaders?(apiKey: string, ctx?: HeaderContext): Record<string, string>

  /**
   * Does this provider honor OpenAI's `function.strict: true` schema
   * enforcement? Mistral rejects it; most others ignore if unsupported.
   */
  supportsStrictMode(): boolean

  /**
   * Clamp an outbound `max_tokens` to the provider's hard ceiling.
   * Returns the requested value when no clamp applies.
   */
  clampMaxTokens(requested: number): number

  /**
   * Mutate a request body in place with provider-specific quirks
   * (strip unsupported fields, rename tool_choice modes, inject
   * `extra_body` flags, etc.). Called AFTER the lane has built the
   * OpenAI-canonical body but BEFORE serialization.
   */
  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest

  /**
   * Normalize a streaming delta into OpenAI-canonical shape (e.g.
   * `reasoning` → `reasoning_content` for Groq, error-finish surface
   * for DashScope, etc.). Called on every streamed chunk's delta.
   */
  normalizeStreamDelta?(
    delta: OpenAIChatMessage & {
      reasoning?: string
      reasoning_content?: string
    },
    finishReason: string | null,
  ): void

  /**
   * JSON-Schema drop list for tool parameters. Base set: `$schema`,
   * `$id`, `$ref`, `$comment`. Provider extras (e.g. Mistral drops
   * `format`, `examples`, `default`).
   */
  schemaDropList(): Set<string>

  /**
   * Context-length-exceeded markers to detect in 4xx response bodies.
   * Matched case-insensitively with `includes()`. Used for mapping a
   * 400 to PromptTooLongError so `query.ts` reactive-compact fires.
   */
  contextExceededMarkers(): string[]

  /**
   * Which edit primitive best fits models on this provider. Drives
   * tool-set selection in tools.ts:
   *   'apply_patch'  — model handles unified-diff well (GPT-5 class)
   *   'edit_block'   — model handles Aider SEARCH/REPLACE (most compat)
   *   'str_replace'  — model best handles simple old_string/new_string
   */
  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace'

  /**
   * Model id for cheap fire-and-forget tasks (titles, summaries).
   * Null → caller uses main-loop model.
   */
  smallFastModel(model: string): string | null

  /**
   * Cache-control placement support:
   *   'none'      — strip all cache_control fields (provider rejects)
   *   'passthrough' — keep cache_control as-is (Anthropic-compat)
   *   'last-only' — relocate to last content block (OpenRouter cap)
   */
  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only'

  /**
   * Optional hardcoded model catalog. When set, the lane returns this
   * verbatim from `listModels()` instead of querying the provider's
   * `/v1/models` endpoint. Use for providers whose upstream `/models`
   * is unreliable (auth-gated, paginated, returns sub-aliases) or where
   * a curated, stable list is preferable to whatever the gateway emits.
   */
  staticCatalog?(): ModelInfo[]

  /**
   * Optional hint: prefer the live `/v1/models` response and use
   * `staticCatalog()` only as a fallback when the upstream call fails
   * or returns an empty list. Useful for providers like Copilot where
   * the available model set changes frequently but a curated fallback is
   * still valuable when auth scopes or gateway behavior break `/models`.
   */
  preferLiveModelCatalog?(): boolean

  /**
   * Optional post-filter on the provider's /v1/models response. Used
   * when the upstream catalog contains non-chat (whisper, TTS) or
   * preview/retired models we don't want surfaced in `/models`. Default
   * is no filter (pass through).
   */
  filterModelCatalog?(
    models: Array<{ id: string; name?: string }>,
  ): Array<{ id: string; name?: string }>

  /**
   * Optional per-model tool filter. Used to trim the tool array for
   * models with tight input-token / TPM budgets (e.g. Groq Llama on
   * free tier: 6k/12k TPM). Returning a subset drops the rest. Default
   * is no filter — every tool passes through.
   *
   * The filter runs BEFORE schema sanitization and strict-mode shaping,
   * so it sees the raw Anthropic-format tool names (Bash, Read, Agent,
   * mcp__github__*, …) as they arrive from the caller.
   */
  filterTools?<T extends { name: string }>(model: string, tools: T[]): T[]

  /**
   * Optional per-model hint: skip the OPENAI_COMPAT_TOOL_USAGE_RULES
   * preamble when tokens are scarce. Returning true means the lane
   * sends the caller's system text verbatim without the preamble.
   */
  skipToolUsagePreamble?(model: string): boolean

  /**
   * Optional extra JSON-Schema sanitizer that runs AFTER the drop-list
   * walk in sanitizeToolSchema(). Use for provider-specific schema
   * shapes that the drop list can't express (e.g. Moonshot's "$ref must
   * have no siblings", tuple-form `items` arrays, Gemini's integer enum
   * → string enum, missing `items` on array nodes).
   *
   * Receives the schema AFTER unknown-key/$x stripping; must return a
   * new object (don't mutate). `modelId` is the caller-supplied model
   * id, useful for sub-provider gating (e.g. Gemini-via-OpenRouter).
   */
  sanitizeToolSchemaExtra?(
    schema: Record<string, unknown>,
    modelId: string,
  ): Record<string, unknown>

  /**
   * Optional per-model default generation parameters (temperature,
   * top_p, top_k). Applied by the lane ONLY when the caller did not
   * pass an explicit value — frontier overrides from claude.ts always
   * win. Use this for known-quirky models (Qwen 0.55, Kimi-k2 0.6,
   * MiniMax 1.0/0.95/20-40, Gemini 1.0/0.95/64).
   *
   * Mirrors opencode's per-model temperature/topP/topK helpers in
   * `provider/transform.ts`.
   */
  defaultGenerationParams?(model: string): {
    temperature?: number
    top_p?: number
    top_k?: number
  } | undefined

  /**
   * Optional per-model shell-tool description override. The compat lane
   * forwards the caller's BashTool / PowerShellTool description verbatim
   * by default (which is frontier-tier verbose), so weak models drown
   * in detail and emit wrong-shell syntax. When this hook returns a
   * non-empty string, it REPLACES the caller's description for the
   * named shell tool BEFORE the STRICT PARAMETERS hint is appended.
   *
   * - `toolName` is "Bash" or "PowerShell" (the only names the compat
   *   lane swaps; pass-through otherwise).
   * - `ctx.platform` is the host platform (`process.platform`) so the
   *   override can pick POSIX vs Windows paths and shells.
   * - `ctx.psEdition` is `"desktop"` (5.1), `"core"` (7+), or `null`
   *   when not yet resolved or not applicable.
   *
   * Must be deterministic given (toolName, model, ctx) so the cached
   * description stays byte-stable across turns. Don't return per-call
   * data (homedir, tmpdir, session id) or you'll churn the prompt
   * cache.
   */
  overrideShellToolDescription?(
    toolName: 'Bash' | 'PowerShell',
    model: string,
    ctx: {
      platform: NodeJS.Platform
      psEdition: 'desktop' | 'core' | null
    },
  ): string | undefined
}
