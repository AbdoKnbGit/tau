import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { LegacyRoot } from 'react-reconciler/constants.js'

// Exercise the shipped Markdown, message list, caches and Ink reconciler, with
// no renderer mocks. Run `npm run build` before this test, as for the other
// built-runtime integration tests. Keep configuration out of the user's home.
const configDir = mkdtempSync(join(tmpdir(), 'tau-mermaid-rendering-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_TMPDIR = configDir
after(() => rmSync(configDir, { recursive: true, force: true }))

const distPath = resolve('dist/tau.mjs')
const bundle = readFileSync(distPath, 'utf8')
const entry = /\nvoid main\d*\(\);\r?\n/
assert.match(bundle, entry, 'the test must disable the CLI entry point')
// esbuild renames a symbol when a bundled package uses the same name.
const messagesComponent = bundle.match(/\b(Messages\d*) = React\d*\.memo\(MessagesImpl,/)?.[1]
assert.ok(messagesComponent, 'the Messages component was not found in the bundle')
const auditPath = join(dirname(distPath), `.mermaid-rendering-${process.pid}.mjs`)
writeFileSync(auditPath, bundle.replace(entry, '\n') + `
export function mermaidTestRuntime() {
  init_exportRenderer(); init_Markdown(); init_AppState(); init_store();
  const copied = [];
  copyClipboardText = async text => { copied.push(text); return {sequence: '', path: 'native'}; };
  let nativeHighlights = 0;
  highlightCodeWithNative = () => { nativeHighlights++; return null; };
  return { Markdown, StreamingMarkdown, Messages: ${messagesComponent}, StaticKeybindingProvider,
    applyMarkdown, PlainTranscriptContext, copied, nativeHighlights: () => nativeHighlights,
    AppStoreContext, createStore, getDefaultAppState, createAssistantMessage,
    createUserMessage, TerminalSizeContext, TerminalWriteProvider,
    MermaidDiagramsContext, fitMermaidArt, getCliHighlightPromise, normalizeAttachmentForAPI,
    createNode, FocusManager, reconciler: reconciler_default,
    StylePool, CharPool, HyperlinkPool, createScreen, cellAt, Output,
    renderNodeToOutput, resetLayoutShifted, dispatchClick };
}
`)
let runtime
try {
  runtime = (await import(pathToFileURL(auditPath).href)).mermaidTestRuntime()
} finally {
  unlinkSync(auditPath)
}

const h = React.createElement
const noop = () => {}
const source = 'flowchart TD\n  A[Start] --> B[End]'
const fence = `\x60\x60\x60mermaid\n${source}\n\x60\x60\x60`
const assistant = text => runtime.createAssistantMessage({ content: [{ type: 'text', text }] })
const user = content => runtime.createUserMessage({ content })
const assertDiagram = frame => {
  assert.match(frame, /┌─+┐/)
  assert.match(frame, /│ Start │/)
  assert.match(frame, /│ End │/)
  assert.doesNotMatch(frame, /flowchart|```|not drawn/)
}

function createSession() {
  const { reconciler } = runtime
  const root = runtime.createNode('ink-root')
  root.focusManager = new runtime.FocusManager(() => false)
  const errors = []
  const onError = error => errors.push(error)
  const container = reconciler.createContainer(root, LegacyRoot, null, false,
    null, 'mermaid-test', onError, onError, onError, noop)
  const styles = new runtime.StylePool()
  const chars = new runtime.CharPool()
  const links = new runtime.HyperlinkPool()
  const initial = runtime.getDefaultAppState()
  const store = runtime.createStore({ ...initial, settings: {
    ...initial.settings, syntaxHighlightingDisabled: true,
  } })

  async function render(element, { columns = 80, diagrams = true, plain = false } = {}) {
    const tree = h(runtime.TerminalSizeContext.Provider, { value: { columns, rows: 24 } },
      h(runtime.TerminalWriteProvider, { value: noop },
        h(runtime.AppStoreContext.Provider, { value: store },
          h(runtime.StaticKeybindingProvider, null,
            h(runtime.MermaidDiagramsContext.Provider, { value: diagrams },
              h(runtime.PlainTranscriptContext.Provider, { value: plain }, element))))))
    reconciler.updateContainerSync(tree, container, null, noop)
    reconciler.flushSyncWork()
    // Flush passive effects and any resolved highlighting suspense work.
    await new Promise(setImmediate)
    reconciler.flushSyncWork()
    assert.deepEqual(errors, [], 'rendering must not throw or use the error boundary')
    root.yogaNode.setWidth(columns)
    root.yogaNode.calculateLayout(columns)
    const height = Math.ceil(root.yogaNode.getComputedHeight())
    const screen = runtime.createScreen(columns, Math.max(1, height), styles, chars, links)
    const output = new runtime.Output({ width: columns, height, stylePool: styles, screen })
    runtime.resetLayoutShifted()
    runtime.renderNodeToOutput(root, output, { prevScreen: undefined })
    output.get()
    return Array.from({ length: height }, (_, y) => Array.from({ length: columns },
      (_, x) => runtime.cellAt(screen, x, y).char).join('').trimEnd()).join('\n')
  }

  return {
    render,
    async click(frame, label) {
      const rows = frame.split('\n')
      const y = rows.findIndex(row => row.includes('[' + label + ']'))
      assert.ok(y >= 0, 'visible button ' + label)
      assert.ok(runtime.dispatchClick(root, rows[y].indexOf('[' + label + ']') + 1, y), 'mouse hit ' + label)
      await new Promise(setImmediate)
      reconciler.flushSyncWork()
    },
    async activate(label, keyboard = false) {
      const textOf = node => node.nodeName === '#text' ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('')
      const pending = [root]
      let target
      while (pending.length) {
        const node = pending.pop()
        if (node._eventHandlers?.onClick && textOf(node).includes(`[${label}]`)) { target = node; break }
        pending.push(...(node.childNodes ?? []))
      }
      assert.ok(target, `button ${label} must exist`)
      if (keyboard) target._eventHandlers.onKeyDown({ key: 'return', preventDefault() {} })
      else target._eventHandlers.onClick({})
      await new Promise(setImmediate)
      reconciler.flushSyncWork()
    },
    settings(patch) {
      store.setState(prev => ({ ...prev, settings: { ...prev.settings, ...patch } }))
    },
    history(messages, conversationId, options) {
      return render(h(runtime.Messages, {
        messages, conversationId, tools: [], commands: [], verbose: false,
        toolJSX: null, toolUseConfirmQueue: [], inProgressToolUseIDs: new Set(),
        isMessageSelectorVisible: false, screen: 'prompt', streamingToolUses: [],
        hideLogo: true, isLoading: false,
      }), options)
    },
    close() {
      reconciler.updateContainerSync(null, container, null, noop)
      reconciler.flushSyncWork()
    },
  }
}

test('surviving Mermaid messages render through repeated rewind slices and new conversation IDs', async () => {
  const session = createSession()
  try {
    const history = [user('Draw a diagram'), assistant(fence), user('Later prompt'),
      assistant('Later reply'), user('Last prompt'), assistant('Last reply')]
    assertDiagram(await session.history(history, 'initial'))
    const once = await session.history(history.slice(0, 4), 'first-rewind')
    assertDiagram(once)
    assert.match(once, /Later reply/)
    assert.doesNotMatch(once, /Last prompt|Last reply/)
    const twice = await session.history(history.slice(0, 2), 'second-rewind')
    assertDiagram(twice)
    assert.doesNotMatch(twice, /Later prompt|Later reply/)
    assert.equal(await session.history([], 'rewind-to-first-prompt'), '')
  } finally { session.close() }
})

test('diagrams after long plain introductions render before and after rewind', async () => {
  const session = createSession()
  try {
    const reply = 'This is a plain introduction '.repeat(30) + `\n\n${fence}\n\nDone.`
    const history = [user('Explain the flow'), assistant(reply), user('Follow up'), assistant('Follow up reply')]
    assertDiagram(await session.history(history, 'initial-long'))
    assertDiagram(await session.history(history.slice(0, 2), 'rewind-long'))
  } finally { session.close() }
})

test('late Markdown syntax is parsed generically, including fences, lists and emphasis', async () => {
  const session = createSession()
  try {
    const intro = 'Plain words '.repeat(60)
    for (const suffix of ['\n\n```js\nconst answer = 42\n```', '\n1. first\n2. second', ' **bold ending**']) {
      const frame = await session.render(h(runtime.Markdown, null, intro + suffix))
      assert.doesNotMatch(frame, /```|\*\*/)
      if (suffix.startsWith('\n1.')) assert.match(frame, /\n1\. first\n2\. second/)
    }
  } finally { session.close() }
})

