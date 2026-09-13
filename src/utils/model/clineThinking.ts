import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getClineModelMeta, type ClineModelMeta } from './clineModelsDevCatalog.js'

/**
 * One stop on a Cline model's thinking ladder: an effort value the model
 * publishes on models.dev, or one of two Tau-side stops. `none` is where every
 * model starts: it turns thinking off where the model allows that, and
 * otherwise leaves the model's own default in charge. `on` switches thinking
 * on for a model that publishes the switch but no effort ladder.
 */
export type ClineEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'on'
/** A stop that goes on the wire as the effort value itself. */
export type ClineWireEffort = Exclude<ClineEffort, 'none' | 'on'>

/**
 * The ladder for a model models.dev does not describe: the five stops Tau
 * offered for every Cline model before ladders were per model.
 */
export const CLINE_EFFORT_LEVELS: readonly ClineEffort[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
]

// Least to most effort. `on` sits mid-ladder, so a stored `on` lands on
// `medium` if the model later publishes efforts, and any effort lands on `on`
// for a model that only publishes the switch.
const EFFORT_RANK: Readonly<Record<ClineEffort, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  on: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

const CLINE_EFFORT_VARIANT_SEPARATOR = '::cline-effort='

function storePath(): string {
  return process.env.TAU_CLINE_THINKING_STORE
    || join(homedir(), '.claude', 'cline-thinking.json')
}

let _loadedPath: string | null = null
let _cache: Record<string, ClineEffort> = {}

function normalizeStoreKey(model: string): string {
  return stripClineEffortVariant(model).trim().toLowerCase()
}

export function isClineEffort(value: string): value is ClineEffort {
  return Object.prototype.hasOwnProperty.call(EFFORT_RANK, value)
}

export function encodeClineEffortVariant(
  modelId: string,
  effort: ClineEffort,
): string {
  return `${modelId}${CLINE_EFFORT_VARIANT_SEPARATOR}${effort}`
}

export function parseClineEffortVariant(
  modelId: string,
): { modelId: string; effort?: ClineEffort } {
  const markerIndex = modelId.lastIndexOf(CLINE_EFFORT_VARIANT_SEPARATOR)
  if (markerIndex < 0) return { modelId }

  const baseModelId = modelId.slice(0, markerIndex)
  const effort = modelId.slice(markerIndex + CLINE_EFFORT_VARIANT_SEPARATOR.length)
  if (!baseModelId || !isClineEffort(effort)) {
    return { modelId }
  }
  return { modelId: baseModelId, effort }
}

export function stripClineEffortVariant(modelId: string): string {
  return parseClineEffortVariant(modelId).modelId
}

function load(): void {
  const path = storePath()
  if (_loadedPath === path) return
  _loadedPath = path
  _cache = {}

  try {
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return

    const next: Record<string, ClineEffort> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && isClineEffort(value)) {
        next[key.toLowerCase()] = value
      }
    }
    _cache = next
  } catch {
    // Persistence is best-effort. A stale/corrupt file should not break the picker.
  }
}

function save(): void {
  const path = storePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(_cache, null, 2), 'utf8')
  } catch {
    // Keep the in-memory value for this session even if disk persistence fails.
  }
}

