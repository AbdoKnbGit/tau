/**
 * OpenCode Zen / Go per-model thinking effort store.
 *
 * A row models.dev describes with an `effort` option (see
 * opencodeModelsDevCatalog.ts) gets exactly that ladder: Default, then the
 * values the row publishes — Claude Opus 5.5 Low..Max, GPT-6 None..Max,
 * DeepSeek V4 Low/High/Max, Kimi K3 Max. A pick goes on the wire as
 * `reasoning_effort`, the one field the official OpenCode client sends for
 * it; Default sends nothing, so the upstream's own default applies.
 *
 * Every other reasoning row keeps the id-based rules below: Default (server
 * default — usually off, except for free-tier models where opencode-dev
 * defaults thinking on at medium), Low, Medium, High.
 *
 * The shape we inject downstream for those depends on the upstream backend
 * the gateway routes to (see opencodeTransformer.transformRequest):
 *
 *   - Anthropic native    → thinking: { type: "enabled", budget_tokens }
 *   - OpenAI Responses    → reasoning_effort + reasoning: { effort }
 *   - Google native       → thinking_config: { include_thoughts, thinking_level }
 *   - DeepSeek (oa-compat)→ thinking: { type: "enabled" }   (no effort field)
 *   - GLM/Kimi 4.6/4.7    → chat_template_args: { enable_thinking: true }
 *   - Qwen/QwQ (DashScope)→ enable_thinking: true
 *   - Anything else (e.g. minimax, big-pickle): no effort knob — server-side
 *     defaults pick the thinking mode and we don't inject anything.
 *
 * The store persists to ~/.claude/opencode-thinking.json so the chosen
 * effort survives across sessions per model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getOpencodeModelMeta } from './opencodeModelsDevCatalog.js'
import {
  isOpenAIReasoningModel,
  openCodeRouteFor,
} from '../../lanes/openai-compat/opencode_anthropic_route.js'

export type OpencodeEffort =
  | 'default'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** A stop that goes on the wire as the effort value itself. */
export type OpencodeWireEffort = Exclude<OpencodeEffort, 'default'>

// The generic ladder almost every OpenCode row cycles through.
export const OPENCODE_EFFORT_LEVELS: readonly OpencodeEffort[] = [
  'default',
  'low',
  'medium',
  'high',
]

// GLM-5.2 on OpenCode Go is the one row whose reasoning is driven by
// `reasoning_effort` and only accepts high|max — opencode-dev generates exactly
// those two variants for it (packages/core/src/plugin/variant.ts). No
// low/medium; "default" leaves the upstream server default (thinking off) in
// place. Mirrors the Cloudflare GLM-5.2 ladder (CLOUDFLARE_GLM52_EFFORT_LEVELS).
export const OPENCODE_GLM52_EFFORT_LEVELS: readonly OpencodeEffort[] = [
  'default',
  'high',
  'max',
]

// Every stop in ascending effort, `default` first. Validates persisted values
// on load (a stored 'xhigh' must survive a reload) and orders the snap below.
const OPENCODE_ALL_EFFORT_LEVELS: readonly OpencodeEffort[] = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function isOpencodeEffort(value: string): value is OpencodeEffort {
  return (OPENCODE_ALL_EFFORT_LEVELS as readonly string[]).includes(value)
}

/** True for the OpenCode Go GLM-5.2 row (its reasoning_effort high|max knob). */
export function isOpencodeGlm52(model: string): boolean {
  return model.trim().toLowerCase() === 'glm-5.2'
}

/**
 * The ladder models.dev publishes for this row on this host — Default, then
 * the row's effort values — or null when the row has no effort option there
 * (or the catalogue is not on disk), which leaves it on the id-based rules.
 */
function catalogEffortLevels(
  provider: string,
  model: string,
): readonly OpencodeEffort[] | null {
  const meta = getOpencodeModelMeta(provider, model)
  if (!meta?.reasoning) return null
  const efforts = meta.efforts.filter(isOpencodeEffort)
  return efforts.length > 0 ? ['default', ...efforts] : null
}

/**
 * Whether this row's thinking is driven by the effort values models.dev
 * publishes for it. Such a row sends `reasoning_effort` and nothing else.
 */
