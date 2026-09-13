import { getDirectModelMeta, enrichDirectModel } from './directProviderCatalog.js'
import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export type MoonshotCatalogModel = Partial<ModelInfo> & {
  id?: string
  name?: string
  context_length?: number
  context_window?: number
  max_context_length?: number
  supports_reasoning?: boolean
  supports_tool_calling?: boolean
  tags?: readonly string[]
  capabilities?: {
    function_calling?: boolean
  }
}

export function filterMoonshotModelCatalog(
  models: readonly MoonshotCatalogModel[],
): ModelInfo[] {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const model of models) {
    if (typeof model.id !== 'string') continue
    const id = model.id.trim()
    const key = id.toLowerCase()
    if (!isMoonshotChatModelId(id) || seen.has(key)) continue
    seen.add(key)
    out.push(enrichDirectModel('moonshot', toMoonshotModelInfo({ ...model, id })))
  }
  return out
}

export function toMoonshotModelInfo(
  model: MoonshotCatalogModel & { id: string },
): ModelInfo {
  const id = model.id.trim()
  const contextWindow =
    numberOrUndefined(model.contextWindow)
    ?? numberOrUndefined(model.context_length)
    ?? numberOrUndefined(model.context_window)
    ?? numberOrUndefined(model.max_context_length)
  const tags = normalizeMoonshotTags(model, id)

  return {
    id,
    name: model.name && model.name.trim() ? model.name.trim() : humanizeMoonshotModelId(id),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    supportsToolCalling: true,
    ...(model.provider ? { provider: model.provider } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  }
}

export function isMoonshotChatModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase()
  return normalized.startsWith('kimi-') || normalized.startsWith('moonshot-')
}

export function normalizeMoonshotModelId(model: string): string {
  const trimmed = model.trim()
  const lower = trimmed.toLowerCase()
  return isMoonshotChatModelId(lower) ? lower : model
}

export function isMoonshotThinkingModel(model: string): boolean {
  const normalized = normalizeMoonshotModelId(model)
  return getDirectModelMeta('moonshot', normalized)?.reasoning ?? looksLikeMoonshotThinkingModel(normalized)
}

function looksLikeMoonshotThinkingModel(id: string): boolean {
  const normalized = id.trim().toLowerCase()
  return normalized.includes('kimi-k2-thinking')
    || normalized === 'kimi-k2.5'
    || normalized === 'kimi-k2.6'
}

function normalizeMoonshotTags(
  model: MoonshotCatalogModel,
  id: string,
): string[] {
  const tags = new Set<string>()
  for (const tag of model.tags ?? []) {
    if (typeof tag === 'string' && tag.trim()) tags.add(tag.trim())
  }
  if (model.supports_reasoning === true || looksLikeMoonshotThinkingModel(id)) {
    tags.add('reasoning')
  }
  if (id.toLowerCase().includes('turbo') || id.toLowerCase().includes('highspeed')) {
    tags.add('fast')
  }
  return Array.from(tags)
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function humanizeMoonshotModelId(id: string): string {
  return id
    .replace(/^models\//i, '')
    .split(/[-_]+/g)
    .filter(Boolean)
    .map(part => {
      if (part.toLowerCase() === 'kimi') return 'Kimi'
      if (/^k\d/.test(part.toLowerCase())) return part.toUpperCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}
