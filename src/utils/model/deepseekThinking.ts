/**
 * DeepSeek V4 per-model thinking-effort store.
 *
 * V4 exposes two separate controls in the OpenAI-format body, and Tau folds
 * both onto one picker chip:
 *
 *   {"thinking": {"type": "enabled" | "disabled"}}   -- the toggle
 *   {"reasoning_effort": "low" | "high" | "max"}     -- the effort
 *
 * so the ladder is None / Low / High / Max: None sends the explicit
 * `disabled` toggle, the other three send `enabled` plus the matching effort.
 * DeepSeek maps a requested effort onto its own ladder identically for flash
 * and pro -- low -> low, medium -> high, high -> high, xhigh -> high,
 * max -> max -- so only the three distinct stops are offered here; medium and
 * xhigh would be indistinguishable from High on the wire.
 *
 * The default stop is None, which is byte-for-byte what Tau sent before the
 * chip existed. DeepSeek's own server-side default is thinking-on at high
 * effort, so one press of the right arrow hands the model back to its
 * documented default.
 *
 * Scope: V4 rows only (flash / pro / flash-vision-exp). A custom id behind
 * DEEPSEEK_BASE_URL keeps the old behavior -- driven by the caller's thinking
 * budget, with no effort field on the wire.
 *
 * The pick persists to ~/.claude/deepseek-thinking.json keyed by model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEEPSEEK_EFFORT_LEVELS = ['none', 'low', 'high', 'max'] as const

export type DeepSeekEffort = (typeof DEEPSEEK_EFFORT_LEVELS)[number]

/** Matches today's pre-chip wire shape: an explicit `thinking: disabled`. */
export const DEEPSEEK_DEFAULT_EFFORT: DeepSeekEffort = 'none'

/**
 * True for the V4 family -- flash, pro and flash-vision-exp today, plus any
 * later `deepseek-v4-*` row. Only consulted on the DeepSeek provider path, so
 * a bare prefix test cannot collide with another host's v4 naming.
 */
export function isDeepSeekV4ThinkingModel(model: string): boolean {
  return /^deepseek-v4(?:-|$)/i.test(model.trim())
}

/** The effort stops a DeepSeek row cycles through in the picker. */
export function deepseekEffortLevelsFor(_model: string): readonly DeepSeekEffort[] {
  return DEEPSEEK_EFFORT_LEVELS
}

/** Whether the picker shows an effort chip for this model. */
export function supportsDeepSeekEffortSelection(model: string): boolean {
  return isDeepSeekV4ThinkingModel(model)
}

function storePath(): string {
  return (
    process.env.TAU_DEEPSEEK_THINKING_STORE
    || join(homedir(), '.claude', 'deepseek-thinking.json')
  )
}

let _loadedPath: string | null = null
let _cache: Record<string, DeepSeekEffort> = {}

function load(): void {
  const path = storePath()
  if (_loadedPath === path) return
  _loadedPath = path
  _cache = {}
  try {
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, DeepSeekEffort> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && (DEEPSEEK_EFFORT_LEVELS as readonly string[]).includes(v)) {
          out[k.toLowerCase()] = v as DeepSeekEffort
        }
      }
      _cache = out
    }
  } catch {
    // Stale or corrupt file -- treat as empty. The next save() rewrites it.
  }
}

function save(): void {
  const path = storePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(_cache, null, 2), 'utf8')
  } catch {
    // Best-effort; the in-memory pick still drives this session.
  }
}

export function getDeepSeekEffort(model: string): DeepSeekEffort {
  load()
  return _cache[model.trim().toLowerCase()] ?? DEEPSEEK_DEFAULT_EFFORT
}

export function setDeepSeekEffort(model: string, effort: DeepSeekEffort): void {
  load()
  if (!DEEPSEEK_EFFORT_LEVELS.includes(effort)) return
  _cache[model.trim().toLowerCase()] = effort
  save()
}

export function cycleDeepSeekEffort(
  model: string,
  direction: 'left' | 'right',
): DeepSeekEffort {
  const levels = deepseekEffortLevelsFor(model)
  const idx = Math.max(0, levels.indexOf(getDeepSeekEffort(model)))
  const len = levels.length
  const next =
    direction === 'right'
      ? levels[(idx + 1) % len]!
      : levels[(idx - 1 + len) % len]!
  setDeepSeekEffort(model, next)
  return next
}

/**
 * The effort to put on the wire, or null when thinking should be switched off
 * entirely (the picker's None stop).
 */
export function resolveDeepSeekRequestEffort(
  model: string,
): Exclude<DeepSeekEffort, 'none'> | null {
  const effort = getDeepSeekEffort(model)
  return effort === 'none' ? null : effort
}

/** Label rendered in the picker chip. */
export function getDeepSeekEffortLabel(effort: DeepSeekEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** Test-only: reset the in-memory store to a known state. */
export function _resetDeepSeekThinkingForTests(
  cache: Record<string, DeepSeekEffort> = {},
): void {
  _loadedPath = storePath()
  _cache = { ...cache }
}
