/**
 * Cache-safe lazy-tool selection, shared by the Gemini and OpenAI-compat lanes.
 *
 * Anthropic keeps every tool in the request and lets the SERVER hide the ones
 * flagged `defer_loading`, so its tool block is byte-identical every turn and
 * prompt caching never breaks when ToolSearch loads a tool. The native lanes
 * have no server-side defer, so they physically drop undiscovered tools — which
 * puts the tool block's bytes under our control and makes ORDER a caching
 * concern. This module owns that ordering so it can't drift between lanes.
 *
 * Unlike server-native tail injection, appending a definition to a front-of-
 * request tools array causes one expected cache re-warm for the system/history
 * that follows it. Append-only ordering still matters: it preserves the entire
 * previous tool-array prefix, prevents repeated churn, and makes every loaded
 * set stable from the next turn onward.
 */

import type {
  ProviderContentBlock,
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/constants.js'

/**
 * `ENABLE_TOOL_SEARCH=auto:100` means "never defer" — the native lazy paths
 * treat it the same as an explicit disable.
 */
export function isAutoHundred(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.toLowerCase().trim()
  if (!normalized.startsWith('auto:')) return false
  return Number.parseInt(normalized.slice(5), 10) === 100
}

/**
 * A provider tool is deferred when the schema builder tagged it — either the
 * non-enumerable `__tau_should_defer` marker (set in utils/api.ts, preserved by
 * reference through providerShim) or the enumerable `defer_loading` flag. Either
 * means "hide until ToolSearch loads it".
 */
export function isDeferredProviderTool(tool: ProviderTool): boolean {
  const marker = (tool as { __tau_should_defer?: unknown }).__tau_should_defer
  if (marker === true) return true
  if ((tool as { defer_loading?: unknown }).defer_loading === true) return true
  return false
}

function blockToolName(block: ProviderContentBlock): string | undefined {
  return typeof block.name === 'string' && block.name.length > 0
    ? block.name
    : undefined
}

/**
 * Every tool the model has already touched this conversation, in FIRST-USE
 * order. A JS `Set` preserves insertion order and history is scanned
 * front-to-back, so iterating the result yields the order tools were first
 * loaded — which {@link selectLazyToolsForRequest} relies on to stay
 * append-only.
 *
 * Sources: `tool_use` blocks (the model called the tool directly) and
 * `tool_reference` items inside a ToolSearch `tool_result` (the model loaded the
 * tool for later use).
 */
export function extractLoadedToolNames(
  messages: ProviderMessage[],
): Set<string> {
  const loaded = new Set<string>()

  for (const msg of messages) {
    const carried = compactBoundaryToolNames(msg)
    if (carried) {
      for (const name of carried) loaded.add(name)
      continue
    }

    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const name = blockToolName(block)
        if (name) loaded.add(name)
        continue
      }

      if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
        continue
      }

      for (const item of block.content) {
        if (
          item &&
          typeof item === 'object' &&
          (item as { type?: unknown }).type === 'tool_reference' &&
          typeof (item as { tool_name?: unknown }).tool_name === 'string'
        ) {
          loaded.add((item as { tool_name: string }).tool_name)
        }
      }
    }
  }

  return loaded
}

function compactBoundaryToolNames(message: unknown): string[] | null {
  if (!message || typeof message !== 'object') return null
  const record = message as {
    type?: unknown
    subtype?: unknown
    compactMetadata?: { preCompactDiscoveredTools?: unknown }
  }
  if (record.type !== 'system' || record.subtype !== 'compact_boundary') {
    return null
  }
  const names = record.compactMetadata?.preCompactDiscoveredTools
  if (!Array.isArray(names)) return null
  return names.filter((name): name is string => typeof name === 'string')
}

// First-load order per session. History is the primary record of which tools
// loaded, but it is not durable: compaction (and microcompaction's tool-result
// clearing) can erase the tool_use / tool_reference evidence. Without this
// registry a previously-appended tool would silently vanish from the request —
// rewriting the tool block mid-array (cache break) AND taking a tool away from
// the model that it already loaded. Entries are append-only for the life of
// the process, which matches the lifetime of the provider-side prefix cache.
const _loadedOrderBySession = new Map<string, string[]>()

/**
 * Merge history-derived loads into the session's sticky first-load registry
 * and return the union in first-load order. Monotonic: once a tool has been
 * appended to a session's tool block it stays appended, even if the history
 * evidence is later compacted away. Callers without a session key get the
 * plain history-derived set (no cross-conversation bleed).
 */
export function stickyLoadedToolNames(
  sessionKey: string | undefined,
  discovered: Set<string>,
): Set<string> {
  if (!sessionKey) return discovered

  let order = _loadedOrderBySession.get(sessionKey)
  if (!order) {
    order = []
    _loadedOrderBySession.set(sessionKey, order)
    if (_loadedOrderBySession.size > 256) {
      const oldest = _loadedOrderBySession.keys().next().value
      if (oldest !== undefined) _loadedOrderBySession.delete(oldest)
    }
  }
  for (const name of discovered) {
    if (!order.includes(name)) order.push(name)
  }
  return new Set(order)
}

export function _resetStickyLoadedToolsForTest(): void {
  _loadedOrderBySession.clear()
}

/**
 * Reduce the tool list to the cacheable lazy set WITHOUT breaking the provider's
 * prompt-cache prefix.
 *
 * The tool block is serialized at the FRONT of the cached prefix (before the
 * conversation on Gemini; ahead of the messages on OpenAI-compat), so any change
 * to its bytes cold-starts everything after it. The block therefore must only
 * ever grow by APPENDING — never insert or reorder. This achieves that by:
 *
 *   1. Rendering the stable base (ToolSearch + every non-deferred tool) first in
 *      the caller's original order — byte-identical every turn.
 *   2. Appending discovered deferred tools in LOAD order, not array-index order.
 *      Load order is inherently append-only: a tool discovered on a later turn
 *      can only land after tools discovered earlier, so nothing already sent
 *      shifts position. (Array-index order would let a low-index tool discovered
 *      late jump ahead of an already-sent high-index tool and void the prefix —
 *      exactly what the plain `tools.filter()` did, because deferred tools like
 *      WebBrowser/LSP/MCP are interleaved with core tools in the source list.)
 *
 * Between ToolSearch calls the block is byte-stable. A load turn appends one
 * cold tail and may re-warm later request sections because native providers put
 * tools before history; previously loaded definitions are never removed or
 * reordered, so the re-warm happens at most once per newly loaded batch.
 */
export function selectLazyToolsForRequest(
  tools: ProviderTool[],
  loadedToolNames: Set<string>,
): ProviderTool[] {
  const base: ProviderTool[] = []
  const deferredByName = new Map<string, ProviderTool>()

  for (const tool of tools) {
    if (tool.name !== TOOL_SEARCH_TOOL_NAME && isDeferredProviderTool(tool)) {
      deferredByName.set(tool.name, tool)
    } else {
      base.push(tool)
    }
  }

  // No deferrable tools → nothing to hide; keep the caller's array as-is.
  if (deferredByName.size === 0) return tools

  const appended: ProviderTool[] = []
  for (const name of loadedToolNames) {
    const tool = deferredByName.get(name)
    if (tool) appended.push(tool)
  }

  return appended.length > 0 ? [...base, ...appended] : base
}
