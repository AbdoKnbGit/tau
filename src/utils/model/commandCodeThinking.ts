import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type CommandCodeEffort =
  | 'default'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export type CommandCodeWireEffort = Exclude<CommandCodeEffort, 'default'>

export const COMMAND_CODE_EFFORT_LEVELS: readonly CommandCodeEffort[] = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export const COMMAND_CODE_EFFORT_DESCRIPTIONS: Record<CommandCodeEffort, string> = {
  default: 'Use the provider default reasoning level',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra reasoning depth for complex problems',
  max: 'Maximum reasoning budget for the hardest problems',
}

const CLAUDE_REASONING_EFFORTS: readonly CommandCodeEffort[] = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

const GPT_REASONING_EFFORTS: readonly CommandCodeEffort[] = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
]

const GPT_54_MINI_EFFORTS: readonly CommandCodeEffort[] = [
  'default',
  'low',
  'medium',
  'high',
]

const STORE_PATH = join(homedir(), '.claude', 'commandcode-thinking.json')

let _loaded = false
let _cache: Record<string, CommandCodeEffort> = {}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase()
}

function comparableModel(model: string): string {
  return normalizeModel(model).replace(/[._]/g, '-')
}

function providerlessModel(model: string): string {
  return comparableModel(model).split('/').pop() ?? comparableModel(model)
}

function storeKey(model: string): string {
  return normalizeModel(model)
}

function storeKeys(model: string): string[] {
  const key = storeKey(model)
  const alias = key.split('/').pop() ?? key
  return alias === key ? [key] : [key, alias]
}

export function isCommandCodeClaudeModel(model: string): boolean {
  return comparableModel(model).includes('claude')
}

function isCommandCodeClaudeHaiku(model: string): boolean {
  const m = comparableModel(model)
  return m.includes('claude') && m.includes('haiku')
}

function isCommandCodeClaudeOpusOrSonnet(model: string): boolean {
  const m = comparableModel(model)
  return m.includes('claude') && (m.includes('opus') || m.includes('sonnet'))
}

function isCommandCodeGptModel(model: string): boolean {
  const m = comparableModel(model)
  const leaf = providerlessModel(model)
  return leaf.startsWith('gpt-') || m.includes('/gpt-') || leaf.includes('codex')
}

function isGpt54Mini(model: string): boolean {
  const leaf = providerlessModel(model)
  return leaf === 'gpt-5-4-mini' || leaf.startsWith('gpt-5-4-mini-')
}

export function commandCodeEffortLevelsForModel(
  model: string,
): readonly CommandCodeEffort[] {
  if (isCommandCodeClaudeHaiku(model)) return ['default']
  if (isCommandCodeClaudeOpusOrSonnet(model)) return CLAUDE_REASONING_EFFORTS
  if (isCommandCodeGptModel(model)) {
    return isGpt54Mini(model) ? GPT_54_MINI_EFFORTS : GPT_REASONING_EFFORTS
  }
  return ['default']
}

export function supportsCommandCodeEffortSelection(
  model: string,
  _tags?: readonly string[],
): boolean {
  return commandCodeEffortLevelsForModel(model).length > 1
}

function load(): void {
  if (_loaded) return
  _loaded = true
  try {
    if (!existsSync(STORE_PATH)) return
    const raw = readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return

    const next: Record<string, CommandCodeEffort> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'string'
        && (COMMAND_CODE_EFFORT_LEVELS as readonly string[]).includes(value)
      ) {
        next[key.toLowerCase()] = value as CommandCodeEffort
      }
    }
    _cache = next
  } catch {
    // Stale or corrupt state should not break the picker.
  }
}

