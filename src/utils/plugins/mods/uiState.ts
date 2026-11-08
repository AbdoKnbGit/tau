import type { ModRecord } from './runtime.js'
import { KEYBINDING_ACTIONS } from '../../../keybindings/schema.js'

/**
 * The terminal surface of the mods UI: panes mods open, their status lines,
 * and the trees their `ui.render` hooks drew for each render site. Plain data
 * the REPL subscribes to; nothing here renders.
 */
export type ModUiNode = string | {
  type: string
  props: ModRecord
  children: ModUiNode[]
}
export type ModPane = {
  plugin: string
  id: string
  title: string
  closeOnEscape: boolean
  /** While it is the one shown, toasts wait. */
  holdToasts: boolean
  backgroundColor?: string
  rows?: number
  columns?: number
  openedAt: number
  /** Drawn. False while an open the person did not ask for waits for a
   * wide enough terminal. */
  placed: boolean
  /** The width such an open waits for: 144 columns, 110 once the person
   * opened that id themselves. */
  floor: number
  /** What the person resized it to (Ctrl+X and an arrow). */
  sized?: { rows?: number; columns?: number }
}
/** A site's scroll window, as the view that draws it registers it. */
export type ModScroller = {
  scrollTo(row: number): void
  getScrollTop(): number
  getScrollHeight(): number
  getViewportHeight(): number
  /** Brings a control into view by its ring id; false when not drawn. */
  reveal?(id: string): boolean
}
type Site = {
  tree?: ModUiNode | null
  /** Rasters repainted by `$.ui.blit` since the tree arrived, by key. */
  blits?: Map<string, string>
  /** Which plugin drew each Raster of the tree, by key. */
  owners?: Map<string, string>
  error?: string
  key?: string
  pending?: boolean
  stale?: boolean
  lastAt?: number
  timer?: ReturnType<typeof setTimeout>
}

/** What a person did to a control that its mod has not drawn back yet: an
 * Input's text, a Select's pick or highlighted row; `base` is the value the
 * mod had drawn then, `typed` the texts sent since (their echoes keep it). */
export type ModControlDraft = {
  text?: string
  /** Where an Input's cursor stands in `text`, in code points. */
  cursor?: number
  pick?: string
  highlight?: number
  base?: string
  typed?: string[]
}

const panes: ModPane[] = []
const statuses = new Map<string, string>()
const sites = new Map<string, Site>()
const focusKeys = new Map<string, string>()
const drafts = new Map<string, Map<string, ModControlDraft>>()
let focused: { plugin: string; id: string } | null = null
/** The one pane the surface shows; the others are tabs behind it. */
let shown: { plugin: string; id: string } | null = null
let bandFocused = false
let bandCollapsed = false
/** Pane ids the person once opened themselves, by `plugin:id`. */
const askedPanes = new Set<string>()
const scrollers = new Map<string, ModScroller>()
let version = 0
const subscribers = new Set<() => void>()
let renderer: ((site: string, input: ModRecord) => Promise<unknown>) | undefined

function changed(): void {
  version++
  for (const subscriber of subscribers) {
    try { subscriber() } catch { /* a view's own failure stays its own */ }
  }
}
export function subscribeModUi(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}
export const getModUiVersion = () => version
export const getModPanes = (): readonly ModPane[] => panes
export const getModStatuses = (): ReadonlyMap<string, string> => statuses
export const getFocusedModPane = () => focused
export const getShownModPane = () => shown
export const isModBandFocused = () => bandFocused
export const isModBandCollapsed = () => bandCollapsed
export const getModSite = (site: string): Site | undefined => sites.get(site)

/** The manager supplies how a site's tree is drawn: the `ui.render` chain. */
export function setModUiRenderer(draw: typeof renderer): void {
  renderer = draw
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const hasControl = (text: string) => Array.from(text).some(char => {
  const code = char.codePointAt(0)!
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)
})
/** An unpaired surrogate half draws as U+FFFD, as Claude Code draws it. */
const wellFormed = (text: string) =>
  Array.from(text).map(char => {
    const code = char.codePointAt(0)!
    return code >= 0xd800 && code <= 0xdfff ? String.fromCodePoint(0xfffd) : char
  }).join('')

