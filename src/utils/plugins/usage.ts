import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { getSettingsForSource } from '../settings/settings.js'

const lastWrite = new Map<string, number>()

/** Local activity only; discovery and cost inspection never count as use. */
export function recordPluginUse(pluginId: string | undefined): void {
  if (!pluginId) return
  const now = Date.now()
  if (now - (lastWrite.get(pluginId) ?? 0) < 60_000) return
  lastWrite.set(pluginId, now)
  saveGlobalConfig(current => ({
    ...current,
    pluginLastUsed: { ...current.pluginLastUsed, [pluginId]: now },
  }))
}

export function getPluginLastUsed(pluginId: string): string | undefined {
  if (
    getSettingsForSource('policySettings')?.strictKnownMarketplaces !==
    undefined
  )
    return undefined
  const timestamp = getGlobalConfig().pluginLastUsed?.[pluginId]
  const date = new Date(typeof timestamp === 'number' ? timestamp : NaN)
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : 'No recorded use'
}
