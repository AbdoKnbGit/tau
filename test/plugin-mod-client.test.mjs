import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// Client modules: a second file of the plugin drawing a region on the
// drawing thread, sandboxed, with its own state, timers and keys; what it
// posts reaches the plugin's hooks as ui.message, and how it fails as
// ui.fault, its place taken by one dimmed line.
const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-client-')), project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true, writable: true })
const r = await loadBuiltRuntime({
  paths: ['src/utils/hooks.ts', 'src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/uiState.ts',
    'src/components/mods/ModSurface.tsx', 'src/utils/plugins/refresh.ts', 'src/utils/plugins/mods/clientHost.ts'],
  exports: ['startPluginMods', 'stopPluginMods', 'getModWarnings', 'setInlinePlugins', 'resetSettingsCache',
    'clearAllCaches', 'setOriginalCwd', 'setSessionTrustAccepted', 'setAllowedSettingSources', 'setIsInteractive',
    'getManagedFilePath', 'bindModSession', 'updateHooksConfigSnapshot', 'ModPromptSurface', 'focusModBand',
    'listModClients', 'inputModClient', 'setModClientKeyboard', 'getModClientKeyboard'],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)

let serial = 0, closeSession
const views = []
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)) }
const read = name => existsSync(join(project, name)) ? JSON.parse(readFileSync(join(project, name), 'utf8')) : undefined
const pause = ms => new Promise(done => setTimeout(done, ms))
async function until(check, what, timeout = 10_000) {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - started < timeout, `timed out waiting for ${what}`)
    await pause(20)
  }
}
/** `read` while a mod may still be writing the file: a transient empty or
 * half-written file is not a failure, the poll goes on. */
const untilJson = (name, what, timeout) => until(() => {
  try { return read(name) } catch { return undefined }
}, what, timeout)
/** A mod whose hooks module and Client files are `files` (under hooks/). */
async function loadMod(files, { allowWarnings = false } = {}) {
  const name = `client-${++serial}`
  const path = join(root, name)
  write(join(path, '.claude-plugin/plugin.json'), { name, version: '1.0.0' })
  write(join(path, 'hooks/hooks.json'), { modules: ['./register.tsx'] })
  for (const [file, source] of Object.entries(files)) write(join(path, 'hooks', file), source)
  if (!closeSession)
    closeSession = r.bindModSession({ getMessages: () => [], getModel: () => 'model', appendNotice: () => {}, canGiveKeyboard: () => true })
  r.setInlinePlugins([path]); r.resetSettingsCache(); r.clearAllCaches(); r.updateHooksConfigSnapshot()
  await r.startPluginMods(true)
  if (!allowWarnings) assert.deepEqual(r.getModWarnings(), [])
  return name
}
async function show() {
  const view = await mount(r, React.createElement(r.ModPromptSurface, { isWorking: false, promptEmpty: true }), { columns: 100, rows: 30 })
  views.push(view)
  return view
}
function keyHandler(node) {
  if (node._eventHandlers?.onKeyDown) return node._eventHandlers.onKeyDown
  for (const child of node.childNodes ?? []) {
    const found = keyHandler(child)
    if (found) return found
  }
}
afterEach(async () => {
  for (const view of views.splice(0)) view.close()
  await r.stopPluginMods(); closeSession?.(); closeSession = undefined
})
after(async () => { await r.stopPluginMods(); process.chdir(original); rmSync(root, { recursive: true, force: true, maxRetries: 10 }) })

const BAND = (client) => `export function register(on) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box, Client } = $.ui.resolve(e)
    return <Box flexDirection="column">${client}</Box>
  })
  on('ui.message', async ($, e, next) => {
    await $.fs.write('message.json', JSON.stringify(e))
    return { props: { label: 'P' } }
  })
  on('ui.fault', async ($, e, next) => {
    await $.fs.write('fault-' + e.element + '.json', JSON.stringify(e))
    return next(e)
  })
}`

