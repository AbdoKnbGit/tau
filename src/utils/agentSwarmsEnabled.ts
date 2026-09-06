/**
 * Retired gate for the agent teams / teammate ("swarm") feature.
 *
 * The feature is being removed. This stays as the single choke point during
 * that removal: every teammate code path in the tree is reachable only through
 * this predicate, so pinning it to `false` makes all of them provably dead
 * before any of them are deleted. That ordering is deliberate — it turns the
 * deletion into removal of unreachable code rather than surgery on live paths,
 * and it keeps the behavior change (the feature going away) in its own small,
 * revertable commit, separate from the large mechanical one that follows.
 *
 * What was here before: an opt-in via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
 * or `--agent-teams`, plus a remote killswitch. Both are gone along with the
 * flag itself, so nothing can turn teammates back on.
 *
 * Callers are removed as the teammate code is deleted; when the last one goes,
 * so does this file.
 */
export function isAgentSwarmsEnabled(): boolean {
  return false
}