/** How an open came to be, as the surface judges whether to place it. */
export type ModPaneOpenContext = {
  /** The person asked: a command they ran, a control they used. */
  asked: boolean
  /** Something in the session draws panes (an interactive terminal). */
  surface: boolean
  /** The terminal's width now. */
  columns: number
  /** The keyboard may be given: the prompt has it over an empty composer,
   * nothing else holds it, no dialog is up. */
  canFocus: () => boolean
}

const paneOf = (target: { plugin: string; id: string } | null) =>
  target ? panes.find(pane => pane.plugin === target.plugin && pane.id === target.id) : undefined

/**
 * `$.ui.open`: opens (or retitles) a pane. An open the person did not ask
 * for waits, undrawn, for a terminal 144 columns wide (110 once they opened
 * that id); `focus` is granted only over an empty, idle prompt.
 */
export function openModPane(plugin: string, args: unknown, context: ModPaneOpenContext): ModRecord {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('ui.open takes { id, title }')
  const { id, title, focus, closeOnEscape, holdToasts, rows, columns, backgroundColor } = args as ModRecord
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('ui.open id is 1-64 letters, digits, _ or -')
  if (title !== undefined && (typeof title !== 'string' || hasControl(title)))
    throw new Error('ui.open title is a string without control characters')
  for (const [name, value] of [['focus', focus], ['closeOnEscape', closeOnEscape], ['holdToasts', holdToasts]] as const)
    if (value !== undefined && value !== true) throw new Error(`ui.open: ${name} is true or left out`)
  for (const [name, value] of [['rows', rows], ['columns', columns]] as const)
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 500))
      throw new Error(`ui.open ${name} must be a positive whole number of cells`)
  if (backgroundColor !== undefined && (typeof backgroundColor !== 'string' || !backgroundColor))
    throw new Error('ui.open backgroundColor is a theme key, a color, or "transparent"')
  const key = `${plugin}:${id}`
  if (context.asked) askedPanes.add(key)
  const floor = context.asked ? 0 : askedPanes.has(key) ? 110 : 144
  const label = title === undefined ? undefined : wellFormed(title)
  let pane = panes.find(item => item.plugin === plugin && item.id === id)
  if (pane) {
    // Opening an open id retitles it; each open sets the rest anew.
    if (label !== undefined) pane.title = label
    pane.closeOnEscape = closeOnEscape === true
    pane.holdToasts = holdToasts === true
    pane.backgroundColor = backgroundColor
    pane.rows = rows
    pane.columns = columns
    if (!pane.placed) pane.floor = Math.min(pane.floor, floor)
  } else {
    pane = {
      plugin, id, title: label ?? id, closeOnEscape: closeOnEscape === true, holdToasts: holdToasts === true,
      ...(backgroundColor !== undefined ? { backgroundColor } : {}),
      ...(rows !== undefined ? { rows } : {}), ...(columns !== undefined ? { columns } : {}),
      openedAt: Date.now(), placed: false, floor,
    }
    panes.push(pane)
  }
  if (context.surface && !pane.placed && context.columns >= pane.floor) pane.placed = true
  if (pane.placed && (context.asked || focus === true || !paneOf(shown)?.placed)) shown = { plugin, id }
  if (pane.placed && focus === true && context.canFocus()) {
    focused = { plugin, id }
    bandFocused = false
    shown = { plugin, id }
  }
  invalidateModSite(`Pane:${key}`)
  changed()
  if (!context.surface) return { isPlaced: false, reason: 'no-surface: nothing in this session draws panes' }
  return pane.placed ? { isPlaced: true }
    : { isPlaced: false, reason: `opened unasked, it waits for a terminal ${pane.floor} columns wide; this one is ${context.columns}` }
}

/** The terminal is this wide now: waiting panes it fits are placed. */
export function placeModPanes(columns: number): void {
  let touched = false
  for (const pane of panes)
    if (!pane.placed && columns >= pane.floor) {
      pane.placed = true
      touched = true
      if (!paneOf(shown)?.placed) shown = { plugin: pane.plugin, id: pane.id }
      invalidateModSite(`Pane:${pane.plugin}:${pane.id}`)
    }
  if (touched) changed()
}

/** A tab chosen: that pane is the one shown (and holds the keys if one did). */
export function showModPane(plugin: string, id: string): boolean {
  const pane = paneOf({ plugin, id })
  if (!pane?.placed) return false
  shown = { plugin, id }
  if (focused) focused = { plugin, id }
  changed()
  return true
}

