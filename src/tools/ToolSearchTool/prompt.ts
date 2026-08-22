import { feature } from 'bun:bundle'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { Tool } from '../../Tool.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getPowerModeFromSettings } from '../../utils/powerMode.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { shouldDisableToolDeferralForProvider } from '../../utils/toolDeferralPolicy.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'

// Dead code elimination: Brief tool name only needed when KAIROS or KAIROS_BRIEF is on
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../BriefTool/prompt.js') as typeof import('../BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('../SendUserFileTool/prompt.js') as typeof import('../SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

export { TOOL_SEARCH_TOOL_NAME } from './constants.js'

import { TOOL_SEARCH_TOOL_NAME } from './constants.js'

const PROMPT_HEAD = `Loads callable schemas for deferred tools. `

// Matches isDeferredToolsDeltaEnabled in toolSearch.ts (not imported —
// toolSearch.ts imports from this file). When enabled: tools announced
// via system-reminder attachments. When disabled: prepended
// <available-deferred-tools> block (pre-gate behavior).
function getToolLocationHint(): string {
  const deltaEnabled =
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  return deltaEnabled
    ? 'Their names and short intents appear in <system-reminder> messages.'
    : 'Their names and short intents appear in <available-deferred-tools> messages.'
}

const PROMPT_TAIL = ` Load before calling: the intent list is not a parameter schema. A call made without the schema still runs when its arguments happen to match, but any parameter the schema does not define is rejected rather than ignored. Batch related exact names to avoid repeated cache re-warms.

Queries: "select:Read,Edit,Grep" for exact names; "notebook jupyter" for keywords; "+slack send" to require a term.`

/**
 * Check if a tool should be deferred (requires ToolSearch to load).
 * A tool is deferred if:
 * - It's an MCP tool (always deferred - workflow-specific)
 * - It has shouldDefer: true
 *
 * A tool is NEVER deferred if it has alwaysLoad: true (MCP tools set this via
 * _meta['anthropic/alwaysLoad']). This check runs first, before any other rule.
 */
export function isDeferredTool(tool: Tool): boolean {
  // Provider gate. Deferral is enabled only for Anthropic's native discovery
  // transport or a Tau lane with a verified client-side implementation. Every
  // other/dedicated provider receives eager schemas. The central policy also
  // keeps cheap client-native lanes eager for prefix-cache stability while
  // retaining server-native deferral, whose physical tool block stays fixed.
  const powerMode = getPowerModeFromSettings(getInitialSettings())
  if (shouldDisableToolDeferralForProvider(getAPIProvider(), powerMode)) {
    return false
  }

  // Explicit opt-out via _meta['anthropic/alwaysLoad'] — tool appears in the
  // initial prompt with full schema. Checked first so MCP tools can opt out.
  if (tool.alwaysLoad === true) return false

  // MCP tools are always deferred (workflow-specific)
  if (tool.isMcp === true) return true

  // Never defer ToolSearch itself — the model needs it to load everything else
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  // Fork-first experiment: Agent must be available turn 1, not behind ToolSearch.
  // Lazy require: static import of forkSubagent → coordinatorMode creates a cycle
  // through constants/tools.ts at module init.
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    type ForkMod = typeof import('../AgentTool/forkSubagent.js')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('../AgentTool/forkSubagent.js') as ForkMod
    if (m.isForkSubagentEnabled()) return false
  }

  // Brief is the primary communication channel whenever the tool is present.
  // Its prompt contains the text-visibility contract, which the model must
  // see without a ToolSearch round-trip. No runtime gate needed here: this
  // tool's isEnabled() IS isBriefEnabled(), so being asked about its deferral
  // status implies the gate already passed.
  if (
    (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
    BRIEF_TOOL_NAME &&
    tool.name === BRIEF_TOOL_NAME
  ) {
    return false
  }

  // SendUserFile is a file-delivery communication channel (sibling of Brief).
  // Must be immediately available without a ToolSearch round-trip.
  if (
    feature('KAIROS') &&
    SEND_USER_FILE_TOOL_NAME &&
    tool.name === SEND_USER_FILE_TOOL_NAME &&
    isReplBridgeActive()
  ) {
    return false
  }

  return tool.shouldDefer === true
}

/**
 * Format a compact discovery catalog entry. Name-only entries encouraged
 * weaker models to call hidden tools with guessed parameters. A one-line
 * intent provides enough routing signal while keeping the parameter schema
 * deferred. MCP metadata is untrusted, so normalize and cap it here even when
 * an upstream adapter already sanitized it.
 */
export const MAX_DEFERRED_TOOL_INTENT_CHARS = 120

function normalizeDeferredToolIntent(intent: string): string {
  // Catalog lines are embedded inside an XML-ish system-reminder wrapper.
  // Reject delimiter characters instead of escaping them: escaping can grow a
  // 10k untrusted MCP hint before the cap is applied, and truncating an entity
  // can leave a raw `&` at the boundary. Removing the three delimiters first
  // keeps the cap deterministic and makes closing-tag injection impossible.
  const normalized = intent
    .replace(/[<>&]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ')
    .trim()
  const characters = Array.from(normalized)
  if (characters.length <= MAX_DEFERRED_TOOL_INTENT_CHARS) return normalized
  return `${characters.slice(0, MAX_DEFERRED_TOOL_INTENT_CHARS - 1).join('')}…`
}

export function formatDeferredToolLine(tool: Tool): string {
  const inferredIntent = tool.name
    .replace(/^mcp__/, '')
    .replace(/__/g, ' via ')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  // MCP metadata is controlled by an external server. The callable name is
  // already enough to infer a compact intent, so never place its searchHint in
  // model-visible XML. Built-in hints are still normalized defensively.
  const isUntrustedMcpTool = tool.isMcp === true || tool.name.startsWith('mcp__')
  const explicitIntent = !isUntrustedMcpTool && tool.searchHint
    ? normalizeDeferredToolIntent(tool.searchHint)
    : ''
  return `${tool.name} — ${explicitIntent || normalizeDeferredToolIntent(inferredIntent)}`
}

export function getPrompt(): string {
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL
}
