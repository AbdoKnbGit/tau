import { expect, test } from 'bun:test'
import { GEMINI_TOOL_REGISTRY } from './tools.js'

test('replace asks for small edits, split when the change is large', () => {
  const replace = GEMINI_TOOL_REGISTRY.find(tool => tool.nativeName === 'replace')!
  expect(replace.nativeDescription).toContain('the lines you change plus 2-3 lines of context; split a large change into several edits.')
})
