// Repairing MCP tool arguments toward the server's own JSON Schema.
//
// coerceToolInput reads its expected types off the tool's Zod schema, and
// every MCP tool shares MCPTool's `z.object({}).passthrough()` placeholder,
// which declares none — so for MCP it did nothing. The Cline lane grew its
// own copy of the recovery; no other lane had any. These cases cover the
// shared, schema-driven replacement.
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
  `.mcp-coerce-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __mcpCoerce() {
  init_coerceMcpInput(); init_contractValidation();
  return { coerceMcpInput, checkMcpArguments };
}
`
writeFileSync(auditPath, source)

let c
try {
  const module = await import(pathToFileURL(auditPath).href)
  c = module.__mcpCoerce()
} finally {
  unlinkSync(auditPath)
}

const arraySchema = {
  type: 'object',
  properties: {
    batch: { type: 'array', items: { type: 'object' } },
    container: { type: 'object' },
    opId: { type: 'string' },
  },
  required: ['batch', 'container'],
}

test('a stringified array becomes an array', () => {
  // The reported case: a model sends `"batch": "[{...}]"`, a JSON string
  // where the schema wants an array.
  const out = c.coerceMcpInput(
    { batch: '[{"op":"update"}]', container: { id: 'x' } },
    arraySchema,
  )
  assert.equal(Array.isArray(out.batch), true)
  assert.deepEqual(out.batch, [{ op: 'update' }])
})

test('a stringified object becomes an object', () => {
  const out = c.coerceMcpInput(
    { batch: [], container: '{"id":"bd72","kind":"project"}' },
    arraySchema,
  )
  assert.deepEqual(out.container, { id: 'bd72', kind: 'project' })
})

test('the repaired call then passes validation', () => {
  // End to end: the shape from the transcript, repaired and accepted.
  const tool = { name: 'mcp__docs__batch', isMcp: true, inputJSONSchema: arraySchema }
  const wire = {
    batch: '[{"op":"update","ref":{"id":"4c85"}}]',
    container: '{"id":"bd72","kind":"project"}',
    opId: 'test-batch-1',
  }
  assert.equal(c.checkMcpArguments(tool, wire).ok, false)
  assert.equal(c.checkMcpArguments(tool, c.coerceMcpInput(wire, arraySchema)).ok, true)
})

test('a malformed JSON string is left exactly as it arrived', () => {
  // The transcript's actual payload had its inner quotes eaten, so it does
  // not parse. Repairing it would mean inventing a payload; it is left for
  // validation to report.
  const broken = '[{"op":"update"'
  const out = c.coerceMcpInput(
    { batch: broken, container: { id: 'x' } },
    arraySchema,
  )
  assert.equal(out.batch, broken)
})

