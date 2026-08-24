/**
 * LXD API model catalog.
 *
 * LXD (api.lxds.org) publishes an OpenRouter-shaped `/v1/models` document
 * that already carries everything Tau needs to drive the picker:
 *
 *   capabilities.reasoning_efforts  -> the effort ladder for THIS model
 *   capabilities.reasoning          -> whether the effort chip shows at all
 *   capabilities.vision / .tools    -> row badges + tool-calling gate
 *   context_length / max_tokens     -> context window + output clamp
 *   architecture.modality           -> "text->image" / "audio->text" rows we hide
 *
 * The ladders are genuinely per-model and NOT a fixed low/medium/high set --
 * gpt-oss-120b takes low|medium|high, the DeepSeek V4 rows take none|high|max,
 * and several rows expose only high. So the picker reads the ladder from here
 * instead of hardcoding one, and `recordLxdCatalog` refreshes it from every
 * live `/v1/models` response: a model LXD adds tomorrow gets a correct chip
 * without a Tau release.
 *
 * The static seed below is the catalog as published on 2026-08-23; it is the
 * synchronous fallback for the very first paint (and for offline use) before
 * any live response has landed.
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'

/**
 * How LXD drives thinking for a model upstream, as reported by the dashboard's
 * `/public/models`. The relay accepts a uniform `reasoning_effort` regardless,
 * so this is informational -- it explains why the ladders differ per row.
 */
export type LxdReasoningType = 'native' | 'tags' | 'auto' | 'none'

/** Effort stops LXD accepts. 'default' is Tau-side: send no field at all. */
export type LxdEffort = 'default' | 'none' | 'low' | 'medium' | 'high' | 'max'

/** Every effort LXD has been observed to accept, for validating stored picks. */
export const LXD_ALL_EFFORTS: readonly LxdEffort[] = [
  'default',
  'none',
  'low',
  'medium',
  'high',
  'max',
]

export interface LxdModelMeta {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  reasoningType: LxdReasoningType
  /** Ladder as published by the API, WITHOUT the Tau-side 'default' stop. */
  reasoningEfforts: readonly LxdEffort[]
  vision: boolean
  tools: boolean
  /** Limited-time event row -- free/unlimited while the event runs. */
  event: boolean
  /** Xen (LXD's credit unit) per 1M tokens. */
  xenPerMillion: { prompt: number; completion: number }
}

/**
 * LXD's documented per-request output ceiling ("max: 32,000 (context: 1M)").
 * deepseek-v4-pro-0813 advertises max_tokens 400k in the catalog, which is a
 * context figure rather than a per-request cap -- clamp everything to the
 * documented ceiling so a large request cannot 400 on the way out.
 */
export const LXD_MAX_OUTPUT_TOKENS = 32_000

