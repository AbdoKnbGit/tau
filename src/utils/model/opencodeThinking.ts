/**
 * OpenCode Zen per-model thinking effort store.
 *
 * Every reasoning-capable model the gateway serves has its own knob:
 * Default (server default — usually off, except for free-tier models
 * where opencode-dev defaults thinking on at medium), Low, Medium, High.
 *
 * The shape we inject downstream depends on the upstream backend the
 * gateway routes to (see opencodeTransformer.transformRequest):
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

export type OpencodeEffort = 'default' | 'low' | 'medium' | 'high'

export const OPENCODE_EFFORT_LEVELS: readonly OpencodeEffort[] = [
  'default',
  'low',
  'medium',
  'high',
]

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

const STORE_PATH = join(homedir(), '.claude', 'opencode-thinking.json')

let _loaded = false
let _cache: Record<string, OpencodeEffort> = {}

function load(): void {
  if (_loaded) return
  _loaded = true
  try {
    if (!existsSync(STORE_PATH)) return
    const raw = readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, OpencodeEffort> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && (OPENCODE_EFFORT_LEVELS as readonly string[]).includes(v)) {
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
  try {
    const dir = dirname(STORE_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(STORE_PATH, JSON.stringify(_cache, null, 2), 'utf8')
  } catch {
    // Persistence is best-effort. The in-memory cache still works for the
    // current session even if the disk write fails (read-only home, etc.).
  }
}

export function getOpencodeEffort(model: string): OpencodeEffort {
  load()
  const key = model.trim().toLowerCase()
  const stored = _cache[key]
  if (stored) return stored
  if (FREE_TIER_DEFAULT_MEDIUM(model) && isOpencodeThinkingModel(model)) {
    return 'medium'
  }
  return 'default'
}

export function setOpencodeEffort(model: string, effort: OpencodeEffort): void {
  load()
  const key = model.trim().toLowerCase()
  if (effort === 'default') {
    delete _cache[key]
  } else {
    _cache[key] = effort
  }
  save()
}

export function cycleOpencodeEffort(
  model: string,
  direction: 'left' | 'right',
): OpencodeEffort {
  const current = getOpencodeEffort(model)
  const idx = OPENCODE_EFFORT_LEVELS.indexOf(current)
  const len = OPENCODE_EFFORT_LEVELS.length
  const next =
    direction === 'right'
      ? OPENCODE_EFFORT_LEVELS[(idx + 1) % len]!
      : OPENCODE_EFFORT_LEVELS[(idx - 1 + len) % len]!
  setOpencodeEffort(model, next)
  return next
}

/**
 * Label rendered in the picker chip. Capitalized for the row.
 */
export function getOpencodeEffortLabel(effort: OpencodeEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}
