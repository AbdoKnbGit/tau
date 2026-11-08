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
import { isAbsolute, relative, resolve as resolvePath } from 'path'
import type { CompiledMod } from './compiler.js'
import {
  CORE_NOUNS,
  MOD_API_EVENTS,
  MOD_EVENTS,
  MOD_METHODS,
  MOD_MCP_EVENTS,
  MOD_OP_CODECS,
  MOD_PLAIN_METHODS,
  modHookSelects,
  modTelemetryHookRefusal,
} from './contracts.js'
import { emitModLog, getModSessionBinding, takeModLogs, toastFromMod } from './sessionState.js'
import { peekModState, readModState, resetModState, writeModState, type ModStateAddress } from './stateApi.js'
import { disposeModClients, forgetModClientFaults, setModClientEvents } from './clientHost.js'
import {
  forgetModUi,
  getFocusedModPane,
  getModPanes,
  getModSite,
  invalidateModSite,
  listModPanes,
  modControls,
  openModPane,
  removeModPane,
  setModFocusKey,
  setModStatus,
  setModUiRenderer,
  validateModTree,
  blitModRaster,
  setModToolNotice,
  getModScroller,
  isModBandFocused,
  normalizeModTree,
  type ModUiNode,
} from './uiState.js'
import {
  createModToolRegistry,
  publishModToolRegistries,
  type ModToolRegistry,
} from './tools.js'
export { getModTools, getModToolRevision, subscribeModTools } from './tools.js'
import {
  MOD_TIERS,
  ModRuntime,
  type ModChainJump,
  type ModChunkSink,
  type ModRecord,
  type ModHost,
  type ModTier,
  type ModTraceEntry,
  type ModTraceSinks,
} from './runtime.js'
import {
  exitModToolContext,
  getModToolContext,
  readModToolSnapshot,
  withModToolContext,
  type ModCallFrame,
} from './toolContext.js'

export type ModDispatchOptions = {
  origin?: { plugin: string; tier: string }
  skip?: { runtime: ModRuntime; hook: number }
  /** The event came from this module's code outside its hooks: every hook
   * of it is skipped (re-entry). */
  skipRuntime?: ModRuntime
  validateInput?: (input: ModRecord) => void
  validateResult?: (result: ModRecord) => void
  onWarning?: (text: string) => void
  /** Receives every link of the chain as it settles. */
  collect?: ModTraceEntry[]
  /** A site's `ui.render`: its hooks' `$.state` reads subscribe it. */
  render?: ModCallFrame['render']
}

type ActiveMod = {
  plugin: LoadedPlugin
  runtime: ModRuntime
  /** Its place among the chain's tiers: org mods prepend or append. */
  tier: Exclude<ModTier, 'core'>
  /** Every `$` method its module calls, as the compiler read them. */
  calls: readonly string[]
  /** Its compiled files, for the Client modules it draws. */
  compiled: CompiledMod
  commands: Map<string, ModCommandSpec>
  tools: ModToolRegistry
  host: ModHost
  /** The load this module belongs to, in chain order. */
  snapshot: readonly ActiveMod[]
}
let active: ActiveMod[] = []
let started = false
let loading: Promise<void> | undefined
const warnings: string[] = []
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

/** Whether a loaded mod hooks `event`, by name or by a glob or negation. An
 * event Tau does not raise to mods is never hooked, whatever a glob says. */
export function hasModEvent(event: string): boolean {
  return (
    MOD_EVENTS.has(event) &&
    active.some(
      (mod) =>
        allowed(mod.plugin) &&
        mod.runtime.hooks.some((hook) => modHookSelects(hook, event)),
    )
  )
}
export { takeModLogs }
export function logModCompactionFallback(text: string): void {
  routeModLog(text)
}
/** A `$.ui.log` line goes to the output it belongs to when one collects it,
 * else to the transcript (or held for the next output that drains lines). */
function routeModLog(text: string): void {
  const collect = getModToolContext()?.log
  if (collect) collect(text)
  else emitModLog(text)
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
  core: (event: ModRecord) => Promise<unknown>,
  signal?: AbortSignal,
  options?: ModDispatchOptions,
): Promise<unknown> {
  return dispatchModSnapshot(active, event, input, core, signal, options)
}

/** Who a mod's own calls come from, as `next.origin` reads it, and the
 * module whose hooks a call of its code outside its hooks skips. */
export function modChainSeat(plugin: string): { origin: { plugin: string; tier: string }; runtime?: ModRuntime } {
  const mod = active.find(item => item.plugin.name === plugin)
  return { origin: { plugin, tier: mod?.tier ?? 'user' }, ...(mod ? { runtime: mod.runtime } : {}) }
}

function dispatchModSnapshot(
  snapshot: readonly ActiveMod[],
  event: string,
  input: ModRecord,
  core: (event: ModRecord) => Promise<unknown>,
  signal?: AbortSignal,
  options: ModDispatchOptions = {},
): Promise<unknown> {
  const mods = snapshot.filter((mod) => allowed(mod.plugin))
  const bound = getModToolContext()
  // The chain's links: each module's hooks selecting the event, in order,
  // indexed from 0 at the outermost; the engine is the last.
  const counts = mods.map(mod => mod.runtime.hooks.filter(hook => modHookSelects(hook, event)).length)
  const bases = counts.map((_, index) => counts.slice(0, index).reduce((sum, count) => sum + count, 0))
  const engineLink = counts.reduce((sum, count) => sum + count, 0)
  const settle = (sinks: ModTraceSinks, entry: ModTraceEntry) => { for (const sink of sinks) sink.push(entry) }
  const runCore = async (current: ModRecord, sinks: ModTraceSinks): Promise<unknown> => {
    const started = Date.now()
    const engine = (outcome: ModTraceEntry['outcome'], returned: unknown) => settle(sinks, {
      index: engineLink, plugin: 'engine', tier: 'core', event, outcome, ms: Date.now() - started, received: current, returned,
    })
    try {
      const value = await withModToolContext(bound, () => core(current))
      engine('returned', value)
      return value
    } catch (error) {
      engine('rejected', undefined)
      throw error
    }
  }
  const run = (index: number, current: ModRecord, sinks: ModTraceSinks, jump?: ModChainJump): Promise<unknown> => {
    // A next.to above: every link above the tier it named is skipped.
    if (jump) {
      const floor = MOD_TIERS.indexOf(jump.to)
      for (; index < mods.length && MOD_TIERS.indexOf(mods[index]!.tier) < floor; index++)
        for (let position = 0; position < counts[index]!; position++)
          settle(sinks, {
            index: bases[index]! + position, plugin: mods[index]!.plugin.name, tier: mods[index]!.tier, event,
            outcome: 'skipped', reason: `bypassed by ${jump.by}`, ms: 0, received: current, returned: undefined,
          })
    }
    const mod = mods[index]
    if (!mod) return runCore(current, sinks)
    return mod.runtime.dispatch(
      event,
      current,
      (next, nextJump, nextSinks) => run(index + 1, next, nextSinks ?? sinks, nextJump),
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
          () => callModApi(snapshot, mod, method, args, signal,
            frame && options.render ? { ...frame, render: options.render } : frame),
        ),
      {
        signal,
        warn: text => { warn(text); options.onWarning?.(text) },
        origin: options.origin,
        skipHook:
          options.skip?.runtime === mod.runtime ? options.skip.hook : undefined,
        skipAll: options.skipRuntime === mod.runtime,
        tier: mod.tier,
        base: bases[index],
        sinks,
        validateResult: options.validateResult,
        validateInput: options.validateInput,
      },
    )
  }
  return run(0, input, options.collect ? [options.collect] : [])
}

