/**
 * The once-per-session re-run of command-sourced plugins: shortly after an
 * interactive session starts, each enabled one runs its accepted command
 * again in the background, so the tool's changed output reaches the user
 * without a reinstall.
 *
 * Changed output is installed as a new version on disk. The running session
 * keeps what it loaded, so its prompt cache is untouched; the user is told
 * to /reload-plugins. A command that changed in the catalog is not run, and
 * the user gets an Errors entry naming the update command that reviews it.
 */
import type { PluginError } from '../../types/plugin.js'
import { updatePluginOp } from '../../services/plugins/pluginOperations.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  getDeclaredCommand,
  getDeclaredCommandPolicyBlock,
  hasStoredConsent,
} from './commandConsent.js'
import { isCommandSource } from './commandSource.js'
import {
  isInstallationRelevantToCurrentProject,
  loadInstalledPluginsFromDisk,
} from './installedPluginsManager.js'
import { getMarketplaceCacheOnly } from './marketplaceManager.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'

let ranThisSession = false

export async function rerunCommandSourcePlugins(): Promise<{
  updated: string[]
  errors: PluginError[]
}> {
  const updated: string[] = []
  const errors: PluginError[] = []
  if (ranThisSession) return { updated, errors }
  ranThisSession = true
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) {
    return { updated, errors }
  }
  if (getDeclaredCommandPolicyBlock()) return { updated, errors }

  const enabled = getInitialSettings().enabledPlugins ?? {}
  const installed = loadInstalledPluginsFromDisk()
  // One catalog read per marketplace, however many plugins it has.
  const catalogs = new Map<string, Awaited<ReturnType<typeof getMarketplaceCacheOnly>>>()
  for (const [pluginId, installations] of Object.entries(installed.plugins)) {
    if (!enabled[pluginId]) continue
    const { name: plugin, marketplace } = parsePluginIdentifier(pluginId)
    if (!plugin || !marketplace) continue
    if (!catalogs.has(marketplace)) {
      catalogs.set(marketplace, await getMarketplaceCacheOnly(marketplace))
    }
    const entry = catalogs.get(marketplace)?.plugins.find(p => p.name === plugin)
    if (!entry || !isCommandSource(entry.source)) continue

    const declared = getDeclaredCommand(pluginId, entry)
    if (!declared || !hasStoredConsent(declared)) {
      errors.push({
        type: 'generic-error',
        source: pluginId,
        plugin,
        error: `The command for "${pluginId}" changed in its marketplace and was not run. Review it with: tau plugin update ${pluginId}`,
      })
      continue
    }

    for (const { scope } of installations.filter(
      isInstallationRelevantToCurrentProject,
    )) {
      try {
        const result = await updatePluginOp(pluginId, scope, {
          commandRun: 'later',
        })
        if (result.success && !result.alreadyUpToDate) {
          updated.push(pluginId)
        } else if (!result.success) {
          errors.push({
            type: 'generic-error',
            source: pluginId,
            plugin,
            error: result.message,
          })
        }
      } catch (error) {
        logForDebugging(
          `Command source re-run for ${pluginId} failed: ${errorMessage(error)}`,
          { level: 'warn' },
        )
        errors.push({
          type: 'generic-error',
          source: pluginId,
          plugin,
          error: errorMessage(error),
        })
      }
    }
  }
  return { updated: [...new Set(updated)], errors }
}