/** The band above the prompt takes the keyboard, or gives it back. */
export function focusModBand(on: boolean): void {
  if (bandFocused === on && (!on || !focused)) return
  bandFocused = on && !bandCollapsed
  if (bandFocused) focused = null
  changed()
}

/** Collapses the band to one row, or expands it (abovePrompt:toggle). */
export function toggleModBand(): void {
  bandCollapsed = !bandCollapsed
  if (bandCollapsed) bandFocused = false
  changed()
}

/** Whether toasts wait: the pane shown asked for it. */
export function isModToastHold(): boolean {
  const pane = paneOf(shown)
  return !!pane?.placed && pane.holdToasts
}

/** The person resized the pane (Ctrl+X and an arrow): rows inline, columns docked. */
export function resizeModPane(plugin: string, id: string, by: number, docked: boolean, current: number): void {
  const pane = paneOf({ plugin, id })
  if (!pane) return
  pane.sized = { ...pane.sized, [docked ? 'columns' : 'rows']: Math.max(1, current + by) }
  changed()
}

export function registerModScroller(site: string, scroller: ModScroller): () => void {
  scrollers.set(site, scroller)
  return () => { if (scrollers.get(site) === scroller) scrollers.delete(site) }
}
export const getModScroller = (site: string) => scrollers.get(site)

/** Removes a pane once its close was decided; `true` when it was open. */
export function removeModPane(plugin: string, id: string): boolean {
  const index = panes.findIndex(pane => pane.plugin === plugin && pane.id === id)
  if (index < 0) return false
  panes.splice(index, 1)
  if (focused?.plugin === plugin && focused.id === id) focused = null
  // The latest pane opened of the rest is shown in its place.
  if (shown?.plugin === plugin && shown.id === id) {
    const next = panes.filter(pane => pane.placed).sort((a, b) => b.openedAt - a.openedAt)[0]
    shown = next ? { plugin: next.plugin, id: next.id } : null
  }
  forgetSite(`Pane:${plugin}:${id}`)
  changed()
  return true
}

function forgetSite(site: string): void {
  clearTimeout(sites.get(site)?.timer)
  sites.delete(site)
  focusKeys.delete(site)
  drafts.delete(site)
}

export function listModPanes(plugin: string): ModRecord[] {
  return panes.filter(pane => pane.plugin === plugin).map(pane => ({
    id: pane.id,
    title: pane.title,
    isShown: pane.placed && shown?.plugin === plugin && shown.id === pane.id,
    isFocused: focused?.plugin === plugin && focused.id === pane.id,
    isPlaced: pane.placed,
  }))
}

export function focusModPane(plugin: string, id: string | null): boolean {
  if (id !== null && !panes.some(pane => pane.plugin === plugin && pane.id === id && pane.placed)) return false
  focused = id === null ? null : { plugin, id }
  if (id !== null) {
    shown = { plugin, id }
    bandFocused = false
  }
  changed()
  return true
}

/** Tool calls whose permission dialog is open, the line a plugin put under
 * each, and which plugin's `$.tool.call` started a call. */
const openToolCalls = new Set<string>()
const toolNotices = new Map<string, { plugin: string; text: string }>()
const modToolCalls = new Map<string, string>()
export function markModToolCall(id: string, plugin: string | undefined): () => void {
  if (plugin === undefined) return () => {}
  modToolCalls.set(id, plugin)
  return () => { modToolCalls.delete(id) }
}
export function openModToolCall(id: string): void {
  openToolCalls.add(id)
}
/** The dialog closed: the call resolved, and its line goes with it. */
export function closeModToolCall(id: string): void {
  openToolCalls.delete(id)
  if (toolNotices.delete(id)) changed()
}
export const getModToolNotice = (id: string) => toolNotices.get(id)
/** `$.ui.notice`: a line under the open dialog of `id`, or none. */
export function setModToolNotice(plugin: string, id: string, text: unknown): void {
  if (!openToolCalls.has(id)) throw new Error('ui.notice: no dialog is open for that call')
  const starter = modToolCalls.get(id)
  if (starter !== undefined && starter !== plugin) throw new Error('ui.notice: that call is another plugin\'s $.tool.call run')
  if (text === undefined) {
    if (toolNotices.delete(id)) changed()
    return
  }
  const line = String(text).replace(/[\r\n]+/g, ' ')
  const current = toolNotices.get(id)
  if (current?.plugin === plugin && current.text === line) return
  toolNotices.set(id, { plugin, text: line })
  changed()
}

