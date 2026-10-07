/**
 * Global reasoning effort store for OpenAI Codex models.
 *
 * Request-scoped effort takes precedence over the standalone picker store.
 * Settings are read lazily, after CLI/settings sources have been initialized.
 */

import { convertEffortValueToLevel, getEffortEnvOverride, type EffortValue } from '../effortValue.js'
import { getSessionSettingsCache } from '../settings/settingsCache.js'

export type OpenAIReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const STANDARD_REASONING_LEVELS: readonly OpenAIReasoningLevel[] = [
  'low',
  'medium',
  'high',
]

const EXTENDED_REASONING_LEVELS: readonly OpenAIReasoningLevel[] = [
  ...STANDARD_REASONING_LEVELS,
  'xhigh',
]

const MAX_REASONING_LEVELS: readonly OpenAIReasoningLevel[] = [
  ...EXTENDED_REASONING_LEVELS,
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

let _currentLevel: OpenAIReasoningLevel | undefined

export function getOpenAIReasoningLevel(
  modelId?: string,
  effortValue?: EffortValue | null,
): OpenAIReasoningLevel {
  return resolveOpenAIReasoningEffort(modelId, effortValue)
    ?? clampReasoningLevel('medium', modelId)
}

function clampReasoningLevel(level: OpenAIReasoningLevel, modelId?: string): OpenAIReasoningLevel {
  if (!modelId) return level
  const levels = getAllReasoningLevels(modelId)
  const requested = MAX_REASONING_LEVELS.indexOf(level)
  return [...levels].reverse().find(candidate => MAX_REASONING_LEVELS.indexOf(candidate) <= requested)
    ?? levels[0]!
}

/** Whether the standalone picker has a session override. */
export function isReasoningLevelExplicit(): boolean {
  return _currentLevel !== undefined
}

export function setOpenAIReasoningLevel(level: OpenAIReasoningLevel | undefined): void {
  _currentLevel = level
}

/**
 * env → request/session choice → merged settings → server default.
 * null represents an explicit auto/unset request, so a stale picker value
 * cannot revive a cleared setting. Never store a model-specific clamp: switching
 * back to a more capable model must restore the user's original preference.
 */
export function resolveOpenAIReasoningEffort(
  modelId?: string,
  effortValue?: EffortValue | null,
): OpenAIReasoningLevel | undefined {
  if (modelId && !modelSupportsReasoning(modelId)) return undefined
  const env = getEffortEnvOverride()
  if (env === null) return undefined
  const value = env ?? (effortValue === null
    ? undefined
    : effortValue ?? _currentLevel ?? getSessionSettingsCache()?.settings.effortLevel)
  if (value === undefined) return undefined
  const level = convertEffortValueToLevel(value)
  return clampReasoningLevel(level === 'ultracode' ? 'max' : level, modelId)
}

/**
 * Standalone transports may run before AppState has loaded settings. Load the
 * normal settings cascade at request time, never during module initialization:
 * settings imports provider clients indirectly, so a static import here creates
 * a cycle through OpenAIProvider's subclasses. Explicit request values need no I/O.
 */
export async function resolveOpenAIRequestEffort(
  modelId: string,
  effortValue?: EffortValue | null,
): Promise<OpenAIReasoningLevel | undefined> {
  if (!modelSupportsReasoning(modelId)) return undefined
  if (effortValue === undefined && _currentLevel === undefined && getEffortEnvOverride() === undefined) {
    const { getInitialSettings } = await import('../settings/settings.js')
    effortValue = getInitialSettings().effortLevel ?? null
  }
  return resolveOpenAIReasoningEffort(modelId, effortValue)
}

export function cycleOpenAIReasoningLevel(
  direction: 'left' | 'right',
  modelId?: string,
  effortValue?: EffortValue | null,
): OpenAIReasoningLevel {
  _currentLevel = getNextOpenAIReasoningLevel(direction, modelId, effortValue)
  return _currentLevel
}

/** Preview a picker change without mutating another request's session state. */
export function getNextOpenAIReasoningLevel(
  direction: 'left' | 'right',
  modelId?: string,
  effortValue?: EffortValue | null,
): OpenAIReasoningLevel {
  const levels = getAllReasoningLevels(modelId)
  const currentLevel = getOpenAIReasoningLevel(modelId, effortValue)
  const idx = levels.indexOf(currentLevel)
  return levels[(idx + (direction === 'right' ? 1 : -1) + levels.length) % levels.length]!
}

export function getReasoningLabel(level: OpenAIReasoningLevel): string {
  return REASONING_LABELS[level]
}

export function getAllReasoningLevels(modelId?: string): readonly OpenAIReasoningLevel[] {
  if (!modelId) return EXTENDED_REASONING_LEVELS
  const normalized = normalizeModelId(modelId)
  if (/^gpt-5-pro(?:$|-)/.test(normalized)) return ['high']
  if (modelSupportsMaxReasoning(modelId)) return MAX_REASONING_LEVELS
  const version = gptVersion(modelId)
  const extended = version && (version.major > 5 || version.minor >= 2)
    || /^gpt-5\.1-codex-max(?:$|-)/.test(normalized)
  if (extended) {
    return /-pro(?:$|-)/.test(normalized)
      ? ['medium', 'high', 'xhigh']
      : EXTENDED_REASONING_LEVELS
  }
  return STANDARD_REASONING_LEVELS
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^openai\//, '')
}

function gptVersion(modelId: string): { major: number; minor: number } | undefined {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:$|-)/.exec(normalizeModelId(modelId))
  return version ? { major: Number(version[1]), minor: Number(version[2] ?? 0) } : undefined
}

/**
 * The API's `max` effort arrived with GPT-5.6, and every later family (GPT-6
 * Sol, Luna and Astra) accepts it as well (models.dev, 2026-09-26). Judged by
 * version rather than a list of ids, so a new release gets its top tier
 * without an edit here.
 */
export function modelSupportsMaxReasoning(modelId: string): boolean {
  const version = gptVersion(modelId)
  if (!version) return false
  const { major, minor } = version
  return major > 5 || (major === 5 && minor >= 6)
}

/**
 * Check if an OpenAI model supports reasoning_effort.
 * GPT-5 family + o-series reasoning models.
 */
export function modelSupportsReasoning(modelId: string): boolean {
  const normalized = normalizeModelId(modelId)
  if (/(?:^|-)chat(?:-|$)/.test(normalized)) return false
  return /^(?:o[1-9]\d*(?:$|-)|gpt-(?:[5-9]|[1-9]\d+)(?:$|[.-])|codex-)/.test(normalized)
}
