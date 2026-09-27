/**
 * OpenAI Responses adapter invariants.
 *
 * Run: bun run src/services/api/adapters/openai_responses.test.ts
 */

import { anthropicToolsToResponsesTools } from './openai_responses.js'

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

async function main(): Promise<void> {
  console.log('openai responses adapter:')

  await test('sends failure-prone schemas as their own contracts, non-strict', () => {
    const tools = anthropicToolsToResponsesTools([
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
        name: 'TaskCreate',
        description: 'Create a task',
        input_schema: {
          type: 'object',
          required: ['subject', 'description'],
          additionalProperties: false,
          properties: {
            subject: { type: 'string' },
            description: { type: 'string' },
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
    ] as any)

    assert(tools.length === 3, `tools.length=${tools.length}`)
    for (const tool of tools) {
      // Sent the way the Codex lane (and native Codex) sends every tool.
      assert(tool.strict === false, `${tool.name} strict=${tool.strict}`)
      assert(isRecord(tool.parameters.properties), `${tool.name} properties missing`)
      assert(!deepContainsKey(tool.parameters, 'format'), `${tool.name} format leaked`)
      assert(!deepContainsKey(tool.parameters, 'propertyNames'), `${tool.name} propertyNames leaked`)
    }

    const ast = tools.find(tool => tool.name === 'SampleAstSearch')!
    const astProps = ast.parameters.properties as Record<string, any>
    assert(astProps.pattern.type === 'string', 'pattern must stay a string')
    assert(astProps.paths.type === 'array', 'optional paths stays optional, not nullable')
    assert(JSON.stringify(ast.parameters.required) === '["pattern","lang"]', 'the real required list is kept')

    const task = tools.find(tool => tool.name === 'TaskCreate')!
    const metadata = (task.parameters.properties as Record<string, any>).metadata
    assert(JSON.stringify(metadata) === '{"type":"object","additionalProperties":{}}',
      `metadata must stay a map: ${JSON.stringify(metadata)}`)
    assert(JSON.stringify(task.parameters.required) === '["subject","description"]',
      'the real required list is kept')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
