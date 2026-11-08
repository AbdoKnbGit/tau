import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// Panes as Claude Code seats them: one shown, the others tabs behind it; an
// open the mod makes by itself waits for a wide terminal; the ring and the
// window move through ui.focus and ui.scroll; toasts wait behind a pane that
// holds them; the band collapses, takes the keyboard, and answers a digit.
const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-panes-')), project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
let terminalColumns = 100
Object.defineProperty(process.stdout, 'columns', { get: () => terminalColumns, configurable: true })
const r = await loadBuiltRuntime({
  paths: ['src/utils/hooks.ts', 'src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/uiState.ts',
    'src/components/mods/ModSurface.tsx', 'src/utils/plugins/refresh.ts'],
  exports: ['startPluginMods', 'stopPluginMods', 'getModWarnings', 'setInlinePlugins', 'resetSettingsCache',
    'clearAllCaches', 'setOriginalCwd', 'setSessionTrustAccepted', 'setAllowedSettingSources', 'setIsInteractive',
    'getManagedFilePath', 'bindModSession', 'updateHooksConfigSnapshot', 'ModPromptSurface', 'ModFocusedPane',
    'getModPanes', 'getFocusedModPane', 'dispatchModEvent', 'getShownModPane', 'showModPane', 'placeModPanes',
    'isModToastHold', 'focusModBand', 'toggleModBand', 'isModBandFocused', 'getModFocusKey', 'getModScroller'],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)

let serial = 0, closeSession
const views = []
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)) }
const read = name => existsSync(join(project, name)) ? readFileSync(join(project, name), 'utf8') : undefined
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
async function loadMod(source) {
  const name = `panes-${++serial}`
  const path = join(root, name)
  write(join(path, '.claude-plugin/plugin.json'), { name, version: '1.0.0' })
  write(join(path, 'hooks/hooks.json'), { modules: ['./register.tsx'] })
  write(join(path, 'hooks/register.tsx'), source)
  closeSession ??= r.bindModSession({ getMessages: () => [], getModel: () => 'model', appendNotice: () => {}, canGiveKeyboard: () => true })
  r.setInlinePlugins([path]); r.resetSettingsCache(); r.clearAllCaches(); r.updateHooksConfigSnapshot()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  return name
}
const command = async (name, args = '') => JSON.parse((await r.dispatchModEvent('command.run', { command: name, args }, async () => ({ text: 'core' }))).text)
async function show(element) {
  const view = await mount(r, element, { columns: 100, rows: 30 })
  views.push(view)
  return view
}
const settled = () => { let first = true; return { test: () => first ? (first = false) : true } }
function keyHandler(node) {
  if (node._eventHandlers?.onKeyDown) return node._eventHandlers.onKeyDown
  for (const child of node.childNodes ?? []) {
    const found = keyHandler(child)
    if (found) return found
  }
}
async function key(view, name, { shift = false } = {}) {
  const handler = keyHandler(view.root)
  assert.ok(handler, 'something holds the keys')
  handler({ key: name, shift, ctrl: false, meta: false, preventDefault() {} })
  await view.waitFor(settled())
}
afterEach(async () => {
  for (const view of views.splice(0)) view.close()
  await r.stopPluginMods(); closeSession?.(); closeSession = undefined
  terminalColumns = 100
})
after(async () => { await r.stopPluginMods(); process.chdir(original); rmSync(root, { recursive: true, force: true, maxRetries: 10 }) })

