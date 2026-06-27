/**
 * Cline lane invariants.
 *
 * Run: bun run src/lanes/cline/cline.test.ts
 */

import { buildClineToolsForRequest } from './tools.js'

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

  test('emits sanitized non-strict schemas while preserving full 35-tool set', () => {
    const providerTools = [
      {
        name: 'AFTAstSearch',
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
    ] as any

    const tools = buildClineToolsForRequest(providerTools)
    assert(tools.length === 35, `tools.length=${tools.length}`)

    for (const tool of tools) {
      assert(tool.type === 'function', `${tool.function.name} not a function tool`)
      assert(tool.function.strict === undefined, `${tool.function.name} strict=${tool.function.strict}`)
      assert(tool.function.description?.includes('STRICT PARAMETERS:'),
        `${tool.function.name} missing strict parameter hint`)

      const parameters = tool.function.parameters
      const properties = parameters.properties
      assert(isRecord(properties), `${tool.function.name} properties missing`)
      const required = parameters.required
      assert(Array.isArray(required), `${tool.function.name} required missing`)
      assert(!required.includes('optionalPath'), `${tool.function.name} optionalPath became required`)

      for (const key of ['format', 'propertyNames', 'default', 'examples']) {
        assert(!deepContainsKey(parameters, key), `${tool.function.name} leaked ${key}`)
      }
    }

    const ast = tools.find(tool => tool.function.name === 'AFTAstSearch')!
    const astProps = ast.function.parameters.properties as Record<string, any>
    const astRequired = ast.function.parameters.required as string[] | undefined
    assert(astProps.pattern.type === 'string', 'pattern must stay required string')
    assert(astRequired?.includes('pattern'), 'pattern must stay required')
    assert(astRequired?.includes('lang'), 'lang must stay required')
    assert(!astRequired?.includes('paths'), 'optional paths should stay optional')
    assert(astProps.paths.type === 'array', 'optional paths should stay array typed')

    const task = tools.find(tool => tool.function.name === 'TaskUpdate')!
    const taskProps = task.function.parameters.properties as Record<string, any>
    const taskRequired = task.function.parameters.required as string[] | undefined
    assert(taskProps.taskId.type === 'string', 'taskId must stay required string')
    assert(taskRequired?.includes('taskId'), 'taskId must stay required')
    assert(!taskRequired?.includes('subject'), 'optional subject should stay optional')
    assert(taskProps.metadata.additionalProperties === false,
      `metadata.additionalProperties=${JSON.stringify(taskProps.metadata.additionalProperties)}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
