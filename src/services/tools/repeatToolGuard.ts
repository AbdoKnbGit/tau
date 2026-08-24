/**
 * Repeat-tool guard.
 *
 * A model stuck in a loop re-issues the same tool call with byte-identical
 * arguments - re-running a failing grep, re-reading an unchanged file, polling
 * a command that already answered. Each round trip costs tokens, wall-clock,
 * and money without adding information, and nothing else in the loop notices.
 *
 * This guard counts consecutive identical calls and returns an advisory
 * reminder at escalating thresholds. It NEVER blocks, delays, or rewrites a
 * call - the model decides whether to change course or finish. The reminder is
 * appended to that call's own tool_result, so it lands after the result in
 * model order and never disturbs the cached request prefix.
 *
 * Two deliberate rules, both load-bearing:
 *
 *   - Untracked tools are TRANSPARENT to the chain, not resets. A call to an
 *     excluded bookkeeping tool neither increments nor resets the counter, so
 *     `Grep X -> TodoWrite -> Grep X` still counts as two consecutive `Grep X`.
 *     Without this, interleaving a bookkeeping call launders the loop.
 *   - Chains are keyed per agent. Subagents share one tool pipeline, so a
 *     global counter would let one agent's calls reset another's chain.
 */

/** Consecutive-identical counts that emit a reminder. */
const THRESHOLDS = [3, 5, 8] as const

/** Cap on argument text quoted back in the detailed reminder. */
const ARGUMENTS_PREVIEW_CHARS = 500

/**
 * Tools that are transparent to the chain. Bookkeeping calls a model
 * interleaves into a loop must not launder it.
 */
const TRANSPARENT_TOOLS = new Set(['TodoWrite'])

/** Bound on tracked agents so long-lived sessions cannot grow this unboundedly. */
const MAX_TRACKED_AGENTS = 100

interface Chain {
  /** Canonical `${toolName} ${canonicalArgs}` of the last tracked call. */
  key: string
  /** Consecutive count of that exact call. */
  count: number
  /** Thresholds already reported for this chain, so each fires at most once. */
  fired: Set<number>
  /** Tool name and argument preview, retained for the detailed reminder. */
  toolName: string
  argsPreview: string
}

const chains = new Map<string, Chain>()

/**
 * Deep key-sorted JSON, so `{a:1,b:2}` and `{b:2,a:1}` are the same call.
 * Falls back to a string coercion for anything JSON cannot represent - the
 * result only has to be comparable, not reversible.
 */
function canonicalize(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys)
    if (v && typeof v === 'object') {
      const src = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k])
      return out
    }
    return v
  }
  try {
    return JSON.stringify(sortKeys(value)) ?? String(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} [truncated]`
}

function wrap(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`
}

function shortReminder(toolName: string, count: number): string {
  return wrap(
    `You have called ${toolName} ${count} times in a row with identical ` +
      'arguments. Analyze the result you already have before calling it ' +
      'again - an identical call cannot return new information. If you need ' +
      'different data, change the arguments or try a different approach.',
  )
}

function detailedReminder(
  toolName: string,
  count: number,
  argsPreview: string,
): string {
  return wrap(
    `${toolName} has now been called ${count} times consecutively with the ` +
      `same arguments:\n${argsPreview}\n\n` +
      'These calls made no progress. Stop repeating this call. Re-read the ' +
      'result you already received, then either change the arguments, use a ' +
      'different tool, or explain to the user why you cannot proceed.',
  )
}

/**
 * Record one tool call and return a reminder when it crosses a threshold.
 *
 * Called once per tool call from `runToolUse`, which Tau invokes before the
 * permission check - so a denied call still counts, and a model hammering a
 * denied call is exactly the loop worth breaking.
 *
 * @param agentKey Per-agent identity (`agentId` for subagents, session id for
 *   the main thread). Chains never cross this boundary.
 * @returns The reminder text to append to this call's tool_result, or null.
 */
export function noteToolCall(
  agentKey: string,
  toolName: string,
  input: unknown,
): string | null {
  // Transparent tools neither increment nor reset the chain.
  if (TRANSPARENT_TOOLS.has(toolName)) return null

  const canonicalArgs = canonicalize(input)
  const key = `${toolName} ${canonicalArgs}`
  const existing = chains.get(agentKey)

  if (!existing || existing.key !== key) {
    if (!existing && chains.size >= MAX_TRACKED_AGENTS) {
      // Map preserves insertion order; drop the oldest tracked agent.
      const oldest = chains.keys().next()
      if (!oldest.done) chains.delete(oldest.value)
    }
    chains.set(agentKey, {
      key,
      count: 1,
      fired: new Set(),
      toolName,
      argsPreview: truncate(canonicalArgs, ARGUMENTS_PREVIEW_CHARS),
    })
    return null
  }

  existing.count += 1

  // Report the highest threshold this call has reached and not yet fired.
  let hit: number | null = null
  for (const threshold of THRESHOLDS) {
    if (existing.count >= threshold && !existing.fired.has(threshold)) {
      hit = threshold
    }
  }
  if (hit === null) return null
  existing.fired.add(hit)

  return hit === THRESHOLDS[0]
    ? shortReminder(existing.toolName, existing.count)
    : detailedReminder(existing.toolName, existing.count, existing.argsPreview)
}

/**
 * Clear an agent's chain. A user interjection changes the context, so
 * repetition across it is not a loop.
 */
export function resetRepeatToolChain(agentKey: string): void {
  chains.delete(agentKey)
}

/** Test-only: drop all tracked chains. */
export function __resetAllRepeatToolChains(): void {
  chains.clear()
}
