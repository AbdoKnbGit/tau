/**
 * Lane Architecture Types
 *
 * Each lane is a native execution environment for a model family.
 * Lanes own their agent loop, tool registry, system prompt, and API
 * client. The shared layer owns session, permissions, tool implementations,
 * MCP, UI, and commands.
 *
 * The Anthropic IR (AnthropicStreamEvent) is the boundary between lanes
 * and the shared layer. Every lane normalizes its native events into
 * this IR so the UI is lane-agnostic.
 */

import type {
  AnthropicStreamEvent,
  AnthropicMessage,
  ModelInfo,
  ProviderMessage,
  ProviderTool,
  SystemBlock,
  ProviderRequestParams,
} from '../services/api/providers/base_provider.js'

// ─── Lane Interface ──────────────────────────────────────────────
//
// Each lane implements this interface. The dispatcher selects a lane
// based on the active provider/model and invokes lane.run().
//
// Key contract: lane.run() is the COMPLETE agent loop. It sends
// requests to the model, processes responses, executes tools via the
// shared callback, and loops until the model says stop. The caller
// (QueryEngine) just iterates the events and renders them.

export interface Lane {
  /** Lane identifier: 'anthropic' | 'gemini' | 'codex' | 'openai-compat' */
  readonly name: string

  /** Human-readable display name */
  readonly displayName: string

  /**
   * Can this lane handle the given model ID?
   * The dispatcher calls this to find the right lane.
   */
  supportsModel(model: string): boolean

  /**
   * Run the complete agent loop for one user turn.
   *
   * This is the core of the lane for future "lane-owns-loop" mode. It:
   * 1. Assembles the request in the lane's native format
   * 2. Calls the model's API directly (no shim, no translation)
   * 3. Processes the response using the lane's native patterns
   * 4. Executes tools via context.executeTool() (shared layer)
   * 5. Loops until the model stops or max turns hit
   * 6. Yields AnthropicStreamEvent at each step for UI rendering
   *
   * The caller does NOT manage the tool loop — the lane does.
   */
  run(context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult>

  /**
   * Stream ONE native API call as a provider replacement.
   *
   * This is the provider-shim-compatible entry point: the caller (claude.ts)
   * owns the turn-orchestration loop and calls this once per assistant turn.
   * The lane:
   *   1. Takes pre-assembled system + messages + tools (caller-built)
   *   2. Maps Anthropic-format tools → the lane's native tool schemas
   *   3. Issues ONE API call in the lane's native format
   *   4. Yields Anthropic-IR events for text/thinking/tool_use blocks
   *   5. Returns — does not execute tools internally
   *
   * The model still sees its home environment (native tool names, native
   * prompt delivery, native cache, native auth, native reasoning knobs).
   * Tool execution happens in the outer loop with the shared implementations.
   *
   * Optional because not every lane has been ported yet. Lanes that don't
   * implement this can only be used via run() (lane-owns-loop mode).
   */
  streamAsProvider?(params: LaneProviderCallParams): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage>

  /**
   * List models available through this lane.
   * Used by /models command.
   *
   * `providerFilter` narrows the result to a single registered sub-provider
   * on shared lanes like openai-compat (e.g. "groq" vs. "openrouter").
   * Lanes that serve a single provider can ignore it.
   */
  listModels(providerFilter?: string): Promise<ModelInfo[]>

  /**
   * Map a user-facing model name to the provider's actual model ID.
   */
  resolveModel(model: string): string

  /**
   * Return the model id this lane prefers for cheap, fast, single-turn
   * calls (session titles, commit messages, tool-use summaries). Callers
   * that fire-and-forget short completions should use this rather than
   * the main-loop model to save cost + latency.
   *
   * Returns `null` when the lane has no distinct fast model — caller
   * should fall back to the main-loop model.
   */
  smallFastModel?(): string | null

  /**
   * Health check. Returns false if the lane should be skipped
   * (API down, auth expired, disabled by config).
   */
  isHealthy(): boolean

  /**
   * Graceful shutdown — cancel in-flight requests, flush caches.
   */
  dispose(): void
}

// ─── Lane Provider-Call Params ───────────────────────────────────
//
// Input shape for streamAsProvider(). Matches ProviderRequestParams
// shape so the provider-shim bridge can forward without reshaping.
// The lane consumes these directly for a single API call.

export interface LaneProviderCallParams {
  model: string
  messages: ProviderMessage[]
  system: string | SystemBlock[]
  tools: ProviderTool[]
  max_tokens: number
  temperature?: number
  stop_sequences?: string[]
  thinking?: ProviderRequestParams['thinking']
  effortValue?: ProviderRequestParams['effortValue']
  signal: AbortSignal
  /** Stable claudex session id for provider-side prompt-cache affinity. */
  sessionId?: string
  /** Logical caller source used for diagnostics and cache-key isolation. */
  querySource?: ProviderRequestParams['querySource']
  /**
   * Which sub-provider the shim was built for (e.g. 'groq',
   * 'openrouter', 'deepseek'). Shared lanes like openai-compat use
   * this to disambiguate when the same model ID is hosted on multiple
   * providers — `openai/gpt-oss-120b` lives on both Groq and OpenRouter;
   * this hint is the ONLY reliable way to honor the user's selection.
   */
  providerHint?: string
}

// ─── Lane Run Context ────────────────────────────────────────────
//
// Everything the lane needs from the shared layer for the future
// "lane-owns-loop" mode. Passed by the dispatcher on each invocation.

export interface LaneRunContext {
  /** Model to use (already resolved by the user via /model) */
  model: string

