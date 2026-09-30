import assert from 'node:assert/strict'
import test from 'node:test'
import { hasInstructionsInsideToolOutput } from './mcp-instructions/wire-checks.mjs'

const instructions = '<mcp-server-instructions>fixture</mcp-server-instructions>'

test('wire audit accepts independent context and rejects instructions inside every tool-result format', () => {
  assert.equal(hasInstructionsInsideToolOutput({ messages: [{ role: 'user', content: instructions }] }), false)
  for (const bad of [
    { messages: [{ role: 'tool', content: instructions }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', content: instructions }] }] },
    { input: [{ type: 'function_call_output', output: instructions }] },
    { request: { contents: [{ parts: [{ functionResponse: { response: { content: instructions } } }] }] } },
    { conversationState: { currentMessage: { userInputMessage: { userInputMessageContext: {
      toolResults: [{ content: [{ text: instructions }] }],
    } } } } },
  ]) assert.equal(hasInstructionsInsideToolOutput(bad), true)
})