test('an open the mod makes by itself waits for a wide terminal; one the person asks for shows; one pane shows, the rest are tabs', async () => {
  const name = await loadMod(`export function register(on) {
    on('session.start', async ($, e, next) => {
      await $.fs.write('unasked.json', JSON.stringify(await $.ui.open({ id: 'self', title: 'By itself' })))
      let flag
      try { await $.ui.open({ id: 'bad', focus: false }) } catch (error) { flag = error.message }
      await $.fs.write('flag.txt', flag)
      return next(e)
    })
    on('command.run', { command: 'open' }, async ($) => {
      const opened = await $.ui.open({ id: 'asked', title: 'Asked for' })
      return { text: JSON.stringify({ opened, panes: await $.ui.panes() }) }
    })
    on('ui.render', { component: 'Pane' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>body of {e.requestId}</Text>
    })
  }`)
  const unasked = JSON.parse(read('unasked.json'))
  assert.equal(unasked.isPlaced, false)
  assert.match(unasked.reason, /144 columns wide; this one is 100/)
  assert.equal(read('flag.txt'), 'ui.open: focus is true or left out')
  const out = await command('open')
  assert.deepEqual(out.opened, { isPlaced: true })
  // The refused open opened nothing.
  assert.deepEqual(out.panes.map(pane => [pane.id, pane.isShown, pane.isPlaced]), [['self', false, false], ['asked', true, true]])
  // Widened: the waiting panes are drawn, behind the shown one as tabs.
  r.placeModPanes(150)
  assert.equal(r.getModPanes().every(pane => pane.placed), true)
  assert.deepEqual(r.getShownModPane(), { plugin: name, id: 'asked' })
  const surface = await show(React.createElement(r.ModPromptSurface, { isWorking: false }))
  await surface.waitFor(/body of asked/)
  assert.match(surface.frame(), /By itself/)
  assert.match(surface.frame(), /Asked for/)
  assert.doesNotMatch(surface.frame(), /body of self/)
  r.showModPane(name, 'self')
  await surface.waitFor(/body of self/)
})

test('the ring moves through ui.focus: a hook sees the person\'s Tab and can send it elsewhere; $.ui.focus too', async () => {
  const name = await loadMod(`export function register(on) {
    on('command.run', { command: 'open' }, async ($) => { await $.ui.open({ id: 'form', focus: true }); return { text: '{}' } })
    on('ui.render', { component: 'Pane' }, async ($, e) => {
      const { Box, Button } = $.ui.resolve(e)
      return <Box flexDirection="column">
        <Button key="one" label="One" onPress={() => {}} />
        <Button key="two" label="Two" onPress={() => {}} />
        <Button key="three" label="Three" onPress={() => {}} />
      </Box>
    })
    on('ui.focus', async ($, e, next) => {
      await $.store.set('focus:' + Date.now() + Math.random(), { element: e.element ?? null, origin: e.origin.kind })
      // Tab past "two": the ring lands on "three".
      return e.element === 'two' ? next({ ...e, element: 'three' }) : next(e)
    })
    on('command.run', { command: 'focus' }, async ($) => {
      const moved = await $.ui.focus({ requestId: 'form', key: 'one' })
      const missing = await $.ui.focus({ requestId: 'form', key: 'nope' })
      return { text: JSON.stringify({ moved, missing }) }
    })
  }`)
  await command('open')
  const pane = await show(React.createElement(r.ModFocusedPane))
  await pane.waitFor(/\[Three\]/)
  const site = `Pane:${name}:form`
  await key(pane, 'tab')
  await until(() => r.getModFocusKey(site) === '0:one', 'the first stop')
  await key(pane, 'tab')
  await until(() => r.getModFocusKey(site) === '0:three', 'the hook\'s choice')
  const out = await command('focus')
  assert.deepEqual(out.moved, {})
  assert.match(out.missing.deny, /no element "nope"/)
  assert.equal(r.getModFocusKey(site), '0:one')
})

test('a body taller than its window scrolls with the page keys through ui.scroll, and by $.ui.scroll', async () => {
  const name = await loadMod(`export function register(on) {
    on('command.run', { command: 'open' }, async ($) => { await $.ui.open({ id: 'log', focus: true, rows: 3 }); return { text: '{}' } })
    on('ui.render', { component: 'Pane' }, async ($, e) => {
      const { Box, Text } = $.ui.resolve(e)
      return <Box flexDirection="column">{Array.from({ length: 12 }, (_, row) => <Text key={row}>line {row}</Text>)}</Box>
    })
    on('ui.scroll', async ($, e, next) => {
      await $.fs.write('scroll.json', JSON.stringify({ offset: e.offset, by: e.by, bodyRows: e.bodyRows, contentRows: e.contentRows, origin: e.origin.kind }))
      return next(e)
    })
    on('command.run', { command: 'end' }, async ($) => ({ text: JSON.stringify(await $.ui.scroll({ to: 'end', in: 'log' })) }))
  }`)
  await command('open')
  const pane = await show(React.createElement(r.ModFocusedPane))
  await pane.waitFor(/line 0/)
  assert.doesNotMatch(pane.frame(), /line 5/)
  await key(pane, 'pagedown')
  const paged = JSON.parse(await until(() => read('scroll.json'), 'the scroll event'))
  assert.equal(paged.origin, 'person')
  assert.equal(paged.bodyRows, 3)
  assert.equal(paged.contentRows, 12)
  assert.equal(paged.offset, 3)
  await pane.waitFor(/line 3/)
  assert.deepEqual(await command('end'), {})
  await pane.waitFor(/line 11/)
  assert.equal(JSON.parse(read('scroll.json')).origin, 'plugin')
  assert.equal(r.getModScroller(`Pane:${name}:log`).getScrollTop(), 9)
})

