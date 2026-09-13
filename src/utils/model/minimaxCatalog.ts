import { enrichDirectModel } from './directProviderCatalog.js'
import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export type MiniMaxCatalogModel = Partial<ModelInfo> & {
  id?: string
  name?: string
  context_length?: number
  context_window?: number
  max_context_length?: number
  max_tokens?: number
  supports_tool_calling?: boolean
  tags?: readonly string[]
  capabilities?: {
    function_calling?: boolean
  }
}

export function filterMiniMaxModelCatalog(
  models: readonly MiniMaxCatalogModel[],
): ModelInfo[] {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const model of models) {
    if (typeof model.id !== 'string') continue
    const id = model.id.trim()
    const key = id.toLowerCase()
    if (!isMiniMaxTextModel(id) || seen.has(key)) continue
    seen.add(key)
    out.push(enrichDirectModel('minimax', toMiniMaxModelInfo({ ...model, id })))
  }
  return out
}

export function toMiniMaxModelInfo(
  model: MiniMaxCatalogModel & { id: string },
): ModelInfo {
  const id = model.id.trim()
  const contextWindow =
    numberOrUndefined(model.contextWindow)
    ?? numberOrUndefined(model.context_length)
    ?? numberOrUndefined(model.context_window)
    ?? numberOrUndefined(model.max_context_length)
  const supportsToolCalling =
    model.supportsToolCalling === true
    || model.tags?.includes('tools') === true
    || model.supports_tool_calling === true
    || model.capabilities?.function_calling === true
    || undefined
  const tags = normalizeMiniMaxTags(model, id)

  return {
    id,
    name: model.name && model.name.trim() ? model.name.trim() : labelMiniMaxModel(id),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(supportsToolCalling ? { supportsToolCalling } : {}),
    ...(model.provider ? { provider: model.provider } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  }
}

function isMiniMaxTextModel(id: string): boolean {
  const lower = id.toLowerCase()
  return (
    lower.startsWith('minimax-m') &&
    !lower.includes('speech') &&
    !lower.includes('audio') &&
    !lower.includes('tts') &&
    !lower.includes('voice') &&
    !lower.includes('image') &&
    !lower.includes('video') &&
    !lower.includes('music') &&
    !lower.includes('embedding')
  )
}

function labelMiniMaxModel(id: string): string {
  return id.replace(/-highspeed$/i, ' High Speed')
}

function normalizeMiniMaxTags(
  model: MiniMaxCatalogModel,
  id: string,
): string[] {
  const tags = new Set<string>()
  for (const tag of model.tags ?? []) {
    if (typeof tag === 'string' && tag.trim()) tags.add(tag.trim())
  }
  tags.add('reasoning')
  if (id.toLowerCase().includes('highspeed')) tags.add('fast')
  return Array.from(tags)
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}
