import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { isDeferredTool } from '../tools/ToolSearchTool/prompt.js'
import type { Message } from '../types/message.js'
import {
  isNimFastToolFilterActive,
  isToolKeptByNimFastFilter,
} from '../lanes/openai-compat/nim_tool_policy.js'
import { isToolKeptByGroqSmallTierFilter } from '../lanes/openai-compat/groq_tool_policy.js'
import {
  extractDiscoveredToolNames,
  isNativeLaneToolSearchEnabled,
  isToolSearchEnabled,
  isToolSearchToolAvailable,
} from './toolSearch.js'
import { extractToolReferenceNames } from './toolDiscoveryScan.js'
import {
  decideLazyToolCall,
  rejectProviderFilteredToolCall,
  type LazyToolCallDecision,
} from './toolSearchCallDecision.js'
import { getAPIProvider } from './model/providers.js'
import type { APIProvider } from './model/providers.js'

export function getProviderFilteredToolCallDecision(
  provider: APIProvider,
  toolName: string,
  model = '',
): LazyToolCallDecision | null {
  if (
    provider === 'nim' &&
    isNimFastToolFilterActive() &&
    !isToolKeptByNimFastFilter(toolName)
  ) {
    return rejectProviderFilteredToolCall(toolName, 'NIM fast-tool')
  }
  if (
    provider === 'groq' &&
    !isToolKeptByGroqSmallTierFilter(model, toolName)
  ) {
    return rejectProviderFilteredToolCall(toolName, 'Groq small-tier')
  }
  return null
}

/**
 * Determine whether the current call came from a request where its schema was
 * hidden. Such a call is not refused outright — that cost a turn and surfaced
 * an internal recovery error even when the arguments were correct. It is
 * reported as `execute_unverified` instead, and the caller checks those
 * arguments against the schema Tau already holds locally before running it.
 *
 * Definitive request gates are recomputed here. If discovery was disabled,
 * unsupported, below an auto threshold, or missing ToolSearch, eager schemas
 * win and execution proceeds unchanged.
 */
export async function getLazyToolCallDecision(options: {
  tool: Tool
  messages: Message[]
  tools: Tools
  model: string
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
}): Promise<LazyToolCallDecision> {
  // NIM's default transformer removes tools before request serialization.
  // Those tools are unavailable, not deferred: never execute a remembered or
  // guessed call against a schema the producing model did not receive.
  const providerFilteredDecision = getProviderFilteredToolCallDecision(
    getAPIProvider(),
    options.tool.name,
    options.model,
  )
  if (providerFilteredDecision) return providerFilteredDecision

  const isDeferred = isDeferredTool(options.tool)
  if (!isDeferred) return { action: 'execute' }

  if (!isToolSearchToolAvailable(options.tools)) return { action: 'execute' }

  const nativeDiscovery = isNativeLaneToolSearchEnabled(options.model)
  const anthropicDiscovery = nativeDiscovery
    ? false
    : await isToolSearchEnabled(
        options.model,
        options.tools,
        options.getToolPermissionContext,
        options.agents,
        'tool_call_guard',
      )

  // Client-native lanes can append a schema after a direct blind tool_use, so
  // their broader discovery scan intentionally includes tool_use blocks.
  // Anthropic server-native discovery cannot: only a real tool_reference from
  // ToolSearch loads the schema into model context.
  const schemaWasLoaded = (
    nativeDiscovery
      ? extractDiscoveredToolNames(options.messages)
      : extractToolReferenceNames(options.messages)
  ).has(options.tool.name)
  if (schemaWasLoaded) return { action: 'execute' }

  return decideLazyToolCall({
    toolName: options.tool.name,
    isDeferred,
    schemaWasLoaded,
    discoveryIsActive: nativeDiscovery || anthropicDiscovery,
    requiresExplicitSelection: anthropicDiscovery,
  })
}
