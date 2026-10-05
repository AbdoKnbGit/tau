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
import { formatPicked } from '../../services/browser/pick.js'
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
  'Drive a real Chrome/Edge browser: read a page the cheap way (HTTP first, browser only when needed), observe numbered elements, click, fill, type, drag, upload, run JS, measure what actually rendered, extract structured data with provenance, watch for console/network errors, record and replay flows, screenshot, let the user point at the element they mean, and manage tabs. Every action reports what it actually changed. One tool, one action per call.'

const PROMPT = `Operate real Chromium (Chrome/Edge/Brave) through DevTools. Unlike a plain HTTP fetch, this runs JavaScript (React/Vue/SPA pages), clicks and types through real trusted input, and reads the rendered DOM, same-origin iframes included. Inside web pages prefer it to the Computer tool: it is DOM-aware and needs no screenshot per step.

RULES
- THE ONE RULE: each call is { "action": "name", ...that action's params }. Exactly one action; only its params.
- Loop: open once; observe before acting on a page you have not seen; act by @ref from the latest observation of the current tab, or by visible text. Most actions return a fresh observation: continue from it instead of guessing, and after DOM changes use its refs. observe finds what to act on; read is how you read.
- NEVER guess coordinates for buttons, links, menus or close controls (the #1 source of wasted steps): coordinates are blind, and a guess clicks the wrong element (a nav link, another product) and destroys progress. x/y are ONLY for canvas/map/video/drawing surfaces without DOM targets, after a screenshot shows the location. ref/text override x/y. coordinate_guessing blocks blind clicks: stop, observe/screenshot, then use ref/text, not another coordinate.
- Modals, popups, drawers, overlays: dismiss; never hunt the X with coordinates.
- Every result has "Effect:" (step, URL/document change, DOM movement, elapsed time). "NO OBSERVABLE EFFECT" means URL, document, DOM and scroll are unchanged: the action did nothing; do NOT repeat it with a tweak. "unverified" means the page could not be sampled: unknown, not success.
- When an action fails or does nothing, SEE the page, never try other numbers: re-observe for fresh refs (most failures are a changed DOM) or screenshot ({ "annotate": true } puts @N badges on what you see), then act by ref/text. After two failures of one tactic or blocker, change approach.
- When the result attributes no effect to already selected/pressed, disabled, or unchanged select state, accept that explanation rather than retrying. If a target's centre is covered, the tool itself clicks an uncovered point inside it and says so; if that click still does nothing, the overlap is the likely cause.
- NEVER describe appearance unless this turn's screenshot returned a "vision token" AND you received the image. Source code, OCR, another model's description, "[image not sent ...]", and screenshots saved via path are not seeing. Saved screenshots mint no token: report the path only. For visual facts without an image, use measure.

READ / SEE
- get { url, surface?, maxChars? }: read a page the cheap way; use it instead of open+navigate+read for anything you only need to READ. HTTP first; Chromium only when the bytes prove it is needed (empty SPA shell, bot wall, 403/429, timeout). The reply names the rung: rung=http, or rung=chromium with the escalation reason. surface:"http"|"chromium" forces one.
- observe: URL, title, scroll state and elements as @N tag "text" [role]; fields are named by their label. States: checked/unchecked, expanded/collapsed, selected, current page, pressed/not pressed, required, invalid, disabled. Same-origin iframe elements are marked [iframe] and work like any ref.
- read { selector?, maxChars?, offset? }: rendered markdown with [text](url) links; defaults to the main content; selector scopes it (e.g. "#docs"). Long pages report their total length: page on with the offset each reply gives. Pages end at a sentence or paragraph. If the page shifted, the reply re-finds your place; if your text is gone it says stale_read instead of stitching two versions.
- measure: what actually painted: viewport, background/text colors by area, fonts that fell back, WCAG contrast failures with real ratios, broken/oversized images, overflow, running animations, landmark boxes. Check a UI with it instead of inventing.
- extract { fields, container?, limit? }: e.g. { "container":"article.product", "fields":{ "name":".title", "price":".price", "link":"a@href" } }. Every value comes with the selector that produced it; warnings flag selectors matching nothing or several elements, the same value in every row (the selector escaped the row), and login/redirect/wishlist links posing as item URLs. An unmatched container returns the page's actual repeating structures. Nothing outside that table came from the page. Never fill missing data from memory.
- pick { text? }: only for a genuinely ambiguous target or the user's "this one", never to explore; visible browser only. The user's pointer outlines elements; their click returns the enclosing link/button/heading as the first @N, marked (picked), with tag, selector and text. Tell them to click once the "Tau:" bar shows; an earlier click reaches the page. Esc cancels; waits up to 2 minutes. The page ignores the pointer while picking: hover-open menus first.
- screenshot { full?, ref?, annotate?, path? }: viewport by default; full:true whole page; ref one element; annotate:true overlays the latest @N badges. path saves instead of sending an image (use when the user wants the file, not you).
- console { level?, filter?, limit?, clear? }: this tab's messages and uncaught exceptions; level error|warn|info|log|all.
- network { filter?, failed?, limit?, clear?, bodies? }: this tab's requests as METHOD status url [type]; failed:true only errors/4xx/5xx; bodies:true adds request and response bodies of the newest listed requests (up to 3; narrow with filter), truncated, credentials masked. Debug the app you are building with console + network.

NAVIGATE / ACT
- open { url?, headless? }: launch/attach, once; headless defaults false so the user sees the window.
- navigate { url }: http(s) or an existing local HTML file (open what you just built); "localhost:3000" gets http://, local paths file://.
- back / forward: history. reload { hard? }: hard:true bypasses the cache (after a rebuild).
- wait: { ms }, { selector, timeoutMs?, gone? } or { text, timeoutMs?, gone? }: waits for the selector/text to appear, or with gone:true to disappear (e.g. a spinner).
- click { ref } (strongly preferred), or { text, nth? }; { x, y } only for the non-DOM surfaces above. double:true double-clicks.
- fill { ref, value }: input/textarea/select; the value is read back and verified. Select options match value or visible label.
- type { text, submit? }: into the focused field (click it first); submit:true presses Enter.
- press { key }: one key, character or chord: Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home/End, PageUp/PageDown, F1-F12, Control+a, Control+Shift+ArrowRight.
- hover { ref } or { text }: opens hover menus/tooltips; the returned observation shows what appeared.
- scroll { direction, amount? }: up|down|left|right|top|bottom; or { ref } to bring an element into view.
- drag { ref, toRef }: real mouse path, automatic HTML5 drag/drop fallback.
- upload { ref, files:["C:/path/report.pdf"] }: the file input, its label or a nearby upload control. Set files directly; NEVER open/wait for the native file picker (invisible here).
- eval { js }: the escape hatch: page JavaScript, promises awaited, result JSON-serialized. Extract data in one shot, read computed styles, call the app's APIs; observe after it changes the DOM.
- dismiss: closes the topmost modal/popup/drawer/lightbox via its close control or Escape.
- pdf { path }: save the page as PDF.
- resize { width, height, mobile? }: responsive testing; mobile:true emulates touch; 0 x 0 resets to the real window.
- tabs lists; new_tab { url? }; switch_tab { tabIndex }; close_tab { tabIndex? }. A tab opened by a click is followed automatically.
- close: shut the browser down when finished.

WATCH / FLOWS
- watch { conditions:[...] } registers; with no conditions it checks them. console.error|console.warn|console.any|request.failed take an optional :substring; also selector.appears:CSS, selector.gone:CSS, text.appears:TEXT, url.matches:SUBSTRING. Register once and keep working: new console errors and failed requests reach you in later calls' warnings, with no console read each turn. Page conditions are evaluated when you call watch.
- Successful navigate/click/fill/type/press/scroll/wait/dismiss actions are recorded automatically, by label rather than @ref. flow { mode:"save", name:"login" } writes .tau/flows/<name>.json; { mode:"run", name } replays them with no further calls and stops at the first step that no longer matches, naming it (the cheapest UI regression test: that step is what changed). Other modes: list; delete with name; clear drops the recording to start fresh.

WARNINGS / RECOVERY
Automatic behaviors (read the warnings; do not fight them): JS alert/confirm/prompt are auto-accepted, text reported; downloads land in a known folder ("Download finished: name → path"); observe dismisses consent banners; hidden lazy content is nudged awake. If the user focuses or uses another tab, the tool follows it and reports the handoff.
The reason field names the failure; adjust, do not retry blindly:
- stale_ref: the page changed; observe again and use fresh refs.
- element_covered: the message names the blocker kind. Dialog/drawer/layer → dismiss the topmost (open-layer count reported), then use a fresh ref. Fixed/sticky header, language bar or cookie strip → dismiss cannot remove page chrome; scroll or act on something else. Normal z-index overlap → several points across the target already hit the blocker: a page stacking defect; report it or act on the covering element, never retry/dismiss. No visible area → off-screen or animating: wait or scroll, then observe.
- not_editable: not an input, or it rejected text; click the actual input or fill another element.
- no_match: text/selector matched nothing (or only a negation like "Don't allow"); observe and use a ref.
- timeout: the condition never came; read/observe what the page did instead.
CAPTCHA/login warnings: stop and ask the user to handle them in the browser, then continue (anti-detection is on, so these are rare).
Actions that clearly pay, purchase, delete or enter card data pause for user confirmation; NEVER bypass it.`

