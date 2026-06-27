/**
 * Codex lane invariants.
 *
 * Run:  bun run src/lanes/codex/codex.test.ts
 */

import { CodexApiError, codexApi } from './api.js'
import {
  buildCodexToolsFromRequest,
  codexLane,
  convertHistoryToCodex,
  extractCodexUsageMetrics,
  repairCodexToolCall,
  repairCodexToolInput,
  resolveReasoning,
  sanitizeCodexToolParametersForOpenAI,
  splitCodexSystemForCache,
  stripNullToolArguments,
  toOpenAIStrictToolParameters,
} from './loop.js'
import { assembleCodexSystemPrompt } from './prompt.js'
import { CODEX_TOOL_REGISTRY, getCodexRegistrationByNativeName } from './tools.js'
import { setOpenAIReasoningLevel } from '../../utils/model/openaiReasoning.js'

let passed = 0
let failed = 0

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

function deepContainsKey(obj: unknown, key: string): boolean {
  if (!obj || typeof obj !== 'object') return false
  if (Array.isArray(obj)) return obj.some(item => deepContainsKey(item, key))
  for (const [candidate, value] of Object.entries(obj as Record<string, unknown>)) {
    if (candidate === key) return true
    if (deepContainsKey(value, key)) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const OPENAI_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
])

function assertOpenAIStrictSchema(schema: unknown, path = 'parameters'): void {
  if (!isRecord(schema)) return

  if ('additionalProperties' in schema) {
    assert(schema.additionalProperties === false,
      `${path}.additionalProperties must be false, got ${JSON.stringify(schema.additionalProperties)}`)
  }

  const type = schema.type
  if (type !== undefined) {
    if (Array.isArray(type)) {
      assert(type.length > 0, `${path}.type must not be empty`)
      for (let i = 0; i < type.length; i++) {
        assert(typeof type[i] === 'string' && OPENAI_SCHEMA_TYPES.has(type[i]),
          `${path}.type[${i}] must be a JSON Schema type string, got ${JSON.stringify(type[i])}`)
      }
    } else {
      assert(typeof type === 'string' && OPENAI_SCHEMA_TYPES.has(type),
        `${path}.type must be a JSON Schema type string, got ${JSON.stringify(type)}`)
    }
  }

  const typeValues = Array.isArray(type) ? type : [type]
  const objectLike = typeValues.includes('object') || isRecord(schema.properties)
  if (objectLike) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : undefined
    assert(required !== undefined, `${path}.required must be supplied`)
    for (const key of Object.keys(properties)) {
      assert(required.includes(key), `${path}.required missing ${key}`)
    }
    assert(schema.additionalProperties === false,
      `${path}.additionalProperties must be false for object schemas`)
  }

  if (isRecord(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      assertOpenAIStrictSchema(child, `${path}.properties.${key}`)
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      for (let i = 0; i < schema.items.length; i++) {
        assertOpenAIStrictSchema(schema.items[i], `${path}.items[${i}]`)
      }
    } else {
      assertOpenAIStrictSchema(schema.items, `${path}.items`)
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = schema[key]
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        assertOpenAIStrictSchema(value[i], `${path}.${key}[${i}]`)
      }
    }
  }
}

