import { expect, test } from 'bun:test'
import { CODEX_TOOL_REGISTRY } from './tools.js'

const readFile = CODEX_TOOL_REGISTRY.find(tool => tool.nativeName === 'read_file')!
const properties = readFile.nativeSchema.properties as Record<string, { type: string; description: string }>

test('offset is documented as the 1-based line Read uses, and passes through unchanged', () => {
  expect(properties.offset!.description).toMatch(/1-based/)
  expect(readFile.adaptInput({ file_path: '/p/a.ts', offset: 120, limit: 40 }))
    .toEqual({ file_path: '/p/a.ts', offset: 120, limit: 40 })
})

test('the description asks for targeted ranges, found with search_code first', () => {
  expect(readFile.nativeDescription).toContain('Read only the offset/limit range you need; in a large file, find it with search_code first.')
})

test('skeleton is declared and reaches Read', () => {
  expect(properties.skeleton?.type).toBe('boolean')
  expect(readFile.adaptInput({ file_path: '/p/a.html', skeleton: false }))
    .toEqual({ file_path: '/p/a.html', skeleton: false })
})
