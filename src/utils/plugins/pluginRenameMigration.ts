/**
 * Moving a user's plugin state to the plugin's new name when its marketplace
 * renames it (a `renames` entry that resolves to a listed plugin), or dropping
 * the old name when the marketplace marks the plugin removed (`null`).
 *
 * What moves from the old ID to the new one:
 * - enabledPlugins and pluginConfigs keys in user, project and local settings
 *   (managed and --settings files can't be rewritten; their notice recurs)
 * - installed_plugins.json records, every scope
 * - sensitive options in secure storage
 * - the persistent data directory (${CLAUDE_PLUGIN_DATA})
 * Something already stored under the new ID is never overwritten.
 *
 * A removal drops the settings keys and install records but keeps the data
 * directory and secrets, so a catalog edit can't destroy what a user saved.
 *
 * Each step is idempotent and best-effort: a failure is logged, the next load
 * retries, and the plugin loads under its new name in the meantime.
 */
import { mkdir, rename } from 'fs/promises'
import { dirname } from 'path'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { pathExists } from '../file.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { markPluginVersionOrphaned } from './cacheUtils.js'
import { renamePluginInstallations } from './installedPluginsManager.js'
import { pluginDataDirPath } from './pluginDirectories.js'
import { renamePluginSecrets } from './pluginOptionsStorage.js'

export type PluginRenameMigration = {
  /** The plugin ID users have stored, `old-name@marketplace`. */
  from: string
  /** The plugin ID to move to, or null when the marketplace removed it. */
  to: string | null
}

const EDITABLE_SETTINGS = [
  'userSettings',
  'projectSettings',
  'localSettings',
] as const

// One attempt per migration per process; a failed attempt is retried on the
// next load.
const applied = new Set<string>()

export async function applyPluginRenameMigrations(
  migrations: readonly PluginRenameMigration[],
): Promise<void> {
  for (const migration of migrations) {
    const key = `${migration.from}\n${migration.to ?? ''}`
    if (applied.has(key)) continue
    applied.add(key)
    try {
      await applyMigration(migration)
    } catch (error) {
      applied.delete(key)
      logForDebugging(
        `Plugin rename ${migration.from} -> ${migration.to ?? '(removed)'} failed: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }
}

async function applyMigration({ from, to }: PluginRenameMigration): Promise<void> {
  moveSettingsKeys(from, to)
  const orphaned = renamePluginInstallations(from, to)
  if (to) {
    renamePluginSecrets(from, to)
    await moveDataDirectory(from, to)
  } else {
    for (const path of orphaned) await markPluginVersionOrphaned(path)
  }
  logForDebugging(
    to ? `Migrated plugin ${from} to ${to}` : `Dropped removed plugin ${from}`,
  )
}

type EnabledPlugins = NonNullable<SettingsJson['enabledPlugins']>
type PluginConfigs = NonNullable<SettingsJson['pluginConfigs']>

function moveSettingsKeys(from: string, to: string | null): void {
  for (const source of EDITABLE_SETTINGS) {
    const settings = getSettingsForSource(source)
    if (!settings) continue
    const patch: Partial<SettingsJson> = {}

    // The old key always goes, or the rename would recur on every load. The
    // new key keeps its own value when the user already set one.
    const enabled = settings.enabledPlugins
    if (enabled && Object.hasOwn(enabled, from)) {
      const next: Record<string, unknown> = { [from]: undefined }
      if (to && !Object.hasOwn(enabled, to)) next[to] = enabled[from]
      patch.enabledPlugins = next as EnabledPlugins
    }

    // Options move only when the new ID has none; otherwise both are kept.
    const configs = settings.pluginConfigs
    if (configs && Object.hasOwn(configs, from)) {
      if (!to) {
        patch.pluginConfigs = { [from]: undefined } as unknown as PluginConfigs
      } else if (!Object.hasOwn(configs, to)) {
        patch.pluginConfigs = {
          [from]: undefined,
          [to]: configs[from],
        } as unknown as PluginConfigs
      }
    }

    if (Object.keys(patch).length === 0) continue
    const { error } = updateSettingsForSource(source, patch)
    if (error) {
      logForDebugging(
        `Plugin rename ${from}: could not update ${source}: ${error.message}`,
        { level: 'warn' },
      )
    }
  }
}

async function moveDataDirectory(from: string, to: string): Promise<void> {
  const source = pluginDataDirPath(from)
  const target = pluginDataDirPath(to)
  if (source === target) return
  if (!(await pathExists(source)) || (await pathExists(target))) return
  await mkdir(dirname(target), { recursive: true })
  await rename(source, target)
}
