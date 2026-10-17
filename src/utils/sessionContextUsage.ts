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
 * The count does not depend on the platform. The count is whatever
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
import { getAPIProvider, type APIProvider } from './model/providers.js'

// These providers can publish content before the request's usage is measured.
// Keep this display policy explicit; other providers retain their existing policy.
const KEEP_LAST_MEASURED_USAGE_PROVIDERS = new Set<APIProvider>([
  'openai', 'openrouter', 'opencode', 'opencodego', 'mistral',
  'commandcode', 'deepseek', 'glm', 'moonshot', 'minimax', 'alibaba', 'groq', 'nim',
  'xai', 'meta', 'mimo', 'lxd', 'fireworks', 'cloudflare', 'vercel', 'requesty',
  'modelrouter', 'agentrouter', 'ollama', 'lmstudio', 'cline', 'clinepass',
  'copilot', 'cursor', 'iflow', 'kilocode', 'kiro',
])

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
  // A provisional zero is not a new prompt measurement. For the opted-in
  // providers, retain the last measured usage until trailing usage arrives.
  // getCurrentUsage still accepts genuine smaller measurements, including
  // fully cached prompts, and never reuses usage from before compaction.
  const provider = getAPIProvider()
  const currentUsage = applyInitialContextFloor(
    getCurrentUsage(liveMessages, {
      skipUnmeasured: KEEP_LAST_MEASURED_USAGE_PROVIDERS.has(provider),
    }),
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
