/**
 * Run: bun run src/utils/model/openrouterStrictSchema.test.ts
 */

process.env.TAU_OPENROUTER_STRICT_TOOLS_STORE =
  `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/tau-openrouter-strict-tools-test.json`

import {
  isOpenAIStrictOnOpenRouter,
  isOpenRouterStrictToolSchemaError,
  isStrictToolSchemaOnOpenRouter,
  normalizeOpenAIStrictToolSchema,
  normalizeOpenRouterGPTToolSchemas,
  recordOpenRouterStrictToolSchemaModel,
  _resetOpenRouterStrictToolSchemaForTests,
} from './openrouterStrictSchema.js'

let passed = 0
let failed = 0

function assertEq(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  }
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
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

function assertStrictObjectInvariants(schema: any, path = 'root'): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return

  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
    const props = schema.properties ?? {}
    assert(props && typeof props === 'object' && !Array.isArray(props), `${path}.properties must be an object`)
    assert(Array.isArray(schema.required), `${path}.required must be an array`)
    assert(
      JSON.stringify(schema.required) === JSON.stringify(Object.keys(props)),
      `${path}.required=${JSON.stringify(schema.required)} props=${JSON.stringify(Object.keys(props))}`,
    )
    assert(schema.additionalProperties === false, `${path}.additionalProperties must be false`)
  }

  for (const forbidden of [
    '$schema', '$id', '$ref', '$defs', 'propertyNames', 'patternProperties',
    'minLength', 'pattern', 'format', 'const', 'if', 'then', 'else', 'x-mcp',
  ]) {
    assert(!(forbidden in schema), `${path} still has forbidden key ${forbidden}`)
  }

  for (const [key, value] of Object.entries(schema)) {
    if (value && typeof value === 'object') assertStrictObjectInvariants(value, `${path}.${key}`)
  }
}

await test('detects OpenRouter GPT and o-series strict models only', () => {
  assert(isOpenAIStrictOnOpenRouter('openai/gpt-5.5'), 'openai/gpt-5.5 should be strict')
  assert(isOpenAIStrictOnOpenRouter('gpt-4.1'), 'bare gpt-4.1 should be strict')
  assert(isOpenAIStrictOnOpenRouter('openai/o4-mini'), 'o-series should be strict')
  assert(!isOpenAIStrictOnOpenRouter('openai/gpt-oss-120b'), 'gpt-oss should not use Azure strict normalization')
  assert(!isOpenAIStrictOnOpenRouter('anthropic/claude-sonnet-4.6'), 'non-OpenAI model should not be strict')
})

await test('normalizes MCP-style loose schemas to serialized OpenAI strict invariants', () => {
  const out = normalizeOpenAIStrictToolSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    'x-mcp': 'server-extension',
    propertyNames: { pattern: '^[a-z_]+$' },
    patternProperties: { '^x-': { type: 'string' } },
    properties: {
      query: { type: 'string', minLength: 1, pattern: '^x', default: 'x' },
      metadata: undefined,
      loose: {},
      allowAny: true,
      forbidden: false,
      nested: {
        type: 'object',
        properties: {
          tag: { const: 'alpha' },
          dropped: undefined,
        },
        required: ['tag', 'dropped', 'ghost'],
        additionalProperties: { type: 'string' },
      },
      list: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            uri: { type: 'string', format: 'uri' },
            missing: undefined,
          },
          required: ['uri', 'missing'],
        },
      },
    },
    required: ['query', 'metadata', 'loose', 'allowAny', 'forbidden', 'nested', 'list', 'ghost'],
    additionalProperties: { type: 'string' },
  })

  const wire = JSON.parse(JSON.stringify(out))
  assertStrictObjectInvariants(wire)
  assert(wire.properties.metadata === undefined, 'undefined metadata property must not serialize')
  assert(wire.properties.forbidden === undefined, 'false schema property must be dropped')
  assert(wire.properties.loose.type === 'string', 'loose property schema should get a fallback type')
  assert(wire.properties.allowAny.type === 'string', 'true property schema should get a fallback type')
  assert(wire.properties.nested.properties.tag.type === 'string', 'const-only property should get a fallback type')
})

await test('recognizes the strict-schema rejection from any upstream', () => {
  // The 400 meta/muse-spark-1.3-contributor answers, verbatim.
  const musSpark = `{"error":{"message":"Provider returned error","code":400,`
    + `"metadata":{"raw":"{\\"error\\":{\\"code\\":null,\\"message\\":\\"'required' is required`
    + ` to be supplied and to be an array including every key in properties. Missing`
    + ` 'isolation'.\\",\\"param\\":\\"parameters\\",\\"type\\":\\"invalid_request_error\\"}}",`
    + `"provider_name":"Meta"}}}`
  assert(isOpenRouterStrictToolSchemaError(musSpark), 'Muse Spark 400 must be recognized')
  assert(
    isOpenRouterStrictToolSchemaError(
      `{"error":{"message":"Invalid schema for function 'Bash': 'additionalProperties'`
      + ` is required to be supplied and to be false."}}`,
    ),
    'the additionalProperties variant is the same failure',
  )
  assert(
    !isOpenRouterStrictToolSchemaError('{"error":{"message":"context length exceeded"}}'),
    'an unrelated 400 must not be mistaken for it',
  )
  assert(!isOpenRouterStrictToolSchemaError(''), 'an empty body is not a match')
})

await test('learns a strict upstream from its own error, base id and variants alike', () => {
  _resetOpenRouterStrictToolSchemaForTests()
  const model = 'meta/muse-spark-1.3-contributor'
  assert(!isStrictToolSchemaOnOpenRouter(model), 'nothing is assumed about Meta up front')

  recordOpenRouterStrictToolSchemaModel(model)
  assert(isStrictToolSchemaOnOpenRouter(model), 'the row is strict once it has said so')
  assert(
    isStrictToolSchemaOnOpenRouter(`${model}:free`),
    'a routing variant shares the base row’s verdict',
  )
  assert(
    !isStrictToolSchemaOnOpenRouter('anthropic/claude-sonnet-4.6'),
    'learning one row must not widen to the whole catalog',
  )
  assert(
    isStrictToolSchemaOnOpenRouter('openai/gpt-5.5'),
    'OpenAI families stay strict without having to fail first',
  )
})

await test('normalizes a learned model’s tool schemas in place', () => {
  _resetOpenRouterStrictToolSchemaForTests(['meta/muse-spark-1.3-contributor'])
  const tools = [{
    function: {
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          prompt: { type: 'string' },
          isolation: { type: 'string', enum: ['worktree', 'remote'] },
        },
        required: ['description', 'prompt'],
      },
    },
  }]
  normalizeOpenRouterGPTToolSchemas(tools, 'meta/muse-spark-1.3-contributor')
  const params = tools[0]!.function.parameters as any
  assertEq(
    JSON.stringify(params.required),
    JSON.stringify(['description', 'prompt', 'isolation']),
    'the property named in the 400 must now be required',
  )
  assertEq(params.additionalProperties, false, 'strict objects reject extra properties')
})

await test('leaves an unlearned model’s tool schemas untouched', () => {
  _resetOpenRouterStrictToolSchemaForTests()
  const tools = [{
    function: {
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, isolation: { type: 'string' } },
        required: ['prompt'],
      },
    },
  }]
  normalizeOpenRouterGPTToolSchemas(tools, 'anthropic/claude-sonnet-4.6')
  const params = tools[0]!.function.parameters as any
  assertEq(
    JSON.stringify(params.required),
    JSON.stringify(['prompt']),
    'optional parameters stay optional where nothing demands otherwise',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