/**
 * A streaming event (turn.step) through every loaded mod: each hook an async
 * generator, `core` the engine streaming into the sink it is handed. What
 * the outermost hook yields reaches `sink`; resolves with the event's result.
 */
export function dispatchModStream(
  event: string,
  input: ModRecord,
  core: (event: ModRecord, sink: ModChunkSink, signal: AbortSignal | undefined) => Promise<unknown>,
  sink: ModChunkSink,
  signal?: AbortSignal,
  options: ModDispatchOptions & { resultOf?: (chunks: unknown[], input: ModRecord) => unknown } = {},
): Promise<unknown> {
  const mods = active.filter(mod => allowed(mod.plugin))
  const bound = getModToolContext()
  const counts = mods.map(mod => mod.runtime.hooks.filter(hook => modHookSelects(hook, event)).length)
  const bases = counts.map((_, index) => counts.slice(0, index).reduce((sum, count) => sum + count, 0))
  const engineLink = counts.reduce((sum, count) => sum + count, 0)
  const settle = (sinks: ModTraceSinks, entry: ModTraceEntry) => { for (const item of sinks) item.push(entry) }
  const runCore = async (current: ModRecord, out: ModChunkSink, sinks: ModTraceSinks, below: AbortSignal | undefined) => {
    const started = Date.now()
    let chunks = 0
    const engine = (outcome: ModTraceEntry['outcome'], returned: unknown) => settle(sinks, {
      index: engineLink, plugin: 'engine', tier: 'core', event, outcome, ms: Date.now() - started, chunks, received: current, returned,
    })
    try {
      const value = await withModToolContext(bound, () => core(current, chunk => { chunks++; out(chunk) }, below))
      engine('returned', value)
      return value
    } catch (error) {
      engine('rejected', undefined)
      throw error
    }
  }
  const run = (index: number, current: ModRecord, out: ModChunkSink, sinks: ModTraceSinks, below: AbortSignal | undefined, jump?: ModChainJump): Promise<unknown> => {
    if (jump) {
      const floor = MOD_TIERS.indexOf(jump.to)
      for (; index < mods.length && MOD_TIERS.indexOf(mods[index]!.tier) < floor; index++)
        for (let position = 0; position < counts[index]!; position++)
          settle(sinks, {
            index: bases[index]! + position, plugin: mods[index]!.plugin.name, tier: mods[index]!.tier, event,
            outcome: 'skipped', reason: `bypassed by ${jump.by}`, ms: 0, received: current, returned: undefined,
          })
    }
    const mod = mods[index]
    if (!mod) return runCore(current, out, sinks, below)
    return mod.runtime.dispatchStream(
      event,
      current,
      out,
      (next, nextSink, nextSignal, nextJump, nextSinks) => run(index + 1, next, nextSink, nextSinks ?? sinks, nextSignal, nextJump),
      (method, args, callSignal, frame) =>
        withModToolContext(
          bound ? { ...bound, frame: frame ? { ...frame, plugin: mod.plugin.name } : bound.frame } : undefined,
          () => callModApi(mod.snapshot, mod, method, args, callSignal, frame),
        ),
      {
        signal: below,
        warn: text => { warn(text); options.onWarning?.(text) },
        origin: options.origin,
        skipHook: options.skip?.runtime === mod.runtime ? options.skip.hook : undefined,
        skipAll: options.skipRuntime === mod.runtime,
        tier: mod.tier,
        base: bases[index],
        sinks,
        validateResult: options.validateResult,
        validateInput: options.validateInput,
        resultOf: options.resultOf,
      },
    )
  }
  return run(0, input, sink, options.collect ? [options.collect] : [], signal)
}

/**
 * Serves one `$` call of `mod`. A call the host serves is first an event for
 * the mods above the caller (its own hooks never see it): they may pass it
 * on, rewrite it, refuse it with `{ deny }`, or answer `{ value }`.
 */
async function callModApi(
  snapshot: readonly ActiveMod[],
  mod: ActiveMod,
  method: string,
  args: any[],
  signal: AbortSignal,
  frame?: ModCallFrame,
): Promise<unknown> {
  if (method === 'session.compact') {
    const { compactModSession } = await import('./compactApi.js')
    return compactModSession(args, signal, frame, mod.plugin.name)
  }
  if (method === 'lent.call') {
    // A method another module added to $ at engine.create: it runs in that
    // module, its own $ calls served in this call's context while it runs.
    const [id, callArgs] = args
    const lender = [...snapshot, ...active].find(item =>
      item.runtime.token && typeof id === 'string' && id.startsWith(item.runtime.token + ':lent:'))
    if (!lender || !allowed(lender.plugin)) throw new Error('The mod that added this method is not loaded')
    const bound = getModToolContext()
    return lender.runtime.runLent(id, Array.isArray(callArgs) ? callArgs : [], (lentMethod, lentArgs, lentSignal) =>
      withModToolContext(bound, () =>
        callModApi(lender.snapshot, lender, lentMethod, lentArgs, AbortSignal.any([signal, lentSignal]))))
  }
  if (method === 'prompt.compose') {
    // The system prompt's sections for the facts asked (the session's own
    // for any left out), through every other mod's hook; sent to nobody.
    const [facts] = args
    if (args.length > 1 || (facts !== undefined && !isRecord(facts)))
      throw new Error('prompt.compose takes an optional facts object')
    const context = getModToolContext()?.toolUseContext ?? getModSessionBinding()?.getCompactContext?.()
    if (!context) throw new Error('$.prompt.compose needs a running session')
    const { composeSystemPrompt } = await import('../../../constants/prompts.js')
    const directories = [...(context.getAppState().toolPermissionContext.additionalWorkingDirectories?.keys?.() ?? [])]
    const model = isRecord(facts) && typeof facts.model === 'string' && facts.model ? facts.model : context.options.mainLoopModel
    const { sections } = await composeSystemPrompt(context.options.tools, model, directories, context.options.mcpClients, {
      dry: true, always: true, signal, facts: isRecord(facts) ? facts : undefined,
      dispatch: { skipRuntime: mod.runtime, origin: { plugin: mod.plugin.name, tier: mod.tier } },
    })
    return { sections }
  }
  if (method === 'process.__next' || method === 'process.__kill') {
    const spawn = await import('./actionsApi.js')
    return method === 'process.__next'
      ? spawn.readModSpawn(args[0], mod.runtime, signal)
      : spawn.stopModSpawn(args[0], mod.runtime)
  }
  if (MOD_PLAIN_METHODS.has(method)) return callPlainModApi(mod, method, args, signal, frame)
  if (MOD_API_EVENTS.has(method)) {
    const mcp = MOD_MCP_EVENTS.has(method) ? await import('./mcpApi.js') : undefined
    const codec = MOD_OP_CODECS[method]
    if (!mcp && !codec) throw new Error(`Tau does not yet support mod API $.${method}`)
    const input: ModRecord = mcp ? mcp.mcpApiInput(method, args) : codec!.event(args)
    if (method === 'state.set') {
      // Raised by the value's owner alone, and never while it draws.
      if (frame?.event === 'ui.render')
        throw new Error(`${mod.plugin.name}: $.state.set is refused while a ui.render hook draws; write from onPress or another event`)
      if (input.plugin !== mod.plugin.name)
        throw new Error(`${mod.plugin.name}: $.state.set: ${input.plugin}'s values are its own; hook its state.set and rewrite e.value`)
      const previous = peekModState(input as ModStateAddress)
      if (previous !== undefined) input.previous = previous
    }
    const pinned = codec?.pinned ?? []
    const position = snapshot.indexOf(mod)
    const result = (await dispatchModSnapshot(
      position < 0 ? [] : snapshot.slice(0, position),
      method,
      input,
      async (event) => ({
        value: mcp
          ? await mcp.runModMcpAPI(method, event, signal, mod.plugin)
          : await serveModOp(mod, method, event, codec!, signal, frame),
      }),
      signal,
      {
        origin: { plugin: mod.plugin.name, tier: mod.tier },
        ...(pinned.length
          ? {
              // A pinned field left out of a rewrite is kept; a changed one is refused.
              validateInput: (rewritten: ModRecord) => {
                for (const key of pinned) {
                  if (rewritten[key] === undefined && input[key] !== undefined) rewritten[key] = input[key]
                  else if (JSON.stringify(rewritten[key]) !== JSON.stringify(input[key]))
                    throw new Error(`${method} cannot rewrite ${key}`)
                }
              },
            }
          : {}),
      },
    )) as ModRecord
    if (result.deny !== undefined)
      throw new Error(`${mod.plugin.name}: $.${method}: ${result.deny}`)
    return result.value
  }
  if (method === 'prompt.submit') {
    const { enqueueModPrompt } = await import('./promptQueue.js')
    const { isModSessionStopped } = await import('./sessionState.js')
    // Startup handlers can submit before their snapshot is published.
    // A queued turn must see that complete snapshot and its tools.
    if (!active.some(item => item.runtime === mod.runtime) && loading) await loading
    if (!active.some(item => item.runtime === mod.runtime && allowed(item.plugin)))
      return { drop: 'the plugin was unloaded before the prompt ran' }
    if (isModSessionStopped()) return { drop: 'the session was stopped and nobody has sent input since' }
    if (args.length !== 1) throw new Error('prompt.submit takes one argument object')
    return enqueueModPrompt(args[0], { plugin: mod.plugin.name, owner: mod.runtime, hook: frame?.hook }, signal)
  }
  if (method === 'tool.call' || method === 'tool.check') {
    const { runModToolAPI } = await import('./toolApi.js')
    return inSessionToolContext(() => runModToolAPI(method, args[0], signal, mod.plugin.name))
  }
  return mod.host(method, args, signal, frame)
}

