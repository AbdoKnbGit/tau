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
  return { coerceMcpInput, checkMcpArguments, INCOMPLETE_TOOL_ARGUMENTS };
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
  assert.match(result.message, /not valid JSON/)
  assert.match(result.message, /real array value rather than a quoted string/)
  // The parser's own message never appears: this string is also copied into
  // analytics errorDetails, and a parser that quoted the offending fragment
  // would put argument content into telemetry.
  assert.doesNotMatch(result.message, /Expected .* in JSON at position/)
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

// --- Findings from the follow-up review (F05, F09-F12) ----------
//
// The governing rule these enforce: an already valid argument object is
// returned untouched. An earlier walk repaired each node on its own, which
// rewrote valid input into a different operation.

test('an already valid union value is never rewritten', () => {
  // F09. `{n: "5"}` satisfies the string branch exactly as sent. Rewriting
  // it to `{n: 5}` makes a different call that also validates - which is
  // precisely why "it validates afterwards" is not a safety argument.
  const schema = {
    type: 'object',
    properties: {
      p: {
        anyOf: [
          { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
          { type: 'object', properties: { n: { type: 'string' } }, required: ['n'] },
        ],
      },
    },
  }
  assert.deepEqual(c.coerceMcpInput({ p: { n: '5' } }, schema), { p: { n: '5' } })
})

test('a zero-padded identifier keeps its padding', () => {
  // F09. "007" is a valid string; turning it into 7 loses the padding that
  // may be exactly what identifies the record.
  const schema = {
    type: 'object',
    properties: { id: { anyOf: [{ type: 'integer' }, { type: 'string' }] } },
  }
  assert.equal(c.coerceMcpInput({ id: '007' }, schema).id, '007')
})

test('an unsatisfiable oneOf is not forced through', () => {
  // F09. oneOf requires exactly one match; [1,2] matches both branches, so
  // no repair can rescue it and the value is returned as sent.
  const schema = {
    type: 'object',
    properties: {
      v: {
        oneOf: [
          { type: 'array', items: { type: 'integer' } },
          { type: 'array', items: { type: 'number' } },
        ],
      },
    },
  }
  assert.equal(c.coerceMcpInput({ v: '[1,2]' }, schema).v, '[1,2]')
})

test('allOf conjuncts are all applied, never treated as alternatives', () => {
  // F09. Satisfying the first conjunct while breaking the second would
  // produce an invalid call; candidates are checked against the whole
  // contract, so that one is refused.
  const schema = {
    type: 'object',
    properties: { v: { allOf: [{ type: 'array' }, { minItems: 2 }] } },
  }
  assert.equal(c.coerceMcpInput({ v: '[1]' }, schema).v, '[1]')
  assert.deepEqual(c.coerceMcpInput({ v: '[1,2]' }, schema).v, [1, 2])
})

test('an integer beyond double precision is never silently rounded', () => {
  // F10. JSON.parse turns "9007199254740993" into ...992, which then
  // validates as an integer - a corrupted identifier reaching the server
  // looking correct.
  const schema = { type: 'object', properties: { n: { type: 'integer' } } }
  assert.equal(
    c.coerceMcpInput({ n: '9007199254740993' }, schema).n,
    '9007199254740993',
  )
  assert.equal(c.coerceMcpInput({ n: '42' }, schema).n, 42)
})

test('a large integer inside a stringified structure is not rounded', () => {
  // F10. The rounding can happen inside an otherwise valid array, where
  // validating the parsed result would never notice.
  const schema = {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'integer' } } },
  }
  assert.equal(
    c.coerceMcpInput({ ids: '[9007199254740993]' }, schema).ids,
    '[9007199254740993]',
  )
  assert.deepEqual(c.coerceMcpInput({ ids: '[1,2]' }, schema).ids, [1, 2])
})

test('digits inside a quoted string do not block a parse', () => {
  // F10. The precision scan is token-aware: an opaque id that happens to be
  // a long digit string is not a numeric literal.
  const schema = {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' } } },
  }
  assert.deepEqual(
    c.coerceMcpInput({ ids: '["9007199254740993"]' }, schema).ids,
    ['9007199254740993'],
  )
})

