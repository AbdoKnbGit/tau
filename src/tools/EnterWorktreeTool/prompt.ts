export function getEnterWorktreeToolPrompt(): string {
  return `Create an isolated git worktree ONLY when the user explicitly asks for a "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree"). For requests to create/switch/work on a different branch, use git commands. For bugs/features, use normal git workflow unless they specifically mention worktrees.

Requires a git repository OR WorktreeCreate/WorktreeRemove hooks in settings.json; must not already be in a worktree.

- In git: creates a worktree in \`.claude/worktrees/\` with a new branch based on HEAD. Outside git: delegates to those hooks for VCS-agnostic isolation.
- Switches the session's working directory to the new worktree.
- ExitWorktree leaves mid-session (keep/remove). If still there at session exit, the user is prompted to keep/remove it.
- Optional \`name\`: worktree name; generates a random name when omitted.
`
}
