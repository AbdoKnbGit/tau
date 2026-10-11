// Run against an isolated current build, optionally comparing the pre-fix build:
// TAU_MCP_TEST_BUNDLE=<fixed>/tau.mjs TAU_MEMORY_BASELINE_BUNDLE=<baseline>/tau.mjs
// node --test test/memory-index-tool-results.test.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { toJSONSchema } from 'zod/v4'
import { fixtureContext, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const sandbox = mkdtempSync(join(tmpdir(), 'tau-memory-index-results-'))
const memoryDir = join(sandbox, 'memory')
mkdirSync(memoryDir)
process.env.CLAUDE_CONFIG_DIR = join(sandbox, 'config')
process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryDir
process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
process.env.DISABLE_TELEMETRY = '1'
process.env.DISABLE_ERROR_REPORTING = '1'
delete process.env.USER_TYPE
delete process.env.CLAUDE_INTERNAL_FC_OVERRIDES

const loadOptions = {
  paths: ['src/tools/FileWriteTool/FileWriteTool.ts', 'src/tools/FileEditTool/FileEditTool.ts'],
  exports: ['FileWriteTool', 'FileEditTool'],
}
const runtime = await loadMcpRuntime(loadOptions)
let baseline
if (process.env.TAU_MEMORY_BASELINE_BUNDLE) {
  const fixedBundle = process.env.TAU_MCP_TEST_BUNDLE
  process.env.TAU_MCP_TEST_BUNDLE = process.env.TAU_MEMORY_BASELINE_BUNDLE
  try { baseline = await loadMcpRuntime(loadOptions) }
  finally {
    if (fixedBundle === undefined) delete process.env.TAU_MCP_TEST_BUNDLE
    else process.env.TAU_MCP_TEST_BUNDLE = fixedBundle
  }
}
test.after(() => {
  assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()))
  assert.ok(sandbox.includes('tau-memory-index-results-'))
  rmSync(sandbox, { recursive: true, force: true })
})

const topicBody = '---\nname: Tests\ndescription: Vitest, never Jest\ntype: feedback\n---\nUse vitest, never jest.\n'
const hasReminder = result => String(result.content).includes('<system-reminder>Add this memory')
const topic = name => {
  const file = join(memoryDir, `${name}.md`)
  writeFileSync(file, topicBody)
  return file
}
const mapWrite = (filePath, extra = {}) => runtime.FileWriteTool.mapToolResultToToolResultBlockParam(
  { filePath, type: 'create', content: topicBody, ...extra }, 'memory-write',
)
const mapEdit = (filePath, extra = {}) => runtime.FileEditTool.mapToolResultToToolResultBlockParam(
  { filePath, oldString: 'jest', newString: 'vitest', structuredPatch: [], ...extra }, 'memory-edit',
)

test('both production mappers surface the recorded orphan-save case', () => {
  const file = topic('missing-index')
  for (const [map, id] of [[mapWrite, 'memory-write'], [mapEdit, 'memory-edit']]) {
    const result = map(file)
    assert.equal(result.type, 'tool_result')
    assert.equal(result.tool_use_id, id)
    assert.notEqual(result.is_error, true)
    assert.ok(hasReminder(result))
    assert.equal(String(result.content).split('<system-reminder>').length, 2)
  }
})

test('no-op orphan saves get recovery guidance without claiming another write', () => {
  const file = topic('no-op')
  for (const map of [mapWrite, mapEdit]) {
    const result = map(file, { noOp: true })
    assert.ok(hasReminder(result))
    assert.match(String(result.content), /do not retry/i)
  }
})

test('repairing the pointer silences future results without mutating previous messages', () => {
  const file = topic('repaired')
  const previous = mapWrite(file)
  const bytes = JSON.stringify(previous)
  writeFileSync(join(memoryDir, 'MEMORY.md'), '- [Tests](repaired.md) — Vitest, never Jest.\n')
  assert.equal(hasReminder(mapWrite(file)), false)
  assert.equal(hasReminder(mapEdit(file)), false)
  assert.equal(JSON.stringify(previous), bytes)
  assert.equal(readFileSync(file, 'utf8'), topicBody)
})

test('Edit reminder precedes a long snippet and preserves other warnings', () => {
  const result = mapEdit(topic('long-snippet'), {
    replaceAll: true, editedSnippet: 'x'.repeat(10_000), syntaxWarning: 'syntax note', importWarning: 'import note',
  })
  const text = String(result.content)
  assert.ok(hasReminder(result))
  assert.ok(text.indexOf('<system-reminder>') < text.indexOf('Edited region'))
  assert.ok(text.endsWith('syntax note\nimport note'))
})

