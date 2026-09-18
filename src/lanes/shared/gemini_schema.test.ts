/**
 * Gemini / Antigravity tool-schema converter tests.
 *
 * Regression for the 2026-09-18 field bug: the claude.ai "Claude Docs"
 * connector declares `batch: {type: "array"}` with no `items`, and every
 * Antigravity request 400'd with
 *   "...function_declarations[36].parameters.properties[batch].items: missing field."
 *
 * Every rule the converter enforces was measured against the live backend
 * (see gemini_schema.ts); `findGeminiSchemaViolations` encodes those rules,
 * and every case here — including a seeded fuzzer — must come out clean,
 * deterministic, idempotent and without touching its input.
 *
 * Run:  bun run src/lanes/shared/gemini_schema.test.ts
 */

import assert from 'node:assert/strict'
import {
  findGeminiSchemaViolations,
  GEMINI_SCHEMA_MAX_DEPTH,
  geminiSafeToolName,
  sanitizeGeminiToolParameters,
} from './gemini_schema.js'
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Convert, and assert the invariants every output must satisfy. */
function check(input: unknown): Record<string, any> {
  const before = JSON.stringify(input)
  const out = sanitizeGeminiToolParameters(input)
  assert.equal(JSON.stringify(input), before, 'input was mutated')
  const violations = findGeminiSchemaViolations(out)
  assert.deepEqual(violations, [], `violations: ${violations.join(' | ')}\n${JSON.stringify(out)}`)
  assert.equal(JSON.stringify(sanitizeGeminiToolParameters(input)), JSON.stringify(out), 'not deterministic')
  assert.equal(JSON.stringify(sanitizeGeminiToolParameters(out)), JSON.stringify(out), 'not idempotent')
  return out
}

function maxDepth(node: unknown, depth = 0): number {
  if (!node || typeof node !== 'object') return depth
  const n = node as Record<string, any>
  let best = depth
  if (n.items) best = Math.max(best, maxDepth(n.items, depth + 1))
  if (n.properties) for (const child of Object.values(n.properties)) best = Math.max(best, maxDepth(child, depth + 1))
  return best
}

// The 8 claude.ai "Claude Docs" tools, verbatim as the connector serves them.
const container = { properties: { id: { type: 'string' }, kind: { type: 'string' }, version: { type: 'string' } }, required: ['kind', 'id'], type: 'object' }
const payload = { anyOf: [{ type: 'object' }, { type: 'string' }] }
const DOCS_TOOLS: Record<string, unknown> = {
  batch: { properties: { batch: { type: 'array' }, container: { properties: { create: { type: 'object' }, id: { type: 'string' }, kind: { type: 'string' } }, required: ['kind'], type: 'object' }, opId: { type: 'string' }, verbose: { type: 'boolean' } }, type: 'object' },
  create: { properties: { artifact: { type: 'string' }, container, engine: { type: 'string' }, object: { enum: ['file', 'node', 'utterance', 'enum', 'blob'], type: 'string' }, opId: { type: 'string' }, payload, verbose: { type: 'boolean' } }, required: ['object', 'payload'], type: 'object' },
  delete: { properties: { container, engine: { type: 'string' }, opId: { type: 'string' }, payload, ref: { properties: { id: { type: 'string' }, object: { enum: ['project', 'file', 'node', 'utterance'], type: 'string' } }, required: ['object', 'id'], type: 'object' }, verbose: { type: 'boolean' } }, required: ['ref'], type: 'object' },
  export: { properties: { container, file: { type: 'string' }, format: { enum: ['markdown', 'text', 'html', 'docx', 'pdf', 'notion'], type: 'string' }, maxBytes: { maximum: 11534336, minimum: 1, type: 'integer' }, paper: { enum: ['letter', 'a4'], type: 'string' } }, required: ['container', 'file', 'format'], type: 'object' },
  guide: { properties: { items: { description: 'topic.<name> or refusal.<code>; several per call is fine.', type: 'array' } }, type: 'object' },
  query: { properties: { container, object: { enum: ['utterance'], type: 'string' }, payload }, type: 'object' },
  read: { properties: { container, engine: { type: 'string' }, payload, ref: { properties: { id: { type: 'string' }, object: { enum: ['project', 'file', 'node', 'utterance', 'enum', 'blob'], type: 'string' } }, required: ['object', 'id'], type: 'object' } }, required: ['ref'], type: 'object' },
  update: { properties: { answering: { maxLength: 64, type: 'string' }, container, engine: { type: 'string' }, opId: { type: 'string' }, payload, ref: { properties: { id: { type: 'string' }, object: { enum: ['project', 'file', 'node', 'utterance', 'enum'], type: 'string' } }, required: ['object', 'id'], type: 'object' }, verbose: { type: 'boolean' } }, required: ['ref', 'payload'], type: 'object' },
}

