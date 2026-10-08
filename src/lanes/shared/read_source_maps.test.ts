import { expect, test } from 'bun:test'
import { GEMINI_TOOL_REGISTRY } from '../gemini/tools.js'
import { CODEX_TOOL_REGISTRY } from '../codex/tools.js'
import { OPENAI_COMPAT_TOOL_REGISTRY } from '../openai-compat/tools.js'
import { QWEN_TOOL_REGISTRY } from '../qwen/tools.js'
import { CURSOR_TOOL_REGISTRY, buildCursorToolDefinitions, resolveCursorToolCall } from '../cursor/tools.js'
import { normalizeKiloToolCallArguments } from '../kilo/tool_args.js'

for (const [name, registry] of [
  ['Gemini (including Antigravity Gemini/Claude)', GEMINI_TOOL_REGISTRY],
  ['Codex', CODEX_TOOL_REGISTRY],
  ['OpenAI-compatible', OPENAI_COMPAT_TOOL_REGISTRY],
  ['Qwen', QWEN_TOOL_REGISTRY],
  ['Cursor', CURSOR_TOOL_REGISTRY],
] as const) {
  test(`${name}: shared Read and full-map option are reachable`, () => {
    const read = registry.find(tool => tool.implId === 'Read')!
    expect(read).toBeDefined()
    expect((read.nativeSchema.properties as any).include_source_maps.type).toBe('boolean')
    for (const option of [true, false]) {
      const input = { file_path: '/project/arbitrary.js', path: '/project/arbitrary.js', include_source_maps: option }
      const snapshot = JSON.stringify(input)
      expect(read.adaptInput(input).include_source_maps).toBe(option)
      expect(JSON.stringify(input)).toBe(snapshot)
    }
    expect(read.adaptInput({ file_path: '/project/arbitrary.js', path: '/project/arbitrary.js' }).include_source_maps).toBeUndefined()
  })
}

test('Cursor protocol aliases retain the full-map option and schema', () => {
  const definitions = buildCursorToolDefinitions([{ name: 'Read', input_schema: { type: 'object' } }])
  expect((definitions[0]!.input_schema!.properties as any).include_source_maps.type).toBe('boolean')
  for (const name of ['Read', 'read_file', 'read_file_v2']) {
    const result = resolveCursorToolCall(name, { path: '/project/arbitrary.js', include_source_maps: true })!
    expect(result.implId).toBe('Read')
    expect(result.input.include_source_maps).toBe(true)
  }
})

test('Kilo forwards the shared option along with its existing read options', () => {
  expect(normalizeKiloToolCallArguments('Read', { path: '/project/arbitrary.js', include_source_maps: true, skeleton: false }))
    .toEqual({ file_path: '/project/arbitrary.js', include_source_maps: true, skeleton: false })
})
