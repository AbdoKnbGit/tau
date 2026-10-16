/**
 * Flexible match resolver unit tests.
 *
 * Run: bun run src/tools/FileEditTool/matchResolver.test.ts
 */

import {
  capEditResultSnippet,
  describeClosestMatch,
  describeOldStringMismatch,
  isEditLikelyAlreadyApplied,
  lineShiftAfterEdit,
  occurrenceLines,
  previewOldString,
  resolveFlexibleMatch,
  shouldTreatEditAsAlreadyApplied,
} from './matchResolver.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function assertEq(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(
      `${hint}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    )
  }
}

console.log('resolveFlexibleMatch:')

test('recovers trailing-whitespace drift and returns the real file text', () => {
  const file = 'const a = 1;  \nconst b = 2;\t\nconst c = 3;\n'
  const m = resolveFlexibleMatch(file, 'const a = 1;\nconst b = 2;', 'X')
  assert(m !== null, 'expected a match')
  assertEq(m!.matchType, 'trailing-whitespace', 'match type')
  assertEq(m!.actualOldString, 'const a = 1;  \nconst b = 2;\t', 'actual text')
  assertEq(m!.actualNewString, 'X', 'new_string untouched')
  assert(file.includes(m!.actualOldString), 'actual must be verbatim file text')
})

test('recovers a uniform indent increase and re-indents new_string', () => {
  const file = '    if (x) {\n      go()\n    }\n'
  const m = resolveFlexibleMatch(
    file,
    'if (x) {\n  go()\n}',
    'if (x) {\n  stop()\n}',
  )
  assert(m !== null, 'expected a match')
  assertEq(m!.matchType, 'indent', 'match type')
  assertEq(m!.actualOldString, '    if (x) {\n      go()\n    }', 'actual text')
  assertEq(
    m!.actualNewString,
    '    if (x) {\n      stop()\n    }',
    'new_string shifted by the same prefix',
  )
})

test('recovers a uniform indent decrease when new_string carries the prefix', () => {
  const file = 'if (x) {\n  go()\n}\n'
  const m = resolveFlexibleMatch(
    file,
    '  if (x) {\n    go()\n  }',
    '  if (y) {\n    go()\n  }',
  )
  assert(m !== null, 'expected a match')
  assertEq(m!.matchType, 'indent', 'match type')
  assertEq(m!.actualNewString, 'if (y) {\n  go()\n}', 'prefix removed')
})

test('refuses an indent decrease when new_string lacks the prefix', () => {
  const file = 'if (x) {\n  go()\n}\n'
  const m = resolveFlexibleMatch(
    file,
    '  if (x) {\n    go()\n  }',
    'if (y) { go() }', // cannot strip two spaces from this cleanly
  )
  assertEq(m, null, 'must refuse rather than mangle indentation')
})

test('returns null when the relaxed match is ambiguous', () => {
  const file = 'a();  \nb();\na();  \nb();\n'
  const m = resolveFlexibleMatch(file, 'a();\nb();', 'X')
  assertEq(m, null, 'two candidate windows must not auto-heal')
})

test('returns null for mid-line (non line-aligned) partial matches', () => {
  const file = 'const value = compute(1, 2);\n'
  const m = resolveFlexibleMatch(file, 'value = compute(1, 2)', 'X')
  assertEq(m, null, 'mid-line fragments are not safe to relax')
})

test('handles old_string with trailing newline', () => {
  const file = 'one\ntwo  \nthree\n'
  const m = resolveFlexibleMatch(file, 'two\n', 'TWO\n')
  assert(m !== null, 'expected a match')
  assertEq(m!.actualOldString, 'two  \n', 'keeps the newline in actual text')
})

test('blank lines pass through a uniform indent shift', () => {
  const file = '  a\n\n  b\n'
  const m = resolveFlexibleMatch(file, 'a\n\nb', 'a\n\nc')
  assert(m !== null, 'uniform +2 shift with a blank line between should match')
  assertEq(m!.actualOldString, '  a\n\n  b', 'actual text')
  assertEq(m!.actualNewString, '  a\n\n  c', 'shifted new_string')
  assertEq(
    resolveFlexibleMatch(file, 'a\nzz\nb', 'X'),
    null,
    'content line must not match a blank line',
  )
  assertEq(
    resolveFlexibleMatch('a\n\n  b\n', 'a\n\nb', 'X'),
    null,
    'per-line (non-uniform) shifts must not match',
  )
})

test('mixed per-line indent deltas do not match', () => {
  const file = '    a\n  b\n'
  assertEq(
    resolveFlexibleMatch(file, 'a\nb', 'X'),
    null,
    'non-uniform shift must not match',
  )
})

test('empty and whitespace-only old_string never match', () => {
  assertEq(resolveFlexibleMatch('a\nb\n', '', 'X'), null, 'empty')
  assertEq(resolveFlexibleMatch('a\nb\n', '   \n', 'X'), null, 'ws-only')
})

console.log('isEditLikelyAlreadyApplied:')

test('detects new_string already present', () => {
  const file = `import { join } from "node:path"\nimport { fileURLToPath } from "node:url"\n`
  assert(
    isEditLikelyAlreadyApplied(
      file,
      'import { fileURLToPath } from "node:url"',
    ),
    'should detect already-applied content',
  )
})

test('ignores trivial new_strings', () => {
  assert(!isEditLikelyAlreadyApplied('}\n}\n', '}'), 'single brace is noise')
  assert(!isEditLikelyAlreadyApplied('x\n', ''), 'deletion edits never count')
})

test('matches on trimmed new_string when indentation drifted', () => {
  const file = 'foo()\nbar(1, 2, 3)\n'
  assert(
    isEditLikelyAlreadyApplied(file, '  bar(1, 2, 3)'),
    'trimmed containment should count',
  )
})

console.log('shouldTreatEditAsAlreadyApplied:')

test('the incident shape: unique multiline new_string present, old gone → no-op rewrite', () => {
  const file = `import { join } from "node:path"\nimport { fileURLToPath } from "node:url"\nconst x = 1\n`
  assert(
    shouldTreatEditAsAlreadyApplied(
      file,
      'import { join, fileURLToPath } from "node:path"',
      'import { join } from "node:path"\nimport { fileURLToPath } from "node:url"',
    ),
    'should qualify for the no-op rewrite',
  )
})

test('long unique single-line new_string qualifies too', () => {
  const file = 'const configuredTimeoutMs = 45_000\nother()\n'
  assert(
    shouldTreatEditAsAlreadyApplied(
      file,
      'const configuredTimeoutMs = 30_000',
      'const configuredTimeoutMs = 45_000',
    ),
    'distinctive single line should qualify',
  )
})

test('short or repeated new_strings never rewrite', () => {
  assert(
    !shouldTreatEditAsAlreadyApplied('const x = 2\n', 'const x = 1', 'x = 2'),
    'short single-line fragment must not qualify',
  )
  const dup =
    'const repeated_marker_line_value = 1\nmid()\nconst repeated_marker_line_value = 1\n'
  assert(
    !shouldTreatEditAsAlreadyApplied(
      dup,
      'const some_gone_line = 0',
      'const repeated_marker_line_value = 1',
    ),
    'new_string appearing more than once must not qualify',
  )
})

test('no rewrite when old_string still exists or equals new_string', () => {
  const file = 'const value = alpha_beta_gamma_delta\n'
  assert(
    !shouldTreatEditAsAlreadyApplied(
      file,
      'const value = alpha_beta_gamma_delta',
      'const value = alpha_beta_gamma_delta',
    ),
    'old === new is the plain no-op path, not a rewrite',
  )
  assert(
    !shouldTreatEditAsAlreadyApplied(
      'aaa_bbb_ccc_ddd_eee\nfff_ggg_hhh_iii_jjj\n',
      'aaa_bbb_ccc_ddd_eee',
      'fff_ggg_hhh_iii_jjj',
    ),
    'old_string present means a real edit is intended',
  )
})

test('flexible-matchable old_string prefers the healed edit over a no-op', () => {
  // old_string differs from the file only by trailing whitespace — the flex
  // healer can perform the REAL edit, so the rewrite must stand down, even
  // though new_string happens to be present elsewhere in the file.
  const file =
    'alpha_line_one  \nbeta_line_two\nreplacement_text_for_the_edit_here\n'
  assert(
    !shouldTreatEditAsAlreadyApplied(
      file,
      'alpha_line_one\nbeta_line_two',
      'replacement_text_for_the_edit_here',
    ),
    'flex match available → no rewrite',
  )
})

test('deletions (empty new_string) never rewrite', () => {
  assert(
    !shouldTreatEditAsAlreadyApplied('abc\n', 'gone-from-file-entirely', ''),
    'deletion edits must fail loudly, not silently no-op',
  )
})

console.log('capEditResultSnippet:')

test('short snippets pass through untouched', () => {
  const s = '   10\tconst a = 1\n   11\tconst b = 2'
  assertEq(capEditResultSnippet(s), s, 'no truncation expected')
})

test('long snippets are cut on a line boundary with a marker', () => {
  const lines: string[] = []
  for (let i = 1; i <= 80; i++) lines.push(`${String(i).padStart(5)}\tline number ${i}`)
  const out = capEditResultSnippet(lines.join('\n'))
  assert(out.includes('more lines not shown'), `expected marker, got tail: ${out.slice(-80)}`)
  assert(
    out.split('\n').length <= 32,
    `expected bounded output, got ${out.split('\n').length} lines`,
  )
})

console.log('describeClosestMatch:')

test('locates the drifted import line', () => {
  const lines: string[] = []
  for (let i = 0; i < 120; i++) lines.push(`const filler${i} = ${i};`)
  lines[60] = 'import { join } from "node:path"'
  lines[61] = 'import { fileURLToPath } from "node:url"'
  const file = lines.join('\n')
  const c = describeClosestMatch(
    file,
    'import { join, fileURLToPath } from "node:path"',
  )
  assert(c !== null, 'expected a closest match')
  const found = c!.lines.join('\n')
  assert(
    found.includes('import { join } from "node:path"'),
    `snippet should contain the current import line, got:\n${found}`,
  )
  assert(
    c!.startLine <= 61 && c!.startLine + c!.lines.length >= 61,
    `window should cover line 61, got start ${c!.startLine} len ${c!.lines.length}`,
  )
})

test('returns null when nothing is remotely similar', () => {
  const file = 'alpha\nbeta\ngamma\n'
  const c = describeClosestMatch(file, 'zzzz qqqq wwww')
  assertEq(c, null, 'no similar region should mean null')
})

test('multi-line windows score across all lines', () => {
  const file = 'aa bb cc\nfunction handle(req, res) {\n  res.send(1)\n}\nzz\n'
  const c = describeClosestMatch(
    file,
    'function handle(req, resp) {\n  resp.send(1)\n}',
  )
  assert(c !== null, 'expected a match')
  assert(
    c!.lines.join('\n').includes('function handle(req, res) {'),
    'window should cover the function',
  )
})

console.log('describeOldStringMismatch:')

function numberedFile(count: number): string[] {
  const lines: string[] = []
  for (let i = 1; i <= count; i++) lines.push(`  const value${i} = compute(${i}, "row ${i}");`)
  return lines
}

test('a long old_string with one remembered line names that line and shows it', () => {
  const lines = numberedFile(400)
  const file = lines.join('\n')
  // Lines 101-160, with line 150 rewritten from memory.
  const old = lines.slice(100, 160)
  old[49] = '  const value150 = recompute(150);'
  const m = describeOldStringMismatch(file, old.join('\n'))
  assert(m !== null, 'expected a mismatch')
  assertEq(m!.regionStart, 101, 'region starts where old_string does')
  assertEq(m!.matchedLines, 49, 'lines before the remembered one match')
  assertEq(m!.difference?.line, 150, 'first differing file line')
  assertEq(m!.difference?.file, lines[149], 'the file line at the difference')
  assertEq(m!.difference?.whitespaceOnly, false, 'a real change, not whitespace')
  const shownTo = m!.startLine + m!.lines.length - 1
  assert(m!.startLine <= 150 && shownTo >= 150, `window must show line 150, got ${m!.startLine}-${shownTo}`)
  assert(m!.lines.length <= 40, 'window stays bounded')
})

test('a short old_string keeps the whole region in view', () => {
  const lines = numberedFile(200)
  const old = lines.slice(49, 55)
  old[3] = '  const value53 = other();'
  const m = describeOldStringMismatch(lines.join('\n'), old.join('\n'))
  assertEq(m!.difference?.line, 53, 'difference line')
  assertEq(m!.startLine, 47, 'starts three lines above the region, as before')
})

test('whitespace-only differences are flagged', () => {
  const lines = numberedFile(120)
  const old = lines.slice(9, 14)
  old[2] = old[2]!.replace('  const', '\tconst')
  const m = describeOldStringMismatch(lines.join('\n'), old.join('\n'))
  assertEq(m!.difference?.line, 12, 'difference line')
  assertEq(m!.difference?.whitespaceOnly, true, 'only whitespace differs')
})

test('partial first and last lines count as matching', () => {
  const lines = numberedFile(120)
  const old = [
    lines[19]!.slice(10),
    lines[20]!,
    'BROKEN',
    lines[22]!.slice(0, 12),
  ]
  const m = describeOldStringMismatch(lines.join('\n'), old.join('\n'))
  assertEq(m!.matchedLines, 2, 'the partial first line and the next match')
  assertEq(m!.difference?.line, 22, 'difference at the broken line')
})

test('previewOldString keeps short strings and trims long ones', () => {
  assertEq(previewOldString('a\nb'), 'a\nb', 'short strings are echoed whole')
  const long = numberedFile(30).join('\n')
  const preview = previewOldString(long)
  assert(preview.startsWith(numberedFile(1)[0]!), 'starts with the first line')
  assert(preview.includes('28 more lines'), `names the elided lines: ${preview}`)
  assert(preview.length < 400, 'bounded')
})

console.log('lineShiftAfterEdit:')

test('a replacement that adds lines moves everything below it', () => {
  const shift = lineShiftAfterEdit([
    { oldStart: 7, lines: [' a7', ' a8', ' a9', '-a10', '+b1', '+b2', '+b3', ' a11', ' a12', ' a13'] },
  ])
  assertEq(JSON.stringify(shift), JSON.stringify({ firstOldLine: 11, delta: 2 }), 'old line 11 is now 13')
})

test('deletions, insertions at the top, and several hunks', () => {
  assertEq(JSON.stringify(lineShiftAfterEdit([{ oldStart: 1, lines: [' a1', '-a2', '-a3', ' a4'] }])), JSON.stringify({ firstOldLine: 4, delta: -2 }), 'deletion')
  assertEq(JSON.stringify(lineShiftAfterEdit([{ oldStart: 1, lines: ['+x', ' a1', ' a2'] }])), JSON.stringify({ firstOldLine: 1, delta: 1 }), 'insertion at the top')
  assertEq(
    JSON.stringify(lineShiftAfterEdit([
      { oldStart: 3, lines: [' a3', '+n', ' a4'] },
      { oldStart: 20, lines: [' a20', '+m', '+k', ' a21'] },
    ])),
    JSON.stringify({ firstOldLine: 21, delta: 3 }),
    'cumulative below the last change',
  )
})

test('same line count means no shift', () => {
  assertEq(lineShiftAfterEdit([{ oldStart: 5, lines: [' a5', '-a6', '+b6', ' a7'] }]), null, 'in-place change')
  assertEq(lineShiftAfterEdit([]), null, 'no hunks')
})

test('occurrenceLines reports the line of each non-overlapping match', () => {
  const file = 'x\nfoo\nbar\nfoo\nfoo bar foo\n'
  assertEq(JSON.stringify(occurrenceLines(file, 'foo', 10)), '[2,4,5,5]', 'all matches')
  assertEq(JSON.stringify(occurrenceLines(file, 'foo', 2)), '[2,4]', 'bounded')
  assertEq(JSON.stringify(occurrenceLines(file, 'bar\nfoo', 5)), '[3]', 'multi-line needle')
  assertEq(file.split('foo').length - 1, occurrenceLines(file, 'foo', 99).length, 'same count as split')
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
