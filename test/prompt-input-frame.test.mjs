import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// The prompt bar as the shipped bundle draws it: the real frame, the real text
// input and the real cursor model. Run `npm run build` first.
const repoDir = process.cwd()
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'tau-prompt-frame-')))
const projectDir = join(scratch, 'project')
mkdirSync(join(projectDir, '.git'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = join(scratch, 'config')
process.env.CLAUDE_CODE_TMPDIR = join(scratch, 'tmp')
process.env.DISABLE_TELEMETRY = '1'
process.chdir(projectDir)

after(async () => {
  process.chdir(repoDir)
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 100 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
})

const r = await loadBuiltRuntime({
  paths: [
    'src/components/PromptInput/PromptInputFrame.tsx',
    'src/components/PromptInput/PromptInputModeIndicator.tsx',
    'src/components/TextInput.tsx',
    'src/ink/components/Text.tsx',
    'src/utils/Cursor.ts',
    'src/ink/hit-test.ts',
  ],
  exports: [
    'PromptInputFrame', 'promptTextColumns', 'PROMPT_INDICATOR_COLUMNS',
    'TextInput', 'Text', 'Cursor', 'dispatchClick',
  ],
})
const h = React.createElement
const TOP = '╭'
const BOTTOM = '╰'

/** Rows between the frame's top and bottom border. */
function textRows(screen) {
  const lines = screen.split('\n')
  const top = lines.findIndex(line => line.startsWith(TOP))
  const bottom = lines.findIndex(line => line.startsWith(BOTTOM))
  assert.ok(top >= 0 && bottom > top, `no prompt frame on screen:\n${screen}`)
  return lines.slice(top + 1, bottom)
}

/** A prompt the way PromptInput wires it, holding its own value and cursor. */
function prompt({ columns, initial = '', cursor = initial.length, mode = 'prompt', onClick }) {
  const textColumns = r.promptTextColumns(columns, 'framed')
  const state = { value: initial, offset: cursor, textColumns }
  function Prompt() {
    const [value, setValue] = React.useState(initial)
    const [offset, setOffset] = React.useState(cursor)
    state.value = value
    state.offset = offset
    return h(r.PromptInputFrame, {
      borderColor: 'brand', mode, isLoading: false,
      onTextClick: event => onClick?.(event, state),
    }, h(r.TextInput, {
      value, onChange: setValue, onSubmit: () => {}, columns: textColumns,
      cursorOffset: offset, onChangeCursorOffset: setOffset,
      focus: true, showCursor: true, multiline: true,
    }))
  }
  return { state, element: h(Prompt) }
}

/** How many lines the cursor model wraps the value into. */
function modelLines({ value, offset, textColumns }) {
  return r.Cursor.fromText(value, textColumns, offset).measuredText.getWrappedText().length
}

test('the text width the cursor model wraps at is the width the frame gives the text', async () => {
  for (const columns of [16, 24, 40, 61, 80, 120]) {
    for (const mode of ['prompt', 'bash']) {
      const ui = await mount(r, h(r.PromptInputFrame, { borderColor: 'brand', mode, isLoading: false },
        h(r.Text, { wrap: 'wrap' }, 'x'.repeat(400))), { columns })
      try {
        const [first] = textRows(ui.frame())
        const width = first.split('').filter(char => char === 'x').length
        assert.equal(r.promptTextColumns(columns, 'framed'), width, `${mode} prompt at ${columns} columns`)
      } finally {
        ui.close()
      }
    }
  }
  // The banner row (indicator and text, no box) keeps the width it always had.
  for (const columns of [40, 80]) {
    assert.equal(r.promptTextColumns(columns, 'banner'), columns - r.PROMPT_INDICATOR_COLUMNS - 1)
  }
})

test('typing paints exactly the rows the cursor model wraps into', async () => {
  const sentence = 'please look at the plan mode bug where sub agents keep  asking for   permission'
  for (const columns of [30, 47, 60, 80]) {
    const p = prompt({ columns })
    const ui = await mount(r, p.element, { columns })
    let wrapped = false
    try {
      for (const char of sentence) {
        await ui.press(char)
        const rows = textRows(ui.frame())
        assert.equal(rows.length, modelLines(p.state),
          `${columns} columns after ${JSON.stringify(p.state.value)}:\n${rows.join('\n')}`)
        wrapped ||= rows.length > 1
      }
      assert.equal(p.state.value, sentence)
      assert.ok(wrapped, `the sentence never wrapped at ${columns} columns`)
    } finally {
      ui.close()
    }
  }
})

test('wide characters (two columns each) wrap the same on screen as in the model', async () => {
  const text = 'fix 漢字 wrapping 😀 near the box edge with wide 日本語 text and ✓ marks 한국어 too'
  for (const columns of [24, 37, 52]) {
    const p = prompt({ columns })
    const ui = await mount(r, p.element, { columns })
    try {
      for (const char of text) {
        await ui.press(char)
        const rows = textRows(ui.frame())
        assert.equal(rows.length, modelLines(p.state),
          `${columns} columns after ${JSON.stringify(p.state.value)}:\n${rows.join('\n')}`)
      }
      assert.equal(p.state.value, text)
    } finally {
      ui.close()
    }
  }
})

test('inserting spaces mid-line never makes a word jump onto a row of its own', async () => {
  const base = 'fix the prompt bar wrapping when I add spaces here and then keep typing'
  const at = base.indexOf('here')
  for (const columns of [40, 60, 80]) {
    const p = prompt({ columns, initial: base, cursor: at })
    const ui = await mount(r, p.element, { columns })
    try {
      for (let spaces = 1; spaces <= 8; spaces++) {
        await ui.press(' ')
        const rows = textRows(ui.frame())
        assert.equal(p.state.value, base.slice(0, at) + ' '.repeat(spaces) + base.slice(at))
        assert.equal(rows.length, modelLines(p.state), `${columns} columns, ${spaces} spaces:\n${rows.join('\n')}`)
      }
    } finally {
      ui.close()
    }
  }
})

test('line breaks with spaces typed before them keep the rows the model expects', async () => {
  const words = 'investigate why the plan mode prompt keeps asking for permission when sub agents run'.split(' ')
  for (const columns of [40, 60]) {
    for (let count = 3; count <= words.length; count += 2) {
      const first = words.slice(0, count).join(' ')
      const initial = `${first}\n\nsecond line here`
      const p = prompt({ columns, initial, cursor: first.length })
      const ui = await mount(r, p.element, { columns })
      try {
        for (let spaces = 1; spaces <= 3; spaces++) {
          await ui.press(' ')
          const rows = textRows(ui.frame())
          assert.equal(rows.length, modelLines(p.state),
            `${columns} columns, ${JSON.stringify(p.state.value)}:\n${rows.join('\n')}`)
        }
      } finally {
        ui.close()
      }
    }
  }
})

test('a click puts the cursor on the character under the pointer', async () => {
  const columns = 32
  const value = 'abcdefghij klmnopqrst uvwxyz 0123456789 abcdefghij klmnopqrstuvwxyz'
  const clicked = []
  const p = prompt({
    columns, initial: value, cursor: 0,
    onClick(event, state) {
      // PromptInput's handleInputClick, without a viewport (all lines shown).
      const cursor = r.Cursor.fromText(state.value, state.textColumns, state.offset)
      clicked.push(cursor.measuredText.getOffsetFromPosition({ line: event.localRow, column: event.localCol }))
    },
  })
  const ui = await mount(r, p.element, { columns })
  try {
    const screen = ui.frame()
    const lines = screen.split('\n')
    const firstRow = lines.findIndex(line => line.startsWith(TOP)) + 1
    const textLeft = lines[firstRow].indexOf(value[0])
    assert.ok(textLeft > 0, `the value is not on the first row:\n${screen}`)
    for (const offset of [0, 5, 10, 11, 25, 33, 40, value.length - 1]) {
      const { line, column } = r.Cursor.fromText(value, p.state.textColumns, offset).getPosition()
      const x = textLeft + column
      const y = firstRow + line
      assert.equal(lines[y][x], value[offset], `offset ${offset} is not drawn at (${x}, ${y})`)
      assert.ok(r.dispatchClick(ui.root, x, y, false), `no click handler at (${x}, ${y})`)
      assert.equal(clicked.at(-1), offset, `clicking ${JSON.stringify(value[offset])} at offset ${offset}`)
    }
    // The indicator and padding are not text: clicking them moves nothing.
    const before = clicked.length
    r.dispatchClick(ui.root, textLeft - 1, firstRow, false)
    assert.equal(clicked.length, before)
  } finally {
    ui.close()
  }
})
