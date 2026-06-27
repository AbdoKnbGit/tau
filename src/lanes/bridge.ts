/**
 * Lane Bridge — Integration with existing query flow
 *
 * Two functions the existing code calls:
 *   shouldUseNativeLane(model) → boolean  (fast, synchronous)
 *   runNativeLane(model, params) → AsyncGenerator<events>
 *
 * That's it. No config, no env vars. If a native lane is registered
 * and healthy for this model, it's used. Otherwise the existing
 * claude.ts + shim path runs as before.
 */

import { resolveRoute, dispatch } from './dispatcher.js'
import type { LaneRunContext, SystemPromptParts, SharedTool, ToolResult } from './types.js'
import type {
  AnthropicStreamEvent,
  ProviderMessage,
  ProviderTool,
} from '../services/api/providers/base_provider.js'
import { filterProviderToolsForLane, filterSharedToolsForLane } from './tool_filter.js'

/**
 * Should this model run through a native lane?
 * Fast, synchronous — no I/O. Returns true when a native lane
 * is registered, configured, and healthy for this model.
 *
 * Anthropic models always return false (they use the existing path).
 */
export function shouldUseNativeLane(model: string): boolean {
  return resolveRoute(model).type === 'native'
}

/**
 * Which lane handles this model? For diagnostics/UI.
 */
export function getNativeLaneName(model: string): string | null {
  const route = resolveRoute(model)
  if (route.type === 'native') return route.lane.name
  if (route.type === 'existing' && route.lane) return route.lane
  return null
}

/**
 * Run through the native lane. Yields AnthropicStreamEvent — same
 * IR the existing renderer consumes. Drop-in replacement for the
 * claude.ts agent loop on supported models.
 */
export async function* runNativeLane(
  model: string,
  params: NativeLaneParams,
): AsyncGenerator<AnthropicStreamEvent> {
  const route = resolveRoute(model)
  const laneName = route.type === 'native' ? route.lane.name : ''
  const context: LaneRunContext = {
    model,
    messages: params.messages,
    systemParts: params.systemParts,
    availableTools: filterSharedToolsForLane(laneName, params.availableTools),
    mcpTools: filterProviderToolsForLane(laneName, params.mcpTools),
    executeTool: params.executeTool,
    maxTokens: params.maxTokens,
    signal: params.signal,
    cwd: params.cwd,
  }

  const gen = dispatch(model, context)
  if (!gen) throw new Error(`No native lane for model ${model}`)

  // Forward events from the lane. The generator yields AnthropicStreamEvent
  // and returns LaneRunResult — we only forward the yielded events.
  for await (const event of gen) {
    yield event
  }
}

export interface NativeLaneParams {
  messages: ProviderMessage[]
  systemParts: SystemPromptParts
  availableTools: SharedTool[]
  mcpTools: ProviderTool[]
  executeTool(implId: string, input: Record<string, unknown>): Promise<ToolResult>
  maxTokens: number
  signal: AbortSignal
  cwd: string
}
