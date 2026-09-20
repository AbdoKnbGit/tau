// Projecting an MCP tool's JSON Schema into a lane's accepted subset.
//
// The sanitizer drops keywords each provider rejects. The thing it must not
// do is apply that drop list where a key is a user-chosen name rather than a
// schema keyword — a tool parameter called `default`, `format` or `x-label`
// is describing its own API.
//
// Exercised through the built bundle, like core-tool-contracts.test.mjs.

import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const auditPath = join(
  dirname(distPath),
  `.mcp-projection-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __mcpProjection() {
  init_mcp_bridge(); init_schema_positions();
  return { sanitizeSchemaForLane, walkSchemaByPosition };
}
`
writeFileSync(auditPath, source)

let b
try {
  const module = await import(pathToFileURL(auditPath).href)
  b = module.__mcpProjection()
} finally {
  unlinkSync(auditPath)
}

// 'mistral' has the widest drop list of the walk-based profiles ($schema,
// $id, $ref, $comment, strict, additionalProperties, format, examples,
// default), so it is the sharpest test of keyword-versus-name confusion.
const PROFILE = 'mistral'

test('a keyword is still dropped where it really is a keyword', () => {
  const out = b.sanitizeSchemaForLane(
    { type: 'object', $schema: 'x', default: 'y', properties: {} },
    PROFILE,
  )
  assert.equal('$schema' in out, false)
  assert.equal('default' in out, false)
  assert.equal(out.type, 'object')
})

test('a property named like a keyword survives', () => {
  // Reproduced defect: these three properties were deleted from the
  // declaration while `required` still named two of them, so the model was
  // handed a schema whose mandatory fields did not exist.
  const out = b.sanitizeSchemaForLane(
    {
      type: 'object',
      properties: {
        default: { type: 'string' },
        format: { type: 'string' },
        'x-label': { type: 'string' },
        keep: { type: 'number' },
      },
      required: ['default', 'x-label'],
    },
    PROFILE,
  )
  assert.deepEqual(Object.keys(out.properties), [
    'default',
    'format',
    'x-label',
    'keep',
  ])
  // Every name in `required` is a property that still exists.
  for (const name of out.required) {
    assert.equal(name in out.properties, true, `${name} missing`)
  }
})

test('a keyword-named property still has its own subschema sanitized', () => {
  // The name survives; the schema under it is projected like any other.
  const out = b.sanitizeSchemaForLane(
    {
      type: 'object',
      properties: {
        default: { type: 'string', $comment: 'internal', format: 'uuid' },
      },
    },
    PROFILE,
  )
  assert.equal('default' in out.properties, true)
  assert.equal('$comment' in out.properties.default, false)
  assert.equal('format' in out.properties.default, false)
  assert.equal(out.properties.default.type, 'string')
})

test('nested properties keep keyword-like names at every depth', () => {
  const out = b.sanitizeSchemaForLane(
    {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { default: { type: 'boolean' } },
          required: ['default'],
        },
      },
    },
    PROFILE,
  )
  assert.equal('default' in out.properties.filter.properties, true)
})

test('$defs and patternProperties keep their keys', () => {
  const out = b.sanitizeSchemaForLane(
    {
      type: 'object',
      $defs: { default: { type: 'string' }, 'x-shared': { type: 'number' } },
      patternProperties: { '^x-': { type: 'string' } },
      properties: {},
    },
    'codex',
  )
  assert.deepEqual(Object.keys(out.$defs), ['default', 'x-shared'])
  assert.deepEqual(Object.keys(out.patternProperties), ['^x-'])
})

test('an enum of keyword-like strings is passed through untouched', () => {
  // enum members are data, not keys to filter.
  const out = b.sanitizeSchemaForLane(
    {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['default', 'format', 'x-custom'] },
      },
    },
    PROFILE,
  )
  assert.deepEqual(out.properties.mode.enum, ['default', 'format', 'x-custom'])
})

test('a default value object is not filtered as if it were a schema', () => {
  // `default` survives on a profile that does not drop it, and its VALUE is
  // data: filtering keywords out of it would change what the server receives.
  const out = b.sanitizeSchemaForLane(
    {
      type: 'object',
      properties: {
        options: {
          type: 'object',
          default: { format: 'json', 'x-trace': true, strict: false },
        },
      },
    },
    'codex',
  )
  assert.deepEqual(out.properties.options.default, {
    format: 'json',
    'x-trace': true,
    strict: false,
  })
})