test('drawing-cache eviction and narrow terminals do not poison later remounts', async () => {
  const session = createSession()
  try {
    const history = [user('Diagram'), assistant(fence)]
    assertDiagram(await session.history(history, 'initial-cache'))
    // More than the bounded drawing cache can retain; correctness must not
    // depend on retaining any particular entry across a rewind.
    for (let i = 0; i < 100; i++) runtime.fitMermaidArt(`flowchart TD\n A[Node ${i}] --> B`, 80)
    assertDiagram(await session.history(history.slice(), 'evicted-cache'))
    const narrow = await session.history(history, 'narrow', { columns: 12 })
    assert.match(narrow, /not drawn/)
    assertDiagram(await session.history(history, 'wide-again', { columns: 80 }))
  } finally { session.close() }
})

test('settings and text export still select source without contaminating the next render', async () => {
  const session = createSession()
  try {
    const element = h(runtime.Markdown, { mermaid: true }, fence)
    assertDiagram(await session.render(element))
    session.settings({ mermaidDiagrams: false })
    assert.match(await session.render(element), /flowchart TD/)
    session.settings({ mermaidDiagrams: true })
    assertDiagram(await session.render(element))
    assert.match(await session.render(element, { diagrams: false }), /flowchart TD/)
    assertDiagram(await session.render(element))
    assert.match(await session.render(h(runtime.Markdown, null, fence)), /flowchart TD/)
  } finally { session.close() }
})

