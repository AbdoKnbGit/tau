/**
 * What each model turn proceeds with, for `turn.start`'s `text`. The prompt
 * pipeline notes the prompt once it has settled (after `prompt.submit` and
 * the UserPromptSubmit hooks) on the user messages that start the turn; the
 * Agent tool notes a subagent run's prompt by the agent's id. A leaf module,
 * so neither of them pulls the mod runtime in. A note nobody takes (no turn
 * followed, no mod hooks turn.start) is pushed out by newer ones.
 */
const KEPT = 64
const byMessage = new Map<string, string>()
const byAgent = new Map<string, string>()

function keep(notes: Map<string, string>, key: string, text: string): void {
  notes.delete(key)
  notes.set(key, text)
  while (notes.size > KEPT) notes.delete(notes.keys().next().value as string)
}

function take(notes: Map<string, string>, key: string): string | undefined {
  const text = notes.get(key)
  if (text !== undefined) notes.delete(key)
  return text
}

/** The prompt a main-loop turn begins with, on the user messages carrying it. */
export function noteModTurnText(messages: readonly { type: string; uuid?: string }[], text: string): void {
  for (const message of messages)
    if (message.type === 'user' && typeof message.uuid === 'string') keep(byMessage, message.uuid, text)
}

/** The prompt a subagent's next run begins with: its Agent call's, or the message that resumed it. */
export function noteModAgentTurnText(agentId: string, text: string): void {
  keep(byAgent, agentId, text)
}

export const takeModTurnText = (uuid: string): string | undefined => take(byMessage, uuid)
export const takeModAgentTurnText = (agentId: string): string | undefined => take(byAgent, agentId)