test('an unparseable structure argument is explained, not just rejected', () => {
  // "must be array" alone leaves the model guessing whether it chose the
  // wrong field, the wrong type, or mangled its escaping.
  const tool = { name: 'mcp__docs__batch', isMcp: true, inputJSONSchema: arraySchema }
  const result = c.checkMcpArguments(tool, {
    batch: '[{"op":"update"',
    container: { id: 'x' },
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /does not parse/)
  assert.match(result.message, /real array value rather than a quoted string/)
})

test('a value the schema already accepts is untouched', () => {
  const input = { batch: [{ op: 'update' }], container: { id: 'x' } }
  const out = c.coerceMcpInput(input, arraySchema)
  // Same reference: nothing was rewritten.
  assert.equal(out, input)
})

test('a string that belongs as a string is not parsed', () => {
  // `opId` is declared a string, so a JSON-looking value stays text.
  const out = c.coerceMcpInput(
    { batch: [], container: {}, opId: '{"not":"parsed"}' },
    arraySchema,
  )
  assert.equal(out.opId, '{"not":"parsed"}')
})

test('numeric and boolean strings are repaired only where declared', () => {
  const schema = {
    type: 'object',
    properties: {
      limit: { type: 'integer' },
      ratio: { type: 'number' },
      dryRun: { type: 'boolean' },
      label: { type: 'string' },
    },
  }
  const out = c.coerceMcpInput(
    { limit: '25', ratio: '0.5', dryRun: 'true', label: '42' },
    schema,
  )
  assert.equal(out.limit, 25)
  assert.equal(out.ratio, 0.5)
  assert.equal(out.dryRun, true)
  // Declared a string, so it stays one.
  assert.equal(out.label, '42')
})

test('a fractional string is not forced into an integer field', () => {
  const schema = { type: 'object', properties: { page: { type: 'integer' } } }
  const out = c.coerceMcpInput({ page: '1.5' }, schema)
  // Left for validation to reject rather than silently truncated.
  assert.equal(out.page, '1.5')
})

test('a number is stringified only where a string is the only option', () => {
  const strict = { type: 'object', properties: { id: { type: 'string' } } }
  assert.equal(c.coerceMcpInput({ id: 42 }, strict).id, '42')
  const union = {
    type: 'object',
    properties: { id: { type: ['string', 'number'] } },
  }
  // The schema takes a number as it stands, so it is left alone.
  assert.equal(c.coerceMcpInput({ id: 42 }, union).id, 42)
})

test('nested and array items are repaired too', () => {
  const schema = {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: { tags: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  }
  const out = c.coerceMcpInput({ rows: [{ tags: '["a","b"]' }] }, schema)
  assert.deepEqual(out.rows[0].tags, ['a', 'b'])
})

test('a union branch that already fits wins outright', () => {
  const schema = {
    type: 'object',
    properties: {
      target: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    },
  }
  assert.equal(c.coerceMcpInput({ target: 'one' }, schema).target, 'one')
  // A JSON-looking string is a *valid* string here, and the schema says so.
  // Parsing it would override the contract with a guess about which branch
  // the model meant.
  assert.equal(c.coerceMcpInput({ target: '["a","b"]' }, schema).target, '["a","b"]')
})

test('a union repairs into the only branch that can take the value', () => {
  const schema = {
    type: 'object',
    properties: {
      target: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'integer' }] },
    },
  }
  // No branch accepts a string, but one accepts what it parses into.
  assert.deepEqual(c.coerceMcpInput({ target: '["a","b"]' }, schema).target, [
    'a',
    'b',
  ])
})

test('an undeclared property is passed through, never guessed at', () => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'string' } },
  }
  const out = c.coerceMcpInput({ id: 'a', extra: '[1,2]' }, schema)
  // No schema says what `extra` is, so its type is not invented.
  assert.equal(out.extra, '[1,2]')
})

test('additionalProperties gives undeclared values a type to repair toward', () => {
  const schema = {
    type: 'object',
    properties: {},
    additionalProperties: { type: 'array', items: { type: 'string' } },
  }
  assert.deepEqual(c.coerceMcpInput({ anything: '["a"]' }, schema).anything, [
    'a',
  ])
})

test('a schema that states no type repairs nothing', () => {
  const schema = { type: 'object', properties: { free: {} } }
  assert.equal(c.coerceMcpInput({ free: '[1,2]' }, schema).free, '[1,2]')
})

test('no schema, or non-object arguments, are returned unchanged', () => {
  assert.deepEqual(c.coerceMcpInput({ a: '1' }, undefined), { a: '1' })
  assert.equal(c.coerceMcpInput('not an object', arraySchema), 'not an object')
  assert.equal(c.coerceMcpInput(null, arraySchema), null)
})

test('a required field is never invented', () => {
  // `batch` and `container` are required and absent; repair adds neither.
  const out = c.coerceMcpInput({ opId: 'x' }, arraySchema)
  assert.deepEqual(Object.keys(out), ['opId'])
})

test('a deeply nested schema terminates', () => {
  // Third-party schemas can nest arbitrarily; the walk is depth-capped.
  let schema = { type: 'array', items: { type: 'string' } }
  for (let i = 0; i < 60; i++) schema = { type: 'array', items: schema }
  const input = { deep: '[]' }
  const wrapper = { type: 'object', properties: { deep: schema } }
  // The point is that this returns at all.
  assert.ok(c.coerceMcpInput(input, wrapper))
})
