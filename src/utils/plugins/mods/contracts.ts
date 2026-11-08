type ModRecord = Record<string, any>

/**
 * A call on `$` that the host serves, as the event hooks above the caller see
 * it (upstream OpEventOf): `e` is the call's argument object, and a hook may
 * pass it on, rewrite it, refuse it with `{ deny }` or answer `{ value }`.
 */
export type ModOpCodec = {
  /** The positional `$` arguments as the event's argument object. */
  event(args: readonly unknown[]): ModRecord
  /** The event as the chain left it, as the host call's positional arguments. */
  args(event: ModRecord): unknown[]
  /** Fields naming what the call acts on; a hook above may not rewrite them. */
  pinned?: readonly string[]
}

const string = (value: unknown, message: string): string => {
  if (typeof value !== 'string') throw new Error(message)
  return value
}
const options = (value: unknown): ModRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ModRecord)
    : {}
const noArgs: ModOpCodec = { event: () => ({}), args: () => [] }
const optionalObject = (method: string): ModOpCodec => ({
  event(args) {
    const [value] = args
    if (
      args.length > 1 ||
      (value !== undefined &&
        (!value || typeof value !== 'object' || Array.isArray(value)))
    )
      throw new Error(`${method} takes an optional argument object`)
    return (value as ModRecord | undefined) ?? {}
  },
  args: event => [event],
})
const path = (value: unknown) =>
  string(value, 'Expected a filesystem path')
const key = (value: unknown) => string(value, 'Store key must be a string')

const MAX_STATE_FIELD = 1_024
/** A `$.state` reference as a call gave it, checked: `{ plugin, key }`, with
 * `id` for a family member. An atom passed in its place reads as its `ref`. */
export function modStateAddress(ref: unknown, method: string): { plugin: string; key: string; id?: string } {
  const record = ref && typeof ref === 'object' && !Array.isArray(ref) ? (ref as ModRecord) : undefined
  const source = record && record.ref && typeof record.ref === 'object' && 'initial' in record ? (record.ref as ModRecord) : record
  if (!source || typeof source.plugin !== 'string' || !source.plugin || typeof source.key !== 'string' || !source.key)
    throw new Error(`${method} takes a reference { plugin, key }`)
  if (source.id !== undefined && typeof source.id !== 'string')
    throw new Error(`${method}: a family member's id is a string`)
  for (const field of [source.plugin, source.key, source.id ?? ''])
    if (field.length > MAX_STATE_FIELD)
      throw new Error(`${method}: a reference field is at most ${MAX_STATE_FIELD} characters`)
  return { plugin: source.plugin, key: source.key, ...(source.id === undefined ? {} : { id: source.id }) }
}

/** The Claude Code release whose mods contract Tau implements: what
 * `$.session.version()` answers, so a mod that gates on "2.1.290 or later"
 * finds what Tau serves. Raise it with the contract Tau follows. */
export const MOD_API_VERSION = '2.1.319'

/** MCP calls cross through mcpApi.ts, which owns their argument checks. */
export const MOD_MCP_EVENTS = new Set(['mcp.call', 'mcp.connect'])