const isRecord = (value: unknown): value is ModRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * `agent.spawn` for a subagent or teammate the Agent tool is about to start:
 * a hook refuses it with `{ deny }` or picks its model with `next({ ...e, model })`.
 */
export async function dispatchModAgentSpawn(input: ModRecord, signal: AbortSignal): Promise<ModRecord> {
  return (await dispatchModEvent(
    'agent.spawn',
    input,
    async e => ({ model: typeof e.model === 'string' && e.model ? e.model : 'inherit' }),
    signal,
    getModToolContext()?.dispatchOptions,
  )) as ModRecord
}

/** Whether the organization's managed settings install this mod. */
function isManagedMod(mod: ActiveMod): boolean {
  return isOrganizationMod(mod.plugin)
}

/**
 * Runs `action` with a tool invocation context: the hook's own when it has
 * one, else the session's (a timer, a call made after a hook returned). Tool
 * calls made from there check permissions without a dialog: an `ask` refuses.
 */
async function inSessionToolContext<T>(action: () => Promise<T>): Promise<T> {
  if (getModToolContext()) return action()
  const context = getModSessionBinding()?.getCompactContext?.()
  if (!context) throw new Error('this mod API needs a running session')
  const [{ hasPermissionsToUseTool }, { createAssistantMessage }] = await Promise.all([
    import('../../permissions/permissions.js'),
    import('../../messages.js'),
  ])
  return withModToolContext(
    { toolUseContext: context, canUseTool: hasPermissionsToUseTool, assistantMessage: createAssistantMessage({ content: [] }) },
    action,
  )
}

/** The host side of an op event, after the mods above the caller passed it on. */
async function serveModOp(
  mod: ActiveMod,
  method: string,
  event: ModRecord,
  codec: { args(event: ModRecord): unknown[] },
  signal: AbortSignal,
  frame?: ModCallFrame,
): Promise<unknown> {
  switch (method) {
    case 'model.complete':
    case 'model.classify':
    case 'model.fork': {
      const model = await import('./modelApi.js')
      return method === 'model.complete'
        ? model.modelComplete(event, signal)
        : method === 'model.classify'
          ? model.modelClassify(event, signal)
          : model.modelFork(event, signal)
    }
    case 'http.fetch':
      return (await import('./sessionApi.js')).modHttpFetch(event.url, event.init, signal)
    case 'fs.ancestors': {
      const { readAncestors } = await import('./sessionApi.js')
      return readAncestors(event, path => {
        if (/^[\\/]{2}/.test(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path))
          throw new Error('Mod filesystem calls do not accept network locations')
        return resolvePath(getOriginalCwd(), path)
      })
    }
    case 'session.repo':
      return (await import('./sessionApi.js')).readSessionRepo()
    case 'session.usage':
      return (await import('./sessionApi.js')).readSessionUsage()
    case 'session.authorize':
      return (await import('./sessionApi.js')).authorizeSession()
    case 'session.identity':
      return (await import('./sessionApi.js')).readSessionIdentity(isManagedMod(mod))
    case 'prompt.read':
      return (await import('./sessionApi.js')).readPromptBox()
    case 'process.spawn':
      return (await import('./actionsApi.js')).startModSpawn(event.argv, event.init, mod.runtime, signal)
    case 'agent.list': {
      const state = getModToolContext()?.toolUseContext.getAppState() ?? getModSessionBinding()?.getAppState?.()
      return (await import('./actionsApi.js')).listModAgents(state as ModRecord | undefined)
    }
    case 'agent.register':
      return (await import('./actionsApi.js')).registerModAgent(event, { name: mod.plugin.name, root: mod.plugin.path }, mod.runtime)
    case 'ui.toast': {
      if (event.timeoutMs !== undefined && (!Number.isFinite(event.timeoutMs) || event.timeoutMs <= 0))
        throw new Error('ui.toast timeoutMs must be a positive number of milliseconds')
      toastFromMod(mod.plugin.name, String(event.text), event.timeoutMs)
      return
    }
    case 'ui.status':
      return setModStatus(mod.plugin.name, event.text)
    case 'ui.notify':
      return notifyFromMod(mod, event, signal, frame)
    case 'ui.open': {
      // An open the person asked for (a command they ran, a control they
      // used) is drawn at any width; one the mod made by itself waits.
      const binding = getModSessionBinding()
      const asked = mod.runtime.servingPerson() ||
        ['command.run', 'ui.press', 'ui.input', 'ui.select'].includes(frame?.event ?? '')
      return openModPane(mod.plugin.name, event, {
        asked,
        // The REPL draws panes; a -p run or the SDK draws nothing.
        surface: !!binding?.appendNotice,
        columns: process.stdout.columns ?? 80,
        canFocus: () => (binding?.canGiveKeyboard?.() ?? false) && !getFocusedModPane() && !isModBandFocused(),
      })
    }
    case 'ui.panes':
      return listModPanes(mod.plugin.name)
    case 'ui.copy':
      return (await import('./sessionApi.js')).copyForMod(event)
    case 'ui.selection':
      // What the person last selected with the mouse, kept past the key or
      // click that took the highlight down, until their next prompt.
      return getModSessionBinding()?.readSelection?.() ?? undefined
    case 'ui.blit':
      return blitModRaster(mod.plugin.name, event)
    case 'ui.notice':
      return setModToolNotice(mod.plugin.name, String(event.tool_use_id), event.text)
    case 'audio.play':
      return (await import('./audioApi.js')).playModClip(event, mod.plugin.path, signal)
    case 'audio.speak':
      return (await import('./audioApi.js')).speakModText(event, signal)
    case 'state.get':
      return readModState(stateAddressOf(event), frame?.render)
    case 'state.set':
      return writeModState(stateAddressOf(event), event.value, event.ifVersion)
    case 'telemetry.log':
    case 'telemetry.mark':
      // Raised for the mods above; a record a mod makes is never sent.
      return
    case 'ui.invalidate':
      // A redraw of what this plugin draws; cached prompt answers are not
      // kept by Tau, so other events have nothing to drop.
      if (event.event === 'ui.render') {
        // A Client that failed in a redraw may be tried again.
        forgetModClientFaults()
        invalidateModSite()
      }
      return
    default:
      return mod.host(method, codec.args(event), signal, frame)
  }
}