const LXD_STATIC_CATALOG: readonly LxdModelMeta[] = [
  {
    id: 'gpt-oss-120b',
    name: 'GPT OSS 120B',
    contextWindow: 131_072,
    maxOutputTokens: 4_096,
    reasoningType: 'native',
    reasoningEfforts: ['low', 'medium', 'high'],
    vision: false,
    tools: true,
    event: false,
    xenPerMillion: { prompt: 10, completion: 54 },
  },
  {
    id: 'glm-4.7-flash',
    name: 'GLM 4.7 Flash',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    reasoningType: 'tags',
    reasoningEfforts: ['high'],
    vision: false,
    tools: true,
    event: false,
    xenPerMillion: { prompt: 28, completion: 184 },
  },
  {
    id: 'llama-4-scout',
    name: 'LLaMA 4 Scout',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    reasoningType: 'none',
    reasoningEfforts: [],
    vision: true,
    tools: true,
    event: false,
    xenPerMillion: { prompt: 124, completion: 391 },
  },
  {
    id: 'gemma-4-31b',
    name: 'Gemma 4 31B',
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    reasoningType: 'native',
    reasoningEfforts: ['high'],
    vision: false,
    tools: true,
    event: false,
    xenPerMillion: { prompt: 26, completion: 112 },
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax M3',
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
    reasoningType: 'none',
    reasoningEfforts: [],
    vision: true,
    tools: true,
    event: false,
    xenPerMillion: { prompt: 74, completion: 307 },
  },
  {
    id: 'nemotron-3-ultra',
    name: 'Nemotron 3 Ultra',
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    reasoningType: 'native',
    reasoningEfforts: ['high'],
    vision: false,
    tools: true,
    event: false,
    xenPerMillion: { prompt: 160, completion: 704 },
  },
  {
    id: 'deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash 0731',
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
    reasoningType: 'native',
    reasoningEfforts: ['none', 'high', 'max'],
    vision: false,
    tools: true,
    event: false,
    xenPerMillion: { prompt: 110, completion: 330 },
  },
  {
    id: 'qwen3.8-27b',
    name: 'Qwen 3.8 27B',
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    reasoningType: 'auto',
    reasoningEfforts: ['low', 'medium', 'high'],
    vision: false,
    tools: true,
    event: false,
    xenPerMillion: { prompt: 113, completion: 800 },
  },
  {
    id: 'random-model',
    name: 'Random models',
    contextWindow: 256_000,
    maxOutputTokens: 32_000,
    reasoningType: 'auto',
    reasoningEfforts: ['low', 'medium', 'high'],
    vision: false,
    tools: true,
    event: true,
    xenPerMillion: { prompt: 0, completion: 0 },
  },
  {
    id: 'deepseek-v4-pro-0813',
    name: 'DeepSeek V4 PRO 0813',
    contextWindow: 1_000_000,
    maxOutputTokens: 400_000,
    reasoningType: 'native',
    reasoningEfforts: ['none', 'high', 'max'],
    vision: false,
    tools: true,
    event: true,
    xenPerMillion: { prompt: 290, completion: 870 },
  },
  {
    id: 'spy-model',
    name: 'Test model',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    reasoningType: 'native',
    reasoningEfforts: ['high'],
    vision: false,
    tools: true,
    event: true,
    xenPerMillion: { prompt: 0, completion: 0 },
  },
  {
    id: 'qwen-3.8-2.4t-a95b',
    name: 'Qwen 3.8 2.4t a95b',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    reasoningType: 'native',
    reasoningEfforts: ['high'],
    vision: false,
    tools: true,
    event: true,
    xenPerMillion: { prompt: 410, completion: 920 },
  },
]

/** Live metadata, keyed by lowercased model id. Seeded from the static list. */
const _meta = new Map<string, LxdModelMeta>(
  LXD_STATIC_CATALOG.map(m => [m.id.toLowerCase(), m]),
)

/** Raw `/v1/models` row shape, as far as we rely on it. */
export interface LxdCatalogRow {
  id?: string
  name?: string
  context_length?: number
  max_tokens?: number
  architecture?: { modality?: string }
  pricing?: { prompt?: string | number; completion?: string | number }
  capabilities?: {
    reasoning?: boolean
    reasoning_efforts?: readonly string[]
    vision?: boolean
    tools?: boolean
    stream?: boolean
  }
}

function isEffort(value: string): value is LxdEffort {
  return (LXD_ALL_EFFORTS as readonly string[]).includes(value)
}

