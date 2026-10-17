import type { EffortValue } from '../effortValue.js'
import { type APIProvider, PROVIDER_DISPLAY_NAMES } from './providers.js'
import { selectInheritedEffort } from './effortInheritance.js'
import { getDirectModelMeta, isDirectThinkingProvider } from './directProviderCatalog.js'
import { clearDirectEffort, directEffortLevels, getDirectEffort, hasExplicitDirectEffort, setDirectEffort } from './directProviderThinking.js'
import { clearDeepSeekEffort, deepseekEffortLevelsFor, getDeepSeekEffort, hasExplicitDeepSeekEffort, setDeepSeekEffort, supportsDeepSeekEffortSelection } from './deepseekThinking.js'
import { clearClineEffort, getClineEffort, getClineEffortLabel, getClineThinkingLadder, hasExplicitClineEffort, parseClineEffortVariant, setClineEffort } from './clineThinking.js'
import { clearOpencodeEffort, getOpencodeEffort, hasExplicitOpencodeEffort, opencodeEffortLevelsFor, setOpencodeEffort, supportsOpencodeThinkingSelection } from './opencodeThinking.js'
import { clearCommandCodeEffort, commandCodeEffortLevelsForModel, getCommandCodeEffort, hasExplicitCommandCodeEffort, setCommandCodeEffort, supportsCommandCodeEffortSelection } from './commandCodeThinking.js'
import { clearCloudflareEffort, cloudflareEffortLevelsForModel, getCloudflareEffort, hasExplicitCloudflareEffort, setCloudflareEffort, supportsCloudflareThinkingSelection } from './cloudflareThinking.js'
import { clearLxdEffort, getLxdEffort, hasExplicitLxdEffort, lxdEffortLevelsFor, setLxdEffort, supportsLxdEffortSelection } from './lxdThinking.js'
import { clearMimoEffort, getMimoEffort, hasExplicitMimoEffort, mimoEffortLevelsFor, setMimoEffort, supportsMimoEffortSelection } from './mimoThinking.js'
import { alibabaEffortLevelsFor, clearAlibabaEffort, getAlibabaEffort, hasExplicitAlibabaEffort, setAlibabaEffort, supportsAlibabaEffortSelection } from './alibabaThinking.js'
import { clearOpenRouterEffort, getOpenRouterEffort, hasExplicitOpenRouterEffort, openRouterEffortLevelsFor, setOpenRouterEffort, supportsOpenRouterEffortSelection } from './openrouterThinking.js'
import { clearCompatEffort, compatEffortLevels, getCompatEffort, hasExplicitCompatEffort, setCompatEffort } from './compatEffort.js'
import { clearXaiEffort, getXaiEffort, hasExplicitXaiEffort, setXaiEffort, xaiEffortLevelsFor } from './xaiThinking.js'
import { getXaiModelMeta } from './xaiCatalog.js'

export type ProviderEffortState = {
  supported: boolean
  levels: readonly string[]
  value?: string
  label: string
  explicit: boolean
  source: 'model' | 'configured' | 'default' | 'unavailable'
}

type ProviderEffortControl = {
  state: ProviderEffortState
  set: (value: string) => void
  clear: () => void
}

/** These providers keep their existing effort commands and resolution rules. */
export function usesProviderEffort(provider: APIProvider): boolean {
  return !['firstParty', 'bedrock', 'vertex', 'foundry', 'openai', 'gemini', 'antigravity'].includes(provider)
}

function effortLabel(value: string): string {
  if (value === 'default') return 'provider default'
  if (value === 'off' || value === 'none') return 'thinking off'
  if (value === 'on') return 'thinking on'
  return value
}

function modelEffortLabel(provider: APIProvider, model: string, value: string): string {
  if ((provider === 'cline' || provider === 'clinepass') && (value === 'none' || value === 'on')) {
    const label = getClineEffortLabel(value, model).toLowerCase()
    return label === 'default' ? 'provider default' : `thinking ${label}`
  }
  return effortLabel(value)
}

function control<T extends string>(
  levels: readonly T[],
  get: () => T,
  set: (value: T) => void,
  clear: () => void,
  explicit: boolean,
  fallback: EffortValue | null | undefined,
  label: (value: T) => string = effortLabel,
): ProviderEffortControl {
  const value = get()
  return {
    state: {
      supported: true,
      levels,
      value,
      label: label(value),
      explicit,
      source: explicit ? 'model'
        : selectInheritedEffort(levels, fallback) === value ? 'configured' : 'default',
    },
    set(value) {
      const supported = levels.find(level => level === value)
      if (supported !== undefined) set(supported)
    },
    clear,
  }
}