export function isClineThinkingModel(model: string): boolean {
  const m = model.trim().toLowerCase().replace(/[._]/g, '-')

  if (!m) return false
  if (m.includes('thinking') || m.includes('reasoning')) return true

  // Cline's model catalog should be authoritative when it exposes
  // supportsReasoning. These families are the conservative fallback for
  // fallback catalogs and older API payloads.
  if (m.includes('deepseek-r1') || m.includes('deepseek/deepseek-r')) return true
  if (m.includes('deepseek-v4') || m.includes('deepseek-reasoner')) return true
  if (m.includes('qwq') || m.includes('qwen3') || m.includes('qwen-3')) return true
  if (m.includes('glm-5') || m.includes('glm-4-7') || m.includes('glm-4-6')) return true
  if (m.includes('kimi-k2-thinking') || m.includes('kimi-k2-5') || m.includes('kimi-k2p5')) return true
  if (m.includes('minimax-m2')) return true
  if (m.includes('grok-3') || m.includes('grok-4') || m.includes('xai/grok-3') || m.includes('xai/grok-4')) return true
  if (m.includes('gemini-2-5') || m.includes('gemini-3')) return true
  if (m.includes('claude-sonnet-4') || m.includes('claude-opus-4') || m.includes('claude-haiku-4')) return true
  if (m.includes('gpt-5') || m.includes('codex')) return true
  if (m.includes('/o1') || m.includes('/o3') || m.includes('/o4')) return true
  if (m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return true

  return false
}

export interface ClineThinkingLadder {
  /** Stops in cycle order. The first, `none`, is where a model starts. */
  levels: readonly ClineEffort[]
  /** `none` turns thinking off. When false it means "the model decides". */
  offSupported: boolean
}

function ladderFromMeta(meta: ClineModelMeta): ClineThinkingLadder | null {
  if (!meta.reasoning) return null
  const efforts = meta.efforts.filter(isClineEffort)
  if (efforts.length > 0) {
    return { levels: ['none', ...efforts], offSupported: meta.canTurnOff }
  }
  if (meta.toggle) return { levels: ['none', 'on'], offSupported: true }
  // Reasons, but publishes neither a switch nor a ladder: nothing to pick.
  return null
}

/**
 * This model's thinking ladder, or null when there is nothing to pick. It is
 * the model's own `reasoning_options` on models.dev when models.dev describes
 * the model (clineModelsDevCatalog.ts), so glm-5.3 on Cline Pass cycles
 * Default/Low/High/Max and never offers an Off it would refuse. A model
 * models.dev does not describe keeps the five stops Tau offered before, when
 * the old id check calls it a thinking model.
 */
export function getClineThinkingLadder(model: string): ClineThinkingLadder | null {
  const base = stripClineEffortVariant(model)
  const meta = getClineModelMeta(base)
  if (meta) return ladderFromMeta(meta)
  return isClineThinkingModel(base)
    ? { levels: CLINE_EFFORT_LEVELS, offSupported: true }
    : null
}

export function supportsClineThinkingSelection(
  model: string,
  _tags?: readonly string[],
): boolean {
  return (getClineThinkingLadder(model)?.levels.length ?? 0) > 1
}

/**
 * The stop on `ladder` closest to `effort`. A stored pick can predate the
 * model's current ladder; the nearest published stop replaces it, and on a
 * tie the stronger one wins, as in Cline's SDK (normalizeReasoningEffort in
 * sdk/packages/llms/src/providers/model-facts.ts).
 */
function snapToLadder(effort: ClineEffort, ladder: ClineThinkingLadder): ClineEffort {
  if (ladder.levels.includes(effort)) return effort
  const stops = ladder.levels.filter(level => level !== 'none')
  if (effort === 'none' || stops.length === 0) return 'none'
  const wanted = EFFORT_RANK[effort]
  let best = stops[0]!
  for (const stop of stops) {
    const distance = Math.abs(EFFORT_RANK[stop] - wanted)
    const bestDistance = Math.abs(EFFORT_RANK[best] - wanted)
    if (
      distance < bestDistance
      || (distance === bestDistance && EFFORT_RANK[stop] > EFFORT_RANK[best])
    ) {
      best = stop
    }
  }
  return best
}

export function getClineEffort(model: string): ClineEffort {
  load()
  const stored = _cache[normalizeStoreKey(model)] ?? 'none'
  const ladder = getClineThinkingLadder(model)
  return ladder ? snapToLadder(stored, ladder) : stored
}

export function setClineEffort(model: string, effort: ClineEffort): void {
  load()
  const key = normalizeStoreKey(model)
  if (effort === 'none') {
    delete _cache[key]
  } else {
    _cache[key] = effort
  }
  save()
}

export function cycleClineEffort(
  model: string,
  direction: 'left' | 'right',
): ClineEffort {
  const levels = getClineThinkingLadder(model)?.levels ?? CLINE_EFFORT_LEVELS
  const idx = Math.max(0, levels.indexOf(getClineEffort(model)))
  const len = levels.length
  const next =
    direction === 'right'
      ? levels[(idx + 1) % len]!
      : levels[(idx - 1 + len) % len]!
  setClineEffort(model, next)
  return next
}

/**
 * Name of one stop. Pass the model so `none` reads as what it does there:
 * "Off" where thinking can be turned off, "Default" where the model decides.
 */
export function getClineEffortLabel(effort: ClineEffort, model?: string): string {
  if (effort === 'none') {
    return model && getClineThinkingLadder(model)?.offSupported === false
      ? 'Default'
      : 'Off'
  }
  if (effort === 'on') return 'On'
  if (effort === 'xhigh') return 'Extra High'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** The thinking fields a Cline request carries. */
export interface ClineReasoningFields {
  reasoning: { enabled: boolean; effort?: ClineWireEffort }
  reasoning_effort?: ClineWireEffort
}

/**
 * The thinking fields to send for this model, or null to send none. Only a
 * stop on the model's own ladder is ever named, and `enabled: false` only
 * where the model can stop thinking; anywhere else `none` sends nothing and
 * the model's own default applies.
 */
export function resolveClineReasoningFields(model: string): ClineReasoningFields | null {
  const variant = parseClineEffortVariant(model)
  const ladder = getClineThinkingLadder(variant.modelId)
  if (!ladder) return null

  load()
  const picked = variant.effort ?? _cache[normalizeStoreKey(variant.modelId)] ?? 'none'
  const effort = snapToLadder(picked, ladder)
  if (effort === 'none') {
    return ladder.offSupported ? { reasoning: { enabled: false } } : null
  }
  if (effort === 'on') return { reasoning: { enabled: true } }
  return { reasoning: { enabled: true, effort }, reasoning_effort: effort }
}

/** Replace any thinking fields on `body` with `fields` (none when null). */
export function applyClineReasoningFields(
  body: Record<string, unknown>,
  fields: ClineReasoningFields | null,
): void {
  delete body.reasoning
  delete body.reasoning_effort
  if (!fields) return
  body.reasoning = fields.reasoning
  if (fields.reasoning_effort) body.reasoning_effort = fields.reasoning_effort
}

export function _resetClineThinkingForTests(
  cache: Record<string, ClineEffort> = {},
): void {
  _loadedPath = storePath()
  _cache = { ...cache }
}