async function main(): Promise<void> {
  console.log('codex lane:')

  await test('lists GPT-5.5 with reasoning support', async () => {
    const models = await codexLane.listModels()
    const model = models.find(m => m.id === 'gpt-5.5')
    assert(model, 'expected gpt-5.5 in codex model list')
    assert(model?.contextWindow === 272000, 'expected codex-main context window')
    assert(model?.tags?.includes('reasoning'), 'expected reasoning tag')
    assert(models.some(m => m.id === 'gpt-5.4'), 'expected gpt-5.4')
    assert(models.some(m => m.id === 'gpt-5.4-mini'), 'expected gpt-5.4-mini')
    assert(!models.some(m => m.id.startsWith('gpt-5.3')), 'gpt-5.3 must not be listed')
    assert(!models.some(m => m.id.startsWith('gpt-5.2')), 'gpt-5.2 must not be listed')
  })
  await test('supports gpt-5-codex', () => {
    assert(codexLane.supportsModel('gpt-5-codex'), 'expected support')
  })
  await test('supports gpt-5.5', () => {
    assert(codexLane.supportsModel('gpt-5.5'), 'expected support')
  })
  await test('supports o3-mini', () => {
    assert(codexLane.supportsModel('o3-mini'), 'expected support')
  })
  await test('supports codex-turbo', () => {
    assert(codexLane.supportsModel('codex-turbo'), 'expected support')
  })
  await test('does NOT support claude-*', () => {
    assert(!codexLane.supportsModel('claude-sonnet-4-6'), 'Claude must stay in Claude lane')
  })
  await test('does NOT support gemini-*', () => {
    assert(!codexLane.supportsModel('gemini-2.5-pro'), 'Gemini must stay in Gemini lane')
  })
  await test('does NOT support qwen-*', () => {
    assert(!codexLane.supportsModel('qwen3-coder-plus'), 'Qwen must go to Qwen lane')
  })

  await test('smallFastModel returns gpt-5.4-mini', () => {
    assert(codexLane.smallFastModel?.() === 'gpt-5.4-mini', 'expected gpt-5.4-mini')
  })
  await test('explicit xhigh reasoning reaches Responses request config', () => {
    setOpenAIReasoningLevel('xhigh')
    const reasoning = resolveReasoning({ type: 'disabled' }, 'gpt-5.5')
    assert(reasoning?.effort === 'xhigh', `expected xhigh; got ${reasoning?.effort}`)
  })

  await test('Codex history conversion skips prior thinking blocks', () => {
    const out = convertHistoryToCodex([{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'volatile hidden reasoning '.repeat(1000) },
        { type: 'text', text: 'visible answer' },
      ],
    }] as any, new Map())

    assert(!(out as any[]).some(item => item.type === 'reasoning'), 'thinking must not be replayed as reasoning input')
    assert(!JSON.stringify(out).includes('volatile hidden reasoning'), 'thinking text must stay out of prompt input')
    const message = out.find((item: any) => item.type === 'message') as any
    assert(message?.role === 'assistant', 'assistant message preserved')
    assert(message?.content?.[0]?.type === 'output_text', 'assistant text remains output_text')
    assert(message?.content?.[0]?.text === 'visible answer', 'visible assistant text preserved')
  })

  await test('tool registry has apply_patch', () => {
    const r = getCodexRegistrationByNativeName('apply_patch')
    assert(r != null, 'apply_patch missing from Codex tool registry')
  })

  await test('Codex shell exposes tracked background execution', () => {
    const shell = getCodexRegistrationByNativeName('shell')
    assert(shell != null, 'shell missing from Codex tool registry')
    const props = (shell!.nativeSchema.properties ?? {}) as Record<string, unknown>
    assert('run_in_background' in props, 'shell schema must expose run_in_background')
    assert(shell!.nativeDescription.includes('run_in_background=true'), 'shell description must steer to run_in_background')
    assert(shell!.nativeDescription.includes('echo $!'), 'shell description must warn against pid capture')
    assert(shell!.nativeDescription.includes('docker compose up -d'), 'shell description must warn against Docker detach')
    const input = shell!.adaptInput({
      command: 'npm run dev > "$TMPDIR/app.log" 2>&1',
      run_in_background: true,
    } as any) as any
    assert(input.run_in_background === true, 'adaptInput must forward run_in_background')
  })

  await test('Codex emits OpenAI-strict-compatible schemas for every native registry tool', () => {
    const providerTools = CODEX_TOOL_REGISTRY.map(reg => ({
      name: reg.implId,
      description: reg.nativeDescription,
      input_schema: reg.nativeSchema,
    }))
    const tools = buildCodexToolsFromRequest(providerTools as any) ?? []
    assert(tools.length === CODEX_TOOL_REGISTRY.length,
      `expected ${CODEX_TOOL_REGISTRY.length} native tools, got ${tools.length}`)

    for (const tool of tools) {
      if (tool.type === 'custom') {
        assert(tool.name === 'apply_patch', `unexpected custom tool ${tool.name}`)
        assert((tool as any).format?.type === 'text', 'apply_patch should keep text format')
        continue
      }
      assert(tool.type === 'function', `expected function tool, got ${tool.type}`)
      assertOpenAIStrictSchema(tool.parameters, `native.${tool.name}.parameters`)
      assert(tool.strict === true, `${tool.name} should use strict mode`)
      for (const key of ['format', 'propertyNames', 'default']) {
        assert(!deepContainsKey(tool.parameters, key), `${tool.name} ${key} leaked`)
      }
    }
  })

  await test('OpenAI strict tool schema helper accepts fully required schemas', () => {
    const out = toOpenAIStrictToolParameters({
      type: 'object',
      properties: {
        command: { type: 'string' },
        target: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            symbol: { type: 'string' },
          },
          required: ['filePath', 'symbol'],
        },
      },
      required: ['command', 'target'],
    }) as any
    assert(out != null, 'expected strict-compatible schema')
    assert(out.additionalProperties === false, 'top-level additionalProperties=false')
    assert(out.properties.target.additionalProperties === false, 'nested additionalProperties=false')
    assert(out.required.includes('command') && out.required.includes('target'), 'required preserved')
  })

  await test('OpenAI strict tool schema helper makes optional AFTAstSearch fields nullable', () => {
    const out = toOpenAIStrictToolParameters({
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        lang: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['pattern', 'lang'],
    }) as any
    assert(out !== null, 'optional paths should be encoded as nullable')
    assert(out.additionalProperties === false, 'top-level additionalProperties=false')
    assert(out.required.includes('pattern') && out.required.includes('lang'), 'original required preserved')
    assert(out.required.includes('paths'), 'OpenAI strict requires every property')
    assert(out.properties.pattern.type === 'string', 'required pattern must not become nullable')
    assert(Array.isArray(out.properties.paths.type), 'optional paths should use type array')
    assert(out.properties.paths.type.includes('array'), 'paths array type preserved')
    assert(out.properties.paths.type.includes('null'), 'optional paths should accept null')
  })

  await test('Codex OpenAI sanitizer strips WebFetch uri format without breaking strict eligibility', () => {
    const out = sanitizeCodexToolParametersForOpenAI({
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'The URL to fetch content from',
        },
        prompt: {
          type: 'string',
          description: 'The prompt to run on the fetched content',
        },
      },
      required: ['url', 'prompt'],
      additionalProperties: false,
    }) as any
    assert(out.properties.url.type === 'string', 'url string type preserved')
    assert(!('format' in out.properties.url), 'OpenAI rejects format: uri')
    assert(Array.isArray(out.required) && out.required.includes('url'), 'required preserved')
    assert(toOpenAIStrictToolParameters(out) !== null, 'sanitized WebFetch schema should be strict-compatible')
  })

  await test('Codex strips OpenAI nullable optional args before local tool validation', () => {
    const out = stripNullToolArguments({
      pattern: 'foo($$$)',
      lang: 'python',
      paths: null,
      globs: ['*.py', null],
      contextLines: null,
      nested: {
        keep: 'yes',
        drop: null,
      },
    }) as any
    assert(out.pattern === 'foo($$$)', 'required pattern preserved')
    assert(out.lang === 'python', 'required lang preserved')
    assert(!('paths' in out), 'null optional paths removed')
    assert(!('contextLines' in out), 'null optional contextLines removed')
    assert(out.globs.length === 1 && out.globs[0] === '*.py', 'null array item removed')
    assert(out.nested.keep === 'yes' && !('drop' in out.nested), 'nested null removed')
  })

  await test('Codex repairs AFTZoom targets vs filePath/symbols conflict', () => {
    const out = repairCodexToolInput('AFTZoom', {
      filePath: 'moteur_pipeline/run_pipeline.py',
      symbols: ['run_pipeline'],
      targets: [{ filePath: 'moteur_pipeline/run_pipeline.py', symbol: 'run_pipeline' }],
      contextLines: 3,
    }) as any
    assert(!('filePath' in out), 'filePath should be removed when targets is present')
    assert(!('symbols' in out), 'symbols should be removed when targets is present')
    assert(Array.isArray(out.targets) && out.targets.length === 1, 'targets should be preserved')
    assert(out.contextLines === 3, 'contextLines preserved')
  })

  await test('Codex repairs AFTDiagnostics filePath vs directory conflict', () => {
    const out = repairCodexToolInput('AFTDiagnostics', {
      filePath: 'moteur_pipeline/run_pipeline.py',
      directory: 'moteur_pipeline',
    }) as any
    assert(out.filePath === 'moteur_pipeline/run_pipeline.py', 'filePath preserved')
    assert(!('directory' in out), 'directory should be removed when filePath is present')
  })

  await test('Codex reroutes patternless AFTAstSearch to AFTOutline', () => {
    const repaired = repairCodexToolCall('AFTAstSearch', {
      lang: 'go',
      paths: ['C:\\Users\\ok\\Desktop\\CLIProxyAPI-main\\internal\\api'],
      globs: ['**/*.go'],
      contextLines: 1,
    })

    assert(repaired.toolName === 'AFTOutline',
      `toolName=${repaired.toolName}`)
    assert(repaired.input.target === 'C:\\Users\\ok\\Desktop\\CLIProxyAPI-main\\internal\\api',
      `target=${repaired.input.target}`)
    assert(!('pattern' in repaired.input), 'pattern must not be invented')
  })

  await test('Codex OpenAI sanitizer strips unsupported schema metadata recursively', () => {
    const out = sanitizeCodexToolParametersForOpenAI({
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        query: {
          type: 'string',
          pattern: '^https?://',
          default: 'https://example.com',
          examples: ['https://example.com'],
          'x-provider-note': 'strip me',
        },
        nested: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', format: 'uri' },
            },
          },
        },
      },
    })
    for (const key of ['$schema', 'pattern', 'default', 'examples', 'format', 'x-provider-note']) {
      assert(!deepContainsKey(out, key), `${key} should be stripped recursively`)
    }
  })

  await test('Codex emits OpenAI-strict-compatible schemas for failure-prone tools', () => {
    const tools = buildCodexToolsFromRequest([
      {
        name: 'TaskCreate',
        description: 'create a task',
        input_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            description: { type: 'string' },
            activeForm: { type: 'string' },
            metadata: {
              type: 'object',
              propertyNames: { type: 'string' },
              additionalProperties: {},
            },
          },
          required: ['subject', 'description'],
          additionalProperties: false,
        },
      },
      {
        name: 'TaskUpdate',
        description: 'update a task',
        input_schema: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            subject: { type: 'string' },
            metadata: {
              type: 'object',
              propertyNames: { type: 'string' },
              additionalProperties: {},
            },
          },
          required: ['taskId'],
          additionalProperties: false,
        },
      },
      {
        name: 'WebFetch',
        description: 'fetch url',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
      },
      {
        name: 'AFTAstSearch',
        description: 'ast search',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            lang: { type: 'string', enum: ['python', 'typescript'] },
            paths: { type: 'array', items: { type: 'string' } },
            globs: { type: 'array', items: { type: 'string' } },
            contextLines: { type: 'integer' },
          },
          required: ['pattern', 'lang'],
          additionalProperties: false,
        },
      },
      {
        name: 'AFTZoom',
        description: 'zoom',
        input_schema: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            symbols: {
              anyOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
            targets: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    filePath: { type: 'string' },
                    symbol: { type: 'string' },
                  },
                  required: ['filePath', 'symbol'],
                  additionalProperties: false,
                },
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      filePath: { type: 'string' },
                      symbol: { type: 'string' },
                    },
                    required: ['filePath', 'symbol'],
                    additionalProperties: false,
                  },
                },
              ],
            },
            contextLines: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
    ] as any) ?? []

    assert(tools.length === 5, `expected 5 tools, got ${tools.length}`)
    for (const tool of tools) {
      assert(tool.type === 'function', `expected function tool, got ${tool.type}`)
      if (tool.type !== 'function') continue
      assert(tool.strict === true, `${tool.name} should use strict mode`)
      assertOpenAIStrictSchema(tool.parameters, `tools.${tool.name}.parameters`)
      assert(!deepContainsKey(tool.parameters, 'format'), `${tool.name} format leaked`)
      assert(!deepContainsKey(tool.parameters, 'propertyNames'), `${tool.name} propertyNames leaked`)
      assert(!deepContainsKey(tool.parameters, 'default'), `${tool.name} default leaked`)
    }
    const ast = tools.find(tool => tool.type === 'function' && tool.name === 'AFTAstSearch') as any
    assert(ast?.parameters?.properties?.pattern?.type === 'string',
      'AFTAstSearch pattern property must survive schema sanitization')
    assert(ast.parameters.required.includes('pattern'),
      'AFTAstSearch required must include pattern')
  })

  await test('Codex strict schema compiler handles common tool schema shapes', () => {
    const schemas: Record<string, Record<string, unknown>> = {
      NoArgs: { type: 'object', properties: {}, required: [], additionalProperties: false },
      EnumOptionals: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['read', 'write'] },
          count: { type: 'integer' },
        },
        required: ['mode'],
      },
      NestedObject: {
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              label: { type: 'string' },
            },
            required: ['enabled'],
          },
        },
        required: ['config'],
      },
      ArrayOfObjects: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', pattern: '^/' },
                metadata: { type: 'object', additionalProperties: {} },
              },
              required: ['path'],
            },
          },
        },
        required: ['items'],
      },
      AnyOfUnion: {
        type: 'object',
        properties: {
          value: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      },
      MalformedTypeArray: {
        type: 'object',
        properties: {
          value: {
            type: [
              { type: 'object', additionalProperties: {} },
              'null',
            ],
          },
        },
      },
    }

    const providerTools = Object.entries(schemas).map(([name, input_schema]) => ({
      name,
      description: `${name} fixture`,
      input_schema,
    }))
    const tools = buildCodexToolsFromRequest(providerTools as any) ?? []
    assert(tools.length === providerTools.length,
      `expected ${providerTools.length} tools, got ${tools.length}`)

    for (const tool of tools) {
      assert(tool.type === 'function', `expected function tool, got ${tool.type}`)
      if (tool.type !== 'function') continue
      assert(tool.strict === true, `${tool.name} should use strict mode`)
      assertOpenAIStrictSchema(tool.parameters, `fixture.${tool.name}.parameters`)
      assert(!deepContainsKey(tool.parameters, 'pattern'), `${tool.name} pattern leaked`)
      assert(!deepContainsKey(tool.parameters, 'additionalProperties') ||
        JSON.stringify(tool.parameters).includes('"additionalProperties":false'),
        `${tool.name} has non-false additionalProperties`)
    }
  })

  await test('stable slot byte-identical across turns when volatile changes', () => {
    const base = { toolsAddendum: '', mcpIntro: '', skillsContext: '', customInstructions: 'c' }
    const t1 = assembleCodexSystemPrompt('gpt-5-codex', {
      ...base, memory: 'a', environment: 'e1', gitStatus: 'g1',
    })
    const t2 = assembleCodexSystemPrompt('gpt-5-codex', {
      ...base, memory: 'b', environment: 'e2', gitStatus: 'g2',
    })
    assert(String(t1.stable) === String(t2.stable), 'stable drifted between turns')
    assert(String(t1.volatile) !== String(t2.volatile), 'volatile should differ')
  })
  await test('apply_patch mentioned in stable preamble', () => {
    const p = assembleCodexSystemPrompt('gpt-5-codex', {
      memory: '', environment: '', gitStatus: '',
      toolsAddendum: '', mcpIntro: '', skillsContext: '', customInstructions: '',
    })
    assert(String(p.stable).includes('apply_patch'),
      'codex system prompt should call out apply_patch as the edit primitive')
  })

  await test('CodexApiError detects context_length_exceeded as prompt-too-long', () => {
    const err = new CodexApiError(400, JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'maximum context length 128000' },
    }))
    assert(err.isPromptTooLong, 'context_length_exceeded should be classified as PTL')
    assert(err.message.startsWith('Prompt is too long'),
      `message should lead with PTL prefix; got: ${err.message.slice(0, 60)}`)
  })
  await test('CodexApiError non-PTL error has normal prefix', () => {
    const err = new CodexApiError(500, 'internal server error')
    assert(!err.isPromptTooLong, 'should not classify 500 as PTL')
    assert(err.message.startsWith('OpenAI Responses API error'),
      `got: ${err.message.slice(0, 60)}`)
  })
  await test('CodexApiError 429 is retryable, 400 is not', () => {
    assert(new CodexApiError(429, '').isRetryable, '429 should be retryable')
    assert(!new CodexApiError(400, '').isRetryable, '400 should NOT be retryable')
  })

  await test('extractCodexUsageMetrics reads Responses cached tokens', () => {
    const usage = extractCodexUsageMetrics({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 640 },
      output_tokens: 12,
      output_tokens_details: { reasoning_tokens: 3 },
    })
    assert(usage.inputTokens === 1000, `input=${usage.inputTokens}`)
    assert(usage.outputTokens === 12, `output=${usage.outputTokens}`)
    assert(usage.cacheReadTokens === 640, `cacheRead=${usage.cacheReadTokens}`)
    assert(usage.reasoningTokens === 3, `reasoning=${usage.reasoningTokens}`)
  })

  await test('extractCodexUsageMetrics reads Chat-style cached tokens', () => {
    const usage = extractCodexUsageMetrics({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 512 },
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 4 },
    })
    assert(usage.inputTokens === 1000, `input=${usage.inputTokens}`)
    assert(usage.outputTokens === 20, `output=${usage.outputTokens}`)
    assert(usage.cacheReadTokens === 512, `cacheRead=${usage.cacheReadTokens}`)
    assert(usage.reasoningTokens === 4, `reasoning=${usage.reasoningTokens}`)
  })

  await test('extractCodexUsageMetrics prefers explicit native cache usage over zero cached_tokens', () => {
    const usage = extractCodexUsageMetrics({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 0 },
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 100,
      output_tokens: 10,
    })
    assert(usage.cacheReadTokens === 700, `cacheRead=${usage.cacheReadTokens}`)
    assert(usage.cacheWriteTokens === 100, `cacheWrite=${usage.cacheWriteTokens}`)
  })

  // ── splitCodexSystemForCache: cache-stability invariants ─────────
  // These guard the surgical fix for "cache hits but is unstable" on
  // tool-heavy / model-swap sessions. The Responses API hashes the
  // `instructions` field as part of the prompt-cache prefix; if env /
  // git / memory bytes leak in, every turn's hash drifts and the cache
  // misses past the first divergence.

  await test('splitCodexSystemForCache splits at SYSTEM_PROMPT_DYNAMIC_BOUNDARY', () => {
    const text = 'STATIC PREAMBLE\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\nDYNAMIC TAIL'
    const { stable, volatile } = splitCodexSystemForCache(text)
    assert(stable === 'STATIC PREAMBLE', `stable=${JSON.stringify(stable)}`)
    assert(volatile === 'DYNAMIC TAIL', `volatile=${JSON.stringify(volatile)}`)
  })

  await test('splitCodexSystemForCache: stable bytes identical across env-only churn', () => {
    // Simulate a long static preamble (so the 70%-tail cutoff is well
    // past the static section) followed by an env block whose
    // timestamp / git status changes turn-to-turn.
    const preamble = 'You are Codex.\n'.repeat(200)
    const env1 = '<env>\nWorking directory: /a\nDate: 2026-05-04T12:00:00Z\n</env>'
    const env2 = '<env>\nWorking directory: /a\nDate: 2026-05-04T12:05:33Z\n</env>'
    const a = splitCodexSystemForCache(preamble + env1)
    const b = splitCodexSystemForCache(preamble + env2)
    assert(a.stable === b.stable, 'stable drifted across env-only change')
    assert(a.volatile !== b.volatile, 'volatile should differ')
    assert(!a.stable.includes('<env>'), 'env leaked into stable slot')
  })

  await test('splitCodexSystemForCache: stable byte-stable across git status churn', () => {
    const preamble = '# Codex preamble\n'.repeat(200)
    const tail1 = '# gitStatus\nbranch: main · clean'
    const tail2 = '# gitStatus\nbranch: main · 1 modified'
    const a = splitCodexSystemForCache(`${preamble}\n${tail1}`)
    const b = splitCodexSystemForCache(`${preamble}\n${tail2}`)
    assert(a.stable === b.stable, 'stable drifted on git status flip')
    assert(a.volatile !== b.volatile, 'volatile should reflect git delta')
  })

  await test('splitCodexSystemForCache: no-volatile input passes through', () => {
    const text = 'Just a static prompt with no env or git markers anywhere.'
    const { stable, volatile } = splitCodexSystemForCache(text)
    assert(stable === text, 'stable should equal full text')
    assert(volatile === '', `volatile should be empty; got ${JSON.stringify(volatile)}`)
  })

  await test('splitCodexSystemForCache: empty input returns empty pair', () => {
    const { stable, volatile } = splitCodexSystemForCache('')
    assert(stable === '', `stable=${JSON.stringify(stable)}`)
    assert(volatile === '', `volatile=${JSON.stringify(volatile)}`)
  })

  await test('splitCodexSystemForCache: env mention in prompt body (head 70%) is NOT volatile', () => {
    // A tool description in the middle of the prompt mentions <env>;
    // we must not strip it just because the substring matches.
    const head = '<env>\nfake context\n</env>\n' + 'X'.repeat(5000)
    const { stable, volatile } = splitCodexSystemForCache(head)
    assert(stable === head, 'should leave head-occurring matches alone')
    assert(volatile === '', 'no volatile expected from head-region match')
  })

  // ── Frozen volatile anchor: input[0] byte-stability ──────────────
  // The leading dev-message anchor must keep emitting identical bytes
  // every turn for the prompt-cache prefix to land on a warm chunk.
  // These tests pin the seed/return semantics independent of any
  // network call.

  await test('frozen volatile anchor: first call seeds and returns input', () => {
    codexApi.clearChain()
    const out = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-A')
    assert(out === 'env-A', `seed result; got ${JSON.stringify(out)}`)
  })

  await test('frozen volatile anchor: second call returns the seeded copy', () => {
    codexApi.clearChain()
    codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-A')
    const out = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-B-DIFFERENT')
    assert(out === 'env-A', `should return seeded; got ${JSON.stringify(out)}`)
  })

  await test('frozen volatile anchor: per-model isolation', () => {
    codexApi.clearChain()
    codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-for-5.4')
    const out = codexApi.getOrSeedFrozenVolatile('gpt-5-codex', 'env-for-codex')
    assert(out === 'env-for-codex', `model swap should seed fresh; got ${JSON.stringify(out)}`)
    const replay = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-for-5.4-V2')
    assert(replay === 'env-for-5.4', `original model anchor stays put; got ${JSON.stringify(replay)}`)
  })

  await test('frozen volatile anchor: clearChain wipes the map', () => {
    codexApi.clearChain()
    codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-A')
    codexApi.clearChain()
    const out = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-B')
    assert(out === 'env-B', `clearChain should re-seed on next call; got ${JSON.stringify(out)}`)
  })

  await test('session cache key adopts Tau session id and clears volatile anchors on change', () => {
    codexApi.clearChain()
    codexApi.setSessionCacheKey('tau-session-a')
    assert(codexApi.sessionCacheKey === 'tau-session-a', 'expected Tau session id as cache key')
    codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-A')
    codexApi.setSessionCacheKey('tau-session-b')
    assert(codexApi.sessionCacheKey === 'tau-session-b', 'expected cache key switch')
    const out = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-B')
    assert(out === 'env-B', `session switch should clear volatile anchor; got ${JSON.stringify(out)}`)
  })

  await test('frozen volatile anchor: empty input is a no-op (returns empty)', () => {
    codexApi.clearChain()
    const out = codexApi.getOrSeedFrozenVolatile('gpt-5.4', '')
    assert(out === '', `empty input should return empty; got ${JSON.stringify(out)}`)
    // And shouldn't have seeded — a later non-empty call should win.
    const seeded = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'real-env')
    assert(seeded === 'real-env', `empty seed must not block real seed; got ${JSON.stringify(seeded)}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