test('a Client draws on the drawing thread: its state, timer and keys, sandboxed; a post is a ui.message whose props it takes', async () => {
  const name = await loadMod({
    'register.tsx': BAND(`<Client key="clock" module="./clock.tsx" props={{ label: 'T' }} />`),
    'clock.tsx': `export default function Clock(props, surface) {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ ticks: 0, key: '-', sandbox: [typeof process, typeof Buffer, typeof setTimeout].join(',') })
    surface.every(30, () => surface.setState({ ...surface.state, ticks: surface.state.ticks + 1 }))
    surface.onKey(event => surface.setState({ ...surface.state, key: event.key }))
    surface.post({ hello: props.label })
  }
  const state = surface.state ?? { ticks: 0, key: '-', sandbox: '' }
  return <Text>{props.label}:{state.ticks >= 3 ? 'many' : String(state.ticks)} key={state.key} sb={state.sandbox}</Text>
}`,
  })
  const view = await show()
  await view.waitFor(/T:\d|P:\d|:many/)
  await view.waitFor(/:many/)
  assert.match(view.frame(), /sb=undefined,undefined,undefined/, 'no Node inside the realm')
  await untilJson('message.json', 'the ui.message')
  assert.deepEqual(read('message.json'), { surface: 'terminal', component: 'AbovePrompt', requestId: 'AbovePrompt', element: 'clock', module: 'hooks/clock.tsx', data: { hello: 'T' } })
  await view.waitFor(/P:many/)
  const [instance] = r.listModClients().filter(item => item.plugin === name)
  assert.ok(instance && instance.listens.key)
  r.inputModClient(instance, 'key', { key: 'x' })
  await view.waitFor(/key=x/)
  // A click gives it the keyboard: the band's keys reach it; Esc gives them back.
  r.focusModBand(true)
  r.setModClientKeyboard('AbovePrompt', instance)
  const handler = await until(() => keyHandler(view.root), 'the focused band to take the keys')
  handler({ key: 'z', shift: false, ctrl: false, meta: false, preventDefault() {} })
  await view.waitFor(/key=z/)
  handler({ key: 'escape', shift: false, ctrl: false, meta: false, preventDefault() {} })
  assert.equal(r.getModClientKeyboard('AbovePrompt'), undefined)
})

test('a Client that throws draws one dimmed line and the plugin hears ui.fault; a runaway is cut at its time limit', async () => {
  const name = await loadMod({
    'register.tsx': BAND(`<Client key="bad" module="./bad.tsx" /><Client key="spin" module="./spin.tsx" />`),
    'bad.tsx': `export default function Bad() { throw new Error('boom') }`,
    'spin.tsx': `export function Spin(props, surface) { for (;;) {} }`,
  })
  const view = await show()
  await view.waitFor(new RegExp(`${name}: Client hooks/bad\\.tsx: boom`))
  await view.waitFor(new RegExp(`${name}: Client hooks/spin\\.tsx: a call ran past 1000 ms`), { timeout: 15_000 })
  for (const element of ['bad', 'spin']) {
    await untilJson(`fault-${element}.json`, `the ui.fault of ${element}`)
    const fault = read(`fault-${element}.json`)
    assert.equal(fault.phase, 'render')
    assert.equal(fault.component, 'AbovePrompt')
    assert.equal(fault.module, `hooks/${element}.tsx`)
  }
  assert.equal(read('fault-spin.json').reason, 'a call ran past 1000 ms')
  assert.equal(read('fault-bad.json').reason, 'boom')
})

test('a Client module is a string literal path to a file of the plugin, checked at load', async () => {
  await loadMod({ 'register.tsx': BAND(`<Client key="x" module={'./' + 'x.tsx'} />`) }, { allowWarnings: true })
  assert.ok(r.getModWarnings().some(text => /A Client's module is a string literal path/.test(text)), r.getModWarnings().join('\n'))
  await r.stopPluginMods()
  await loadMod({ 'register.tsx': BAND(`<Client key="x" module="./missing.tsx" />`) }, { allowWarnings: true })
  assert.ok(r.getModWarnings().some(text => /A Client's module names no file: \.\/missing\.tsx/.test(text)), r.getModWarnings().join('\n'))
})
