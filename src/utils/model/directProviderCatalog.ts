/** First-party metadata for the four direct OpenAI-compatible model browsers.
 * Live /models controls availability; models.dev fills in thin ID-only rows.
 * The bundled snapshot is only an offline fallback (see direct-provider-models.md).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { recordModelVision } from '../../lanes/shared/vision_capability.js'
import seed from './directProviderSeed.json'

export type DirectProvider = 'deepseek' | 'glm' | 'moonshot' | 'minimax'
export type DirectThinkingProvider = Exclude<DirectProvider, 'deepseek'>
export interface DirectModelMeta {
  name: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
  toggle: boolean
  efforts: string[]
  released: string
  vision: boolean
  tools: boolean
}
type Catalog = Record<string, Record<string, DirectModelMeta>>
const TTL = 24 * 60 * 60 * 1000
const SURFACES = ['deepseek', 'zhipuai', 'zai', 'zhipuai-coding-plan', 'zai-coding-plan', 'moonshotai', 'moonshotai-cn', 'minimax', 'minimax-cn', 'minimax-coding-plan', 'minimax-cn-coding-plan']
let catalog: Catalog = seed
let loadedPath = ''
let fetchedAt = 0
let retryAt = 0
let pending: Promise<void> | undefined
const activeSurfaces = new Map<DirectProvider, string>()

export function isDirectProvider(provider: string): provider is DirectProvider {
  return ['deepseek', 'glm', 'moonshot', 'minimax'].includes(provider)
}
export function isDirectThinkingProvider(provider: string): provider is DirectThinkingProvider {
  return ['glm', 'moonshot', 'minimax'].includes(provider)
}

export function directCatalogSurface(provider: DirectProvider, baseUrl?: string): string {
  const url = (baseUrl ?? (provider === 'glm' ? process.env.GLM_BASE_URL : provider === 'moonshot' ? process.env.MOONSHOT_BASE_URL : provider === 'minimax' ? process.env.MINIMAX_BASE_URL : '') ?? '').toLowerCase()
  if (provider === 'glm') return `${url.includes('api.z.ai') ? 'zai' : 'zhipuai'}${url.includes('/coding/') ? '-coding-plan' : ''}`
  if (provider === 'moonshot') return /moonshot\.cn|moonshotai\.cn/.test(url) ? 'moonshotai-cn' : 'moonshotai'
  if (provider === 'minimax') return `minimax${url.includes('minimaxi.com') ? '-cn' : ''}${url.includes('/coding/') ? '-coding-plan' : ''}`
  return 'deepseek'
}

function cachePath(): string {
  return process.env.TAU_DIRECT_MODEL_CATALOG_STORE || join(homedir(), '.config', 'claude-code', 'direct-models.json')
}
function load(): void {
  const path = cachePath()
  if (loadedPath === path) return
  loadedPath = path
  catalog = seed
  fetchedAt = 0
  retryAt = 0
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    if (saved.version === 1 && Number.isFinite(saved.fetchedAt) && saved.catalog) {
      const valid = validateCatalog(saved.catalog)
      if (Object.keys(valid).length) {
        catalog = { ...seed, ...valid }
        fetchedAt = saved.fetchedAt
      }
    }
  } catch { /* Offline first use or corrupt cache: use the bundled snapshot. */ }
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
function validateCatalog(value: unknown): Catalog {
  const out: Catalog = {}
  if (!value || typeof value !== 'object') return out
  for (const surface of SURFACES) {
    const rows = (value as Catalog)[surface]
    if (!rows || typeof rows !== 'object') continue
    for (const [id, row] of Object.entries(rows)) {
      if (!row || typeof row.name !== 'string' || !positive(row.contextWindow) || !positive(row.maxOutputTokens)
        || typeof row.reasoning !== 'boolean' || typeof row.toggle !== 'boolean'
        || !Array.isArray(row.efforts) || !row.efforts.every(e => typeof e === 'string')
        || typeof row.released !== 'string') continue
      ;(out[surface] ??= {})[id.toLowerCase()] = row
    }
  }
  return out
}

export function deriveDirectCatalog(payload: unknown): Catalog {
  const out: Catalog = {}
  if (!payload || typeof payload !== 'object') return out
  for (const surface of SURFACES) {
    const rows = (payload as Record<string, { models?: Record<string, Record<string, unknown>> }>)[surface]?.models
    if (!rows) continue
    for (const [id, row] of Object.entries(rows)) {
      if (!row || typeof row !== 'object') continue
      const limit = row.limit as { context?: number; output?: number } | undefined
      const modalities = row.modalities as { input?: string[]; output?: string[] } | undefined
      if (!positive(limit?.context) || !positive(limit?.output) || row.status === 'deprecated'
        || !modalities?.output?.includes('text')) continue
      const options = Array.isArray(row.reasoning_options) ? row.reasoning_options : []
      const efforts = options.flatMap(option => option?.type === 'effort' && Array.isArray(option.values)
        ? option.values.filter((v: unknown): v is string => typeof v === 'string') : [])
      ;(out[surface] ??= {})[id.toLowerCase()] = {
        name: typeof row.name === 'string' ? row.name : id,
        contextWindow: limit.context, maxOutputTokens: limit.output,
        reasoning: row.reasoning === true, toggle: options.some(o => o?.type === 'toggle'),
        efforts: [...new Set<string>(efforts)], released: typeof row.release_date === 'string' ? row.release_date : '',
        vision: modalities.input?.includes('image') === true, tools: row.tool_call === true,
      }
    }
  }
  return out
}

