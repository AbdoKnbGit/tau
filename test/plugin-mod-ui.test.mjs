import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// Mods drawing in the terminal: a JSX pane whose controls reach the mod's own
// closures, the band above the prompt, status lines, toasts, notifications,
// and trees the terminal refuses or draws as their authors meant.
const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-ui-')), project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
// A terminal wide enough for panes a mod opens by itself (they wait below 144 columns).
Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true, writable: true })
const r = await loadBuiltRuntime({
  paths: ['src/utils/hooks.ts', 'src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/uiState.ts',
    'src/components/mods/ModSurface.tsx', 'src/utils/plugins/refresh.ts', 'src/components/mods/inputEditing.ts'],
  exports: ['startPluginMods', 'stopPluginMods', 'getModWarnings', 'setInlinePlugins', 'resetSettingsCache',
    'clearAllCaches', 'setOriginalCwd', 'setSessionTrustAccepted', 'setAllowedSettingSources', 'setIsInteractive',
    'getManagedFilePath', 'bindModSession', 'updateHooksConfigSnapshot', 'ModPromptSurface', 'ModFocusedPane',
    'ModStatusLines', 'getModPanes', 'getFocusedModPane', 'closeModPane', 'dispatchModEvent', 'getModSite', 'applyModControl',
    'invalidateModSite', 'editInput', 'inputWindow', 'openModToolCall', 'closeModToolCall', 'getModToolNotice',
    'showModPane', 'getShownModPane'],
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
async function loadMod(source, { allowWarnings = false } = {}) {
  const name = `ui-${++serial}`
  const path = join(root, name)
  write(join(path, '.claude-plugin/plugin.json'), { name, version: '1.0.0' })
  write(join(path, 'hooks/hooks.json'), { modules: ['./register.tsx'] })
  write(join(path, 'hooks/register.tsx'), source)
  bindDrawing()
  r.setInlinePlugins([path]); r.resetSettingsCache(); r.clearAllCaches(); r.updateHooksConfigSnapshot()
  await r.startPluginMods(true)
  if (!allowWarnings) assert.deepEqual(r.getModWarnings(), [])
  return name
}
/** A session that draws panes, as the REPL binds one: placed and focusable. */
function bindDrawing(extra = {}) {
  if (closeSession) return
  closeSession = r.bindModSession({
    getMessages: () => [], getModel: () => 'model', appendNotice: () => {}, canGiveKeyboard: () => true, ...extra,
  })
}
/** Several mods, the first outermost (each depends on the next). */
async function loadMods(sources) {
  const names = sources.map((_, index) => `ui-${++serial}-${index}`)
  const paths = sources.map((source, index) => {
    const path = join(root, names[index])
    write(join(path, '.claude-plugin/plugin.json'), { name: names[index], version: '1.0.0',
      ...(index + 1 < names.length ? { dependencies: [names[index + 1] + '@inline'] } : {}) })
    write(join(path, 'hooks/hooks.json'), { modules: ['./register.tsx'] })
    write(join(path, 'hooks/register.tsx'), source)
    return path
  })
  bindDrawing()
  r.setInlinePlugins(paths); r.resetSettingsCache(); r.clearAllCaches(); r.updateHooksConfigSnapshot()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  return names
}
async function show(element) {
  const view = await mount(r, element, { columns: 80, rows: 30 })
  views.push(view)
  return view
}
/** The focused pane's key handler, as Ink's dispatcher reaches it. */
function keyHandler(node) {
  if (node._eventHandlers?.onKeyDown) return node._eventHandlers.onKeyDown
  for (const child of node.childNodes ?? []) {
    const found = keyHandler(child)
    if (found) return found
  }
}
/** One more render pass, failing on any render error, as the helper's waitFor settles. */
const settled = () => { let first = true; return { test: () => first ? (first = false) : true } }
async function key(view, name, { shift = false, ctrl = false, meta = false } = {}) {
  const handler = keyHandler(view.root)
  assert.ok(handler, 'the focused pane takes the keys')
  let prevented = false
  handler({ key: name, shift, ctrl, meta, preventDefault() { prevented = true } })
  await view.waitFor(settled())
  return prevented
}
afterEach(async () => {
  for (const view of views.splice(0)) view.close()
  await r.stopPluginMods(); closeSession?.(); closeSession = undefined
})
after(async () => { await r.stopPluginMods(); process.chdir(original); rmSync(root, { recursive: true, force: true, maxRetries: 10 }) })

const COUNTER = `let count = 0, name = ''
export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.ui.open({ id: 'main', title: 'Counter', focus: true })
    $.ui.status('ready')
    return next(e)
  })
  on('ui.render', { component: 'Pane', requestId: 'main' }, async ($, e) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    return <Box flexDirection="column">
      <Text bold>Count {count} {e.props.isFocused ? 'focused' : 'resting'}</Text>
      <Button label="Add" hotkey="a" autoFocus onPress={() => { count++; $.ui.invalidate('ui.render') }} />
      <Input key="name" label="Name" value={name} placeholder="who?"
        onInput={value => { name = value; $.ui.invalidate('ui.render') }}
        onSubmit={async value => { await $.fs.write('name.txt', value); name = ''; $.ui.invalidate('ui.render') }} />
      <Select key="color" label="Color" options={[{ value: 'red' }, { value: 'blue', label: 'Blue' }]}
        onSelect={async value => { await $.fs.write('color.txt', value) }} />
    </Box>
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text color="cyan">band {e.props.isWorking ? 'busy' : 'idle'}</Text>
  })
}`

test('a JSX pane takes the keys: autoFocus, hotkeys, typing the mod echoes, a pick; Esc gives the keys back', async () => {
  // Mounted first, as the REPL is: the pane opens, and asks for its first
  // drawing, while session.start is still running.
  const pane = await show(React.createElement(r.ModFocusedPane))
  const name = await loadMod(COUNTER)
  assert.equal(r.getModPanes()[0].title, 'Counter')
  assert.deepEqual(r.getFocusedModPane(), { plugin: name, id: 'main' })
  await pane.waitFor(/Count 0 focused/)
  assert.match(pane.frame(), /\[Add\]/)
  assert.match(pane.frame(), /Name who\?/)
  assert.match(pane.frame(), /Color - ▾/)
  // The ring starts on the autoFocus button: Enter presses it at once.
  assert.equal(await key(pane, 'return'), true)
  await pane.waitFor(/Count 1/)
  // Its hotkey too, while the ring is not in a text field (Shift+a is a).
  await key(pane, 'A', { shift: true })
  await pane.waitFor(/Count 2/)
  await key(pane, 'tab')
  await pane.waitFor(/⏎ submit/)
  // The mod echoes each change into the field's value; typing faster than the
  // echoes keeps every key.
  for (const letter of 'bob') await key(pane, letter)
  await pane.waitFor(/Name bob▏/)
  await until(() => r.getModSite(`Pane:${name}:main`)?.tree && JSON.stringify(r.getModSite(`Pane:${name}:main`).tree).includes('"value":"bob"'), 'the echo')
  await pane.waitFor(/Name bob▏/)
  // A hotkey letter types into the field instead of pressing.
  await key(pane, 'a')
  await pane.waitFor(/Name boba▏/)
  assert.match(pane.frame(), /Count 2/)
  await key(pane, 'backspace')
  await pane.waitFor(/Name bob▏/)
  await key(pane, 'return')
  await until(() => read('name.txt') === 'bob', 'the input submission')
  // The mod cleared its value on submit: the field shows what it drew.
  await pane.waitFor(/Name ▏who\?/)
  await key(pane, 'tab')
  await pane.waitFor(/○ red/)
  await key(pane, 'down')
  await key(pane, 'return')
  await until(() => read('color.txt') === 'blue', 'the selection')
  await pane.waitFor(/● Blue/)
  // Shift+Tab walks the ring back; the ring wraps.
  await key(pane, 'tab', { shift: true })
  await pane.waitFor(/Name ▏who\?/)
  assert.equal(await key(pane, 'escape'), true)
  assert.equal(r.getFocusedModPane(), null)
  // Resting above the prompt now, with the band and the status line; the
  // pick it has not drawn back stays.
  const surface = await show(React.createElement(r.ModPromptSurface, { isWorking: false }))
  await surface.waitFor(/Count 2 resting/)
  await surface.waitFor(/band idle/)
  assert.match(surface.frame(), /Color Blue ▾/)
  const status = await show(React.createElement(r.ModStatusLines))
  assert.match(status.frame(), new RegExp(`⚠ ${name}: ready`))
})

test('controls that share a label keep their own closures; the ring starts on nothing without autoFocus', async () => {
  const name = await loadMod(`const rows = ['a', 'b', 'c']
  export function register(on) {
    on('session.start', async ($, e, next) => { await $.ui.open({ id: 'list', focus: true }); return next(e) })
    on('ui.render', { component: 'Pane' }, async ($, e) => {
      const { Box, Text, Button } = $.ui.resolve(e)
      return <Box flexDirection="column">{rows.map(row =>
        <Box key={row} flexDirection="row" gap={1}><Text>{row}</Text>
          <Button label="Delete" onPress={async () => { await $.fs.write('deleted.txt', row) }} /></Box>)}</Box>
    })
  }`)
  const pane = await show(React.createElement(r.ModFocusedPane))
  await pane.waitFor(/c \[Delete\]/)
  // Nothing holds the ring yet: Enter does nothing.
  assert.equal(await key(pane, 'return'), false)
  await pause(100)
  assert.equal(read('deleted.txt'), undefined)
  await key(pane, 'tab')
  await key(pane, 'tab')
  await key(pane, 'return')
  await until(() => read('deleted.txt') === 'b', 'the second row\'s own closure')
  // Back past the start wraps to the last one.
  await key(pane, 'tab', { shift: true })
  await key(pane, 'tab', { shift: true })
  await key(pane, ' ')
  await until(() => read('deleted.txt') === 'c', 'the last row\'s own closure')
  assert.equal(r.getFocusedModPane().plugin, name)
})

test('a press on the drawing on screen reaches its closure while a newer drawing is on its way', async () => {
  await loadMods([
    // Above: holds each drawing after the first before passing it on.
    `let draws = 0
    export function register(on) {
      on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const tree = await next(e)
        if (++draws > 1) await $.clock.sleep(600)
        return tree
      })
    }`,
    `let hits = 0
    export function register(on) {
      on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
        const { Button } = $.ui.resolve(e)
        return <Button label="Hit" onPress={async () => { hits++; await $.fs.write('hits.txt', String(hits)) }} />
      })
    }`,
  ])
  const surface = await show(React.createElement(r.ModPromptSurface, { isWorking: false }))
  await surface.waitFor(/\[Hit\]/)
  // A redraw: the inner mod draws again at once; the outer one holds it.
  r.invalidateModSite()
  await surface.waitFor(settled())
  await pause(250)
  assert.equal(r.getModSite('AbovePrompt').pending, true, 'the newer drawing is still on its way')
  await r.applyModControl('AbovePrompt', 'Hit', 'press')
  await until(() => read('hits.txt') === '1', 'the press on the drawing on screen')
})

test('trees the terminal cannot draw fail their hook; a pass-through draws nothing and breaks nothing', async () => {
  const name = await loadMod(`export function register(on) {
    on('session.start', async ($, e, next) => {
      for (const id of ['block', 'link', 'hotkey', 'plain']) await $.ui.open({ id })
      return next(e)
    })
    on('ui.render', { component: 'Pane' }, async ($, e, next) => {
      const { Box, Text, Button, Link } = $.ui.resolve(e)
      switch (e.requestId) {
        case 'block': return <Text>a <Box><Text>box</Text></Box> in a line</Text>
        case 'link': return <Link href="http://example.com/x">plain http</Link>
        case 'hotkey': return <Button label="x" hotkey="ctrl+x" onPress={() => {}} />
        // Hand-built: no props, numbers, nested lists, the engine's own drawing.
        default: return { type: 'Box', children: [[{ type: 'Text', children: ['n=', 42, false, null] }], await next(e),
          { type: 'Link', props: { href: 'https://example.com/a' }, children: [] },
          { type: 'Button', props: { label: 'Go', onPress: async () => { await $.fs.write('hand.txt', 'pressed') } } }] }
      }
    })
    // Only panes: the band passes through to the engine, which draws nothing.
    on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))
  }`)
  const surface = await show(React.createElement(r.ModPromptSurface, { isWorking: false }))
  // One pane shows at a time, the others tabs behind it.
  r.showModPane(name, 'plain')
  await surface.waitFor(/n=42/)
  await surface.waitFor(/https:\/\/example\.com\/a/)
  // A closure inside a hand-built element without props still reaches the mod.
  await surface.waitFor(/\[Go\]/)
  await r.applyModControl(`Pane:${name}:plain`, 'Go', 'press')
  await until(() => read('hand.txt') === 'pressed', 'the hand-built button\'s closure')
  for (const [id, reason] of [['block', /a Text holds text and Text, Link, Button or Image elements, not a Box/], ['hotkey', /a Button hotkey is one digit or one lowercase letter/]]) {
    r.showModPane(name, id)
    await until(() => r.getModWarnings().some(text => text.startsWith(`${name}: ui.render hook skipped`) && reason.test(text)), String(reason))
    await surface.waitFor(settled())
    assert.doesNotMatch(surface.frame(), /box|\[x\]/)
  }
  // A Link of any scheme draws, its tree standing.
  r.showModPane(name, 'link')
  await surface.waitFor(/plain http/)
  assert.equal(r.getModSite('AbovePrompt')?.tree, null)
})

test('a toast sent before a session draws (from session.start) shows once one binds', async () => {
  const name = await loadMod(`export function register(on) {
    on('session.start', async ($, e, next) => {
      $.ui.toast('early', { timeoutMs: 9000 })
      $.ui.toast('loaded', { timeoutMs: 9000 })
      return next(e)
    })
  }`)
  const toasts = []
  closeSession = r.bindModSession({
    getMessages: () => [], getModel: () => 'model',
    toast: (plugin, text, timeoutMs) => toasts.push({ plugin, text, timeoutMs }),
  })
  // The newer one from the plugin took the older one's place.
  await until(() => toasts.length, 'the held toast')
  assert.deepEqual(toasts, [{ plugin: name, text: 'loaded', timeoutMs: 9000 }])
})

test('panes close through ui.close hooks; toasts, notifications and status lines reach the session', async () => {
  const toasts = [], notified = []
  closeSession = r.bindModSession({
    getMessages: () => [], getModel: () => 'model', appendNotice: () => {}, canGiveKeyboard: () => true,
    toast: (plugin, text, timeoutMs) => toasts.push({ plugin, text, timeoutMs }),
    notify: async (text, title) => { notified.push({ text, title }); return 'kitty' },
  })
  const name = await loadMod(`let seen = 0
  export function register(on) {
    on('session.start', async ($, e, next) => { await $.ui.open({ id: 'keep', title: 'Kept' }); return next(e) })
    on('ui.close', async ($, e, next) => e.origin.kind === 'person' ? {} : next(e))
    on('classic.Notification', async ($, e, next) => {
      seen++
      // Notifying from the hook does not run this hook again.
      if (seen === 1) await $.ui.notify('from the hook')
      await $.fs.write('notification.txt', e.notification_type + ':' + seen)
      return next(e)
    })
    on('command.run', { command: 'ui-probe' }, async ($) => {
      $.ui.toast('hello', { timeoutMs: 1500 })
      $.ui.status('working')
      const sent = await $.ui.notify('done', { title: 'Probe' })
      let asked
      try { await $.ui.ask('Proceed?', ['Yes', 'No']) } catch (error) { asked = error.message }
      return { text: JSON.stringify({ sent, asked, panes: await $.ui.panes() }) }
    })
  }`)
  const out = JSON.parse((await r.dispatchModEvent('command.run', { command: 'ui-probe', args: '' }, async () => ({ text: 'core' }))).text)
  assert.deepEqual(toasts, [{ plugin: name, text: 'hello', timeoutMs: 1500 }])
  assert.deepEqual(out.sent, { isSent: true, channel: 'kitty' })
  assert.deepEqual(notified.map(item => item.text).sort(), ['done', 'from the hook'])
  assert.equal(read('notification.txt'), 'plugin_notification:1')
  assert.match(out.asked, /nobody to ask/)
  assert.deepEqual(out.panes, [{ id: 'keep', title: 'Kept', isShown: true, isFocused: false, isPlaced: true }])
  // A person's close is refused by the hook; the plugin's own close goes through.
  await r.closeModPane(name, 'keep', 'person')
  assert.equal(r.getModPanes().length, 1)
  await r.closeModPane(name, 'keep', 'plugin')
  assert.equal(r.getModPanes().length, 0)
  const status = await show(React.createElement(r.ModStatusLines))
  assert.match(status.frame(), new RegExp(`⚠ ${name}: working`))
  // Unloading takes the mod's status line and panes away.
  await r.stopPluginMods()
  await status.waitFor(/^$/)
})

test('Svg draws its children; a Raster repaints by $.ui.blit; onPress gets the press; copy, selection and notice', async () => {
  const cells = text => btoa(String.fromCharCode(...new Uint8Array(Uint32Array.from([...text].flatMap(char => [char.codePointAt(0), 0x01000000, 0x01000000])).buffer)))
  closeSession = r.bindModSession({
    getMessages: () => [], getModel: () => 'model', appendNotice: () => {}, canGiveKeyboard: () => true,
    readSelection: () => ({ text: 'picked text' }),
  })
  const name = await loadMod(`export function register(on) {
    on('session.start', async ($, e, next) => { await $.ui.open({ id: 'grid' }); return next(e) })
    on('ui.render', { component: 'Pane', requestId: 'grid' }, async ($, e) => {
      const { Box, Text, Raster, Button, Svg } = $.ui.resolve(e)
      return <Box flexDirection="column">
        <Raster key="g" columns={2} rows={1} cells={${JSON.stringify(cells('ab'))}} />
        <Svg viewBox="0 0 1 1"><Text>inside svg</Text></Svg>
        <Button label="Go" onPress={async press => { await $.fs.write('press.json', JSON.stringify(press)) }} />
      </Box>
    })
    on('command.run', { command: 'probe' }, async ($, e) => {
      const blit = await $.ui.blit({ requestId: 'grid', key: 'g', cells: ${JSON.stringify(cells('xy'))} })
      const wrongSize = await $.ui.blit({ requestId: 'grid', key: 'g', columns: 3, cells: ${JSON.stringify(cells('xyz'))} })
      const unknown = await $.ui.blit({ requestId: 'grid', key: 'nope', cells: ${JSON.stringify(cells('xy'))} })
      const copied = await $.ui.copy({ text: 'hello' })
      const selection = await $.ui.selection()
      $.ui.notice('call-1', 'checked by the probe')
      return { text: JSON.stringify({ blit, wrongSize, unknown, copied, selection }) }
    })
  }`)
  const surface = await show(React.createElement(r.ModPromptSurface, { isWorking: false }))
  await surface.waitFor(/ab/)
  await surface.waitFor(/inside svg/)
  r.openModToolCall('call-1')
  const out = JSON.parse((await r.dispatchModEvent('command.run', { command: 'probe', args: '' }, async () => ({ text: 'core' }))).text)
  assert.deepEqual(out.blit, {})
  assert.match(out.wrongSize.deny, /mounted at 2x1/)
  assert.match(out.unknown.deny, /no Raster "nope"/)
  // No terminal draws in this run: nothing to copy to.
  assert.deepEqual(out.copied, { isCopied: false, reason: 'no-surface' })
  assert.deepEqual(out.selection, { text: 'picked text' })
  await surface.waitFor(/xy/)
  await until(() => r.getModToolNotice('call-1'), 'the notice')
  assert.deepEqual(r.getModToolNotice('call-1'), { plugin: name, text: 'checked by the probe' })
  r.closeModToolCall('call-1')
  assert.equal(r.getModToolNotice('call-1'), undefined)
  await r.applyModControl(`Pane:${name}:grid`, 'Go', 'press')
  const press = JSON.parse(await until(() => read('press.json'), 'the press'))
  assert.equal(press.element, 'Go')
  assert.equal(press.requestId, 'grid')
  assert.equal(press.surface, 'terminal')
})

test('an Input field edits at its cursor, takes a paste, and holds several rows', async () => {
  const edit = (text, cursor, key, rows = 1) => r.editInput(text, cursor, typeof key === 'string' ? { key } : key, rows)
  assert.deepEqual(edit('abc', 3, 'left'), { kind: 'cursor', cursor: 2 })
  assert.deepEqual(edit('abc', 2, 'X'), { kind: 'edit', text: 'abXc', cursor: 3 })
  assert.deepEqual(edit('abc', 2, 'backspace'), { kind: 'edit', text: 'ac', cursor: 1 })
  assert.deepEqual(edit('abc', 1, 'delete'), { kind: 'edit', text: 'ac', cursor: 1 })
  assert.deepEqual(edit('abc', 2, { key: 'a', ctrl: true }), { kind: 'cursor', cursor: 0 })
  assert.deepEqual(edit('abc', 0, { key: 'e', ctrl: true }), { kind: 'cursor', cursor: 3 })
  assert.deepEqual(edit('one two', 7, { key: 'w', ctrl: true }), { kind: 'edit', text: 'one ', cursor: 4 })
  assert.deepEqual(edit('abc', 1, { key: 'k', ctrl: true }), { kind: 'edit', text: 'a', cursor: 1 })
  // A paste: text that is no key's name; one row folds its line breaks.
  assert.deepEqual(edit('', 0, 'pasted\nlines'), { kind: 'edit', text: 'pasted lines', cursor: 12 })
  assert.deepEqual(edit('', 0, 'pasted\nlines', 3), { kind: 'edit', text: 'pasted\nlines', cursor: 12 })
  assert.equal(edit('abc', 1, 'pageup'), undefined)
  assert.deepEqual(edit('abc', 1, 'return'), { kind: 'submit' })
  // Several rows: Shift+Enter types a newline; Up and Down walk rows, then leave.
  assert.deepEqual(edit('ab', 2, { key: 'return', shift: true }, 3), { kind: 'edit', text: 'ab\n', cursor: 3 })
  assert.deepEqual(edit('ab\ncd', 4, 'up', 3), { kind: 'cursor', cursor: 1 })
  assert.deepEqual(edit('ab\ncd', 1, 'up', 3), { kind: 'leave', step: -1 })
  assert.deepEqual(edit('ab\ncd', 1, 'down', 3), { kind: 'cursor', cursor: 4 })
  assert.deepEqual(edit('ab\ncd', 4, 'down', 3), { kind: 'leave', step: 1 })
  assert.deepEqual(edit('abc', 1, 'up'), { kind: 'leave', step: -1 })
  assert.deepEqual(r.inputWindow('a\nb\nc\nd', 6, 2), { lines: ['a', 'b', 'c', 'd'], first: 2, cursorLine: 3, cursorColumn: 0 })
  // In a pane: typing lands at the cursor, the mod sees each change.
  const pane = await show(React.createElement(r.ModFocusedPane))
  await loadMod(`export function register(on) {
    on('session.start', async ($, e, next) => { await $.ui.open({ id: 'form', focus: true }); return next(e) })
    on('ui.render', { component: 'Pane', requestId: 'form' }, async ($, e) => {
      const { Input } = $.ui.resolve(e)
      return <Input key="note" label="Note" autoFocus rows={2}
        onInput={async value => { await $.fs.write('typed.txt', value) }}
        onSubmit={async value => { await $.fs.write('sent.txt', value) }} />
    })
  }`)
  await pane.waitFor(/Note/)
  for (const letter of 'abc') await key(pane, letter)
  await key(pane, 'left')
  await key(pane, 'X')
  await until(() => read('typed.txt') === 'abXc', 'the edit at the cursor')
  await key(pane, 'return', { shift: true })
  await key(pane, 'z')
  await until(() => read('typed.txt') === 'abX\nzc', 'a second row')
  await pane.waitFor(/abX[^]*z/)
  await key(pane, 'return')
  await until(() => read('sent.txt') === 'abX\nzc', 'the submission')
})
