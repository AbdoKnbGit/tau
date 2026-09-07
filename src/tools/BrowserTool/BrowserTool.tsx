import type {
  Base64ImageSource,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { existsSync } from 'fs'
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
  normalizeUrlForNavigation,
  type BrowserActionOutcome,
  type TabInfo,
} from '../../services/browser/browserSession.js'
import type { ObservedState } from '../../services/browser/pageScripts.js'
import { formatEffect, isMutatingAction } from '../../services/browser/effects.js'
import { formatExtract } from '../../services/browser/extract.js'
import {
  deleteFlow,
  describeStep,
  formatFlow,
  listFlows,
  loadFlow,
  saveFlow,
  type Flow,
  FLOW_FORMAT_VERSION,
} from '../../services/browser/flows.js'
import {
  buildStepFromAction,
  replayStep,
  type ObservedElementLike,
} from '../../services/browser/flowRunner.js'
import { runSurfaceLadder } from '../../services/browser/surfaceLadder.js'
import { formatVisionReceipt } from '../../services/browser/imageMeta.js'
import { formatMeasure } from '../../services/browser/measure.js'
import {
  formatWatchReport,
  parseWatchSpec,
  type WatchCondition,
} from '../../services/browser/watch.js'
import type { PermissionResult } from '../../types/permissions.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { BROWSER_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Drive a real Chrome/Edge browser: read a page the cheap way (HTTP first, browser only when needed), observe numbered elements, click, fill, type, drag, upload, run JS, measure what actually rendered, extract structured data with provenance, watch for console/network errors, record and replay flows, screenshot, and manage tabs. Every action reports what it actually changed. One tool, one action per call.'

