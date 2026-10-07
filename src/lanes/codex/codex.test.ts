/**
 * Codex lane invariants.
 *
 * Run:  bun run src/lanes/codex/codex.test.ts
 */

import { CodexApiError, codexApi, FROZEN_VOLATILE_SESSION_LIMIT } from './api.js'
import {
  buildCodexToolsFromRequest,
  codexLane,
  convertHistoryToCodex,
  extractCodexUsageMetrics,
  freezeCodexToolOrder,
  repairCodexToolInput,
  resolveReasoning,
  sanitizeCodexToolParametersForOpenAI,
  splitCodexSystemForCache,
  stripNullToolArguments,
} from './loop.js'
import { assembleCodexSystemPrompt } from './prompt.js'
import { CODEX_TOOL_REGISTRY, getCodexRegistrationByNativeName } from './tools.js'
import { findCodexToolSchemaViolations } from './tool_schema.js'
import {
  cycleOpenAIReasoningLevel,
  getAllReasoningLevels,
  getReasoningLabel,
  setOpenAIReasoningLevel,
} from '../../utils/model/openaiReasoning.js'

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

async function main(): Promise<void> {
  console.log('codex lane:')

  await test('lists the GPT-6 and GPT-5.6 families with models.dev metadata', async () => {
    const models = await codexLane.listModels()
    const expected = [
      ['gpt-6-sol', 'GPT-6 Sol'],
      ['gpt-6-astra', 'GPT-6 Astra'],
      ['gpt-6-luna', 'GPT-6 Luna'],
      ['gpt-5.6-sol', 'GPT-5.6 Sol'],
      ['gpt-5.6-terra', 'GPT-5.6 Terra'],
      ['gpt-5.6-luna', 'GPT-5.6 Luna'],
    ] as const
    assert(models.length === expected.length, `expected ${expected.length} models, got ${models.map(m => m.id).join(', ')}`)
    for (const [id, name] of expected) {
      const model = models.find(candidate => candidate.id === id)
      assert(model, `expected ${id} in codex model list`)
      assert(model?.name === name, `expected official ${id} display name`)
      assert(model?.contextWindow === 1050000, `expected 1.05M context for ${id}`)
      assert(model?.tags?.includes('reasoning'), `expected reasoning tag for ${id}`)
    }
    assert(models.find(m => m.id === 'gpt-6-sol')?.tags?.includes('recommended'), 'GPT-6 Sol should be recommended')
    assert(models.filter(m => m.tags?.includes('recommended')).length === 1, 'one recommended row')
    for (const gone of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']) {
      assert(!models.some(m => m.id === gone), `${gone} must no longer be listed`)
    }
    assert(!models.some(m => m.id.startsWith('gpt-5.3')), 'gpt-5.3 must not be listed')
    assert(!models.some(m => m.id.startsWith('gpt-5.2')), 'gpt-5.2 must not be listed')
    // listModels hands out copies: a caller editing tags cannot change the catalog.
    ;(models[0]!.tags as string[]).push('free')
    assert(!(await codexLane.listModels())[0]!.tags!.includes('free'), 'catalog was mutated through listModels')
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

  await test('smallFastModel returns gpt-5.6-luna (ChatGPT accounts refuse gpt-5.4-mini)', () => {
    assert(codexLane.smallFastModel?.() === 'gpt-5.6-luna', `got ${codexLane.smallFastModel?.()}`)
  })
  await test('explicit xhigh reasoning reaches Responses request config', () => {
    setOpenAIReasoningLevel('xhigh')
    const reasoning = resolveReasoning({ type: 'disabled' }, 'gpt-5.5')
    assert(reasoning?.effort === 'xhigh', `expected xhigh; got ${reasoning?.effort}`)
  })
  await test('GPT-6 models get reasoning, and Low through Ultra', () => {
    setOpenAIReasoningLevel('high')
    for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra']) {
      assert(getAllReasoningLevels(model).join(',') === 'low,medium,high,xhigh,max', `${model} levels`)
      const reasoning = resolveReasoning({ type: 'disabled' }, model)
      assert(reasoning?.effort === 'high', `${model} must carry the chosen effort, got ${JSON.stringify(reasoning)}`)
    }
    assert(resolveReasoning({ type: 'adaptive' } as any, 'gpt-6-sol') !== undefined, 'GPT-6 is reasoning-capable')
  })
  await test('GPT-5.6 exposes Ultra while sending the official max effort', () => {
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'openai/gpt-6-astra']) {
      assert(getAllReasoningLevels(model).at(-1) === 'max', `${model} should expose max`)
    }
    for (const model of ['gpt-5.5', 'gpt-5.2', 'gpt-5.1-codex-max']) {
      assert(getAllReasoningLevels(model).at(-1) === 'xhigh', `${model} should stop at xhigh`)
    }
    for (const model of ['gpt-5', 'gpt-5-codex', 'gpt-5.1', 'o3']) {
      assert(getAllReasoningLevels(model).at(-1) === 'high', `${model} should stop at high`)
    }
    setOpenAIReasoningLevel('xhigh')
    const selected = cycleOpenAIReasoningLevel('right', 'gpt-5.6-sol')
    assert(selected === 'max', `expected max; got ${selected}`)
    assert(getReasoningLabel(selected) === 'Ultra', 'max should render as Ultra')
    assert(resolveReasoning({ type: 'disabled' }, 'gpt-5.6-sol')?.effort === 'max', '5.6 should send max')
    assert(resolveReasoning({ type: 'disabled' }, 'gpt-5.5')?.effort === 'xhigh', 'older models should clamp max to xhigh')
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

  await test('Codex file search can include ignored files, as Glob can', () => {
    const search = getCodexRegistrationByNativeName('search_files')
    assert(search?.implId === 'Glob', 'search_files must map to Glob')
    const props = (search!.nativeSchema.properties ?? {}) as Record<string, unknown>
    assert('include_ignored' in props, 'search_files schema must expose include_ignored')
    const input = search!.adaptInput({ pattern: '**/*.py', include_ignored: true } as any) as any
    assert(input.include_ignored === true, 'adaptInput must forward include_ignored')
    const plain = search!.adaptInput({ pattern: '**/*.py' } as any) as any
    assert(!('include_ignored' in plain), 'an omitted include_ignored stays omitted')
    const code = getCodexRegistrationByNativeName('search_code')
    assert(code?.implId === 'Grep', 'search_code must map to Grep')
    assert('include_ignored' in ((code!.nativeSchema.properties ?? {}) as Record<string, unknown>), 'search_code schema must expose include_ignored')
    const grep = code!.adaptInput({ pattern: 'x', include: '*.py', include_ignored: true } as any) as any
    assert(grep.include_ignored === true && grep.glob === '*.py', 'search_code must forward include_ignored and include')
    // Without an output mode a model could never see the matching lines.
    assert('output_mode' in ((code!.nativeSchema.properties ?? {}) as Record<string, unknown>), 'search_code schema must expose output_mode')
    const lines = code!.adaptInput({ pattern: 'x', output_mode: 'content' } as any) as any
    assert(lines.output_mode === 'content', 'search_code must forward output_mode')
    assert(!('output_mode' in (code!.adaptInput({ pattern: 'x' } as any) as any)), 'no output_mode keeps the shared default')
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

  await test('Codex sends every native registry tool non-strict with its own schema, as native Codex does', () => {
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
      assert(tool.strict === false, `${tool.name} strict=${tool.strict}`)
      const violations = findCodexToolSchemaViolations(tool.parameters)
      assert(violations.length === 0, `${tool.name}: ${violations.join(' | ')}`)
      const reg = CODEX_TOOL_REGISTRY.find(r => r.nativeName === tool.name)!
      assert(JSON.stringify(tool.parameters.required ?? []) === JSON.stringify(reg.nativeSchema.required ?? []),
        `${tool.name} required list changed: ${JSON.stringify(tool.parameters.required)}`)
      for (const key of ['format', 'propertyNames', 'default']) {
        assert(!deepContainsKey(tool.parameters, key), `${tool.name} ${key} leaked`)
      }
    }
  })

  await test('optional fields stay optional on the wire (no all-required, no nullable rewrite)', () => {
    const tools = buildCodexToolsFromRequest([{
      name: 'SampleAstSearch',
      description: 'ast search',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          lang: { type: 'string', enum: ['python', 'typescript'] },
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['pattern'],
      },
    }] as any) ?? []
    const out = (tools[0] as any).parameters
    assert(JSON.stringify(out.required) === '["pattern"]', `required=${JSON.stringify(out.required)}`)
    assert(out.properties.paths.type === 'array', 'optional paths is not made nullable')
    assert(JSON.stringify(out.properties.lang.enum) === '["python","typescript"]', 'optional enum gains no null')
    assert(!('additionalProperties' in out), 'no additionalProperties is invented')
  })

  await test('Codex OpenAI sanitizer strips WebFetch uri format', () => {
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
    assert(findCodexToolSchemaViolations(out).length === 0, 'sanitized WebFetch schema passes the backend check')
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
        name: 'SampleAstSearch',
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
        name: 'SampleZoom',
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
      assert(tool.strict === false, `${tool.name} strict=${tool.strict}`)
      const violations = findCodexToolSchemaViolations(tool.parameters)
      assert(violations.length === 0, `${tool.name}: ${violations.join(' | ')}`)
      assert(!deepContainsKey(tool.parameters, 'format'), `${tool.name} format leaked`)
      assert(!deepContainsKey(tool.parameters, 'propertyNames'), `${tool.name} propertyNames leaked`)
      assert(!deepContainsKey(tool.parameters, 'default'), `${tool.name} default leaked`)
    }
    const task = tools.find(tool => tool.type === 'function' && tool.name === 'TaskCreate') as any
    assert(JSON.stringify(task.parameters.properties.metadata) === '{"type":"object","additionalProperties":{}}',
      `TaskCreate metadata must stay a map: ${JSON.stringify(task.parameters.properties.metadata)}`)
    assert(JSON.stringify(task.parameters.required) === '["subject","description"]', 'the real required list is kept')
    const ast = tools.find(tool => tool.type === 'function' && tool.name === 'SampleAstSearch') as any
    assert(ast?.parameters?.properties?.pattern?.type === 'string',
      'SampleAstSearch pattern property must survive schema sanitization')
    assert(ast.parameters.required.includes('pattern'),
      'SampleAstSearch required must include pattern')
  })

  await test('tool order stays stable per conversation: late tools are appended, every request shares it', () => {
    const fn = (name: string, extra: Record<string, unknown> = {}) => ({
      type: 'function' as const, name, description: `${name} tool`,
      parameters: { type: 'object', properties: { q: { type: 'string' }, ...extra } }, strict: false,
    })
    const key = `order-test-${Date.now()}`
    const first = [fn('Bash'), fn('Read'), fn('mcp__playwright__click')]
    assert(freezeCodexToolOrder(key, first).map(t => t.name).join() === 'Bash,Read,mcp__playwright__click', 'first request keeps its order')
    // A claude.ai connector connects: it sorts before playwright.
    const second = [fn('Bash'), fn('Read'), fn('mcp__claude_ai_Docs__read'), fn('mcp__playwright__click')]
    assert(freezeCodexToolOrder(key, second).map(t => t.name).join() === 'Bash,Read,mcp__playwright__click,mcp__claude_ai_Docs__read',
      'a late tool goes to the end so the earlier prefix stays byte-identical')
    // A removed tool is dropped, a changed contract replaced in place, a
    // description-only change keeps the first declaration.
    const changed = { ...fn('Read', { limit: { type: 'integer' } }) }
    const reworded = { ...fn('Bash'), description: 'Bash tool, reworded' }
    const third = freezeCodexToolOrder(key, [reworded, changed, fn('mcp__claude_ai_Docs__read')])
    assert(third.map(t => t.name).join() === 'Bash,Read,mcp__claude_ai_Docs__read', `order ${third.map(t => t.name).join()}`)
    assert((third[1] as any).parameters.properties.limit, 'a changed contract is sent')
    assert((third[0] as any).description === 'Bash tool', 'an unchanged contract keeps its first description')
    // Every request on the conversation shares the order: one with fewer
    // tools sends them in that order and leaves the rest alone.
    const subset = freezeCodexToolOrder(key, [fn('mcp__claude_ai_Docs__read'), fn('Bash')])
    assert(subset.map(t => t.name).join() === 'Bash,mcp__claude_ai_Docs__read', `subset order ${subset.map(t => t.name).join()}`)
    // The dropped server comes back to its old slot: the block is the one the
    // conversation sent before it dropped.
    const back = freezeCodexToolOrder(key, [reworded, changed, fn('mcp__claude_ai_Docs__read'), fn('mcp__playwright__click')])
    assert(back.map(t => t.name).join() === 'Bash,Read,mcp__playwright__click,mcp__claude_ai_Docs__read', `order after return ${back.map(t => t.name).join()}`)
    // A helper forked from the conversation lists the tools in Tau's sorted
    // order; it still sends the conversation's block byte for byte.
    const forked = freezeCodexToolOrder(key, [fn('Bash'), changed, fn('mcp__claude_ai_Docs__read'), fn('mcp__playwright__click')])
    assert(JSON.stringify(forked) === JSON.stringify(back), 'a forked helper resends the conversation tool block')
    // Another conversation keeps an order of its own.
    const other = freezeCodexToolOrder(`${key}-other`, [fn('Read'), fn('Bash')])
    assert(other.map(t => t.name).join() === 'Read,Bash', 'conversations do not share an order')
  })

  await test('Codex tool schemas handle common tool schema shapes', () => {
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
      assert(tool.strict === false, `${tool.name} strict=${tool.strict}`)
      const violations = findCodexToolSchemaViolations(tool.parameters)
      assert(violations.length === 0, `${tool.name}: ${violations.join(' | ')}`)
      assert(!deepContainsKey(tool.parameters, 'pattern'), `${tool.name} pattern leaked`)
      const source = schemas[tool.name]!
      assert(JSON.stringify(tool.parameters.required) === JSON.stringify(source.required),
        `${tool.name} required list changed: ${JSON.stringify(tool.parameters.required)}`)
    }
    const arrays = tools.find(tool => tool.name === 'ArrayOfObjects') as any
    assert(JSON.stringify(arrays.parameters.properties.items.items.properties.metadata) === '{"type":"object","additionalProperties":{}}',
      'a free-form map is sent as itself')
    const malformed = tools.find(tool => tool.name === 'MalformedTypeArray') as any
    assert(JSON.stringify(malformed.parameters.properties.value.type) === '["object","null"]',
      'a type list with a schema entry keeps the types it names')
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

  await test('session cache key isolates and restores volatile anchors across side requests', () => {
    codexApi.clearChain()
    codexApi.setSessionCacheKey('tau-session-a')
    assert(codexApi.sessionCacheKey === 'tau-session-a', 'expected Tau session id as cache key')
    codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-A')
    codexApi.setSessionCacheKey('tau-session-b')
    assert(codexApi.sessionCacheKey === 'tau-session-b', 'expected cache key switch')
    const side = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'report-env')
    assert(side === 'report-env', `side session should seed independently; got ${JSON.stringify(side)}`)
    codexApi.setSessionCacheKey('tau-session-a')
    const restored = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'env-A-CHANGED')
    assert(restored === 'env-A', `live session anchor was not restored; got ${JSON.stringify(restored)}`)
  })

  await test('a session used every turn keeps its anchor while subagent sessions come and go', () => {
    codexApi.clearChain()
    codexApi.setSessionCacheKey('tau-main')
    codexApi.getOrSeedFrozenVolatile('gpt-6-sol', 'main-env')
    for (let i = 0; i < FROZEN_VOLATILE_SESSION_LIMIT * 3; i++) {
      codexApi.setSessionCacheKey(`tau-agent-${i}`)
      codexApi.getOrSeedFrozenVolatile('gpt-5.6-luna', `agent-env-${i}`)
      if (i % 10 === 0) {
        codexApi.setSessionCacheKey('tau-main')
        const main = codexApi.getOrSeedFrozenVolatile('gpt-6-sol', `main-env-changed-${i}`)
        assert(main === 'main-env', `main anchor was evicted after ${i} agents: ${JSON.stringify(main)}`)
      }
    }
    // A resumed subagent that is still in the store replays its own anchor.
    const last = FROZEN_VOLATILE_SESSION_LIMIT * 3 - 1
    codexApi.setSessionCacheKey(`tau-agent-${last}`)
    const replay = codexApi.getOrSeedFrozenVolatile('gpt-5.6-luna', 'agent-env-changed')
    assert(replay === `agent-env-${last}`, `resumed agent anchor changed: ${JSON.stringify(replay)}`)
  })

  await test('frozen volatile anchors evict oldest sessions instead of growing', () => {
    codexApi.clearChain()
    codexApi.setSessionCacheKey('tau-session-oldest')
    codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'oldest-env')
    for (let i = 0; i < FROZEN_VOLATILE_SESSION_LIMIT + 8; i++) {
      codexApi.setSessionCacheKey(`tau-session-${i}`)
      codexApi.getOrSeedFrozenVolatile('gpt-5.4', `env-${i}`)
    }
    codexApi.setSessionCacheKey('tau-session-oldest')
    const reseeded = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'fresh-env')
    assert(
      reseeded === 'fresh-env',
      `evicted session should re-seed, got ${JSON.stringify(reseeded)}`,
    )
    const recent = codexApi.getOrSeedFrozenVolatile('gpt-5.4', 'ignored')
    assert(recent === 'fresh-env', `re-seeded anchor must now replay; got ${JSON.stringify(recent)}`)
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