test('composition branches are sanitized and keep their order', () => {
  const out = b.sanitizeSchemaForLane(
    {
      type: 'object',
      properties: {
        value: {
          oneOf: [
            { type: 'string', $comment: 'a' },
            { type: 'number', $comment: 'b' },
          ],
        },
      },
    },
    'codex',
  )
  assert.deepEqual(out.properties.value.oneOf, [
    { type: 'string' },
    { type: 'number' },
  ])
})

test('array items keep keyword-like property names', () => {
  const out = b.sanitizeSchemaForLane(
    {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { default: { type: 'string' } },
            required: ['default'],
          },
        },
      },
    },
    PROFILE,
  )
  assert.equal('default' in out.properties.rows.items.properties, true)
  assert.deepEqual(out.properties.rows.items.required, ['default'])
})

test('a boolean additionalProperties is preserved, not walked', () => {
  const out = b.sanitizeSchemaForLane(
    { type: 'object', additionalProperties: false, properties: {} },
    'codex',
  )
  assert.equal(out.additionalProperties, false)
})

test('an additionalProperties subschema is sanitized as a schema', () => {
  const out = b.sanitizeSchemaForLane(
    {
      type: 'object',
      additionalProperties: { type: 'string', $comment: 'drop me' },
      properties: {},
    },
    'codex',
  )
  assert.deepEqual(out.additionalProperties, { type: 'string' })
})

test('a non-gemini profile still drops its listed keywords', () => {
  // The pre-existing contract, unchanged.
  const out = b.sanitizeSchemaForLane(
    { type: 'object', $schema: 'x', additionalProperties: true },
    'groq',
  )
  assert.equal('$schema' in out, false)
})

test('a null input still falls back to an empty object schema', () => {
  const out = b.sanitizeSchemaForLane(null, 'codex')
  assert.equal(out.type, 'object')
  assert.deepEqual(out.properties, {})
})

// ─── The shared position-aware walk itself ──────────────────────
//
// openai-compat/loop.ts drives its own drop list through this same walk, and
// its sanitizer is not exported, so the walk is covered directly here.

/** A drop-list visitor of the shape both call sites use. */
const dropping = (...keys) => {
  const drop = new Set(keys)
  return (key, value, recurse) => {
    if (drop.has(key)) return undefined
    if (key.startsWith('x-')) return undefined
    return recurse(value)
  }
}

test('the shared walk drops keywords but keeps property names', () => {
  const out = b.walkSchemaByPosition(
    {
      type: 'object',
      $schema: 'drop me',
      'x-vendor': 'drop me too',
      properties: {
        default: { type: 'string', $schema: 'drop me' },
        'x-label': { type: 'string' },
      },
      required: ['default', 'x-label'],
    },
    dropping('$schema', 'default'),
  )
  assert.equal('$schema' in out, false)
  assert.equal('x-vendor' in out, false)
  assert.deepEqual(Object.keys(out.properties), ['default', 'x-label'])
  assert.equal('$schema' in out.properties.default, false)
  assert.deepEqual(out.required, ['default', 'x-label'])
})

test('the shared walk leaves data values untouched', () => {
  const out = b.walkSchemaByPosition(
    {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['default', 'x-legacy'],
          default: { 'x-nested': 1, format: 'json' },
        },
      },
    },
    dropping('format'),
  )
  assert.deepEqual(out.properties.mode.enum, ['default', 'x-legacy'])
  // The default VALUE is data: its keys are not keywords to filter.
  assert.deepEqual(out.properties.mode.default, { 'x-nested': 1, format: 'json' })
})

test('the shared walk recurses through every subschema position', () => {
  const out = b.walkSchemaByPosition(
    {
      type: 'object',
      properties: { a: { type: 'string', $id: 'x' } },
      items: { type: 'string', $id: 'x' },
      anyOf: [{ type: 'string', $id: 'x' }],
      not: { type: 'string', $id: 'x' },
      $defs: { Shared: { type: 'string', $id: 'x' } },
      additionalProperties: { type: 'string', $id: 'x' },
    },
    dropping('$id'),
  )
  assert.equal('$id' in out.properties.a, false)
  assert.equal('$id' in out.items, false)
  assert.equal('$id' in out.anyOf[0], false)
  assert.equal('$id' in out.not, false)
  assert.equal('$id' in out.$defs.Shared, false)
  assert.equal('$id' in out.additionalProperties, false)
  // The $defs key is a name, so it survives whatever it is called.
  assert.deepEqual(Object.keys(out.$defs), ['Shared'])
})

test('the shared walk preserves boolean schemas in subschema positions', () => {
  const out = b.walkSchemaByPosition(
    { type: 'object', additionalProperties: false, items: true, properties: {} },
    dropping('$id'),
  )
  assert.equal(out.additionalProperties, false)
  assert.equal(out.items, true)
})