// Realistic MCP schemas covering the shapes popular servers emit.
const REAL_WORLD: Record<string, unknown> = {
  zodFilesystemEdit: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string', description: 'Text to search for' }, newText: { type: 'string' } }, required: ['oldText', 'newText'], additionalProperties: false } },
      dryRun: { type: 'boolean', default: false, description: 'Preview changes' },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  githubSearch: {
    type: 'object',
    properties: {
      q: { type: 'string' },
      sort: { type: 'string', enum: ['comments', 'reactions', 'created', 'updated'] },
      per_page: { type: 'number', minimum: 1, maximum: 100 },
      state: { anyOf: [{ const: 'open' }, { const: 'closed' }, { const: 'all' }] },
    },
    required: ['q'],
  },
  memoryCreateEntities: {
    type: 'object',
    properties: { entities: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, entityType: { type: 'string' }, observations: { type: 'array', items: { type: 'string' } } }, required: ['name', 'entityType', 'observations'] } } },
    required: ['entities'],
  },
  fastmcpPydantic: {
    $defs: {
      Priority: { enum: [1, 2, 3], title: 'Priority', type: 'integer' },
      Task: {
        properties: {
          title: { title: 'Title', type: 'string' },
          priority: { $ref: '#/$defs/Priority', default: 2 },
          tags: { items: { type: 'string' }, title: 'Tags', type: 'array' },
          due: { anyOf: [{ format: 'date-time', type: 'string' }, { type: 'null' }], default: null, title: 'Due' },
        },
        required: ['title'],
        title: 'Task',
        type: 'object',
      },
    },
    properties: {
      task: { $ref: '#/$defs/Task', description: 'The task to create' },
      tasks: { anyOf: [{ items: { $ref: '#/$defs/Task' }, type: 'array' }, { type: 'null' }], default: null },
    },
    required: ['task'],
    title: 'create_taskArguments',
    type: 'object',
  },
  recursiveTree: {
    $defs: { Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } },
    properties: { root: { $ref: '#/$defs/Node' } },
    type: 'object',
  },
  zodRelativeRef: {
    type: 'object',
    properties: { a: { type: 'object', properties: { x: { type: 'string' } } }, b: { $ref: '#/properties/a' } },
  },
  notionBlocks: {
    type: 'object',
    properties: {
      children: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'object', properties: { type: { const: 'paragraph' }, paragraph: { type: 'object', properties: { rich_text: { type: 'array', items: { type: 'object', properties: { text: { type: 'object', properties: { content: { type: 'string' } } } } } } } } }, required: ['type', 'paragraph'] },
            { type: 'object', properties: { type: { const: 'heading_1' }, heading_1: { type: 'object' } }, required: ['type', 'heading_1'] },
          ],
        },
      },
    },
  },
  openapiDerived: {
    type: 'object',
    properties: {
      id: { type: 'integer', format: 'int64', example: 10, readOnly: true, 'x-go-name': 'ID' },
      status: { type: 'integer', enum: [200, 404], 'x-enum-descriptions': ['ok', 'missing'] },
      note: { type: 'string', nullable: true, pattern: '^[a-z]+$', minLength: 1 },
      ratio: { type: 'number', exclusiveMinimum: 0, multipleOf: 0.5 },
    },
  },
  mixedUnions: {
    type: 'object',
    properties: {
      value: { type: ['string', 'number'] },
      target: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      labels: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
  handWrittenNoTypes: { properties: { query: { type: 'string' }, filters: { properties: { tag: {} } }, ids: { items: { type: 'integer' } } }, required: ['query', 'ghost'] },
  emptyObject: { type: 'object' },
  emptySchema: {},
  tupleCoordinate: { type: 'object', properties: { coordinate: { type: 'array', items: [{ type: 'number' }, { type: 'number' }], minItems: 2, maxItems: 2 } } },
}

function main(): void {
  console.log('gemini schema converter:')

  // ── The reported failure ────────────────────────────────────────
  test('Claude Docs batch: array without items gets items {}', () => {
    const out = check(DOCS_TOOLS.batch)
    assert.deepEqual(out.properties.batch, { type: 'array', items: {} })
  })
  test('Claude Docs guide: property literally named "items" is fixed too', () => {
    const out = check(DOCS_TOOLS.guide)
    assert.deepEqual(out.properties.items, { description: 'topic.<name> or refusal.<code>; several per call is fine.', type: 'array', items: {} })
  })
  test('all 8 Claude Docs tools convert cleanly', () => {
    for (const schema of Object.values(DOCS_TOOLS)) check(schema)
  })
  test('schemas that were already valid come out byte-identical', () => {
    const out = check(DOCS_TOOLS.export)
    assert.equal(JSON.stringify(out), JSON.stringify(DOCS_TOOLS.export))
  })

  // ── One case per live-measured rule ─────────────────────────────
  test('nested arrays without items all get items', () => {
    const out = check({ type: 'object', properties: { m: { type: 'array', items: { type: 'array' } } } })
    assert.deepEqual(out.properties.m, { type: 'array', items: { type: 'array', items: {} } })
  })
  test('implicit object/array types are spelled out', () => {
    const out = check({ properties: { q: { properties: { a: { type: 'string' } } }, ids: { items: { type: 'integer' } } } })
    assert.equal(out.type, 'object')
    assert.equal(out.properties.q.type, 'object')
    assert.equal(out.properties.ids.type, 'array')
  })
  test('required keeps only unique names that exist in properties', () => {
    const out = check({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'ghost', 'a', 7] })
    assert.deepEqual(out.required, ['a'])
    const none = check({ type: 'object', properties: { a: { type: 'string' } }, required: ['ghost'] })
    assert.ok(!('required' in none))
  })
  test('items/properties/required are removed from non-matching types', () => {
    const out = check({ type: 'object', properties: { s: { type: 'string', items: { type: 'string' }, properties: { a: {} }, required: ['a'] } } })
    assert.deepEqual(out.properties.s, { type: 'string' })
  })
  test('empty property names are dropped; "__proto__" stays an own property', () => {
    const props = JSON.parse('{"": {"type": "string"}, "__proto__": {"type": "string"}, "ok": {"type": "string"}}')
    const out = check({ type: 'object', properties: props, required: ['', '__proto__'] })
    assert.deepEqual(Object.keys(out.properties), ['__proto__', 'ok'])
    assert.ok(Object.prototype.hasOwnProperty.call(out.properties, '__proto__'))
    assert.deepEqual(out.required, ['__proto__'])
  })
  test('numeric enums become a description hint; string enums stay', () => {
    const out = check({ type: 'object', properties: { n: { type: 'integer', enum: [1, 2], description: 'Level' }, s: { type: 'string', enum: ['a', 2, true, null] } } })
    assert.deepEqual(out.properties.n, { type: 'integer', description: 'Level\nAllowed values: 1, 2' })
    assert.deepEqual(out.properties.s, { type: 'string', enum: ['a', '2', 'true'], nullable: true })
  })
  test('type arrays collapse to one type plus nullable; unknown names are ignored', () => {
    const out = check({ type: 'object', properties: { a: { type: ['string', 'null'] }, b: { type: 'text', minLength: 1 }, c: { type: 'STRING' }, d: { type: 'null' } } })
    assert.deepEqual(out.properties.a, { type: 'string', nullable: true })
    assert.deepEqual(out.properties.b, { type: 'string', minLength: 1 })
    assert.deepEqual(out.properties.c, { type: 'string' })
    assert.deepEqual(out.properties.d, { nullable: true })
  })
  test('const becomes a one-value enum (strings) or a hint (others)', () => {
    const out = check({ type: 'object', properties: { k: { const: 'text' }, n: { const: 3 }, z: { const: null } } })
    assert.deepEqual(out.properties.k, { enum: ['text'], type: 'string' })
    assert.deepEqual(out.properties.n, { description: 'Allowed values: 3', type: 'integer' })
    assert.deepEqual(out.properties.z, { nullable: true })
  })
  test('unknown keywords never reach the wire', () => {
    const out = check({ type: 'object', title: 'T', default: {}, $schema: 'x', 'x-ext': 1, properties: { p: { type: 'string', pattern: 'a', examples: ['a'], default: 'a', deprecated: true, contentEncoding: 'base64' } } })
    assert.deepEqual(out, { type: 'object', properties: { p: { type: 'string' } } })
  })
  test('bad counts and bounds are dropped, good ones kept', () => {
    const out = check({ type: 'object', properties: { a: { type: 'array', items: {}, minItems: -1, maxItems: 1.5 }, s: { type: 'string', minLength: '2', maxLength: 1e20 }, n: { type: 'number', minimum: 0, maximum: Infinity }, t: { type: 'string', maxLength: 64 } } })
    assert.deepEqual(out.properties.a, { type: 'array', items: {} })
    assert.deepEqual(out.properties.s, { type: 'string' })
    assert.deepEqual(out.properties.n, { type: 'number', minimum: 0 })
    assert.deepEqual(out.properties.t, { type: 'string', maxLength: 64 })
  })
  test('boolean schemas: true means any, false properties are dropped', () => {
    const out = check({ type: 'object', properties: { any: true, never: false, list: { type: 'array', items: true } } })
    assert.deepEqual(out.properties, { any: {}, list: { type: 'array', items: {} } })
  })
  test('tuple items and prefixItems use the first position', () => {
    const out = check({ type: 'object', properties: { t: { type: 'array', items: [{ type: 'number' }, { type: 'string' }] }, p: { type: 'array', prefixItems: [{ type: 'boolean' }] } } })
    assert.deepEqual(out.properties.t, { type: 'array', items: { type: 'number' } })
    assert.deepEqual(out.properties.p, { type: 'array', items: { type: 'boolean' } })
  })
  test('the root is always a non-nullable object', () => {
    assert.deepEqual(check({}), { type: 'object', properties: {} })
    assert.deepEqual(check({ type: 'string' }), { type: 'object', properties: {} })
    assert.deepEqual(check(null), { type: 'object', properties: {} })
    assert.deepEqual(check({ type: ['object', 'null'], properties: {} }), { type: 'object', properties: {} })
  })

  // ── $ref / composition ──────────────────────────────────────────
  test('pydantic $defs/$ref are inlined; sibling description wins', () => {
    const out = check(REAL_WORLD.fastmcpPydantic)
    const task = out.properties.task
    assert.equal(task.type, 'object')
    assert.equal(task.description, 'The task to create')
    assert.deepEqual(task.required, ['title'])
    assert.deepEqual(task.properties.priority, { type: 'integer', description: 'Allowed values: 1, 2, 3' })
    assert.deepEqual(task.properties.due, { format: 'date-time', type: 'string', nullable: true })
    assert.equal(out.properties.tasks.type, 'array')
    assert.equal(out.properties.tasks.nullable, true)
    assert.equal(out.properties.tasks.items.type, 'object')
  })
  test('recursive $ref terminates with a shallow typed node', () => {
    const out = check(REAL_WORLD.recursiveTree)
    const children = out.properties.root.properties.children
    assert.equal(children.type, 'array')
    assert.deepEqual(children.items, { type: 'object' })
  })
  test('root self-reference ($ref "#") terminates', () => {
    check({ type: 'object', properties: { next: { $ref: '#' }, v: { type: 'string' } } })
  })
  test('unresolvable refs are dropped, siblings kept', () => {
    const out = check({ type: 'object', properties: { a: { $ref: 'https://example.com/x.json', description: 'ext' }, b: { $ref: '#/$defs/missing' } } })
    assert.deepEqual(out.properties, { a: { description: 'ext' }, b: {} })
  })
  test('literal unions become one string enum', () => {
    const out = check(REAL_WORLD.githubSearch)
    assert.deepEqual(out.properties.state, { enum: ['open', 'closed', 'all'], type: 'string' })
  })
  test('discriminated object unions merge; the discriminator becomes an enum', () => {
    const out = check(REAL_WORLD.notionBlocks)
    const item = out.properties.children.items
    assert.equal(item.type, 'object')
    assert.deepEqual(item.properties.type, { enum: ['paragraph', 'heading_1'], type: 'string' })
    assert.deepEqual(item.required, ['type'])
    assert.ok(item.properties.paragraph && item.properties.heading_1)
  })
  test('allOf merges properties and required', () => {
    const out = check({ allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'number' } }, required: ['b'] }] })
    assert.deepEqual(Object.keys(out.properties), ['a', 'b'])
    assert.deepEqual(out.required, ['a', 'b'])
  })
  test('mixed-type unions keep the first branch; "any" branches make it any', () => {
    const out = check({ type: 'object', properties: { m: { oneOf: [{ type: 'string' }, { type: 'number' }] }, x: { anyOf: [{ type: 'string' }, {}] } } })
    assert.deepEqual(out.properties.m, { type: 'string' })
    assert.deepEqual(out.properties.x, {})
  })

  // ── Size and depth ──────────────────────────────────────────────
  test(`nesting deeper than ${GEMINI_SCHEMA_MAX_DEPTH} is cut to a shallow node`, () => {
    let node: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 60; i++) node = { type: 'object', properties: { n: node } }
    const out = check(node)
    assert.ok(maxDepth(out) <= GEMINI_SCHEMA_MAX_DEPTH, `depth ${maxDepth(out)}`)
    let arr: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 60; i++) arr = { type: 'array', items: arr }
    assert.ok(maxDepth(check({ type: 'object', properties: { a: arr } })) <= GEMINI_SCHEMA_MAX_DEPTH + 1)
  })
  test('exponential $ref fan-out stays bounded', () => {
    const defs: Record<string, unknown> = { L0: { type: 'string' } }
    for (let i = 1; i <= 24; i++) {
      defs[`L${i}`] = { type: 'object', properties: { a: { $ref: `#/$defs/L${i - 1}` }, b: { $ref: `#/$defs/L${i - 1}` } } }
    }
    const out = check({ $defs: defs, type: 'object', properties: { root: { $ref: '#/$defs/L24' } } })
    assert.ok(JSON.stringify(out).length < 200_000, `output too large: ${JSON.stringify(out).length}`)
  })

  // ── Real-world corpus ───────────────────────────────────────────
  for (const [name, schema] of Object.entries(REAL_WORLD)) {
    test(`real-world shape: ${name}`, () => { check(schema) })
  }
  test('frozen inputs are never written to', () => {
    for (const schema of [...Object.values(REAL_WORLD), ...Object.values(DOCS_TOOLS)]) {
      check(deepFreeze(structuredClone(schema)))
    }
  })
  test('sanitizeSchemaForLane("gemini") routes through the converter', () => {
    assert.deepEqual(sanitizeSchemaForLane(DOCS_TOOLS.batch, 'gemini'), sanitizeGeminiToolParameters(DOCS_TOOLS.batch))
  })

  // ── Seeded fuzzing ──────────────────────────────────────────────
  test('fuzz: 4000 random schemas are all valid, stable and idempotent', () => {
    let seed = 0x9e3779b9
    const rand = (): number => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const KEYS = ['type', 'properties', 'items', 'required', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref', '$defs', 'nullable', 'description', 'title', 'default', 'format', 'pattern', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'additionalProperties', 'prefixItems', 'not', 'x-ext'] as const
    const NAMES = ['a', 'b', 'items', 'properties', '', '__proto__', 'with space', '$x', 'type', 'k'.repeat(70)]
    const own = (obj: Record<string, unknown>, key: string, value: unknown) =>
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
    const schema = (depth: number): unknown => {
      if (depth > 5 || rand() < 0.1) return pick([true, false, {}, null, 5, 'x', [], { type: 'string' }])
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
        case 'type': return pick(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null', 'STRING', 'text', ['string', 'null'], ['array', 'object'], 5, null])
        case 'properties': {
          const props: Record<string, unknown> = {}
          for (let i = Math.floor(rand() * 4); i > 0; i--) own(props, pick(NAMES), schema(depth + 1))
          return pick([props, props, [], 'x'])
        }
        case 'items': return pick([schema(depth + 1), [schema(depth + 1), schema(depth + 1)], true, false])
        case 'required': return pick([[pick(NAMES), pick(NAMES)], 'a', [], [1, null]])
        case 'enum': return pick([['a', 'b'], [1, 2], [true], ['a', 1, null, { o: 1 }], []])
        case 'const': return pick(['c', 1, null, { o: 1 }, true])
        case 'anyOf': case 'oneOf': case 'allOf':
          return Array.from({ length: Math.floor(rand() * 4) }, () => schema(depth + 1))
        case '$ref': return pick(['#', '#/$defs/A', '#/$defs/B', '#/definitions/C', 'http://x/y', '#/properties/a', '#/$defs/missing', '#/$defs/A/properties/a'])
        case '$defs': return { A: schema(depth + 1), B: schema(depth + 1) }
        case 'nullable': return pick([true, false, 'yes'])
        case 'description': return pick(['d', 5, null, ''])
        case 'format': return pick(['uri', 'date-time', 'int32', 'float', 5, 'weird'])
        case 'minItems': case 'maxItems': case 'minLength': case 'maxLength': return pick([0, 3, -1, 1.5, '2', 1e20, Number.NaN])
        case 'minimum': case 'maximum': return pick([0, -5, 1.5, 'x', Infinity])
        case 'additionalProperties': return pick([true, false, { type: 'string' }])
        case 'prefixItems': return [schema(depth + 1)]
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

  // ── Tool names ──────────────────────────────────────────────────
  test('valid tool names are unchanged', () => {
    for (const name of ['mcp__claude_ai_Claude_Docs__batch', 'Bash', 'read_file', '_x', 'a-b_c', 'x'.repeat(128)]) {
      assert.equal(geminiSafeToolName(name), name)
    }
  })
  test('digit-leading names keep the historical t_ prefix', () => {
    assert.equal(geminiSafeToolName('1tool'), 't_1tool')
  })
  test('invalid names become valid, deterministic and collision-free', () => {
    const names = ['a.b', 'a:b', 'a b', 'a/b', '-x', 'x'.repeat(129), 'x'.repeat(200), `${'y'.repeat(130)}1`, `${'y'.repeat(130)}2`]
    const out = names.map(geminiSafeToolName)
    for (const name of out) assert.match(name, /^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/)
    assert.equal(new Set(out).size, out.length, 'aliases collided')
    assert.deepEqual(names.map(geminiSafeToolName), out, 'not deterministic')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
