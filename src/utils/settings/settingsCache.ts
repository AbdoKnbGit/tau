import { normalize } from 'path'
import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

let sessionSettingsCache: SettingsWithErrors | null = null

export function getSessionSettingsCache(): SettingsWithErrors | null {
  return sessionSettingsCache
}

export function setSessionSettingsCache(value: SettingsWithErrors): void {
  sessionSettingsCache = value
}

/**
 * Per-source cache for getSettingsForSource. Invalidated alongside the
 * merged sessionSettingsCache — same resetSettingsCache() triggers
 * (settings write, --add-dir, plugin init, hooks refresh).
 */
const perSourceCache = new Map<SettingSource, SettingsJson | null>()

export function getCachedSettingsForSource(
  source: SettingSource,
): SettingsJson | null | undefined {
  // undefined = cache miss; null = cached "no settings for this source"
  return perSourceCache.has(source) ? perSourceCache.get(source) : undefined
}

export function setCachedSettingsForSource(
  source: SettingSource,
  value: SettingsJson | null,
): void {
  perSourceCache.set(source, value)
}

/**
 * Path-keyed cache for parseSettingsFile. Both getSettingsForSource and
 * loadSettingsFromDisk call parseSettingsFile on the same paths during
 * startup — this dedupes the disk read + zod parse.
 */
type ParsedSettings = {
  settings: SettingsJson | null
  errors: ValidationError[]
}
const parseFileCache = new Map<string, ParsedSettings>()
// Accepted snapshots outlive ordinary cache invalidation. ConfigChange may
// refuse disk bytes while another source, plugin reload, or /add-dir resets
// the caches; that must not accidentally activate the refused settings.
const acceptedFiles = new Map<string, ParsedSettings>()
const retainedFiles = new Map<string, ParsedSettings>()

export function getCachedParsedFile(path: string): ParsedSettings | undefined {
  const key = normalize(path)
  return retainedFiles.get(key) ?? parseFileCache.get(key)
}

export function setCachedParsedFile(path: string, value: ParsedSettings): void {
  const key = normalize(path)
  parseFileCache.set(key, value)
  acceptedFiles.set(key, value)
}

export function retainSettingsFile(path: string): void {
  const key = normalize(path)
  if (!retainedFiles.has(key)) {
    retainedFiles.set(key, acceptedFiles.get(key) ?? { settings: null, errors: [] })
  }
}

export function releaseSettingsFile(path: string): void {
  const key = normalize(path)
  retainedFiles.delete(key)
  parseFileCache.delete(key)
}

export function getRetainedSettingsFile(path: string): ParsedSettings | undefined {
  return retainedFiles.get(normalize(path))
}

export function updateRetainedSettingsFile(path: string, value: ParsedSettings): void {
  const key = normalize(path)
  retainedFiles.set(key, value)
  acceptedFiles.set(key, value)
}

export function clearRetainedSettingsFiles(): void {
  retainedFiles.clear()
  acceptedFiles.clear()
}

export function resetSettingsCache(): void {
  sessionSettingsCache = null
  perSourceCache.clear()
  parseFileCache.clear()
}

/**
 * Plugin settings base layer for the settings cascade.
 * pluginLoader writes here after loading plugins;
 * loadSettingsFromDisk reads it as the lowest-priority base.
 */
let pluginSettingsBase: Record<string, unknown> | undefined

export function getPluginSettingsBase(): Record<string, unknown> | undefined {
  return pluginSettingsBase
}

export function setPluginSettingsBase(
  settings: Record<string, unknown> | undefined,
): void {
  pluginSettingsBase = settings
}

export function clearPluginSettingsBase(): void {
  pluginSettingsBase = undefined
}
