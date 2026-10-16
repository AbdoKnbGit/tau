import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeTextChange, describeWrittenFile, readTextForSummary } from './writeSummary.js'

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row ${i + 1}`).join('\n') + '\n'

test('an insertion names its lines and where the lines below moved', () => {
  const before = rows(12)
  const after = before.replace('row 5\n', 'row 5\nnew a\nnew b\n')
  expect(describeTextChange(before, after)).toBe('changed lines 6-7; lines below moved down 2 (old line 6 is now 8)')
})

test('deletions, in-place changes and several places', () => {
  const before = rows(40)
  expect(describeTextChange(before, before.replace('row 6\nrow 7\n', '')))
    .toBe('changed lines removed before line 6; lines below moved up 2 (old line 8 is now 6)')
  expect(describeTextChange(before, before.replace('row 9\n', 'ROW 9\n'))).toBe('changed line 9')
  const spread = before.replace('row 2\n', 'R2\n').replace('row 12\n', 'R12\n').replace('row 22\n', 'R22\n').replace('row 32\n', 'R32\n')
  expect(describeTextChange(before, spread)).toBe('changed line 2, line 12, line 22 and 1 more place')
  expect(describeTextChange(before, before)).toBe('unchanged')
})

test('written files: new, deleted, binary and edited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tau-write-summary-'))
  try {
    const edited = join(dir, 'a.txt')
    writeFileSync(edited, rows(10).replace('row 3\n', 'row 3\nextra\n'))
    expect(await describeWrittenFile(edited, rows(10), false)).toBe('changed line 4; lines below moved down 1 (old line 4 is now 5)')
    const created = join(dir, 'b.txt')
    writeFileSync(created, rows(3))
    expect(await describeWrittenFile(created, null, true)).toBe('new, 3 lines')
    expect(await describeWrittenFile(join(dir, 'gone.txt'), rows(3), false)).toBe('deleted')
    const binary = join(dir, 'c.bin')
    writeFileSync(binary, Buffer.from([0, 1, 2, 0]))
    expect(await readTextForSummary(binary)).toBeNull()
    expect(await describeWrittenFile(binary, null, false)).toBe('')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
