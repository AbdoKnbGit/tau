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
const auditPath = join(dirname(distPath), `.mermaid-rendering-${process.pid}.mjs`)
writeFileSync(auditPath, bundle.replace(entry, '\n') + `
export function mermaidTestRuntime() {
  init_exportRenderer(); init_Markdown(); init_AppState(); init_store();
  return { Markdown, StreamingMarkdown, Messages, StaticKeybindingProvider,
    AppStoreContext, createStore, getDefaultAppState, createAssistantMessage,
    createUserMessage, TerminalSizeContext, TerminalWriteProvider,
    MermaidDiagramsContext, fitMermaidArt, getCliHighlightPromise,
    createNode, FocusManager, reconciler: reconciler_default,
    StylePool, CharPool, HyperlinkPool, createScreen, cellAt, Output,
    renderNodeToOutput, resetLayoutShifted };
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
    ...initial.settings, syntaxHighlightingDisabled: true, mermaidDiagrams: true,
  } })

  async function render(element, { columns = 80, diagrams = true } = {}) {
    const tree = h(runtime.TerminalSizeContext.Provider, { value: { columns, rows: 24 } },
      h(runtime.TerminalWriteProvider, { value: noop },
        h(runtime.AppStoreContext.Provider, { value: store },
          h(runtime.StaticKeybindingProvider, null,
            h(runtime.MermaidDiagramsContext.Provider, { value: diagrams }, element)))))
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
