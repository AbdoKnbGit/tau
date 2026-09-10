/**
 * How full the context window is, as both status rows report it.
 *
 * Tau has two rows that show this: the built-in session bar
 * (PromptInputStatusBar) and a user's `statusLine` command, which receives it
 * as `context_window` JSON. They used to be computed separately and drifted:
 * the command got the provider's count of the last prompt, while the bar
 * estimated the conversation text alone and left out the system prompt, tool
 * schemas, MCP servers, skills and memory. A fresh install with no custom
 * command therefore showed a fraction of the real figure. Both rows now read
 * this one function, so they cannot disagree.
 *
 * Nothing here depends on the platform or the provider. The count is whatever
 * the provider metered for the last request; the window is whatever
 * getContextWindowForModel resolves for the model actually running.
 */

import { getSdkBetas } from '../bootstrap/state.js'
import { roughTokenCountEstimationForMessages } from '../services/tokenEstimation.js'
import type { Message } from '../types/message.js'
import {
  calculateContextPercentages,
  getContextWindowForModel,
  promptTokenCount,
} from './context.js'
import {
  applyInitialContextFloor,
  type ContextUsage,
  getContextBaselineTokens,
} from './contextBaseline.js'
import { getMessagesAfterCompactBoundary } from './messages.js'
import { getCurrentUsage } from './tokens.js'

export type SessionContextUsage = {
  /** Window the percentages are measured against. */
  contextWindowSize: number
  /**
   * The provider's usage for the last request, or the measured initial
   * context while no request has been answered yet. Null when neither exists.
   */
  currentUsage: ContextUsage | null
  /** Prompt tokens in `currentUsage`; null while it is unknown. */
  usedTokens: number | null
  usedPercentage: number | null
  remainingPercentage: number | null
}

/**
 * Context usage for this session, against the model that actually runs.
 *
 * `runtimeModel` must come from getRuntimeMainLoopModel rather than the
 * configured model: under opusplan they differ, and the initial-context
 * measurement is keyed by the runtime one.
 */
export function getSessionContextUsage(
  messages: Message[],
  runtimeModel: string,
): SessionContextUsage {
  // Only what the next request will carry. Fullscreen keeps the messages
  // before a compact boundary for scrollback, and the last usage among them
  // describes a context the summary has since replaced.
  const liveMessages = getMessagesAfterCompactBoundary(messages)
  const currentUsage = applyInitialContextFloor(
    getCurrentUsage(liveMessages),
    getContextBaselineTokens(runtimeModel),
    () => roughTokenCountEstimationForMessages(liveMessages),
  )
  const contextWindowSize = getContextWindowForModel(
    runtimeModel,
    getSdkBetas(),
  )
  const { used, remaining } = calculateContextPercentages(
    currentUsage,
    contextWindowSize,
  )
  return {
    contextWindowSize,
    currentUsage,
    usedTokens: currentUsage ? promptTokenCount(currentUsage) : null,
    usedPercentage: used,
    remainingPercentage: remaining,
  }
}