function save(): void {
  try {
    const dir = dirname(STORE_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(STORE_PATH, JSON.stringify(_cache, null, 2), 'utf8')
  } catch {
    // Persistence is best-effort; the in-memory value still works this run.
  }
}

export function getCommandCodeEffort(model: string): CommandCodeEffort {
  load()
  const levels = commandCodeEffortLevelsForModel(model)
  const stored = storeKeys(model).map(key => _cache[key]).find(Boolean)
  return stored && levels.includes(stored) ? stored : 'default'
}

export function setCommandCodeEffort(
  model: string,
  effort: CommandCodeEffort,
): void {
  load()
  const keys = storeKeys(model)
  const levels = commandCodeEffortLevelsForModel(model)
  const next = levels.includes(effort) ? effort : 'default'
  if (next === 'default') {
    for (const key of keys) delete _cache[key]
  } else {
    for (const key of keys) _cache[key] = next
  }
  save()
}

export function cycleCommandCodeEffort(
  model: string,
  direction: 'left' | 'right',
): CommandCodeEffort {
  const levels = commandCodeEffortLevelsForModel(model)
  if (levels.length <= 1) return 'default'
  const current = getCommandCodeEffort(model)
  const idx = Math.max(0, levels.indexOf(current))
  const len = levels.length
  const next =
    direction === 'right'
      ? levels[(idx + 1) % len]!
      : levels[(idx - 1 + len) % len]!
  setCommandCodeEffort(model, next)
  return next
}

export function getCommandCodeEffortLabel(effort: CommandCodeEffort): string {
  return effort === 'xhigh'
    ? 'XHigh'
    : effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function getCommandCodeRequestEffort(
  model: string,
): CommandCodeWireEffort | null {
  const effort = getCommandCodeEffort(model)
  return effort === 'default' ? null : effort
}

export function commandCodeAnthropicBudgetForEffort(
  effort: CommandCodeWireEffort,
): number {
  switch (effort) {
    case 'low': return 4000
    case 'medium': return 8000
    case 'high': return 16000
    case 'xhigh': return 24000
    case 'max': return 30000
  }
}

export function getCommandCodeModelDisplayName(modelId: string): string | null {
  const leaf = modelId.split('/').pop() ?? modelId
  const normalized = leaf.toLowerCase()
  const full = modelId.toLowerCase()
  switch (normalized) {
    case 'gpt-5.3-codex':
      return 'GPT-5.3 Codex'
    case 'gpt-5.4-mini':
      return 'GPT-5.4 Mini'
    case 'claude-opus-4-8':
      return 'Claude Opus 4.8'
    case 'claude-opus-4-7':
      return 'Claude Opus 4.7'
    case 'claude-opus-4-6':
      return 'Claude Opus 4.6'
    case 'claude-sonnet-4-6':
      return 'Claude Sonnet 4.6'
    case 'claude-haiku-4-5':
    case 'claude-haiku-4-5-20251001':
      return 'Claude Haiku 4.5'
    case 'deepseek-v4-flash':
    case 'deepseek/deepseek-v4-flash':
      return 'DeepSeek V4 Flash'
    case 'deepseek-v4-pro':
      return 'DeepSeek V4 Pro'
    case 'kimi-k2.6':
      return 'Kimi K2.6'
    case 'kimi-k2.5':
      return 'Kimi K2.5'
    case 'qwen3.7-max':
      return 'Qwen 3.7 Max'
    case 'qwen3.7-plus':
      return 'Qwen 3.7 Plus'
    case 'qwen3.7-max-free':
      return 'Qwen 3.7 Max Free'
    case 'minimax-m3':
      return 'MiniMax M3'
    case 'minimax-m2.7':
      return 'MiniMax M2.7'
    case 'minimax-m2.5':
      return 'MiniMax M2.5'
    case 'glm-5.1':
      return 'GLM 5.1'
    case 'glm-5':
      return 'GLM 5'
    default:
      if (full.endsWith('/kimi-k2.6')) return 'Kimi K2.6'
      if (full.endsWith('/kimi-k2.5')) return 'Kimi K2.5'
      if (full.endsWith('/qwen3.7-max')) return 'Qwen 3.7 Max'
      if (full.endsWith('/qwen3.7-plus')) return 'Qwen 3.7 Plus'
      if (full.endsWith('/qwen3.7-max-free')) return 'Qwen 3.7 Max Free'
      if (full.endsWith('/minimax-m3')) return 'MiniMax M3'
      if (full.endsWith('/minimax-m2.7')) return 'MiniMax M2.7'
      if (full.endsWith('/minimax-m2.5')) return 'MiniMax M2.5'
      return null
  }
}

export function inferCommandCodeUpstreamProvider(modelId: string): string {
  const m = comparableModel(modelId)
  if (m.includes('claude')) return 'Anthropic'
  if (isCommandCodeGptModel(modelId) || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
    return 'OpenAI / Codex'
  }
  if (m.includes('deepseek')) return 'DeepSeek'
  if (m.includes('gemini')) return 'Google Gemini'
  if (m.includes('qwen') || m.includes('qwq')) return 'Qwen'
  if (m.includes('glm')) return 'GLM'
  if (m.includes('kimi') || m.includes('moonshot')) return 'Moonshot AI'
  if (m.includes('minimax')) return 'MiniMax AI'
  if (m.includes('grok') || m.includes('xai')) return 'xAI'
  return 'Command Code'
}

export function _resetCommandCodeThinkingForTests(
  cache: Record<string, CommandCodeEffort> = {},
): void {
  _loaded = true
  _cache = { ...cache }
}
