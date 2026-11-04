import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: `export * from './src/utils/markdownTableCopy.ts'; export { lexTerminalMarkdown } from './src/utils/terminalMarkdown.ts'; export { marked } from 'marked';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const { extractMarkdownTables, createMarkdownTableCopy, marked } = runtime

test('table source is unchanged while safe TSV uses logical inline text', () => {
  const source = '| Name | Detail |\n| :--- | ---: |\n| **Málaga** &amp; 東京 | [docs](https://example.test) and `a\\|b` |\n'
  const [table] = extractMarkdownTables(`Before\n\n${source}\nAfter`)
  assert.equal(table.markdown, source + '\n')
  assert.equal(table.tsv, 'Name\tDetail\nMálaga & 東京\tdocs and a|b')
  assert.equal(table.rows, 2)
  assert.equal(table.columns, 2)
  assert.equal(table.neutralizedCells, 0)
})

test('TSV quotes embedded tabs, newlines and double quotes without extra columns', () => {
  const [table] = extractMarkdownTables('| a | b |\n|---|---|\n| one\ttwo | say "hi"<br>next |\n')
  assert.equal(table.tsv, 'a\tb\n"one\ttwo"\t"say ""hi""\nnext"')
})

test('safe TSV neutralizes formula-like cells in both headers and rows', () => {
  const values = ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '  =2', '&#61;3', '&equals;4', '\u200b=5']
  for (const value of values) {
    const source = `| ${value} |\n|---|\n| ${value} |\n`
    const [table] = extractMarkdownTables(source)
    assert.equal(table.markdown, source, value)
    assert.equal(table.neutralizedCells, 2, value)
    assert.ok(table.tsv.split('\n').every(cell => cell.startsWith("'")), value)
  }
  const [quoted] = extractMarkdownTables('| h |\n|---|\n| =HYPERLINK("https://example.test","open") |\n')
  assert.equal(quoted.tsv, 'h\n"\'=HYPERLINK(""https://example.test"",""open"")"')
})

test('literal code, escapes and link labels copy without Markdown decoration', () => {
  const [table] = extractMarkdownTables('| h |\n|---|\n| ~~old~~ *new* ![alt](https://example.test/a.png) \\* `&amp;` |\n')
  assert.equal(table.tsv, 'h\nold new alt * &amp;')
})

test('terminal and command table copying preserve the same footnote markers', () => {
  for (const definition of ['', '\n[^a]: Additional detail\n']) {
    const source = '| h |\n|---|\n| value[^a] and [docs](https://example.test) |\n' + definition
    const token = runtime.lexTerminalMarkdown(source).find(token => token.type === 'table')
    const inline = createMarkdownTableCopy(token)
    const [command] = extractMarkdownTables(source)
    assert.equal(inline.tsv, 'h\nvalue[^a] and docs')
    assert.equal(inline.tsv, command.tsv)
    assert.equal(inline.markdown, command.markdown)
  }
})

test('unknown inline extensions retain their source instead of losing content', () => {
  const token = marked.lexer('| h |\n|---|\n| value |\n')[0]
  token.rows[0][0].tokens = [{ type: 'futureInline', raw: '[future:value]' }]
  assert.equal(createMarkdownTableCopy(token).tsv, 'h\n[future:value]')
})

test('bounds reject an entire table or source rather than truncate its content', () => {
  const source = '| h |\n|---|\n| v |\n'
  const token = marked.lexer(source)[0]
  assert.equal(createMarkdownTableCopy({ ...token, rows: Array(runtime.MAX_TABLE_COPY_ROWS).fill(token.rows[0]) }), null)
  assert.equal(createMarkdownTableCopy({ ...token, header: Array(runtime.MAX_TABLE_COPY_COLUMNS + 1).fill(token.header[0]) }), null)
  assert.equal(createMarkdownTableCopy({ ...token, raw: 'x'.repeat(runtime.MAX_TABLE_COPY_SOURCE_CHARS + 1) }), null)
  assert.deepEqual(extractMarkdownTables('x'.repeat(runtime.MAX_TABLE_COPY_SOURCE_CHARS + 1) + '\n\n' + source), [])
  const tables = extractMarkdownTables(Array(runtime.MAX_TABLE_COPY_TABLES + 3).fill(source).join('\ntext\n\n'))
  assert.equal(tables.length, runtime.MAX_TABLE_COPY_TABLES)
  assert.ok(tables.every(table => table.markdown.trimEnd() === source.trimEnd()))
})

test('copy extraction leaves global Marked, input and token trees unchanged', () => {
  const source = '| h |\n|---|\n| **x** |\n'
  const token = marked.lexer(source)[0]
  const before = JSON.stringify(token)
  const defaults = marked.defaults
  createMarkdownTableCopy(token)
  extractMarkdownTables(source)
  assert.equal(JSON.stringify(token), before)
  assert.equal(marked.defaults, defaults)
  assert.equal(marked.parse('~~old~~'), '<p><del>old</del></p>\n')
  assert.deepEqual(extractMarkdownTables('```md\n' + source + '```'), [])
})
