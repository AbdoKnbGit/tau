import type {
  Base64ImageSource,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'

import { Text } from '../../ink.js'
import {
  buildTool,
  type ToolDef,
  type ToolUseContext,
  type ValidationResult,
} from '../../Tool.js'
import {
  classifyBrowserRisk,
  classifyPressRisk,
  type BrowserRisk,
} from '../../services/browser/riskClassifier.js'
import {
  getBrowserSession,
  type BrowserActionOutcome,
  type TabInfo,
} from '../../services/browser/browserSession.js'
import type { ObservedState } from '../../services/browser/pageScripts.js'
import type { PermissionResult } from '../../types/permissions.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { BROWSER_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Drive a real Chrome/Edge browser: navigate, observe numbered elements, read page content as markdown, click, fill, type, hover, drag, upload, run JS, watch console/network, screenshot, and manage tabs. One tool, one action per call.'

const PROMPT = `Operate a real Chromium browser (Chrome, Edge, or Brave) through the DevTools protocol. Unlike WebBrowser/InspectSite (static HTML fetch), this runs JavaScript: it works on React/Vue/SPA pages, clicks and types through real trusted input, reads the rendered DOM (including same-origin iframes), extracts page content as markdown, runs JS in the page, watches console/network (great for debugging web apps you are developing), uploads files, and handles tabs, dialogs, and downloads.

THE ONE RULE THAT PREVENTS ERRORS: every call is { "action": "<name>", ...params for that action }. Pick exactly one action. Provide only that action's params. Most actions return a fresh page observation, so continue from the returned state instead of guessing.

THE LOOP:
1. open — launch/attach the browser (once per session). Optionally pass url to land somewhere immediately.
2. observe — the page as numbered interactive elements (ref @N, role, text). Always observe before acting on a page you have not seen. Elements inside same-origin iframes are included (marked [iframe]) and work like any other ref.
3. read — the page CONTENT as markdown when you need to actually read something (articles, docs, search results, prices). observe finds what to act on; read is how you read.
4. Act on a ref from the latest observation: click, fill, type, hover, press, drag, upload, scroll. Each returns the new observation.
5. Repeat until done. Refs are only valid for the most recent observation of the current tab; after the DOM changes, use the refs from the observation you just received.

HOW TO TARGET THINGS — READ THIS, IT IS THE #1 SOURCE OF WASTED STEPS:
Act by @ref (from the latest observation) or by text. These are precise: the tool knows exactly which element you mean. NEVER guess (x, y) coordinates to find or reach a button, link, close-X, or menu. Coordinates are blind — you cannot see where things are, so guessing them clicks the wrong element (a nav link, a different product) and destroys your progress. Coordinates are ONLY for a canvas/map/video/drawing surface that has no DOM element, and only after a screenshot shows you exactly where to click.

WHEN AN ACTION FAILS OR DOES NOTHING, the fix is always to SEE the page, never to try different coordinates:
- Re-observe to get fresh @refs, then act by ref. (Most failures are just a changed DOM — refs went stale.)
- screenshot when you need to SEE layout/visual state ({ "annotate": true } burns the @N badges into the image so you can match refs to what you see).
- Then act by ref/text. Do not repeat a failed approach with tweaked numbers. If the same tactic fails twice, it is the wrong tactic — change it.
The tool BLOCKS repeated blind coordinate clicks on purpose (reason "coordinate_guessing"). That is a signal to stop guessing and observe/screenshot — not a hint to try yet another coordinate.

CLOSING MODALS / POPUPS / OVERLAYS: use { "action": "dismiss" }. It finds the topmost dialog/popup/drawer/lightbox and clicks its close control (or sends Escape). Do NOT hunt for the X with coordinates. Cookie/consent banners are auto-dismissed on observe.

SEE / READ:
- observe — no params. url, title, elements as "@N tag \\"text\\" [role]", and scroll state.
- read — { selector?, maxChars?, offset? }. Rendered page as markdown with [text](url) links. Defaults to the main content area; selector scopes it (e.g. "#docs"); long pages report total length — page through with offset.
- screenshot — optional { full: true } whole page, { ref: N } one element, { annotate: true } @N badges over the last observation, { path: "shot.png" } save to a file instead of returning into context (use path when the user wants the image, not you).
- console — { level?, filter?, limit?, clear? }. This tab's console messages + uncaught exceptions. level: error|warn|info|log|all.
- network — { filter?, failed?, limit?, clear? }. This tab's requests as "METHOD status url [type]". failed: only errors/4xx/5xx. Use console+network to debug the web app you are working on.

NAVIGATE:
- open — { url?, headless? } start the browser (headless default false so the user sees the window).
- navigate — { url }. http(s) or a local file: "localhost:3000" becomes http://, an existing local HTML file path becomes file:// (open what you just built).
- back / forward — history. reload — { hard? } reload the tab (hard: bypass cache after a rebuild).
- wait — { ms: 1500 } pause, OR { selector: ".results", timeoutMs?, gone? }, OR { text: "Success", timeoutMs?, gone? } — wait until a CSS selector or visible text appears (gone: true → disappears, e.g. a spinner).

ACT:
- click — { ref: N } (STRONGLY PREFERRED) or { text: "Sign in", nth? } or { x, y } (canvas/map only, after a screenshot). If mixed accidentally, ref/text wins and x/y is ignored. { double: true } for double-click.
- fill — { ref: N, value: "..." } set input/textarea/select; the value is read back and verified. For <select>, value matches an option by value or visible label.
- type — { text: "..." } into the focused field (click it first). submit: true presses Enter after.
- press — { key: "..." } one key or chord: Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home/End, PageUp/PageDown, F1-F12, any single character, or chords like "Control+a", "Control+Shift+ArrowRight".
- hover — { ref: N } or { text: "..." }. Opens hover menus/tooltips; the observation shows what appeared.
- scroll — { direction: up|down|left|right|top|bottom, amount? } or { ref: N } to scroll that element into view.
- drag — { ref: N, toRef: M } drag source onto target (real mouse path; falls back to HTML5 drag-and-drop events automatically).
- upload — { ref: N, files: ["C:/path/report.pdf"] } set local file(s) on a file input. NEVER click a file-picker button and wait — the native OS dialog is invisible to this tool; upload sets files directly (the ref can be the input, its label, or a nearby upload control).
- eval — { js: "..." } run JavaScript in the page, returns the JSON-serialized result (promises awaited). The escape hatch: extract structured data in one shot, read computed styles, call the app's own APIs. If your JS changed the DOM, observe afterwards.
- dismiss — no params. Close the topmost modal/popup/overlay.
- pdf — { path: "page.pdf" } save the current page as PDF.
- resize — { width, height, mobile? } emulate a viewport for responsive testing (mobile: true also emulates touch; 0 x 0 resets to the real window).

TABS: tabs (list) / new_tab { url? } / switch_tab { tabIndex } / close_tab { tabIndex? }. A click that opens a new tab switches to it automatically.
close — shut the browser down when the task is finished.

AUTOMATIC BEHAVIORS (read the warnings, do not fight them):
- JS dialogs (alert/confirm/prompt) are auto-accepted so they can never wedge the session; the dialog text shows up in warnings.
- Downloads land in a known folder; "Download finished: name → path" appears in warnings.
- Consent banners auto-dismissed; new tabs from clicks auto-followed; hidden lazy content nudged awake.
- If the user focuses or interacts with another browser tab, the tool follows that active tab automatically and reports the handoff in warnings.

RECOVERY (the reason field tells you which happened — adjust, do not retry blindly):
- stale_ref — the page changed since your last observe. Observe and use the new refs.
- element_covered — an overlay/modal is on top of your target. dismiss it, then retry by ref.
- coordinate_guessing — you are clicking blind coordinates. Stop. Observe (refs) or screenshot (see), then act by ref/text.
- not_editable — that element is not an input, or it rejected text. Click the actual input first, or fill a different element.
- no_match — your text/selector matched nothing (or only a negation like "Don't allow"). Observe and act by ref.
- timeout — the waited-for condition never came. Read or observe to see what the page did instead.
CAPTCHA/login walls are flagged in warnings — stop and ask the user to handle them in the browser window, then continue. (Anti-detection measures are on, so these should be rare.)

SAFETY: actions that clearly pay, purchase, delete, or enter card data pause for user confirmation. Do not try to route around that; it is intended.

Prefer this tool over the Computer tool for anything inside a web page — it is DOM-aware and does not burn tokens on screenshots for every step.`

const ACTIONS = [
  'open',
  'navigate',
  'observe',
  'read',
  'click',
  'fill',
  'type',
  'press',
  'hover',
  'scroll',
  'drag',
  'upload',
  'eval',
  'dismiss',
  'wait',
  'screenshot',
  'console',
  'network',
  'pdf',
  'resize',
  'tabs',
  'new_tab',
  'switch_tab',
  'close_tab',
  'back',
  'forward',
  'reload',
  'close',
] as const

const actionSchema = z.enum(ACTIONS)

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: actionSchema.describe(
      'The browser operation to perform. Exactly one per call.',
    ),
    url: z
      .string()
      .optional()
      .describe('URL for open (optional), navigate, and new_tab.'),
    ref: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Element ref @N from the latest observation. For click, fill, hover, drag (source), upload, scroll, screenshot.',
      ),
    text: z
      .string()
      .optional()
      .describe(
        'For click/hover: visible text to match. For type: text to type. For wait: text to wait for.',
      ),
    nth: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('For click/hover by text: which match (1-based). Default 1.'),
    value: z.string().optional().describe('For fill: the value to enter.'),
    x: z.number().int().min(0).optional().describe('For coordinate-only click: viewport X coordinate. Ignored when ref or text is present.'),
    y: z.number().int().min(0).optional().describe('For coordinate-only click: viewport Y coordinate. Ignored when ref or text is present.'),
    key: z
      .string()
      .optional()
      .describe(
        'For press: a named key (Enter, Tab, F5, ...), a single character, or a chord like "Control+a".',
      ),
    submit: z
      .boolean()
      .optional()
      .describe('For type: press Enter after typing. Default false.'),
    double: z
      .boolean()
      .optional()
      .describe('For click: double-click. Default false.'),
    direction: z
      .enum(['up', 'down', 'left', 'right', 'top', 'bottom'])
      .optional()
      .describe('For scroll: the direction.'),
    amount: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .optional()
      .describe('For scroll up/down/left/right: pixels to scroll. Default 650.'),
    ms: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .optional()
      .describe('For wait: milliseconds to pause.'),
    selector: z
      .string()
      .optional()
      .describe('For wait: CSS selector to wait for. For read: scope to this selector.'),
    gone: z
      .boolean()
      .optional()
      .describe('For wait with selector/text: wait for it to DISAPPEAR instead. Default false.'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(30_000)
      .optional()
      .describe('For wait by selector/text: max wait in ms. Default 5000.'),
    toRef: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('For drag: the drop-target ref @M from the latest observation.'),
    files: z
      .array(z.string())
      .optional()
      .describe('For upload: local file path(s) to put into the file input.'),
    js: z
      .string()
      .optional()
      .describe('For eval: JavaScript to run in the page (promises are awaited).'),
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(30_000)
      .optional()
      .describe('For read: max characters to return. Default 6000.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('For read: continue from this character offset (pagination).'),
    full: z
      .boolean()
      .optional()
      .describe('For screenshot: capture the whole page, not just the viewport.'),
    annotate: z
      .boolean()
      .optional()
      .describe('For screenshot: overlay @N ref badges from the last observation.'),
    path: z
      .string()
      .optional()
      .describe('For screenshot/pdf: save to this local file path (screenshot then returns no image into context).'),
    level: z
      .enum(['error', 'warn', 'info', 'log', 'all'])
      .optional()
      .describe('For console: minimum interest level filter. Default all.'),
    filter: z
      .string()
      .optional()
      .describe('For console/network: only entries containing this substring.'),
    failed: z
      .boolean()
      .optional()
      .describe('For network: only failed requests (errors, 4xx, 5xx). Default false.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('For console/network: max entries to return. Default 30.'),
    clear: z
      .boolean()
      .optional()
      .describe('For console/network: clear the captured buffer after returning it.'),
    width: z
      .number()
      .int()
      .min(0)
      .max(4000)
      .optional()
      .describe('For resize: viewport width in px (0 with height 0 resets).'),
    height: z
      .number()
      .int()
      .min(0)
      .max(4000)
      .optional()
      .describe('For resize: viewport height in px.'),
    mobile: z
      .boolean()
      .optional()
      .describe('For resize: emulate a mobile device (touch, mobile UA hints). Default false.'),
    hard: z
      .boolean()
      .optional()
      .describe('For reload: bypass the cache. Default false.'),
    tabIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('For switch_tab and close_tab: the tab index from the tabs action.'),
    headless: z
      .boolean()
      .optional()
      .describe('For open: run without a visible window. Default false.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: actionSchema,
    ok: z.boolean(),
    message: z.string(),
    reason: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    elementsText: z.string().optional(),
    tabsText: z.string().optional(),
    /** Markdown page content from the read action. */
    pageText: z.string().optional(),
    /** JSON-serialized result of the eval action. */
    value: z.string().optional(),
    consoleText: z.string().optional(),
    networkText: z.string().optional(),
    savedPath: z.string().optional(),
    warnings: z.array(z.string()),
    screenshot: z
      .object({
        base64: z.string(),
        mediaType: z.enum(['image/jpeg', 'image/png']),
      })
      .optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type BrowserOutput = z.infer<OutputSchema>

const REQUIRED_BY_ACTION: Partial<Record<Input['action'], Array<keyof Input>>> = {
  navigate: ['url'],
  fill: ['ref', 'value'],
  type: ['text'],
  press: ['key'],
  drag: ['ref', 'toRef'],
  upload: ['ref', 'files'],
  eval: ['js'],
  pdf: ['path'],
  resize: ['width', 'height'],
  switch_tab: ['tabIndex'],
}

function validateBrowserInput(input: Input): ValidationResult {
  const required = REQUIRED_BY_ACTION[input.action]
  if (required) {
    const missing = required.filter(field => input[field] === undefined)
    if (missing.length > 0) {
      return {
        result: false,
        message: `Browser action "${input.action}" requires: ${missing.join(', ')}. Call it as { "action": "${input.action}", ${required.map(f => `"${String(f)}": ...`).join(', ')} }.`,
        errorCode: 1,
      }
    }
  }
  if (input.action === 'click') {
    const hasRef = input.ref !== undefined
    const hasText = !!input.text?.trim()
    const hasCoords = input.x !== undefined && input.y !== undefined
    if (!hasRef && !hasText && !hasCoords) {
      return {
        result: false,
        message:
          'Browser action "click" needs a target: { "ref": N } from the last observation (preferred), or { "text": "..." }, or { "x": .., "y": .. }.',
        errorCode: 1,
      }
    }
  }
  if (input.action === 'hover' && input.ref === undefined && !input.text) {
    return {
      result: false,
      message:
        'Browser action "hover" needs a target: { "ref": N } from the last observation (preferred) or { "text": "..." }.',
      errorCode: 1,
    }
  }
  if (input.action === 'scroll' && !input.direction && input.ref === undefined) {
    return {
      result: false,
      message:
        'Browser action "scroll" needs { "direction": "up|down|left|right|top|bottom" } (optional amount), or { "ref": N } to scroll that element into view.',
      errorCode: 1,
    }
  }
  if (
    input.action === 'wait' &&
    input.ms === undefined &&
    !input.selector &&
    !input.text
  ) {
    return {
      result: false,
      message:
        'Browser action "wait" needs { "ms": <milliseconds> }, { "selector": "<css>" }, or { "text": "<visible text>" } (optional gone: true to wait for disappearance).',
      errorCode: 1,
    }
  }
  if (
    input.action === 'upload' &&
    input.files !== undefined &&
    input.files.length === 0
  ) {
    return {
      result: false,
      message:
        'Browser action "upload" needs at least one local file path in "files".',
      errorCode: 1,
    }
  }
  return { result: true }
}

/** Renders the observed interactive elements as a compact, ref-addressable list. */
function formatElements(observation: ObservedState): string {
  if (observation.interactive_elements.length === 0) {
    return '(no interactive elements found)'
  }
  const lines = observation.interactive_elements.map(el => {
    const label = el.text || el.aria || el.placeholder || ''
    const parts = [`@${el.id}`, el.tag]
    if (el.role && el.role !== el.tag) parts.push(`[${el.role}]`)
    if (label) parts.push(`"${label}"`)
    if (el.value) parts.push(`= "${el.value}"`)
    if (el.checked !== undefined) parts.push(el.checked ? '(checked)' : '(unchecked)')
    if (el.disabled) parts.push('(disabled)')
    if (el.frame) parts.push('[iframe]')
    if (el.repeatNote) parts.push(`(+${el.repeatNote} more similar)`)
    return parts.join(' ')
  })
  return lines.join('\n')
}

function formatTabs(tabs: TabInfo[]): string {
  if (tabs.length === 0) return '(no open tabs)'
  return tabs
    .map(
      t =>
        `${t.index}: ${t.active ? '* ' : '  '}${t.title || '(untitled)'} — ${t.url}`,
    )
    .join('\n')
}

function outcomeToOutput(
  action: Input['action'],
  outcome: BrowserActionOutcome,
  extraMessage?: string,
): BrowserOutput {
  const obs = outcome.observation
  const messageParts: string[] = []
  if (extraMessage) messageParts.push(extraMessage)
  if (!outcome.ok && outcome.error) messageParts.push(outcome.error)
  if (obs) {
    messageParts.push(`Now on: ${obs.title || '(untitled)'} — ${obs.url}`)
    if (obs.dismissed) messageParts.push(`(auto-dismissed overlay: ${obs.dismissed})`)
  }
  return {
    action,
    ok: outcome.ok,
    message: messageParts.filter(Boolean).join(' ') || (outcome.ok ? 'Done.' : 'Failed.'),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(obs ? { url: obs.url, title: obs.title, elementsText: formatElements(obs) } : {}),
    warnings: outcome.warnings,
  }
}

function errorOutput(
  action: Input['action'],
  message: string,
  reason?: string,
): BrowserOutput {
  return {
    action,
    ok: false,
    message,
    ...(reason ? { reason } : {}),
    warnings: [],
  }
}

/**
 * Resolves the human-readable label of the element an action will touch, for
 * the safety brake. Uses the cached observation for ref/coordinate targets.
 */
function riskForInput(input: Input, currentUrl?: string): BrowserRisk | null {
  const session = getBrowserSession()
  if (input.action === 'click') {
    if (input.ref !== undefined) {
      const el = session.getCachedElement(input.ref)
      return classifyBrowserRisk('click', el?.text, el?.placeholder, el?.aria)
    }
    if (input.text !== undefined) {
      return classifyBrowserRisk('click', input.text)
    }
    return null
  }
  if (input.action === 'fill' && input.ref !== undefined) {
    const el = session.getCachedElement(input.ref)
    return classifyBrowserRisk('fill', el?.text, el?.placeholder, el?.aria)
  }
  if (input.action === 'drag' && input.ref !== undefined) {
    const el = session.getCachedElement(input.ref)
    return classifyBrowserRisk('click', el?.text, el?.placeholder, el?.aria)
  }
  if (input.action === 'type' && input.submit) {
    return classifyPressRisk('enter', currentUrl)
  }
  if (input.action === 'press' && input.key) {
    return classifyPressRisk(input.key, currentUrl)
  }
  return null
}

function summarize(input: Partial<Input>): string {
  switch (input.action) {
    case 'navigate':
      return `Navigate to ${input.url ?? ''}`
    case 'open':
      return input.url ? `Open browser at ${input.url}` : 'Open browser'
    case 'observe':
      return 'Observe page'
    case 'read':
      return input.selector
        ? `Read page (${input.selector})`
        : input.offset
          ? `Read page from ${input.offset}`
          : 'Read page'
    case 'click':
      if (input.ref !== undefined)
        return `${input.double ? 'Double-click' : 'Click'} @${input.ref}`
      if (input.text) return `Click "${input.text}"`
      if (input.x !== undefined) return `Click (${input.x}, ${input.y})`
      return 'Click'
    case 'fill':
      return `Fill @${input.ref} = "${(input.value ?? '').slice(0, 30)}"`
    case 'type':
      return `Type "${(input.text ?? '').slice(0, 30)}"`
    case 'press':
      return `Press ${input.key}`
    case 'hover':
      return input.ref !== undefined
        ? `Hover @${input.ref}`
        : `Hover "${(input.text ?? '').slice(0, 30)}"`
    case 'scroll':
      return input.ref !== undefined
        ? `Scroll to @${input.ref}`
        : `Scroll ${input.direction}`
    case 'drag':
      return `Drag @${input.ref} → @${input.toRef}`
    case 'upload':
      return `Upload ${input.files?.length ?? 0} file(s) to @${input.ref}`
    case 'eval':
      return `Eval: ${(input.js ?? '').replace(/\s+/g, ' ').slice(0, 40)}`
    case 'dismiss':
      return 'Dismiss overlay'
    case 'wait':
      if (input.selector)
        return `Wait for ${input.selector}${input.gone ? ' to go' : ''}`
      if (input.text)
        return `Wait for "${input.text.slice(0, 25)}"${input.gone ? ' to go' : ''}`
      return `Wait ${input.ms ?? ''}ms`
    case 'screenshot':
      if (input.ref !== undefined) return `Screenshot @${input.ref}`
      if (input.full) return 'Screenshot (full page)'
      if (input.annotate) return 'Screenshot (annotated)'
      return 'Screenshot'
    case 'console':
      return `Console${input.level && input.level !== 'all' ? ` (${input.level})` : ''}`
    case 'network':
      return `Network${input.failed ? ' failures' : ''}`
    case 'pdf':
      return `Save PDF ${input.path ?? ''}`
    case 'resize':
      return input.width === 0 && input.height === 0
        ? 'Reset viewport'
        : `Resize to ${input.width}x${input.height}${input.mobile ? ' (mobile)' : ''}`
    case 'tabs':
      return 'List tabs'
    case 'new_tab':
      return `New tab${input.url ? ` ${input.url}` : ''}`
    case 'switch_tab':
      return `Switch to tab ${input.tabIndex}`
    case 'close_tab':
      return input.tabIndex !== undefined ? `Close tab ${input.tabIndex}` : 'Close tab'
    case 'back':
      return 'Go back'
    case 'forward':
      return 'Go forward'
    case 'reload':
      return input.hard ? 'Hard reload' : 'Reload'
    case 'close':
      return 'Close browser'
    default:
      return 'Browser'
  }
}

async function runAction(
  input: Input,
  context: ToolUseContext,
): Promise<BrowserOutput> {
  const session = getBrowserSession()
  const signal = context.abortController.signal

  // An explicit look at the page clears the blind-coordinate-click streak (the
  // trailing observe after every action must NOT, or the guard never trips).
  if (input.action === 'observe' || input.action === 'screenshot') {
    session.resetCoordinateGuard()
  }

  // Every action except open needs a running browser; start it lazily with a
  // clear message rather than failing, so a stray first call self-heals.
  if (input.action !== 'open' && !session.isRunning()) {
    if (input.action === 'close') {
      return { action: 'close', ok: true, message: 'Browser is already closed.', warnings: [] }
    }
    const started = await session.ensureStarted({ signal })
    if (input.action !== 'navigate' && input.action !== 'tabs') {
      // For a page action with no page yet, surface the auto-start and let the
      // model observe next rather than acting on about:blank.
      const { observation, warnings } = await session.observe(signal)
      return outcomeToOutput(
        input.action,
        { ok: true, observation, warnings },
        `Browser was not open, so I started it (${started.note}). Observe or navigate, then retry your ${input.action}.`,
      )
    }
  }

  switch (input.action) {
    case 'open': {
      const started = await session.ensureStarted({
        signal,
        headless: input.headless,
      })
      if (input.url) {
        await session.navigate(input.url, signal)
      }
      const { observation, warnings } = await session.observe(signal)
      const note =
        started.launched === 'already'
          ? 'Browser already running.'
          : started.note
      return outcomeToOutput(
        'open',
        { ok: true, observation, warnings },
        note,
      )
    }
    case 'navigate': {
      await session.navigate(input.url!, signal)
      const { observation, warnings } = await session.observe(signal)
      return outcomeToOutput('navigate', { ok: true, observation, warnings })
    }
    case 'observe': {
      const { observation, warnings } = await session.observe(signal)
      return outcomeToOutput('observe', { ok: true, observation, warnings })
    }
    case 'read': {
      const result = await session.readPage({
        selector: input.selector,
        offset: input.offset,
        maxChars: input.maxChars,
      })
      if (!result.success) {
        return errorOutput('read', result.error ?? 'Could not read the page.', result.reason)
      }
      const shown = result.content?.length ?? 0
      const total = result.total ?? shown
      const from = result.offset ?? 0
      const more = from + shown < total
      const range =
        total > shown
          ? `Characters ${from}–${from + shown} of ${total}.${more ? ` Continue with { "action": "read", "offset": ${from + shown} }.` : ''}`
          : ''
      return {
        action: 'read',
        ok: true,
        message: [`Read ${result.title || result.url || 'page'}.`, range]
          .filter(Boolean)
          .join(' '),
        url: result.url,
        title: result.title,
        pageText: result.content ?? '',
        warnings: session.drainSessionNotes(),
      }
    }
    case 'click': {
      const outcome = await session.click(
        {
          ref: input.ref,
          text: input.text,
          nth: input.nth,
          x: input.x,
          y: input.y,
          double: input.double,
        },
        signal,
      )
      return outcomeToOutput('click', outcome)
    }
    case 'hover': {
      const outcome = await session.hover(
        { ref: input.ref, text: input.text, nth: input.nth },
        signal,
      )
      return outcomeToOutput('hover', outcome)
    }
    case 'drag': {
      const outcome = await session.drag(input.ref!, input.toRef!, signal)
      return outcomeToOutput('drag', outcome)
    }
    case 'upload': {
      const outcome = await session.upload(input.ref!, input.files!, signal)
      return outcomeToOutput('upload', outcome)
    }
    case 'eval': {
      const result = await session.evalJs(input.js!)
      if (!result.ok) {
        return errorOutput('eval', `JavaScript failed: ${result.error}`)
      }
      return {
        action: 'eval',
        ok: true,
        message: 'JavaScript ran. If it changed the page, observe to get fresh refs.',
        value: result.value,
        warnings: session.drainSessionNotes(),
      }
    }
    case 'console': {
      const result = session.consoleLogs({
        level: input.level,
        filter: input.filter,
        limit: input.limit,
        clear: input.clear,
      })
      return {
        action: 'console',
        ok: true,
        message: `${result.captured} console entr${result.captured === 1 ? 'y' : 'ies'} captured on this tab${input.clear ? ' (buffer cleared)' : ''}.`,
        consoleText: result.text,
        warnings: session.drainSessionNotes(),
      }
    }
    case 'network': {
      const result = session.networkLog({
        filter: input.filter,
        failedOnly: input.failed,
        limit: input.limit,
        clear: input.clear,
      })
      return {
        action: 'network',
        ok: true,
        message: `${result.captured} request(s) captured on this tab${input.clear ? ' (buffer cleared)' : ''}.`,
        networkText: result.text,
        warnings: session.drainSessionNotes(),
      }
    }
    case 'pdf': {
      const saved = await session.pdf(input.path!)
      return {
        action: 'pdf',
        ok: true,
        message: `Saved the page as PDF (${Math.round(saved.bytes / 1024)} KB).`,
        savedPath: saved.savedPath,
        warnings: session.drainSessionNotes(),
      }
    }
    case 'resize': {
      const outcome = await session.resize(
        input.width!,
        input.height!,
        { mobile: input.mobile },
        signal,
      )
      return outcomeToOutput('resize', outcome)
    }
    case 'forward': {
      await session.goForward(signal)
      const { observation, warnings } = await session.observe(signal)
      return outcomeToOutput('forward', { ok: true, observation, warnings })
    }
    case 'reload': {
      await session.reload(input.hard ?? false, signal)
      const { observation, warnings } = await session.observe(signal)
      return outcomeToOutput('reload', { ok: true, observation, warnings })
    }
    case 'fill': {
      const outcome = await session.fill(input.ref!, input.value!, signal)
      return outcomeToOutput('fill', outcome)
    }
    case 'type': {
      const outcome = await session.typeText(input.text!, input.submit ?? false, signal)
      return outcomeToOutput('type', outcome)
    }
    case 'press': {
      const outcome = await session.press(input.key!, signal)
      return outcomeToOutput('press', outcome)
    }
    case 'scroll': {
      const outcome = await session.scroll(
        { direction: input.direction, amount: input.amount, ref: input.ref },
        signal,
      )
      return outcomeToOutput('scroll', outcome)
    }
    case 'dismiss': {
      const outcome = await session.dismissOverlay(signal)
      return outcomeToOutput('dismiss', outcome)
    }
    case 'wait': {
      const outcome = await session.waitAction(
        {
          ms: input.ms,
          selector: input.selector,
          text: input.text,
          gone: input.gone,
          timeoutMs: input.timeoutMs,
        },
        signal,
      )
      return outcomeToOutput('wait', outcome)
    }
    case 'screenshot': {
      const shot = await session.screenshot({
        full: input.full,
        ref: input.ref,
        path: input.path,
        annotate: input.annotate,
      })
      const messageParts = [
        shot.savedPath
          ? 'Saved a screenshot to a file.'
          : 'Captured a screenshot of the current tab.',
      ]
      if (shot.note) messageParts.push(shot.note)
      return {
        action: 'screenshot',
        ok: true,
        message: messageParts.join(' '),
        ...(shot.savedPath ? { savedPath: shot.savedPath } : {}),
        warnings: session.drainSessionNotes(),
        ...(shot.base64
          ? {
              screenshot: {
                base64: shot.base64,
                mediaType: shot.mediaType,
              },
            }
          : {}),
      }
    }
    case 'tabs': {
      const tabs = await session.listTabs()
      return {
        action: 'tabs',
        ok: true,
        message: `${tabs.length} open tab(s).`,
        tabsText: formatTabs(tabs),
        warnings: [],
      }
    }
    case 'new_tab': {
      await session.newTab(input.url)
      const { observation, warnings } = await session.observe(signal)
      return outcomeToOutput(
        'new_tab',
        { ok: true, observation, warnings },
        'Opened and switched to a new tab.',
      )
    }
    case 'switch_tab': {
      const tabs = await session.selectTab(input.tabIndex!)
      const { observation, warnings } = await session.observe(signal)
      return outcomeToOutput(
        'switch_tab',
        { ok: true, observation, warnings },
        `Switched to tab ${input.tabIndex}.\nOpen tabs:\n${formatTabs(tabs)}`,
      )
    }
    case 'close_tab': {
      const tabs = await session.closeTab(input.tabIndex)
      return {
        action: 'close_tab',
        ok: true,
        message: `Closed tab. ${tabs.length} tab(s) remaining.`,
        tabsText: formatTabs(tabs),
        warnings: [],
      }
    }
    case 'back': {
      await session.goBack(signal)
      const { observation, warnings } = await session.observe(signal)
      return outcomeToOutput('back', { ok: true, observation, warnings })
    }
    case 'close': {
      await session.closeBrowser()
      return { action: 'close', ok: true, message: 'Closed the browser.', warnings: [] }
    }
  }
}

function toTextContent(output: BrowserOutput): string {
  const lines: string[] = []
  lines.push(output.ok ? output.message : `Error: ${output.message}`)
  if (output.reason) lines.push(`Reason: ${output.reason}`)
  if (output.savedPath) lines.push(`Saved to: ${output.savedPath}`)
  if (output.warnings.length > 0) {
    lines.push('', 'Attention:')
    for (const w of output.warnings) lines.push(`- ${w}`)
  }
  if (output.value !== undefined) {
    lines.push('', 'Result:', output.value)
  }
  if (output.pageText !== undefined) {
    lines.push('', 'Page content:', output.pageText || '(no readable content found)')
  }
  if (output.consoleText) {
    lines.push('', 'Console:', output.consoleText)
  }
  if (output.networkText) {
    lines.push('', 'Requests:', output.networkText)
  }
  if (output.tabsText) {
    lines.push('', 'Tabs:', output.tabsText)
  }
  if (output.elementsText) {
    lines.push('', 'Interactive elements (use @N as ref):', output.elementsText)
  }
  return lines.join('\n')
}

export const BrowserTool = buildTool({
  name: BROWSER_TOOL_NAME,
  searchHint: 'control real chrome browser click type navigate dom automation',
  // Kept modest on purpose: a browsing session appends one observation per
  // action, so an outlier huge page is spilled to disk (retrievable) rather
  // than left to saturate the window. Typical observations are well under
  // this; the ceiling exists for read with an explicit large maxChars.
  maxResultSizeChars: 32_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Browser'
  },
  getToolUseSummary(input) {
    return input ? summarize(input) : 'Browser'
  },
  getActivityDescription(input) {
    return input ? summarize(input) : null
  },
  isReadOnly(input) {
    return (
      input.action === 'observe' ||
      input.action === 'read' ||
      input.action === 'screenshot' ||
      input.action === 'console' ||
      input.action === 'network' ||
      input.action === 'tabs' ||
      input.action === 'wait'
    )
  },
  isConcurrencySafe() {
    // A single shared browser session — parallel actions would race on tabs.
    return false
  },
  isDestructive(input) {
    return (
      input.action === 'click' ||
      input.action === 'fill' ||
      input.action === 'type' ||
      input.action === 'drag' ||
      input.action === 'upload' ||
      input.action === 'eval'
    )
  },
  isOpenWorld() {
    return true
  },
  toAutoClassifierInput(input) {
    return {
      action: input.action,
      url: input.url,
      ref: input.ref,
      toRef: input.toRef,
      text: input.text,
      valueLength: input.value?.length,
      key: input.key,
      submit: input.submit,
      direction: input.direction,
      fileCount: input.files?.length,
      jsLength: input.js?.length,
      selector: input.selector,
      path: input.path,
    }
  },
  async validateInput(input) {
    return validateBrowserInput(input)
  },
  async checkPermissions(input): Promise<PermissionResult> {
    const risk = riskForInput(input, getBrowserSession().getLastKnownUrl())
    if (risk) {
      return {
        behavior: 'ask',
        message: `This browser action looks like a ${risk.kind} action ("${risk.label}"). Confirm before Tau runs it.`,
      }
    }
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage(input) {
    return <Text>{summarize(input)}</Text>
  },
  renderToolResultMessage(output) {
    if (output.action === 'screenshot' && output.screenshot) {
      return <Text>Captured a screenshot.</Text>
    }
    if (output.action === 'read' && output.ok) {
      return <Text>Read {output.title || output.url || 'the page'}.</Text>
    }
    const head = output.ok ? output.message : `Error: ${output.message}`
    return <Text>{head}</Text>
  },
  extractSearchText(output) {
    return [
      output.message,
      output.pageText,
      output.value,
      output.consoleText,
      output.networkText,
      output.elementsText,
      output.tabsText,
    ]
      .filter(Boolean)
      .join('\n')
  },
  isResultTruncated(output) {
    return (
      !!output.elementsText ||
      !!output.tabsText ||
      !!output.pageText ||
      !!output.consoleText ||
      !!output.networkText
    )
  },
  async call(input, context) {
    try {
      const data = await runAction(input, context)
      return { data }
    } catch (error) {
      if (context.abortController.signal.aborted) {
        return { data: errorOutput(input.action, 'Browser action was interrupted.') }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { data: errorOutput(input.action, message) }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.action === 'screenshot' && output.screenshot) {
      const caption = [
        output.message || 'Screenshot of the current tab.',
        ...(output.warnings.length > 0
          ? ['Attention:', ...output.warnings.map(w => `- ${w}`)]
          : []),
      ].join('\n')
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: output.screenshot
                .mediaType as Base64ImageSource['media_type'],
              data: output.screenshot.base64,
            },
          },
          { type: 'text', text: caption },
        ],
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: toTextContent(output),
      is_error: output.ok ? undefined : true,
    }
  },
} satisfies ToolDef<InputSchema, BrowserOutput>)