/** Bind the same native per-model controls that the model picker uses. */
function getControl(
  provider: APIProvider,
  model: string,
  fallback?: EffortValue | null,
): ProviderEffortControl | undefined {
  const compatibleLevels = compatEffortLevels(provider, model)
  if (compatibleLevels.length > 0) {
    return control(['default', ...compatibleLevels], () => getCompatEffort(provider, model, fallback) ?? 'default',
      value => setCompatEffort(provider, model, value), () => clearCompatEffort(provider, model),
      hasExplicitCompatEffort(provider, model), fallback)
  }
  if (isDirectThinkingProvider(provider)) {
    const levels = directEffortLevels(provider, model)
    if (levels.length < 2) return undefined
    return control(levels, () => getDirectEffort(provider, model, fallback), value => setDirectEffort(provider, model, value),
      () => clearDirectEffort(provider, model), hasExplicitDirectEffort(provider, model), fallback)
  }
  switch (provider) {
    case 'deepseek':
      if (!supportsDeepSeekEffortSelection(model)) return undefined
      return control(deepseekEffortLevelsFor(model), () => getDeepSeekEffort(model, fallback), value => setDeepSeekEffort(model, value),
        () => clearDeepSeekEffort(model), hasExplicitDeepSeekEffort(model), fallback)
    case 'cline':
    case 'clinepass': {
      if (parseClineEffortVariant(model).effort !== undefined) return undefined
      const ladder = getClineThinkingLadder(model)
      if (!ladder || ladder.levels.length < 2) return undefined
      return control(ladder.levels, () => getClineEffort(model, fallback), value => setClineEffort(model, value),
        () => clearClineEffort(model), hasExplicitClineEffort(model), fallback,
        value => modelEffortLabel(provider, model, value))
    }
    case 'opencode':
    case 'opencodego':
      if (!supportsOpencodeThinkingSelection(provider, model)) return undefined
      return control(opencodeEffortLevelsFor(model, provider), () => getOpencodeEffort(model, provider, fallback), value => setOpencodeEffort(model, value, provider),
        () => clearOpencodeEffort(model, provider), hasExplicitOpencodeEffort(model, provider), fallback)
    case 'commandcode':
      if (!supportsCommandCodeEffortSelection(model)) return undefined
      return control(commandCodeEffortLevelsForModel(model), () => getCommandCodeEffort(model, fallback), value => setCommandCodeEffort(model, value),
        () => clearCommandCodeEffort(model), hasExplicitCommandCodeEffort(model), fallback)
    case 'cloudflare':
      if (!supportsCloudflareThinkingSelection(model)) return undefined
      return control(cloudflareEffortLevelsForModel(model), () => getCloudflareEffort(model, fallback), value => setCloudflareEffort(model, value),
        () => clearCloudflareEffort(model), hasExplicitCloudflareEffort(model), fallback)
    case 'lxd':
      if (!supportsLxdEffortSelection(model)) return undefined
      return control(lxdEffortLevelsFor(model), () => getLxdEffort(model, fallback), value => setLxdEffort(model, value),
        () => clearLxdEffort(model), hasExplicitLxdEffort(model), fallback)
    case 'mimo':
      if (!supportsMimoEffortSelection(model)) return undefined
      return control(mimoEffortLevelsFor(model), () => getMimoEffort(model, fallback), value => setMimoEffort(model, value),
        () => clearMimoEffort(model), hasExplicitMimoEffort(model), fallback)
    case 'alibaba':
      if (!supportsAlibabaEffortSelection(model)) return undefined
      return control(alibabaEffortLevelsFor(model), () => getAlibabaEffort(model, fallback), value => setAlibabaEffort(model, value),
        () => clearAlibabaEffort(model), hasExplicitAlibabaEffort(model), fallback)
    case 'openrouter':
      if (!supportsOpenRouterEffortSelection(model)) return undefined
      return control(openRouterEffortLevelsFor(model), () => getOpenRouterEffort(model, fallback), value => setOpenRouterEffort(model, value),
        () => clearOpenRouterEffort(model), hasExplicitOpenRouterEffort(model), fallback)
    case 'xai': {
      // The row's own ladder from xAI's catalog. `default` sends no effort, so
      // xAI applies the model's default (high on Grok 4.5 and later).
      const levels = xaiEffortLevelsFor(model)
      if (levels.length === 0) return undefined
      const builtIn = getXaiModelMeta(model)?.defaultEffort
      return control(['default', ...levels], () => getXaiEffort(model, fallback) ?? 'default', value => setXaiEffort(model, value),
        () => clearXaiEffort(model), hasExplicitXaiEffort(model), fallback,
        value => value === 'default' && builtIn ? `provider default (${builtIn})` : effortLabel(value))
    }
    default:
      return undefined
  }
}

