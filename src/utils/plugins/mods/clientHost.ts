import { logForDebugging } from '../../debug.js'
import { ModClientRealm } from './clientRealm.js'
import { invalidateModSite, normalizeModTree, validateModTree, type ModUiNode } from './uiState.js'

type Rec = Record<string, any>
export type ModClientSource = { digest: string; files: Record<string, { code: string; imports: Record<string, string> }>; clients: Record<string, string> }
/** How the host reaches the plugin's hooks for a Client's events. */
export type ModClientEvents = {
  source(plugin: string, module: string): ModClientSource | undefined
  message(plugin: string, input: Rec): Promise<Rec | undefined>
  fault(plugin: string, input: Rec): Promise<void>
}

const FRAME_MS = 16
const MAX_PROPS = 100_000

/** One `Client` drawn: where, which module, and what it drew or why not. */
export type ModClientInstance = {
  id: string
  plugin: string
  site: string
  key: string
  module: string
  version: number
  tree?: ModUiNode | null
  fault?: { phase: 'load' | 'render' | 'run'; reason: string }
  listens: { pointer: boolean; key: boolean }
  subscribe(listener: () => void): () => void
}

type Live = ModClientInstance & {
  realm?: ModClientRealm
  props?: string
  /** Props a ui.message hook answered, until the drawing hands new ones. */
  answered?: string
  drawnProps?: string
  columns: number
  rows: number
  timers: Map<number, ReturnType<typeof setInterval>>
  listeners: Set<() => void>
  redraw?: ReturnType<typeof setTimeout>
  post?: { data: string; timer: ReturnType<typeof setTimeout> }
  dirty: boolean
  input: boolean
  /** Born in the redraw a fault caused: another fault redraws nothing. */
  afterFault: boolean
  mounts: number
  disposed: boolean
}

let events: ModClientEvents | undefined
const realms = new Map<string, ModClientRealm>()
const live = new Map<string, Live>()
/** Sites a fault redrew, and the Client keys that faulted in them. */
const faultRedraws = new Map<string, Set<string>>()

/** The manager's side: compiled modules and the plugin's own hooks. */
export function setModClientEvents(next: ModClientEvents | undefined): void {
  events = next
  if (!next) {
    for (const instance of [...live.values()]) dispose(instance)
    realms.clear()
  }
}

/** The realm a plugin's current load runs its Client modules in. */
function realmOf(plugin: string, source: ModClientSource): ModClientRealm {
  const name = `${plugin}\0${source.digest}`
  let realm = realms.get(name)
  if (!realm) {
    for (const key of [...realms.keys()]) if (key.startsWith(`${plugin}\0`)) realms.delete(key)
    realm = new ModClientRealm(plugin, source.files, text => logForDebugging(`${plugin}: Client: ${text}`, { level: 'warn' }))
    realms.set(name, realm)
  }
  return realm
}

