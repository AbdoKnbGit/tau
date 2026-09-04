/**
 * Alibaba Model Studio per-model thinking store.
 *
 * Qwen does not have one thinking knob, it has three, and which ones a model
 * accepts differs per row. Model Studio documents them as:
 *
 *   enable_thinking    boolean, hybrid thinking/non-thinking rows only
 *   reasoning_effort   one of the values THAT model publishes
 *   thinking_budget    a token cap — and explicitly not to be sent alongside
 *                      reasoning_effort
 *
 * So the ladder cannot be a fixed low/medium/high set. It is read per model
 * out of models.dev `reasoning_options` (see alibabaCatalog.ts) and rendered
 * as-is, which is what the API actually describes:
 *
 *   qwen3.8-max     Default / Off / Low / Medium / xHigh   (toggle + effort)
 *   qwen3.7-max     Default / Off / On                     (toggle only)
 *   glm-5.2         Default / None / Minimal / … / Max     (effort only)
 *   qwen3-max       (no chip — the row does not reason)
 *
 * `Default` is a Tau-side stop meaning "no per-model override": the session's
 * own thinking setting drives the row, through whichever fields it published.
 * It is where every row starts, and it is what makes `/thinking` reach this
 * provider at all — Model Studio turns thinking ON by default on the hybrid
 * rows, so a stop that sent nothing would quietly bill a thinking request to
 * someone who had turned thinking off. Express no preference at all and
 * nothing is sent, leaving the vendor default alone.
 *
 * Only fields the model published are ever sent: `enable_thinking` needs a
 * `toggle` option, `reasoning_effort` needs the value on that model's own
 * list. Model Studio answers 400 for a parameter a model does not take
 * ("parameter.enable_thinking only support …"), so silence is the only safe
 * default for a model the catalogue has not described.
 *
 * The pick persists to ~/.claude/alibaba-thinking.json keyed by model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getAlibabaModelMeta } from './alibabaCatalog.js'

/**
 * One stop on a model's ladder. Either a Tau-side stop (`default`, `off`,
 * `on`) or a `reasoning_effort` value the model itself published — which is
 * why this is a string rather than a closed union: the values come from the
 * catalogue at runtime and differ per model.
 */
export type AlibabaEffort = string

/** No per-model override: the session's thinking setting drives the row. */
export const ALIBABA_DEFAULT_STOP = 'default'
/** `enable_thinking: false`. Only offered for rows publishing a toggle. */
export const ALIBABA_OFF_STOP = 'off'
/** `enable_thinking: true` on a toggle row that publishes no effort ladder. */
export const ALIBABA_ON_STOP = 'on'

/** The fields this provider is allowed to put on a chat-completions body. */
export interface AlibabaThinkingFields {
  enable_thinking?: boolean
  reasoning_effort?: string
}

/** What the caller's own thinking budget asks for, when nothing was picked. */
export interface AlibabaThinkingFallback {
  /** Whether the session currently wants thinking at all. */
  enabled: boolean
  /** The session's mapped effort, or null when it expressed none. */
  effort: 'low' | 'medium' | 'high' | null
}

/**
 * The stops this model cycles through: `default`, then whatever the catalogue
 * published for the row. A single-entry ladder reads as "hide the chip".
 *
 * `off` is only offered when the row takes `enable_thinking` AND does not
 * already publish its own `none` effort — glm-5.2 does, and two adjacent stops
 * that both mean "stop thinking" would only be confusing.
 */
export function alibabaEffortLevelsFor(
  model: string,
): readonly AlibabaEffort[] {
  const meta = getAlibabaModelMeta(model)
  if (!meta || !meta.reasoning) return [ALIBABA_DEFAULT_STOP]

  const stops: AlibabaEffort[] = [ALIBABA_DEFAULT_STOP]
  if (meta.toggle && !meta.efforts.includes('none')) stops.push(ALIBABA_OFF_STOP)
  if (meta.efforts.length > 0) stops.push(...meta.efforts)
  else if (meta.toggle) stops.push(ALIBABA_ON_STOP)
  return stops
}

/** Whether the picker shows an effort chip for this model. */
export function supportsAlibabaEffortSelection(model: string): boolean {
  return alibabaEffortLevelsFor(model).length > 1
}

function storePath(): string {
  return (
    process.env.TAU_ALIBABA_THINKING_STORE
    || join(homedir(), '.claude', 'alibaba-thinking.json')
  )
}

let _loadedPath: string | null = null
let _cache: Record<string, AlibabaEffort> = {}