const ACTIONS = [
  'open',
  'get',
  'navigate',
  'observe',
  'read',
  'pick',
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
        'For click/hover: visible text to match. For type: text to type. For wait: text to wait for. For pick: one short line shown over the page saying what to point at.',
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
    bodies: z
      .boolean()
      .optional()
      .describe(
        'For network: also show the request payload and response body of the newest listed requests (up to 3), cut short, with credentials masked. Default false.',
      ),
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
    if (el.pressed !== undefined) parts.push(el.pressed ? '(pressed)' : '(not pressed)')
    if (el.expanded !== undefined) parts.push(el.expanded ? '(expanded)' : '(collapsed)')
    if (el.selected) parts.push('(selected)')
    if (el.current) parts.push(el.current === 'true' ? '(current)' : `(current ${el.current})`)
    if (el.required) parts.push('(required)')
    if (el.invalid) parts.push('(invalid)')
    if (el.disabled) parts.push('(disabled)')
    if (el.picked) parts.push('(picked)')
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
    case 'pick':
      return input.text
        ? `Your turn in the browser: ${input.text.slice(0, 60)}`
        : 'Your turn in the browser: click the element you mean'
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
      return `Network${input.failed ? ' failures' : ''}${input.bodies ? ' with bodies' : ''}`
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
      if (result.stale) {
        return errorOutput(
          'read',
          'The page changed since your last read: the text you were reading is no longer on it, so continuing would stitch two versions together. Read again without an offset to start over.',
          'stale_read',
        )
      }
      const shifted = result.shift
        ? `The page shifted by ${Math.abs(result.shift)} characters since your last read; I found your place again and continued from there.`
        : ''
      const shown = result.content?.length ?? 0
      const total = result.total ?? shown
      const from = result.offset ?? 0
      const more = from + shown < total
      const range =
        total > shown
          ? `Characters ${from}–${from + shown} of ${result.complete === false ? 'at least ' : ''}${total}.${more ? ` Continue with { "action": "read", "offset": ${from + shown} }.` : ''}`
          : ''
      return {
        action: 'read',
        ok: true,
        message: [`Read ${result.title || result.url || 'page'}.`, shifted, range]
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
    case 'pick': {
      const outcome = await session.pick(input.text, signal)
      const picked = outcome.picked
      if (!outcome.ok || !picked) return outcomeToOutput('pick', outcome)
      const entry = outcome.observation?.interactive_elements.find(el => el.picked)
      const ref = entry?.id
      // An icon button has no text of its own; its accessible name says what it is.
      const name = picked.text || entry?.text || ''
      const said = name ? ` "${name.slice(0, 60)}"` : ''
      // A picked element that left the page at once (a popup that closed) has
      // no ref; say so instead of handing out one that cannot resolve.
      const gone =
        ref === undefined
          ? ' It is no longer on the page, so it has no ref; use its selector, or pick again.'
          : ''
      return {
        ...outcomeToOutput(
          'pick',
          outcome,
          `The user picked ${ref !== undefined ? `@${ref}: ` : ''}${picked.tag}${said}.${gone}`,
        ),
        detailText: formatPicked(picked),
      }
    }
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
      const result = await session.networkLog({
        filter: input.filter,
        failedOnly: input.failed,
        limit: input.limit,
        clear: input.clear,
        bodies: input.bodies,
      })
      return {
        action: 'network',
        ok: true,
        message: `${result.captured} request(s) captured on this tab${input.clear ? ' (buffer cleared)' : ''}.`,
        networkText: result.bodies
          ? `${result.text}\n\nBodies of the newest listed requests (credentials masked):\n${result.bodies}`
          : result.text,
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
      // The target's own state (checked, pressed, expanded, its value) is part
      // of the evidence, so toggling it is never reported as no effect.
      ...(input.ref !== undefined ? { targetRef: input.ref } : {}),
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
      // The user does the pointing; nothing reaches the page.
      input.action === 'pick' ||
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
      // The vision token rides beside the image. A text-only provider swaps
      // the image for a "not sent" or OCR note, which the prompt says to heed.
      const caption = [
        output.message || 'Screenshot of the current tab.',
        ...(output.vision ? [output.vision] : []),
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
