/**
 * Run: bun run src/utils/toolResultSearch.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { searchToolResultFile, windowAround } from './toolResultSearch.js'

let passed = 0
let failed = 0

async function test(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn()
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

const NUL = String.fromCharCode(0)

const dir = mkdtempSync(join(tmpdir(), 'tau-tool-result-search-'))
let seq = 0
function fixture(content: string): string {
  const path = join(dir, `fixture-${seq++}.txt`)
  writeFileSync(path, content)
  return path
}

console.log('tool result search:')

await test('returns matching lines with 1-based line numbers', async () => {
  const path = fixture('alpha\nbravo\ncharlie\nbravo again\n')
  const out = await searchToolResultFile(path, 'bravo')

  assert(out.matches === 2, `expected 2 matches, got ${out.matches}`)
  assert(out.content.startsWith('2: bravo'), `expected line 2 first, got ${out.content}`)
  assert(out.content.includes('4: bravo again'), 'expected line 4 in results')
  assert(!out.truncated, 'should not be truncated')
})

await test('matches case-insensitively', async () => {
  const path = fixture('Fatal: ENOENT while reading\nok\n')
  const out = await searchToolResultFile(path, 'enoent')

  assert(out.matches === 1, `expected 1 match, got ${out.matches}`)
  assert(out.content.includes('ENOENT'), 'should preserve original casing in output')
})

await test('zero matches reports the exact total line count', async () => {
  const path = fixture('one\ntwo\nthree\nfour\nfive\n')
  const out = await searchToolResultFile(path, 'absent')

  assert(out.matches === 0, 'expected no matches')
  assert(out.completed, 'a zero-match scan must reach EOF')
  assert(out.scannedLines === 5, `expected 5 lines scanned, got ${out.scannedLines}`)
  assert(out.content === '', 'content should be empty when nothing matched')
})

await test('windows a long single line around the hit', async () => {
  // The failure this exists to prevent: minified JSON parked as one huge line,
  // where a naive match pastes the entire payload back into context.
  const line = `${'x'.repeat(50_000)}NEEDLE${'y'.repeat(50_000)}`
  const path = fixture(`${line}\n`)
  const out = await searchToolResultFile(path, 'NEEDLE', { maxLineChars: 400 })

  assert(out.matches === 1, 'expected 1 match')
  assert(out.content.includes('NEEDLE'), 'window must contain the match')
  assert(
    out.content.length < 600,
    `window should stay near maxLineChars, got ${out.content.length}`,
  )
  assert(out.content.includes('…'), 'elision should be marked')
})

await test('caps the number of matches and flags truncation', async () => {
  const path = fixture('hit\n'.repeat(50))
  const out = await searchToolResultFile(path, 'hit', { maxMatches: 10 })

  assert(out.matches === 10, `expected 10 matches, got ${out.matches}`)
  assert(out.truncated, 'should be flagged truncated')
  assert(!out.completed, 'should not claim completion after a cap')
})

await test('caps total bytes returned', async () => {
  const path = fixture('hit padding padding padding\n'.repeat(500))
  const out = await searchToolResultFile(path, 'hit', { maxBytes: 1_000 })

  assert(out.content.length <= 1_100, `expected byte cap honoured, got ${out.content.length}`)
  assert(out.truncated, 'should be flagged truncated')
})

await test('detects binary payloads instead of searching them', async () => {
  const path = fixture(`PNG${NUL}${NUL}binary junk needle\n`)
  const out = await searchToolResultFile(path, 'needle')

  assert(out.binary, 'should be detected as binary')
  assert(out.matches === 0, 'binary payloads report no matches')
  assert(out.content === '', 'binary payloads return no content')
})

await test('handles CRLF line endings', async () => {
  const path = fixture('alpha\r\nbravo\r\ncharlie\r\n')
  const out = await searchToolResultFile(path, 'bravo')

  assert(out.matches === 1, `expected 1 match, got ${out.matches}`)
  assert(!out.content.includes('\r'), 'carriage returns should not survive into output')
})

await test('handles an empty file', async () => {
  const path = fixture('')
  const out = await searchToolResultFile(path, 'anything')

  assert(out.matches === 0, 'expected no matches')
  assert(out.scannedLines === 0, `expected 0 lines, got ${out.scannedLines}`)
  assert(out.completed, 'empty file scan completes')
})

await test('is deterministic across repeated scans', async () => {
  // The cache-safety property: a parked result is write-once, so replaying the
  // same query must render byte-identical content into the prompt.
  const path = fixture('alpha\nbravo\ncharlie\nbravo\n')
  const first = await searchToolResultFile(path, 'bravo')
  const second = await searchToolResultFile(path, 'bravo')

  assert(first.content === second.content, 'repeated scans must return identical bytes')
})

await test('windowAround returns short lines unchanged', () => {
  assert(windowAround('short line', 0, 5, 400) === 'short line', 'short lines pass through')
})

await test('windowAround clamps at the start of a line', () => {
  const line = `NEEDLE${'y'.repeat(1_000)}`
  const out = windowAround(line, 0, 6, 100)

  assert(out.startsWith('NEEDLE'), 'no leading elision when the hit is at index 0')
  assert(out.endsWith('…'), 'trailing elision expected')
})

rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