const oneLine = (text: unknown): string => {
  const flat = String(text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim() || 'the module failed without a message'
  return flat.length > 200 ? flat.slice(0, 199) + String.fromCharCode(0x2026) : flat
}
const siteParts = (site: string) => site.startsWith('Pane:')
  ? { component: 'Pane', requestId: site.slice(site.lastIndexOf(':') + 1) }
  : { component: site, requestId: site }

function notify(instance: Live): void {
  instance.version++
  for (const listener of [...instance.listeners]) listener()
}

/**
 * The instance drawn under `key` in `site` by `plugin`'s `module`: one kept
 * across the plugin's redraws while a Client under that key stays drawn.
 */
export function mountModClient(plugin: string, site: string, key: string, module: string): ModClientInstance {
  const id = `${plugin}\0${site}\0${key}\0${module}`
  const existing = live.get(id)
  if (existing) {
    existing.mounts++
    return existing
  }
  const instance: Live = {
    id, plugin, site, key, module, version: 0, listens: { pointer: false, key: false },
    columns: 0, rows: 0, timers: new Map(), listeners: new Set(), dirty: true, input: true, mounts: 1, disposed: false,
    afterFault: faultRedraws.get(site)?.has(key) ?? false,
    subscribe(listener) {
      instance.listeners.add(listener)
      return () => { instance.listeners.delete(listener) }
    },
  }
  live.set(id, instance)
  const source = events?.source(plugin, module)
  const entry = source?.clients[module]
  if (!source || !entry) {
    fail(instance, 'load', source ? `${module} is not one of the plugin's Client modules` : 'the plugin is not loaded')
    return instance
  }
  try {
    instance.realm = realmOf(plugin, source)
  } catch (error) {
    fail(instance, 'load', error instanceof Error ? error.message : String(error))
    return instance
  }
  const reply = instance.realm.call({ type: 'mount', id, entry })
  if (!reply.ok) fail(instance, 'load', reply.error)
  return instance
}

/** The drawing it no longer holds: one release per mount. */
export function releaseModClient(instance: ModClientInstance): void {
  const own = instance as Live
  if (--own.mounts > 0) return
  dispose(own)
}

function dispose(instance: Live): void {
  if (instance.disposed) return
  instance.disposed = true
  for (const timer of instance.timers.values()) clearInterval(timer)
  instance.timers.clear()
  clearTimeout(instance.redraw)
  if (instance.post) clearTimeout(instance.post.timer)
  instance.post = undefined
  if (live.get(instance.id) === instance) live.delete(instance.id)
  if (instance.realm && !instance.fault) instance.realm.call({ type: 'unmount', id: instance.id })
}

/**
 * The instance's tree for these props in a region this size, drawn again
 * only when either changed, its state moved, or input reached it.
 */
export function drawModClient(instance: ModClientInstance, props: unknown, columns: number, rows: number): { tree?: ModUiNode | null; fault?: ModClientInstance['fault'] } {
  const own = instance as Live
  if (own.fault || !own.realm) return { fault: own.fault }
  let json: string | undefined
  try {
    json = props === undefined ? undefined : JSON.stringify(props)
  } catch {
    json = undefined
  }
  if (json !== undefined && json.length > MAX_PROPS) {
    fail(own, 'render', `the Client's props are over ${MAX_PROPS} characters`)
    return { fault: own.fault }
  }
  // New props from the drawing replace those a ui.message hook answered.
  if (json !== own.drawnProps) {
    own.drawnProps = json
    own.answered = undefined
    own.dirty = true
    own.input = true
  }
  const shown = own.answered ?? json
  if (columns !== own.columns || rows !== own.rows) {
    own.columns = columns
    own.rows = rows
    own.dirty = true
    own.input = true
  }
  if (!own.dirty) return { tree: own.tree }
  own.dirty = false
  const reply = own.realm.call({ type: 'render', id: own.id, props: shown, columns, rows, input: own.input })
  own.input = false
  if (!reply.ok) {
    fail(own, 'render', reply.error)
    return { fault: own.fault }
  }
  try {
    const tree = reply.value?.tree
    validateModTree(tree, { client: true })
    own.tree = normalizeModTree(tree)
  } catch (error) {
    fail(own, 'render', error instanceof Error ? error.message : String(error))
    return { fault: own.fault }
  }
  effects(own, reply.effects)
  return { tree: own.tree }
}

/** A pointer event over the region, or a key while it holds the focus. */
export function inputModClient(instance: ModClientInstance, kind: 'pointer' | 'key', event: Rec): void {
  const own = instance as Live
  if (own.fault || !own.realm) return
  const reply = own.realm.call({ type: kind, id: own.id, event })
  if (!reply.ok) return fail(own, 'run', reply.error)
  own.input = true
  effects(own, reply.effects)
}

/** A Button, Input or Select inside the region, used: its handler runs there. */
export function pressModClient(instance: ModClientInstance, handler: number, args: unknown[]): void {
  const own = instance as Live
  if (own.fault || !own.realm) return
  const reply = own.realm.call({ type: 'handler', id: own.id, handler, args })
  if (!reply.ok) return fail(own, 'run', reply.error)
  own.input = true
  effects(own, reply.effects)
}

function effects(instance: Live, list: Rec[]): void {
  for (const effect of list) {
    if (instance.fault) return
    switch (effect.type) {
      case 'redraw':
        instance.dirty = true
        instance.redraw ??= setTimeout(() => { instance.redraw = undefined; notify(instance) }, FRAME_MS)
        break
      case 'every': {
        const timer = setInterval(() => {
          if (instance.fault || !instance.realm) return
          const reply = instance.realm.call({ type: 'timer', id: instance.id, timer: effect.id })
          if (!reply.ok) return fail(instance, 'run', reply.error)
          instance.input = true
          effects(instance, reply.effects)
        }, Math.max(FRAME_MS, Number(effect.ms) || FRAME_MS))
        timer.unref?.()
        instance.timers.set(Number(effect.id), timer)
        break
      }
      case 'clear': {
        clearInterval(instance.timers.get(Number(effect.id)))
        instance.timers.delete(Number(effect.id))
        break
      }
      case 'listen':
        instance.listens = { pointer: effect.pointer === true, key: effect.key === true }
        break
      case 'post': {
        // One per frame: a later post replaces one not yet delivered.
        if (instance.post) instance.post.data = String(effect.data)
        else {
          const post = { data: String(effect.data), timer: setTimeout(() => deliver(instance), FRAME_MS) }
          instance.post = post
        }
        break
      }
    }
  }
}

/** `ui.message`: the post, through the plugin's own hooks; `{ props }`
 * answered is the instance's next props. */
function deliver(instance: Live): void {
  const post = instance.post
  instance.post = undefined
  if (!post || !events || instance.fault) return
  let data: unknown
  try { data = JSON.parse(post.data) } catch { return }
  void events.message(instance.plugin, { surface: 'terminal', ...siteParts(instance.site), element: instance.key, module: instance.module, data })
    .then(result => {
      if (!result || result.props === undefined || instance.fault || !live.has(instance.id)) return
      let json: string | undefined
      try { json = JSON.stringify(result.props) } catch { json = undefined }
      if (json === undefined || json.length > MAX_PROPS) return
      instance.answered = json
      instance.dirty = true
      instance.input = true
      notify(instance)
    })
    .catch(error => logForDebugging(`${instance.plugin}: ui.message failed: ${String(error)}`, { level: 'warn' }))
}

/** The instance failed: it stops, draws its one dimmed line, and the
 * plugin's hooks hear `ui.fault`; then the site is drawn again, once. */
function fail(instance: Live, phase: 'load' | 'render' | 'run', reason: unknown): void {
  if (instance.fault) return
  instance.fault = { phase, reason: oneLine(reason) }
  for (const timer of instance.timers.values()) clearInterval(timer)
  instance.timers.clear()
  if (instance.post) clearTimeout(instance.post.timer)
  instance.post = undefined
  if (instance.realm) instance.realm.call({ type: 'unmount', id: instance.id })
  // A fault found while drawing shows at once; the listeners hear it after.
  queueMicrotask(() => notify(instance))
  const redraw = !instance.afterFault
  if (redraw) {
    let keys = faultRedraws.get(instance.site)
    if (!keys) faultRedraws.set(instance.site, (keys = new Set()))
    keys.add(instance.key)
  }
  void (events?.fault(instance.plugin, {
    surface: 'terminal', ...siteParts(instance.site), element: instance.key, module: instance.module, phase, reason: instance.fault.reason,
  }) ?? Promise.resolve())
    .catch(error => logForDebugging(`${instance.plugin}: ui.fault failed: ${String(error)}`, { level: 'warn' }))
    .finally(() => { if (redraw) invalidateModSite(instance.site) })
}

/** `$.ui.invalidate` of a site: a Client born there may fail and redraw again. */
export function forgetModClientFaults(site?: string): void {
  if (site === undefined) faultRedraws.clear()
  else faultRedraws.delete(site)
}

/** Every instance drawn now. */
export function listModClients(): ModClientInstance[] {
  return [...live.values()]
}

let generation = 0
const hostListeners = new Set<() => void>()
/** Bumped when every instance ends: a drawn region mounts afresh. */
export function getModClientGeneration(): number {
  return generation
}
export function subscribeModClients(listener: () => void): () => void {
  hostListeners.add(listener)
  return () => { hostListeners.delete(listener) }
}
/** The mods stopped (a reload, the session's end): every instance ends, its
 * timers with it, and what is drawn again runs the code loaded next. */
export function disposeModClients(): void {
  for (const instance of listModClients()) dispose(instance as Live)
  keyboards.clear()
  faultRedraws.clear()
  generation++
  for (const listener of [...hostListeners]) listener()
}

/** Which Client of a site holds the keyboard: a click gave it, Esc gives it back. */
const keyboards = new Map<string, ModClientInstance>()
const keyboardListeners = new Set<() => void>()
export function setModClientKeyboard(site: string, instance: ModClientInstance | undefined): void {
  if (instance) keyboards.set(site, instance)
  else keyboards.delete(site)
  for (const listener of [...keyboardListeners]) listener()
}
export function getModClientKeyboard(site: string): ModClientInstance | undefined {
  const instance = keyboards.get(site)
  // A Client gone or failed holds nothing.
  if (instance && (!live.has(instance.id) || instance.fault)) {
    keyboards.delete(site)
    return undefined
  }
  return instance
}
export function subscribeModClientKeyboard(listener: () => void): () => void {
  keyboardListeners.add(listener)
  return () => { keyboardListeners.delete(listener) }
}
