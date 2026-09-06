/**
 * Write-ownership claims between concurrently running subagents.
 *
 * Two subagents editing one file do not corrupt it — Edit, Write and
 * NotebookEdit each carry a staleness guard, so the loser's write is refused
 * rather than applied over the winner's. What they do is waste a whole turn:
 * the loser reads the file, reasons about it, calls its tool, and only then
 * learns it lost — via "File has been modified since read", which does not say
 * who moved it or that another agent is involved at all. Writes issued through
 * Bash carry no staleness guard, so there the loser can clobber outright.
 *
 * So: the first subagent to write a path owns it for as long as that agent
 * runs. A different subagent writing the same path is refused immediately and
 * told which agent holds it.
 *
 * Deliberately a refusal, not a lock. `writeTextContent` is synchronous, and
 * its callers document that a yield between the staleness check and the write
 * lets concurrent edits interleave — so there is nothing safe to await on
 * without reopening exactly the window the staleness check exists to close. A
 * refused agent gets an actionable error on the spot instead of blocking, and
 * there is no queue to deadlock.
 *
 * Scope is deliberately narrow:
 * - Only subagents claim, and only subagents are refused. The main session is
 *   the coordinator; it is never blocked and never claims, so no ordinary
 *   single-agent workflow can change behavior.
 * - Enforcement engages only while two or more subagents are running. With one
 *   agent — the overwhelmingly common case — the map is never consulted.
 * - Reads are untouched. Only the write path consults claims.
 *
 * Nothing here reaches the model: no tool schema, description, or system-prompt
 * text changes. Enforcement lives entirely in the write path, so every provider
 * behaves identically and no prompt cache is affected.
 */
import { isAbsolute, resolve } from 'node:path'
import { getAgentContext } from './agentContext.js'

interface FileClaim {
  agentId: string
  /** The `name` the spawn was given, when it had one — better than a raw id in the refusal. */
  label?: string
}

/** path key -> owning subagent */
const claims = new Map<string, FileClaim>()
/** Subagents currently running, by agentId. Value is the display label. */
const activeAgents = new Map<string, string | undefined>()

/**
 * Case-insensitive on Windows because NTFS is: two agents writing `Src/App.ts`
 * and `src/app.ts` are writing one file, and a case-sensitive key would let
 * both claim it.
 */
function claimKey(filePath: string): string {
  const absolute = isAbsolute(filePath) ? filePath : resolve(filePath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** The running subagent on this async execution chain, if any. */
function currentSubagentId(): string | undefined {
  const context = getAgentContext()
  if (!context) return undefined
  return typeof context.agentId === 'string' && context.agentId.length > 0
    ? context.agentId
    : undefined
}

/** Register a subagent as running. Call when its execution scope opens. */
export function beginAgentFileScope(agentId: string, label?: string): void {
  if (!agentId) return
  activeAgents.set(agentId, label)
}

/**
 * Drop a subagent's registration and every claim it held. Call from the same
 * `finally` that clears the agent's other per-run state, so an agent that
 * throws or is aborted never strands a claim.
 */
export function endAgentFileScope(agentId: string): void {
  if (!agentId) return
  activeAgents.delete(agentId)
  for (const [key, claim] of claims) {
    if (claim.agentId === agentId) claims.delete(key)
  }
}

/**
 * Claim `filePath` for the calling subagent, or return the conflicting owner's
 * label when a different running subagent already holds it.
 *
 * Self-healing: a claim whose owner is no longer registered is stale (a run
 * that ended without its `finally`, in principle) and is taken over rather than
 * blocking forever.
 */
function acquire(filePath: string): { conflictWith: string } | undefined {
  const agentId = currentSubagentId()
  // Not a subagent (main session), or fewer than two agents in flight: nothing
  // can race, so never touch the map.
  if (!agentId || activeAgents.size < 2) return undefined
  // An agent whose scope was never opened is not part of the concurrent set.
  if (!activeAgents.has(agentId)) return undefined

  const key = claimKey(filePath)
  const existing = claims.get(key)
  if (existing && existing.agentId !== agentId) {
    if (activeAgents.has(existing.agentId)) {
      return { conflictWith: existing.label ?? existing.agentId }
    }
    // Owner is gone — its claim cannot be load-bearing any more.
  }

  claims.set(key, { agentId, label: activeAgents.get(agentId) })
  return undefined
}

/**
 * Enforce write ownership for `filePath`, throwing when another running
 * subagent owns it. Called from the single write choke point, so it covers
 * Edit, Write, NotebookEdit and Bash-issued writes alike.
 */
export function enforceAgentFileClaim(filePath: string): void {
  const conflict = acquire(filePath)
  if (!conflict) return
  throw new Error(
    `Another agent ("${conflict.conflictWith}") is already writing ${filePath} and owns it until it finishes. ` +
      `Do not edit this file: parallel agents must work on disjoint files. ` +
      `Report what you needed to change here and let the caller sequence it, or work on a file no other agent owns.`,
  )
}

/** Test-only: drop all registrations and claims. */
export function _resetAgentFileClaimsForTest(): void {
  claims.clear()
  activeAgents.clear()
}

/**
 * Test-only: deregister an agent while leaving its claims behind — the
 * "cleanup never ran" shape the self-healing path in {@link acquire} exists to
 * survive. Not reachable in production: every run site releases through
 * {@link endAgentFileScope}, which drops both.
 */
export function _orphanAgentForTest(agentId: string): void {
  activeAgents.delete(agentId)
}

/** Test-only: inspect the current owner label for a path. */
export function _ownerLabelForTest(filePath: string): string | undefined {
  const claim = claims.get(claimKey(filePath))
  return claim ? (claim.label ?? claim.agentId) : undefined
}