test('a patternProperties field is not repaired as an additional property', () => {
  // F11. `x_a` matches ^x_ and must be a string; the additionalProperties
  // array schema does not apply to it.
  const schema = {
    type: 'object',
    patternProperties: { '^x_': { type: 'string' } },
    additionalProperties: { type: 'array' },
  }
  assert.equal(c.coerceMcpInput({ x_a: '[1]' }, schema).x_a, '[1]')
  // A property the pattern does not cover still uses additionalProperties.
  assert.deepEqual(c.coerceMcpInput({ other: '[1]' }, schema).other, [1])
})

test('repair follows a local $ref', () => {
  // F12. The contract is resolved by the validator, so a referenced array
  // type is honoured without the repair engine reimplementing $ref.
  const schema = {
    type: 'object',
    $defs: { Tags: { type: 'array', items: { type: 'string' } } },
    properties: { tags: { $ref: '#/$defs/Tags' } },
  }
  assert.deepEqual(c.coerceMcpInput({ tags: '["a"]' }, schema).tags, ['a'])
})

test('a 2020-12 keyword is enforced, not silently ignored', () => {
  // F05. Deleting $schema and validating under Ajv's Draft-07 default made
  // dependentRequired a no-op, so arguments the server rejects passed.
  const tool = {
    name: 'mcp__fixture__dependent',
    isMcp: true,
    inputJSONSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      dependentRequired: { a: ['b'] },
    },
  }
  assert.equal(c.checkMcpArguments(tool, { a: 'x' }).ok, false)
  assert.equal(c.checkMcpArguments(tool, { a: 'x', b: 'y' }).ok, true)
})

test('two contracts sharing an $id both remain callable', () => {
  // F05. A shared Ajv registers by $id, so a server that updated its schema
  // - or a second server reusing an $id - was reported unsupported and its
  // tool could not be called at all.
  const shared = 'https://example.invalid/shared'
  const v1 = {
    name: 'mcp__fixture__shared_id',
    isMcp: true,
    inputJSONSchema: {
      $id: shared,
      type: 'object',
      properties: { v: { type: 'string' } },
      required: ['v'],
    },
  }
  const v2 = {
    name: 'mcp__fixture__shared_id',
    isMcp: true,
    inputJSONSchema: {
      $id: shared,
      type: 'object',
      properties: { v: { type: 'integer' } },
      required: ['v'],
    },
  }
  assert.equal(c.checkMcpArguments(v1, { v: 'text' }).ok, true)
  assert.equal(c.checkMcpArguments(v2, { v: 7 }).ok, true)
  // Each still enforces its own contract.
  assert.equal(c.checkMcpArguments(v1, { v: 7 }).ok, false)
  assert.equal(c.checkMcpArguments(v2, { v: 'text' }).ok, false)
})

test('arguments that never arrived complete are refused, not executed', () => {
  // F13. A truncated or malformed streamed concatenation used to be dropped,
  // and whatever earlier deltas had assembled was dispatched as the whole
  // call — so an argument the stream never finished delivering simply went
  // missing. Validation cannot tell that from the model omitting an optional
  // field, so the call executed silently and wrongly.
  const schema = {
    type: 'object',
    properties: { container: { type: 'object' }, batch: { type: 'array' } },
    required: ['container'],
  }
  const tool = { name: 'mcp__docs__batch', isMcp: true, inputJSONSchema: schema }

  // The fragment that did arrive satisfies the schema on its own, which is
  // exactly why the marker is needed: nothing else here looks wrong.
  const partial = { container: { id: 'x' } }
  assert.equal(c.checkMcpArguments(tool, partial).ok, true)

  const marked = { ...partial, [c.INCOMPLETE_TOOL_ARGUMENTS]: 21 }
  const result = c.checkMcpArguments(tool, marked)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'decode_error')
  assert.match(result.message, /did not arrive complete/)
})
