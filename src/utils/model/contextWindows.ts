import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import type { APIProvider } from './providers.js'

type ContextWindowMap = Record<string, number>

const OPENAI_LONG_CONTEXT_WINDOW = 1_050_000
const GEMINI_LONG_CONTEXT_WINDOW = 1_048_576
const GEMINI_15_PRO_CONTEXT_WINDOW = 2_097_152

const providerContextWindows = new Map<APIProvider, Map<string, number>>()

const PROVIDER_SCOPED_CONTEXT_WINDOWS: Partial<Record<APIProvider, ContextWindowMap>> = {
  firstParty: {
    'claude-opus-4-8': 1_000_000,
    'claude-opus-4-7': 1_000_000,
  },
  kiro: {
    auto: 1_000_000,
    'claude-sonnet-4.5': 200_000,
    'claude-sonnet-4': 200_000,
    'claude-haiku-4.5': 200_000,
    'deepseek-3.2': 164_000,
    'minimax-m2.5': 196_000,
    'minimax-m2.1': 196_000,
    'glm-5': 200_000,
    'qwen3-coder-next': 256_000,
  },
  cursor: {
    'claude-4-sonnet-1m': 1_000_000,
    'claude-4-sonnet-1m-thinking': 1_000_000,
  },
  glm: {
    'glm-5.1': 200_000,
    'glm-5-turbo': 200_000,
    'glm-5': 200_000,
    'glm-4.7': 200_000,
  },
  moonshot: {
    'kimi-k2.6': 262_144,
    'kimi-k2.5': 262_144,
    'kimi-k2-thinking': 262_144,
    'kimi-k2-thinking-turbo': 262_144,
    'kimi-k2-turbo-preview': 262_144,
    'kimi-k2-0905-preview': 262_144,
    'kimi-k2-0711-preview': 131_072,
  },
  minimax: {
    'minimax-m2.7': 204_800,
    'minimax-m2.7-highspeed': 204_800,
    'minimax-m2.5': 196_000,
    'minimax-m2.5-highspeed': 196_000,
    'minimax-m2.1': 196_000,
    'minimax-m2.1-highspeed': 196_000,
  },
}

const KNOWN_MODEL_CONTEXT_WINDOWS: ContextWindowMap = {
  // OpenAI and Codex catalogs.
  'gpt-5.5': 272_000,
  'gpt-5.5-pro': 272_000,
  'gpt-5.4': OPENAI_LONG_CONTEXT_WINDOW,
  'gpt-5.4-pro': OPENAI_LONG_CONTEXT_WINDOW,
  'gpt-5.4-mini': 272_000,
  'gpt-5.4-nano': 272_000,
  'gpt-5.3-codex': 272_000,
  'gpt-5.3-codex-spark-preview': 272_000,
  'gpt-5.2': 272_000,
  'gpt-5.2-codex': 272_000,
  'gpt-5.1': 272_000,
  'gpt-5.1-codex-max': 272_000,
  'gpt-5.1-codex-mini': 272_000,
  'gpt-5-mini': 272_000,
  'gpt-5': 200_000,
  'gpt-5-codex': 200_000,
  o1: 200_000,
  'o1-mini': 128_000,
  'o1-preview': 128_000,
  o3: 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
  'gpt-4.1': 1_000_000,
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,

  // Google Gemini catalogs.
  'gemini-3.1-pro': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3.1-pro-high': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3.1-pro-low': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3.1-pro-preview': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3.1-pro-preview-customtools': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3.5-flash-high': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3.5-flash-medium': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3.1-flash-lite-preview': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3-flash': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3-flash-preview': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-2.5-pro': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-2.5-flash': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-2.0': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-1.5-pro': GEMINI_15_PRO_CONTEXT_WINDOW,
  'gemini-1.5-flash': GEMINI_LONG_CONTEXT_WINDOW,

  // Provider-owned and OpenAI-compatible catalogs.
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  'deepseek-coder': 128_000,
  'minimax-m2.7': 204_800,
  'minimax-m2.7-highspeed': 204_800,
  'deepseek-3.2': 164_000,
  'minimax-m2.5': 196_000,
  'minimax-m2.1': 196_000,
  'glm-5.1': 200_000,
  'glm-5-turbo': 200_000,
  'glm-5': 200_000,
  'glm-4.7': 200_000,
  'kimi-k2.6': 262_144,
  'kimi-k2.5': 262_144,
  'kimi-k2-thinking': 262_144,
  'kimi-k2-thinking-turbo': 262_144,
  'kimi-k2-turbo-preview': 262_144,
  'kimi-k2-0905-preview': 262_144,
  'kimi-k2-0711-preview': 131_072,
  'qwen3-coder-next': 256_000,

  // Ollama common models.
  llama3: 8_192,
  'llama3.1': 128_000,
  'llama3.2': 128_000,
  'llama3.3': 128_000,
  codellama: 16_384,
  mixtral: 32_768,
  mistral: 32_768,
  'qwen2.5': 128_000,
  phi3: 128_000,
  'command-r': 128_000,
}

