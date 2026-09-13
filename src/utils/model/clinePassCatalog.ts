import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import { stripClineEffortVariant } from './clineThinking.js'

export const CLINE_PASS_PROVIDER = 'clinepass'
export const CLINE_PASS_LABEL = 'Cline Pass'

// Offline fallback only. The live Cline Pass list is the `clinePass` bucket of
// Cline's recommended-models feed, the same source Cline's own model pickers
// read (see lanes/cline/catalog.ts). This snapshot of that bucket is used when
// the feed cannot be reached, like the bundled catalog the Cline SDK ships.
const BUNDLED_CLINE_PASS_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'cline-pass/qwen3.8-max', name: 'Qwen3.8 Max' },
  { id: 'cline-pass/glm-5.2', name: 'GLM 5.2' },
  { id: 'cline-pass/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'cline-pass/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'cline-pass/kimi-k3', name: 'Kimi K3' },
  { id: 'cline-pass/glm-5.3-flash', name: 'GLM 5.3 Flash' },
  { id: 'cline-pass/glm-5.3', name: 'GLM 5.3' },
  { id: 'cline-pass/qwen3.7-plus', name: 'Qwen3.7 Plus' },
  { id: 'cline-pass/minimax-m3', name: 'MiniMax M3' },
  { id: 'cline-pass/kimi-k2.7-code', name: 'Kimi K2.7 Code' },
  { id: 'cline-pass/kimi-k2.6', name: 'Kimi K2.6' },
  { id: 'cline-pass/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'cline-pass/qwen3.7-max', name: 'Qwen3.7 Max' },
  { id: 'cline-pass/mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' },
  { id: 'cline-pass/mimo-v2.5', name: 'MiMo-V2.5' },
]

// Display names from the most recent live list, keyed by lowercase model id.
const liveDisplayNames = new Map<string, string>()

function normalizeClinePassModelId(modelId: string): string {
  return stripClineEffortVariant(modelId).trim().toLowerCase()
}

export function isClinePassProvider(provider: string | undefined): boolean {
  return provider === CLINE_PASS_PROVIDER
}

export function getClinePassModelDisplayName(modelId: string): string | null {
  const id = normalizeClinePassModelId(modelId)
  return liveDisplayNames.get(id)
    ?? BUNDLED_CLINE_PASS_MODELS.find(model => model.id === id)?.name
    ?? null
}

/** Remember the live list's names so status lines match the picker. */
export function recordClinePassModelNames(
  models: readonly Pick<ModelInfo, 'id' | 'name'>[],
): void {
  for (const model of models) {
    if (model.name && model.name !== model.id) {
      liveDisplayNames.set(normalizeClinePassModelId(model.id), model.name)
    }
  }
}

export function toClinePassModelInfo(
  id: string,
  name: string,
  details: Pick<ModelInfo, 'contextWindow' | 'supportsToolCalling'> = {},
): ModelInfo {
  return {
    id,
    name,
    provider: CLINE_PASS_LABEL,
    ...(details.contextWindow ? { contextWindow: details.contextWindow } : {}),
    supportsToolCalling: details.supportsToolCalling ?? true,
    tags: ['thinking', 'pro'],
  }
}

/** The bundled offline list, in feed order. */
export function getClinePassModels(): ModelInfo[] {
  return BUNDLED_CLINE_PASS_MODELS.map(model =>
    toClinePassModelInfo(model.id, model.name))
}
