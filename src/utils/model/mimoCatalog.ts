/**
 * Xiaomi MiMo model catalog.
 *
 * MiMo is a first-party vendor API (not a relay), served from two billing
 * surfaces that speak the identical wire protocol:
 *
 *   api.xiaomimimo.com/v1              pay-as-you-go
 *   token-plan-sgp.xiaomimimo.com/v1   Token Plan subscription (also -cn)
 *
 * `/v1/models` is auth-gated — an unauthenticated GET answers
 * `{"error":{"message":"Invalid API Key","code":"401","type":"invalid_key"}}` —
 * so the catalog below is the source of truth for the picker, and a live
 * response only refines it once the user has logged in.
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'

/** Effort stops MiMo accepts on `reasoning_effort`. */
export type MimoEffort = 'low' | 'medium' | 'high'

export const MIMO_EFFORT_LEVELS: readonly MimoEffort[] = ['low', 'medium', 'high']

/** MiMo's own default reasoning level when the caller expresses no preference. */
export const MIMO_DEFAULT_EFFORT: MimoEffort = 'medium'

export interface MimoModelMeta {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  /** Every MiMo chat row reasons; the ladder is uniform low/medium/high. */
  reasoning: boolean
  vision: boolean
  tools: boolean
}

const MIMO_STATIC_CATALOG: readonly MimoModelMeta[] = [
  {
    id: 'mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    vision: false,
    tools: true,
  },
  {
    id: 'mimo-v2.5',
    name: 'MiMo V2.5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    vision: true,
    tools: true,
  },
]

const _meta = new Map<string, MimoModelMeta>(
  MIMO_STATIC_CATALOG.map(m => [m.id.toLowerCase(), m]),
)

/** Raw `/v1/models` row, as far as we rely on it. */
export interface MimoCatalogRow {
  id?: string
  name?: string
  context_length?: number
  max_tokens?: number
  max_output_tokens?: number
}

/**
 * Fold a live `/v1/models` response into the metadata map. MiMo's catalog
 * endpoint returns a plain OpenAI list, so unknown rows inherit conservative
 * defaults rather than being dropped — a new MiMo model stays usable without
 * a Tau release.
 */
export function recordMimoCatalog(rows: readonly MimoCatalogRow[]): void {
  for (const row of rows) {
    const id = row.id?.trim()
    if (!id) continue
    const key = id.toLowerCase()
    const previous = _meta.get(key)
    _meta.set(key, {
      id,
      name: row.name?.trim() || previous?.name || id,
      contextWindow: row.context_length ?? previous?.contextWindow ?? 256_000,
      maxOutputTokens:
        row.max_output_tokens ?? row.max_tokens ?? previous?.maxOutputTokens ?? 64_000,
      reasoning: previous?.reasoning ?? true,
      vision: previous?.vision ?? false,
      tools: previous?.tools ?? true,
    })
  }
}

export function getMimoModelMeta(model: string): MimoModelMeta | undefined {
  return _meta.get(model.trim().toLowerCase())
}

export function listMimoModelMeta(): MimoModelMeta[] {
  return [..._meta.values()]
}

/** Per-model output ceiling. MiMo publishes generous per-model caps. */
export function mimoMaxOutputTokens(model: string): number {
  return getMimoModelMeta(model)?.maxOutputTokens ?? 64_000
}

/** True for a model MiMo serves with reasoning enabled. */
export function isMimoReasoningModel(model: string): boolean {
  return getMimoModelMeta(model)?.reasoning ?? false
}

function toModelInfo(meta: MimoModelMeta): ModelInfo {
  const tags: string[] = ['reasoning']
  if (meta.tools) tags.push('tools')
  return {
    id: meta.id,
    name: meta.name,
    contextWindow: meta.contextWindow,
    supportsToolCalling: meta.tools,
    tags,
  }
}

/** Curated catalog, used directly (the live endpoint is auth-gated). */
export function mimoStaticCatalog(): ModelInfo[] {
  return MIMO_STATIC_CATALOG.map(toModelInfo)
}

/** Every model currently known — static seed plus anything a live call added. */
export function mimoModelCatalog(): ModelInfo[] {
  return listMimoModelMeta().map(toModelInfo)
}