export const MOD_OP_CODECS: Readonly<Record<string, ModOpCodec>> = {
  'session.cwd': noArgs,
  'session.root': noArgs,
  'session.id': noArgs,
  'session.version': noArgs,
  'session.surfaces': noArgs,
  'session.surface': noArgs,
  'session.model': optionalObject('session.model'),
  'session.turns': optionalObject('session.turns'),
  'session.messages': optionalObject('session.messages'),
  'turn.abort': optionalObject('turn.abort'),
  'command.list': noArgs,
  'command.register': {
    event: ([spec]) => options(spec),
    args: event => [event],
  },
  'tool.list': noArgs,
  'tool.register': {
    event: ([spec]) => options(spec),
    args: event => [event],
  },
  'fs.read': {
    event: ([file, read]) => ({ path: path(file), as: options(read).as ?? 'text' }),
    args: event => [event.path, { as: event.as }],
  },
  'fs.write': {
    event: ([file, text]) => ({ path: path(file), text }),
    args: event => [event.path, event.text],
  },
  'fs.list': {
    event: ([file]) => ({ path: file === undefined ? '.' : path(file) }),
    args: event => [event.path],
  },
  'fs.exists': {
    event: ([file]) => ({ path: path(file) }),
    args: event => [event.path],
  },
  'fs.stat': {
    event: ([file, stat]) => ({ path: path(file), resolve: options(stat).resolve === true }),
    args: event => [event.path, { resolve: event.resolve }],
  },
  'store.get': { event: ([name]) => ({ key: key(name) }), args: event => [event.key] },
  'store.set': {
    event: ([name, value]) => ({ key: key(name), value }),
    args: event => [event.key, event.value],
  },
  'store.delete': { event: ([name]) => ({ key: key(name) }), args: event => [event.key] },
  'store.keys': noArgs,
  // Named values for the session. The reference is identity, pinned; a hook
  // above rewrites the value a write stores. `previous` is the host's.
  'state.get': {
    event: ([ref]) => modStateAddress(ref, 'state.get'),
    args: event => [event],
    pinned: ['plugin', 'key', 'id'],
  },
  'state.set': {
    event: ([ref, value, set]) => ({
      ...modStateAddress(ref, 'state.set'),
      value,
      ...(options(set).ifVersion === undefined ? {} : { ifVersion: options(set).ifVersion }),
    }),
    args: event => [event],
    pinned: ['plugin', 'key', 'id', 'previous'],
  },
  'clock.now': noArgs,
  'clock.sleep': { event: ([ms]) => ({ ms }), args: event => [event.ms] },
  // One dispatch per wait; the plugin's callback runs only when it resolves.
  'clock.after': { event: ([ms]) => ({ ms }), args: event => [event.ms] },
  'clock.every': { event: ([ms]) => ({ ms }), args: event => [event.ms] },
  'settings.read': optionalObject('settings.read'),
  'env.get': {
    event: ([name]) => ({ name: string(name, 'env.get requires a variable name') }),
    args: event => [event.name],
    pinned: ['name'],
  },
  'env.set': {
    event: ([name, value]) => ({
      name: string(name, 'env.set requires a variable name'),
      ...(value === undefined ? {} : { value }),
    }),
    args: event => [event.name, event.value],
    pinned: ['name'],
  },
  'ui.log': {
    event: ([text, log]) => ({
      text: string(text, 'ui.log requires text'),
      to: options(log).to ?? 'transcript',
    }),
    args: event => [event.text, { to: event.to }],
  },
  'process.run': {
    event: ([argv, init]) => (init === undefined ? { argv } : { argv, init }),
    args: event => (event.init === undefined ? [event.argv] : [event.argv, event.init]),
  },
  // A guard above sees the command before it starts; its output streams to
  // the caller alone.
  'process.spawn': {
    event: ([argv, init]) => (init === undefined ? { argv } : { argv, init }),
    args: event => (event.init === undefined ? [event.argv] : [event.argv, event.init]),
  },
  'session.repo': noArgs,
  'session.usage': optionalObject('session.usage'),
  'session.authorize': noArgs,
  'session.identity': noArgs,
  'prompt.read': noArgs,
  'agent.list': noArgs,
  'agent.register': { event: ([spec]) => options(spec), args: event => [event], pinned: ['name'] },
  'fs.ancestors': { event: ([request]) => options(request), args: event => [event] },
  'http.fetch': {
    event: ([url, init]) => ({ url: string(url, 'http.fetch requires a URL'), ...(init === undefined ? {} : { init }) }),
    args: event => [event.url, event.init],
  },
  'model.complete': { event: ([request]) => options(request), args: event => [event] },
  'model.fork': { event: ([request]) => options(request), args: event => [event] },
  'model.classify': {
    event: ([text, labels, settings]) => ({ text, labels, ...(settings === undefined ? {} : { options: settings }) }),
    args: event => [event],
  },
  'ui.toast': {
    event: ([text, toast]) => ({
      text: string(text, 'ui.toast requires text'),
      ...(options(toast).timeoutMs === undefined ? {} : { timeoutMs: options(toast).timeoutMs }),
    }),
    args: event => [event],
  },
  // `text` undefined clears the line.
  'ui.status': { event: ([text]) => (text === undefined ? {} : { text }), args: event => [event] },
  'ui.notify': {
    event: ([text, notify]) => ({
      text: string(text, 'ui.notify requires text'),
      ...(options(notify).title === undefined ? {} : { title: options(notify).title }),
    }),
    args: event => [event],
  },
  // A hook above may retitle or refuse a pane, never rename it.
  'ui.open': { event: ([pane]) => options(pane), args: event => [event], pinned: ['id'] },
  'ui.panes': noArgs,
  'ui.invalidate': { event: ([name]) => ({ event: name }), args: event => [event] },
  // Text for a clipboard, on a surface the session draws on (the caller's pick).
  'ui.copy': {
    event: ([copy]) => {
      const { text, surface } = options(copy)
      return { text: string(text, 'ui.copy requires { text }'), ...(surface === undefined ? {} : { surface }) }
    },
    args: event => [event],
  },
  'ui.selection': noArgs,
  // A mounted Raster repainted (or an Image's source swapped), by site and key.
  'ui.blit': { event: ([blit]) => options(blit), args: event => [event], pinned: ['requestId', 'key'] },
  // A line under the open dialog of a tool call; no text takes it away.
  'ui.notice': {
    event: ([id, text]) => ({
      tool_use_id: string(id, 'ui.notice requires the tool_use_id of an open call'),
      ...(text === undefined ? {} : { text: string(text, 'ui.notice text must be a string or undefined') }),
    }),
    args: event => [event.tool_use_id, event.text],
    pinned: ['tool_use_id'],
  },
  // A clip and how to play it; the signal that stops it stays with the caller.
  'audio.play': {
    event: ([clip, play]) => {
      const settings = options(play)
      return { clip, shouldLoop: settings.shouldLoop === true, ...(settings.gain === undefined ? {} : { gain: settings.gain }) }
    },
    args: event => [event.clip, { shouldLoop: event.shouldLoop, ...(event.gain === undefined ? {} : { gain: event.gain }) }],
  },
  'audio.speak': {
    event: ([text, speak]) => ({
      text: string(text, 'audio.speak requires text'),
      ...(options(speak).voice === undefined ? {} : { voice: options(speak).voice }),
    }),
    args: event => [event],
  },
  // A usage record: raised for the mods above; Tau sends none of a mod's.
  // `to` is where it goes, pinned, `anthropic` when left out.
  'telemetry.log': {
    event: ([entry]) => {
      const record = options(entry)
      const to = record.to ?? 'anthropic'
      if (to !== 'anthropic' && to !== 'collector')
        throw new Error("telemetry.log to is 'anthropic' or 'collector'")
      string(record.event, "telemetry.log requires the record's event name")
      return { ...record, to }
    },
    args: event => [event],
    pinned: ['to'],
  },
  // A mark always means anthropic: it takes no `to`.
  'telemetry.mark': {
    event: ([entry]) => {
      const mark = options(entry)
      string(mark.feature, 'telemetry.mark requires the feature it marks')
      if (!['ok', 'sad', 'bad'].includes(mark.kind))
        throw new Error("telemetry.mark kind is 'ok', 'sad' or 'bad'")
      if (mark.reason !== undefined) string(mark.reason, 'telemetry.mark reason is a short token')
      if (mark.to !== undefined) throw new Error('telemetry.mark takes no to: a mark always means anthropic')
      return mark
    },
    args: event => [event],
  },
}