const PREFIX_CONTEXT_WINDOWS: ContextWindowMap = {
  'gpt-5.4-mini': 272_000,
  'gpt-5.4-nano': 272_000,
  'gpt-5.4-pro': OPENAI_LONG_CONTEXT_WINDOW,
  'gpt-5.4': OPENAI_LONG_CONTEXT_WINDOW,
  'gpt-5.3-codex': 272_000,
  'gpt-5.2-codex': 272_000,
  'gpt-5.2': 272_000,
  'gpt-5.1-codex-max': 272_000,
  'gpt-5.1-codex-mini': 272_000,
  'gpt-5.1': 272_000,
  'gpt-5-mini': 272_000,
  'gemini-3.5-flash': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3.1-pro': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3.1-flash-lite': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-3-flash': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-2.5-pro': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-2.5-flash': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-2.0': GEMINI_LONG_CONTEXT_WINDOW,
  'gemini-1.5-pro': GEMINI_15_PRO_CONTEXT_WINDOW,
  'gemini-1.5-flash': GEMINI_LONG_CONTEXT_WINDOW,
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  'deepseek-coder': 128_000,
  'minimax-m2.7': 204_800,
  'minimax-m2.7-highspeed': 204_800,
  'minimax-m2.5': 196_000,
  'minimax-m2.5-highspeed': 196_000,
  'minimax-m2.1': 196_000,
  'minimax-m2.1-highspeed': 196_000,
  'glm-5.1': 200_000,
  'glm-5-turbo': 200_000,
  'glm-5': 200_000,
  'glm-4.7': 200_000,
  'kimi-k2.6': 262_144,
  'kimi-k2.5': 262_144,
  'kimi-k2-thinking': 262_144,
  'kimi-k2-thinking-turbo': 262_144,
  'kimi-k2-turbo-preview': 262_144,
  'kimi-k2-0905-preview': 262_144,
  'kimi-k2-0711-preview': 131_072,
  'llama3.3': 128_000,
  'llama3.2': 128_000,
  'llama3.1': 128_000,
  llama3: 8_192,
  codellama: 16_384,
  mixtral: 32_768,
  mistral: 32_768,
  'qwen2.5': 128_000,
  phi3: 128_000,
  'command-r': 128_000,
}

const VARIANT_SUFFIXES = new Set([
  'fast',
  'high',
  'low',
  'max',
  'medium',
  'minimal',
  'none',
  'thinking',
  'xhigh',
])

export function recordProviderModelContextWindows(
  provider: APIProvider,
  models: readonly ModelInfo[],
): void {
  let providerWindows = providerContextWindows.get(provider)
  if (!providerWindows) {
    providerWindows = new Map()
    providerContextWindows.set(provider, providerWindows)
  }

  for (const model of models) {
    if (
      typeof model.contextWindow !== 'number' ||
      !Number.isFinite(model.contextWindow) ||
      model.contextWindow <= 0
    ) {
      continue
    }

    for (const candidate of getModelLookupCandidates(model.id)) {
      providerWindows.set(candidate, model.contextWindow)
    }
  }
}

export function getProviderCatalogContextWindow(
  model: string,
  provider?: APIProvider,
): number | undefined {
  const candidates = getModelLookupCandidates(model)
  if (candidates.length === 0) {
    return undefined
  }

  if (provider) {
    const dynamicWindow = lookupMap(candidates, providerContextWindows.get(provider))
    if (dynamicWindow !== undefined) {
      return dynamicWindow
    }

    const scopedWindow = lookupRecord(candidates, PROVIDER_SCOPED_CONTEXT_WINDOWS[provider])
    if (scopedWindow !== undefined) {
      return scopedWindow
    }
  }

  const exactWindow = lookupRecord(candidates, KNOWN_MODEL_CONTEXT_WINDOWS)
  if (exactWindow !== undefined) {
    return exactWindow
  }

  return lookupPrefixes(candidates)
}

function lookupMap(
  candidates: readonly string[],
  values: ReadonlyMap<string, number> | undefined,
): number | undefined {
  if (!values) {
    return undefined
  }

  for (const candidate of candidates) {
    const value = values.get(candidate)
    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

function lookupRecord(
  candidates: readonly string[],
  values: ContextWindowMap | undefined,
): number | undefined {
  if (!values) {
    return undefined
  }

  for (const candidate of candidates) {
    const value = values[candidate]
    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

function lookupPrefixes(candidates: readonly string[]): number | undefined {
  const keys = Object.keys(PREFIX_CONTEXT_WINDOWS).sort((a, b) => b.length - a.length)
  for (const candidate of candidates) {
    for (const key of keys) {
      if (candidate.startsWith(key)) {
        return PREFIX_CONTEXT_WINDOWS[key]
      }
    }
  }

  return undefined
}

function getModelLookupCandidates(model: string): string[] {
  const normalized = normalizeModelId(model)
  if (!normalized) {
    return []
  }

  const baseCandidates = [normalized]
  const slashIndex = normalized.lastIndexOf('/')
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    baseCandidates.push(normalized.slice(slashIndex + 1))
  }

  const candidates: string[] = []
  for (const candidate of baseCandidates) {
    addVariantCandidates(candidate, candidates)
  }

  return Array.from(new Set(candidates))
}

function addVariantCandidates(candidate: string, candidates: string[]): void {
  let current = candidate
  for (let i = 0; i < 6; i += 1) {
    candidates.push(current)
    const stripped = stripKnownVariantSuffix(current)
    if (!stripped || stripped === current) {
      return
    }
    current = stripped
  }
}

function stripKnownVariantSuffix(model: string): string | null {
  const parts = model.split('-')
  if (parts.length <= 1) {
    return null
  }

  const suffix = parts[parts.length - 1]
  if (!suffix || !VARIANT_SUFFIXES.has(suffix)) {
    return null
  }

  return parts.slice(0, -1).join('-')
}

function normalizeModelId(model: string): string {
  let normalized = model.trim().toLowerCase()
  if (!normalized) {
    return ''
  }

  const effortSeparator = '::effort='
  const effortIndex = normalized.lastIndexOf(effortSeparator)
  if (effortIndex >= 0) {
    normalized = normalized.slice(0, effortIndex)
  }

  normalized = normalized.replace(/\[1m\]$/i, '').trim()
  normalized = normalized.replace(/^models\//, '')
  normalized = normalized.replace(/^antigravity-/, '')

  return normalized
}