const stateAddressOf = (event: ModRecord): ModStateAddress => ({
  plugin: String(event.plugin), key: String(event.key), ...(typeof event.id === 'string' ? { id: event.id } : {}),
})

/**
 * An OpenTelemetry record about to leave for the operator's collector, as
 * `telemetry.log` with `to: 'collector'`: hooks may rewrite what it carries
 * or refuse it. Answers the attributes to send, undefined when it is not sent.
 */
export async function dispatchModCollectorRecord(
  event: string,
  attributes: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (!hasModEvent('telemetry.log')) return attributes
  let sent: Record<string, unknown> | undefined
  const input = {
    to: 'collector', event, attributes,
    loggedAt: typeof attributes['event.timestamp'] === 'string' ? attributes['event.timestamp'] : new Date().toISOString(),
  }
  const attribute = (value: unknown): boolean =>
    ['string', 'number', 'boolean'].includes(typeof value) ||
    (Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item)))
  const result = (await dispatchModEvent('telemetry.log', input, async (e: ModRecord) => {
    // What leaves is plain attribute data; anything else a hook wrote stays out.
    sent = isRecord(e.attributes)
      ? Object.fromEntries(Object.entries(e.attributes).filter(([, value]) => attribute(value)))
      : attributes
    return { value: undefined }
  }, AbortSignal.timeout(5_000), {
    validateInput: (rewritten: ModRecord) => {
      if (rewritten.to === undefined) rewritten.to = 'collector'
      else if (rewritten.to !== 'collector') throw new Error('telemetry.log cannot rewrite to')
    },
    validateResult: (answer: ModRecord) => {
      if (answer.deny === undefined && !Object.hasOwn(answer, 'value'))
        throw new Error('telemetry.log must return { value } or { deny: reason }')
    },
  })) as ModRecord
  return result?.deny !== undefined ? undefined : sent
}

/** `$.ui.notify`: the user's Notification hooks first (the calling hook left
 * out), then the terminal notification their preferredNotifChannel names. */
async function notifyFromMod(mod: ActiveMod, event: ModRecord, signal: AbortSignal, frame?: ModCallFrame) {
  const title = typeof event.title === 'string' && event.title ? event.title : mod.plugin.name
  const binding = getModSessionBinding()
  if (binding) {
    const { createBaseHookInput, executeHooksOutsideREPL } = await import('../../hooks.js')
    await executeHooksOutsideREPL({
      hookInput: {
        ...createBaseHookInput(undefined),
        hook_event_name: 'Notification',
        message: String(event.text),
        title,
        notification_type: 'plugin_notification',
      },
      matchQuery: 'plugin_notification',
      signal,
      modOptions: {
        origin: { plugin: mod.plugin.name, tier: mod.tier },
        ...(frame ? { skip: { runtime: frame.runtime, hook: frame.hook } } : {}),
      },
    }).catch(error => logForDebugging(`${mod.plugin.name}: Notification hooks failed: ${String(error)}`))
  }
  if (!binding?.notify) return { isSent: false, reason: 'no-surface' }
  const method = await binding.notify(String(event.text), title)
  if (method === 'disabled') return { isSent: false, reason: 'disabled' }
  if (method === 'no_method_available' || method === 'none') return { isSent: false, reason: 'no-channel' }
  if (method === 'error') throw new Error('ui.notify could not write to the terminal')
  return { isSent: true, channel: method }
}

/** The `ui.render` chain behind one render site. A pane is drawn by the mod
 * that opened it; the band above the prompt, by every mod in chain order. */
async function renderModSite(site: string, input: ModRecord): Promise<unknown> {
  const owner = site.startsWith('Pane:') ? site.slice(5, site.lastIndexOf(':')) : undefined
  const snapshot = owner === undefined ? active : active.filter(mod => mod.plugin.name === owner)
  const collect: ModTraceEntry[] = []
  const tree = await dispatchModSnapshot(snapshot, 'ui.render', input,
    async () => ({ type: 'engine', ref: String(input.component) }),
    undefined, { validateResult: validateModTree as (result: ModRecord) => void, collect, render: { site, moment: new Map() } })
  // Who drew each Raster, for $.ui.blit: walking up from the engine, the
  // keys a link's drawing holds that the drawing beneath it did not.
  const owners = new Map<string, string>()
  let beneath = new Set<string>()
  for (const entry of collect
    .filter(item => item.plugin !== 'engine' && (item.outcome === 'returned' || item.outcome === 'caught'))
    .sort((a, b) => b.index - a.index)) {
    const keys = ownedKeysOf(entry.returned)
    for (const key of keys) if (!beneath.has(key)) owners.set(key, entry.plugin)
    beneath = keys
  }
  return { tree, owners }
}

/** The Rasters and controls of a drawing, by the keys they are addressed by. */
function ownedKeysOf(tree: unknown): Set<string> {
  const out = new Set<string>()
  const normalized = normalizeModTree(tree)
  const visit = (node: ModUiNode | null): void => {
    if (!node || typeof node === 'string') return
    if (node.type === 'Raster' && typeof node.props.key === 'string') out.add(node.props.key)
    for (const child of node.children) visit(child)
  }
  visit(normalized)
  for (const control of modControls(normalized)) out.add(control.key)
  const clients = (node: ModUiNode | null): void => {
    if (!node || typeof node === 'string') return
    if (node.type === 'Client' && typeof node.props.key === 'string') out.add(node.props.key)
    for (const child of node.children) clients(child)
  }
  clients(normalized)
  return out
}

const siteParts = (site: string): { component: 'Pane' | 'AbovePrompt'; requestId: string; plugin?: string } =>
  site.startsWith('Pane:')
    ? { component: 'Pane', requestId: site.slice(site.lastIndexOf(':') + 1), plugin: site.slice(5, site.lastIndexOf(':')) }
    : { component: 'AbovePrompt', requestId: 'AbovePrompt' }

/**
 * Moves a site's focus ring: `ui.focus` through the mods, then core lands it
 * on `e.element` (the first drawn under that key; a ring `id` tells apart a
 * person's pick among several) or, without one, on an engine stop (a tab).
 */
export async function moveModRing(
  site: string,
  target: { element?: string; id?: string },
  origin: ModRecord,
  signal?: AbortSignal,
  options: ModDispatchOptions = {},
): Promise<ModRecord> {
  const { component, requestId, plugin } = siteParts(site)
  const drawer = target.element === undefined ? undefined : plugin ?? getModSite(site)?.owners?.get(target.element)
  const input: ModRecord = {
    component, requestId,
    ...(target.element !== undefined ? { ...(drawer ? { plugin: drawer } : {}), element: target.element } : {}),
    origin,
  }
  const land = async (e: ModRecord): Promise<ModRecord> => {
    if (e.element === undefined) {
      setModFocusKey(site, target.id)
      return {}
    }
    const controls = modControls(getModSite(site)?.tree)
    const chosen = e.element === target.element && target.id && controls.some(item => `${item.nth}:${item.key}` === target.id)
      ? target.id
      : controls.some(item => item.key === e.element) ? `0:${e.element}` : undefined
    if (!chosen) return { deny: `no element "${String(e.element)}" is drawn there` }
    setModFocusKey(site, chosen)
    return {}
  }
  if (!hasModEvent('ui.focus')) return land(input)
  return (await dispatchModEvent('ui.focus', input, land, signal, options)) as ModRecord
}