const PROMPT = `Operate a real Chromium browser (Chrome, Edge, or Brave) through the DevTools protocol. Unlike WebBrowser/InspectSite (static HTML fetch), this runs JavaScript: it works on React/Vue/SPA pages, clicks and types through real trusted input, reads the rendered DOM (including same-origin iframes), extracts page content as markdown, runs JS in the page, watches console/network (great for debugging web apps you are developing), uploads files, and handles tabs, dialogs, and downloads.

THE ONE RULE THAT PREVENTS ERRORS: every call is { "action": "<name>", ...params for that action }. Pick exactly one action. Provide only that action's params. Most actions return a fresh page observation, so continue from the returned state instead of guessing.

EVIDENCE — THE PART THAT KEEPS YOU HONEST:
- Every result carries an "Effect:" line: step number, whether the url changed, whether it is still the same document, how the interactive DOM moved, and how long it took. It is proof the action did something.
- "NO OBSERVABLE EFFECT" means the url, the document, the DOM and the scroll position are all unchanged: your action did nothing. Do NOT repeat it with a tweak. Observe or screenshot, then act differently.
- "unverified" means the page could not be sampled. Treat it as unknown, not as success.
- NEVER describe how a page LOOKS unless a screenshot in this same turn returned a "vision token". A screenshot saved with { "path": ... } is NOT shown to you and mints no token — you may say where it was saved, nothing about its appearance. Reading the source of a component is not seeing it.
- For visual facts without an image, use measure: it returns what actually painted (colors, fonts that failed to load, contrast ratios, broken images, overflow).

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
- A click whose centre is covered is NOT abandoned: I click an uncovered point inside the target and tell you the centre was blocked. If that click then has no effect, the overlap is the likely reason.
- When an action has no effect and the target's own state explains it (already selected, already pressed, disabled, inside a <select> that did not change value), the result says so. That is an answer, not a failure to retry.
The tool BLOCKS repeated blind coordinate clicks on purpose (reason "coordinate_guessing"). That is a signal to stop guessing and observe/screenshot — not a hint to try yet another coordinate.

CLOSING MODALS / POPUPS / OVERLAYS: use { "action": "dismiss" }. It finds the topmost dialog/popup/drawer/lightbox and clicks its close control (or sends Escape). Do NOT hunt for the X with coordinates. Cookie/consent banners are auto-dismissed on observe.

SEE / READ:
- get — { url, surface?, maxChars? } READ A PAGE THE CHEAP WAY. Fetches over HTTP first and only starts the browser when the bytes prove it is needed (empty SPA shell, bot wall, 403/429, timeout). The reply always says which rung answered ("rung=http" or "rung=chromium · escalated from http: ..."). Use this instead of open+navigate+read for anything you only want to READ. surface: "http" or "chromium" forces one rung.
- measure — no params. MEASURED FACTS about what rendered: viewport, painted background/text colors by area, fonts that fell back because they never loaded, WCAG contrast failures with real ratios, broken and oversized images, elements overflowing the viewport, running animations, landmark boxes. This is how you check a UI without inventing it.
- extract — { fields, container?, limit? } STRUCTURED SCRAPING WITH PROVENANCE. { "container": "article.product", "fields": { "name": ".title", "price": ".price", "link": "a@href" } }. Every value comes back with the selector that produced it, plus warnings you cannot get any other way: a selector that matched nothing, one that matched the same value in every row (it is reaching outside the row), one that matched several elements, and links that are really login/redirect/wishlist URLs rather than item URLs. If the container matches nothing you get the page's actual repeating structures to choose from. Nothing outside that table came from the page — do not fill gaps from memory.
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

STANDING WATCH (the dev loop):
- watch — { conditions: [...] } registers what you care about; { } with no conditions checks them. Conditions: console.error, console.warn, console.any, request.failed (all accept an optional ":substring" filter), selector.appears:CSS, selector.gone:CSS, text.appears:TEXT, url.matches:SUBSTRING.
- Register once, then keep working: new console errors and failed requests are attached to the warnings of your later browser calls, so a runtime error in the app you are editing finds you instead of costing a console read every turn. Page conditions (selector/text/url) are evaluated when you call watch.

FLOWS (stop paying for the same login twice):
- Your successful navigate/click/fill/type/press/scroll/wait/dismiss actions are recorded automatically, by label rather than by @ref.
- flow { mode: "save", name: "login" } writes them to .tau/flows/<name>.json. { mode: "run", name: "login" } replays them with no further calls from you and stops at the first step that no longer matches, naming that step. { mode: "list" }, { mode: "delete", name }, { mode: "clear" } (drop the recording and start fresh).
- Replay is also the cheapest UI regression test you have: if a flow that worked yesterday diverges today, the step it names is what changed.

TABS: tabs (list) / new_tab { url? } / switch_tab { tabIndex } / close_tab { tabIndex? }. A click that opens a new tab switches to it automatically.
close — shut the browser down when the task is finished.

AUTOMATIC BEHAVIORS (read the warnings, do not fight them):
- JS dialogs (alert/confirm/prompt) are auto-accepted so they can never wedge the session; the dialog text shows up in warnings.
- Downloads land in a known folder; "Download finished: name → path" appears in warnings.
- Consent banners auto-dismissed; new tabs from clicks auto-followed; hidden lazy content nudged awake.
- If the user focuses or interacts with another browser tab, the tool follows that active tab automatically and reports the handoff in warnings.

RECOVERY (the reason field tells you which happened — adjust, do not retry blindly):
- stale_ref — the page changed since your last observe. Observe and use the new refs.
- element_covered — something is on top of your target, and the message says WHICH KIND, because the fix differs:
  · a dialog/drawer/layer → dismiss it (the message says how many layers are open; close the topmost first), then retry with a fresh ref.
  · fixed or sticky page furniture (header, language bar, cookie strip) → dismiss does nothing to page chrome. Scroll, or act on something else.
  · a normal element painted above (z-index) → I already tried several points across the target and every one hit the blocker. Retrying is pointless and dismiss does not apply: it is a stacking defect in the page. Report it, or act on the covering element.
  · no visible area → the element is off-screen or still animating in. Wait or scroll, then re-observe.
  If the same blocker stops you twice the message says so: stop retrying and change approach.
- coordinate_guessing — you are clicking blind coordinates. Stop. Observe (refs) or screenshot (see), then act by ref/text.
- not_editable — that element is not an input, or it rejected text. Click the actual input first, or fill a different element.
- no_match — your text/selector matched nothing (or only a negation like "Don't allow"). Observe and act by ref.
- timeout — the waited-for condition never came. Read or observe to see what the page did instead.
CAPTCHA/login walls are flagged in warnings — stop and ask the user to handle them in the browser window, then continue. (Anti-detection measures are on, so these should be rare.)

SAFETY: actions that clearly pay, purchase, delete, or enter card data pause for user confirmation. Do not try to route around that; it is intended.

Prefer this tool over the Computer tool for anything inside a web page — it is DOM-aware and does not burn tokens on screenshots for every step.`

