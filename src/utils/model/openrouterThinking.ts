/**
 * OpenRouter per-model thinking store.
 *
 * OpenRouter unifies every upstream's reasoning surface behind one request
 * field — `reasoning: { enabled, effort, max_tokens }` — but WHICH of those a
 * given model accepts, and which effort values it takes, is per model and is
 * published by OpenRouter itself (see openrouterReasoningCatalog.ts):
 *
 *   meta/muse-spark-1.3     Default / Minimal / Low / Medium / High / xHigh / Max
 *   x-ai/grok-4.20          Default / Off / Low / High / Max
 *   deepseek/deepseek-v3.2  Default / Off / On          (reasons, no ladder)
 *   openai/gpt-5.5-chat     (no chip — the row does not reason)
 *
 * So the ladder cannot be the fixed low/medium/high set Tau's own thinking
 * budget speaks. `["max","high","low"]` has no `medium` at all, and `minimal`,
 * `xhigh` and `max` were unreachable before this module existed. Every stop
 * below `default` comes straight out of OpenRouter's catalogue, in ascending
 * effort order, and nothing else is ever put on the wire.
 *
 * `Default` is a Tau-side stop meaning "no per-model override": the session's
 * own /thinking setting drives the row, mapped onto a value the model actually
 * published. It is where every row starts, so a model nobody has configured
 * behaves exactly as it did before — OpenRouter applies its own
 * `default_effort`.
 *
 * `Off` is only offered where OpenRouter says reasoning is optional. On a
 * `mandatory: true` row (the whole Muse Spark family) `enabled: false` is a
 * 400, so the stop is not offered and never sent.
 *
 * The pick persists to ~/.claude/openrouter-thinking.json keyed by model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getOpenRouterReasoningMeta } from './openrouterReasoningCatalog.js'

/**
 * One stop on a model's ladder. Either a Tau-side stop (`default`, `off`,
 * `on`) or an effort value the model itself published — which is why this is a
 * string rather than a closed union: the values come from OpenRouter at
 * runtime and differ per row.
 */
export type OpenRouterEffort = string

/** No per-model override: the session's thinking setting drives the row. */
export const OPENROUTER_DEFAULT_STOP = 'default'
/** `reasoning: { enabled: false }`. Only offered where reasoning is optional. */
export const OPENROUTER_OFF_STOP = 'off'
/** `reasoning: { enabled: true }` on an optional row publishing no ladder. */
export const OPENROUTER_ON_STOP = 'on'

/** The reasoning field this provider is allowed to put on a request body. */
export interface OpenRouterReasoningField {
  enabled?: boolean
  effort?: string
}

/** What the caller's own thinking budget asks for, when nothing was picked. */
export interface OpenRouterThinkingFallback {
  /** Whether the session currently wants thinking at all. */
  enabled: boolean
  /** The session's mapped effort, or null when it expressed none. */
  effort: 'low' | 'medium' | 'high' | null
}

/**
 * The stops this model cycles through: `default`, then whatever OpenRouter
 * published for the row. A single-entry ladder reads as "hide the chip".
 *
 * `off` is only offered when reasoning is optional AND the row does not
 * already publish its own `none` effort — two adjacent stops that both mean
 * "stop thinking" would only be confusing.
 */
export function openRouterEffortLevelsFor(
  model: string,
): readonly OpenRouterEffort[] {
  const meta = getOpenRouterReasoningMeta(model)
  if (!meta) return [OPENROUTER_DEFAULT_STOP]

  const stops: OpenRouterEffort[] = [OPENROUTER_DEFAULT_STOP]
  const optional = !meta.mandatory
  if (optional && !meta.efforts.includes('none')) stops.push(OPENROUTER_OFF_STOP)
  if (meta.efforts.length > 0) stops.push(...meta.efforts)
  else if (optional) stops.push(OPENROUTER_ON_STOP)
  return stops
}

/** Whether the picker shows an effort chip for this model. */
export function supportsOpenRouterEffortSelection(model: string): boolean {
  return openRouterEffortLevelsFor(model).length > 1
}

function storePath(): string {
  return (
    process.env.TAU_OPENROUTER_THINKING_STORE
    || join(homedir(), '.claude', 'openrouter-thinking.json')
  )
}

let _loadedPath: string | null = null
let _cache: Record<string, OpenRouterEffort> = {}

function load(): void {
  const path = storePath()
  if (_loadedPath === path) return
  _loadedPath = path
  _cache = {}
  try {
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, OpenRouterEffort> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) out[k.toLowerCase()] = v
      }
      _cache = out
    }
  } catch {
    // Stale or corrupt file — treat as empty. The next save() rewrites it.
  }
}

