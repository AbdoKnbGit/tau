/**
 * MCP bridge schema sanitizer tests — Gemini deep sanitization.
 *
 * Regression coverage for the v0.2.0-next field bug where an MCP tool
 * with `const` / `anyOf` inside `properties[N].value` triggered a 400:
 *   "Unknown name 'const' at ...parameters.properties[4].value.any_of[1]"
 *
 * Run:  bun run src/lanes/shared/mcp_bridge.test.ts
 */

import { sanitizeSchemaForLane } from './mcp_bridge.js'

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

function hasKey(obj: unknown, path: string[]): boolean {
  let cur: any = obj
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return false
    cur = cur[p]
  }
  return cur !== undefined
}

function deepContainsKey(obj: unknown, key: string): boolean {
  if (!obj || typeof obj !== 'object') return false
  if (Array.isArray(obj)) return obj.some(v => deepContainsKey(v, key))
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === key) return true
    if (deepContainsKey(v, key)) return true
  }
  return false
}

function main(): void {
  console.log('mcp_bridge gemini deep sanitizer:')

  // ── The exact failing shape from the 400 error ──────────────────
  test('strips const inside nested properties[N].value.any_of[i]', () => {
    const schema = {
      type: 'object',
      properties: {
        op: {
          type: 'object',
          properties: {
            value: {
              anyOf: [
                { type: 'string' },
                { const: 'literal-value' },
                { type: 'number' },
              ],
            },
          },
        },
      },
    }
    const out = sanitizeSchemaForLane(schema, 'gemini')
    assert(!deepContainsKey(out, 'const'), 'const should be stripped everywhere')
    assert(!deepContainsKey(out, 'anyOf'), 'anyOf should be flattened')
    assert(!deepContainsKey(out, 'any_of'), 'any_of should not appear')
  })

  // ── Composition flattening ──────────────────────────────────────
  test('anyOf with null → nullable + non-null branch', () => {
    const s = {
      type: 'object',
      properties: {
        name: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
    }
    const out = sanitizeSchemaForLane(s, 'gemini') as any
    assert(out.properties.name.type === 'string', 'wanted string')
    assert(out.properties.name.nullable === true, 'wanted nullable=true')
    assert(!('anyOf' in out.properties.name), 'anyOf should be gone')
  })

  test('oneOf picks first variant', () => {
    const s = {
      type: 'object',
      properties: {
        v: {
          oneOf: [
            { type: 'string', description: 'picked' },
            { type: 'number' },
          ],
        },
      },
    }
    const out = sanitizeSchemaForLane(s, 'gemini') as any
    assert(out.properties.v.type === 'string', 'wanted first variant')
    assert(out.properties.v.description === 'picked', 'first variant description kept')
    assert(!deepContainsKey(out, 'oneOf'), 'oneOf should be gone')
  })

  test('parameters root is always an object schema', () => {
    const out = sanitizeSchemaForLane({ oneOf: [{ type: 'string' }, { type: 'number' }] }, 'gemini') as any
    assert(out.type === 'object', 'function-call arguments must be an object')
  })

  test('allOf merges branches', () => {
    const s = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    }
    const out = sanitizeSchemaForLane(s, 'gemini') as any
    assert(out.properties.a != null && out.properties.b != null, 'both props merged')
    assert(Array.isArray(out.required)
      && out.required.includes('a')
      && out.required.includes('b'), 'required merged')
  })

  test('type array ["string","null"] collapses to string + nullable', () => {
    const s = { properties: { x: { type: ['string', 'null'] } } }
    const out = sanitizeSchemaForLane(s, 'gemini') as any
    assert(out.properties.x.type === 'string', 'wanted string')
    assert(out.properties.x.nullable === true, 'wanted nullable=true')
  })

  // ── Drop list ───────────────────────────────────────────────────
  test('drops additionalProperties, pattern, default, examples, $schema', () => {
    const s = {
      type: 'object',
      $schema: 'http://json-schema.org/draft-07/schema',
      additionalProperties: false,
      properties: {
        x: {
          type: 'string',
          pattern: '^[a-z]+$',
          default: 'hello',
          examples: ['a', 'b'],
          readOnly: true,
        },
      },
    }
    const out = sanitizeSchemaForLane(s, 'gemini')
    assert(!deepContainsKey(out, '$schema'), '$schema should be stripped')
    assert(!deepContainsKey(out, 'additionalProperties'), 'additionalProperties stripped')
    assert(!deepContainsKey(out, 'pattern'), 'pattern stripped')
    assert(!deepContainsKey(out, 'default'), 'default stripped')
    assert(!deepContainsKey(out, 'examples'), 'examples stripped')
    assert(!deepContainsKey(out, 'readOnly'), 'readOnly stripped')
  })

  test('drops $ref / $defs / definitions', () => {
    const s = {
      $defs: { Node: { type: 'object' } },
      definitions: { Legacy: { type: 'string' } },
      properties: { x: { $ref: '#/$defs/Node' } },
    }
    const out = sanitizeSchemaForLane(s, 'gemini')
    assert(!deepContainsKey(out, '$defs'), '$defs stripped')
    assert(!deepContainsKey(out, 'definitions'), 'definitions stripped')
    assert(!deepContainsKey(out, '$ref'), '$ref stripped')
  })

  // ── Empty required arrays ───────────────────────────────────────
  test('empty required array is dropped (Gemini rejects [])', () => {
    const s = { type: 'object', properties: { x: { type: 'string' } }, required: [] }
    const out = sanitizeSchemaForLane(s, 'gemini')
    assert(!('required' in out), 'empty required should be dropped, got ' + JSON.stringify(out))
  })

  test('non-empty required is preserved', () => {
    const s = {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    }
    const out = sanitizeSchemaForLane(s, 'gemini') as any
    assert(Array.isArray(out.required) && out.required[0] === 'x', 'required preserved')
  })

  // ── Supported fields pass through ───────────────────────────────
  test('passes through type, description, enum, items', () => {
    const s = {
      type: 'object',
      description: 'desc',
      properties: {
        color: { type: 'string', enum: ['red', 'blue'], description: 'pick one' },
        nums: { type: 'array', items: { type: 'number', minimum: 0, maximum: 100 } },
      },
      required: ['color'],
    }
    const out = sanitizeSchemaForLane(s, 'gemini') as any
    assert(out.description === 'desc', 'description preserved')
    assert(out.properties.color.enum.length === 2, 'enum preserved')
    assert(out.properties.nums.items.minimum === 0, 'items.minimum preserved')
    assert(out.properties.nums.items.maximum === 100, 'items.maximum preserved')
  })

  // ── Non-gemini profiles keep old drop-list-only behavior ────────
  test('non-gemini profile still uses drop-list walk', () => {
    const s = { type: 'object', $schema: 'x', additionalProperties: true }
    const out = sanitizeSchemaForLane(s, 'groq') as any
    assert(!('$schema' in out), 'groq should drop $schema')
  })

  // ── Safe with non-object inputs ─────────────────────────────────
  test('null input returns empty object schema', () => {
    const out = sanitizeSchemaForLane(null, 'gemini') as any
    assert(out.type === 'object', 'should fallback to object schema')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
