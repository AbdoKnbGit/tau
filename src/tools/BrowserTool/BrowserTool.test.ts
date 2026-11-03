/** Tool-boundary regressions; uses the real flow code with an in-memory session.
 * Run: bun run src/tools/BrowserTool/BrowserTool.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTool } from './BrowserTool.js'
import { getBrowserSession } from '../../services/browser/browserSession.js'
import { saveFlow, type Flow } from '../../services/browser/flows.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import type { ObservedElementLike } from '../../services/browser/flowRunner.js'
import type { FlowFieldMetadata } from '../../services/browser/flowSafety.js'

const directory = mkdtempSync(join(tmpdir(), 'tau-browser-tool-'))
const session = getBrowserSession() as unknown as Record<string, unknown>
const originals = new Map<string, unknown>()
const events: string[] = []
const recorded: Flow['steps'] = []
let running = true
let typedValue = ''
let effectUrlChanged = false
const observation = {
  url: 'https://app.test/', title: 'App', text_sample: '',
  interactive_elements: [{ id: 12, tag: 'iframe', text: 'Embedded' }, { id: 13, tag: 'input', text: 'Search' }],
}
let cachedElements: ObservedElementLike[] = observation.interactive_elements
let freshField: FlowFieldMetadata = { type: 'text' }
let beforeQueuedRun: (() => Promise<void>) | undefined
function patch(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, session[name])
  session[name] = value
}
patch('isRunning', () => running)
patch('claimActiveTab', () => undefined)
patch('getCachedElement', (ref: number) => { events.push('cachedElement'); return cachedElements.find(element => element.id === ref) })
patch('getCachedElements', () => { events.push('cachedElements'); return cachedElements })
patch('flowFieldForRef', async () => { events.push('fieldMetadata'); return freshField })
patch('focusedFlowField', async () => { events.push('focusedMetadata'); return freshField })
patch('getLastKnownUrl', () => observation.url)
patch('drainSessionNotes', () => [])
patch('drainWatchAlerts', () => [])
patch('recordStep', (step: Flow['steps'][number]) => { events.push('record'); recorded.push(step) })
patch('recordedFlow', () => ({ startUrl: observation.url, steps: recorded }))
patch('ensureStarted', async () => { events.push('start'); running = true })
patch('observe', async () => { events.push('observe'); return { observation, warnings: [] } })
patch('navigate', async () => { events.push('navigate') })
patch('prepareFlowScope', () => { events.push('scope:top') })
patch('click', async () => { events.push('click'); return { ok: true, observation, warnings: [] } })
patch('press', async () => { events.push('press'); return { ok: true, observation, warnings: [] } })
patch('fill', async (_ref: number, value: string) => {
  events.push('fill'); typedValue = value; return { ok: true, observation, warnings: [] }
})
patch('switchFrame', async (ref?: number) => {
  events.push(ref === undefined ? 'frame:top' : `frame:${ref}`)
  return { ok: true, observation, warnings: [] }
})
patch('withEffect', async (_action: string, run: () => Promise<unknown>) => {
  events.push('effect')
  await beforeQueuedRun?.()
  const result = await run()
  events.push('queue:finished')
  return { result, effect: { step: 1, ms: 0, url: observation.url, urlChanged: effectUrlChanged, docChanged: false, domChanged: true, scrolled: false, noop: false } }
})
const context = { abortController: new AbortController() }
const call = (input: Record<string, unknown>) => runWithCwdOverride(directory, async () =>
  (await BrowserTool.call(input as never, context as never)).data)
const definition = async () => JSON.stringify({
  description: await BrowserTool.description(), prompt: await BrowserTool.prompt(),
  schema: zodToJsonSchema(BrowserTool.inputSchema),
})
const initialDefinition = await definition()
let passed = 0
async function check(name: string, run: () => Promise<void>): Promise<void> {
  events.length = 0
  recorded.length = 0
  await run()
  console.log(`  ok ${name}`)
  passed++
}
const baseFlow = (name: string): Flow => ({
  version: 1, name, createdAt: '2026-01-01T00:00:00.000Z', parameters: ['term'],
  steps: [{ action: 'navigate', url: observation.url }, { action: 'fill', target: { text: 'Search' }, value: '{{term}}' }],
})
try {
  await check('successful actions append their recording before leaving the action queue', async () => {
    const output = await call({ action: 'frame', ref: 12 })
    assert.equal(output.ok, true)
    assert.ok(events.indexOf('record') > events.indexOf('frame:12'))
    assert.ok(events.indexOf('record') < events.indexOf('queue:finished'))
  })
  await check('frame enters the observed ref and records a durable target', async () => {
    running = true
    const output = await call({ action: 'frame', ref: 12 })
    assert.equal(output.ok, true)
    assert.ok(events.includes('frame:12'))
    assert.deepEqual(recorded, [{ action: 'frame', target: { text: 'Embedded', tag: 'iframe' } }])
    assert.equal(BrowserTool.isReadOnly({ action: 'frame' } as never), false)
    assert.equal(BrowserTool.isDestructive({ action: 'frame' } as never), false)
  })
  await check('frame without a ref returns to the top document', async () => {
    const output = await call({ action: 'frame' })
    assert.equal(output.ok, true)
    assert.ok(events.includes('frame:top'))
    assert.deepEqual(recorded, [{ action: 'frame' }])
  })
  await check('queued actions record the latest cache after earlier actions finish', async () => {
    let entered!: () => void
    const queued = new Promise<void>(resolve => { entered = resolve })
    let resume!: () => void
    const wait = new Promise<void>(resolve => { resume = resolve })
    beforeQueuedRun = async () => { entered(); await wait }
    const pending = call({ action: 'click', ref: 13 })
    try {
      await queued
      assert.equal(events.includes('cachedElement'), false)
      cachedElements = [{ id: 13, tag: 'button', text: 'Latest label' }]
      resume()
      assert.equal((await pending).ok, true)
      assert.equal(recorded[0]?.target?.text, 'Latest label')
    } finally {
      resume(); beforeQueuedRun = undefined; cachedElements = observation.interactive_elements
    }
  })
  await check('fresh sensitive field metadata overrides a stale cached text type before fill', async () => {
    running = true
    cachedElements = [{ id: 13, tag: 'input', text: 'Entry', type: 'text' }]
    freshField = { type: 'password' }
    try {
      const output = await call({ action: 'fill', ref: 13, value: 'harmless' })
      assert.equal(output.ok, true)
      assert.ok(events.indexOf('fieldMetadata') < events.indexOf('fill'))
      assert.ok(recorded[0]?.unreplayable?.includes('sensitive'))
      assert.equal(JSON.stringify(recorded).includes('harmless'), false)
    } finally {
      freshField = { type: 'text' }; cachedElements = observation.interactive_elements
    }
  })
  await check('fresh fill metadata preserves repeated target ordinals', async () => {
    cachedElements = [{ id: 13, tag: 'input', text: 'Entry' }, { id: 14, tag: 'input', text: 'Entry' }]
    try {
      const output = await call({ action: 'fill', ref: 14, value: 'harmless' })
      assert.equal(output.ok, true)
      assert.equal(recorded[0]?.target?.nth, 2)
    } finally {
      cachedElements = observation.interactive_elements
    }
  })
  await check('printable key recording inspects the focused field before pressing', async () => {
    freshField = { type: 'password' }
    try {
      const output = await call({ action: 'press', key: 'a' })
      assert.equal(output.ok, true)
      assert.ok(events.indexOf('focusedMetadata') < events.indexOf('press'))
      assert.ok(recorded[0]?.unreplayable)
      assert.equal(recorded[0]?.key, undefined)
    } finally {
      freshField = { type: 'text' }
    }
  })
  await check('a later missing flow parameter prevents probes, startup and navigation', async () => {
    running = false
    saveFlow(directory, baseFlow('missing'))
    const output = await call({ action: 'flow', mode: 'run', name: 'missing' })
    assert.equal(output.ok, false)
    assert.equal(output.reason, 'flow_unreplayable')
    assert.deepEqual(events, [])
  })
  await check('flow save parameterizes input and needs no browser startup', async () => {
    running = false
    recorded.push({ action: 'fill', target: { text: 'Search' }, value: 'recorded query' })
    const output = await call({ action: 'flow', mode: 'save', name: 'search', fields: { term: 'recorded query' } })
    assert.equal(output.ok, true)
    assert.equal(events.includes('start'), false)
    const saved = readFileSync(output.savedPath!, 'utf8')
    assert.ok(saved.includes('{{term}}'))
    assert.equal(saved.includes('recorded query'), false)
  })
  await check('valid flow resolves values only at runtime and keeps traces parameterized', async () => {
    running = false
    saveFlow(directory, baseFlow('valid'))
    const output = await call({ action: 'flow', mode: 'run', name: 'valid', fields: { term: 'runtime query' } })
    assert.equal(output.ok, true)
    assert.equal(typedValue, 'runtime query')
    assert.ok(events.indexOf('start') < events.indexOf('navigate'))
    assert.equal(JSON.stringify(output).includes('runtime query'), false)
    assert.equal(readFileSync(join(directory, '.tau', 'flows', 'valid.json'), 'utf8').includes('runtime query'), false)
  })
  await check('local flow listing leaves a closed browser closed', async () => {
    running = false
    const output = await call({ action: 'flow', mode: 'list' })
    assert.equal(output.ok, true)
    assert.equal(events.includes('start'), false)
    assert.equal(running, false)
  })
  await check('flow replay resets frame scope before its first observation or click', async () => {
    running = true
    saveFlow(directory, { version: 1, name: 'click-only', createdAt: '2026-01-01T00:00:00.000Z', steps: [{ action: 'click', target: { text: 'Search' } }] })
    const output = await call({ action: 'flow', mode: 'run', name: 'click-only' })
    assert.equal(output.ok, true)
    assert.ok(events.indexOf('scope:top') < events.indexOf('observe'))
    assert.ok(events.indexOf('scope:top') < events.indexOf('click'))
  })
  await check('flow output redacts page echoes and encoded runtime values', async () => {
    running = true
    const previousUrl = observation.url
    observation.url = 'https://app.test/?q=runtime%20query'
    effectUrlChanged = true
    observation.interactive_elements.push({ id: 14, tag: 'button', text: 'runtime query' })
    try {
      const output = await call({ action: 'flow', mode: 'run', name: 'valid', fields: { term: 'runtime query' } })
      assert.equal(output.ok, true)
      assert.equal(JSON.stringify(output).includes('runtime query'), false)
      assert.equal(JSON.stringify(output).includes('runtime%20query'), false)
      assert.ok(output.receipt?.includes('[parameter]'))
      assert.equal(output.action, 'flow')
    } finally {
      observation.url = previousUrl
      effectUrlChanged = false
      observation.interactive_elements.pop()
    }
  })
  await check('an unencodable runtime value does not break output handling', async () => {
    const output = await call({ action: 'flow', mode: 'run', name: 'valid', fields: { term: '\uD800' } })
    assert.equal(output.ok, true)
  })
  await check('frame and flow state never change the static tool definition', async () => {
    assert.equal(await definition(), initialDefinition)
    assert.equal(Object.keys(BrowserTool.inputSchema.shape).length, 43)
    assert.equal(BrowserTool.inputSchema.safeParse({ action: 'frame', ref: 12 }).success, true)
  })
  console.log(`${passed} browser tool checks passed`)
} finally {
  for (const [name, value] of originals) session[name] = value
  rmSync(directory, { recursive: true, force: true })
}
