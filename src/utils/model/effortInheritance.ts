import { convertEffortValueToLevel, getEffortEnvOverride, type EffortValue } from '../effortValue.js'
import { getSessionSettingsCache } from '../settings/settingsCache.js'

/** undefined inherits settings; null clears that fallback. An environment override still applies. */
export type EffortFallback = EffortValue | null

/** Read at use time so initialization and unrelated model choices cannot capture stale settings. */
export function getInheritedEffort(fallback?: EffortFallback): string | undefined {
  const env = getEffortEnvOverride()
  if (env === null) return undefined
  const value = env ?? (fallback === null
    ? undefined
    : fallback ?? getSessionSettingsCache()?.settings.effortLevel)
  if (value === undefined) return undefined
  const level = convertEffortValueToLevel(value)
  return level === 'ultracode' ? 'max' : level
}

/** Inherit only a level this particular provider/model accepts. */
export function selectInheritedEffort<T extends string>(
  levels: readonly T[],
  fallback?: EffortFallback,
): T | undefined {
  const effort = getInheritedEffort(fallback)
  return effort !== undefined && (levels as readonly string[]).includes(effort)
    ? effort as T
    : undefined
}