/** Interface events: a site about to be drawn, and the controls a mod drew
 * being used. `ui.close` fires for every pane that closes. */
export const MOD_UI_EVENTS = ['ui.render', 'ui.press', 'ui.input', 'ui.select', 'ui.close', 'ui.focus', 'ui.scroll', 'ui.message', 'ui.fault']

/** Calls on `$` that are not events of their own here: each acts through an
 * engine event (`prompt.submit`, `command.run`, `tool.call` of SendMessage or
 * Agent) or edits what the person sees, and the hooks see that instead. */
export const MOD_PLAIN_METHODS = new Set([
  'session.append', 'session.send', 'prompt.fill', 'prompt.suggest',
  'command.run', 'agent.spawn', 'ui.close', 'ui.ask',
  // The ring and the window move through ui.focus / ui.scroll, as a person's
  // Tab or scroll keys move them.
  'ui.focus', 'ui.scroll',
])

/** `$` calls that answer at once, nothing to await: their failures go to the
 * debug log. `ui.resolve` reads the element table in the module itself. */
export const MOD_SYNC_METHODS = new Set(['ui.log', 'ui.toast', 'ui.status', 'ui.invalidate', 'ui.notice'])

/** Calls on `$` that are events, hookable by name; hooks above the caller run. */
export const MOD_API_EVENTS = new Set([
  ...Object.keys(MOD_OP_CODECS),
  ...MOD_MCP_EVENTS,
])

/** Engine call sites; `$.prompt.submit`, `$.tool.call`, `$.tool.check` and
 * `$.session.compact` raise the same events through every hook but the caller. */
const ENGINE_EVENTS = [
  'session.start',
  'session.end',
  'session.compact',
  'command.run',
  'prompt.submit',
  'skill.prompt',
  'turn.start',
  // One model request of a turn, its response streaming through the hooks.
  'turn.step',
  'turn.complete',
  'tool.call',
  'tool.check',
  'agent.spawn',
  // Other mods: one about to join the chain, and the fold that builds `$`.
  'plugin.register',
  'engine.create',
  // A system prompt rendered: its sections, each { id, text, scope }.
  'prompt.compose',
]

/** Every settings hook event Tau raises to mods as `classic.<Event>`; `e` is
 * the hook's stdin JSON (PreToolUse: the tool call's envelope). */
