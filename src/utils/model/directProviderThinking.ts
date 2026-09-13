/** Per-model controls, scoped to GLM, Moonshot and MiniMax's native APIs. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getDirectModelMeta, type DirectThinkingProvider } from './directProviderCatalog.js'
import { getGlmThinking } from './glmThinking.js'
import { isDirectProvider, isDirectThinkingProvider } from './directProviderCatalog.js'
import { deepseekEffortLevelsFor, supportsDeepSeekEffortSelection } from './deepseekThinking.js'

let loadedPath = ''
let selections: Record<string, string> = {}
function path(): string {
  return process.env.TAU_DIRECT_THINKING_STORE || join(homedir(), '.claude', 'direct-provider-thinking.json')
}
function load(): void {
  if (loadedPath === path()) return
  loadedPath = path()
  selections = {}
  try {
    const saved = JSON.parse(readFileSync(loadedPath, 'utf8'))
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      selections = Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    }
  } catch { /* Use provider defaults. */ }
}
function key(provider: DirectThinkingProvider, model: string): string {
  return `${provider}:${model.trim().toLowerCase()}`
}

export function directEffortLevels(provider: DirectThinkingProvider, model: string): readonly string[] {
  const meta = getDirectModelMeta(provider, model)
  if (!meta?.reasoning) return []
  return [...(meta.toggle ? ['off'] : []), ...(meta.efforts.length ? meta.efforts : meta.toggle ? ['on'] : [])]
}

export function getDirectEffort(provider: DirectThinkingProvider, model: string): string {
  load()
  const levels = directEffortLevels(provider, model)
  const stored = selections[key(provider, model)]
  if (stored && levels.includes(stored)) return stored
  if (levels.includes('max')) return 'max'
  if (levels.includes('on')) return provider === 'glm' && !getGlmThinking() ? 'off' : 'on'
  return levels.at(-1) ?? 'on'
}

export function setDirectEffort(provider: DirectThinkingProvider, model: string, effort: string): void {
  load()
  if (!directEffortLevels(provider, model).includes(effort)) return
  selections[key(provider, model)] = effort
  try {
    mkdirSync(dirname(path()), { recursive: true })
    writeFileSync(path(), JSON.stringify(selections, null, 2))
  } catch { /* The session selection still applies. */ }
}

export function cycleDirectEffort(provider: DirectThinkingProvider, model: string, direction: 'left' | 'right'): void {
  const levels = directEffortLevels(provider, model)
  if (!levels.length) return
  const index = levels.indexOf(getDirectEffort(provider, model))
  setDirectEffort(provider, model, levels[(index + (direction === 'right' ? 1 : -1) + levels.length) % levels.length]!)
}

export function directEffortLabel(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** Text search gets the same context and capability information as the picker. */
export function directModelDetails(provider: string, model: string, contextWindow?: number): string {
  if (!isDirectProvider(provider)) return ''
  const context = ` [${contextWindow?.toLocaleString('en-US') ?? 'unknown'} context]`
  const levels = isDirectThinkingProvider(provider) ? directEffortLevels(provider, model)
    : supportsDeepSeekEffortSelection(model) ? deepseekEffortLevelsFor(model) : []
  const thinking = levels.length ? ` [Thinking: ${levels.map(directEffortLabel).join('/')}]`
    : getDirectModelMeta(provider, model)?.reasoning ? ' [Thinking always on]' : ''
  return context + thinking
}

export function directThinkingFields(provider: DirectThinkingProvider, model: string): {
  thinking?: { type: 'enabled' | 'disabled' | 'adaptive'; clear_thinking?: boolean }
  reasoning_effort?: string
} {
  const meta = getDirectModelMeta(provider, model)
  if (!meta?.reasoning) return {}
  const effort = getDirectEffort(provider, model)
  if (meta.toggle && effort === 'off') return { thinking: { type: 'disabled' } }
  const reasoning = meta.efforts.includes(effort) ? { reasoning_effort: effort } : {}
  if (provider === 'glm') return { thinking: { type: 'enabled', ...(/^glm-(?:4\.7|5)/i.test(model) ? { clear_thinking: false } : {}) }, ...reasoning }
  if (provider === 'minimax') return meta.toggle ? { thinking: { type: 'adaptive' } } : {}
  return meta.toggle ? { thinking: { type: 'enabled' }, ...reasoning } : reasoning
}