export function usesOpencodeCatalogEfforts(
  provider: string,
  model: string,
): boolean {
  return catalogEffortLevels(provider, model) !== null
}

/**
 * The effort stops a given model cycles through in the picker: the row's own
 * published ladder where models.dev states one, otherwise GLM-5.2's
 * Default/High/Max (reasoning_effort) or the generic Default/Low/Medium/High.
 * Zen and Go can publish different ladders for the same id (Qwen3.8 Max), so
 * the provider matters.
 */
export function opencodeEffortLevelsFor(
  model: string,
  provider = 'opencode',
): readonly OpencodeEffort[] {
  return catalogEffortLevels(provider, model)
    ?? (isOpencodeGlm52(model) ? OPENCODE_GLM52_EFFORT_LEVELS : OPENCODE_EFFORT_LEVELS)
}

/**
 * The stop on `levels` closest to `effort`, ties going to the stronger one.
 * A pick stored against an older ladder (Medium, on a row that now publishes
 * Low/High/Max) lands on a value the row accepts instead of being dropped.
 */
function snapToLevels(
  effort: OpencodeWireEffort,
  levels: readonly OpencodeEffort[],
): OpencodeWireEffort | null {
  const rank = (value: OpencodeEffort) => OPENCODE_ALL_EFFORT_LEVELS.indexOf(value)
  let best: OpencodeWireEffort | null = null
  for (const stop of levels) {
    if (stop === 'default') continue
    if (
      best === null
      || Math.abs(rank(stop) - rank(effort)) < Math.abs(rank(best) - rank(effort))
      || (
        Math.abs(rank(stop) - rank(effort)) === Math.abs(rank(best) - rank(effort))
        && rank(stop) > rank(best)
      )
    ) {
      best = stop
    }
  }
  return best
}

// Models that should default to "medium" on first use:
//   1. Free-tier rows that opencode-dev itself ships with thinking enabled —
//      without this they'd come up cold and the user would see worse quality
//      than running opencode directly.
//   2. Models whose server-side default is thinking-on regardless of body
//      flags (kimi-k2-thinking, glm-4.6, deepseek-v4-*). Forcing "default"
//      → off via thinking: {type:"disabled"} on these would either be ignored
//      (kimi-thinking) or fight the upstream's own default, surfacing the
//      "reasoning_content must be passed back" 400 anyway. Starting at medium
//      keeps the picker in sync with what the upstream is actually doing.
const FREE_TIER_DEFAULT_MEDIUM = (model: string): boolean => {
  const m = model.toLowerCase()
  if (m.endsWith('-free')) return true
  if (m.includes('big-pickle')) return true
  if (m === 'gpt-5-nano' || m === 'gpt-5.4-nano') return true
  if (m === 'kimi-k2-thinking' || m === 'glm-4.6') return true
  if (m.startsWith('deepseek-v4')) return true
  return false
}

