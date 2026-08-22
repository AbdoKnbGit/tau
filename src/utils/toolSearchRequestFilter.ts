import type { Tools } from '../Tool.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.js'
import { providerSupportsAnthropicToolSearch } from './model/providerCapabilities.js'
import type { APIProvider } from './model/providers.js'
import { providerModelSupportsClientSideToolDiscovery } from './toolDeferralPolicy.js'

interface ToolSearchRequestTransports {
  useToolSearch: boolean
  useNativeLaneToolSearch: boolean
}

/**
 * Reconcile optimistic feature decisions with the physical provider/model
 * route. The result is safe to reuse for upstream filtering, beta headers,
 * and defer_loading serialization.
 */
export function resolveToolSearchRequestTransports(options: {
  useToolSearch: boolean
  useNativeLaneToolSearch: boolean
  provider: APIProvider
  model?: string
}): ToolSearchRequestTransports {
  return {
    useToolSearch:
      options.useToolSearch &&
      providerSupportsAnthropicToolSearch(options.provider),
    useNativeLaneToolSearch:
      options.useNativeLaneToolSearch &&
      (options.model === undefined ||
        providerModelSupportsClientSideToolDiscovery(
          options.provider,
          options.model,
        )),
  }
}

export function selectToolsForToolSearchRequest(
  tools: Tools,
  options: {
    useToolSearch: boolean
    useNativeLaneToolSearch: boolean
    deferredToolNames: ReadonlySet<string>
    discoveredToolNames: ReadonlySet<string>
    provider: APIProvider
    model?: string
  },
): Tools {
  // Never trust a caller's transport booleans beyond the provider/model route
  // they were computed for. In particular, Groq small-tier models remove
  // ToolSearch in their transformer. If an optimistic/server-style boolean
  // leaked through here, filtering first would strand every deferred schema:
  // WebFetch/MCP would be removed upstream and ToolSearch downstream.
  const routedTransports = resolveToolSearchRequestTransports(options)

  // Client-side/native lanes own physical schema omission. Keep their full
  // source pool here so the lane can:
  //   1. apply its provider/model filter first,
  //   2. fall back to every surviving schema if ToolSearch is unavailable,
  //   3. append newly discovered schemas in stable first-load order.
  // Filtering here used to permanently discard the hidden definitions before
  // the lane saw them, making an eager fallback impossible.
  if (routedTransports.useNativeLaneToolSearch) {
    return tools
  }

  if (routedTransports.useToolSearch && options.provider === 'firstParty') {
    return tools
  }

  if (routedTransports.useToolSearch) {
    return tools.filter(tool => {
      if (!options.deferredToolNames.has(tool.name)) return true
      if (tool.name === TOOL_SEARCH_TOOL_NAME) return true
      return options.discoveredToolNames.has(tool.name)
    })
  }

  return tools.filter(tool => tool.name !== TOOL_SEARCH_TOOL_NAME)
}
