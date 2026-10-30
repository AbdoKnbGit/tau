// Tool definitions are part of the prompt cache key, and provider schema subsets differ on how
// unions are written, so the JSON sent for a schema is pinned byte for byte, whatever zod's own
// output looks like in a given version.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod/v4'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

process.env.TAU_MCP_TEST_BUNDLE ??= resolve('dist/tau.mjs')
const { zodToJsonSchema } = await loadMcpRuntime({
  paths: ['src/utils/zodToJsonSchema.ts'],
  exports: ['zodToJsonSchema'],
})

const spelled = schema => {
  const { $schema, ...rest } = zodToJsonSchema(schema)
  return JSON.stringify(rest)
}

test('unions are plain anyOf, whichever form zod chose', () => {
  assert.equal(
    spelled(z.union([z.string(), z.number(), z.boolean()])),
    '{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"}]}',
  )
  assert.equal(
    spelled(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a') }),
      z.object({ kind: z.literal('b') }),
    ])),
    '{"anyOf":[' +
      '{"type":"object","properties":{"kind":{"type":"string","const":"a"}},"required":["kind"],"additionalProperties":false},' +
      '{"type":"object","properties":{"kind":{"type":"string","const":"b"}},"required":["kind"],"additionalProperties":false}]}',
  )
})

test('description comes first in every schema', () => {
  assert.equal(
    spelled(z.object({ command: z.string().min(1).describe('What to run') }).describe('A call')),
    '{"description":"A call","type":"object","properties":{"command":{"description":"What to run","type":"string","minLength":1}},"required":["command"],"additionalProperties":false}',
  )
})

test('names and plain values that look like keywords are left alone', () => {
  const { properties } = zodToJsonSchema(z.object({
    oneOf: z.string(),
    type: z.enum(['oneOf', 'type']),
    description: z.string(),
    example: z.string().default('oneOf'),
  }))
  assert.deepEqual(Object.keys(properties), ['oneOf', 'type', 'description', 'example'])
  assert.deepEqual(properties.type.enum, ['oneOf', 'type'])
  assert.equal(properties.example.default, 'oneOf')
})

test('the same schema object gives the same result object', () => {
  const schema = z.object({ value: z.string() })
  assert.equal(zodToJsonSchema(schema), zodToJsonSchema(schema))
})
