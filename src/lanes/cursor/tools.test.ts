/**
 * Cursor native tool surface checks.
 *
 * Run via: bun run src/lanes/cursor/tools.test.ts
 */

import {
  CURSOR_CLIENT_SIDE_TOOL_V2,
  buildCursorSupportedToolEnums,
  buildCursorToolDefinitions,
  resolveCursorToolCall,
} from './tools.js'

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

test('Cursor exposes file and shell tools with native names', () => {
  const defs = buildCursorToolDefinitions([
    { name: 'Read', input_schema: { type: 'object' } },
    { name: 'Write', input_schema: { type: 'object' } },
    { name: 'Edit', input_schema: { type: 'object' } },
    { name: 'Bash', input_schema: { type: 'object' } },
    { name: 'Grep', input_schema: { type: 'object' } },
    { name: 'Glob', input_schema: { type: 'object' } },
  ])
  const names = defs.map(t => t.name)
  for (const expected of [
    'read_file',
    'write_file',
    'replace',
    'run_terminal_cmd',
    'grep_search',
    'glob_file_search',
  ]) {
    assert(names.includes(expected), `missing ${expected}`)
  }
})

test('Cursor exposes agent, planning, and MCP resource tools in native names', () => {
  const defs = buildCursorToolDefinitions([
    {
      name: 'Agent',
      description: 'Spawn a subagent',
      input_schema: {
        type: 'object',
        properties: { description: { type: 'string' }, prompt: { type: 'string' } },
        required: ['description', 'prompt'],
      },
    },
    { name: 'EnterPlanMode', input_schema: { type: 'object', properties: {} } },
    {
      name: 'AskUserQuestion',
      input_schema: { type: 'object', properties: { questions: { type: 'array' } } },
    },
    { name: 'ListMcpResourcesTool', input_schema: { type: 'object', properties: {} } },
    {
      name: 'ReadMcpResourceTool',
      input_schema: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } } },
    },
  ])
  const names = defs.map(t => t.name)
  for (const expected of [
    'task',
    'create_plan',
    'ask_question',
    'list_mcp_resources',
    'read_mcp_resource',
  ]) {
    assert(names.includes(expected), `missing ${expected}`)
  }
})

test('Cursor read_file input adapts to shared Read schema', () => {
  const resolved = resolveCursorToolCall('read_file', {
    file_path: '/tmp/a.txt',
    start_line: 3,
    end_line: 5,
  })
  assert(resolved?.implId === 'Read', 'wrong impl')
  assert(resolved.input.file_path === '/tmp/a.txt', 'wrong path')
  assert(resolved.input.offset === 2, 'wrong offset')
  assert(resolved.input.limit === 3, 'wrong limit')
})

test('Cursor read_file and write_file accept common path/content aliases', () => {
  const read = resolveCursorToolCall('read_file', {
    path: '/tmp/a.txt',
  })
  assert(read?.implId === 'Read', 'wrong read impl')
  assert(read.input.file_path === '/tmp/a.txt', 'read path alias was not adapted')

  const write = resolveCursorToolCall('write_file', {
    path: '/tmp/a.txt',
    text: 'hello',
  })
  assert(write?.implId === 'Write', 'wrong write impl')
  assert(write.input.file_path === '/tmp/a.txt', 'write path alias was not adapted')
  assert(write.input.content === 'hello', 'write content alias was not adapted')
})

test('Cursor run_shell_command input adapts to shared Bash schema', () => {
  const resolved = resolveCursorToolCall('run_shell_command', {
    command: 'bun test',
    description: 'Run tests',
    is_background: true,
  })
  assert(resolved?.implId === 'Bash', 'wrong impl')
  assert(resolved.input.command === 'bun test', 'wrong command')
  assert(resolved.input.description === 'Run tests', 'wrong description')
  assert(resolved.input.run_in_background === true, 'wrong background flag')
})

test('Cursor shell description forbids raw backgrounding', () => {
  const defs = buildCursorToolDefinitions([
    { name: 'Bash', input_schema: { type: 'object' } },
  ])
  const shell = defs.find(def => def.name === 'run_terminal_cmd')
  assert(shell, 'missing run_terminal_cmd')
  const text = JSON.stringify(shell)
  assert(text.includes('is_background=true'), 'description should mention is_background')
  assert(text.includes('echo $!'), 'description should warn against pid capture')
  assert(text.includes('docker compose up -d'), 'description should warn against Docker detach')
})