test('toasts wait behind a shown pane opened with holdToasts', async () => {
  await loadMod(`export function register(on) {
    on('command.run', { command: 'dialog' }, async ($) => { await $.ui.open({ id: 'ask', holdToasts: true }); return { text: '{}' } })
    on('command.run', { command: 'quiet' }, async ($) => { await $.ui.open({ id: 'other' }); return { text: '{}' } })
  }`)
  assert.equal(r.isModToastHold(), false)
  await command('dialog')
  assert.equal(r.isModToastHold(), true)
  await command('quiet')
  assert.equal(r.isModToastHold(), false, 'the hold lasts while that pane is the one shown')
})

test('the band collapses to one row, takes the keyboard, and answers a digit typed into an empty prompt', async () => {
  await loadMod(`export function register(on) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Box, Button } = $.ui.resolve(e)
      return <Box flexDirection="row" gap={1}>
        <Button key="yes" label="Yes" hotkey="1" plain onPress={async () => { await $.fs.write('answer.txt', 'yes') }} />
        <Button key="no" label="No" hotkey="2" plain onPress={async () => { await $.fs.write('answer.txt', 'no') }} />
      </Box>
    })
  }`)
  const surface = await show(React.createElement(r.ModPromptSurface, { isWorking: false, promptEmpty: true }))
  await surface.waitFor(/1: Yes/)
  // A bare digit in an empty prompt presses the band's Button.
  await surface.press('2')
  await until(() => read('answer.txt') === 'no', 'the digit hotkey')
  // The band takes the keyboard: Tab, then Enter.
  r.focusModBand(true)
  await surface.waitFor(settled())
  await key(surface, 'tab')
  await key(surface, 'return')
  await until(() => read('answer.txt') === 'yes', 'the band\'s focused Button')
  await key(surface, 'escape')
  assert.equal(r.isModBandFocused(), false)
  // Collapsed: one dim row; nothing presses its Buttons.
  r.toggleModBand()
  await surface.waitFor(/plugin panel hidden/)
  assert.doesNotMatch(surface.frame(), /1: Yes/)
  await surface.press('1')
  await pause(150)
  assert.equal(read('answer.txt'), 'yes')
  r.toggleModBand()
  await surface.waitFor(/1: Yes/)
})

test('hover: a keyed Box lights what it holds under the pointer; a hover outside one, or an unknown action, refuses the tree', async () => {
  const name = await loadMod(`export function register(on) {
    on('command.run', { command: 'open' }, async ($) => { await $.ui.open({ id: 'h' }); await $.ui.open({ id: 'bad' }); await $.ui.open({ id: 'act' }); return { text: '{}' } })
    on('ui.render', { component: 'Pane' }, async ($, e) => {
      const { Box, Text, Button } = $.ui.resolve(e)
      if (e.requestId === 'bad') return <Text hover={{ bold: true }}>loose</Text>
      if (e.requestId === 'act') return <Button label="Go" action="app:noSuchAction" onPress={() => {}} />
      return <Box key="row" flexDirection="row" gap={1}>
        <Text>row</Text>
        <Box display="none" hover={{ display: 'flex' }}><Text>revealed</Text></Box>
      </Box>
    })
  }`)
  await command('open')
  const surface = await show(React.createElement(r.ModPromptSurface, { isWorking: false }))
  r.showModPane(name, 'h')
  await surface.waitFor(/row/)
  assert.doesNotMatch(surface.frame(), /revealed/)
  const enter = (node) => node._eventHandlers?.onMouseEnter ? node._eventHandlers.onMouseEnter : (node.childNodes ?? []).map(enter).find(Boolean)
  enter(surface.root)()
  await surface.waitFor(/revealed/)
  for (const [id, reason] of [['bad', /a Text hover needs a keyed Box around it, or a scope/], ['act', /a Button action is an engine keybinding action/]]) {
    r.showModPane(name, id)
    await until(() => r.getModWarnings().some(text => reason.test(text)), String(reason))
  }
})
