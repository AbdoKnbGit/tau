import type {
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/constants.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import {
  extractLoadedToolNames,
  isAutoHundred,
  selectLazyToolsForRequest,
  stickyLoadedToolNames,
} from '../shared/lazy_tools_core.js'

// Re-exported under the lane-specific name the lane's callers/tests use.
export { extractLoadedToolNames as extractOpenAICompatLoadedToolNames } from '../shared/lazy_tools_core.js'

function shouldUseOpenAICompatLazyTools(tools: ProviderTool[]): boolean {
  if (isEnvDefinedFalsy(process.env.ENABLE_TOOL_SEARCH)) return false
  if (isAutoHundred(process.env.ENABLE_TOOL_SEARCH)) return false
  if (isEnvDefinedFalsy(process.env.TAU_NATIVE_LAZY_TOOLS)) return false
  // Without ToolSearch in the toolset the model can never load a deferred tool,
  // so hiding them would strand it — keep the full set.
  return tools.some(tool => tool.name === TOOL_SEARCH_TOOL_NAME)
}

export function selectOpenAICompatToolsForRequest(
  tools: ProviderTool[],
  messages: ProviderMessage[],
  sessionId?: string,
  provider?: string,
): ProviderTool[] {
  // Do not trust deferred flags carried by a resumed or cross-provider
  // session. OpenRouter always receives every available callable contract.
  if (provider === 'openrouter') {
    return tools.filter(tool => tool.name !== TOOL_SEARCH_TOOL_NAME)
  }
  if (!shouldUseOpenAICompatLazyTools(tools)) return tools
  // Sticky per-session registry: compaction can erase the history evidence of
  // a load, and the tool block must never shrink or reorder mid-session.
  const loaded = stickyLoadedToolNames(
    sessionId ? `openai-compat:${sessionId}` : undefined,
    extractLoadedToolNames(messages),
  )
  return selectLazyToolsForRequest(tools, loaded)
}
