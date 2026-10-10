/**
 * The working directory an environment block states: "- Primary working
 * directory: <path>" in the main prompt, "Working directory: <path>" in an
 * agent's. EnterWorktree and ExitWorktree change it, but a system prompt is
 * built once per turn, so the rest of the turn that switched still states the
 * old directory. Freeze keys carry this value: a block frozen from that turn
 * keeps naming what it states, and the first turn that states another
 * directory freezes its own block instead of replaying the old one.
 */
export function statedWorkingDirectory(text: string): string | undefined {
  return /^[ \t]*(?:-[ \t]*)?(?:Primary working directory|Working directory):[ \t]*(\S[^\r\n]*?)[ \t]*$/m
    .exec(text)?.[1]
}
