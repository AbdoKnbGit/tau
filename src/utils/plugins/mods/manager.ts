import {
  getIsInteractive,
  getOriginalCwd,
  getSessionId,
} from '../../../bootstrap/state.js'
import type { Command, LocalJSXCommandContext } from '../../../types/command.js'
import type { LoadedPlugin, PluginLoadResult } from '../../../types/plugin.js'
import { checkHasTrustDialogAccepted } from '../../config.js'
import { isBareMode, isEnvTruthy } from '../../envUtils.js'
import { logForDebugging } from '../../debug.js'
import {
  getSettingsForSource,
  getSettings_DEPRECATED,
} from '../../settings/settings.js'
import { isFullscreenActive } from '../../fullscreen.js'
import { qualifyDependency } from '../dependencyResolver.js'
import { createModHost, type ModCommandSpec } from './host.js'
import { MOD_API_EVENTS } from './contracts.js'
import {
  createModToolRegistry,
  publishModToolRegistries,
  type ModToolRegistry,
} from './tools.js'
export { getModTools, getModToolRevision, subscribeModTools } from './tools.js'
import {
  ModRuntime,
  type ModRecord,
  type ModHost,
  type ModContinuation,
} from './runtime.js'
import {
  getModToolContext,
  readModToolSnapshot,
  withModToolContext,
} from './toolContext.js'

export type ModDispatchOptions = {
  origin?: { plugin: string; tier: string }
  skip?: { runtime: ModRuntime; hook: number }
  validateResult?: (result: ModRecord) => void
}

type ActiveMod = {
  plugin: LoadedPlugin
  runtime: ModRuntime
  commands: Map<string, ModCommandSpec>
  tools: ModToolRegistry
  host: ModHost
}
let active: ActiveMod[] = []
let started = false
let loading: Promise<void> | undefined
const warnings: string[] = [],
  logs: string[] = []
const warn = (text: string) => {
  warnings.push(text)
  logForDebugging(text, { level: 'warn' })
}

function allowed(plugin: LoadedPlugin): boolean {
  if (
    !plugin.enabled ||
    plugin.hooksSuppressedBy ||
    !plugin.modEntries?.length ||
    isBareMode() ||
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
  )
    return false
  if (getIsInteractive() && !checkHasTrustDialogAccepted()) return false
  const policy = getSettingsForSource('policySettings')
  if (policy?.disableAllHooks) return false
  const managed = policy?.enabledPlugins?.[plugin.source] === true
  if (
    !managed &&
    (policy?.allowManagedModsOnly ||
      policy?.allowManagedHooksOnly ||
      getSettings_DEPRECATED().disableAllHooks)
  )
    return false
  return true
}

export function hasModEvent(event: string): boolean {
  return active.some(
    (mod) =>
      allowed(mod.plugin) &&
      mod.runtime.hooks.some((hook) => hook.event === event),
  )
}
export function takeModLogs(): string[] {
  return logs.splice(0)
}
export function getModWarnings(): string[] {
  return [...warnings]
}
export function activeModCount(): number {
  return active.filter((mod) => allowed(mod.plugin)).length
}

export async function dispatchModEvent(
  event: string,
  input: ModRecord,
  core: ModContinuation,
  signal?: AbortSignal,
  options?: ModDispatchOptions,
): Promise<unknown> {
  return dispatchModSnapshot(active, event, input, core, signal, options)
}

function dispatchModSnapshot(
  snapshot: readonly ActiveMod[],
  event: string,
  input: ModRecord,
  core: ModContinuation,
  signal?: AbortSignal,
  options: ModDispatchOptions = {},
): Promise<unknown> {
  const mods = snapshot.filter((mod) => allowed(mod.plugin))
  const bound = getModToolContext()
  const run = (index: number, current: ModRecord): Promise<unknown> => {
    const mod = mods[index]
    if (!mod) return withModToolContext(bound, () => core(current))
    return mod.runtime.dispatch(
      event,
      current,
      (next) => run(index + 1, next),
      (method, args, signal, frame) =>
        withModToolContext(
          bound
            ? {
                ...bound,
                frame: frame
                  ? { ...frame, plugin: mod.plugin.name }
                  : bound.frame,
              }
            : undefined,
          async () => {
            if (MOD_API_EVENTS.has(method)) {
              const { mcpApiInput, runModMcpAPI } = await import('./mcpApi.js')
              const result = await dispatchModSnapshot(
                snapshot.slice(0, snapshot.indexOf(mod)),
                method,
                mcpApiInput(method, args),
                async input => ({ value: await runModMcpAPI(method, input, signal, mod.plugin) }),
                signal,
                { origin: { plugin: mod.plugin.name, tier: 'user' } },
              ) as ModRecord
              if (result.deny !== undefined) throw new Error(`${method} refused: ${result.deny}`)
              return result.value
            }
            if (method === 'tool.call' || method === 'tool.check') {
              const { runModToolAPI } = await import('./toolApi.js')
              return runModToolAPI(method, args[0], signal, mod.plugin.name)
            }
            return mod.host(method, args, signal, frame)
          },
        ),
      {
        signal,
        warn,
        origin: options.origin,
        skipHook:
          options.skip?.runtime === mod.runtime ? options.skip.hook : undefined,
        validateResult: options.validateResult,
      },
    )
  }
  return run(0, input)
}