function save(): void {
  const path = storePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(_cache, null, 2), 'utf8')
  } catch {
    // Persistence is best-effort; the in-memory pick still drives this session.
  }
}

/**
 * The stop this model sits on.
 *
 * A stored value that is not on the model's current ladder is ignored: the
 * ladder moves when OpenRouter re-publishes a row, and a stale `xhigh` must
 * not keep riding on a model that has since dropped it — that is exactly the
 * 400 this module exists to prevent.
 */
export function getOpenRouterEffort(model: string): OpenRouterEffort {
  load()
  const stored = _cache[model.trim().toLowerCase()]
  if (stored && openRouterEffortLevelsFor(model).includes(stored)) return stored
  return OPENROUTER_DEFAULT_STOP
}

/**
 * Whether the user actually picked a stop for this model, as opposed to
 * sitting on `default`. Lets the request path tell "the chip says high" apart
 * from "nobody expressed a preference", so an explicit pick outranks the
 * session's thinking budget instead of being overwritten by it.
 */
export function hasExplicitOpenRouterEffort(model: string): boolean {
  return getOpenRouterEffort(model) !== OPENROUTER_DEFAULT_STOP
}

export function setOpenRouterEffort(
  model: string,
  effort: OpenRouterEffort,
): void {
  load()
  const key = model.trim().toLowerCase()
  const next = openRouterEffortLevelsFor(model).includes(effort)
    ? effort
    : OPENROUTER_DEFAULT_STOP
  if (next === OPENROUTER_DEFAULT_STOP) delete _cache[key]
  else _cache[key] = next
  save()
}

export function cycleOpenRouterEffort(
  model: string,
  direction: 'left' | 'right',
): OpenRouterEffort {
  const levels = openRouterEffortLevelsFor(model)
  const idx = Math.max(0, levels.indexOf(getOpenRouterEffort(model)))
  const len = levels.length
  const next =
    direction === 'right'
      ? levels[(idx + 1) % len]!
      : levels[(idx - 1 + len) % len]!
  setOpenRouterEffort(model, next)
  return next
}

/** Name of one stop. `xhigh` reads as `xHigh`, not `Xhigh`. */
export function getOpenRouterEffortLabel(effort: OpenRouterEffort): string {
  if (effort === 'xhigh') return 'xHigh'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/**
 * The whole picker chip. The two Tau-side toggle stops name what they do
 * ("Thinking On") rather than pretending to be a rung on an effort ladder,
 * which is what "On effort" would read as.
 */
export function getOpenRouterEffortChipLabel(effort: OpenRouterEffort): string {
  if (effort === OPENROUTER_OFF_STOP) return 'Thinking Off'
  if (effort === OPENROUTER_ON_STOP) return 'Thinking On'
  return `${getOpenRouterEffortLabel(effort)} effort`
}

/**
 * The `reasoning` field to put on the wire for this model, given what the
 * session's own thinking budget asks for when no stop was picked. `undefined`
 * means "say nothing", which leaves OpenRouter's own default in charge.
 *
 * Precedence matches the other per-model chips: an explicit pick wins, then
 * the caller's budget where it maps onto something the model published, then
 * nothing at all.
 */
export function resolveOpenRouterReasoningField(
  model: string,
  fallback?: OpenRouterThinkingFallback,
): OpenRouterReasoningField | undefined {
  const meta = getOpenRouterReasoningMeta(model)
  if (!meta) return undefined

  const stop = getOpenRouterEffort(model)

  if (stop === OPENROUTER_DEFAULT_STOP) {
    if (!fallback) return undefined
    if (!fallback.enabled) {
      // A row that cannot stop reasoning is left alone rather than sent a
      // field it rejects; OpenRouter applies its own default_effort.
      return meta.mandatory ? undefined : { enabled: false }
    }
    // Only an effort the row itself published is ever named. `medium` on a
    // ["max","high","low"] ladder is the 400 this module exists to prevent.
    if (fallback.effort && meta.efforts.includes(fallback.effort)) {
      return { effort: fallback.effort }
    }
    return meta.mandatory ? undefined : { enabled: true }
  }

  if (stop === OPENROUTER_OFF_STOP) return { enabled: false }
  if (stop === OPENROUTER_ON_STOP) return { enabled: true }
  return { effort: stop }
}

/** Test-only: reset the in-memory store to a known state. */
export function _resetOpenRouterThinkingForTests(
  cache: Record<string, OpenRouterEffort> = {},
): void {
  _loadedPath = storePath()
  _cache = { ...cache }
}