/** The control of a site that holds its focus ring, by its ring id. */
export const getModFocusKey = (site: string) => focusKeys.get(site)
export function setModFocusKey(site: string, key: string | undefined): void {
  if (focusKeys.get(site) === key) return
  if (key === undefined) focusKeys.delete(site)
  else focusKeys.set(site, key)
  changed()
}

/** Hover scopes the pointer is over: a keyed Box (by site and key), or a
 * scope group (by its owner and name). */
const hovered = new Set<string>()
export const isModHovered = (scope: string) => hovered.has(scope)
export function setModHover(scope: string, on: boolean): void {
  if (on === hovered.has(scope)) return
  if (on) hovered.add(scope)
  else hovered.delete(scope)
  changed()
}

export const getModDraft = (site: string, id: string): ModControlDraft | undefined => drafts.get(site)?.get(id)
export function setModDraft(site: string, id: string, draft: ModControlDraft): void {
  let held = drafts.get(site)
  if (!held) drafts.set(site, (held = new Map()))
  held.set(id, draft)
  changed()
}

/** A control's address, what `e.element` carries: its `key`, or a Button's
 * label (the text of its children when it has no label). */
export function modControlKey(node: ModUiNode | null | undefined): string | undefined {
  if (!node || typeof node === 'string') return undefined
  if (node.type !== 'Button' && node.type !== 'Input' && node.type !== 'Select') return undefined
  if (typeof node.props.key === 'string' && node.props.key) return node.props.key
  if (node.type !== 'Button') return undefined
  if (typeof node.props.label === 'string' && node.props.label) return node.props.label
  const text = (item: ModUiNode): string => typeof item === 'string' ? item : item.children.map(text).join('')
  return node.children.map(text).join('') || undefined
}

/** The controls of a tree in drawing order; `nth` tells apart controls that
 * share an address (a Delete button on every row), each keeping its closure. */
export function modControls(tree: ModUiNode | null | undefined): Array<{ node: Exclude<ModUiNode, string>; key: string; nth: number }> {
  const out: Array<{ node: Exclude<ModUiNode, string>; key: string; nth: number }> = []
  const seen = new Map<string, number>()
  const visit = (node: ModUiNode | null | undefined): void => {
    if (!node || typeof node === 'string') return
    const key = modControlKey(node)
    if (key !== undefined) {
      const nth = seen.get(key) ?? 0
      seen.set(key, nth + 1)
      out.push({ node, key, nth })
    }
    for (const child of node.children) visit(child)
  }
  visit(tree)
  return out
}

export function setModStatus(plugin: string, text: unknown): void {
  if (text !== undefined && typeof text !== 'string') throw new Error('ui.status takes text or undefined')
  // An unpaired surrogate half draws as U+FFFD, as Claude Code draws it.
  const line = typeof text === 'string'
    ? text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�').replace(/[\r\n]+/g, ' ')
    : undefined
  if (line === undefined || !line.trim()) {
    if (!statuses.delete(plugin)) return
  } else if (statuses.get(plugin) === line) return
  else statuses.set(plugin, line)
  changed()
}

/** Forgets everything a mod drew or opened, when it unloads. */
export function forgetModUi(plugin: string): void {
  let touched = statuses.delete(plugin)
  for (let i = panes.length - 1; i >= 0; i--) {
    if (panes[i]!.plugin !== plugin) continue
    forgetSite(`Pane:${plugin}:${panes[i]!.id}`)
    panes.splice(i, 1)
    touched = true
  }
  if (focused?.plugin === plugin) focused = null
  if (shown?.plugin === plugin) {
    const next = panes.filter(pane => pane.placed).sort((a, b) => b.openedAt - a.openedAt)[0]
    shown = next ? { plugin: next.plugin, id: next.id } : null
  }
  for (const key of [...sites.keys()]) if (!key.startsWith('Pane:')) { forgetSite(key); touched = true }
  if (touched) changed()
}

/** Redraws are coalesced: at most one per site every 33 ms (thirty a second). */
const REDRAW_MS = 33

/** Marks every site (or one) for a redraw at its next request. */
export function invalidateModSite(site?: string): void {
  for (const [key, entry] of sites) if (site === undefined || key === site) entry.stale = true
  changed()
}