export function getProviderEffort(
  provider: APIProvider,
  model: string,
  fallback?: EffortValue | null,
): ProviderEffortState | null {
  if (!usesProviderEffort(provider)) return null
  if ((provider === 'cline' || provider === 'clinepass') && parseClineEffortVariant(model).effort !== undefined) {
    const value = getClineEffort(model, fallback)
    return { supported: false, levels: [], value, label: `${modelEffortLabel(provider, model, value)} (selected model variant)`, explicit: true, source: 'model' }
  }
  const fixedLevels = isDirectThinkingProvider(provider) ? directEffortLevels(provider, model) : []
  return getControl(provider, model, fallback)?.state ?? {
    supported: false,
    levels: [],
    label: fixedLevels.length === 1 ? `${effortLabel(fixedLevels[0]!)} (fixed)`
      : (isDirectThinkingProvider(provider) && getDirectModelMeta(provider, model)?.reasoning)
          || (provider === 'xai' && getXaiModelMeta(model)?.reasoning)
        ? 'thinking always on' : 'provider/model default',
    explicit: false,
    source: 'unavailable',
  }
}

function describeCurrent(state: ProviderEffortState): string {
  if (!state.supported) return `Current thinking: ${state.label} (no adjustable effort control for this provider/model).`
  if (state.source === 'model') return `Current effort level: ${state.label} (selected for this model)`
  if (state.source === 'configured') return `Current effort level: ${state.label} (inherited from session/settings)`
  return `Effort level: auto (currently ${state.label})`
}

/** Picker previews stay local until a model is selected with Enter. */
export function getProviderEffortPreview(
  provider: APIProvider,
  model: string,
  fallback?: EffortValue | null,
  selection?: string,
): ProviderEffortState | null {
  const state = getProviderEffort(provider, model, fallback)
  if (!state?.supported || selection === undefined) return state
  if (selection === 'auto') return { ...state, value: undefined, label: 'auto (session/settings)', explicit: false, source: 'default' }
  if (!state.levels.includes(selection)) return state
  return { ...state, value: selection, label: modelEffortLabel(provider, model, selection), explicit: true, source: 'model' }
}

export function getNextProviderEffort(
  provider: APIProvider,
  model: string,
  direction: 'left' | 'right',
  fallback?: EffortValue | null,
  selection?: string,
): string | undefined {
  const state = getProviderEffort(provider, model, fallback)
  if (!state?.supported) return undefined
  const levels = ['auto', ...state.levels.filter(level => level !== 'default')]
  const current = selection ?? state.value ?? 'auto'
  const index = Math.max(0, levels.indexOf(current))
  return levels[(index + (direction === 'right' ? 1 : -1) + levels.length) % levels.length]
}

/** Model-only consumers (for example agent configuration) cannot change effort. */
export function commitProviderEffortSelection(
  provider: APIProvider,
  model: string,
  selection: string | undefined,
  allowSelection = true,
): boolean {
  if (!allowSelection || selection === undefined || !usesProviderEffort(provider)) return false
  const binding = getControl(provider, model)
  if (!binding) return false
  if (selection === 'auto' || selection === 'default') {
    binding.clear()
    return true
  }
  if (!binding.state.levels.includes(selection)) return false
  binding.set(selection)
  return true
}

/** Native changes never overwrite the global preference or OpenAI session state. */
export function executeProviderEffort(
  provider: APIProvider,
  model: string,
  args: string,
  fallback?: EffortValue | null,
): { message: string } | null {
  if (!usesProviderEffort(provider)) return null
  const binding = getControl(provider, model, fallback)
  const state = binding?.state ?? getProviderEffort(provider, model, fallback)!
  const normalized = args.trim().toLowerCase()
  if (!state.supported || !binding) return { message: describeCurrent(state) }
  if (!normalized || normalized === 'current' || normalized === 'status') return { message: describeCurrent(state) }
  const levels = state.levels.filter(level => level !== 'default')
  if (['help', '-h', '--help'].includes(normalized)) {
    return { message: `Usage: /effort [${[...levels, 'auto'].join('|')}]\n\nApplies to ${PROVIDER_DISPLAY_NAMES[provider]} / ${model}.\nAuto clears this model's selection and follows the session/settings preference where supported, then the provider default.` }
  }
  if (['auto', 'unset', 'default'].includes(normalized)) {
    binding.clear()
    const next = getProviderEffort(provider, model, fallback)!
    return { message: `Effort level set to auto for this model. ${describeCurrent(next)}` }
  }
  if (!levels.includes(normalized)) {
    return { message: `Unsupported effort level: ${args}. Valid options for ${PROVIDER_DISPLAY_NAMES[provider]} / ${model}: ${[...levels, 'auto'].join(', ')}` }
  }
  binding.set(normalized)
  const next = getProviderEffort(provider, model, fallback)!
  return { message: `Set effort level to ${next.label} for ${PROVIDER_DISPLAY_NAMES[provider]} / ${model}` }
}