function load(): void {
  const path = storePath()
  if (_loadedPath === path) return
  _loadedPath = path
  _cache = {}
  try {
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, AlibabaEffort> = {}
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
 * ladder moves when models.dev re-publishes a row, and a stale `xhigh` must
 * not keep riding on a model that has since dropped it — that is exactly the
 * 400 this module exists to prevent.
 */
export function getAlibabaEffort(model: string): AlibabaEffort {
  load()
  const stored = _cache[model.trim().toLowerCase()]
  if (stored && alibabaEffortLevelsFor(model).includes(stored)) return stored
  return ALIBABA_DEFAULT_STOP
}

/**
 * Whether the user actually picked a stop for this model, as opposed to
 * sitting on `default`. Lets the request path tell "the chip says medium"
 * apart from "nobody expressed a preference", so an explicit pick outranks
 * the session's thinking budget instead of being overwritten by it.
 */
export function hasExplicitAlibabaEffort(model: string): boolean {
  return getAlibabaEffort(model) !== ALIBABA_DEFAULT_STOP
}

export function setAlibabaEffort(model: string, effort: AlibabaEffort): void {
  load()
  const key = model.trim().toLowerCase()
  const next = alibabaEffortLevelsFor(model).includes(effort)
    ? effort
    : ALIBABA_DEFAULT_STOP
  if (next === ALIBABA_DEFAULT_STOP) delete _cache[key]
  else _cache[key] = next
  save()
}

export function cycleAlibabaEffort(
  model: string,
  direction: 'left' | 'right',
): AlibabaEffort {
  const levels = alibabaEffortLevelsFor(model)
  const idx = Math.max(0, levels.indexOf(getAlibabaEffort(model)))
  const len = levels.length
  const next =
    direction === 'right'
      ? levels[(idx + 1) % len]!
      : levels[(idx - 1 + len) % len]!
  setAlibabaEffort(model, next)
  return next
}

/** Label rendered in the picker chip. `xhigh` reads as `xHigh`, not `Xhigh`. */
export function getAlibabaEffortLabel(effort: AlibabaEffort): string {
  if (effort === 'xhigh') return 'xHigh'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/**
 * The thinking fields to put on the wire for this model, given what the
 * session's own thinking budget asks for when no stop was picked.
 *
 * Precedence matches the other per-model chips: an explicit pick wins, then
 * the caller's budget where it maps onto a field the model published, then
 * nothing at all.
 */
export function resolveAlibabaThinkingFields(
  model: string,
  fallback?: AlibabaThinkingFallback,
): AlibabaThinkingFields {
  const meta = getAlibabaModelMeta(model)
  if (!meta || !meta.reasoning) return {}

  const stop = getAlibabaEffort(model)

  if (stop === ALIBABA_DEFAULT_STOP) {
    if (!fallback) return {}
    const fields: AlibabaThinkingFields = {}
    // The toggle is the only field safe to derive from the session budget:
    // it is a plain boolean the row declared it accepts.
    if (meta.toggle) fields.enable_thinking = fallback.enabled
    if (
      fallback.enabled
      && fallback.effort
      && meta.efforts.includes(fallback.effort)
    ) {
      fields.reasoning_effort = fallback.effort
    }
    return fields
  }

  if (stop === ALIBABA_OFF_STOP) return { enable_thinking: false }
  if (stop === ALIBABA_ON_STOP) return { enable_thinking: true }

  // A published effort value. `none` means stop thinking, so on a row that
  // also takes the toggle the toggle says it unambiguously and the effort
  // field is left off rather than sent alongside a contradiction.
  if (stop === 'none') {
    return meta.toggle
      ? { enable_thinking: false }
      : { reasoning_effort: 'none' }
  }
  return meta.toggle
    ? { enable_thinking: true, reasoning_effort: stop }
    : { reasoning_effort: stop }
}

/**
 * True for rows that will stream `reasoning_content` and want it echoed back
 * on replayed assistant tool-call messages.
 *
 * Model Studio's own DeepSeek, GLM and Kimi rows answer
 * "the reasoning_content in the thinking mode must be passed back to the API"
 * on the SECOND tool turn without the carry-back; the Qwen rows ignore the
 * field unless `preserve_thinking` is set. So carrying it costs a row that
 * does not need it nothing, and skipping it breaks the rows that do.
 *
 * Gated on the stop rather than on the model alone, because `off` genuinely
 * turns thinking off and then there is no reasoning to carry. `default` counts
 * as thinking-on: Model Studio enables it by default on the hybrid rows.
 */
export function alibabaReasoningContentReplayRequired(model: string): boolean {
  const meta = getAlibabaModelMeta(model)
  if (!meta || !meta.reasoning) return false
  const stop = getAlibabaEffort(model)
  return stop !== ALIBABA_OFF_STOP && stop !== 'none'
}

/** Test-only: reset the in-memory store to a known state. */
export function _resetAlibabaThinkingForTests(
  cache: Record<string, AlibabaEffort> = {},
): void {
  _loadedPath = storePath()
  _cache = { ...cache }
}