/**
 * The tree a site shows now. A new request (other props, other width, or a
 * redraw) dispatches `ui.render` in the background; until it answers the
 * previous tree stays on screen.
 */
export function requestModSite(site: string, input: ModRecord): Site {
  const key = JSON.stringify(input)
  let entry = sites.get(site)
  if (!entry) sites.set(site, (entry = {}))
  if (!renderer || entry.pending || (entry.key === key && !entry.stale)) return entry
  const wait = entry.lastAt === undefined ? 0 : Math.max(0, entry.lastAt + REDRAW_MS - Date.now())
  if (wait > 0) {
    entry.timer ??= setTimeout(() => { entry!.timer = undefined; changed() }, wait)
    return entry
  }
  entry.pending = true
  entry.stale = false
  entry.key = key
  entry.lastAt = Date.now()
  const draw = renderer
  void draw(site, input).then(drawn => {
    const { tree, owners } = drawn && typeof drawn === 'object' && 'owners' in (drawn as ModRecord)
      ? drawn as { tree: unknown; owners: Map<string, string> }
      : { tree: drawn, owners: undefined }
    entry!.tree = normalizeModTree(tree)
    // A new drawing replaces what was blitted into the old one.
    entry!.blits = undefined
    entry!.owners = owners
    entry!.error = undefined
  }, error => {
    entry!.error = error instanceof Error ? error.message : String(error)
  }).finally(() => {
    entry!.pending = false
    if (sites.get(site) === entry) changed()
  })
  return entry
}

/**
 * A checked tree as the terminal draws it: numbers as text, `null` and
 * booleans gone, nested lists flattened, every element with its props and
 * children, and the engine's own drawing (empty in Tau) gone. A list at the
 * top draws as a column, as the site would draw its items.
 */
export function normalizeModTree(value: unknown): ModUiNode | null {
  const list = (items: unknown, out: ModUiNode[]): ModUiNode[] => {
    for (const item of Array.isArray(items) ? items : [items]) {
      if (Array.isArray(item)) list(item, out)
      else {
        const node = one(item)
        if (node !== null) out.push(node)
      }
    }
    return out
  }
  const one = (node: unknown): ModUiNode | null => {
    if (typeof node === 'string') return node
    if (typeof node === 'number') return String(node)
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      const children = list(node, [])
      return children.length ? { type: 'Box', props: { flexDirection: 'column' }, children } : null
    }
    const element = node as ModRecord
    if (element.type === 'engine') return null
    return { type: String(element.type), props: { ...(element.props ?? {}) }, children: list(element.children ?? [], []) }
  }
  return one(value)
}

const ELEMENTS = new Set(['Box', 'Text', 'Button', 'Link', 'Code', 'Markdown', 'Input', 'Select', 'Raster', 'Image', 'Client', 'engine'])
/** What may sit inside a line of text: the terminal cannot put a block there. */
const INLINE = new Set(['Text', 'Link', 'Button', 'Image', 'engine'])
const LIMITS = { depth: 32, nodes: 20_000, text: 100_000, field: 10_000, href: 2_048, rasterCells: 262_144 }

/**
 * Whether a Link draws as a link in the terminal: any scheme, as written, at
 * most 2048 characters once percent-encoded. Anything else (a blank href, no
 * string) draws its text plain, and the tree stands.
 */
export function modLinkTarget(href: unknown): string | undefined {
  if (typeof href !== 'string' || !href.trim()) return undefined
  let encoded: string
  try { encoded = encodeURI(decodeURI(href)) } catch { encoded = href }
  return encoded.length > LIMITS.href ? undefined : href
}

/**
 * `$.ui.blit`: new cells for a Raster this plugin drew, painted at the next
 * frame without a redraw. Answers `{}` or `{ deny }` saying why not.
 */