test('Cursor list_dir emits Bash syntax for the Bash implementation', () => {
  const resolved = resolveCursorToolCall('list_dir', {
    dir_path: 'C:\\Projects\\example',
  })
  assert(resolved?.implId === 'Bash', 'wrong impl')
  assert(String(resolved.input.command).startsWith('ls -la -- '), 'list_dir must use ls for Bash')
  assert(!/Get-ChildItem/i.test(String(resolved.input.command)), 'list_dir must not emit PowerShell')
})

test('Cursor keeps MCP tools in their independent names', () => {
  const defs = buildCursorToolDefinitions([
    {
      name: 'mcp__context7__query-docs',
      description: 'Query docs',
      input_schema: { type: 'object' },
    },
  ])
  assert(defs[0]?.name === 'mcp__context7__query-docs', 'MCP name changed')
})

test('Cursor advertises native ClientSideToolV2 enums for available tools', () => {
  const enums = buildCursorSupportedToolEnums([
    { name: 'Read', input_schema: { type: 'object' } },
    { name: 'Bash', input_schema: { type: 'object' } },
    { name: 'Grep', input_schema: { type: 'object' } },
    { name: 'Glob', input_schema: { type: 'object' } },
    { name: 'WebSearch', input_schema: { type: 'object' } },
    { name: 'Agent', input_schema: { type: 'object' } },
    { name: 'EnterPlanMode', input_schema: { type: 'object' } },
    { name: 'AskUserQuestion', input_schema: { type: 'object' } },
    { name: 'ListMcpResourcesTool', input_schema: { type: 'object' } },
    { name: 'ReadMcpResourceTool', input_schema: { type: 'object' } },
    { name: 'mcp__context7__query-docs', input_schema: { type: 'object' } },
  ])
  for (const expected of [
    CURSOR_CLIENT_SIDE_TOOL_V2.READ_FILE,
    CURSOR_CLIENT_SIDE_TOOL_V2.RUN_TERMINAL_COMMAND_V2,
    CURSOR_CLIENT_SIDE_TOOL_V2.RIPGREP_SEARCH,
    CURSOR_CLIENT_SIDE_TOOL_V2.GLOB_FILE_SEARCH,
    CURSOR_CLIENT_SIDE_TOOL_V2.WEB_SEARCH,
    CURSOR_CLIENT_SIDE_TOOL_V2.TASK,
    CURSOR_CLIENT_SIDE_TOOL_V2.TASK_V2,
    CURSOR_CLIENT_SIDE_TOOL_V2.CREATE_PLAN,
    CURSOR_CLIENT_SIDE_TOOL_V2.ASK_QUESTION,
    CURSOR_CLIENT_SIDE_TOOL_V2.LIST_MCP_RESOURCES,
    CURSOR_CLIENT_SIDE_TOOL_V2.READ_MCP_RESOURCE,
    CURSOR_CLIENT_SIDE_TOOL_V2.MCP,
    CURSOR_CLIENT_SIDE_TOOL_V2.CALL_MCP_TOOL,
  ]) {
    assert(enums.includes(expected), `missing enum ${expected}`)
  }
})

test('Cursor native aliases adapt back to shared tool implementations', () => {
  const shell = resolveCursorToolCall('run_terminal_cmd', {
    command: 'pwd',
    cwd: '/tmp/project',
    is_background: false,
  })
  assert(shell?.implId === 'Bash', 'wrong shell impl')
  // cwd maps to the shared Bash `workdir` field, NOT a `cd <dir> &&` prefix.
  assert(shell.input.command === 'pwd', 'shell command should be untouched (no cd prefix)')
  assert(shell.input.workdir === '/tmp/project', 'cwd should map to workdir')

  const web = resolveCursorToolCall('web_search', { search_term: 'cursor cli tools' })
  assert(web?.implId === 'WebSearch', 'wrong web impl')
  assert(web.input.query === 'cursor cli tools', 'wrong web query')

  const task = resolveCursorToolCall('task', {
    description: 'Explore',
    prompt: 'Inspect the repository and summarize the auth flow.',
  })
  assert(task?.implId === 'Agent', 'wrong task impl')
  assert(task.input.prompt === 'Inspect the repository and summarize the auth flow.', 'wrong task input')
})

