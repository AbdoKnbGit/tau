import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { selectInheritedEffort, type EffortFallback } from './effortInheritance.js'
import { getAllReasoningLevels, modelSupportsReasoning } from './openaiReasoning.js'

const LEVELS = ['low', 'medium', 'high'] as const
export type CompatEffort = typeof LEVELS[number] | 'none' | 'on' | 'xhigh' | 'max' | 'adaptive'
let loadedPath = ''
let selections: Record<string, string> = {}

/** Existing gateway controls; unknown models must never receive speculative fields. */
export function compatEffortLevels(provider: string, model: string): readonly CompatEffort[] {
  const m = model.trim().toLowerCase()
  switch (provider) {
    case 'groq': return m.includes('gpt-oss') ? LEVELS : []
    case 'vercel':
    case 'requesty': return m.startsWith('openai/') ? gatewayOpenAIEfforts(m) : []
    case 'modelrouter': return gatewayOpenAIEfforts(m)
    case 'agentrouter': return m.startsWith('claude-opus-4') || m.startsWith('claude-haiku-4') || m.includes('deepseek-r1') || m.startsWith('glm-5') ? LEVELS : []
    case 'fireworks': return fireworksEffortLevels(m)
    case 'kilocode': return /^(?:openai\/)?(?:gpt-|o[1-9])/.test(m) ? gatewayOpenAIEfforts(m)
      : /claude-(?:sonnet|opus)-4|gemini-(?:2\.5|3)|deepseek-(?:reasoner|r1)|thinking/.test(m) ? LEVELS : []
    default: return []
  }
}

function gatewayOpenAIEfforts(model: string): readonly CompatEffort[] {
  if (!modelSupportsReasoning(model)) return []
  // Retain the gateway's existing three-tier surface, narrowed by the
  // upstream model (chat models have no knob; GPT-5 Pro only accepts high).
  return LEVELS.filter(level => getAllReasoningLevels(model).includes(level))
}

// Use effective tiers rather than aliases that the server silently promotes.
// https://docs.fireworks.ai/api-reference/post-chatcompletions#body-reasoning-effort
function fireworksEffortLevels(model: string): readonly CompatEffort[] {
  const m = model.slice(model.lastIndexOf('/') + 1)
  if (/^(?:deepseek-v4|kimi-k3)/.test(m)) return ['none', 'low', 'high', 'max']
  if (/^glm-5[.p]2/.test(m)) return ['none', 'high', 'max']
  if (/^qwen3[.p]8/.test(m)) return ['none', 'low', 'medium', 'xhigh']
  if (/^minimax-m3/.test(m)) return [...LEVELS, 'adaptive']
  if (/^(?:minimax-m2|gpt-oss)/.test(m)) return LEVELS
  if (/^(?:deepseek-v3[.p][12]|glm-(?:4[.p][567]|5[.p]1))/.test(m)) return ['none', 'on']
  // A custom deployment or an unrecognized row may use a non-thinking chat
  // template. Leave its server default alone instead of inferring a knob.
  return []
}

function path(): string {
  return process.env.TAU_COMPAT_THINKING_STORE || join(homedir(), '.claude', 'compat-thinking.json')
}
function load(): void {
  if (loadedPath === path()) return
  loadedPath = path()
  selections = {}
  try {
    const saved = JSON.parse(readFileSync(loadedPath, 'utf8'))
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      selections = Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    }
  } catch { /* No manual choices yet. */ }
}
function key(provider: string, model: string): string { return `${provider}:${model.trim().toLowerCase()}` }
function save(): void {
  try {
    mkdirSync(dirname(path()), { recursive: true })
    writeFileSync(path(), JSON.stringify(selections, null, 2))
  } catch { /* Keep the session choice when persistence is unavailable. */ }
}
export function hasExplicitCompatEffort(provider: string, model: string): boolean {
  load()
  return (compatEffortLevels(provider, model) as readonly string[]).includes(selections[key(provider, model)] ?? '')
}
export function getCompatEffort(provider: string, model: string, fallback?: EffortFallback): CompatEffort | undefined {
  load()
  if (hasExplicitCompatEffort(provider, model)) return selections[key(provider, model)] as CompatEffort
  return selectInheritedEffort(compatEffortLevels(provider, model), fallback)
}
export function getCompatRequestEffort(provider: string, model: string, fallback?: EffortFallback): Exclude<CompatEffort, 'on'> | undefined {
  const effort = getCompatEffort(provider, model, fallback)
  // Fireworks' binary models accept medium to enable thinking. The UI exposes
  // this as On because the model does not implement a medium effort tier.
  return effort === 'on' ? 'medium' : effort
}
export function setCompatEffort(provider: string, model: string, effort: string): void {
  load()
  if (!(compatEffortLevels(provider, model) as readonly string[]).includes(effort)) return
  selections[key(provider, model)] = effort
  save()
}
export function clearCompatEffort(provider: string, model: string): void {
  load()
  delete selections[key(provider, model)]
  save()
}