/**
 * Moves a site's window: `ui.scroll` through the mods, then core scrolls the
 * view to `e.offset`. `by` is signed rows; `to` an absolute offset.
 */
export async function scrollModSite(
  site: string,
  move: { by?: number; to?: number },
  origin: ModRecord,
  signal?: AbortSignal,
  options: ModDispatchOptions = {},
): Promise<ModRecord> {
  const scroller = getModScroller(site)
  if (!scroller) return { deny: 'that site is not drawn' }
  const { component, requestId } = siteParts(site)
  const bodyRows = scroller.getViewportHeight()
  const contentRows = scroller.getScrollHeight()
  const top = scroller.getScrollTop()
  const last = Math.max(0, contentRows - bodyRows)
  const offset = Math.max(0, Math.min(last, move.to ?? top + (move.by ?? 0)))
  const input = { component, requestId, offset, by: offset - top, bodyRows, contentRows, origin }
  const apply = async (e: ModRecord): Promise<ModRecord> => {
    scroller.scrollTo(Math.max(0, Math.min(last, Number(e.offset) || 0)))
    return {}
  }
  if (!hasModEvent('ui.scroll')) return apply(input)
  return (await dispatchModEvent('ui.scroll', input, apply, signal, options)) as ModRecord
}

/** `$.ui.scroll({ to, in, block })`: the start or end of a site, or one of
 * this plugin's elements brought into view. */
async function scrollFromMod(mod: ActiveMod, input: unknown, signal: AbortSignal, frame?: ModCallFrame): Promise<ModRecord> {
  if (!isRecord(input)) throw new Error('ui.scroll takes { to, in }')
  const options = frame ? { skip: { runtime: frame.runtime, hook: frame.hook } } : {}
  const origin = { kind: 'plugin', name: mod.plugin.name }
  const siteOf = (id: string) => id === 'AbovePrompt' ? 'AbovePrompt' : `Pane:${mod.plugin.name}:${id}`
  if (input.to === 'start' || input.to === 'end') {
    if (typeof input.in !== 'string') throw new Error('ui.scroll to start or end names the site: { to, in }')
    return scrollModSite(siteOf(input.in), input.to === 'start' ? { to: 0 } : { to: Number.MAX_SAFE_INTEGER }, origin, signal, options)
  }
  if (isRecord(input.to) && typeof input.to.key === 'string') {
    const key = input.to.key
    const site = typeof input.in === 'string' ? siteOf(input.in)
      : [...getModPanes().filter(pane => pane.plugin === mod.plugin.name).map(pane => `Pane:${pane.plugin}:${pane.id}`), 'AbovePrompt']
        .find(candidate => modControls(getModSite(candidate)?.tree).some(item => item.key === key))
    const scroller = site ? getModScroller(site) : undefined
    if (!site || !scroller?.reveal) return { deny: `no element "${key}" of this plugin is drawn` }
    const before = scroller.getScrollTop()
    if (!scroller.reveal(`0:${key}`)) return { deny: `no element "${key}" of this plugin is drawn` }
    const after = scroller.getScrollTop()
    scroller.scrollTo(before)
    return scrollModSite(site, { to: after }, origin, signal, options)
  }
  return { deny: 'the terminal scrolls a site to its start or end, or to one of the plugin\'s elements' }
}
setModUiRenderer(renderModSite)

// A Client's module comes from the plugin's current load; what it posts and
// how it fails reach that plugin's hooks alone.
setModClientEvents({
  source(plugin, module) {
    const mod = active.find(item => item.plugin.name === plugin && allowed(item.plugin) && item.compiled.clients?.[module])
    return mod ? { digest: mod.compiled.digest, files: mod.compiled.files, clients: mod.compiled.clients! } : undefined
  },
  async message(plugin, input) {
    const own = active.filter(item => item.plugin.name === plugin)
    if (!own.some(item => item.runtime.hooks.some(hook => modHookSelects(hook, 'ui.message')))) return undefined
    return (await dispatchModSnapshot(own, 'ui.message', input, async () => ({}), undefined,
      { origin: { plugin: 'client', tier: 'core' } })) as ModRecord
  },
  async fault(plugin, input) {
    const own = active.filter(item => item.plugin.name === plugin)
    if (!own.some(item => item.runtime.hooks.some(hook => modHookSelects(hook, 'ui.fault')))) return
    await dispatchModSnapshot(own, 'ui.fault', input, async () => ({}), undefined)
  },
})

/**
 * A person used a control a mod drew: `ui.press`, `ui.input` or `ui.select`
 * through every mod, then the control's own closure in the mod that drew it.
 * `nth` picks among controls sharing the key (a Delete button on every row).
 */
export async function applyModControl(
  site: string,
  key: string,
  kind: 'press' | 'change' | 'submit' | 'select',
  value?: string,
  nth = 0,
): Promise<void> {
  const control = modControls(getModSite(site)?.tree).find(item => item.key === key && item.nth === nth)?.node
  const handlerName = kind === 'press' ? 'onPress' : kind === 'change' ? 'onInput' : kind === 'submit' ? 'onSubmit' : 'onSelect'
  const handleOf = (name: string) => {
    const reference = control?.props[name]
    return isRecord(reference) && typeof reference.__handler === 'string' ? reference.__handler : undefined
  }
  const handler = handleOf(handlerName)
  const anyHandle = handler ?? ['onPress', 'onInput', 'onSubmit', 'onSelect'].map(handleOf).find(Boolean)
  if (!anyHandle) return
  const owner = active.find(mod => mod.runtime.token && anyHandle.startsWith(mod.runtime.token + ':'))
  if (!owner || !allowed(owner.plugin)) return
  const [component, requestId] = site.startsWith('Pane:')
    ? ['Pane', site.slice(site.lastIndexOf(':') + 1)]
    : [site, site]
  const event = kind === 'press' ? 'ui.press' : kind === 'select' ? 'ui.select' : 'ui.input'
  await dispatchModEvent(event, {
    plugin: owner.plugin.name,
    element: key,
    component,
    requestId,
    surface: 'terminal',
    ...(kind === 'change' || kind === 'submit' ? { kind: kind === 'submit' ? 'submit' : 'change', value: value ?? '' } : {}),
    ...(kind === 'select' ? { value: value ?? '' } : {}),
  }, async e => {
    // The control's own closure, with the argument as the chain left it.
    if (handler) await owner.runtime.runHandler(handler, event === 'ui.press' ? [e] : [e.value, e])
    return { element: key, ...(e.value !== undefined ? { value: e.value } : {}) }
  }).catch(error => logForDebugging(`${owner.plugin.name}: ${event} on ${key} failed: ${String(error)}`, { level: 'warn' }))
}

/**
 * Closes a pane: `ui.close` through every mod (the calling hook skipped); a
 * hook that answers without `next` keeps it open.
 */
