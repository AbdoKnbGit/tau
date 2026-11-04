import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: `export * from './src/utils/markdownCodePreview.ts'`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const {
  markdownCodePreview,
  CODE_FOLD_LINES,
  CODE_EXPAND_AT,
  CODE_MAX_RENDER_LINES,
  CODE_MAX_RENDER_CHARS,
} = runtime

const lines = length => Array.from({ length }, (_, i) => `line ${i + 1}`).join('\n')
const lineCount = text => text ? text.split('\n').length : 0

test('short code is complete, and the fold threshold does not hide content', () => {
  for (const source of ['', 'const value = 1;', lines(CODE_EXPAND_AT)]) {
    for (const expanded of [false, true]) {
      const preview = markdownCodePreview(source, expanded)
      assert.equal(preview.text, source)
      assert.equal(preview.hidden, false)
      assert.equal(preview.foldable, false)
      assert.equal(preview.totalLines, lineCount(source))
    }
  }
})

test('a long block folds and expands without changing the complete source', () => {
  const source = lines(CODE_EXPAND_AT + 1)
  const original = source
  const folded = markdownCodePreview(source, false)
  assert.equal(lineCount(folded.text), CODE_FOLD_LINES)
  assert.equal(folded.text, lines(CODE_FOLD_LINES))
  assert.equal(folded.hidden, true)
  assert.equal(folded.foldable, true)
  assert.equal(folded.totalLines, CODE_EXPAND_AT + 1)
  const expanded = markdownCodePreview(source, true)
  assert.equal(expanded.text, source)
  assert.equal(expanded.hidden, false)
  assert.equal(source, original, 'the source retained for copy/export is complete')
  assert.equal(markdownCodePreview(source, false).text, folded.text)
})

test('expanded previews stop at the line budget for large blocks', () => {
  const source = lines(CODE_MAX_RENDER_LINES * 4)
  const preview = markdownCodePreview(source, true)
  assert.equal(preview.text, lines(CODE_MAX_RENDER_LINES))
  assert.equal(lineCount(preview.text), CODE_MAX_RENDER_LINES)
  assert.equal(preview.hidden, true)
  assert.equal(preview.totalLines, CODE_MAX_RENDER_LINES * 4)
  assert.ok(source.endsWith(`line ${CODE_MAX_RENDER_LINES * 4}`))
})

test('a huge single line is bounded even after expand', () => {
  const source = 'x'.repeat(CODE_MAX_RENDER_CHARS * 3)
  for (const expanded of [false, true]) {
    const preview = markdownCodePreview(source, expanded)
    assert.equal(preview.text.length, CODE_MAX_RENDER_CHARS)
    assert.equal(preview.hidden, true)
    assert.equal(preview.foldable, true)
    assert.equal(preview.totalLines, 1)
  }
  assert.equal(source.length, CODE_MAX_RENDER_CHARS * 3)
  assert.equal(markdownCodePreview('x'.repeat(CODE_MAX_RENDER_CHARS), false).hidden, false)
})

test('the character budget never cuts a UTF-16 surrogate pair in half', () => {
  const prefix = 'x'.repeat(CODE_MAX_RENDER_CHARS - 1)
  const source = prefix + '😀tail'
  for (const expanded of [false, true]) {
    const preview = markdownCodePreview(source, expanded)
    assert.equal(preview.text, prefix)
    assert.equal(preview.hidden, true)
    assert.equal(preview.text.isWellFormed(), true)
  }
  const exact = 'x'.repeat(CODE_MAX_RENDER_CHARS - 2) + '😀'
  assert.equal(markdownCodePreview(exact, true).text, exact)
  assert.equal(markdownCodePreview(exact, true).hidden, false)
})

test('both budgets apply together, including blank lines and a long later line', () => {
  const source = lines(CODE_FOLD_LINES) + '\n' + 'y'.repeat(CODE_MAX_RENDER_CHARS * 2)
  const folded = markdownCodePreview(source, false)
  const expanded = markdownCodePreview(source, true)
  assert.equal(folded.text, lines(CODE_FOLD_LINES))
  assert.ok(expanded.text.length <= CODE_MAX_RENDER_CHARS)
  assert.ok(expanded.text.startsWith(folded.text + '\n'))
  assert.equal(expanded.hidden, true)
  const blanks = markdownCodePreview('\n'.repeat(CODE_MAX_RENDER_LINES * 3), true)
  assert.ok(blanks.text.length <= CODE_MAX_RENDER_LINES)
  assert.equal(blanks.hidden, true)
  assert.equal(blanks.totalLines, CODE_MAX_RENDER_LINES * 3 + 1)
})

test('CRLF and trailing newlines preserve the original source for copying', () => {
  const source = 'first\r\nsecond\r\n'
  const preview = markdownCodePreview(source, true)
  assert.equal(preview.totalLines, 3)
  assert.equal(preview.hidden, false)
  assert.equal(source, 'first\r\nsecond\r\n')
  assert.ok(preview.text.startsWith('first\r\nsecond'))
})
test('wrapped visual work is bounded on narrow terminals including tabs and wide glyphs', () => {
  for (const width of [1, 8, 24]) {
    for (const source of ['x'.repeat(60000), '\t'.repeat(60000), '界'.repeat(30000)]) {
      const preview = markdownCodePreview(source, true, width)
      assert.equal(preview.hidden, true)
      const room = Math.max(1, width - String(preview.totalLines).length - 4)
      assert.ok(preview.text.length <= 400 * room)
      assert.ok(source.startsWith(preview.text))
    }
  }
})
