import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const auditPath = join(
  dirname(distPath),
  `.core-tool-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __coreToolContracts() {
  init_BashTool(); init_TodoWriteTool(); init_FileReadTool();
  init_FileEditTool(); init_FileWriteTool(); init_NotebookEditTool();
  init_GrepTool(); init_GlobTool(); init_EnterPlanModeTool();
  init_ExitPlanModeV2Tool(); init_SnapshotTool();
  init_ToolOutputRetrieveTool(); init_WebFetchTool(); init_WebSearchTool();
  init_AskUserQuestionTool(); init_TaskOutputTool(); init_TaskStopTool();
  init_zodToJsonSchema(); init_toolSearchRequestFilter(); init_transformers();
  return { BashTool, TodoWriteTool, FileReadTool, FileEditTool,
    FileWriteTool, NotebookEditTool, GrepTool, GlobTool,
    EnterPlanModeTool, ExitPlanModeV2Tool, SnapshotTool,
    ToolOutputRetrieveTool, WebFetchTool, WebSearchTool,
    AskUserQuestionTool, TaskOutputTool, TaskStopTool,
    zodToJsonSchema, getEnterPlanModeToolPrompt,
    readFileSyncWithMetadata, isFileWriteNoOp,
    selectToolsForToolSearchRequest, getTransformer };
}
`
writeFileSync(auditPath, source)

let audit
try {
  const module = await import(pathToFileURL(auditPath).href)
  audit = module.__coreToolContracts()
} finally {
  unlinkSync(auditPath)
}

const contracts = [
  ['BashTool', 9_000, ['command', 'timeout', 'description', 'run_in_background', 'plan_only', 'syntax_confirmed', 'command_parts', 'dangerouslyDisableSandbox']],
  ['TodoWriteTool', 1_500, ['todos']],
  ['FileReadTool', 2_200, ['file_path', 'offset', 'limit', 'skeleton', 'pages']],
  ['FileEditTool', 1_500, ['file_path', 'old_string', 'new_string', 'replace_all']],
  ['FileWriteTool', 900, ['file_path', 'content']],
  ['NotebookEditTool', 1_500, ['notebook_path', 'cell_id', 'new_source', 'cell_type', 'edit_mode']],
  ['GrepTool', 2_000, ['pattern', 'path', 'glob', 'output_mode', '-B', '-A', '-C', 'context', '-n', '-i', 'type', 'head_limit', 'offset', 'multiline']],
  ['GlobTool', 650, ['pattern', 'path']],
  ['EnterPlanModeTool', 900, []],
  ['ExitPlanModeV2Tool', 1_200, ['allowedPrompts']],
  ['SnapshotTool', 1_700, ['action', 'hash', 'compareHash', 'label', 'limit']],
  ['ToolOutputRetrieveTool', 1_700, ['path', 'toolUseId', 'startByte', 'maxBytes', 'startLine', 'lineCount', 'query']],
  ['WebFetchTool', 1_300, ['url', 'prompt']],
  ['WebSearchTool', 2_300, ['query', 'allowed_domains', 'blocked_domains']],
  ['AskUserQuestionTool', 2_700, ['questions', 'answers', 'annotations', 'metadata']],
  ['TaskOutputTool', 950, ['task_id', 'block', 'timeout']],
  ['TaskStopTool', 550, ['task_id', 'shell_id']],
]

test('core tool fields and serialized byte budgets stay stable', async () => {
  for (const [key, budget, expectedFields] of contracts) {
    const tool = audit[key]
    const description = await tool.prompt()
    const schema = audit.zodToJsonSchema(tool.inputSchema)
    assert.deepEqual(Object.keys(schema.properties ?? {}), expectedFields, key)
    const bytes = Buffer.byteLength(
      JSON.stringify({ name: tool.name, description, input_schema: schema }),
    )
    assert.ok(bytes <= budget, `${tool.name}: ${bytes} B > ${budget} B`)
  }
})

test('rendered Bash prompt retains code-backed edge-case guidance', async () => {
  const prompt = await audit.BashTool.prompt()
  for (const text of [
    'absolute path',
    'verify the target directory',
    'run_in_background: true',
    'do not poll',
    'plan_only',
    'timeout',
    'Do not sleep, poll, or retry in a loop',
  ]) {
    assert.ok(prompt.includes(text), `Bash prompt missing ${JSON.stringify(text)}`)
  }
})

test('external EnterPlanMode build preserves proactive trigger policy', () => {
  assert.match(
    audit.getEnterPlanModeToolPrompt(),
    /Use proactively for non-trivial implementation/,
  )
})

test('compact auxiliary prompts retain recovery-critical behavior', async () => {
  const expectations = [
    ['AskUserQuestionTool', ['Other', '(Recommended)', 'ExitPlanMode']],
    ['WebSearchTool', ['Sources', 'plain hostnames', 'Current month']],
    ['WebFetchTool', ['Authenticated/private URLs fail', 'GitHub', 'redirect']],
    ['TaskOutputTool', ['Prefer Read', 'block=false', 'timeout']],
    ['TaskStopTool', ['already-finished task', 'no-op']],
  ]
  for (const [key, fragments] of expectations) {
    const prompt = await audit[key].prompt()
    for (const fragment of fragments) {
      assert.ok(prompt.includes(fragment), `${key} missing ${JSON.stringify(fragment)}`)
    }
  }
})

test('TaskStop no-op applies only to terminal task states', async () => {
  const task = status => ({
    id: 'task-1',
    type: 'local_bash',
    status,
    description: 'test task',
    startTime: 0,
    outputFile: 'unused',
    outputOffset: 0,
    notified: false,
  })
  const context = status => ({
    getAppState: () => ({ tasks: { 'task-1': task(status) } }),
    setAppState: () => {},
    abortController: new AbortController(),
  })

  await assert.rejects(
    () => audit.TaskStopTool.call({ task_id: 'task-1' }, context('pending')),
    /not running \(status: pending\)/,
  )
  const completed = await audit.TaskStopTool.call(
    { task_id: 'task-1' },
    context('completed'),
  )
  assert.match(completed.data.message, /already finished.*nothing to stop/)
})

test('FileWrite exact no-op detects CRLF beyond the 4 KB sample', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'tau-write-noop-'))
  const mixedPath = join(tempDir, 'mixed.txt')
  try {
    const raw = `${'head\n'.repeat(1_000)}later\r\n`
    writeFileSync(mixedPath, raw, 'utf8')
    const meta = audit.readFileSyncWithMetadata(mixedPath)
    assert.equal(meta.lineEndings, 'LF')
    assert.equal(meta.hasCRLF, true)
    assert.equal(
      audit.isFileWriteNoOp(
        meta.content,
        meta.hasCRLF,
        raw.replaceAll('\r\n', '\n'),
      ),
      false,
    )
  } finally {
    unlinkSync(mixedPath)
    rmdirSync(tempDir)
  }
})

test('Groq small-tier request never strands allowed deferred tools', () => {
  const source = [
    { name: 'ToolSearch' },
    { name: 'WebFetch' },
    { name: 'mcp__github__list_issues' },
    { name: 'NotebookEdit' },
  ]
  const upstream = audit.selectToolsForToolSearchRequest(source, {
    useToolSearch: true,
    useNativeLaneToolSearch: false,
    deferredToolNames: new Set([
      'WebFetch',
      'mcp__github__list_issues',
      'NotebookEdit',
    ]),
    discoveredToolNames: new Set(),
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
  })
  const final = audit
    .getTransformer('groq')
    .filterTools('llama-3.1-8b-instant', upstream)
    .map(tool => tool.name)
  assert.deepEqual(final, ['WebFetch', 'mcp__github__list_issues'])
})

test.after(() => {
  // A failed import can leave the audit copy behind; report the exact path so
  // cleanup is obvious without risking a broad delete.
  assert.notEqual(basename(auditPath), basename(distPath))
})
