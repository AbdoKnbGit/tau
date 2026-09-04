/**
 * Alibaba Cloud Model Studio transformer (DashScope compatible-mode).
 *
 * Model Studio is a first-party vendor API rather than a relay, and its
 * OpenAI-compatible route is close to stock. Three things differ, and all
 * three are per-model rather than per-provider:
 *
 *   1. Thinking is steered by `enable_thinking` and `reasoning_effort`, and
 *      which of the two a model accepts is published per model. Sending one a
 *      model does not take is a 400, so both come from the catalogue-derived
 *      ladder in utils/model/alibabaThinking.ts and never from a guess.
 *      Node clients pass them at the top level of the body (the Python SDK's
 *      `extra_body` wrapper is an SDK detail, not a wire one).
 *   2. `max_tokens` is honoured but capped per model — 131,072 on the
 *      qwen3.8 rows, 32,768 on qwen-flash — so the clamp reads the row.
 *   3. Reasoning rows stream `reasoning_content`. Model Studio's DeepSeek,
 *      GLM and Kimi rows demand it echoed back on replayed assistant
 *      tool-call messages; the Qwen rows ignore it unless `preserve_thinking`
 *      is set. The lane carries it back for every thinking-on row, which is
 *      free for the rows that ignore it and load-bearing for the rest.
 *
 * ── Prompt cache ─────────────────────────────────────────────────────
 *
 * Model Studio caches implicitly: automatic, always on, not disableable, and
 * keyed on the exact prompt prefix with a 1,024-token minimum. Hits come back
 * as `prompt_tokens_details.cached_tokens`, which the lane's generic usage
 * extractor already reads, and cost them nothing to write.
 *
 * It also documents an explicit `cache_control: {"type": "ephemeral"}` marker.
 * Nothing here sends one: the implicit cache already covers a stable prefix,
 * and the markers are documented against the Anthropic-compatible protocol —
 * shipping an unverified field into message content blocks risks a 400 on
 * every request to save nothing the implicit cache is not already saving. So
 * `cacheControlMode` strips them, and `alibaba` is registered as an exact
 * prefix-cache provider in utils/toolDeferralPolicy.ts so a mid-session
 * ToolSearch cannot rewrite the head of the request and void the prefix.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import {
  ALIBABA_DEFAULT_BASE_URL,
  alibabaMaxOutputTokens,
  alibabaModelCatalog,
  recordAlibabaLiveModels,
} from '../../../utils/model/alibabaCatalog.js'
import {
  hasExplicitAlibabaEffort,
  resolveAlibabaThinkingFields,
} from '../../../utils/model/alibabaThinking.js'

/**
 * Highest per-request output ceiling Model Studio publishes on any row
 * (qwen3.8-max / qwen3.8-flash). `transformRequest` narrows it to the row's
 * own cap once the model id is known.
 */
const ALIBABA_MAX_OUTPUT_TOKENS = 131_072

export const alibabaTransformer: Transformer = {
  id: 'alibaba',
  displayName: 'Alibaba Model Studio',
  defaultBaseUrl: ALIBABA_DEFAULT_BASE_URL,

  // Model Studio rejects `function.strict`; its schema enforcement is the
  // plain JSON-Schema pass.
  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return Math.min(Math.max(1, requested), ALIBABA_MAX_OUTPUT_TOKENS)
  },

  // `/models` is the authority on what THIS key may call — a Model Studio key
  // is region- and workspace-scoped — so the live list leads and the
  // catalogue below is only the offline fallback.
  preferLiveModelCatalog: () => true,

  staticCatalog() {
    return alibabaModelCatalog()
  },

  filterModelCatalog(models) {
    // `/models` answers ids and nothing else: no context window, no
    // capabilities. Record which ids the key may call, then hand back the
    // catalogue's description of exactly those — that pairing is what puts a
    // real context window and a real thinking ladder on each row.
    recordAlibabaLiveModels(models.map(model => model.id))
    return alibabaModelCatalog()
  },

  transformRequest(
    body: OpenAIChatRequest,
    ctx: TransformContext,
  ): OpenAIChatRequest {
    const bag = body as unknown as Record<string, unknown>

    if (typeof body.max_tokens === 'number') {
      body.max_tokens = Math.min(
        Math.max(1, body.max_tokens),
        alibabaMaxOutputTokens(ctx.model),
      )
    }

    // Precedence: the picker's per-model pick wins; otherwise the session's
    // thinking budget drives whichever fields the row published. Without the
    // explicit-pick check the budget would silently overwrite the chip on
    // every request.
    const thinking = resolveAlibabaThinkingFields(
      ctx.model,
      hasExplicitAlibabaEffort(ctx.model)
        ? undefined
        : { enabled: ctx.isReasoning, effort: ctx.reasoningEffort },
    )
    delete bag.enable_thinking
    delete bag.reasoning_effort
    delete bag.thinking_budget
    if (thinking.enable_thinking !== undefined) {
      bag.enable_thinking = thinking.enable_thinking
    }
    if (thinking.reasoning_effort !== undefined) {
      bag.reasoning_effort = thinking.reasoning_effort
    }

    // Fields Model Studio's compatible-mode route does not read. `thinking`
    // is DeepSeek's spelling of the toggle and would collide with the one
    // above; the rest are Anthropic and OpenRouter leftovers.
    delete bag.thinking
    delete bag.reasoning
    delete bag.store
    delete bag.prompt_cache_key
    delete bag.prompt_cache_retention
    delete bag.transforms
    delete bag.plugins
    delete bag.route
    delete bag.models
    delete bag.extra_body
    delete bag.providerOptions

    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict'])
  },

  contextExceededMarkers(): string[] {
    return [
      // Model Studio's own code for this is `invalid_parameter_error` with
      // "Range of input length should be [1, N]"; the rest are the shared
      // OpenAI-compatible phrasings its gateway also emits.
      'range of input length',
      'context length',
      'context_length_exceeded',
      'maximum context',
      'prompt is too long',
      'too long',
      'tokens exceed',
      'exceed token',
      'input length',
    ]
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    // Qwen-Coder is post-trained on Aider-style SEARCH/REPLACE, and the
    // general Qwen rows handle it at least as well as str_replace.
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    // The cheapest row Model Studio publishes ($0.05/$0.40 per 1M), and a
    // 1M-context one, so titles and summaries never bounce off the window.
    return 'qwen-flash'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    // See the header: the implicit cache needs no markers, and the explicit
    // ones are documented against a protocol this lane does not speak.
    return 'none'
  },
}
