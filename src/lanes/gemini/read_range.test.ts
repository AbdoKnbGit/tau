import { expect, test } from 'bun:test'
import { GEMINI_TOOL_REGISTRY, linesFromReadRange, readRangeFromLines } from './tools.js'

const readFile = GEMINI_TOOL_REGISTRY.find(tool => tool.nativeName === 'read_file')!

test('start_line/end_line map to the same lines in shared Read (offset is 1-based)', () => {
  expect(readFile.adaptInput({ file_path: '/p/a.ts', start_line: 100, end_line: 120 }))
    .toEqual({ file_path: '/p/a.ts', offset: 100, limit: 21 })
  expect(readFile.adaptInput({ file_path: '/p/a.ts', start_line: 1, end_line: 1 }))
    .toEqual({ file_path: '/p/a.ts', offset: 1, limit: 1 })
})

test('one-sided and malformed ranges read what was asked, never an invalid Read input', () => {
  expect(readRangeFromLines(40, undefined)).toEqual({ offset: 40 })
  expect(readRangeFromLines(undefined, 25)).toEqual({ limit: 25 })
  expect(readRangeFromLines(200, 150)).toEqual({ offset: 150, limit: 51 })
  expect(readRangeFromLines('12', '14')).toEqual({ offset: 12, limit: 3 })
  expect(readRangeFromLines(0, 3)).toEqual({ offset: 1, limit: 3 })
  expect(readRangeFromLines(7, -1)).toEqual({ offset: 7 })
  expect(readRangeFromLines(3.9, 5.2)).toEqual({ offset: 3, limit: 3 })
  expect(readRangeFromLines('top', undefined)).toEqual({})
})

test('history replays the arguments the model sent', () => {
  for (const args of [
    { start_line: 100, end_line: 120 },
    { start_line: 1, end_line: 9 },
    { start_line: 40 },
    { end_line: 25 },
  ]) {
    const { offset, limit } = readFile.adaptInput({ file_path: '/p/a.ts', ...args }) as {
      offset?: number
      limit?: number
    }
    expect(linesFromReadRange(offset, limit)).toEqual(args)
  }
})

test('older transcripts that read from line 1 replay unchanged', () => {
  // Before the fix start_line 1 was stored as offset 0.
  expect(linesFromReadRange(0, 10)).toEqual({ start_line: 1, end_line: 10 })
  expect(linesFromReadRange(undefined, undefined)).toEqual({})
})

test('the description asks for targeted ranges, found with grep_search first', () => {
  expect(readFile.nativeDescription).toContain('Read only the start_line/end_line range you need; in a large file, find it with grep_search first.')
})

test('skeleton is declared and reaches Read, so a structure view can be expanded', () => {
  expect((readFile.nativeSchema.properties as Record<string, { type: string }>).skeleton?.type).toBe('boolean')
  expect(readFile.adaptInput({ file_path: '/p/a.html', skeleton: false }))
    .toEqual({ file_path: '/p/a.html', skeleton: false })
})

test('adapted input keeps its key order and leaves the model arguments untouched', () => {
  const native = { file_path: '/p/a.ts', start_line: 5, end_line: 6, include_source_maps: true }
  const snapshot = JSON.stringify(native)
  expect(Object.keys(readFile.adaptInput(native))).toEqual(['file_path', 'include_source_maps', 'offset', 'limit'])
  expect(JSON.stringify(native)).toBe(snapshot)
})
