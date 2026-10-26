import { feature } from 'bun:bundle'
import partition from 'lodash-es/partition.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { CHEAP_MODE_CORE_TOOL_NAME_SET } from '../constants/cheapModeTools.js'
import { COORDINATOR_MODE_ALLOWED_TOOLS } from '../constants/tools.js'
import { isMcpTool } from '../services/mcp/utils.js'
import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'
import { getPowerModeFromSettings } from './powerMode.js'
import { filterDisabledPrebuiltTools } from './prebuiltToolToggles.js'
import type { SettingsJson } from './settings/types.js'
import { filterCurrentModTools } from './plugins/mods/tools.js'

type SettingsWithPrebuiltToolToggles = Pick<
  SettingsJson,
  'disabledPrebuiltTools' | 'powerMode'
>

// MCP tool name suffixes for PR activity subscription. These are lightweight
// orchestration actions the coordinator calls directly rather than delegating
// to workers. Matched by suffix since the MCP server name prefix may vary.
const PR_ACTIVITY_TOOL_SUFFIXES = [
  'subscribe_pr_activity',
  'unsubscribe_pr_activity',
]

export function isPrActivitySubscriptionTool(name: string): boolean {
  return PR_ACTIVITY_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

// Dead code elimination: conditional imports for feature-gated modules
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Filters a tool array to the set allowed in coordinator mode.
 * Shared between the REPL path (mergeAndFilterTools) and the headless
 * path (main.tsx) so both stay in sync.
 *
 * PR activity subscription tools are always allowed since subscription
 * management is orchestration.
 */
export function applyCoordinatorToolFilter(tools: Tools): Tools {
  return tools.filter(
    (t) =>
      COORDINATOR_MODE_ALLOWED_TOOLS.has(t.name) ||
      isPrActivitySubscriptionTool(t.name),
  )
}

/**
 * Pure function that merges tool pools and applies coordinator mode filtering.
 *
 * Lives in a React-free file so print.ts can import it without pulling
 * react/ink into the SDK module graph. The useMergedTools hook delegates
 * to this function inside useMemo.
 *
 * @param initialTools - Extra tools to include (built-in + startup MCP from props).
 * @param assembled - Tools from assembleToolPool (built-in + MCP, deduped).
 * @param mode - The permission context mode.
 * @returns Merged, deduplicated, and coordinator-filtered tool array.
 */
export function mergeAndFilterTools(
  initialTools: Tools,
  assembled: Tools,
  mode: ToolPermissionContext['mode'],
  settings: SettingsWithPrebuiltToolToggles = {},
): Tools {
  // Merge initialTools on top - they take precedence in deduplication after
  // removing optional prebuilt tools disabled mid-session via /tools.
  // initialTools may include built-in tools (from getTools() in REPL.tsx) which
  // overlap with assembled tools. uniqBy handles this deduplication.
  // Partition-sort for prompt-cache stability (same as assembleToolPool):
  // built-ins must stay a contiguous prefix for the server's cache policy.
  const filteredInitialTools = filterDisabledPrebuiltTools(
    filterCurrentModTools(initialTools),
    settings,
  )
  const [mcp, builtIn] = partition(
    uniqBy([...filteredInitialTools, ...assembled], 'name'),
    isMcpTool,
  )
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  // Cheap power mode ignores MCP entirely — even tools from servers that
  // connected before the mode switch stay out of the pool — and clamps the
  // built-in partition to the core allowlist. getTools() already applies the
  // allowlist, but initialTools captured in an earlier mode (REPL boot props,
  // SDK-provided tools) would otherwise re-introduce agents/skills/aux tools
  // after a mid-session switch to cheap.
  const cheap = getPowerModeFromSettings(settings) === 'cheap'
  const effectiveBuiltIn = cheap
    ? builtIn.filter((tool) => CHEAP_MODE_CORE_TOOL_NAME_SET.has(tool.name))
    : builtIn
  const tools = [
    ...effectiveBuiltIn.sort(byName),
    ...(cheap ? [] : mcp.sort(byName)),
  ]

  if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
    if (coordinatorModeModule.isCoordinatorMode()) {
      return applyCoordinatorToolFilter(tools)
    }
  }

  return tools
}