export async function warmDirectProviderCatalog(): Promise<void> {
  load()
  if (process.env.TAU_DISABLE_DIRECT_MODEL_CATALOG === '1' || isEssentialTrafficOnly()
    || Date.now() - fetchedAt < TTL || Date.now() < retryAt) return
  if (pending) return pending
  pending = (async () => {
    try {
      const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(8_000) })
      if (!response.ok) throw new Error('Model metadata unavailable')
      const fresh = deriveDirectCatalog(await response.json())
      if (!Object.keys(fresh).length) throw new Error('Empty model metadata')
      catalog = { ...catalog, ...fresh }
      fetchedAt = Date.now()
      const path = cachePath()
      try {
        mkdirSync(dirname(path), { recursive: true })
        const temp = `${path}.${process.pid}.tmp`
        writeFileSync(temp, JSON.stringify({ version: 1, fetchedAt, catalog }))
        renameSync(temp, path)
      } catch { /* Persistence is best effort. */ }
    } catch { retryAt = Date.now() + 60_000 }
  })().finally(() => { pending = undefined })
  return pending
}

function rowsFor(provider: DirectProvider): Record<string, DirectModelMeta> {
  load()
  const surface = activeSurfaces.get(provider) ?? directCatalogSurface(provider)
  return catalog[surface] ?? catalog[surface.replace(/-coding-plan$/, '').replace(/-cn$/, '')] ?? {}
}

export function getDirectModelMeta(provider: DirectProvider, model: string): DirectModelMeta | undefined {
  const id = model.trim().toLowerCase()
  const row = rowsFor(provider)[id]
  if (!row) return undefined
  // Official Chat Completions docs supersede stale models.dev transport metadata.
  // K3 always reasons and uses top-level reasoning_effort (2026-09-13).
  if (provider === 'moonshot' && id === 'kimi-k3') return { ...row, toggle: false, efforts: ['low', 'high', 'max'] }
  // MiniMax's hosted OpenAI endpoint advertises 1,000,000, not the weights' 1,048,576.
  if (provider === 'minimax' && id === 'minimax-m3') return { ...row, contextWindow: 1_000_000 }
  if (provider === 'deepseek' && ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(id)) {
    return { ...row, name: 'DeepSeek V4.1 Flash (legacy alias)' }
  }
  return row
}

export function enrichDirectModel(provider: DirectProvider, model: ModelInfo): ModelInfo {
  const meta = getDirectModelMeta(provider, model.id)
  return {
    ...model,
    name: meta?.name ?? model.name ?? model.id,
    contextWindow: positive(model.contextWindow) ? model.contextWindow : meta?.contextWindow,
    supportsToolCalling: model.supportsToolCalling ?? meta?.tools,
    tags: [...new Set([...(model.tags ?? []), ...(meta?.reasoning ? ['reasoning'] : [])])],
  }
}

export function directProviderModels(provider: DirectProvider): ModelInfo[] {
  return Object.keys(rowsFor(provider)).map(id => enrichDirectModel(provider, {
    id: provider === 'minimax' ? id.replace(/^minimax-m/, 'MiniMax-M') : id, name: id,
  })).filter(model => provider !== 'deepseek' || !['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model.id))
    .sort((a, b) => (getDirectModelMeta(provider, b.id)?.released ?? '').localeCompare(getDirectModelMeta(provider, a.id)?.released ?? '') || a.id.localeCompare(b.id))
}

export async function listDirectProviderModels(provider: DirectProvider, baseUrl: string, headers: Record<string, string>): Promise<ModelInfo[]> {
  activeSurfaces.set(provider, directCatalogSurface(provider, baseUrl))
  const metadata = warmDirectProviderCatalog()
  let live: ModelInfo[] = []
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout(8_000) })
    if (response.ok) {
      const payload = await response.json() as { data?: Array<Record<string, unknown>> }
      live = (payload.data ?? []).flatMap(row => {
        if (typeof row.id !== 'string') return []
        const id = row.id.trim()
        if (/(?:speech|audio|tts|voice|music|embedding|rerank|image|video)/i.test(id) || row.status === 'deprecated') return []
        if (!(provider === 'deepseek' ? /^deepseek-/i : provider === 'glm' ? /^glm-/i : provider === 'moonshot' ? /^(kimi|moonshot)-/i : /^minimax-m/i).test(id)) return []
        const context = [row.contextWindow, row.context_length, row.context_window, row.max_context_length].find(positive)
        const capabilities = row.capabilities as { vision?: boolean } | undefined
        const vision = typeof row.supports_vision === 'boolean' ? row.supports_vision : capabilities?.vision
        if (typeof vision === 'boolean') recordModelVision(provider, id, vision)
        return [{ id, name: typeof row.name === 'string' ? row.name : id, contextWindow: context,
          ...(typeof row.supports_tool_calling === 'boolean' ? { supportsToolCalling: row.supports_tool_calling } : {}),
        }]
      })
    }
  } catch { /* Provider without /models: use the current metadata catalog. */ }
  await metadata
  if (!live.length) return directProviderModels(provider)
  const seen = new Set<string>()
  return live.filter(m => {
    const key = m.id.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(m => enrichDirectModel(provider, m))
    .sort((a, b) => (getDirectModelMeta(provider, b.id)?.released ?? '').localeCompare(getDirectModelMeta(provider, a.id)?.released ?? '') || a.id.localeCompare(b.id))
}