// Models that the gateway forwards in a shape where Anthropic-style
// `thinking: { type: "enabled" }` (or the alternate fields below) is the
// switch that controls reasoning emission. If a model isn't reasoning-capable
// the picker's toggle UI is hidden and nothing is injected.
//
// This intentionally matches opencodeTransformer.isReasoningCapable():
// the two should stay in lockstep. If you add a family here add it there
// too, and vice versa.
export function isOpencodeThinkingModel(model: string): boolean {
  const m = model.toLowerCase()
  // Anthropic
  if (m.startsWith('claude-opus-4') || m.startsWith('claude-haiku-4') || m.startsWith('claude-sonnet-4')) return true
  if (m.includes('anthropic/claude-opus-4') || m.includes('anthropic/claude-sonnet-4') || m.includes('anthropic/claude-haiku-4')) return true
  // DeepSeek
  if (m.includes('deepseek-r1') || m.includes('deepseek/deepseek-r')) return true
  if (m.includes('deepseek-v4') || m.includes('deepseek-reasoner')) return true
  // Qwen / QwQ
  if (m.includes('qwen3') || m.includes('qwen-3') || m.includes('qwq')) return true
  // GLM 4.7 / 5.x — these are the families opencode marks reasoning=true
  if (m.startsWith('glm-5') || m.includes('glm-5') || m === 'glm-4.7' || m === 'glm-4.6') return true
  // Kimi thinking family
  if (m === 'kimi-k2-thinking' || m.includes('kimi-k2.5') || m.includes('kimi-k2p5') || m.includes('kimi-k2-5')) return true
  // OpenAI GPT-5 / o-series / codex
  if (m.startsWith('gpt-5') || m.startsWith('openai/gpt-5') || m.includes('codex')) return true
  if (m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return true
  // Grok reasoning
  if (m.startsWith('grok-3') || m.startsWith('grok-4') || m.startsWith('xai/grok-3') || m.startsWith('xai/grok-4')) return true
  // Gemini 2.5 / 3.x
  if (m.includes('gemini-2.5') || m.includes('gemini-3')) return true
  // MiniMax M2 reasoning variants
  if (m.includes('minimax-m2')) return true
  return false
}

/**
 * Whether Tau should expose a user-selectable thinking effort for a model.
 *
 * OpenCode Go marks GLM-5.2 and Qwen3.7 Max as reasoning-capable. Qwen3.7 Max
 * publishes no usable request control, so its selector stays hidden. GLM-5.2,
 * however, DOES take a `reasoning_effort` (high|max) — opencode-dev generates
 * exactly those two variants for it — so it is selectable (Default/High/Max, see
 * opencodeEffortLevelsFor); the Go transformer translates the pick into
 * reasoning_effort and drops the zai-style thinking object that row 400s on.
 */
export function supportsOpencodeThinkingSelection(
  provider: string,
  model: string,
): boolean {
  // What models.dev says about the row on this host outranks the id rules:
  // a row that does not reason gets no chip, one with published efforts does.
  const meta = getOpencodeModelMeta(provider, model)
  if (meta && !meta.reasoning) return false
  // The route decides what a pick can reach. On /responses the official SDK
  // sends `reasoning` only for OpenAI reasoning models, so Grok and Muse
  // Spark would show a chip that changes nothing; on /messages only Claude
  // and Qwen rows take a thinking setting from the client (MiniMax's
  // defaults are fixed by OpenCode).
  const route = openCodeRouteFor(provider, model)
  if (route === 'systemone') return false
  if (route === 'responses' && !isOpenAIReasoningModel(model)) return false
  if (usesOpencodeCatalogEfforts(provider, model)) return true
  if (route === 'messages' && !/^(claude-|qwen)/.test(model.trim().toLowerCase())) return false
  if (!isOpencodeThinkingModel(model)) return false
  if (provider !== 'opencodego') return true

  const normalized = model.trim().toLowerCase()
  return normalized !== 'qwen3.7-max'
}

function storePath(): string {
  return (
    process.env.TAU_OPENCODE_THINKING_STORE
    || join(homedir(), '.claude', 'opencode-thinking.json')
  )
}

let _loadedPath: string | null = null
let _cache: Record<string, OpencodeEffort> = {}

function load(): void {
  const path = storePath()
  if (_loadedPath === path) return
  _loadedPath = path
  _cache = {}
  try {
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, OpencodeEffort> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && (OPENCODE_ALL_EFFORT_LEVELS as readonly string[]).includes(v)) {
          out[k.toLowerCase()] = v as OpencodeEffort
        }
      }
      _cache = out
    }
  } catch {
    // Stale or corrupt file — treat as empty. Next save() rewrites it.
  }
}

function save(): void {
  const path = storePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(_cache, null, 2), 'utf8')
  } catch {
    // Persistence is best-effort. The in-memory cache still works for the
    // current session even if the disk write fails (read-only home, etc.).
  }
}

export function getOpencodeEffort(
  model: string,
  provider = 'opencode',
): OpencodeEffort {
  load()
  const key = model.trim().toLowerCase()
  const catalogLevels = catalogEffortLevels(provider, model)
  const levels = catalogLevels ?? opencodeEffortLevelsFor(model, provider)
  const stored = _cache[key]
  if (stored && levels.includes(stored)) return stored
  if (catalogLevels) {
    // A published ladder starts at Default — the upstream's own setting —
    // and a pick stored against another ladder snaps to the nearest stop.
    return stored && stored !== 'default'
      ? snapToLevels(stored, catalogLevels) ?? 'default'
      : 'default'
  }
  // Ignore a stored value that isn't valid for this model's ladder (e.g. a
  // generic 'medium' left over for a GLM-5.2 that now only takes high|max).
  if (FREE_TIER_DEFAULT_MEDIUM(model) && isOpencodeThinkingModel(model)) {
    return 'medium'
  }
  return 'default'
}

