/**
 * Constants related to tool result size limits
 */

/**
 * Default maximum size in characters for tool results before they get persisted
 * to disk. When exceeded, the result is saved to a file and the model receives
 * a preview with the file path instead of the full content.
 *
 * Individual tools may declare a lower maxResultSizeChars, but this constant
 * acts as a system-wide cap regardless of what tools declare.
 *
 * 20_000 chars ≈ 5K tokens: mid-size bash/grep/webfetch output takes the
 * persist+distill path (failures + summary + retrieval handle) instead of
 * riding inline in the transcript for the rest of the session. The full
 * output stays on disk and is retrievable via ToolOutputRetrieve, and the
 * persist decision is made once at execution time and frozen, so lowering
 * this is prompt-cache safe on every provider.
 * Runtime override: TAU_TOOL_PERSIST_THRESHOLD_CHARS /
 * CLAUDE_CODE_TOOL_PERSIST_THRESHOLD_CHARS — see getPersistenceThreshold()
 * in toolResultStorage.ts.
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 20_000

/**
 * Cheap-mode system cap for one inline tool result. Persisted results keep a
 * deterministic ~2 KB evidence preview plus a ToolOutputRetrieve handle, so
 * 10 KB leaves useful local context without allowing every tool invocation to
 * permanently add the normal-mode 20 KB ceiling to the transcript.
 */
export const CHEAP_MODE_MAX_RESULT_SIZE_CHARS = 10_000

/**
 * Maximum size for tool results in tokens.
 * Based on analysis of tool result sizes, we set this to a reasonable upper bound
 * to prevent excessively large tool results from consuming too much context.
 *
 * This is approximately 400KB of text (assuming ~4 bytes per token).
 */
export const MAX_TOOL_RESULT_TOKENS = 100_000

/**
 * Bytes per token estimate for calculating token count from byte size.
 * This is a conservative estimate - actual token count may vary.
 */
export const BYTES_PER_TOKEN = 4

/**
 * Maximum size for tool results in bytes (derived from token limit).
 */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN

/**
 * Default maximum aggregate size in characters for tool_result blocks within
 * a SINGLE user message (one turn's batch of parallel tool results). When a
 * message's blocks together exceed this, the largest blocks in that message
 * are persisted to disk and replaced with previews until under budget.
 * Messages are evaluated independently — a 150K result in one turn and a
 * 150K result in the next are both untouched.
 *
 * This prevents N parallel tools from each hitting the per-tool max and
 * collectively producing e.g. 10 × 15K = 150K in one turn's user message.
 *
 * 60_000 chars ≈ 15K tokens: the ceiling one turn's batch of tool results
 * may add to the transcript inline; the largest fresh blocks overflow to
 * the persist+preview path. Enforcement freezes per tool_use_id
 * (enforceToolResultBudget), so already-sent messages are never rewritten
 * and provider prefix caches are preserved.
 * Overridable at runtime via GrowthBook flag tengu_hawthorn_window or env
 * TAU_TOOL_RESULTS_BUDGET_CHARS / CLAUDE_CODE_TOOL_RESULTS_BUDGET_CHARS —
 * see getPerMessageBudgetLimit() in toolResultStorage.ts.
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 60_000

/**
 * Cheap-mode aggregate target for one API-level user message. This is high
 * enough for several small parallel results, while bounding a reducible fresh
 * tool batch to roughly 6K text tokens. Frozen historical bytes, Read output,
 * or blocks smaller than a retrieval handle are explicit irreducible overage.
 */
export const CHEAP_MODE_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 24_000

/**
 * Maximum raw payload returned by one ToolOutputRetrieve call in cheap mode.
 * Kept below the 10 KB per-tool persistence threshold so retrieving a saved
 * result cannot create another persisted-output handle. Pagination and search
 * still expose the complete file across bounded calls.
 */
export const CHEAP_MODE_TOOL_OUTPUT_RETRIEVE_BYTES = 8_000

/** Preview payload used only when the aggregate message budget offloads a result. */
export const AGGREGATE_TOOL_RESULT_PREVIEW_CHARS = 512

/**
 * Maximum character length for tool summary strings in compact views.
 * Used by getToolUseSummary() implementations to truncate long inputs
 * for display in grouped agent rendering.
 */
export const TOOL_SUMMARY_MAX_LENGTH = 50