const ACTIONS = [
  'open',
  'get',
  'navigate',
  'observe',
  'read',
  'measure',
  'extract',
  'watch',
  'flow',
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
    surface: z
      .enum(['auto', 'http', 'chromium'])
      .optional()
      .describe(
        'For get: which surface to use. auto (default) tries HTTP first and escalates to the browser only when the HTML turns out to be a shell or a bot wall.',
      ),
    container: z
      .string()
      .optional()
      .describe(
        'For extract: CSS selector matching one repeating row (e.g. "article.product"). Omit to extract a single row from the whole document.',
      ),
    fields: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'For extract: { columnName: "selector" }. Add "@attr" to read an attribute instead of text ("a@href", "@data-id"); "." means the row element itself.',
      ),
    conditions: z
      .array(z.string())
      .optional()
      .describe(
        'For watch: conditions to register, e.g. ["console.error", "request.failed", "selector.gone:.spinner", "text.appears:Order placed", "url.matches:/checkout"]. Omit to check the ones already registered.',
      ),
    name: z
      .string()
      .optional()
      .describe('For flow save/run/delete: the flow name.'),
    mode: z
      .enum(['save', 'run', 'list', 'delete', 'clear'])
      .optional()
      .describe('For flow: what to do. Default list.'),
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
    /** Proof-of-effect line: what this action actually changed. */
    receipt: z.string().optional(),
    /** Vision receipt: whether the image was seen, and its citation token. */
    vision: z.string().optional(),
    /** Which surface answered a get, and why it escalated. */
    rung: z.string().optional(),
    /** Rendered block for measure / extract / watch / flow. */
    detailText: z.string().optional(),
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
  get: ['url'],
  extract: ['fields'],
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
  if (
    input.action === 'extract' &&
    input.fields !== undefined &&
    Object.keys(input.fields).length === 0
  ) {
    return {
      result: false,
      message:
        'Browser action "extract" needs at least one field, e.g. { "fields": { "name": ".title", "price": ".price" } }.',
      errorCode: 1,
    }
  }
  if (input.action === 'flow') {
    const mode = input.mode ?? 'list'
    if ((mode === 'save' || mode === 'run' || mode === 'delete') && !input.name?.trim()) {
      return {
        result: false,
        message: `Browser action "flow" with mode "${mode}" needs { "name": "<flow name>" }.`,
        errorCode: 1,
      }
    }
  }
  if (input.action === 'watch' && input.conditions !== undefined) {
    const bad = input.conditions
      .map(spec => ({ spec, parsed: parseWatchSpec(spec) }))
      .filter(entry => 'error' in entry.parsed)
    if (bad.length > 0) {
      return {
        result: false,
        message: bad
          .map(entry => (entry.parsed as { error: string }).error)
          .join(' '),
        errorCode: 1,
      }
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
    case 'get':
      return `Get ${input.url ?? ''}`
    case 'observe':
      return 'Observe page'
    case 'measure':
      return 'Measure rendered page'
    case 'extract':
      return `Extract ${Object.keys(input.fields ?? {}).join(', ') || 'fields'}`
    case 'watch':
      return input.conditions?.length
        ? `Watch ${input.conditions.join(', ')}`
        : 'Check watches'
    case 'flow':
      return `Flow ${input.mode ?? 'list'}${input.name ? ` "${input.name}"` : ''}`
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

/** Maps the shared surface ladder onto this tool's output shape. */
async function runGet(
  input: Input,
  context: ToolUseContext,
): Promise<BrowserOutput> {
  const result = await runSurfaceLadder(getBrowserSession(), {
    url: normalizeUrlForNavigation(input.url!, existsSync),
    ...(input.surface ? { surface: input.surface } : {}),
    ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
    signal: context.abortController.signal,
  })
  return {
    action: 'get',
    ok: result.ok,
    message: result.message,
    rung: result.rung,
    ...(result.url ? { url: result.url } : {}),
    ...(result.title ? { title: result.title } : {}),
    ...(result.text !== undefined ? { pageText: result.text } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    warnings: result.warnings,
  }
}

/** save / run / list / delete / clear over project-local `.tau/flows`. */
async function runFlow(
  input: Input,
  context: ToolUseContext,
): Promise<BrowserOutput> {
  const session = getBrowserSession()
  const signal = context.abortController.signal
  const cwd = getCwd()
  const mode = input.mode ?? 'list'

  if (mode === 'list') {
    const flows = listFlows(cwd)
    return {
      action: 'flow',
      ok: true,
      message: flows.length === 0 ? 'No flows saved in this project yet.' : `${flows.length} saved flow(s).`,
      detailText:
        flows.length === 0
          ? 'Act in the browser, then save what you did with { "action": "flow", "mode": "save", "name": "login" }.'
          : flows
              .map(
                flow =>
                  `  ${flow.name} · ${flow.steps} step(s)${flow.createdAt ? ` · ${flow.createdAt}` : ''}${flow.startUrl ? ` · from ${flow.startUrl}` : ''}${flow.problem ? ` · ⚠ ${flow.problem}` : ''}`,
              )
              .join('\n'),
      warnings: [],
    }
  }

  if (mode === 'clear') {
    session.clearRecording()
    return {
      action: 'flow',
      ok: true,
      message: 'Cleared the step recording. Everything you do from now on records fresh.',
      warnings: [],
    }
  }

  if (mode === 'delete') {
    const removed = deleteFlow(cwd, input.name!)
    return {
      action: 'flow',
      ok: removed,
      message: removed
        ? `Deleted flow "${input.name}".`
        : `No flow named "${input.name}" to delete.`,
      warnings: [],
    }
  }

  if (mode === 'save') {
    const recorded = session.recordedFlow()
    if (recorded.steps.length === 0) {
      return errorOutput(
        'flow',
        'Nothing has been recorded yet. Drive the browser first (navigate, click, fill, …), then save.',
      )
    }
    const flow: Flow = {
      version: FLOW_FORMAT_VERSION,
      name: input.name!,
      createdAt: new Date().toISOString(),
      ...(recorded.startUrl ? { startUrl: recorded.startUrl } : {}),
      steps: recorded.steps,
    }
    let savedPath: string
    try {
      savedPath = saveFlow(cwd, flow)
    } catch (error: unknown) {
      return errorOutput(
        'flow',
        error instanceof Error ? error.message : String(error),
      )
    }
    return {
      action: 'flow',
      ok: true,
      message: `Saved ${flow.steps.length} recorded step(s) as flow "${input.name}".`,
      savedPath,
      detailText: formatFlow(flow),
      warnings: [],
    }
  }

  const loaded = loadFlow(cwd, input.name!)
  if ('error' in loaded) return errorOutput('flow', loaded.error)
  if (loaded.steps.length === 0) {
    return errorOutput('flow', `Flow "${loaded.name}" has no steps.`)
  }
  if (!session.isRunning()) {
    await session.ensureStarted({ signal })
  }
  const trace: string[] = []
  for (const [index, step] of loaded.steps.entries()) {
    const position = `step ${index + 1}/${loaded.steps.length} (${describeStep(step)})`
    if (step.unreplayable) {
      trace.push(`  ✗ ${position} — recorded as unreplayable: ${step.unreplayable}`)
      return {
        action: 'flow',
        ok: false,
        message: `Flow "${loaded.name}" stopped at ${position}.`,
        reason: 'flow_unreplayable',
        url: session.getLastKnownUrl(),
        detailText: trace.join('\n'),
        warnings: session.drainSessionNotes(),
      }
    }
    const outcome = await replayStep(session, step, signal)
    if (!outcome.ok) {
      trace.push(`  ✗ ${position} — ${outcome.error}`)
      return {
        action: 'flow',
        ok: false,
        message: `Flow "${loaded.name}" diverged at ${position}: ${outcome.error}. The page has changed since the flow was recorded; re-record it or fix the step.`,
        reason: 'flow_diverged',
        url: session.getLastKnownUrl(),
        detailText: trace.join('\n'),
        warnings: session.drainSessionNotes(),
      }
    }
    trace.push(`  ✓ ${position}`)
  }
  const { observation, warnings } = await session.observe(signal)
  return {
    action: 'flow',
    ok: true,
    message: `Replayed all ${loaded.steps.length} step(s) of "${loaded.name}". Now on: ${observation.title || '(untitled)'} — ${observation.url}`,
    url: observation.url,
    title: observation.title,
    elementsText: formatElements(observation),
    detailText: trace.join('\n'),
    warnings,
  }
}

async function runActionInner(
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
    case 'get':
      return runGet(input, context)
    case 'measure': {
      const measured = await session.measurePage()
      return {
        action: 'measure',
        ok: true,
        message: `Measured the rendered page at ${measured.document.url}.`,
        url: measured.document.url,
        title: measured.document.title,
        detailText: formatMeasure(measured),
        warnings: session.drainSessionNotes(),
      }
    }
    case 'extract': {
      const fields = input.fields ?? {}
      const extracted = await session.extractData({
        container: input.container,
        fields,
        limit: Math.min(Math.max(input.limit ?? 20, 1), 200),
      })
      if (!extracted.ok) {
        return errorOutput('extract', extracted.error ?? 'Extraction failed.')
      }
      return {
        action: 'extract',
        ok: true,
        message: `Extracted ${extracted.rows.length} row(s) with provenance.`,
        url: extracted.url,
        title: extracted.title,
        detailText: formatExtract(extracted, Object.keys(fields)),
        warnings: session.drainSessionNotes(),
      }
    }
    case 'watch': {
      const registered = input.conditions
        ? session.watchAdd(
            input.conditions
              .map(spec => parseWatchSpec(spec))
              .filter((parsed): parsed is WatchCondition => !('error' in parsed)),
          )
        : session.watchList()
      const alerts = session.drainWatchAlerts()
      const dom = await session.watchCheckDom()
      return {
        action: 'watch',
        ok: true,
        message: input.conditions
          ? `Watching ${registered.length} condition(s).`
          : `Checked ${registered.length} watch condition(s).`,
        detailText: formatWatchReport({
          conditions: registered,
          alerts,
          dom,
          ...(session.captureBufferFull()
            ? {
                droppedHint:
                  'The console/network capture ring is full (300 entries per tab), so older events may have been dropped before this check.',
              }
            : {}),
        }),
        warnings: session.drainSessionNotes(),
      }
    }
    case 'flow':
      return runFlow(input, context)
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
      // A capture that only reached disk is explicitly not citable: the model
      // never saw those pixels and must not describe them.
      const vision = shot.meta
        ? formatVisionReceipt(shot.meta, {
            step: session.currentStep(),
            seen: !!shot.base64,
            ...(shot.savedPath ? { savedPath: shot.savedPath } : {}),
          })
        : undefined
      return {
        action: 'screenshot',
        ok: true,
        message: messageParts.join(' '),
        ...(shot.savedPath ? { savedPath: shot.savedPath } : {}),
        ...(vision ? { vision } : {}),
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

/** Records the action that just succeeded as a replayable step. */
function recordActionAsStep(
  input: Input,
  element: ObservedElementLike | undefined,
  siblings: ObservedElementLike[],
): void {
  const step = buildStepFromAction(input, element, siblings)
  if (step) getBrowserSession().recordStep(step)
}

/** Names the agent driving this call, for advisory tab ownership. */
function currentAgent(): { agentId: string; label: string } {
  const context = getAgentContext()
  if (!context) return { agentId: 'main', label: 'the main session' }
  const named = 'subagentName' in context ? context.subagentName : undefined
  return {
    agentId: context.agentId,
    label: named ? `subagent "${named}"` : `agent ${context.agentId.slice(0, 8)}`,
  }
}

/**
 * Every action carries a receipt.
 *
 * The whole switch is wrapped, so the trailing observe is inside the measured
 * window: a click that changes nothing, followed by an observe that dismisses a
 * newly-appeared consent banner, reads as "dom changed" rather than a no-op.
 * That direction is deliberate — the failure this guards against is a silent
 * no-op reported as success, and a missed verdict is better than a false alarm.
 *
 * Serialization comes with it: `withEffect` runs one action at a time per
 * session, so two concurrent agents cannot interleave inside a single action.
 */
async function runAction(
  input: Input,
  context: ToolUseContext,
): Promise<BrowserOutput> {
  const session = getBrowserSession()
  // Closing tears down the page the receipt would sample; there is nothing
  // left to prove and nothing left to race with.
  if (input.action === 'close') return runActionInner(input, context)

  const ownershipWarnings: string[] = []
  if (session.isRunning() && isMutatingAction(input.action)) {
    const previousOwner = session.claimActiveTab(currentAgent())
    if (previousOwner) {
      ownershipWarnings.push(
        `This tab was last driven by ${previousOwner}; you have taken it over. Its refs are stale for that agent — re-observe before trusting anything it reported.`,
      )
    }
  }
  // Resolve the ref to a durable label BEFORE acting: the trailing observe
  // rebuilds the element cache, and a step recorded afterwards can point at a
  // different element.
  const targetElement =
    input.ref !== undefined ? session.getCachedElement(input.ref) : undefined
  // The label is only unambiguous relative to what else was on screen.
  const targetSiblings = input.ref !== undefined ? session.getCachedElements() : []

  const { result, effect } = await session.withEffect(
    input.action,
    () => runActionInner(input, context),
    {
      producedValue: output =>
        output.action === 'eval'
          ? output.value !== undefined && output.value !== 'undefined'
          : false,
    },
  )
  if (result.ok) recordActionAsStep(input, targetElement, targetSiblings)
  // "Nothing happened" is more useful with a cause attached.
  const noEffectNotes: string[] = []
  if (effect.noop && input.ref !== undefined) {
    const explained = await session.explainNoEffect(input.ref)
    if (explained?.known && explained.reasons?.length) {
      noEffectNotes.push(
        `Nothing changed because ${explained.reasons.join('; ')}${explained.label ? ` (target: "${explained.label}")` : ''}.`,
      )
    }
  }
  const alerts = session.drainWatchAlerts()
  const watchWarnings = alerts
    .slice(0, 10)
    .map(alert => `watch [${alert.spec}] ${alert.detail}`)
  if (alerts.length > 10) {
    watchWarnings.push(`watch: ${alerts.length - 10} more alert(s); check with { "action": "watch" }.`)
  }
  const warnings = [
    ...result.warnings,
    ...noEffectNotes,
    ...ownershipWarnings,
    ...watchWarnings,
  ]
  return {
    ...result,
    warnings,
    ...(input.action === 'open' ? {} : { receipt: formatEffect(effect) }),
  }
}

function toTextContent(output: BrowserOutput): string {
  const lines: string[] = []
  lines.push(output.ok ? output.message : `Error: ${output.message}`)
  if (output.reason) lines.push(`Reason: ${output.reason}`)
  if (output.rung) lines.push(output.rung)
  if (output.receipt) lines.push(`Effect: ${output.receipt}`)
  if (output.vision) lines.push(output.vision)
  if (output.savedPath) lines.push(`Saved to: ${output.savedPath}`)
  if (output.warnings.length > 0) {
    lines.push('', 'Attention:')
    for (const w of output.warnings) lines.push(`- ${w}`)
  }
  if (output.value !== undefined) {
    lines.push('', 'Result:', output.value)
  }
  if (output.detailText) {
    lines.push('', output.detailText)
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
      input.action === 'wait' ||
      input.action === 'measure' ||
      input.action === 'extract' ||
      input.action === 'watch' ||
      // Listing flows only reads .tau/flows; saving writes and running acts.
      (input.action === 'flow' && (input.mode ?? 'list') === 'list')
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
      input.action === 'eval' ||
      // A replay re-performs every click and fill it recorded.
      (input.action === 'flow' && input.mode === 'run')
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
    // One line, never the refreshed observation: @refs are an agent-side
    // addressing detail and mean nothing to the person watching.
    const firstSentence = output.message.split(/(?<=\.)\s/)[0] ?? output.message
    const head = output.ok
      ? firstSentence
      : `Failed: ${firstSentence}${output.reason ? ` (${output.reason})` : ''}`
    return <Text>{head.slice(0, 300)}</Text>
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
      // A page that did not do what was asked is a RESULT, not a tool failure:
      // it carries a reason, a refreshed observation and a way forward, and the
      // whole recovery block gets dumped into the transcript when it is flagged
      // as an error. Reserve the flag for calls that genuinely could not run.
      is_error: !output.ok && !output.reason ? true : undefined,
    }
  },
} satisfies ToolDef<InputSchema, BrowserOutput>)