export function setOpencodeEffort(
  model: string,
  effort: OpencodeEffort,
  provider = 'opencode',
): void {
  load()
  const key = model.trim().toLowerCase()
  // Only persist a level this model actually supports; anything else (including
  // 'default') clears the override so the model falls back to its default.
  const next = opencodeEffortLevelsFor(model, provider).includes(effort) ? effort : 'default'
  if (next === 'default') {
    delete _cache[key]
  } else {
    _cache[key] = next
  }
  save()
}

export function cycleOpencodeEffort(
  model: string,
  direction: 'left' | 'right',
  provider = 'opencode',
): OpencodeEffort {
  const levels = opencodeEffortLevelsFor(model, provider)
  const current = getOpencodeEffort(model, provider)
  const idx = Math.max(0, levels.indexOf(current))
  const len = levels.length
  const next =
    direction === 'right'
      ? levels[(idx + 1) % len]!
      : levels[(idx - 1 + len) % len]!
  setOpencodeEffort(model, next, provider)
  return next
}

/**
 * The `reasoning_effort` a row with a published ladder sends, or undefined to
 * send none. A pick on the chip wins. On Default the session's own thinking
 * setting drives the row, mapped onto a value the row published (OpenRouter's
 * Default works the same way); with thinking off nothing is sent and the
 * upstream applies its own default.
 */
export function resolveOpencodeCatalogEffort(
  provider: string,
  model: string,
  sessionEffort: 'low' | 'medium' | 'high' | null,
): OpencodeWireEffort | undefined {
  const levels = catalogEffortLevels(provider, model)
  if (!levels) return undefined
  const picked = getOpencodeEffort(model, provider)
  if (picked !== 'default') return picked
  return sessionEffort ? snapToLevels(sessionEffort, levels) ?? undefined : undefined
}

/**
 * The effort a /messages, /responses or Gemini request carries for this row,
 * or undefined for none: the published-ladder rule above where models.dev
 * states a ladder, otherwise the id-based pick, and on Default the session's
 * own thinking level. Each route turns it into its own field.
 */
export function resolveOpencodeRouteEffort(
  provider: string,
  model: string,
  sessionEffort: 'low' | 'medium' | 'high' | null,
): OpencodeWireEffort | undefined {
  if (!supportsOpencodeThinkingSelection(provider, model)) return undefined
  if (usesOpencodeCatalogEfforts(provider, model)) {
    return resolveOpencodeCatalogEffort(provider, model, sessionEffort)
  }
  const picked = getOpencodeEffort(model, provider)
  return picked !== 'default' ? picked : sessionEffort ?? undefined
}

/**
 * Whether replayed assistant messages carry `reasoning_content` for this row.
 *
 * Where models.dev states the row's contract (`interleaved.field`), that
 * decides it, as it does for the official client, whatever the chip says. So
 * a row that reasons by default replays its reasoning at Default too, and
 * moving the chip never re-serialises the history already sent (which would
 * be a cache miss on every earlier turn). A row with a published ladder and
 * no such contract never replays. Anything else keeps the old rule: replay
 * while a thinking level is picked.
 */
export function opencodeReplaysReasoningContent(
  provider: string,
  model: string,
): boolean {
  if (getOpencodeModelMeta(provider, model)?.replaysReasoningContent) return true
  if (usesOpencodeCatalogEfforts(provider, model)) return false
  return supportsOpencodeThinkingSelection(provider, model)
    && getOpencodeEffort(model, provider) !== 'default'
}

/** Test-only: reset the in-memory store to a known state for the active path. */
export function _resetOpencodeThinkingForTests(
  cache: Record<string, OpencodeEffort> = {},
): void {
  _loadedPath = storePath()
  _cache = { ...cache }
}

/**
 * Label rendered in the picker chip. Capitalized for the row; `xhigh` reads
 * as `xHigh`, as on OpenRouter's chip.
 */
export function getOpencodeEffortLabel(effort: OpencodeEffort): string {
  if (effort === 'xhigh') return 'xHigh'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}
