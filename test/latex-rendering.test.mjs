import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { marked } from 'marked'
import React from 'react'
import { LegacyRoot } from 'react-reconciler/constants.js'

// Exercise the shipped Markdown, message list, caches and Ink reconciler, with
// no renderer mocks. Run `npm run build` before this test, as for the other
// built-runtime integration tests. Keep configuration out of the user's home.
const configDir = mkdtempSync(join(tmpdir(), 'tau-latex-rendering-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_TMPDIR = configDir
// Exercise labels through Tau's existing OSC 8 path, even under node --test's
// non-TTY stdout (its ordinary fallback intentionally shows only the URL).
process.env.TERM_PROGRAM = 'kitty'
after(() => rmSync(configDir, { recursive: true, force: true }))

const distPath = resolve('dist/tau.mjs')
const bundle = readFileSync(distPath, 'utf8')
const entry = /\nvoid main\d*\(\);\r?\n/
assert.match(bundle, entry, 'the test must disable the CLI entry point')
const auditPath = join(dirname(distPath), `.latex-rendering-${process.pid}.mjs`)
writeFileSync(auditPath, bundle.replace(entry, '\n') + `
export function latexTestRuntime() {
  init_exportRenderer(); init_Markdown(); init_AppState(); init_store();
  return { Markdown, StreamingMarkdown, Messages, StaticKeybindingProvider,
    AppStoreContext, createStore, getDefaultAppState, createAssistantMessage,
    createUserMessage, TerminalSizeContext, TerminalWriteProvider,
    MermaidDiagramsContext, fitMermaidArt, getCliHighlightPromise,
    createNode, FocusManager, reconciler: reconciler_default,
    StylePool, CharPool, HyperlinkPool, createScreen, cellAt, Output,
    renderNodeToOutput, resetLayoutShifted, applyMarkdown, lexTerminalMarkdown,
    AssistantThinkingMessage, UserPlanMessage, stringWidth };
}
`)
let runtime
try {
  runtime = (await import(pathToFileURL(auditPath).href)).latexTestRuntime()
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
    null, 'latex-test', onError, onError, onError, noop)
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

test('shared ANSI renderer preserves code and parses math in every Markdown container', () => {
  const input = [
    '# Energy $E = mc^2$',
    '',
    '- **$x_1$** and [value $y^2$](https://example.com)',
    '> Root: \\(\\sqrt{x}\\)',
    '',
    '| Formula | Text |',
    '| --- | --- |',
    '| $\\alpha$ | `$x^2$` |',
    '',
    '$$',
    '\\frac{a+b}{c}',
    '$$',
    '',
    '$\\frac{a}{bc}$',
    '',
    '$$\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}$$',
    '',
    '```latex',
    '\\frac{x}{y} and $x^2$',
    '```',
    '',
    'Price $5 and $10; raw $\\unknown{x}$; normal **bold**.',
  ].join('\n')
  const result = stripVTControlCharacters(runtime.applyMarkdown(input, 'dark'))
  for (const part of ['Energy E = mc²', '- x₁ and value y²', 'Root: √x',
    'α', '(a+b)⁄c', 'a⁄(bc)', 'a = b; c = d', '\\frac{x}{y} and $x^2$', 'Price $5 and $10',
    '$\\unknown{x}$', 'normal bold']) assert.ok(result.includes(part), `${part}\n${result}`)
  assert.equal(marked.parse('$x^2$', { async: false }), '<p>$x^2$</p>\n')
  assert.equal(input.includes('$E = mc^2$'), true, 'stored/copy source is untouched')
})

test('actual Ink output covers completed messages, reasoning, plans and remounts', async () => {
  const session = createSession()
  try {
    const text = 'Energy $E=mc^2$; root \\(\\sqrt{x}\\).'
    const messages = [user('Explain energy'), assistant(text)]
    for (const id of ['initial', 'rewound', 'resumed']) {
      const frame = await session.history(messages.slice(), id)
      assert.match(frame, /E=mc²/)
      assert.match(frame, /√x/)
    }
    const thinking = await session.render(h(runtime.AssistantThinkingMessage, {
      param: { type: 'thinking', thinking: text }, verbose: true, isTranscriptMode: false,
    }))
    assert.match(thinking, /E=mc²/)
    const plan = await session.render(h(runtime.UserPlanMessage, { planContent: text }))
    assert.match(plan, /E=mc²/)
    await runtime.getCliHighlightPromise()
    session.settings({ syntaxHighlightingDisabled: false })
    assert.match(await session.render(h(runtime.Markdown, { key: 'highlighted' }, text)), /E=mc²/)
  } finally { session.close() }
})

test('real streaming frames converge without dropping equations or following Markdown', async () => {
  const session = createSession()
  try {
    for (const text of [
      'Intro.\n\n$$\n\\frac{a+b}{c}\n\n+ x^2\n$$\n\n## Done\n\nEnd.',
      '> \\[\n> x^2\n> \\]\n\nDone.',
      '- $$\n  x^2\n  $$\n\nDone.',
      'Windows.\r\n\r\n$$\r\nx^2\r\n$$\r\n\r\nDone.',
    ]) {
      await session.render(h(runtime.StreamingMarkdown, null, ''))
      let frame
      for (let i = 1; i <= text.length; i++) {
        frame = await session.render(h(runtime.StreamingMarkdown, null, text.slice(0, i)))
      }
      const completed = await session.render(h(runtime.Markdown, null, text))
      const words = s => s.replace(/\s+/g, ' ').trim()
      assert.equal(words(frame), words(completed), text)
      assert.match(frame, /x²/)
      assert.match(frame, /Done/)
    }
  } finally { session.close() }
})

test('formulas wrap with text and tables across terminal widths and resizing', async () => {
  const session = createSession()
  try {
    const text = [
      'Before $\\frac{a+b}{c} + \\alpha^2$ after.',
      '',
      '| Formula | Meaning |',
      '| --- | --- |',
      '| $\\sqrt{x}$ | Root |',
      '| $x_{10}$ | Index |',
    ].join('\n')
    for (const columns of [80, 32, 16, 8, 80]) {
      const frame = await session.render(h(runtime.Markdown, null, text), { columns })
      for (const line of frame.split('\n')) assert.ok(runtime.stringWidth(line) <= columns, line)
      assert.doesNotMatch(frame, /\$|\\frac|\\sqrt/)
      if (columns >= 32) {
        assert.match(frame, /\(a\+b\)⁄c/)
        assert.match(frame, /√x/)
        assert.match(frame, /x₁₀/)
      }
    }
  } finally { session.close() }
})

test('math and Mermaid coexist; literal fences remain literal', async () => {
  const session = createSession()
  try {
    const text = `$x^2$\n\n${fence}\n\n\`$x^2$\`\n\n\`\`\`latex\n\\frac{a}{b}\n\`\`\``
    const frame = await session.render(h(runtime.Markdown, { mermaid: true }, text))
    assertDiagram(frame)
    assert.match(frame, /x²/)
    assert.match(frame, /\$x\^2\$/)
    assert.match(frame, /\\frac\{a\}\{b\}/)
    const raw = await session.render(h(runtime.Markdown, null, text))
    assert.match(raw, /flowchart TD/)
    assert.match(raw, /x²/)
  } finally { session.close() }
})

test('malformed math cannot trigger the error boundary or remove following prose', async () => {
  const session = createSession()
  try {
    for (const source of [
      '$\\frac{a}$', '$\\unknown{x}$', '$' + '{'.repeat(1000) + 'x' + '}'.repeat(1000) + '$',
      '$$\nx^2\n\n## Following',
    ]) {
      const frame = await session.render(h(runtime.Markdown, null, source + '\n\nEnd.'))
      assert.match(frame, /End\./)
    }
    const result = runtime.applyMarkdown('$x\x1b[31m$', 'dark')
    assert.equal(result, '$x\\x1b[31m$')
  } finally { session.close() }
})
