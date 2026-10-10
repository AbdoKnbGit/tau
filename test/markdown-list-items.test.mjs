import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

// Exercise the shipped markdown renderer. Run `npm run build` before this
// test, as for the other built-runtime tests. Keep configuration out of the
// user's home.
const configDir = mkdtempSync(join(tmpdir(), 'tau-markdown-lists-'))
process.env.CLAUDE_CONFIG_DIR = configDir
after(() => rmSync(configDir, { recursive: true, force: true }))

const distPath = resolve('dist/tau.mjs')
const bundle = readFileSync(distPath, 'utf8')
const entry = /\nvoid main\d*\(\);\r?\n/
assert.match(bundle, entry, 'the test must disable the CLI entry point')
const init = bundle.match(/var (init_\w+) = __esm\(\{\s*"src\/utils\/markdown\.ts"\(\)/)
assert.ok(init, 'missing built module src/utils/markdown.ts')
const auditPath = join(dirname(distPath), `.markdown-lists-${process.pid}.mjs`)
writeFileSync(auditPath, bundle.replace(entry, '\n') +
  `\nexport function markdownTestRuntime() { ${init[1]}(); return { applyMarkdown }; }\n`)
let runtime
try {
  runtime = (await import(pathToFileURL(auditPath).href)).markdownTestRuntime()
} finally {
  unlinkSync(auditPath)
}

const render = (...lines) => stripVTControlCharacters(runtime.applyMarkdown(lines.join('\n'), 'dark'))
const fence = '```'

test('text after a code block stays in its item instead of repeating the number', () => {
  assert.equal(render(
    '1. **Alpha Dilution**',
    '   Apply alpha in the background:',
    `   ${fence}css`,
    '   background: red;',
    `   ${fence}`,
    '   Preserves contrast.',
    '2. **Translucent Tokens**',
  ), [
    '1. Alpha Dilution',
    '   Apply alpha in the background:',
    '   background: red;',
    '   Preserves contrast.',
    '2. Translucent Tokens',
  ].join('\n'))
})

test('a later paragraph stays in its bullet', () => {
  assert.equal(render('- a', '', '  more a', '- b'), '- a\n\n  more a\n- b')
})

test('nested lists and continuation lines line up under the item text', () => {
  assert.equal(render(
    '1. Step',
    '   - a',
    '     more a',
    '   - b',
  ), '1. Step\n   - a\n     more a\n   - b')
  assert.equal(render('- a', '  - b', '    - c', '    - d'), '- a\n  - b\n    - c\n    - d')
  assert.equal(render('1. a', '   1. b', '      1. c'), '1. a\n   a. b\n      i. c')
})

test('an item that opens with a code block keeps its marker', () => {
  assert.equal(render('- run:', `- ${fence}sh`, '  npm test', `  ${fence}`), '- run:\n- npm test')
})

test('plain lists render as before', () => {
  assert.equal(render('- one', '- two'), '- one\n- two')
  assert.equal(render('3. three', '4. four'), '3. three\n4. four')
  assert.equal(render('- a', '  - b', '- c'), '- a\n  - b\n- c')
})
