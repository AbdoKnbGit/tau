/** Mistral API chat models verified against models.dev and Mistral's model,
 * pricing and reasoning docs on 2026-10-09. See docs/mistral-provider.md.
 * Only current, tool-capable vision/coding models with >=256K context belong
 * in the picker. Keep API aliases here so limits, prices and effort agree.
 */
import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export interface MistralModelMeta {
  id: string
  name: string
  aliases: string[]
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
  toggle: boolean
  efforts: string[]
  released: string
  vision: boolean
  tools: boolean
  /** USD per million input, output and cached input tokens (standard API). */
  price: [number, number, number, null]
}

const MODELS: readonly MistralModelMeta[] = [
  { id: 'mistral-large-4', name: 'Mistral Large 4', aliases: ['mistral-large-4-0'],
    contextWindow: 1_048_576, maxOutputTokens: 262_144, reasoning: true,
    toggle: false, efforts: ['none', 'high'], released: '2026-10-06',
    vision: true, tools: true, price: [0.68, 2.09, 0.07, null] },
  { id: 'zai-glm-5-3', name: 'GLM-5.3', aliases: [],
    contextWindow: 1_048_576, maxOutputTokens: 131_072, reasoning: true,
    toggle: false, efforts: ['low', 'high', 'max'], released: '2026-09-15',
    vision: false, tools: true, price: [1.4, 4.4, 0.14, null] },
  { id: 'mistral-medium-3-5', name: 'Mistral Medium 3.5',
    aliases: ['mistral-medium-2604', 'mistral-medium-latest'],
    contextWindow: 262_144, maxOutputTokens: 262_144, reasoning: true,
    toggle: false, efforts: ['none', 'high'], released: '2026-04-28',
    vision: true, tools: true, price: [1.5, 7.5, 0.15, null] },
  { id: 'mistral-large-2512', name: 'Mistral Large 3', aliases: ['mistral-large-latest'],
    contextWindow: 262_144, maxOutputTokens: 262_144, reasoning: false,
    toggle: false, efforts: [], released: '2025-12-02',
    vision: true, tools: true, price: [0.5, 1.5, 0.05, null] },
]

export function getMistralModelMeta(model: string): MistralModelMeta | undefined {
  const id = model.trim().toLowerCase()
  return MODELS.find(row => row.id === id || row.aliases.includes(id))
}

export function mistralModelInfo(model: string, contextWindow?: number): ModelInfo | null {
  const meta = getMistralModelMeta(model)
  if (!meta) return null
  const context = typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow : meta.contextWindow
  if (context < 256_000) return null
  return { id: model, name: meta.name, contextWindow: context, supportsToolCalling: true,
    provider: 'Mistral', tags: ['tools', ...(meta.vision ? ['vision'] : []), ...(meta.reasoning ? ['reasoning'] : [])] }
}

export function mistralStaticCatalog(): ModelInfo[] {
  return MODELS.map(row => mistralModelInfo(row.id)!)
}

/** Never fall back to unfiltered upstream rows when every row was excluded. */
export function filterMistralCatalog(models: Array<{ id: string; name?: string; contextWindow?: number }>): ModelInfo[] {
  return MODELS.flatMap(meta => {
    const match = [meta.id, ...meta.aliases]
      .map(id => models.find(row => row.id.toLowerCase() === id))
      .find(row => row && mistralModelInfo(row.id, row.contextWindow))
    return match ? [mistralModelInfo(match.id, match.contextWindow)!] : []
  })
}