export async function closeModPane(
  plugin: string,
  id: string,
  kind: 'plugin' | 'person',
  signal?: AbortSignal,
  options?: ModDispatchOptions,
): Promise<void> {
  if (!getModPanes().some(pane => pane.plugin === plugin && pane.id === id)) return
  const result = (await dispatchModEvent('ui.close', { id, origin: { kind } }, async () => {
    removeModPane(plugin, id)
    return {}
  }, signal, options)) as ModRecord
  if (typeof result.deny === 'string') throw new Error(`${plugin}: $.ui.close: ${result.deny}`)
}

/** `$` calls that act through engine events or what the person sees. */
async function callPlainModApi(
  mod: ActiveMod,
  method: string,
  args: any[],
  signal: AbortSignal,
  frame?: ModCallFrame,
): Promise<unknown> {
  const [input] = args
  switch (method) {
    case 'session.append':
      return (await import('./sessionApi.js')).appendSessionRow(input)
    case 'prompt.fill':
      return (await import('./sessionApi.js')).fillPromptBox(input)
    case 'prompt.suggest':
      return (await import('./sessionApi.js')).suggestPrompt(input)
    case 'session.send': {
      // The SendMessage tool's own delivery, through its tool.call hooks.
      if (!isRecord(input) || typeof input.text !== 'string' || !input.text.trim())
        throw new Error('session.send takes { to, text }')
      const to = typeof input.to === 'string'
        ? input.to
        : isRecord(input.to) && typeof (input.to.agentId ?? input.to.sessionId) === 'string'
          ? String(input.to.agentId ?? input.to.sessionId)
          : undefined
      if (!to) throw new Error('session.send to is an address, { agentId } or { sessionId }')
      try {
        const { runModToolAPI } = await import('./toolApi.js')
        const sent = (await inSessionToolContext(() => runModToolAPI('tool.call', {
          tool: 'SendMessage', to, message: input.text, summary: input.text.slice(0, 60),
        }, signal, mod.plugin.name))) as ModRecord
        if (sent.deny !== undefined) return { isDelivered: false, reason: String(sent.deny) }
        if (sent.isError) return { isDelivered: false, reason: String(sent.text || 'the message was not delivered') }
        return { isDelivered: true }
      } catch (error) {
        signal.throwIfAborted()
        return { isDelivered: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
    case 'agent.spawn': {
      // The Agent tool in the background, through its tool.call and
      // agent.spawn hooks; it answers once the subagent started.
      if (!isRecord(input) || typeof input.prompt !== 'string' || !input.prompt.trim())
        throw new Error('agent.spawn takes { prompt }')
      for (const key of ['description', 'subagentType', 'model', 'name', 'cwd'])
        if (input[key] !== undefined && typeof input[key] !== 'string')
          throw new Error(`agent.spawn ${key} must be a string`)
      const { runModToolAPI } = await import('./toolApi.js')
      const ran = (await inSessionToolContext(() => runModToolAPI('tool.call', {
        tool: 'Agent',
        prompt: input.prompt,
        description: input.description ?? input.prompt.trim().split(/\s+/).slice(0, 6).join(' '),
        ...(input.subagentType ? { subagent_type: input.subagentType } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        run_in_background: true,
      }, signal, mod.plugin.name))) as ModRecord
      if (ran.deny !== undefined) return { deny: String(ran.deny) }
      if (ran.isError) return { deny: String(ran.text || 'the agent did not start') }
      const record = isRecord(ran.result) ? ran.result : {}
      return {
        model: String(record.resolvedModel ?? record.model ?? input.model ?? 'inherit'),
        ...(typeof record.agentId === 'string' ? { agentId: record.agentId } : {}),
      }
    }
    case 'command.run':
      return runModCommandApi(mod, input, signal, frame)
    case 'ui.close':
      if (!isRecord(input) || typeof input.id !== 'string') throw new Error('ui.close takes { id }')
      return closeModPane(mod.plugin.name, input.id, 'plugin', signal, {
        origin: { plugin: mod.plugin.name, tier: mod.tier },
        ...(frame ? { skip: { runtime: frame.runtime, hook: frame.hook } } : {}),
      })
    case 'ui.ask':
      return askFromMod(mod, args, signal)
    case 'ui.focus': {
      if (!isRecord(input) || typeof input.requestId !== 'string' || typeof input.key !== 'string' || !input.key)
        throw new Error('ui.focus takes { requestId, key }')
      const site = input.requestId === 'AbovePrompt' ? 'AbovePrompt' : `Pane:${mod.plugin.name}:${input.requestId}`
      // The keyboard is the person's to give: only a site holding it moves.
      const held = getFocusedModPane()
      const holds = site === 'AbovePrompt' ? isModBandFocused()
        : held?.plugin === mod.plugin.name && `Pane:${held.plugin}:${held.id}` === site
      if (!holds) return { deny: 'that site does not hold the keyboard' }
      if (getModSite(site)?.owners?.get(input.key) !== mod.plugin.name && site === 'AbovePrompt')
        return { deny: `no element "${input.key}" of this plugin is drawn there` }
      return moveModRing(site, { element: input.key }, { kind: 'plugin', name: mod.plugin.name }, signal,
        frame ? { skip: { runtime: frame.runtime, hook: frame.hook } } : {})
    }
    case 'ui.scroll':
      return scrollFromMod(mod, input, signal, frame)
  }
  throw new Error(`Tau does not yet support mod API $.${method}`)
}

/**
 * `$.ui.ask`: the question in the engine's own AskUserQuestion dialog, through
 * its tool.call hooks, answering the label the person chose (or what they
 * typed). Rejects when dismissed, with nobody to ask, or when a bypass mode
 * answered in the person's place, so a guard falls back to its safe answer.
 */
async function askFromMod(mod: ActiveMod, args: any[], signal: AbortSignal): Promise<string> {
  const [question, choices] = args
  if (typeof question !== 'string' || !question.trim()) throw new Error('ui.ask needs a question')
  const options = Array.isArray(choices) ? { options: choices } : isRecord(choices) ? choices : {}
  const labels = options.options
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > 4 || labels.some(label => typeof label !== 'string' || !label.trim()))
    throw new Error('ui.ask takes two to four option labels')
  if (!getIsInteractive()) throw new Error('ui.ask has nobody to ask in this session')
  const header = typeof options.header === 'string' && options.header ? options.header : mod.plugin.name
  const { runModToolAPI } = await import('./toolApi.js')
  const ran = (await inSessionToolContext(() => runModToolAPI('tool.call', {
    tool: 'AskUserQuestion',
    questions: [{
      question,
      header: header.slice(0, 12),
      options: labels.map((label: string) => ({ label, description: label })),
      multiSelect: options.multiSelect === true,
    }],
  }, signal, mod.plugin.name))) as ModRecord
  const record = isRecord(ran.result) ? ran.result : {}
  if (ran.deny !== undefined || ran.isError) throw new Error('ui.ask was dismissed')
  if (Array.isArray(record.autoAnsweredQuestions) && record.autoAnsweredQuestions.length)
    throw new Error('ui.ask was answered by a permission mode, not the person')
  const answer = isRecord(record.answers) ? record.answers[question] : undefined
  if (typeof answer !== 'string' || !answer) throw new Error('ui.ask was dismissed')
  return answer
}

/**
 * `$.command.run`: a slash command as if the person typed it, once the
 * session is idle. A mod's command answers through the `command.run` hooks
 * (every hook but the calling one); any other is queued as typed input.
 */
async function runModCommandApi(mod: ActiveMod, input: unknown, signal: AbortSignal, frame?: ModCallFrame) {
  if (!isRecord(input) || typeof input.command !== 'string' || !input.command.trim())
    throw new Error('command.run takes { command, args }')
  if (input.args !== undefined && typeof input.args !== 'string')
    throw new Error('command.run args must be a string')
  const name = input.command.trim().replace(/^\//, '')
  const args = input.args ?? ''
  const { getModMainTurn, isModSessionStopped, runWhenModTurnIdle } = await import('./sessionState.js')
  // Waiting for an idle session inside a hook the running turn waits on
  // would never end.
  if (frame && getModMainTurn())
    throw new Error('command.run cannot wait for the session to be idle inside a hook the running turn waits on')
  if (isModSessionStopped()) throw new Error(`/${name} was not run: the session was stopped and nobody has sent input since`)
  await new Promise<void>(done => runWhenModTurnIdle(done))
  signal.throwIfAborted()
  const owner = active.find(item => item.commands.has(name) && allowed(item.plugin))
  if (owner) {
    const result = (await inSessionToolContext(() => dispatchModEvent(
      'command.run',
      {
        command: name,
        args,
        origin: { kind: 'plugin', name: mod.plugin.name },
        presentation: { isFullscreen: isFullscreenActive(), columns: process.stdout.columns || 80 },
      },
      async () => ({ text: `No mod handled /${name}.` }),
      signal,
      {
        origin: { plugin: mod.plugin.name, tier: mod.tier },
        ...(frame ? { skip: { runtime: frame.runtime, hook: frame.hook } } : {}),
      },
    ))) as ModRecord
    return {
      ...(typeof result.text === 'string' ? { text: result.text } : {}),
      ...(Array.isArray(result.context) ? { context: result.context } : {}),
    }
  }
  const { getCommands } = await import('../../../commands.js')
  const command = (await getCommands(getOriginalCwd()))
    .find(item => item.name === name || item.aliases?.includes(name))
  if (!command) throw new Error(`Unknown command /${name}`)
  const { enqueue } = await import('../../messageQueueManager.js')
  enqueue({ value: `/${command.name}${args ? ' ' + args : ''}`, mode: 'prompt', priority: 'next' })
  return {}
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
            // The transcript shows a command's input row with its output, after
            // the run: the lines it logs lead that output rather than land above.
            const logs: string[] = []
            let collecting = true
            const run = withModToolContext(
              {
                toolUseContext: context,
                canUseTool: context.canUseTool ?? hasPermissionsToUseTool,
                assistantMessage: assistant,
                // A line that arrives once the output is built is a row of its own.
                log: line => (collecting ? logs.push(line) : emitModLog(line)),
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
            )
            let result: ModRecord
            try {
              result = (await run) as ModRecord
            } catch (error) {
              // A failed run has no output for its lines to lead: they are rows.
              collecting = false
              for (const line of logs.splice(0)) emitModLog(line)
              throw error
            }
            collecting = false
            const text = [
              ...takeModLogs(),
              ...logs,
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

/**
 * `plugin.register`: a hooks module about to join, judged by the modules
 * admitted before it. Answers who refused it and why, or undefined.
 */
async function judgeModule(
  judges: readonly ActiveMod[],
  plugin: LoadedPlugin,
  tier: Exclude<ModTier, 'core'>,
  compiled: CompiledMod,
): Promise<{ by: string; reason: string } | undefined> {
  if (!judges.some(mod => allowed(mod.plugin) && mod.runtime.hooks.some(hook => modHookSelects(hook, 'plugin.register'))))
    return undefined
  const uses: ModRecord = { events: [...compiled.events], calls: [...new Set(compiled.calls)].sort() }
  if (compiled.env) uses.env = { reads: [...compiled.env.reads], writes: [...compiled.env.writes] }
  if (compiled.state) uses.state = { reads: compiled.state.reads.map(name => ({ ...name })), writes: compiled.state.writes.map(name => ({ ...name })) }
  const collect: ModTraceEntry[] = []
  const verdict = (await dispatchModSnapshot(judges, 'plugin.register', {
    name: plugin.name,
    tier,
    root: plugin.path,
    ...(typeof plugin.manifest.version === 'string' ? { version: plugin.manifest.version } : {}),
    provenance: plugin.source,
    uses,
  }, async () => ({ allow: true }), undefined, { collect })) as ModRecord
  if (typeof verdict.refuse !== 'string') return undefined
  // The innermost link that answered a refusal is the one that refused.
  const by = collect
    .filter(entry => entry.plugin !== 'engine' && typeof (entry.returned as ModRecord | undefined)?.refuse === 'string')
    .sort((a, b) => b.index - a.index)[0]?.plugin ?? 'a mod'
  return { by, reason: verdict.refuse }
}

/** Claude Code's nouns Tau serves, as the core of the engine.create fold. */
function coreEngineTable(): Record<string, { kind: 'core' }> {
  const nouns = new Set(['plugin', ...[...MOD_METHODS].map(method => method.split('.')[0]!)])
  return Object.fromEntries([...nouns].sort().map(noun => [noun, { kind: 'core' as const }]))
}

/**
 * `engine.create`: the fold that builds `$`, core innermost. Steps add
 * nouns (their methods run in their module) and org mods may withhold one; a
 * step that fails unloads its module, and so does a module calling a noun no
 * module added. Every module's `$` then carries the result.
 */
async function buildEngine(mods: ActiveMod[]): Promise<void> {
  const core = coreEngineTable()
  for (let round = 0; round <= mods.length; round++) {
    const collect: ModTraceEntry[] = []
    const failed = new Set<ActiveMod>()
    const folding = mods.some(mod => mod.runtime.hooks.some(hook => modHookSelects(hook, 'engine.create')))
    const built = folding
      ? (await dispatchModSnapshot(mods, 'engine.create', { plugins: mods.map(mod => mod.plugin.name) },
          async () => core, undefined, { collect })) as Record<string, ModRecord>
      : core
    for (const entry of collect)
      if (entry.plugin !== 'engine' && entry.outcome !== 'returned' && entry.outcome !== 'caught' && entry.outcome !== 'passed') {
        const mod = mods.find(item => item.plugin.name === entry.plugin)
        if (mod) failed.add(mod)
      }
    // Who withheld each core noun missing from the result: walking up from
    // the engine, the first step whose answer lacks a noun its beneath had.
    const table: Record<string, ModRecord> = { ...built }
    const withheld: Record<string, string> = {}
    let beneath: Record<string, ModRecord> = core
    for (const entry of [...collect].filter(item => item.plugin !== 'engine' && (item.outcome === 'returned' || item.outcome === 'caught'))
      .sort((a, b) => b.index - a.index)) {
      const answer = (entry.returned ?? {}) as Record<string, ModRecord>
      for (const noun of Object.keys(beneath)) {
        if (Object.hasOwn(answer, noun) || withheld[noun] || !Object.hasOwn(core, noun)) continue
        if (entry.tier === 'user') {
          warn(`${entry.plugin}: engine.create: a mod a person installs may not withhold $.${noun}; it stays`)
          table[noun] = core[noun]!
        } else if (!Object.hasOwn(table, noun)) withheld[noun] = entry.plugin
      }
      beneath = answer
    }
    const lent: Record<string, Record<string, string>> = {}
    for (const [noun, entry] of Object.entries(table))
      if (entry?.kind === 'lent' && entry.methods && typeof entry.methods === 'object') lent[noun] = entry.methods as Record<string, string>
    // A module calling a noun nobody added cannot run.
    for (const mod of mods)
      for (const call of mod.calls) {
        const [noun, name] = call.split('.') as [string, string]
        if (CORE_NOUNS.has(noun) || lent[noun]?.[name]) continue
        warn(`${mod.plugin.name}: mod did not load: it calls $.${call}, which no loaded mod adds to $`)
        failed.add(mod)
        break
      }
    if (!failed.size) {
      if (Object.keys(lent).length || Object.keys(withheld).length)
        for (const mod of mods) mod.runtime.setEngine({ lent, withheld })
      return
    }
    for (const mod of failed) {
      warn(`${mod.plugin.name}: unloaded; $ is built again without it`)
      mods.splice(mods.indexOf(mod), 1)
    }
    await Promise.allSettled([...failed].map(mod => mod.runtime.dispose()))
  }
}

/** prependPlugins and appendPlugins: managed settings set them; a person's
 * own settings only where no managed settings exist and the login is not a
 * Team or Enterprise one. */
async function readTierLists(): Promise<{ prepend: string[]; append: string[]; managed: boolean }> {
  const policy = getSettingsForSource('policySettings') as ModRecord | null | undefined
  const managed = !!policy && Object.keys(policy).length > 0
  const list = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  if (managed) return { prepend: list(policy!.prependPlugins), append: list(policy!.appendPlugins), managed }
  const { getSubscriptionType } = await import('../../auth.js')
  const subscription = getSubscriptionType()
  if (subscription === 'team' || subscription === 'enterprise') return { prepend: [], append: [], managed }
  const user = getSettingsForSource('userSettings') as ModRecord | null | undefined
  return { prepend: list(user?.prependPlugins), append: list(user?.appendPlugins), managed }
}

/** An organization's mod: managed settings enable it, and it loads in place
 * from a directory marketplace the managed settings name by absolute path. */
function isOrganizationMod(plugin: LoadedPlugin): boolean {
  const policy = getSettingsForSource('policySettings') as ModRecord | null | undefined
  if (policy?.enabledPlugins?.[plugin.source] !== true) return false
  const marketplace = plugin.source.slice(plugin.source.lastIndexOf('@') + 1)
  const declared = policy?.extraKnownMarketplaces?.[marketplace]?.source
  if (!declared || declared.source !== 'directory' || typeof declared.path !== 'string' || !isAbsolute(declared.path)) return false
  const inside = relative(resolvePath(declared.path), resolvePath(plugin.path))
  return !!inside && !inside.startsWith('..') && !isAbsolute(inside)
}

/**
 * Each mod's tier and the chain's order: the organization's mods first (the
 * ones prependPlugins lists, in its order, then the rest of them), everything
 * a person installs (a mod before its dependencies), then the ones
 * appendPlugins lists. Claude Code's built-in guard has no Tau counterpart.
 */
export async function seatPluginMods(plugins: LoadedPlugin[]): Promise<Array<{ plugin: LoadedPlugin; tier: Exclude<ModTier, 'core'> }>> {
  const lists = await readTierLists()
  const eligible = (plugin: LoadedPlugin) => (lists.managed ? isOrganizationMod(plugin) : true)
  for (const [name, ids] of [['prependPlugins', lists.prepend], ['appendPlugins', lists.append]] as const)
    for (const id of ids) {
      if (id === 'sec-default@builtin') continue
      const plugin = plugins.find(item => item.source === id)
      if (!plugin || !eligible(plugin))
        logForDebugging(`${name} names ${id}, which is not an enabled managed plugin with a hooks module; skipped`)
    }
  const tierOf = (plugin: LoadedPlugin): Exclude<ModTier, 'core'> =>
    lists.append.includes(plugin.source) && eligible(plugin) ? 'append'
      : lists.prepend.includes(plugin.source) && eligible(plugin) ? 'prepend'
        : lists.managed && isOrganizationMod(plugin) ? 'prepend' : 'user'
  const ordered = orderPluginMods(plugins)
  const rank = (ids: string[]) => (plugin: LoadedPlugin) => {
    const at = ids.indexOf(plugin.source)
    return at < 0 ? Number.MAX_SAFE_INTEGER : at
  }
  const seat = (tier: Exclude<ModTier, 'core'>, ids: string[]) => {
    const at = rank(ids)
    return ordered.filter(plugin => tierOf(plugin) === tier)
      .map((plugin, position) => ({ plugin, position }))
      .sort((a, b) => at(a.plugin) - at(b.plugin) || a.position - b.position)
      .map(({ plugin }) => ({ plugin, tier }))
  }
  return [...seat('prepend', lists.prepend), ...seat('user', []), ...seat('append', lists.append)]
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

/**
 * Unloads modules: their workers, the agent types they registered, and what
 * they drew. A plugin in `kept` was reloaded: its panes and status line are
 * the engine's record and stay up for the new module to draw.
 */
async function disposeMods(mods: readonly ActiveMod[], kept: ReadonlySet<string> = new Set()): Promise<void> {
  if (!mods.length) return
  const { forgetModAgents } = await import('./actionsApi.js')
  for (const mod of mods) {
    forgetModAgents(mod.runtime)
    if (!kept.has(mod.plugin.name)) forgetModUi(mod.plugin.name)
  }
  await Promise.allSettled(mods.map((mod) => mod.runtime.dispose()))
  // Controls drawn by a disposed module no longer answer; redraw them.
  invalidateModSite()
}

export async function stopPluginMods(): Promise<void> {
  const previous = active
  active = []
  disposeModClients()
  await publishModToolRegistries([])
  await disposeMods(previous)
}

/** Called at session start or explicit reload, never by catalog discovery. */
export async function startPluginMods(reload = false, startupSessionId?: string): Promise<void> {
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
    // The org's prepended mods, then a person's (a dependent wraps its
    // dependencies), then the appended ones: the public middleware order.
    const seated = await seatPluginMods(candidates)
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
    for (const { plugin, tier } of seated) {
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
          const refusal = await judgeModule(next, plugin, tier, compiled)
          if (refusal) {
            warn(`${plugin.name}: hooks module refused by ${refusal.by}: ${refusal.reason}`)
            errors.push({
              type: 'hook-load-failed',
              source: plugin.source,
              plugin: plugin.name,
              hookPath: entry,
              reason: `refused by ${refusal.by}: ${refusal.reason}`,
            })
            continue
          }
          runtime = new ModRuntime(
            { name: plugin.name, root: plugin.path },
            compiled,
            options,
          )
          await runtime.initialize()
          // A mod a person installs sees the operator's collector records
          // alone: its telemetry hooks name that stream, or never run.
          if (tier === 'user')
            for (const hook of runtime.hooks) {
              const refusal = modTelemetryHookRefusal(hook)
              if (!refusal) continue
              hook.off = refusal
              warn(`${plugin.name}: ${hook.event} hook skipped: ${refusal}`)
            }
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
            tier,
            calls: compiled.calls,
            compiled,
            commands,
            tools,
            host: createModHost({
              id: plugin.source,
              name: plugin.name,
              startupSessionId,
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
              log: routeModLog,
            }),
            snapshot: next,
          }
          // Calls made outside any hook (timer callbacks, work a hook left
          // running) carry no tool or command context of their own.
          runtime.setBackgroundHost((method, args, signal) =>
            exitModToolContext(() => {
              if (!allowed(mod.plugin) || (!active.includes(mod) && !loading))
                throw new Error('The mod is no longer active')
              return callModApi(mod.snapshot, mod, method, args, signal)
            }),
          )
          next.push(mod)
          logForDebugging(`hooks module ${plugin.source} loaded, tier ${tier}`)
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
    await buildEngine(next)
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
      await disposeMods(previous, new Set(next.map(mod => mod.plugin.name)))
    } catch (error) {
      await disposeMods(next, new Set(active.map(mod => mod.plugin.name)))
      throw error
    }
    active = next
    // A site drawn while session.start ran (a pane it opened, the band) was
    // drawn by the snapshot before this one; draw it with this one.
    invalidateModSite()
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
    // The session's named values end with it; a reload of mods keeps them.
    resetModState()
  }
}
