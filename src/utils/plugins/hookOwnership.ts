import type { LoadedPlugin, PluginError } from '../../types/plugin.js'

/** Select by manifest namespace, retaining both plugins and their other components. */
export function assignPluginHookOwners(
  plugins: LoadedPlugin[],
  managed: Record<string, unknown> = {},
): PluginError[] {
  const owners = new Map<string, LoadedPlugin>()
  const errors: PluginError[] = []
  for (const plugin of plugins) {
    delete plugin.hooksSuppressedBy
    if (!plugin.enabled || !plugin.hooksConfig) continue
    const owner = owners.get(plugin.name)
    if (
      !owner ||
      (managed[plugin.source] === true && managed[owner.source] !== true)
    ) {
      owners.set(plugin.name, plugin)
    }
  }
  for (const plugin of plugins) {
    const owner = owners.get(plugin.name)
    if (!plugin.enabled || !plugin.hooksConfig || !owner || owner === plugin)
      continue
    plugin.hooksSuppressedBy = owner.source
    errors.push({
      type: 'generic-error',
      source: plugin.source,
      plugin: plugin.name,
      error: `Its hooks.json hooks do not run because ${owner.source} owns the plugin name "${plugin.name}". Disable that copy and run /reload-plugins to change the owner.`,
    })
  }
  return errors
}
