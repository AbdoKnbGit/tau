/**
 * What the model is told about terminal diagrams (the `mermaidDiagrams`
 * setting, "Draw diagrams" in /config).
 *
 * The announcement is a persisted attachment rather than a system prompt
 * section: it is appended to the conversation whenever the setting differs
 * from what the model was last told. Switching it mid-session therefore
 * reaches the model on its next turn, for every provider, without changing any
 * cached prefix; the system prompt is the same with the setting on or off.
 * After compaction the scan finds no announcement and it is sent again.
 */

type MessageLike = {
  type: string
  attachment?: { type: string; enabled?: boolean }
}

/** The diagrams state this conversation was last told about. */
export function getAnnouncedMermaidDiagrams(
  messages: readonly MessageLike[],
): boolean {
  let announced = false
  for (const message of messages) {
    if (
      message.type === 'attachment' &&
      message.attachment?.type === 'mermaid_diagrams'
    ) {
      announced = message.attachment.enabled === true
    }
  }
  return announced
}

/** The state to announce now, or null when the conversation already knows it. */
export function getMermaidDiagramsChange(
  enabled: boolean,
  messages: readonly MessageLike[],
): boolean | null {
  return enabled === getAnnouncedMermaidDiagrams(messages) ? null : enabled
}

export function getMermaidDiagramsReminder(enabled: boolean): string {
  if (!enabled) {
    return `# Diagrams
Diagram drawing is now off: mermaid blocks in your replies are shown as plain source. Only write mermaid when the user asks for it.`
  }
  return `# Diagrams
Tau draws \`\`\`mermaid blocks in your replies as diagrams right in the terminal, so show rather than tell: whenever you explain how something works or fits together (a flow, the steps of a process, an architecture, a sequence of calls, a state machine, a data model, how options compare), include a small diagram with a short plain-language description of it, rather than long code listings, ASCII art or walls of text. Skip it for one-line answers, and show code only when the user asks for code or you are writing it. Never use tools, scripts, images, browsers or files to draw diagrams.
A diagram that is too big is not drawn, so keep each one small:
- flowchart TD (top-down, not LR), sequenceDiagram, stateDiagram-v2, classDiagram or erDiagram
- at most about 12 boxes and never more than 3 side by side; labels of a few plain words, under 20 characters, with no emoji, HTML, markdown or styling (classDef, style, :::)
- put \`\`\`mermaid on its own line and close the block with \`\`\` on its own line before writing anything else; one diagram per block
- split a bigger picture into several small diagrams, each with a sentence of explanation`
}

/**
 * Sent after a reply whose diagram the terminal could not draw
 * (mermaidDiagramFeedback.ts), so the next one fits.
 */
export function getMermaidNotDrawnReminder(reasons: readonly string[]): string {
  return `# Diagrams
A diagram in your last reply could not be drawn in the terminal (${reasons.join('; ')}); the user sees only a one-line note in its place. Keep the next ones drawable: flowchart TD, sequenceDiagram, stateDiagram-v2, classDiagram or erDiagram, at most 3 boxes side by side, short plain labels, and split a big picture into several small diagrams.`
}