  /**
   * Conversation history in lane-neutral format.
   * The lane converts this to its native message format internally.
   */
  messages: ProviderMessage[]

  /**
   * System prompt parts from the shared layer.
   * The lane injects these into its native prompt template at the
   * appropriate slots. The lane does NOT use the raw text as-is —
   * it has its own base template.
   */
  systemParts: SystemPromptParts

  /**
   * Shared tool implementations available in this session.
   * The lane maps these to its native tool names and schemas.
   * Keys are the implementation IDs (e.g., 'bash', 'read', 'write').
   */
  availableTools: SharedTool[]

  /**
   * MCP tools active in this session (already in ProviderTool shape).
   * The lane sanitizes these into its native tool format and includes
   * them alongside built-in tools.
   */
  mcpTools: ProviderTool[]

  /**
   * Execute a tool by its shared implementation ID.
   * The shared layer handles permissions, sandboxing, audit logging.
   * The lane calls this when the model invokes a tool — the lane
   * maps the native tool name back to the shared impl ID first.
   */
  executeTool(implId: string, input: Record<string, unknown>): Promise<ToolResult>

  /** Max output tokens for the model response */
  maxTokens: number

  /** Abort signal — user pressed Escape or session timeout */
  signal: AbortSignal

  /** Current working directory */
  cwd: string
}

// ─── System Prompt Parts ─────────────────────────────────────────
//
// The shared layer extracts these from CLAUDE.md/GEMINI.md/AGENTS.md,
// environment, git status, hooks, skills, etc. Each lane injects them
// into its native prompt template at the appropriate slots.

export interface SystemPromptParts {
  /**
   * User/project memory content (from CLAUDE.md, GEMINI.md, AGENTS.md,
   * QWEN.md — whichever exists). Already merged and deduplicated.
   */
  memory: string

  /** Environment info: OS, shell, cwd, git branch, date */
  environment: string

  /** Git status snapshot */
  gitStatus: string

  /** Additional tool-use guidance from hooks or user config */
  toolsAddendum: string

  /** MCP tools introduction text (when MCP is active) */
  mcpIntro: string

  /** Active skills context */
  skillsContext: string

  /** Custom user instructions (from config or env) */
  customInstructions: string
}

// ─── Shared Tool Handle ──────────────────────────────────────────
//
// A reference to a tool implementation in the shared layer.
// The lane uses this to build its native tool registry.

export interface SharedTool {
  /** Implementation ID — used in executeTool() calls */
  implId: string

  /** Anthropic-format tool definition (name, description, input_schema) */
  anthropicDef: ProviderTool

  /** Whether this tool should be deferred (lazy-loaded) */
  deferred: boolean
}

// ─── Tool Result ─────────────────────────────────────────────────

export interface ToolResult {
  /** Tool output (text or structured) */
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: unknown }>

  /** Whether the tool execution errored */
  isError: boolean
}

// ─── Lane Run Result ─────────────────────────────────────────────
//
// Returned when the async generator finishes (the return value,
// not a yielded event).

export interface LaneRunResult {
  /** Why the loop ended */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'max_turns' | 'error' | 'aborted'

  /** Normalized token usage for cost tracking */
  usage: NormalizedUsage

  /** The final assembled message (in Anthropic IR format) */
  finalMessage?: AnthropicMessage
}

// ─── Normalized Usage ────────────────────────────────────────────
//
// Every lane converts its native usage shape into this at the boundary.
// The cost tracker only consumes this shape.

export interface NormalizedUsage {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  thinking_tokens: number
}

// ─── Tool Registration ───────────────────────────────────────────
//
// Each lane maps shared tool implementations to native tool names.
// This is the per-lane tool registry entry.

export interface LaneToolRegistration {
  /** What the model sees (e.g., 'read_file' for Gemini, 'Bash' for Anthropic) */
  nativeName: string

  /** Maps to shared impl (e.g., 'read', 'bash') */
  implId: string

  /** JSON Schema in the lane's native format */
  nativeSchema: Record<string, unknown>

  /** Native description the model sees */
  nativeDescription: string

  /**
   * Convert the model's native tool call input to the shared impl's
   * expected input shape. E.g., Gemini's { file_path, start_line } →
   * shared Read's { file_path, offset, limit }.
   */
  adaptInput(nativeInput: Record<string, unknown>): Record<string, unknown>

  /**
   * Convert the shared impl's output to the lane's native result format.
   * E.g., shared Read returns text → Gemini expects { content: text }.
   */
  adaptOutput(sharedOutput: string | unknown): string
}

// ─── Lane Event Types (internal, not part of Anthropic IR) ───────

export type LaneEvent =
  | { type: 'lane_start'; lane: string; model: string }
  | { type: 'lane_tool_call'; nativeName: string; implId: string }
  | { type: 'lane_tool_result'; implId: string; isError: boolean }
  | { type: 'lane_compaction'; reason: string; tokensSaved: number }
  | { type: 'lane_retry'; attempt: number; reason: string }
  | { type: 'lane_end'; reason: string; usage: NormalizedUsage }