test('Cursor tolerates Shell as a terminal alias', () => {
  const shell = resolveCursorToolCall('Shell', {
    command: 'echo ok',
    cwd: '/tmp/project',
    description: 'Verify shell alias',
  })
  assert(shell?.implId === 'Bash', 'wrong Shell impl')
  // cwd maps to the shared Bash `workdir` field, NOT a `cd <dir> &&` prefix.
  assert(shell.input.command === 'echo ok', 'Shell command should be untouched (no cd prefix)')
  assert(shell.input.workdir === '/tmp/project', 'cwd should map to workdir')
  assert(shell.input.description === 'Verify shell alias', 'wrong Shell description')
})

test('Cursor normalizes incomplete ask_question calls to AskUserQuestion schema', () => {
  const resolved = resolveCursorToolCall('ask_question', {
    prompt: 'Which approach should I take?',
    options: ['Simple'],
  })
  assert(resolved?.implId === 'AskUserQuestion', 'wrong ask impl')
  const questions = resolved.input.questions as Array<Record<string, any>>
  assert(questions.length === 1, 'wrong question count')
  assert(questions[0]?.question === 'Which approach should I take?', 'wrong question text')
  assert(typeof questions[0]?.header === 'string' && questions[0].header.length > 0, 'missing header')
  assert(questions[0]?.options.length >= 2, 'must pad to at least two options')
  assert(questions[0]?.options.every((opt: any) => opt.label && opt.description), 'missing option descriptions')
  assert(questions[0]?.multiSelect === false, 'wrong multiSelect default')
})

test('Cursor NotebookEdit inserts default to code cell_type and accept aliases', () => {
  const resolved = resolveCursorToolCall('NotebookEdit', {
    path: '/tmp/demo.ipynb',
    mode: 'insert',
    source: 'print("hi")',
    after_cell_id: 'cell-1',
  })
  assert(resolved?.implId === 'NotebookEdit', 'wrong notebook impl')
  assert(resolved.input.notebook_path === '/tmp/demo.ipynb', 'wrong notebook path')
  assert(resolved.input.new_source === 'print("hi")', 'wrong notebook source')
  assert(resolved.input.edit_mode === 'insert', 'wrong notebook edit mode')
  assert(resolved.input.cell_type === 'code', 'insert must default to code cell_type')
  assert(resolved.input.cell_id === 'cell-1', 'after_cell_id should map to cell_id')
})

test('Cursor NotebookEdit delete accepts cell indexes and missing new_source', () => {
  const resolved = resolveCursorToolCall('NotebookEdit', {
    notebook_path: '/tmp/demo.ipynb',
    edit_mode: 'delete',
    cell_index: 0,
  })
  assert(resolved?.implId === 'NotebookEdit', 'wrong notebook delete impl')
  assert(resolved.input.cell_id === 'cell-0', 'cell_index should map to cell-N id')
  assert(resolved.input.new_source === '', 'delete should provide empty new_source for shared schema')
})

test('Cursor repairs MCP required string arguments from generic query fields', () => {
  const schema = {
    type: 'object',
    properties: {
      libraryName: { type: 'string' },
    },
    required: ['libraryName'],
  }
  const resolved = resolveCursorToolCall(
    'mcp__context7__resolve-library-id',
    { query: 'apache cassandra' },
    {
      toolSchemas: new Map([
        ['mcp__context7__resolve-library-id', schema],
      ]),
    },
  )
  assert(resolved?.implId === 'mcp__context7__resolve-library-id', 'wrong MCP impl')
  assert(resolved.input.libraryName === 'apache cassandra', 'query did not map to required libraryName')
  assert(!('query' in resolved.input), 'unmapped generic query should not leak when schema has no query field')
})