test('streaming, completed replies and highlighting remounts agree on finished diagrams', async () => {
  const session = createSession()
  try {
    const intro = 'A plain introduction '.repeat(30)
    const text = `${intro}\n\n${fence}\n\nAfter the diagram.`
    await session.render(h(runtime.StreamingMarkdown, { mermaid: true }, intro))
    assertDiagram(await session.render(h(runtime.StreamingMarkdown, { mermaid: true }, text)))
    await runtime.getCliHighlightPromise()
    session.settings({ syntaxHighlightingDisabled: false })
    for (const key of ['completed', 'remounted']) {
      assertDiagram(await session.render(h(runtime.Markdown, { mermaid: true, key }, text)))
    }
  } finally { session.close() }
})

test('reply checkboxes and alert labels preserve semantics across supported palettes', () => {
  for (const theme of ['dark', 'light', 'dark-daltonized', 'light-daltonized']) {
    const checklist = runtime.applyMarkdown('- [x] Done\n- [ ] Pending', theme)
    assert.match(checklist, /\[x\] Done/)
    assert.match(checklist, /\[ \] Pending/)
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      const alert = runtime.applyMarkdown(`> [!${kind}]\n> Keep **a backup**.`, theme)
      assert.match(alert, new RegExp(kind))
      assert.match(alert, /a backup/)
      assert.doesNotMatch(alert, /\[!|\*\*/)
    }
    assert.match(runtime.applyMarkdown('~~unchanged~~ and ~100', theme), /~~unchanged~~ and ~100/)
  }
})

test('streaming, completion, export and remount isolate footnote resolution', async () => {
  const session = createSession()
  const text = 'A claim[^a].\n\n[^a]: Supporting detail.\n'
  try {
    assert.match(await session.render(h(runtime.StreamingMarkdown, null, text)), /\[\^a\]/)
    const complete = h(runtime.Markdown, { interactive: true }, text)
    const frame = await session.render(complete)
    assert.match(frame, /claim¹/)
    assert.match(frame, /¹ Supporting detail/)
    assert.doesNotMatch(frame, /\[\^a\]/)
    assert.match(await session.render(complete, { plain: true }), /\[\^a\]/)
    assert.doesNotMatch(await session.render(complete), /\[\^a\]/)
    assert.match(await session.render(h(runtime.Markdown, { resolveFootnotes: false }, text)), /\[\^a\]/)
    assert.doesNotMatch(await session.render(h(runtime.Markdown, { key: 'new' }, text)), /\[\^a\]/)
  } finally { session.close() }
})

test('code controls expand, copy complete source and resize without native helper work', async () => {
  const session = createSession()
  const code = Array.from({ length: 35 }, (_, i) => `const line${i} = ${i};`).join('\n')
  const text = `${fence.slice(0, 0)}\x60\x60\x60typescript\n${code}\n\x60\x60\x60`
  const element = h(runtime.Markdown, { interactive: true }, text)
  try {
    session.settings({ syntaxHighlightingDisabled: false })
    await runtime.getCliHighlightPromise()
    const initial = await session.render(element, { columns: 100 })
    assert.match(initial, /typescript/)
    assert.match(initial, /Copy code/)
    assert.doesNotMatch(initial, /line34/)
    await session.activate('Expand', true)
    assert.match(await session.render(element, { columns: 100 }), /line34/)
    const narrow = await session.render(element, { columns: 24 })
    assert.ok(narrow.split('\n').length < 600)
    assert.match(await session.render(element, { columns: 100 }), /line34/)
    await session.activate('Copy code')
    assert.equal(runtime.copied.at(-1), code)
    assert.equal(runtime.nativeHighlights(), 0)
    const exported = await session.render(element, { plain: true })
    assert.match(exported, /line34/)
    assert.doesNotMatch(exported, /Copy code|Show less|typescript ·/)
  } finally { session.close() }
})

