import { stripUnsupportedHooks } from '../../schemas/hooks.js'

export type PluginHookIssue = { path: string; message: string }

/** Apply the same forward-compatibility rules to inline manifest hooks. */
export function preparePluginManifestHooks(
  value: unknown,
  onUnsupported: (issue: PluginHookIssue) => void,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const raw = value as Record<string, unknown>
  if (!('hooks' in raw)) return raw
  const filter = (hooks: unknown, prefix: string) =>
    typeof hooks === 'string'
      ? hooks
      : stripUnsupportedHooks(hooks, (path, message) =>
          onUnsupported({ path: `${prefix}.${path}`, message }),
        )
  return {
    ...raw,
    hooks: Array.isArray(raw.hooks)
      ? raw.hooks.map((hooks, index) => filter(hooks, `hooks[${index}]`))
      : filter(raw.hooks, 'hooks'),
  }
}

/**
 * Keep independent declarative hooks usable when a plugin also declares a newer
 * extension. Never import modules while discovering or validating plugins.
 */
export function preparePluginHookFile(
  value: unknown,
  onUnsupported: (issue: PluginHookIssue) => void,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const raw = value as Record<string, unknown>
  if ('modules' in raw) {
    onUnsupported({
      path: 'modules',
      message:
        'This plugin uses hook modules (hooks.json "modules"), which this version of Tau does not support. ' +
        'Its JavaScript/TypeScript mod hooks will not run. Declarative hooks in the same file are still loaded. ' +
        'Use a plugin version with declarative hooks or a host that supports the Claude Code mod runtime.',
    })
  }
  return {
    ...raw,
    hooks: stripUnsupportedHooks(
      // Module-only files have no classic hooks. Missing or malformed hooks in
      // other files must still produce the normal validation error.
      raw.hooks === undefined && 'modules' in raw ? {} : raw.hooks,
      (path, message) => onUnsupported({ path: `hooks.${path}`, message }),
    ),
  }
}