test('Cursor repairs direct MCP arguments when Cursor nests args under arguments', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      libraryName: { type: 'string' },
    },
    required: ['libraryName'],
  }
  const resolved = resolveCursorToolCall(
    'mcp__context7__resolve-library-id',
    { arguments: { query: 'apache cassandra' } },
    {
      toolSchemas: new Map([
        ['mcp__context7__resolve-library-id', schema],
      ]),
    },
  )
  assert(resolved?.implId === 'mcp__context7__resolve-library-id', 'wrong MCP impl')
  assert(resolved.input.libraryName === 'apache cassandra', 'nested query did not map to required libraryName')
  assert(!('arguments' in resolved.input), 'wrapper arguments should not leak into direct MCP input')
  assert(!('query' in resolved.input), 'generic nested query should not leak')
})

test('Cursor repairs call_mcp_tool wrapper arguments with the target MCP schema', () => {
  const schema = {
    type: 'object',
    properties: {
      libraryName: { type: 'string' },
    },
    required: ['libraryName'],
  }
  const resolved = resolveCursorToolCall(
    'call_mcp_tool',
    {
      server: 'context7',
      tool_name: 'resolve-library-id',
      tool_args: { query: 'apache cassandra' },
    },
    {
      toolSchemas: new Map([
        ['mcp__context7__resolve-library-id', schema],
      ]),
    },
  )
  assert(resolved?.implId === 'mcp__context7__resolve-library-id', 'wrong call_mcp_tool impl')
  assert(resolved.input.libraryName === 'apache cassandra', 'wrapped query did not map to required libraryName')
})

test('Cursor matches call_mcp_tool underscore names to hyphenated MCP schemas', () => {
  const schema = {
    type: 'object',
    properties: {
      libraryName: { type: 'string' },
    },
    required: ['libraryName'],
  }
  const resolved = resolveCursorToolCall(
    'call_mcp_tool',
    {
      server: 'context7',
      tool_name: 'resolve_library_id',
      tool_args: { query: 'apache cassandra' },
    },
    {
      toolSchemas: new Map([
        ['mcp__context7__resolve-library-id', schema],
      ]),
    },
  )
  assert(resolved?.implId === 'mcp__context7__resolve-library-id', 'underscore MCP tool name did not resolve to schema key')
  assert(resolved.input.libraryName === 'apache cassandra', 'underscore wrapped query did not map')
})

test('Cursor coerces shared TaskUpdate array fields from strings', () => {
  const schema = {
    type: 'object',
    required: ['taskId'],
    additionalProperties: false,
    properties: {
      taskId: { type: 'string' },
      addBlocks: { type: 'array', items: { type: 'string' } },
      addBlockedBy: { type: 'array', items: { type: 'string' } },
      status: { type: 'string' },
    },
  }
  const resolved = resolveCursorToolCall(
    'TaskUpdate',
    {
      taskId: 2,
      addBlocks: '3',
      add_blocked_by: '1, 4',
      ignored: 'drop me',
    },
    {
      toolSchemas: new Map([
        ['TaskUpdate', schema],
      ]),
    },
  )
  assert(resolved?.implId === 'TaskUpdate', 'wrong task update impl')
  assert(resolved.input.taskId === '2', 'taskId should coerce to string')
  assert(Array.isArray(resolved.input.addBlocks), 'addBlocks should be an array')
  assert((resolved.input.addBlocks as string[])[0] === '3', 'addBlocks should contain string task id')
  assert(Array.isArray(resolved.input.addBlockedBy), 'addBlockedBy should be an array')
  assert((resolved.input.addBlockedBy as string[]).join(',') === '1,4', 'addBlockedBy should split string list')
  assert(!('ignored' in resolved.input), 'additionalProperties=false should drop unknown fields')
})

test('Cursor adapts shared Glob and Grep names from printed-tool syntax', () => {
  const glob = resolveCursorToolCall('Glob', {
    target_directory: '/tmp/project',
    glob_pattern: '**/*',
  })
  assert(glob?.implId === 'Glob', 'wrong glob impl')
  assert(glob.input.path === '/tmp/project', 'wrong glob path')
  assert(glob.input.pattern === '**/*', 'wrong glob pattern')

  const grep = resolveCursorToolCall('Grep', {
    path: '/tmp/project',
    pattern: '.',
    head_limit: 3,
  })
  assert(grep?.implId === 'Grep', 'wrong grep impl')
  assert(grep.input.path === '/tmp/project', 'wrong grep path')
  assert(grep.input.head_limit === 3, 'wrong grep limit')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
