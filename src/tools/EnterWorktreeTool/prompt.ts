export function getEnterWorktreeToolPrompt(): string {
  return `Create an isolated git worktree ONLY when the user explicitly asks for a "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree"). For requests to create/switch/work on a different branch, use git commands. For bugs/features, use normal git workflow unless they specifically mention worktrees.

Requires a git repository OR WorktreeCreate/WorktreeRemove hooks in settings.json; must not already be in a worktree entered by this session.

- In git: creates a worktree in the main repository's \`.claude/worktrees/\`. By default the new branch starts from the caller's current HEAD, including unpushed commits but excluding uncommitted changes. With \`worktree.base: "remote-default"\` in settings (/config: Worktree base), it instead fetches the configured remote's current default branch (origin by default); fetch failure is an error, never a cached fallback. The result reports the actual starting commit. Outside git: delegates to those hooks for VCS-agnostic isolation.
- An existing named worktree is resumed at its own current commit; changing Worktree base only affects new worktrees.
- Configured WorktreeCreate hooks take precedence, including inside git, and control their own starting point.
- Switches the session's working directory to the new worktree.
- ExitWorktree leaves mid-session (keep/remove). If still there at session exit, the user is prompted to keep/remove it.
- Optional \`name\`: worktree name; generates a random name when omitted.
`
}