export function blitModRaster(plugin: string, args: ModRecord): ModRecord {
  const requestId = typeof args.requestId === 'string' ? args.requestId : undefined
  const key = typeof args.key === 'string' ? args.key : undefined
  if (!requestId || !key) return { deny: 'ui.blit takes { requestId, key, cells }' }
  if (args.source !== undefined) return { deny: 'this terminal draws an Image as its alt text, which has no source to swap' }
  const site = requestId === 'AbovePrompt' ? 'AbovePrompt' : `Pane:${plugin}:${requestId}`
  const entry = sites.get(site)
  const raster = entry?.tree ? findRaster(entry.tree, key) : undefined
  const owner = entry?.owners?.get(key) ?? (site.startsWith('Pane:') ? plugin : undefined)
  if (!raster || owner !== plugin) return { deny: `no Raster "${key}" of this plugin is mounted in ${requestId}` }
  const columns = raster.props.columns as number, rows = raster.props.rows as number
  if ((args.columns !== undefined && args.columns !== columns) || (args.rows !== undefined && args.rows !== rows))
    return { deny: `the Raster is mounted at ${columns}x${rows}; a resize is a redraw` }
  if (typeof args.cells !== 'string' || Buffer.from(args.cells, 'base64').byteLength !== columns * rows * 12)
    return { deny: 'the cells do not decode to three 32-bit words for each mounted cell' }
  ;(entry!.blits ??= new Map()).set(key, args.cells)
  changed()
  return {}
}

function findRaster(node: ModUiNode, key: string): Exclude<ModUiNode, string> | undefined {
  if (typeof node === 'string') return undefined
  if (node.type === 'Raster' && node.props.key === key) return node
  for (const child of node.children) {
    const found = findRaster(child, key)
    if (found) return found
  }
  return undefined
}

/** The cells a Raster shows now: blitted ones, or its drawing's. */
export const getModRasterCells = (site: string, key: string): string | undefined => sites.get(site)?.blits?.get(key)

/**
 * Checks a tree a `ui.render` hook returned against the terminal's element
 * table and Claude Code's limits; a tree that fails fails its hook, and the
 * site draws what the hooks beneath (or the engine) drew instead.
 */
