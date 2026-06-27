import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type CloudflareEffort = 'default' | 'low' | 'medium' | 'high' | 'max'
export type CloudflareWireEffort = Exclude<CloudflareEffort, 'default'>

export const CLOUDFLARE_OPENAI_EFFORT_LEVELS: readonly CloudflareEffort[] = [
  'default',
  'low',
  'medium',
  'high',
]

export const CLOUDFLARE_GLM52_EFFORT_LEVELS: readonly CloudflareEffort[] = [
  'default',
  'high',
  'max',
]

const CLOUDFLARE_ALL_EFFORT_LEVELS: readonly CloudflareEffort[] = [
  'default',
  'low',
  'medium',
  'high',
  'max',
]

function normalizeModel(model: string): string {
  return model.trim().toLowerCase().replace(/[._]/g, '-')
}

function storeKey(model: string): string {
  return model.trim().toLowerCase()
}

function storePath(): string {
  return process.env.TAU_CLOUDFLARE_THINKING_STORE
    || join(homedir(), '.claude', 'cloudflare-thinking.json')
}

let _loadedPath: string | null = null
let _cache: Record<string, CloudflareEffort> = {}

function load(): void {
  const path = storePath()
  if (_loadedPath === path) return
  _loadedPath = path
  _cache = {}

  try {
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return

    const next: Record<string, CloudflareEffort> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'string'
        && (CLOUDFLARE_ALL_EFFORT_LEVELS as readonly string[]).includes(value)
      ) {
        next[key.toLowerCase()] = value as CloudflareEffort
      }
    }
    _cache = next
  } catch {
    // Stale/corrupt state should not break the picker.
  }
}

function save(): void {
  const path = storePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(_cache, null, 2), 'utf8')
  } catch {
    // Persistence is best-effort; the in-memory value still works this run.
  }
}

export function isCloudflareGlm52EffortModel(model: string): boolean {
  const m = normalizeModel(model)
  return m === '@cf/zai-org/glm-5-2' || m.endsWith('/glm-5-2')
}

export function isCloudflareGptOssEffortModel(model: string): boolean {
  const m = normalizeModel(model)
  return m === '@cf/openai/gpt-oss-120b'
    || m === '@cf/openai/gpt-oss-20b'
    || m.endsWith('/gpt-oss-120b')
    || m.endsWith('/gpt-oss-20b')
}

export function cloudflareEffortLevelsForModel(
  model: string,
  _tags?: readonly string[],
): readonly CloudflareEffort[] {
  if (isCloudflareGlm52EffortModel(model)) return CLOUDFLARE_GLM52_EFFORT_LEVELS
  if (isCloudflareGptOssEffortModel(model)) return CLOUDFLARE_OPENAI_EFFORT_LEVELS
  return ['default']
}

export function supportsCloudflareThinkingSelection(
  model: string,
  tags?: readonly string[],
): boolean {
  return cloudflareEffortLevelsForModel(model, tags).length > 1
}

export function getCloudflareEffort(model: string): CloudflareEffort {
  load()
  const levels = cloudflareEffortLevelsForModel(model)
  const stored = _cache[storeKey(model)]
  return stored && levels.includes(stored) ? stored : 'default'
}

export function setCloudflareEffort(model: string, effort: CloudflareEffort): void {
  load()
  const key = storeKey(model)
  const levels = cloudflareEffortLevelsForModel(model)
  const next = levels.includes(effort) ? effort : 'default'
  if (next === 'default') {
    delete _cache[key]
  } else {
    _cache[key] = next
  }
  save()
}

export function cycleCloudflareEffort(
  model: string,
  direction: 'left' | 'right',
): CloudflareEffort {
  const levels = cloudflareEffortLevelsForModel(model)
  if (levels.length <= 1) return 'default'
  const current = getCloudflareEffort(model)
  const idx = Math.max(0, levels.indexOf(current))
  const len = levels.length
  const next =
    direction === 'right'
      ? levels[(idx + 1) % len]!
      : levels[(idx - 1 + len) % len]!
  setCloudflareEffort(model, next)
  return next
}

export function getCloudflareEffortLabel(effort: CloudflareEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function getCloudflareRequestEffort(
  model: string,
): CloudflareWireEffort | null {
  const effort = getCloudflareEffort(model)
  return effort === 'default' ? null : effort
}

export function cloudflareReasoningContentReplayRequired(model: string): boolean {
  return isCloudflareGlm52EffortModel(model)
}

export function _resetCloudflareThinkingForTests(
  cache: Record<string, CloudflareEffort> = {},
): void {
  _loadedPath = storePath()
  _cache = { ...cache }
}