/** True for rows LXD serves over /v1/chat/completions (not image / speech). */
export function isLxdChatRow(row: LxdCatalogRow): boolean {
  const modality = row.architecture?.modality?.toLowerCase() ?? ''
  if (modality.includes('->image') || modality.startsWith('audio')) return false
  // Belt-and-braces for rows that omit `architecture`: the image and speech
  // families are the only non-chat ones LXD publishes.
  const id = row.id?.toLowerCase() ?? ''
  if (id.includes('emaj') || id.startsWith('flux-') || id.includes('whisper')) {
    return false
  }
  return true
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Fold a live `/v1/models` response into the metadata map so the picker's
 * effort ladders, context windows, and output clamps track the API.
 */
export function recordLxdCatalog(rows: readonly LxdCatalogRow[]): void {
  for (const row of rows) {
    const id = row.id?.trim()
    if (!id || !isLxdChatRow(row)) continue
    const key = id.toLowerCase()
    const previous = _meta.get(key)
    const caps = row.capabilities ?? {}
    const efforts = (caps.reasoning_efforts ?? []).filter(isEffort)
    // `pricing` is a per-token rate; LXD's own Xen figure is that number x 1e6.
    // Keep the seeded value when a row omits pricing.
    const promptPrice = toNumber(row.pricing?.prompt)
    const completionPrice = toNumber(row.pricing?.completion)

    _meta.set(key, {
      id,
      name: row.name?.trim() || previous?.name || id,
      contextWindow: row.context_length ?? previous?.contextWindow ?? 131_072,
      maxOutputTokens: row.max_tokens ?? previous?.maxOutputTokens ?? 8_192,
      // /v1/models carries no reasoning_type -- keep whatever the seed knew.
      reasoningType:
        previous?.reasoningType ?? (caps.reasoning ? 'native' : 'none'),
      reasoningEfforts: caps.reasoning === false
        ? []
        : efforts.length > 0
          ? efforts
          : previous?.reasoningEfforts ?? [],
      vision: caps.vision ?? previous?.vision ?? false,
      tools: caps.tools ?? previous?.tools ?? true,
      event: previous?.event ?? false,
      xenPerMillion: {
        prompt: promptPrice != null
          ? Math.round(promptPrice * 1_000_000)
          : previous?.xenPerMillion.prompt ?? 0,
        completion: completionPrice != null
          ? Math.round(completionPrice * 1_000_000)
          : previous?.xenPerMillion.completion ?? 0,
      },
    })
  }
}

/** Metadata for one model id, or undefined when LXD has never listed it. */
export function getLxdModelMeta(model: string): LxdModelMeta | undefined {
  return _meta.get(model.trim().toLowerCase())
}

/** Every chat model currently known -- seed plus anything a live call added. */
export function listLxdModelMeta(): LxdModelMeta[] {
  return [..._meta.values()]
}

/** Per-model output ceiling, clamped to LXD's documented per-request cap. */
export function lxdMaxOutputTokens(model: string): number {
  const meta = getLxdModelMeta(model)
  return Math.min(
    meta?.maxOutputTokens ?? LXD_MAX_OUTPUT_TOKENS,
    LXD_MAX_OUTPUT_TOKENS,
  )
}

function toModelInfo(meta: LxdModelMeta): ModelInfo {
  const tags: string[] = []
  if (meta.reasoningEfforts.length > 0) tags.push('reasoning')
  if (meta.event) tags.push('free')
  tags.push(meta.tools ? 'tools' : 'no-tools')
  return {
    id: meta.id,
    name: meta.name,
    contextWindow: meta.contextWindow,
    supportsToolCalling: meta.tools,
    tags,
  }
}

/**
 * Curated fallback catalog, used when `/v1/models` is unreachable. Ordered as
 * LXD publishes it, which leads with the cheap general-purpose rows.
 */
export function lxdStaticCatalog(): ModelInfo[] {
  return LXD_STATIC_CATALOG.map(toModelInfo)
}

/**
 * Drop the image / speech rows from a live `/v1/models` payload. Generic over
 * the row type so it composes with the lane's `filterModelCatalog` hook, which
 * hands over a narrower `{ id, name }` shape than the raw catalog row.
 */
export function filterLxdModelCatalog<T extends { id?: string }>(
  rows: readonly T[],
): T[] {
  return rows.filter(row => isLxdChatRow(row as LxdCatalogRow))
}