test('ordinary files and index writes add no reminder', () => {
  for (const file of [join(sandbox, 'README.md'), join(memoryDir, 'MEMORY.md')]) {
    assert.equal(hasReminder(mapWrite(file)), false)
    assert.equal(hasReminder(mapEdit(file)), false)
  }
})

async function execute(tool, input, permission) {
  const id = randomUUID()
  const block = { type: 'tool_use', id, name: tool.name, input }
  const context = fixtureContext([tool], { agentId: randomUUID() })
  const updates = []
  for await (const update of runtime.runToolUse(block,
    { type: 'assistant', uuid: randomUUID(), message: { id: randomUUID(), content: [block] } },
    permission ?? (async () => ({ behavior: 'allow', updatedInput: input })), context)) updates.push(update)
  return updates.flatMap(update => update.message?.message?.content ?? [])
    .filter(block => block.type === 'tool_result')
}

function writingTool(productionTool) {
  return fixtureTool({
    name: productionTool.name,
    mapToolResultToToolResultBlockParam: productionTool.mapToolResultToToolResultBlockParam,
    async call(input) {
      writeFileSync(input.file_path, input.content)
      return { data: { filePath: input.file_path, type: 'create', content: input.content, structuredPatch: [] } }
    },
  })
}

test('shared execution delivers the reminder on successful Write and Edit results', async () => {
  for (const productionTool of [runtime.FileWriteTool, runtime.FileEditTool]) {
    const file = join(memoryDir, `${productionTool.name}-pipeline.md`)
    const results = await execute(writingTool(productionTool), { file_path: file, content: topicBody })
    assert.equal(results.length, 1)
    assert.notEqual(results[0].is_error, true)
    assert.ok(hasReminder(results[0]), JSON.stringify(results))
    assert.equal(readFileSync(file, 'utf8'), topicBody)
  }
})

test('failed or denied saves never report a missing index', async () => {
  const tool = writingTool(runtime.FileWriteTool)
  tool.call = async () => { throw new Error('fixture write failed') }
  const input = { file_path: join(memoryDir, 'failed.md'), content: topicBody }
  const failed = await execute(tool, input)
  assert.equal(failed[0].is_error, true)
  assert.equal(hasReminder(failed[0]), false)
  let called = false
  tool.call = async () => { called = true; throw new Error('should not execute') }
  const denied = await execute(tool, input, async () => ({ behavior: 'deny', message: 'fixture denied' }))
  assert.equal(called, false)
  assert.equal(denied[0].is_error, true)
  assert.equal(hasReminder(denied[0]), false)
})

test('the actual permission-rewritten path determines whether memory is checked', async () => {
  const tool = writingTool(runtime.FileWriteTool)
  const memory = { file_path: join(memoryDir, 'rewritten.md'), content: topicBody }
  const ordinary = { file_path: join(sandbox, 'ordinary.md'), content: topicBody }
  const intoMemory = await execute(tool, ordinary, async () => ({ behavior: 'allow', updatedInput: memory }))
  assert.ok(hasReminder(intoMemory[0]), JSON.stringify(intoMemory))
  const awayFromMemory = await execute(tool, memory, async () => ({ behavior: 'allow', updatedInput: ordinary }))
  assert.equal(hasReminder(awayFromMemory[0]), false)
})

test('baseline comparison: prompts, schemas and quiet results remain byte-for-byte identical', { skip: !baseline }, async () => {
  for (const name of ['FileWriteTool', 'FileEditTool']) {
    const oldTool = baseline[name]
    const newTool = runtime[name]
    assert.equal(await newTool.description(), await oldTool.description())
    assert.equal(await newTool.prompt(), await oldTool.prompt())
    assert.deepEqual(toJSONSchema(newTool.inputSchema), toJSONSchema(oldTool.inputSchema))
    assert.deepEqual(toJSONSchema(newTool.outputSchema), toJSONSchema(oldTool.outputSchema))
    for (const filePath of [join(sandbox, 'ordinary.md'), join(memoryDir, 'repaired.md'), join(memoryDir, 'MEMORY.md')]) {
      for (const noOp of [false, true]) {
        const data = { filePath, type: 'update', content: topicBody, structuredPatch: [], noOp }
        assert.deepEqual(newTool.mapToolResultToToolResultBlockParam(data, 'same-id'), oldTool.mapToolResultToToolResultBlockParam(data, 'same-id'))
      }
    }
    const missing = { filePath: topic(`${name}-baseline-orphan`), type: 'create', content: topicBody, structuredPatch: [] }
    assert.equal(hasReminder(oldTool.mapToolResultToToolResultBlockParam(missing, 'same-id')), false)
    assert.ok(hasReminder(newTool.mapToolResultToToolResultBlockParam(missing, 'same-id')))
  }
})