export const CLASSIC_HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionDenied', 'PermissionRequest', 'Notification', 'UserPromptSubmit',
  'UserPromptExpansion', 'SessionStart', 'SessionEnd', 'Setup', 'Stop',
  'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  'PreModelSwitch', 'PostModelSwitch', 'TeammateIdle', 'TaskCreated',
  'TaskCompleted', 'ConfigChange', 'InstructionsLoaded', 'CwdChanged',
  'FileChanged', 'DirectoryAdded', 'Elicitation', 'ElicitationResult',
  'WorktreeCreate', 'WorktreeRemove', 'MessageDisplay',
] as const

export const MOD_EVENTS = new Set([
  ...MOD_API_EVENTS,
  ...ENGINE_EVENTS,
  ...MOD_UI_EVENTS,
  ...CLASSIC_HOOK_EVENTS.map((event) => `classic.${event}`),
])

/** Claude Code's own nouns on `$`: a call to one of their methods Tau does
 * not serve refuses the module; a noun outside them is one a mod may add at
 * `engine.create`, checked once the fold has built `$`. */
export const CORE_NOUNS = new Set([
  'agent', 'attribution', 'audio', 'clock', 'command', 'config', 'env', 'fs',
  'http', 'mcp', 'model', 'plugin', 'process', 'prompt', 'session', 'settings',
  'skill', 'state', 'store', 'telemetry', 'theme', 'tool', 'turn', 'ui',
])

export const MOD_METHODS = new Set([
  ...MOD_API_EVENTS,
  ...MOD_PLAIN_METHODS,
  'ui.resolve',
  'session.compact',
  'prompt.submit',
  'prompt.compose',
  'tool.call',
  'tool.check',
])

/** Every namespace Claude Code's events live under. A glob over one that Tau
 * does not raise yet selects nothing rather than failing the module. */
const NAMESPACES = new Set([
  'agent', 'attribution', 'audio', 'classic', 'clock', 'command', 'config',
  'engine', 'env', 'fs', 'http', 'mcp', 'model', 'plugin', 'process', 'prompt',
  'session', 'settings', 'skill', 'state', 'store', 'telemetry', 'tool',
  'turn', 'ui',
])

const isGlob = (pattern: string) =>
  pattern === '*' ||
  (pattern.endsWith('.*') && NAMESPACES.has(pattern.slice(0, -2)))

/**
 * Why `on()` refuses a pattern, or undefined when it accepts it: a supported
 * event, every event (`*`), a namespace (`tool.*`), or all but some (`!tool.*`).
 */
export function modEventPatternError(pattern: string): string | undefined {
  if (MOD_EVENTS.has(pattern) || isGlob(pattern)) return undefined
  if (pattern.startsWith('!')) {
    const negated = pattern.slice(1)
    const [namespace, name, ...rest] = negated.split('.')
    if (
      negated !== '*' &&
      (isGlob(negated) ||
        (NAMESPACES.has(namespace!) && !!name && /^\w+$/.test(name) && !rest.length))
    )
      return undefined
    return `Invalid mod event pattern "${pattern}"`
  }
  return `Tau does not yet support mod event "${pattern}"`
}

/** Events a glob or negation never selects, only their own name: hooking
 * MessageDisplay switches every reply to line-by-line streaming, which an
 * observer of everything must not cause. */
const NAMED_ONLY = new Set(['classic.MessageDisplay'])

/** Whether one hook takes part in an event: its pattern selects it, and the
 * host has not switched the hook off (`off` says why). */
export function modHookSelects(hook: { event: string; off?: string }, event: string): boolean {
  return !hook.off && modPatternSelects(hook.event, event)
}

/** Why a telemetry hook of a mod a person installs does not run: it needs
 * the filter `{ to: 'collector' }`, the stream such a mod may see. */
export function modTelemetryHookRefusal(hook: { event: string; matcher?: unknown }): string | undefined {
  const telemetry = hook.event === 'telemetry.log' || hook.event === 'telemetry.mark' || hook.event === 'telemetry.*'
  if (!telemetry) return undefined
  const matcher = hook.matcher as Record<string, unknown> | undefined
  if (hook.event !== 'telemetry.mark' && matcher && typeof matcher === 'object' && matcher.to === 'collector') return undefined
  return "in a mod a person installs, a telemetry hook takes the filter { to: 'collector' }, as in on('telemetry.log', { to: 'collector' }, hook)"
}

/** Whether a registered pattern selects one event Tau raises. `*` leaves out
 * the telemetry events, which take their own name and a collector filter. */
export function modPatternSelects(pattern: string, event: string): boolean {
  if (pattern === event) return true
  if (NAMED_ONLY.has(event)) return false
  if (pattern === '*') return !event.startsWith('telemetry.')
  if (pattern.startsWith('!')) return !modPatternSelects(pattern.slice(1), event)
  return pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1))
}