export function getModCommands(): Command[] {
  return active
    .filter((mod) => allowed(mod.plugin))
    .flatMap((mod) =>
      [...mod.commands.values()].map((spec) => ({
        ...spec,
        type: 'local' as const,
        supportsNonInteractive: true,
        loadedFrom: 'plugin' as const,
        load: async () => ({
          call: async (args: string, context: LocalJSXCommandContext) => {
            const { hasPermissionsToUseTool } =
              await import('../../permissions/permissions.js')
            const { createAssistantMessage } = await import('../../messages.js')
            const assistant =
              [...(context.messages ?? [])]
                .reverse()
                .find((message) => message.type === 'assistant') ??
              createAssistantMessage({ content: [] })
            const result = (await withModToolContext(
              {
                toolUseContext: context,
                canUseTool: context.canUseTool ?? hasPermissionsToUseTool,
                assistantMessage: assistant,
              },
              () =>
                dispatchModEvent(
                  'command.run',
                  {
                    command: spec.name,
                    args,
                    origin: { kind: getIsInteractive() ? 'composer' : 'sdk' },
                    presentation: {
                      isFullscreen: isFullscreenActive(),
                      columns: process.stdout.columns || 80,
                    },
                  },
                  async () => ({ text: `No mod handled /${spec.name}.` }),
                  context.abortController.signal,
                ),
            )) as ModRecord
            const text = [
              ...takeModLogs(),
              ...(typeof result.text === 'string' ? [result.text] : []),
            ].join('\n')
            return text || result.context?.length
              ? { type: 'text' as const, value: text, context: result.context }
              : { type: 'skip' as const }
          },
        }),
      })),
    )
}

export function orderPluginMods(plugins: LoadedPlugin[]): LoadedPlugin[] {
  const remaining = new Map(plugins.map((plugin) => [plugin.source, plugin]))
  const dependencies = new Map(
    plugins.map((plugin) => [
      plugin.source,
      new Set(
        (plugin.manifest.dependencies ?? []).map((dep) => {
          const qualified = qualifyDependency(dep, plugin.source)
          return (
            plugins.find(
              (candidate) =>
                candidate.source === qualified ||
                (!qualified.includes('@') && candidate.name === qualified),
            )?.source ?? qualified
          )
        }),
      ),
    ]),
  )
  const result: LoadedPlugin[] = []
  // A dependent wraps its dependencies even when discovery found a dependency first.
  while (remaining.size) {
    const ready = [...remaining.values()].find(
      (plugin) =>
        ![...remaining.keys()].some((id) =>
          dependencies.get(id)?.has(plugin.source),
        ),
    )
    if (!ready) throw new Error('Cyclic mod dependencies')
    result.push(ready)
    remaining.delete(ready.source)
  }
  return result
}

export async function stopPluginMods(): Promise<void> {
  const previous = active
  active = []
  await publishModToolRegistries([])
  await Promise.allSettled(previous.map((mod) => mod.runtime.dispose()))
}