export function validateModTree(value: unknown, options: { client?: boolean } = {}): void {
  let nodes = 0, text = 0, raster = 0
  const rasterKeys = new Set<string>(), clientKeys = new Set<string>()
  // `within`: the line of text (Text or Link) the node sits in, if any.
  const visit = (node: unknown, depth: number, within?: string, keyed = false): void => {
    if (depth > LIMITS.depth + 1) throw new Error(`the tree nests deeper than ${LIMITS.depth} levels`)
    if (node === null || node === undefined || node === false || node === true) return
    if (++nodes > LIMITS.nodes) throw new Error(`the tree holds more than ${LIMITS.nodes} elements`)
    if (typeof node === 'string' || typeof node === 'number') {
      text += String(node).length
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth, within, keyed)
      return
    }
    if (typeof node !== 'object') throw new Error('a tree holds elements and text only')
    const element = node as ModRecord
    if (typeof element.type !== 'string' || !ELEMENTS.has(element.type))
      throw new Error(`the terminal draws no element ${JSON.stringify(element.type)}`)
    if (within && !INLINE.has(element.type))
      throw new Error(`a ${within} holds text and Text, Link, Button or Image elements, not a ${element.type}`)
    // A Client module draws with the surface's elements, less these.
    if (options.client && ['Client', 'Raster', 'Image', 'engine'].includes(element.type))
      throw new Error(`a Client draws no ${element.type}`)
    if (element.type === 'engine') return
    const props = element.props ?? {}
    if (typeof props !== 'object' || Array.isArray(props)) throw new Error(`${element.type} props must be an object`)
    const children = element.children ?? []
    if (!Array.isArray(children)) throw new Error(`${element.type} children must be a list`)
    const ownKey = element.type === 'Box' && typeof props.key === 'string' && !!props.key
    if (props.hover !== undefined) {
      const hover = props.hover
      if (!hover || typeof hover !== 'object' || Array.isArray(hover)) throw new Error(`${element.type} hover must be an object`)
      if (hover.scope !== undefined && (typeof hover.scope !== 'string' || !/^[^\x00-\x1f\x7f]{1,64}$/.test(hover.scope)))
        throw new Error('a hover scope is 1 to 64 characters without control characters')
      if (hover.scope === undefined && !keyed && !ownKey)
        throw new Error(`a ${element.type} hover needs a keyed Box around it, or a scope`)
    }
    switch (element.type) {
      case 'Button':
        if (props.label === undefined && !children.length) throw new Error('a Button needs a label or children')
        for (const child of children.flat(Infinity))
          if (child !== null && child !== undefined && typeof child !== 'string' && typeof child !== 'number' &&
              !(child && typeof child === 'object' && (child as ModRecord).type === 'Text'))
            throw new Error('a Button holds strings and Text elements only')
        if (props.variant !== undefined && !['primary', 'secondary'].includes(props.variant))
          throw new Error('Button variant is primary or secondary')
        if (props.role !== undefined && props.role !== 'dismiss') throw new Error('Button role is dismiss')
        if (props.hotkey !== undefined && (typeof props.hotkey !== 'string' || !/^[0-9a-z]$/.test(props.hotkey)))
          throw new Error('a Button hotkey is one digit or one lowercase letter')
        if (props.action !== undefined && (typeof props.action !== 'string' || !(KEYBINDING_ACTIONS as readonly string[]).includes(props.action)))
          throw new Error(`a Button action is an engine keybinding action; ${JSON.stringify(props.action)} is not one`)
        break
      case 'Link':
        // Its href is checked as it is drawn: one the terminal cannot link
        // draws as plain text, the tree standing.
        break
      case 'Code':
        if (typeof props.source !== 'string') throw new Error('a Code needs a source')
        for (const field of ['language', 'path'])
          if (props[field] !== undefined && (typeof props[field] !== 'string' || props[field].length > LIMITS.field))
            throw new Error(`Code ${field} is a string of at most ${LIMITS.field} characters`)
        text += props.source.length
        break
      case 'Markdown':
        if (typeof props.text !== 'string') throw new Error('a Markdown needs text')
        text += props.text.length
        break
      case 'Input':
        if (typeof props.key !== 'string' || !props.key) throw new Error('an Input needs a key')
        if (props.rows !== undefined && (!Number.isInteger(props.rows) || props.rows < 1))
          throw new Error('an Input\'s rows is a whole number of at least 1')
        break
      case 'Select':
        if (typeof props.key !== 'string' || !props.key) throw new Error('a Select needs a key')
        if (!Array.isArray(props.options) || !props.options.length || props.options.some((option: unknown) =>
          !option || typeof option !== 'object' || typeof (option as ModRecord).value !== 'string' ||
          (option as ModRecord).value.length > LIMITS.field ||
          ((option as ModRecord).label !== undefined && typeof (option as ModRecord).label !== 'string')))
          throw new Error('Select options are at least one { value, label? } with string values')
        if (new Set(props.options.map((option: ModRecord) => option.value)).size !== props.options.length)
          throw new Error('Select option values are unique')
        break
      case 'Raster': {
        const { columns, rows, cells } = props
        if (typeof props.key !== 'string' || !props.key) throw new Error('a Raster needs a key')
        if (rasterKeys.has(props.key)) throw new Error(`two Rasters share the key "${props.key}"`)
        rasterKeys.add(props.key)
        if (!Number.isInteger(columns) || columns < 1 || columns > 512 || !Number.isInteger(rows) || rows < 1 || rows > 256)
          throw new Error('a Raster is 1-512 columns by 1-256 rows')
        raster += columns * rows
        if (raster > LIMITS.rasterCells) throw new Error(`the tree holds more than ${LIMITS.rasterCells} Raster cells`)
        if (typeof cells !== 'string' || Buffer.from(cells, 'base64').byteLength !== columns * rows * 12)
          throw new Error('Raster cells are base64 of three 32-bit words per cell')
        break
      }
      case 'Client': {
        if (typeof props.module !== 'string' || props.module.length > LIMITS.field)
          throw new Error(`a Client module is a string of at most ${LIMITS.field} characters`)
        if (typeof props.key !== 'string' || !props.key) throw new Error('a Client needs a key')
        if (clientKeys.has(props.key)) throw new Error(`two Clients share the key "${props.key}"`)
        clientKeys.add(props.key)
        let json: string | undefined
        try { json = props.props === undefined ? undefined : JSON.stringify(props.props) } catch { json = undefined }
        if (props.props !== undefined && (json === undefined || json.length > 100_000))
          throw new Error("a Client's props are JSON data of at most 100000 characters")
        break
      }
    }
    const line = element.type === 'Text' || element.type === 'Link' || element.type === 'Button' ? element.type : within
    for (const child of children) visit(child, depth + 1, line, keyed || ownKey)
  }
  visit(value, 0)
  if (text > LIMITS.text * 10) throw new Error('the tree holds too much text to draw')
}
