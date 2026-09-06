/**
 * Tool schema repair-cache tests.
 *
 * The cache is keyed by tool NAME because the inbound side only ever sees the
 * name the provider echoed back. These tests pin the behavior that keeps that
 * keying safe when two different schemas are live under one name — concurrent
 * subagents each carrying their own StructuredOutput contract, or two MCP
 * servers exposing a same-named tool.
 *
 * Run: bun run src/services/api/adapters/tool_schema_cache.test.ts
 */

import {
  clearToolSchemaCache,
  coerceToolCallArgs,
  getParamType,
  recordToolSchema,
} from './tool_schema_cache.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    clearToolSchemaCache()
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

function schema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', properties }
}

async function main(): Promise<void> {
  console.log('tool_schema_cache')

  await test('repairs a stringified array against the recorded schema', () => {
    recordToolSchema('Report', schema({ findings: { type: 'array' } }))
    const out = coerceToolCallArgs('Report', { findings: '["a","b"]' }) as {
      findings: unknown
    }
    assert(Array.isArray(out.findings), 'findings should have been parsed')
    assert((out.findings as unknown[]).length === 2, 'expected 2 elements')
  })

  await test('leaves non-JSON strings and scalar params alone', () => {
    recordToolSchema('Report', schema({ findings: { type: 'array' }, note: { type: 'string' } }))
    const args = { findings: 'not json', note: '["a"]' }
    const out = coerceToolCallArgs('Report', args)
    assert(out === args, 'unchanged args should return the same reference')
  })

  await test('returns the original reference when nothing was recorded', () => {
    const args = { findings: '["a"]' }
    assert(coerceToolCallArgs('Unknown', args) === args, 'expected passthrough')
  })

  await test('last write wins for a param both schemas type identically', () => {
    recordToolSchema('Report', schema({ findings: { type: 'array' }, extra: { type: 'string' } }))
    recordToolSchema('Report', schema({ findings: { type: 'array' } }))
    assert(getParamType('Report', 'findings') === 'array', 'findings should stay array')
  })

  // The collision the name-only key cannot resolve: two live schemas disagree
  // about a param's type, and the inbound call carries no way to tell them
  // apart. Coercing against the loser silently rewrites the payload.
  await test('a param typed differently by two schemas stops coercing', () => {
    recordToolSchema('StructuredOutput', schema({ findings: { type: 'array' } }))
    recordToolSchema('StructuredOutput', schema({ findings: { type: 'string' } }))

    assert(
      getParamType('StructuredOutput', 'findings') === undefined,
      'conflicting param should report no type',
    )
    const args = { findings: '["a","b"]' }
    assert(
      coerceToolCallArgs('StructuredOutput', args) === args,
      'conflicting param must keep the raw provider value',
    )
  })

  await test('a param present in only one of two schemas is treated as conflicting', () => {
    recordToolSchema('StructuredOutput', schema({ findings: { type: 'array' } }))
    recordToolSchema('StructuredOutput', schema({ summary: { type: 'string' } }))
    assert(
      getParamType('StructuredOutput', 'findings') === undefined,
      'findings vanished from the second schema — cannot be repaired safely',
    )
  })

  await test('params both schemas agree on keep working after a conflict', () => {
    recordToolSchema('StructuredOutput', schema({ findings: { type: 'array' }, meta: { type: 'object' } }))
    recordToolSchema('StructuredOutput', schema({ findings: { type: 'string' }, meta: { type: 'object' } }))

    assert(getParamType('StructuredOutput', 'findings') === undefined, 'findings conflicts')
    assert(getParamType('StructuredOutput', 'meta') === 'object', 'meta agrees and stays repairable')

    const out = coerceToolCallArgs('StructuredOutput', {
      findings: '["a"]',
      meta: '{"k":1}',
    }) as Record<string, unknown>
    assert(typeof out.findings === 'string', 'findings must stay raw')
    assert(
      typeof out.meta === 'object' && out.meta !== null,
      'meta must still be repaired',
    )
  })

  await test('a conflict stays sticky once observed', () => {
    recordToolSchema('StructuredOutput', schema({ findings: { type: 'array' } }))
    recordToolSchema('StructuredOutput', schema({ findings: { type: 'string' } }))
    // Re-registering the original schema must not un-poison the param: both
    // are still live, and the next inbound call could belong to either.
    recordToolSchema('StructuredOutput', schema({ findings: { type: 'array' } }))
    assert(
      getParamType('StructuredOutput', 'findings') === undefined,
      'conflict must not be forgotten',
    )
  })

  await test('different tool names never interfere', () => {
    recordToolSchema('A', schema({ findings: { type: 'array' } }))
    recordToolSchema('B', schema({ findings: { type: 'string' } }))
    assert(getParamType('A', 'findings') === 'array', 'A unaffected by B')
    assert(getParamType('B', 'findings') === 'string', 'B unaffected by A')
  })

  await test('nested shape changes alone are not a conflict', () => {
    // Only top-level types drive coercion, so two schemas that differ deeper
    // still coerce identically — treating them as a conflict would disable
    // repair for no benefit.
    recordToolSchema('Report', schema({ findings: { type: 'array', items: { type: 'string' } } }))
    recordToolSchema('Report', schema({ findings: { type: 'array', items: { type: 'object' } } }))
    assert(getParamType('Report', 'findings') === 'array', 'still repairable')
  })

  await test('tolerates schemas with no properties', () => {
    recordToolSchema('Empty', { type: 'object' })
    const args = { anything: '["a"]' }
    assert(coerceToolCallArgs('Empty', args) === args, 'expected passthrough')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