test('long single-line code has a bounded narrow preview and complete copy source', async () => {
  const session = createSession()
  const code = 'x'.repeat(60000)
  const element = h(runtime.Markdown, { interactive: true }, `\x60\x60\x60unknown\n${code}\n\x60\x60\x60`)
  try {
    session.settings({ syntaxHighlightingDisabled: false })
    await runtime.getCliHighlightPromise()
    const frame = await session.render(element, { columns: 8 })
    assert.ok(frame.split('\n').length < 700, `bounded rows: ${frame.split('\n').length}`)
    await session.activate('Copy code')
    assert.equal(runtime.copied.at(-1), code)
  } finally { session.close() }
})

test('inline table TSV preserves footnotes and leaves plain export free of controls', async () => {
  const session = createSession()
  const text = '| h |\n|---|\n| value[^a] |\n\n[^a]: Note\n'
  const element = h(runtime.Markdown, { interactive: true }, text)
  try {
    assert.match(await session.render(element), /Copy safe TSV/)
    await session.activate('Copy safe TSV')
    assert.equal(runtime.copied.at(-1), 'h\nvalue[^a]')
    assert.doesNotMatch(await session.render(element, { plain: true }), /Copy safe TSV|Copy table/)
  } finally { session.close() }
})

test('new Mermaid charts render in replies and survive narrow/wide cache transitions', async () => {
  const session = createSession()
  const examples = [
    'xychart-beta\n x-axis [A, B]\n bar [2, 4]',
    'xychart-beta\n x-axis [A, B]\n line [2, 4]',
    'pie\n "A" : 2\n "B" : 4',
    'gantt\n dateFormat YYYY-MM-DD\n Build :a, 2026-01-01, 2d',
  ]
  try {
    for (const source of examples) {
      const element = h(runtime.Markdown, { mermaid: true }, `\x60\x60\x60mermaid\n${source}\n\x60\x60\x60`)
      assert.doesNotMatch(await session.render(element, { columns: 100 }), /not drawn/)
      await session.render(element, { columns: 15 })
      assert.doesNotMatch(await session.render(element, { columns: 100 }), /not drawn/)
      assert.match(await session.render(element, { diagrams: false }), new RegExp(source.split('\n')[0]))
    }
  } finally { session.close() }
})

test('diagram controls respond at their screen coordinates and preserve original source', async () => {
  const session = createSession()
  const original = 'flowchart TD\n  A[🚀 Café] --> B[東京]'
  const markdown = source => h(runtime.Markdown, { mermaid: true, interactive: true }, '\x60\x60\x60mermaid\n' + source + '\n\x60\x60\x60')
  const element = markdown(original)
  const render = (view = element) => session.render(view, { columns: 100 })
  try {
    const frame = await render()
    assert.match(frame, /┌─/)
    await session.click(frame, 'Copy diagram art')
    assert.equal(runtime.copied.at(-1), runtime.fitMermaidArt(original, 100).art.rows.map(row => row.map(span => span.text).join('')).join('\n'))
    await session.click(await render(), 'Show source')
    assert.match(await render(), /A\[🚀 Café\] --> B\[東京\]/)
    await session.click(await render(), 'Copy diagram source')
    assert.equal(runtime.copied.at(-1), original)
    await session.click(await render(), 'Show diagram')
    assert.match(await render(), /┌─/)
    const invalid = markdown('pie\n "Bad" : -3')
    const fallback = await render(invalid)
    assert.match(fallback, /not drawn/)
    assert.doesNotMatch(fallback, /Copy diagram art|Hide source/)
    await session.click(fallback, 'Show source')
    assert.match(await render(invalid), /"Bad" : -3/)
    session.settings({ mermaidDiagrams: false })
    assert.doesNotMatch(await render(), /Copy diagram|Show source|┌─/)
  } finally { session.close() }
})

test('resumed diagram attachments replay the saved guidance and support older unversioned records', () => {
  const text = attachment => runtime.normalizeAttachmentForAPI(attachment)[0].message.content
  for (const record of [
    { type: 'mermaid_diagrams', enabled: true },
    { type: 'mermaid_not_drawn', reasons: ['the graph was too wide'] },
  ]) {
    const frozen = Object.freeze({ ...record, guidance: 'Guidance from a previous session' })
    assert.equal(text(frozen), '<system-reminder>\nGuidance from a previous session\n</system-reminder>')
    assert.match(text(record), /# Diagrams/)
    assert.doesNotMatch(text(record), /Choose flowchart TD/)
  }
})
