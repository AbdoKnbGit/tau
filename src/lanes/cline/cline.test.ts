/**
 * Cline lane invariants.
 *
 * Run: bun run src/lanes/cline/cline.test.ts
 */

import { buildClineToolsForRequest } from './tools.js'
import {
  buildClineBlockedInvalidToolCallText,
  buildClineRequiredParamMap,
  buildClineToolArgRepairMessage,
  buildClineToolSchemaMap,
  coerceClineToolCallArguments,
  findClineToolCallsMissingRequiredArgs,
  normalizeClineToolCallArgumentEvents,
} from './tool_arg_validation.js'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepContainsKey(obj: unknown, key: string): boolean {
  if (!obj || typeof obj !== 'object') return false
  if (Array.isArray(obj)) return obj.some(item => deepContainsKey(item, key))
  for (const [candidate, value] of Object.entries(obj as Record<string, unknown>)) {
    if (candidate === key) return true
    if (deepContainsKey(value, key)) return true
  }
  return false
}

function main(): void {
  console.log('cline lane:')

  const sampleProviderTools = () => ([
    {
      name: 'SampleAstSearch',
      description: 'AST search',
      input_schema: {
        type: 'object',
        required: ['pattern', 'lang'],
        additionalProperties: false,
        properties: {
          pattern: { type: 'string' },
          lang: { type: 'string', enum: ['go', 'typescript'] },
          paths: { type: 'array', items: { type: 'string' } },
          globs: { type: 'array', items: { type: 'string' } },
          contextLines: { type: 'integer' },
        },
      },
    },
    {
      name: 'TaskUpdate',
      description: 'Update task',
      input_schema: {
        type: 'object',
        required: ['taskId'],
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          subject: { type: 'string' },
          metadata: {
            type: 'object',
            propertyNames: { type: 'string' },
            additionalProperties: {},
          },
        },
      },
    },
    {
      name: 'WebFetch',
      description: 'Fetch URL',
      input_schema: {
        type: 'object',
        required: ['url', 'prompt'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', format: 'uri' },
          prompt: { type: 'string' },
        },
      },
    },
    ...Array.from({ length: 32 }, (_, index) => ({
      name: `DummyTool${index}`,
      description: 'dummy',
      input_schema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: {
          value: { type: 'string' },
          optionalPath: { type: 'string' },
        },
      },
    })),
  ] as any)

  const countRequiredMarkers = (description: string | undefined): number =>
    (description?.match(/ REQUIRED/g) ?? []).length

  // Default path: the mixed Cline fleet (weak/non-OpenAI upstreams) must get
  // the TRUTHFUL schema — real `required` untouched, optionals left optional,
  // no `strict` flag, no nullable rewrite. This is what stops weak models from
  // treating every optional MCP field as mandatory and emitting empty/garbage
  // tool calls.
  test('default (non-strict) emits truthful schemas across the full 35-tool set', () => {
    const providerTools = sampleProviderTools()
    const tools = buildClineToolsForRequest(providerTools)
    assert(tools.length === 35, `tools.length=${tools.length}`)

    for (const tool of tools) {
      assert(tool.type === 'function', `${tool.function.name} not a function tool`)
      assert(tool.function.strict === undefined,
        `${tool.function.name} must not advertise strict on the mixed fleet: ${tool.function.strict}`)
      assert(tool.function.description?.includes('STRICT PARAMETERS:'),
        `${tool.function.name} missing strict parameter hint`)
      // Meta keywords that trip the gateway validator must still be stripped.
      for (const key of ['format', 'propertyNames', 'default', 'examples']) {
        assert(!deepContainsKey(tool.function.parameters, key), `${tool.function.name} leaked ${key}`)
      }
    }

    const ast = tools.find(tool => tool.function.name === 'SampleAstSearch')!
    const astProps = ast.function.parameters.properties as Record<string, any>
    const astRequired = ast.function.parameters.required as string[] | undefined
    assert(JSON.stringify(astRequired) === JSON.stringify(['pattern', 'lang']),
      `SampleAstSearch required should stay ['pattern','lang'], got ${JSON.stringify(astRequired)}`)
    assert(astProps.paths.type === 'array',
      `optional paths must stay a plain array (not nullable), got ${JSON.stringify(astProps.paths.type)}`)
    // The hint must mark ONLY the two truly-required fields, never the optionals.
    assert(countRequiredMarkers(ast.function.description) === 2,
      `SampleAstSearch hint should mark 2 required fields, got ${countRequiredMarkers(ast.function.description)}: ${ast.function.description}`)

    const task = tools.find(tool => tool.function.name === 'TaskUpdate')!
    const taskRequired = task.function.parameters.required as string[] | undefined
    assert(JSON.stringify(taskRequired) === JSON.stringify(['taskId']),
      `TaskUpdate required should stay ['taskId'], got ${JSON.stringify(taskRequired)}`)
    assert(countRequiredMarkers(task.function.description) === 1,
      `TaskUpdate hint should mark 1 required field, got ${countRequiredMarkers(task.function.description)}`)
  })

  // Strict path (genuine OpenAI models on Cline): all-required + nullable
  // shaping is correct because OpenAI enforces it. But the human-readable hint
  // must STILL reflect the true contract — built from the wire schema, never
  // the strict-shaped one. This is the regression guard for the hint bug.
  test('strict mode shapes schemas for OpenAI yet keeps the hint truthful', () => {
    const providerTools = sampleProviderTools()
    const tools = buildClineToolsForRequest(providerTools, { strict: true })

    for (const tool of tools) {
      assert(tool.function.strict === true, `${tool.function.name} strict=${tool.function.strict}`)
      const parameters = tool.function.parameters
      const properties = parameters.properties as Record<string, unknown>
      assert(isRecord(properties), `${tool.function.name} properties missing`)
      const required = parameters.required as unknown
      assert(Array.isArray(required), `${tool.function.name} required missing`)
      for (const propertyName of Object.keys(properties)) {
        assert((required as string[]).includes(propertyName),
          `${tool.function.name} ${propertyName} missing from strict required`)
      }
      assert(parameters.additionalProperties === false,
        `${tool.function.name} additionalProperties=${JSON.stringify(parameters.additionalProperties)}`)
    }

    const ast = tools.find(tool => tool.function.name === 'SampleAstSearch')!
    const astProps = ast.function.parameters.properties as Record<string, any>
    assert(astProps.pattern.type === 'string', 'pattern must stay required string')
    assert(Array.isArray(astProps.paths.type) && astProps.paths.type.includes('array') && astProps.paths.type.includes('null'),
      `optional paths should be nullable array, got ${JSON.stringify(astProps.paths.type)}`)
    // Hint honesty: even though the wire schema was strict-shaped to all-required,
    // the description must still mark only pattern + lang (the real required set).
    assert(countRequiredMarkers(ast.function.description) === 2,
      `strict SampleAstSearch hint must still mark only 2 real required fields, got ${countRequiredMarkers(ast.function.description)}: ${ast.function.description}`)

    const task = tools.find(tool => tool.function.name === 'TaskUpdate')!
    const taskProps = task.function.parameters.properties as Record<string, any>
    assert(Array.isArray(taskProps.subject.type) && taskProps.subject.type.includes('string') && taskProps.subject.type.includes('null'),
      `optional subject should be nullable string, got ${JSON.stringify(taskProps.subject.type)}`)
    assert(taskProps.metadata.additionalProperties === false,
      `metadata.additionalProperties=${JSON.stringify(taskProps.metadata.additionalProperties)}`)
    assert(countRequiredMarkers(task.function.description) === 1,
      `strict TaskUpdate hint must still mark only 1 real required field, got ${countRequiredMarkers(task.function.description)}`)
  })

  test('detects empty Cline tool args before local execution', () => {
    const providerTools = [
      {
        name: 'Bash',
        description: 'Run shell',
        input_schema: {
          type: 'object',
          required: ['command'],
          properties: {
            command: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      {
        name: 'TaskCreate',
        description: 'Create task',
        input_schema: {
          type: 'object',
          required: ['subject', 'description'],
          properties: {
            subject: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    ] as any

    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_1',
          name: 'Bash',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{}',
        },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'call_2',
          name: 'TaskCreate',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: '{}',
        },
      },
      { type: 'content_block_stop', index: 1 },
    ] as any

    const required = buildClineRequiredParamMap(providerTools)
    const invalid = findClineToolCallsMissingRequiredArgs(events, required)
    assert(invalid.length === 2, `invalid length=${invalid.length}`)
    assert(invalid[0]?.toolName === 'Bash', `first tool=${invalid[0]?.toolName}`)
    assert(invalid[0]?.missing.join(',') === 'command',
      `Bash missing=${invalid[0]?.missing.join(',')}`)
    assert(invalid[1]?.toolName === 'TaskCreate', `second tool=${invalid[1]?.toolName}`)
    assert(invalid[1]?.missing.join(',') === 'subject,description',
      `TaskCreate missing=${invalid[1]?.missing.join(',')}`)

    const schemaByTool = buildClineToolSchemaMap(providerTools)
    const repair = buildClineToolArgRepairMessage(invalid, 1, schemaByTool)
    assert(typeof repair.content === 'string' && repair.content.includes('Do not send empty {}'),
      `repair content=${repair.content}`)
    assert(typeof repair.content === 'string' && repair.content.includes('"command"'),
      `repair missing command=${repair.content}`)
    // Enriched repair must spell out the concrete expected shape, not just "missing X".
    assert(typeof repair.content === 'string' && repair.content.includes('command: string REQUIRED'),
      `repair should list expected parameters: ${repair.content}`)
    assert(typeof repair.content === 'string' && repair.content.includes('Minimal valid call'),
      `repair should include a minimal example: ${repair.content}`)
    assert(typeof repair.content === 'string' && /Minimal valid call: \{"subject":/.test(repair.content),
      `repair example should include required subject key: ${repair.content}`)

    const blocked = buildClineBlockedInvalidToolCallText(invalid)
    assert(blocked.includes('blocked them before local execution'),
      `blocked text should explain execution was prevented: ${blocked}`)
    assert(blocked.includes('No local tool was run with empty arguments.'),
      `blocked text should confirm no empty local execution: ${blocked}`)
  })

  test('blocks Cline calls for tools whose schema was not declared', () => {
    const providerTools = [
      {
        name: 'Bash',
        description: 'Run shell',
        input_schema: {
          type: 'object',
          required: ['command'],
          properties: {
            command: { type: 'string' },
          },
        },
      },
    ] as any

    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_1',
          name: 'SampleNavigate',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{}',
        },
      },
      { type: 'content_block_stop', index: 0 },
    ] as any

    const required = buildClineRequiredParamMap(providerTools)
    const invalid = findClineToolCallsMissingRequiredArgs(events, required, {
      knownToolNames: new Set(required.keys()),
    })

    assert(invalid.length === 1, `invalid length=${invalid.length}`)
    assert(invalid[0]?.toolName === 'SampleNavigate', `tool=${invalid[0]?.toolName}`)
    assert(invalid[0]?.reason === 'schema_not_sent', `reason=${invalid[0]?.reason}`)
    assert(invalid[0]?.missing.length === 0,
      `schema-not-sent calls should not fake missing args: ${invalid[0]?.missing.join(',')}`)

    const repair = buildClineToolArgRepairMessage(
      invalid,
      1,
      buildClineToolSchemaMap(providerTools),
    )
    assert(typeof repair.content === 'string' && repair.content.includes('schema was not declared'),
      `repair should explain schema-not-declared calls: ${repair.content}`)
    assert(typeof repair.content === 'string' && repair.content.includes('ToolSearch'),
      `repair should tell Cline how to load deferred schemas: ${repair.content}`)

    const blocked = buildClineBlockedInvalidToolCallText(invalid)
    assert(blocked.includes('schema was not declared in the current Cline request'),
      `blocked should preserve schema-not-declared reason: ${blocked}`)
    assert(blocked.includes('No local tool was run with empty arguments.'),
      `blocked should confirm local execution was prevented: ${blocked}`)
  })

  test('normalizes JSON-string structured Cline args before local validation', () => {
    const providerTools = [
      {
        name: 'SampleZoom',
        description: 'Zoom symbols',
        input_schema: {
          type: 'object',
          properties: {
            targets: {
              anyOf: [
                {
                  type: 'object',
                  required: ['filePath', 'symbol'],
                  properties: {
                    filePath: { type: 'string' },
                    symbol: { type: 'string' },
                  },
                },
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['filePath', 'symbol'],
                    properties: {
                      filePath: { type: 'string' },
                      symbol: { type: 'string' },
                    },
                  },
                },
              ],
            },
            symbols: {
              anyOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
            contextLines: { type: 'integer' },
          },
        },
      },
    ] as any

    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_1',
          name: 'SampleZoom',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"targets":"[{\\"filePath\\":\\"ml/data.py\\",\\"symbol\\":\\"load_gold\\"}]","symbols":"[\\"PowerPredictor\\"]","contextLines":"3"}',
        },
      },
      { type: 'content_block_stop', index: 0 },
    ] as any

    const normalized = normalizeClineToolCallArgumentEvents(events, providerTools)
    const delta = normalized.find(event => event.type === 'content_block_delta') as any
    const parsed = JSON.parse(delta.delta.partial_json) as Record<string, any>

    assert(Array.isArray(parsed.targets), `targets should be array: ${JSON.stringify(parsed.targets)}`)
    assert(parsed.targets[0]?.filePath === 'ml/data.py',
      `filePath=${String(parsed.targets[0]?.filePath)}`)
    assert(Array.isArray(parsed.symbols) && parsed.symbols[0] === 'PowerPredictor',
      `symbols=${JSON.stringify(parsed.symbols)}`)
    assert(parsed.contextLines === 3, `contextLines=${String(parsed.contextLines)}`)

    const required = buildClineRequiredParamMap(providerTools)
    const invalid = findClineToolCallsMissingRequiredArgs(normalized, required, {
      knownToolNames: new Set(required.keys()),
      schemaByTool: buildClineToolSchemaMap(providerTools),
    })
    assert(invalid.length === 0, `normalized args should pass Cline validation: ${JSON.stringify(invalid)}`)
  })

  test('rejects wrong typed Cline args internally before local validation', () => {
    const providerTools = [
      {
        name: 'SampleZoom',
        description: 'Zoom symbols',
        input_schema: {
          type: 'object',
          properties: {
            targets: {
              anyOf: [
                {
                  type: 'object',
                  required: ['filePath', 'symbol'],
                  properties: {
                    filePath: { type: 'string' },
                    symbol: { type: 'string' },
                  },
                },
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['filePath', 'symbol'],
                    properties: {
                      filePath: { type: 'string' },
                      symbol: { type: 'string' },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    ] as any

    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_1',
          name: 'SampleZoom',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"targets":"not json"}',
        },
      },
      { type: 'content_block_stop', index: 0 },
    ] as any

    const required = buildClineRequiredParamMap(providerTools)
    const schemaByTool = buildClineToolSchemaMap(providerTools)
    const invalid = findClineToolCallsMissingRequiredArgs(events, required, {
      knownToolNames: new Set(required.keys()),
      schemaByTool,
    })

    assert(invalid.length === 1, `invalid length=${invalid.length}`)
    assert(invalid[0]?.reason === 'invalid_arguments', `reason=${invalid[0]?.reason}`)
    assert(invalid[0]?.problems?.join('; ').includes('targets'),
      `problems=${invalid[0]?.problems?.join('; ')}`)

    const repair = buildClineToolArgRepairMessage(invalid, 1, schemaByTool)
    assert(typeof repair.content === 'string' && repair.content.includes('declared types'),
      `repair should mention declared types: ${repair.content}`)
  })

  test('strips strict-mode optional nulls before local tool validation', () => {
    const providerTools = [
      {
        name: 'TaskUpdate',
        description: 'Update task',
        input_schema: {
          type: 'object',
          required: ['taskId'],
          properties: {
            taskId: { type: 'string' },
            subject: { type: 'string' },
            metadata: {
              type: 'object',
              additionalProperties: {},
            },
          },
        },
      },
    ] as any

    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_1',
          name: 'TaskUpdate',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"taskId":"task-1","subject":null,"metadata":{"removeMe":null}}',
        },
      },
      { type: 'content_block_stop', index: 0 },
    ] as any

    const normalized = normalizeClineToolCallArgumentEvents(events, providerTools)
    const delta = normalized.find(event => event.type === 'content_block_delta') as any
    const parsed = JSON.parse(delta.delta.partial_json) as Record<string, unknown>

    assert(parsed.taskId === 'task-1', `taskId=${String(parsed.taskId)}`)
    assert(!('subject' in parsed), `subject should be stripped: ${JSON.stringify(parsed)}`)
    assert(JSON.stringify(parsed.metadata) === '{"removeMe":null}',
      `metadata null must stay meaningful: ${JSON.stringify(parsed.metadata)}`)
  })

  // Root cause of the uniform empty-args failure: upstreams that return
  // tool-call `arguments` as a parsed object instead of the OpenAI-spec string.
  // The adapter concatenates it into "[object Object]" → every tool decodes {}.
  test('coerces object-form tool-call arguments to a JSON string', () => {
    const objectArgs = [
      { index: 0, id: 'c1', type: 'function', function: { name: 'Read', arguments: { file_path: '/x.ts' } } },
    ] as any
    const coerced = coerceClineToolCallArguments(objectArgs)
    const coercedArgs = coerced[0]!.function!.arguments
    assert(typeof coercedArgs === 'string',
      `arguments should be a string, got ${typeof coercedArgs}`)
    assert(coercedArgs === '{"file_path":"/x.ts"}',
      `arguments should round-trip to JSON, got ${coercedArgs}`)

    // Arrays too (rare but valid JSON args root).
    const arrArgs = [{ function: { arguments: [1, 2] } }] as any
    assert(coerceClineToolCallArguments(arrArgs)[0]!.function!.arguments === '[1,2]',
      'array arguments should serialize')

    // Well-behaved streams (string / partial fragments) must pass through
    // untouched, including empty-string and partial-JSON fragments.
    const stringArgs = [{ function: { name: 'Read', arguments: '{"file_path":' } }] as any
    const passthrough = coerceClineToolCallArguments(stringArgs)
    assert(passthrough === stringArgs, 'unchanged array should keep its reference (no realloc)')
    assert(passthrough[0]!.function!.arguments === '{"file_path":', 'string fragment must be preserved verbatim')

    // Missing/undefined arguments (name-only opening delta) untouched.
    const nameOnly = [{ function: { name: 'Read' } }] as any
    assert(coerceClineToolCallArguments(nameOnly)[0]!.function!.arguments === undefined,
      'undefined arguments should stay undefined')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
