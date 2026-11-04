import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { stripVTControlCharacters } from 'node:util'
import test from 'node:test'
import { transformSync } from 'esbuild'
import ts from 'typescript'

const require = createRequire(import.meta.url)

// Compile the production modules in memory. Only unrelated I/O/UI import
// boundaries are replaced; shell splitting, word refinement and diff rendering
// below execute their real implementations without launching the CLI.
function load(path, dependencies = {}, extra = '', source) {
  const module = { exports: {} }
  const code = transformSync((source ?? readFileSync(resolve(path), 'utf8')) + extra, {
    loader: path.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'node20',
  }).code
  runInNewContext(code, {
    module, exports: module.exports,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    process,
  }, { filename: path })
  return module.exports
}

const shellQuote = load('src/utils/bash/shellQuote.ts', {
  '../log.js': { logError() {} },
  '../slowOperations.js': { jsonStringify: JSON.stringify },
})
const heredoc = load('src/utils/bash/heredoc.ts')
const commands = load('src/utils/bash/commands.ts', {
  './heredoc.js': heredoc,
  './shellQuote.js': shellQuote,
  '../shell/prefix.js': {
    createCommandPrefixExtractor: () => () => null,
    createSubcommandPrefixExtractor: () => () => null,
  },
})
const bashPath = 'src/tools/BashTool/BashTool.tsx'
const bashSource = ts.createSourceFile(bashPath, readFileSync(bashPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set([
  'BASH_SEARCH_COMMANDS', 'BASH_READ_COMMANDS', 'BASH_LIST_COMMANDS', 'BASH_SEMANTIC_NEUTRAL_COMMANDS',
  'hasReadDisplaySideEffects', 'hasMutatingReadDisplayArgs', 'isSearchOrReadBashCommand',
])
const classifierSource = bashSource.statements.filter(statement =>
  (ts.isFunctionDeclaration(statement) && names.has(statement.name?.text)) ||
  (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d => names.has(d.name.getText(bashSource)))),
).map(statement => statement.getText(bashSource)).join('\n')
const { isSearchOrReadBashCommand } = load(bashPath, {
  './commands.js': commands,
  'shell-quote': require('shell-quote'),
}, '', `import { splitCommandWithOperators } from './commands.js';
import { parse as parseShellWords } from 'shell-quote';\n${classifierSource}`)

for (const command of [
  'cat input.txt > output.txt', 'cat input.txt >> output.txt', 'cat input.txt 2> errors.txt',
  'cat input.txt &> output.txt', 'cat < input.txt', 'cat <<EOF\nhello\nEOF',
  'find . -delete', 'find . -exec touch changed \\;', 'find . -fprint output.txt',
  'sort -o output.txt input.txt', 'sort --output=output.txt input.txt', 'sort -rooutput.txt input.txt',
  'sort --compress-program=custom input.txt', 'uniq input.txt output.txt',
  'uniq -f 2 input.txt output.txt', 'rg --pre=custom needle .', 'rg --hostname-bin custom needle .',
  "awk 'BEGIN {system(\"touch changed\")}'", "awk '{ print > \"changed\" }' input.txt",
  'awk -f custom.awk input.txt', 'file -C -m magic',
  'cat "$(touch changed)"', 'cat `touch changed`', 'cat <(touch changed)',
  'find . $ACTION', 'cat "unterminated',
]) {
  test(`shell display retains ordinary command presentation: ${command}`, () => {
    const actual = isSearchOrReadBashCommand(command)
    assert.equal(actual.isRead || actual.isSearch || actual.isList, false)
  })
}

for (const [command, kind] of [
  ['cat input.txt', 'isRead'], ['cat "file > name.txt"', 'isRead'],
  ["cat '$(literal).txt'", 'isRead'], ['cat escaped\\>name.txt', 'isRead'],
  ['rg "find . -delete > output" src', 'isSearch'], ["rg '\\$\\(literal\\)' src", 'isSearch'],
  ['rg -- --pre=literal.txt', 'isSearch'], ['sort -n input.txt', 'isRead'],
  ['uniq -f 2 input.txt', 'isRead'], ["awk '{print $1}' input.txt", 'isRead'],
  ['find . -name "*.ts"', 'isSearch'], ['ls src | head -n 3', 'isRead'],
  ['cat one.txt && printf "---" && cat two.txt', 'isRead'],
]) {
  test(`shell display preserves benign classification: ${command}`, () => {
    assert.equal(isSearchOrReadBashCommand(command)[kind], true)
  })
}

const realDiff = require('diff')
let refinements = 0
const budget = load('src/utils/wordDiffBudget.ts', {
  diff: { ...realDiff, diffArrays(...args) { refinements++; return realDiff.diffArrays(...args) } },
})
const colorDiff = load('src/native-ts/color-diff/index.ts', {
  '../../utils/wordDiffBudget.js': budget,
  '../../ink/stringWidth.js': { stringWidth: text => text.length },
  '../../utils/log.js': { logError() {} },
})
const ink = {
  Box: 'box', Text: 'text', NoSelect: 'no-select',
  useTheme: () => ['dark'], wrapText: text => text,
}
const fallback = load('src/components/StructuredDiff/Fallback.tsx', {
  '../../utils/wordDiffBudget.js': budget,
  '../../ink/stringWidth.js': { stringWidth: text => text.length },
  '../../ink.js': ink,
}, '\nexport { formatDiff as renderFallbackForTest };')

function textOf(tree) {
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (tree && typeof tree === 'object') return textOf(tree.props?.children)
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : ''
}

test('ordinary word edits preserve exact whitespace and Unicode on both sides', () => {
  const oldText = 'const café = originalName( x );'
  const newText = 'const café = renamed( x );'
  for (const refine of [budget.boundedWordDiff, fallback.calculateWordDiffs]) {
    const parts = refine(oldText, newText)
    assert.ok(parts)
    assert.equal(parts.filter(p => !p.added).map(p => p.value).join(''), oldText)
    assert.equal(parts.filter(p => !p.removed).map(p => p.value).join(''), newText)
  }
  const [oldRanges, newRanges] = colorDiff.__test.wordDiffStrings(oldText, newText)
  assert.ok(oldRanges.length && newRanges.length, 'ordinary code edits retain word highlighting')
})

test('oversized source and token work are refused before entering the diff engine', () => {
  const pairs = [
    ['x'.repeat(20_000), 'y'.repeat(20_000)],
    ['a '.repeat(1_100), 'one'],
    [Array.from({ length: 270 }, (_, i) => `old${i}`).join(' '), Array.from({ length: 270 }, (_, i) => `new${i}`).join(' ')],
  ]
  for (const [oldText, newText] of pairs) {
    const before = refinements
    assert.equal(budget.boundedWordDiff(oldText, newText), null)
    assert.equal(fallback.calculateWordDiffs(oldText, newText), null)
    const [oldRanges, newRanges] = colorDiff.__test.wordDiffStrings(oldText, newText)
    assert.equal(oldRanges.length + newRanges.length, 0)
    assert.equal(refinements, before)
  }
})

test('adversarial edits within input limits stop at a deterministic edit budget', () => {
  const before = refinements
  assert.equal(budget.boundedWordDiff('a,'.repeat(140), 'b;'.repeat(140)), null)
  assert.equal(refinements, before + 1)
})

test('over-budget pairs retain both full source lines in primary and disabled-syntax renderers', () => {
  const oldText = 'old_' + 'a'.repeat(9_000)
  const newText = 'new_' + 'b'.repeat(9_000)
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-' + oldText, '+' + newText] }
  const primary = stripVTControlCharacters(new colorDiff.ColorDiff(hunk, null, 'data.txt', null).render('dark', 20_000, false).join('\n'))
  assert.ok(primary.includes(oldText) && primary.includes(newText))
  const plain = textOf(fallback.renderFallbackForTest(hunk.lines, 1, 20_000, false, 'dark'))
  assert.ok(plain.includes(oldText) && plain.includes(newText))
})

test('dim fallback skips word refinement entirely', () => {
  const before = refinements
  fallback.renderFallbackForTest(['-const oldName = 1;', '+const newName = 1;'], 1, 100, true, 'dark')
  assert.equal(refinements, before)
})
