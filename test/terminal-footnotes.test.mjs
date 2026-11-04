import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: `export * from './src/utils/terminalMarkdown.ts'; export * from './src/utils/terminalFootnotes.ts'; export { marked } from 'marked';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const { lexTerminalMarkdown: lex, stableMarkdownPrefix: stable, marked } = runtime
function flatten(tokens) {
  return tokens.flatMap(token => [token, ...flatten(token.tokens ?? []),
    ...flatten(token.items ?? []), ...flatten(token.header?.flatMap(cell => cell.tokens) ?? []),
    ...flatten(token.rows?.flatMap(row => row.flatMap(cell => cell.tokens)) ?? [])])
}
const references = tokens => flatten(tokens).filter(token => token.type === 'terminalFootnote')
const list = tokens => tokens.find(token => token.type === 'terminalFootnoteList')

test('complete documents number notes by first reference and reuse repeated references', () => {
  const tokens = lex('B[^b], A[^a], B[^B].\n\n[^a]: Alpha **bold**\n[^b]: Beta\n')
  assert.deepEqual(references(tokens).map(token => token.number), [1, 2, 1])
  assert.deepEqual(list(tokens).entries.map(note => note.number), [1, 2])
  assert.equal(list(tokens).entries[0].tokens[0].text, 'Beta')
  assert.equal(flatten(list(tokens).entries[1].tokens).some(token => token.type === 'strong'), true)
})

test('references in lists, quotes and table cells share one document note list', () => {
  const tokens = lex('- list[^a]\n\n> quote[^a]\n\n| h |\n|---|\n| cell[^a] |\n\n[^a]: One note\n')
  assert.deepEqual(references(tokens).map(token => token.number), [1, 1, 1])
  assert.equal(list(tokens).entries.length, 1)
})

test('undefined, malformed and oversized notes keep their raw source', () => {
  for (const source of ['Unknown[^missing].', 'Bad[^with space].', `Long[^${'x'.repeat(65)}].`, `X[^a]\n\n[^a]: ${'x'.repeat(5000)}\n`]) {
    const tokens = lex(source)
    assert.equal(list(tokens), undefined, source.slice(0, 40))
    assert.equal(tokens.map(token => token.raw).join(''), source)
    assert.ok(references(tokens).every(token => token.number === undefined))
  }
})

test('code, escaped markers, HTML raw blocks and link destinations are not references', () => {
  const tokens = lex('`[^a]` \\[^a] [link](https://example.test/[^a])\n\n```md\n[^a]\n[^a]: code\n```\n\n<code>[^a]</code>\n\n[^a]: Note\n')
  assert.deepEqual(references(tokens), [])
  assert.equal(list(tokens), undefined)
})

test('streaming keeps references unresolved and preserves raw offsets at every prefix', () => {
  const source = 'A[^a].\n\n| h |\n|---|\n| v[^a] |\n\n[^a]: first\n    continuation\n\nEnd.'
  let previous = ''
  for (let length = 1; length <= source.length; length++) {
    const prefix = source.slice(0, length)
    const tokens = lex(prefix, false)
    // Marked normalizes a whitespace-only unfinished last line. Compare its
    // meaningful raw prefix while separately checking the actual split below.
    assert.equal(tokens.map(token => token.raw).join('').trimEnd(), prefix.trimEnd(), `raw length ${length}`)
    assert.ok(references(tokens).every(token => token.number === undefined), `resolved length ${length}`)
    assert.equal(list(tokens), undefined)
    const next = stable(prefix, previous)
    assert.ok(prefix.startsWith(next), `prefix length ${length}`)
    assert.ok(next.startsWith(previous), `monotonic length ${length}`)
    previous = next
  }
  assert.equal(list(lex(source)).entries.length, 1)
})

test('separate documents and parses cannot reuse note numbers or mutate global HTML Marked', () => {
  const source = 'X[^a]\n\n[^a]: One\n'
  const before = marked.parse(source)
  const first = lex(source)
  first[0].tokens[1].number = 99
  const second = lex(source)
  assert.deepEqual(references(second).map(token => token.number), [1])
  assert.deepEqual(references(lex('Unresolved[^a]')).map(token => token.number), [undefined])
  assert.equal(marked.parse(source), before)
  assert.equal(marked.parse('~~old~~'), '<p><del>old</del></p>\n')
})

test('duplicate definitions retain the first definition and keep later source visible', () => {
  const tokens = lex('X[^a]\n\n[^a]: First\n\n[^A]: Second\n')
  assert.equal(list(tokens).entries[0].tokens[0].text, 'First')
  const definitions = tokens.filter(token => token.type === 'terminalFootnoteDefinition')
  assert.equal(definitions[0].used, true)
  assert.equal(definitions[1].used, undefined)
  assert.match(definitions[1].raw, /Second/)
})

test('oversized continuation bodies remain unresolved instead of creating a partial note', () => {
  for (const continuation of [Array.from({ length: 35 }, (_, index) => `    line ${index}\n`).join(''), `    ${'x'.repeat(5000)}\n`]) {
    const tokens = lex('X[^a]\n\n[^a]: Start\n' + continuation)
    assert.equal(list(tokens), undefined)
    assert.ok(references(tokens).every(token => token.number === undefined))
  }
})
