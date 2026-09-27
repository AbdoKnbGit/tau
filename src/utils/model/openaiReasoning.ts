/**
 * Global reasoning effort store for OpenAI Codex models.
 *
 * The model picker writes the user's chosen level here; the OpenAI
 * provider reads it at request time.
 */

export type OpenAIReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const STANDARD_REASONING_LEVELS: readonly OpenAIReasoningLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

const MAX_REASONING_LEVELS: readonly OpenAIReasoningLevel[] = [
  ...STANDARD_REASONING_LEVELS,
  'max',
]

const REASONING_LABELS: Record<OpenAIReasoningLevel, string> = {
  low:    'Low',
  medium: 'Medium',
  high:   'High',
  xhigh:  'Extra High',
  // The API value is `max`; "Ultra" is the picker-facing name requested for
  // the top tier GPT-5.6 introduced.
  max:    'Ultra',
}

let _currentLevel: OpenAIReasoningLevel = 'medium'

/** True once the user has explicitly picked a level via ← → in the picker. */
let _explicitlySet = false

export function getOpenAIReasoningLevel(modelId?: string): OpenAIReasoningLevel {
  if (!modelId) return _currentLevel

  const levels = getAllReasoningLevels(modelId)
  return levels.includes(_currentLevel)
    ? _currentLevel
    : levels[levels.length - 1]!
}

/** Whether the user has explicitly chosen a reasoning level. */
export function isReasoningLevelExplicit(): boolean {
  return _explicitlySet
}

export function setOpenAIReasoningLevel(level: OpenAIReasoningLevel): void {
  _currentLevel = level
  _explicitlySet = true
}

export function cycleOpenAIReasoningLevel(
  direction: 'left' | 'right',
  modelId?: string,
): OpenAIReasoningLevel {
  const levels = getAllReasoningLevels(modelId)
  const currentLevel = levels.includes(_currentLevel)
    ? _currentLevel
    : levels[levels.length - 1]!
  const idx = levels.indexOf(currentLevel)
  if (direction === 'right') {
    _currentLevel = levels[(idx + 1) % levels.length]!
  } else {
    _currentLevel = levels[(idx - 1 + levels.length) % levels.length]!
  }
  _explicitlySet = true
  return _currentLevel
}

export function getReasoningLabel(level: OpenAIReasoningLevel): string {
  return REASONING_LABELS[level]
}

export function getAllReasoningLevels(modelId?: string): readonly OpenAIReasoningLevel[] {
  return modelId && modelSupportsMaxReasoning(modelId)
    ? MAX_REASONING_LEVELS
    : STANDARD_REASONING_LEVELS
}

/**
 * The API's `max` effort arrived with GPT-5.6, and every later family (GPT-6
 * Sol, Luna and Astra) accepts it as well (models.dev, 2026-09-26). Judged by
 * version rather than a list of ids, so a new release gets its top tier
 * without an edit here.
 */
export function modelSupportsMaxReasoning(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase().replace(/^openai\//, '')
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:$|-)/.exec(normalized)
  if (!version) return false
  const major = Number(version[1])
  const minor = version[2] === undefined ? 0 : Number(version[2])
  return major > 5 || (major === 5 && minor >= 6)
}

/**
 * Check if an OpenAI model supports reasoning_effort.
 * GPT-5 family + o-series reasoning models.
 */
export function modelSupportsReasoning(modelId: string): boolean {
  return /^(o[1-9](-|$)|o[1-9][0-9]?(-mini|-pro)?|gpt-[5-9])/i.test(modelId)
}
