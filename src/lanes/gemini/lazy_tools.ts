import type {
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import {
  isAntigravityModelId,
} from '../../services/api/providers/gemini_code_assist.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/constants.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import {
  extractLoadedToolNames,
  isAutoHundred,
  selectLazyToolsForRequest,
  stickyLoadedToolNames,
} from '../shared/lazy_tools_core.js'

// Re-exported under the lane-specific name the lane's callers/tests use.
export { extractLoadedToolNames as extractGeminiLoadedToolNames } from '../shared/lazy_tools_core.js'

export function shouldUseGeminiNativeLazyTools(
  model: string,
  providerHint?: string,
): boolean {
  if (isEnvDefinedFalsy(process.env.ENABLE_TOOL_SEARCH)) return false
  if (isAutoHundred(process.env.ENABLE_TOOL_SEARCH)) return false
  if (isEnvDefinedFalsy(process.env.TAU_GEMINI_LAZY_TOOLS)) return false
  // Antigravity's implicit cache is exact-prefix with no partial credit, so any
  // change to the tool block voids the whole conversation cache. Lazy loading
  // would churn that block, so it stays OFF there — the full (stable) tool set
  // warms naturally instead. See antigravity_cache.ts.
  if (providerHint === 'antigravity') return false
  if (isAntigravityModelId(model)) return false
  return true
}

export function selectGeminiToolsForRequest(
  tools: ProviderTool[],
  messages: ProviderMessage[],
  options: {
    model: string
    providerHint?: string
    sessionId?: string
  },
): ProviderTool[] {
  if (!shouldUseGeminiNativeLazyTools(options.model, options.providerHint)) {
    return tools
  }
  // Discovery cannot make progress without its dispatcher. Preserve full
  // schemas as the correctness fallback (for example when a provider/model
  // filter removes ToolSearch).
  if (!tools.some(tool => tool.name === TOOL_SEARCH_TOOL_NAME)) return tools
  // Sticky per-session registry: compaction can erase the history evidence of
  // a load, and the tool block must never shrink or reorder mid-session.
  const loaded = stickyLoadedToolNames(
    options.sessionId ? `gemini:${options.sessionId}` : undefined,
    extractLoadedToolNames(messages),
  )
  return selectLazyToolsForRequest(tools, loaded)
}
