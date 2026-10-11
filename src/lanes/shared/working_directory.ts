/**
 * The working directory an environment block states: "- Primary working
 * directory: <path>" in the main prompt, "Working directory: <path>" in an
 * agent's, "CWD: <path>" in cheap mode's. The main blocks state the session
 * root, which only EnterWorktree and ExitWorktree move. A system prompt is
 * built once per turn, so the rest of the turn that switched still states the
 * old directory. Freeze keys carry this value: a block frozen from that turn
 * keeps naming what it states, and the first turn that states another
 * directory freezes its own block instead of replaying the old one.
 *
 * The most specific label wins, so a "Working directory:" line quoted in a
 * memory file ahead of the environment block cannot stand in for it.
 */
const LABELS = ['Primary working directory', 'Working directory', 'CWD']
const PATTERNS = LABELS.map(label =>
  new RegExp(`^[ \\t]*(?:-[ \\t]*)?${label}:[ \\t]*(\\S[^\\r\\n]*?)[ \\t]*$`, 'm'))

export function statedWorkingDirectory(text: string): string | undefined {
  for (const pattern of PATTERNS) {
    const directory = pattern.exec(text)?.[1]
    if (directory) return directory
  }
  return undefined
}
