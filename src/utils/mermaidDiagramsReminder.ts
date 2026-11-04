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
  attachment?: { type: string; enabled?: boolean; guidance?: string }
}

function lastAnnouncement(messages: readonly MessageLike[]) {
  return messages.findLast(message =>
    message.type === 'attachment' && message.attachment?.type === 'mermaid_diagrams',
  )?.attachment
}

/** The diagrams state this conversation was last told about. */
export function getAnnouncedMermaidDiagrams(
  messages: readonly MessageLike[],
): boolean {
  return lastAnnouncement(messages)?.enabled === true
}

/** The state to announce now, or null when the conversation already knows it. */
export function getMermaidDiagramsChange(
  enabled: boolean,
  messages: readonly MessageLike[],
): boolean | null {
  const last = lastAnnouncement(messages)
  if (enabled !== (last?.enabled === true)) return enabled
  // A resumed conversation gets updated instructions once, appended to history.
  if (enabled && last?.guidance !== getMermaidDiagramsReminder(true)) return true
  return null
}

export function getMermaidDiagramsReminder(enabled: boolean): string {
  if (!enabled) return legacyMermaidDiagramsReminder(false)
  return `# Diagrams
Tau can draw a small Mermaid diagram in a terminal reply. Use one when the picture answers the user's question more clearly, or when requested. A direct answer, code edit or status update usually needs only prose. Give a short plain-language description of what to notice.
- Choose flowchart TD for paths or decisions (A[Request] --> B[Cache]); sequenceDiagram for who calls whom (Client->>API: Request); stateDiagram-v2 for a lifecycle; classDiagram for types and inheritance; erDiagram for data relationships.
- For numeric comparisons use xychart-beta with one statement per line, for example x-axis [Mon, Tue] followed by bar [10, 20]. For trends use line [10, 20]. Match the number of values to the categories. Keep to 32 points and 4 series or fewer.
- For proportions use pie followed by lines like "Ready" : 3. Values must be nonnegative and the total positive. The terminal shows shares as bars and percentages. For a schedule use gantt, then dateFormat YYYY-MM-DD, then tasks such as Build :b, 2026-01-01, 2d and Test :after b, 1d. Use calendar days; omit exclusions and custom axis formats.
- Put \`\`\`mermaid and the closing fence each on its own line. Prefer a top-down flow, at most about 12 boxes and never more than 3 side by side. Use short plain labels under 20 characters, no emoji, HTML, markdown styling or click directives. Split a bigger picture into small diagrams. Never use tools to produce an inline diagram.`
}

/** Reproduce the previous build's prompt bytes when replaying older attachments. */
export function legacyMermaidDiagramsReminder(enabled: boolean): string {
  if (!enabled) {
    return `# Diagrams
Diagram drawing is now off: mermaid blocks in your replies are shown as plain source. Only write mermaid when the user asks for it.`
  }
  return `# Diagrams
Tau draws \`\`\`mermaid blocks in your replies as diagrams right in the terminal, so show rather than tell: whenever you explain how something works or fits together (a flow, the steps of a process, an architecture, a sequence of calls, a state machine, a data model, how options compare), include a small diagram with a short plain-language description of it, rather than long code listings, ASCII art or walls of text. Skip it for one-line answers, and show code only when the user asks for code or you are writing it. Never use tools, scripts, images, browsers or files to draw diagrams.
A diagram that is too big is not drawn, so keep each one small:
- flowchart TD (top-down, not LR), sequenceDiagram, stateDiagram-v2, classDiagram or erDiagram
- small numeric xychart-beta bar/line charts (at most 32 points, 4 series), pie shares, or gantt schedules with dateFormat YYYY-MM-DD, ISO dates and durations such as 2d; gantt dependencies may use after an earlier task ID. Pie shares draw as proportional bars with exact values and percentages. Keep chart syntax simple: no horizontal xychart, calendar exclusions, custom axis formats or interactions
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
A diagram in your last reply could not be drawn in the terminal (${reasons.join('; ')}); the user sees only a one-line note in its place. Keep the next ones drawable: flowchart TD, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, small xychart-beta bar/line charts, pie shares, or simple gantt schedules with ISO dates (YYYY-MM-DD). Use short plain labels, at most 3 boxes side by side in flows, and split a big picture into several small diagrams. Charts use a limited grammar; remove advanced directives rather than repeating unsupported syntax.`
}
