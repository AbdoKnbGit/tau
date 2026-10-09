export function getExitWorktreeToolPrompt(): string {
  return `Exit ONLY the worktree created by EnterWorktree in this session, restoring the original working directory. Call only when the user explicitly asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session; never proactively.

Never touches manually created worktrees (\`git worktree add\`), previous-session worktrees (including EnterWorktree ones), or the current directory if EnterWorktree was never called. Without an active EnterWorktree session, this is a **no-op**: reports no active worktree session and changes no filesystem state.

Parameters:
- Required \`action\`: \`"keep"\` preserves directory and branch on disk for later work or changes to preserve; \`"remove"\` deletes both for a clean exit when work is done or abandoned.
- \`discard_changes\` (optional, default false) only applies to \`action: "remove"\`. Uncommitted files or commits not on the original branch block removal unless \`true\`. After an error listing changes, confirm with the user before retrying with \`discard_changes: true\`.

Behavior:
- Clears CWD-dependent caches (system prompt sections, memory files, plans directory) to reflect the original directory.
- Attached tmux session: killed on \`remove\`, left running on \`keep\` with its name returned for reattachment.
- After exit, EnterWorktree can create a fresh worktree.
`
}
