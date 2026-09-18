/**
 * What a resumed subagent needs to send the request prefix its spawn sent.
 *
 * Every provider caches prompts by prefix. A resume that rebuilds the agent
 * any differently (other tool declarations, a history missing what the agent
 * saw live) re-bills the agent's whole conversation on its first resumed turn.
 *
 * Kept free of heavy imports so it stays testable on its own.
 */
import type { Tool, Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'

// ── Live conversations ──────────────────────────────────────────────────
//
// Sidechain transcripts do not keep attachment messages in external builds
// (isLoggableMessage), yet the query loop folds attachment reminders into the
// neighbouring tool_result. A history rebuilt from disk therefore differs from
// what the agent actually sent, from the first attachment on. SendMessage
// resumes run in the process that ran the agent, so keep each agent's live
// conversation for that resume. The transcript remains the fallback (another
// process, or an entry evicted by the cap).

const MAX_LIVE_CONVERSATIONS = 16
const liveConversations = new Map<string, Message[]>()

export function rememberAgentConversation(
  agentId: string,
  messages: readonly Message[],
): void {
  // Delete-then-set keeps insertion order = recency, so the cap drops the
  // agent that finished longest ago.
  liveConversations.delete(agentId)
  liveConversations.set(agentId, [...messages])
  while (liveConversations.size > MAX_LIVE_CONVERSATIONS) {
    const oldest = liveConversations.keys().next().value
    if (oldest === undefined) break
    liveConversations.delete(oldest)
  }
}

/** The conversation this agent last ran with, if this process still holds it. */
export function getAgentConversation(agentId: string): Message[] | undefined {
  const messages = liveConversations.get(agentId)
  return messages ? [...messages] : undefined
}

export function _resetAgentConversationsForTest(): void {
  liveConversations.clear()
}

// ── Tool declarations ───────────────────────────────────────────────────

/**
 * Keep every declared tool, but make the ones outside `runnable` refuse at
 * validation instead of disappearing. Dropping a declaration changes the
 * request's tool block, which is part of the cached prefix; a refusal only
 * costs a tool round if the model tries the tool anyway.
 */
export function refuseToolsOutsideRunPolicy(
  declared: Tools,
  runnable: Tools,
  refusal: string,
): Tools {
  const runnableNames = new Set(runnable.map(tool => tool.name))
  if (declared.every(tool => runnableNames.has(tool.name))) return declared
  return declared.map(tool =>
    runnableNames.has(tool.name)
      ? tool
      : ({
          ...tool,
          async validateInput() {
            return {
              result: false as const,
              message: `${tool.name} ${refusal}`,
              errorCode: 1,
            }
          },
        } as Tool),
  )
}