/** Called at session start or explicit reload, never by catalog discovery. */
export async function startPluginMods(reload = false): Promise<void> {
  if (loading) {
    await loading
    if (!reload) return
  }
  if (started && !reload) return
  if (isBareMode() || (getIsInteractive() && !checkHasTrustDialogAccepted()))
    return
  loading = (async () => {
    // executeSessionEndHooks owns disposal in its finally path. The general
    // cleanup registry runs before SessionEnd and must not terminate mods early.
    const { loadAllPluginsCacheOnly } = await import('../pluginLoader.js')
    const { enabled, errors }: PluginLoadResult =
      await loadAllPluginsCacheOnly()
    const candidates = enabled.filter(allowed)
    if (!candidates.length && !active.length) {
      started = true
      return
    }
    const { compileMod } = await import('./compiler.js')
    // Dependent mods wrap their dependencies, matching the public middleware order.
    const ordered = orderPluginMods(candidates)
    const { getCommands, clearCommandsCache } =
      await import('../../../commands.js')
    const reserved = new Set(
      (await getCommands(getOriginalCwd()))
        .filter(
          (command) => !active.some((mod) => mod.commands.has(command.name)),
        )
        .flatMap((command) => [command.name, ...(command.aliases ?? [])]),
    )
    const next: ActiveMod[] = []
    const reservedTools = new Map<string, ModToolRegistry>()
    warnings.length = 0
    for (const plugin of ordered) {
      const { loadPluginOptions } = await import('../pluginOptionsStorage.js')
      const options = {
        ...Object.fromEntries(
          Object.entries(plugin.manifest.userConfig ?? {})
            .filter(([, field]) => field.default !== undefined)
            .map(([key, field]) => [key, field.default]),
        ),
        ...loadPluginOptions(plugin.source),
      }
      for (const entry of plugin.modEntries ?? []) {
        let runtime: ModRuntime | undefined
        const commands = new Map<string, ModCommandSpec>()
        try {
          const compiled = await compileMod(plugin.path, entry)
          runtime = new ModRuntime(
            { name: plugin.name, root: plugin.path },
            compiled,
            options,
          )
          await runtime.initialize()
          const tools = createModToolRegistry({
            plugin: plugin.name,
            isCurrent: () =>
              active.some(
                (item) => item.runtime === runtime && allowed(item.plugin),
              ),
            reserved: reservedTools,
            changed: async () => {},
          })
          const mod: ActiveMod = {
            plugin,
            runtime,
            commands,
            tools,
            host: createModHost({
              id: plugin.source,
              name: plugin.name,
              commands,
              reserved,
              tools,
              listTools: async () => {
                const { getModToolContext } = await import('./toolContext.js')
                const bound = getModToolContext()
                const { assembleToolPool, filterToolsByDenyRules } =
                  await import('../../../tools.js')
                const state =
                  bound?.toolUseContext.getAppState() ??
                  (
                    await import('../../../state/AppState.js')
                  ).getDefaultAppState()
                const available = bound
                  ? readModToolSnapshot(bound.toolUseContext).tools
                  : assembleToolPool(state.toolPermissionContext, [])
                // Startup registrations are private until publication. Once a
                // tool invocation binds, its effective inventory is the scope.
                const own = bound ? [] : [...tools.tools.values()]
                const inventory = new Map(
                  filterToolsByDenyRules(
                    [...available, ...own],
                    state.toolPermissionContext,
                  ).map((tool) => [tool.name, tool]),
                )
                const all = [...inventory.values()]
                return Promise.all(
                  all.map(async (tool) => ({
                    name: tool.name,
                    description: await tool.description(
                      {},
                      {
                        isNonInteractiveSession: !getIsInteractive(),
                        toolPermissionContext: state.toolPermissionContext,
                        tools: all,
                      },
                    ),
                    mcp: tool.isMcp === true,
                  })),
                )
              },
              commandsChanged: async () => {
                // Startup registrations stay private until the complete new
                // snapshot has finished its session.start middleware chain.
                if (!active.some((item) => item.runtime === runtime)) return
                clearCommandsCache()
                const { skillChangeDetector } =
                  await import('../../skills/skillChangeDetector.js')
                skillChangeDetector.notifyManualReload()
              },
              log: (text) => logs.push(text),
            }),
          }
          next.push(mod)
        } catch (error) {
          await runtime?.dispose()
          const reason = error instanceof Error ? error.message : String(error)
          warn(`${plugin.name}: mod did not load: ${reason}`)
          errors.push({
            type: 'hook-load-failed',
            source: plugin.source,
            plugin: plugin.name,
            hookPath: entry,
            reason,
          })
        }
      }
    }
    try {
      await dispatchModSnapshot(
        next,
        'session.start',
        {
          cwd: getOriginalCwd(),
          surface: getIsInteractive() ? 'terminal' : null,
          isInteractive: getIsInteractive(),
        },
        async (e) => ({ cwd: e.cwd }),
      )
      // Replace the live snapshot atomically below without publishing an empty
      // registry in between. Unchanged tool definitions keep their cache bytes.
      const previous = active
      active = []
      await Promise.allSettled(previous.map((mod) => mod.runtime.dispose()))
    } catch (error) {
      await Promise.allSettled(next.map((mod) => mod.runtime.dispose()))
      throw error
    }
    active = next
    await publishModToolRegistries(next.map((mod) => mod.tools))
    started = true
    clearCommandsCache()
    const { skillChangeDetector } =
      await import('../../skills/skillChangeDetector.js')
    skillChangeDetector.notifyManualReload()
  })()
  try {
    await loading
  } finally {
    loading = undefined
  }
}

export async function endPluginMods(
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await dispatchModEvent(
      'session.end',
      { reason, sessionId: getSessionId(), resume: { id: getSessionId() } },
      async (e) => ({ sessionId: e.sessionId }),
      signal,
    )
  } finally {
    await stopPluginMods()
    started = false
  }
}
