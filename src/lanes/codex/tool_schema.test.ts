/**
 * Codex lane tool-schema tests.
 *
 * Regression for the 2026-09-26 Codex bug: the claude.ai "Claude Docs"
 * connector declares an optional `batch: {type: "array"}` with no `items`;
 * the old strict projection sent it as `type: ["array", "null"]` and every
 * turn 400'd with
 *   "Invalid schema for function 'mcp__claude_ai_Claude_Docs__batch': In
 *    context=('properties', 'batch', 'type', '0'), array schema missing items."
 *
 * Tools now go out as native Codex sends them: their own schema, `strict:
 * false`. `findCodexToolSchemaViolations` encodes the backend's schema check
 * as measured live, and every case here, a seeded fuzzer included, must come
 * out clean, faithful (nothing narrowed, nothing invented), deterministic,
 * idempotent and without touching its input.
 *
 * Run:  bun run src/lanes/codex/tool_schema.test.ts
 */

import assert from 'node:assert/strict'
import { findCodexToolSchemaViolations, toCodexToolParameters } from './tool_schema.js'

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

/** Convert, and assert the invariants every output must satisfy. */
function check(input: unknown): Record<string, any> {
  const before = JSON.stringify(input)
  const out = toCodexToolParameters(input)
  assert.equal(JSON.stringify(input), before, 'input was mutated')
  const violations = findCodexToolSchemaViolations(out)
  assert.deepEqual(violations, [], `violations: ${violations.join(' | ')}\n${JSON.stringify(out)}`)
  assert.equal(JSON.stringify(toCodexToolParameters(input)), JSON.stringify(out), 'not deterministic')
  assert.equal(JSON.stringify(toCodexToolParameters(out)), JSON.stringify(out), 'not idempotent')
  return out
}

const S = { type: 'string' }

function main(): void {
  console.log('codex tool schema:')

  test('an optional array without items is sent as itself', () => {
    const out = check({
      type: 'object',
      properties: {
        document_id: { type: 'string' },
        batch: { type: 'array', description: 'Operations to apply in order' },
      },
      required: ['document_id'],
    })
    assert.deepEqual(out.properties.batch, { type: 'array', description: 'Operations to apply in order' })
    assert.deepEqual(out.required, ['document_id'], 'optional stays optional')
  })

  test('a clean schema is only stripped of metadata', () => {
    const out = check({
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        pattern: { type: 'string', title: 'Pattern', pattern: '^x' },
        lang: { type: 'string', enum: ['python', 'typescript'], default: 'python' },
        paths: { type: 'array', items: { type: 'string', format: 'uri' } },
        contextLines: { type: 'integer', minimum: 0, 'x-note': 'strip' },
      },
      required: ['pattern', 'lang'],
      additionalProperties: false,
    })
    assert.equal(JSON.stringify(out),
      '{"type":"object","properties":{"pattern":{"type":"string"},"lang":{"type":"string","enum":["python","typescript"]},'
      + '"paths":{"type":"array","items":{"type":"string"}},"contextLines":{"type":"integer","minimum":0}},'
      + '"required":["pattern","lang"],"additionalProperties":false}')
  })

  test('optional fields stay optional: nothing is made required or nullable', () => {
    const out = check({
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['sonnet', 'opus', 'haiku'] },
        isolation: { type: 'string', enum: ['worktree'] },
        prompt: S,
      },
      required: ['prompt'],
    })
    assert.deepEqual(out.required, ['prompt'])
    assert.deepEqual(out.properties.model, { type: 'string', enum: ['sonnet', 'opus', 'haiku'] })
    assert.deepEqual(out.properties.isolation, { type: 'string', enum: ['worktree'] })
  })

  test('local $refs are inlined, so the model sees the structure', () => {
    const out = check({
      $defs: {
        Cell: {
          type: 'object',
          title: 'Cell',
          properties: { row: { type: 'integer', minimum: 0 }, value: { anyOf: [S, { type: 'null' }], default: null } },
          required: ['row'],
        },
        Style: { type: 'string', enum: ['bold', 'plain'] },
      },
      type: 'object',
      properties: {
        cells: { type: 'array', items: { $ref: '#/$defs/Cell' } },
        style: { $ref: '#/$defs/Style', description: 'Style for every cell' },
      },
      required: ['cells'],
    })
    assert.deepEqual(out.properties.cells.items, {
      type: 'object',
      properties: { row: { type: 'integer', minimum: 0 }, value: { anyOf: [S, { type: 'null' }] } },
      required: ['row'],
    })
    assert.deepEqual(out.properties.style, { type: 'string', enum: ['bold', 'plain'], description: 'Style for every cell' })
    assert.ok(!JSON.stringify(out).includes('$ref') && !JSON.stringify(out).includes('$defs'), 'refs left on the wire')
  })

  test('recursion is cut at the cycle with the target type kept', () => {
    const out = check({
      type: 'object',
      properties: { root: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { name: S, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } },
    })
    assert.deepEqual(out.properties.root.properties.children.items, { type: 'object' })
  })

  test('free-form objects, maps, tuples, untyped values and unions keep their shape', () => {
    const out = check({
      type: 'object',
      properties: {
        metadata: { type: 'object', additionalProperties: { type: 'string' } },
        options: { type: 'object' },
        value: {},
        pair: { type: 'array', items: [S, { type: 'integer' }] },
        op: { oneOf: [{ type: 'object', properties: { kind: { const: 'insert' } } }, S] },
        mixin: { allOf: [{ properties: { id: S } }] },
      },
    })
    assert.deepEqual(out.properties.metadata, { type: 'object', additionalProperties: { type: 'string' } })
    assert.deepEqual(out.properties.options, { type: 'object' })
    assert.deepEqual(out.properties.value, {})
    assert.deepEqual(out.properties.pair.items, [S, { type: 'integer' }])
    assert.deepEqual(out.properties.op.oneOf[0].properties.kind, { enum: ['insert'] }, 'const is kept as a one-value enum')
    assert.ok(Array.isArray(out.properties.mixin.allOf))
  })

  test('OpenAPI nullable, draft-3 required and draft-4 exclusive bounds are spelled the JSON Schema way', () => {
    const out = check({
      type: 'object',
      properties: {
        note: { type: 'string', nullable: true },
        path: { type: 'string', required: true },
        size: { type: 'number', minimum: 0, exclusiveMinimum: true },
      },
      required: ['note'],
    })
    assert.deepEqual(out.properties.note, { type: ['string', 'null'] })
    assert.deepEqual(out.required, ['note', 'path'])
    assert.deepEqual(out.properties.size, { type: 'number', exclusiveMinimum: 0 })
  })

  test('malformed keywords are repaired so the backend accepts the schema', () => {
    const out = check({
      type: 'object',
      properties: {
        a: { type: 'String' },
        b: { type: ['string', { type: 'number' }, 'string'] },
        c: { type: 'text' },
        d: { type: 'string', enum: 'only' },
        e: { type: 'string', minLength: -1, maxLength: 1.5, description: 5 },
        f: { type: 'array', items: 'string' },
        g: null,
        h: false,
      },
      required: ['a', 'a', 5],
    })
    assert.deepEqual(out.properties.a, { type: 'string' })
    assert.deepEqual(out.properties.b, { type: ['string', 'number'] })
    assert.deepEqual(out.properties.c, {})
    assert.deepEqual(out.properties.d, { type: 'string', enum: ['only'] })
    assert.deepEqual(out.properties.e, { type: 'string' })
    assert.deepEqual(out.properties.f, { type: 'array', items: { type: 'string' } })
    assert.deepEqual(out.properties.g, {})
    assert.ok(!('h' in out.properties), 'a property that can never be supplied is left out')
    assert.deepEqual(out.required, ['a'])
  })

  test('a non-object root becomes an empty object schema; a root type list becomes object', () => {
    for (const schema of [null, 5, 'x', [], { type: 'array', items: S }, { type: 'string' }]) {
      assert.deepEqual(check(schema), { type: 'object', properties: {} })
    }
    assert.equal(check({ type: ['object', 'null'], properties: { a: S } }).type, 'object')
  })

  test('the validator flags every shape the backend rejected in non-strict mode (measured 2026-09-26)', () => {
    const rejected: Record<string, unknown> = {
      'draft-3 required': { type: 'object', properties: { a: { type: 'string', required: true } } },
      'required as a string': { type: 'object', properties: { a: S }, required: 'a' },
      'duplicate required': { type: 'object', properties: { a: S }, required: ['a', 'a'] },
      'properties as a list': { type: 'object', properties: [] },
      'enum as a string': { type: 'object', properties: { a: { type: 'string', enum: 'x' } } },
      'type list with a schema': { type: 'object', properties: { a: { type: ['string', { type: 'number' }] } } },
      'empty type list': { type: 'object', properties: { a: { type: [] } } },
      'capitalized type': { type: 'object', properties: { a: { type: 'String' } } },
      'unknown type': { type: 'object', properties: { a: { type: 'text' } } },
      'items as a string': { type: 'object', properties: { a: { type: 'array', items: 'string' } } },
      'negative count': { type: 'object', properties: { a: { type: 'string', minLength: -1 } } },
      'description as a number': { type: 'object', properties: { a: { type: 'string', description: 123 } } },
      'empty anyOf': { type: 'object', properties: { a: { anyOf: [] } } },
      'property null': { type: 'object', properties: { a: null } },
      'pattern': { type: 'object', properties: { a: { type: 'string', pattern: '(unclosed' } } },
      'root array': { type: 'array', items: S },
      'draft-4 exclusive bound': { type: 'object', properties: { a: { type: 'number', exclusiveMinimum: true } } },
    }
    for (const [name, schema] of Object.entries(rejected)) {
      assert.notDeepEqual(findCodexToolSchemaViolations(schema), [], `${name} was not flagged`)
      check(schema)
    }
  })

  // ── Seeded fuzzing ──────────────────────────────────────────────
  test('fuzz: 4000 random schemas are valid, stable and idempotent', () => {
    let seed = 0x2545f491
    const rand = (): number => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const KEYS = ['type', 'type', 'properties', 'properties', 'items', 'required', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref', '$defs', 'nullable', 'description', 'title', 'default', 'format', 'pattern', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'multipleOf', 'additionalProperties', 'prefixItems', 'not', 'uniqueItems', 'patternProperties', 'propertyNames', 'x-ext'] as const
    const NAMES = ['a', 'b', 'items', 'properties', '', '__proto__', 'with space', '$x', 'type', 'default', 'k'.repeat(70)]
    const own = (obj: Record<string, unknown>, key: string, value: unknown) =>
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
    const schema = (depth: number): unknown => {
      if (depth > 6 || rand() < 0.08) return pick([true, false, {}, null, 5, 'x', [], { type: 'string' }, { type: 'array' }])
      const node: Record<string, unknown> = {}
      const count = Math.floor(rand() * 6)
      for (let i = 0; i < count; i++) {
        const key = pick(KEYS)
        own(node, key, valueFor(key, depth))
      }
      return node
    }
    const valueFor = (key: string, depth: number): unknown => {
      switch (key) {
        case 'type': return pick(['string', 'number', 'integer', 'boolean', 'array', 'object', 'object', 'null', 'STRING', 'text', ['string', 'null'], ['array', 'object'], ['object', 'null'], 5, null, []])
        case 'properties': {
          const props: Record<string, unknown> = {}
          for (let i = Math.floor(rand() * 4); i > 0; i--) own(props, pick(NAMES), schema(depth + 1))
          return pick([props, props, props, [], 'x'])
        }
        case 'items': return pick([schema(depth + 1), schema(depth + 1), [schema(depth + 1), schema(depth + 1)], true, false, 'string'])
        case 'required': return pick([[pick(NAMES), pick(NAMES)], 'a', [], [1, null], true])
        case 'enum': return pick([['a', 'b'], [1, 2], [true], ['a', 1, null, { o: 1 }], [], 'solo'])
        case 'const': return pick(['c', 1, null, { o: 1 }, true])
        case 'anyOf': case 'oneOf': case 'allOf':
          return pick([Array.from({ length: Math.floor(rand() * 4) }, () => schema(depth + 1)), {}])
        case '$ref': return pick(['#', '#/$defs/A', '#/$defs/B', '#/definitions/C', 'http://x/y', '#/properties/a', '#/$defs/missing', '#/$defs/A/properties/a', 5])
        case '$defs': return { A: schema(depth + 1), B: schema(depth + 1) }
        case 'nullable': return pick([true, false, 'yes'])
        case 'description': return pick(['d', 5, null, ''])
        case 'format': return pick(['uri', 'date-time', 'int32', 'uuid', 5, 'weird'])
        case 'minItems': case 'maxItems': case 'minLength': case 'maxLength': return pick([0, 3, -1, 1.5, '2', 1e20, Number.NaN])
        case 'minimum': case 'maximum': case 'multipleOf': return pick([0, -5, 1.5, 'x', Infinity])
        case 'exclusiveMinimum': return pick([true, false, 0, 'x'])
        case 'additionalProperties': return pick([true, false, { type: 'string' }, {}, 'yes'])
        case 'prefixItems': return [schema(depth + 1)]
        case 'patternProperties': return pick([{ '^x': schema(depth + 1) }, {}, 'x'])
        case 'propertyNames': return pick([{ pattern: '^x' }, true])
        case 'uniqueItems': return pick([true, false])
        case 'not': return schema(depth + 1)
        default: return pick([1, 'x', {}])
      }
    }
    for (let i = 0; i < 4000; i++) {
      const input = schema(0)
      try {
        check(input)
      } catch (e: any) {
        throw new Error(`case ${i}: ${e?.message}\ninput: ${JSON.stringify(input)}`)
      }
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
