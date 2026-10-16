import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fixtureContext, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// A model waiting on a background job must be told when it finishes, see its
// newest output when it checks, and be stopped if it polls anyway. Everything
// here runs through the shipped bundle: the real query loop, the real
// TaskOutput tool, real task state and real log files.

const tempRoot = mkdtempSync(join(tmpdir(), 'tau-wait-loop-'))
process.env.CLAUDE_CODE_TMPDIR = tempRoot
process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
process.env.NODE_ENV = 'test'
test.after(() => rmSync(tempRoot, { recursive: true, force: true }))

const runtime = {
  paths: [
    'src/query.ts', 'src/tools/TaskOutputTool/TaskOutputTool.tsx',
    'src/tools/BashTool/BashTool.tsx', 'src/tools/PowerShellTool/PowerShellTool.tsx',
    'src/state/store.ts', 'src/state/onChangeAppState.ts',
    'src/utils/task/framework.ts', 'src/utils/task/diskOutput.ts',
    'src/tools/FileEditTool/FileEditTool.ts', 'src/tools/FileWriteTool/FileWriteTool.ts',
    'src/tools/NotebookEditTool/NotebookEditTool.ts', 'src/tools/FileReadTool/FileReadTool.ts',
    'src/tools/GrepTool/GrepTool.ts', 'src/tools/GlobTool/GlobTool.ts',
  ],
  exports: [
    'query', 'createUserMessage', 'createAssistantMessage', 'TaskOutputTool',
    'BashTool', 'PowerShellTool', 'registerTask', 'updateTaskState',
    'getTaskOutputPath', 'createStore', 'onChangeAppState',
    'FileEditTool', 'FileWriteTool', 'NotebookEditTool', 'FileReadTool', 'GrepTool', 'GlobTool',
  ],
}
const r = await loadMcpRuntime(runtime)

// Whether tools start while a response streams is a remote gate; pin it on so
// the final round is also checked on that path, where a tool could start
// before the response is complete.
const STREAMING_GATE = /checkStatsigFeatureGate_CACHED_MAY_BE_STALE\(\s*"tengu_streaming_tool_execution2"\s*\)/
let gatePinned = 0
const streaming = await loadMcpRuntime({
  ...runtime,
  transform: source => source.replace(STREAMING_GATE, () => (gatePinned++, 'true')),
})
assert.equal(gatePinned, 1, 'the streaming gate is pinned in the second runtime')

let ids = 0
const newTaskId = () => `b${String(++ids).padStart(8, '0')}`

function harness(rt) {
  function writeLog(id, text) {
    const path = rt.getTaskOutputPath(id)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    return path
  }

  /** A backgrounded shell command in file mode, as spawnShellTask leaves it. */
  function runningShellTask(id, overrides = {}) {
    return {
      id, type: 'local_bash', status: 'running',
      description: 'bun install --frozen-lockfile', command: 'bun install --frozen-lockfile',
      startTime: Date.now() - 4 * 60_000, outputFile: rt.getTaskOutputPath(id), outputOffset: 0,
      notified: false, completionStatusSentInAttachment: false, lastReportedTotalLines: 0,
      isBackgrounded: true,
      shellCommand: { taskOutput: { taskId: id, path: rt.getTaskOutputPath(id), stdoutToFile: true }, kill() {}, cleanup() {} },
      ...overrides,
    }
  }

  function session(tools, { tasks = {}, agentId } = {}) {
    const base = fixtureContext(tools).getAppState()
    const store = rt.createStore(
      { ...base, tasks, settings: {}, speculation: { status: 'idle' } },
      rt.onChangeAppState,
    )
    const context = fixtureContext(tools, {
      getAppState: store.getState, setAppState: store.setState,
      readFileState: new Map(), ...(agentId && { agentId }),
      // REPL callbacks the tool runner reports into.
      setInProgressToolUseIDs: () => {}, setHasInterruptibleToolInProgress: () => {},
    })
    context.options.mainLoopModel = 'fixture-model'
    return { store, context }
  }

  /**
   * Drive the real query loop with a scripted model. `respond(n, messages)`
   * returns the content of model response n (1-based); the run fails if the
   * loop never ends.
   */
  async function drive({ context, respond, limit = 40 }) {
    const requests = []
    const yielded = []
    const iterator = rt.query({
      messages: [rt.createUserMessage({ content: 'Update this repo to the latest version and install it.' })],
      systemPrompt: [], userContext: {}, systemContext: {},
      canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      toolUseContext: context, querySource: 'repl_main_thread',
      deps: {
        uuid: () => `fixture-${requests.length}`,
        microcompact: async messages => ({ messages }),
        autocompact: async () => ({ compactionResult: undefined, consecutiveFailures: 0 }),
        callModel: async function* ({ messages }) {
          requests.push(messages)
          assert.ok(requests.length <= limit, 'the loop never ended')
          yield rt.createAssistantMessage({ content: respond(requests.length, messages) })
        },
      },
    })
    for (;;) {
      const step = await iterator.next()
      if (step.done) return { terminal: step.value, requests, yielded }
      yielded.push(step.value)
    }
  }

  /**
   * The reported session, round after round: TaskOutput on the install, a read
   * of its log, and a socket count that never changes.
   */
  function pollingSession({ agentId } = {}) {
    const id = newTaskId()
    const logPath = writeLog(id, 'bun install v1.4.0\nResolving dependencies\n')
    const probe = fixtureTool({ name: 'Probe', async call(input) { probe.calls.push(input); return { data: '8' } } })
    const readLog = fixtureTool({ name: 'ReadLog', async call() { return { data: 'File unchanged since last read.' } } })
    const { context } = session([rt.TaskOutputTool, probe, readLog], {
      tasks: { [id]: runningShellTask(id, agentId ? { agentId } : {}) }, agentId,
    })
    let n = 0
    const poll = () => (n++, [
      { type: 'tool_use', id: `toolu_${n}_out`, name: 'TaskOutput', input: { task_id: id, block: false } },
      { type: 'tool_use', id: `toolu_${n}_log`, name: 'ReadLog', input: { file_path: logPath } },
      { type: 'tool_use', id: `toolu_${n}_probe`, name: 'Probe', input: { what: 'tcp connections of the install' } },
    ])
    return { id, probe, context, poll }
  }

  return { writeLog, runningShellTask, session, drive, pollingSession }
}

const { writeLog, runningShellTask, session, drive, pollingSession } = harness(r)

const resultText = (tool, data) =>
  tool.mapToolResultToToolResultBlockParam(data, 'toolu_fixture').content
const text = message => {
  // System messages carry their text at the top level.
  const content = message?.type === 'system' ? message.content : message?.message?.content
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(b => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '')).join('\n') : ''
}
const sawText = (messages, needle) => messages.some(m => text(m).includes(needle))
const toolResults = messages => messages.filter(m => m.type === 'user')
  .flatMap(m => (Array.isArray(m.message.content) ? m.message.content : []))
  .filter(b => b.type === 'tool_result')
const NUDGE = 'Checking again will not make it finish sooner'
const FINAL = 'Tau is ending this'

// --- TaskOutput: what a check on a running task shows -------------------------

test('a check on a long log shows its newest output, says it was cut, and where the rest is', async () => {
  const id = newTaskId()
  const lines = ['bun install v1.4.0 (first line)']
  for (let i = 1; i <= 800; i++) lines.push(`[${i}ms] resolved package-${i}@1.0.${i} downloaded and extracted`)
  lines.push('NEWEST: 1342 packages installed')
  const path = writeLog(id, lines.join('\n'))
  const { context } = session([], { tasks: { [id]: runningShellTask(id) } })

  const { data } = await r.TaskOutputTool.call({ task_id: id, block: false, timeout: 0 }, context)
  assert.equal(data.retrieval_status, 'not_ready')
  const shown = resultText(r.TaskOutputTool, data)
  assert.ok(shown.includes('NEWEST: 1342 packages installed'), 'the end of the log is what is shown')
  assert.ok(!shown.includes('(first line)'), 'the start of a long log is the part left out')
  assert.ok(shown.includes('[Truncated. Full output:') && shown.includes(path), 'the cut is announced with the file')
  assert.match(shown, /<progress>Running for 4m[^<]*of output so far\.[^<]*Last output \d+s ago\.<\/progress>/)
  assert.match(shown, /<note>Still running\. Tau sends you a <task-notification> when it finishes[^<]*end your turn\.<\/note>$/)
})

test('repeated checks say whether anything new arrived since the last one', async () => {
  const id = newTaskId()
  const path = writeLog(id, 'Resolving dependencies\n')
  const { context } = session([], { tasks: { [id]: runningShellTask(id) } })
  const check = async () => resultText(r.TaskOutputTool,
    (await r.TaskOutputTool.call({ task_id: id, block: false, timeout: 0 }, context)).data)

  assert.ok(!(await check()).includes('since your last check'), 'nothing to compare on the first check')
  assert.match(await check(), /Nothing new since your last check \d+s ago\./)
  appendFileSync(path, 'Resolved, downloaded and extracted [16]\n')
  assert.match(await check(), /\d+ bytes new since your last check/)
})

test('a live command holding its log open: growth while it writes, quiet time once it stalls', async () => {
  // A separate process keeps the log open and appends whatever it is sent, as
  // a running command does; then it stays alive without writing, as a hung one does.
  const id = newTaskId()
  const path = writeLog(id, '')
  const { context } = session([], { tasks: { [id]: runningShellTask(id) } })
  const writer = spawn(process.execPath, ['-e',
    "const fs = require('fs'); const fd = fs.openSync(process.argv[1], 'a'); process.stdin.on('data', d => fs.writeSync(fd, d))",
    path], { stdio: ['pipe', 'ignore', 'inherit'] })
  const exited = new Promise(resolve => writer.on('exit', resolve))
  const sizeReaches = async bytes => {
    for (let i = 0; i < 500 && statSync(path).size < bytes; i++) await new Promise(res => setTimeout(res, 10))
    assert.ok(statSync(path).size >= bytes, 'the writer process wrote')
  }
  const check = async () => resultText(r.TaskOutputTool,
    (await r.TaskOutputTool.call({ task_id: id, block: false, timeout: 0 }, context)).data)
  try {
    writer.stdin.write('Resolving dependencies\n')
    await sizeReaches(23)
    assert.match(await check(), /23 bytes of output so far\./)
    writer.stdin.write('Resolved, downloaded and extracted [16]\n')
    await sizeReaches(63)
    assert.match(await check(), /40 bytes new since your last check/)
    await new Promise(res => setTimeout(res, 1_200))
    const stalled = await check()
    assert.match(stalled, /Nothing new since your last check [1-9]\d*s ago\./)
    assert.match(stalled, /Last output [1-9]\d*s ago\./, 'the quiet time is read from the log itself')
  } finally {
    writer.stdin.end()
    await exited
  }
})

test('a quiet command says so, and a blocking check that times out says the same', async () => {
  const id = newTaskId()
  writeLog(id, '')
  const { context } = session([], { tasks: { [id]: runningShellTask(id) } })
  const { data } = await r.TaskOutputTool.call({ task_id: id, block: true, timeout: 40 }, context)
  assert.equal(data.retrieval_status, 'timeout')
  const shown = resultText(r.TaskOutputTool, data)
  assert.match(shown, /<progress>Running for 4m[^<]*No output yet\.<\/progress>/)
  assert.ok(shown.includes('<note>Still running.'))
})

test('a subagent is told to wait once, not to end its turn', async () => {
  const id = newTaskId()
  writeLog(id, 'compiling\n')
  const { context } = session([], { tasks: { [id]: runningShellTask(id, { agentId: 'a-sub' }) }, agentId: 'a-sub' })
  const { data } = await r.TaskOutputTool.call({ task_id: id, block: false, timeout: 0 }, context)
  assert.match(data.note, /wait once with block: true and a long timeout \(up to 600000 ms\)/)
  assert.ok(!data.note.includes('end your turn'))
})

test('a finished task reports its result, with no progress or note', async () => {
  const id = newTaskId()
  writeLog(id, 'done\n')
  const { store, context } = session([], { tasks: { [id]: runningShellTask(id) } })
  r.updateTaskState(id, store.setState, t => ({ ...t, status: 'completed', result: { code: 0, interrupted: false } }))
  const { data } = await r.TaskOutputTool.call({ task_id: id, block: false, timeout: 0 }, context)
  assert.equal(data.retrieval_status, 'success')
  assert.equal(data.progress, undefined)
  assert.equal(data.note, undefined)
})

test('a backgrounded command is told its completion will be reported, in Bash and PowerShell', () => {
  for (const tool of [r.BashTool, r.PowerShellTool]) {
    for (const extra of [{}, { backgroundedByUser: true }]) {
      const shown = resultText(tool, { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b00000abc', ...extra })
      assert.ok(shown.includes('<task-notification>') && shown.includes('no need to poll'), `${tool.name}: ${shown}`)
    }
  }
})

// --- the query loop: a model that will not stop polling -----------------------

for (const [label, rt] of [['tools run after the response', r], ['tools start while it streams', streaming]]) {
  test(`${label}: a model that ignores every instruction is stopped after one final round`, async () => {
    const { id, probe, context, poll } = harness(rt).pollingSession()
    const { terminal, requests, yielded } = await harness(rt).drive({ context, respond: () => poll() })

    assert.equal(terminal.reason, 'wait_loop_stopped')
    assert.equal(requests.length, 6, 'five rounds of checks, then the final response')
    assert.equal(probe.calls.length, 5, 'nothing ran in the final response')
    assert.equal(requests.findIndex(messages => sawText(messages, NUDGE)), 3, 'nudged after the third round')
    assert.ok(sawText(requests[3], id) && sawText(requests[3], '<task-notification>'))
    assert.ok(sawText(requests[5], FINAL) && !sawText(requests[4], FINAL), 'the final instruction comes once, last')

    const notRun = toolResults(yielded).filter(b => b.tool_use_id.startsWith('toolu_6_'))
    assert.equal(notRun.length, 3, 'every call in the final response is answered')
    assert.ok(notRun.every(b => b.is_error && b.content.startsWith('Not run:')))
    const notice = yielded.find(m => m.type === 'system' && text(m).includes('Stopped the agent'))
    assert.ok(notice && text(notice).includes(id), 'the user is told why, and which task')
  })
}

test('every check the model saw carried progress and the instruction to stop checking', async () => {
  const { context, poll } = pollingSession()
  const { yielded } = await drive({ context, respond: () => poll() })
  const checks = toolResults(yielded).filter(b => b.tool_use_id.endsWith('_out') && !b.is_error)
  assert.equal(checks.length, 5)
  for (const check of checks) {
    assert.match(check.content, /<progress>Running for/)
    assert.match(check.content, /<note>Still running\./)
  }
})

test('a model that reports when told to stop ends the turn with its own words', async () => {
  const { context, poll } = pollingSession()
  const { terminal, requests, yielded } = await drive({
    context,
    respond: (_n, messages) => sawText(messages, FINAL)
      ? [{ type: 'text', text: 'The install is still running; I will report when it finishes.' }]
      : poll(),
  })
  assert.notEqual(terminal.reason, 'wait_loop_stopped')
  assert.equal(requests.length, 6)
  assert.ok(!yielded.some(m => m.type === 'system' && text(m).includes('Stopped the agent')))
  assert.ok(sawText(yielded.filter(m => m.type === 'assistant'), 'I will report when it finishes'))
})

test('a model that takes the nudge ends its turn without being stopped', async () => {
  const { context, poll } = pollingSession()
  const { terminal, requests } = await drive({
    context,
    respond: (_n, messages) => sawText(messages, NUDGE)
      ? [{ type: 'text', text: 'Still installing. I will pick it up when it finishes.' }]
      : poll(),
  })
  assert.notEqual(terminal.reason, 'wait_loop_stopped')
  assert.equal(requests.length, 4)
})

test('a subagent gets the subagent wording and is stopped the same way', async () => {
  const { context, poll } = pollingSession({ agentId: 'a-sub' })
  const { terminal, requests } = await drive({ context, respond: () => poll() })
  assert.equal(terminal.reason, 'wait_loop_stopped')
  assert.ok(sawText(requests[3], 'wait for it once with TaskOutput (block: true'))
  assert.ok(!sawText(requests[3], 'end your turn'))
  assert.ok(sawText(requests[5], 'Tau is ending this run'))
})

// The query loop counts a call as an edit when its tool declares a file path
// and the call is not read-only. Pin that for the real tools.
test('edits are recognized from the tools\' own declarations', () => {
  const isEdit = tool => tool.getPath !== undefined && !tool.isReadOnly({})
  for (const tool of [r.FileEditTool, r.FileWriteTool, r.NotebookEditTool]) {
    assert.ok(isEdit(tool), `${tool.name} edits files`)
  }
  for (const tool of [r.FileReadTool, r.GrepTool, r.GlobTool, r.TaskOutputTool, r.BashTool, r.PowerShellTool]) {
    assert.ok(!isEdit(tool), `${tool.name} is not an edit`)
  }
  // A probe run through a shell must never look like work, or it would reset the count.
  assert.equal(r.BashTool.getPath, undefined)
  assert.equal(r.PowerShellTool.getPath, undefined)
})

/** Alternate `between` with a read of a dev server's log, then answer in text. */
async function devServerSession(between) {
  const id = newTaskId()
  const logPath = writeLog(id, 'VITE v6 ready in 312 ms\n  Local: http://localhost:5173/\n')
  const { context } = session([between, fixtureTool({ name: 'ReadLog', async call() { return { data: 'File unchanged since last read.' } } })], {
    tasks: { [id]: runningShellTask(id, { description: 'npm run dev', command: 'npm run dev' }) },
  })
  return drive({
    context,
    respond: n => n > 20
      ? [{ type: 'text', text: 'The page renders.' }]
      : n % 2
        ? [{ type: 'tool_use', id: `toolu_${n}`, name: between.name, input: { file_path: 'src/App.tsx', n } }]
        : [{ type: 'tool_use', id: `toolu_${n}`, name: 'ReadLog', input: { file_path: logPath } }],
  })
}

test('reading a dev server log after each edit is work, never waiting', async () => {
  const editor = fixtureTool({ name: 'EditFile', isReadOnly: () => false, getPath: input => input.file_path })
  const { terminal, requests } = await devServerSession(editor)
  assert.notEqual(terminal.reason, 'wait_loop_stopped')
  assert.equal(requests.length, 21, 'ten edits and ten log reads, then the answer')
  assert.ok(!requests.some(messages => sawText(messages, NUDGE)))
})

test('the same rhythm without edits is waiting, and is stopped', async () => {
  const lint = fixtureTool({ name: 'LintFile', getPath: input => input.file_path })
  const { terminal, requests } = await devServerSession(lint)
  assert.equal(terminal.reason, 'wait_loop_stopped', 'reads separated only by read-only calls are waiting')
  assert.ok(requests.length < 21)
})

// repeatToolGuard appends its own reminder to the 3rd and 5th identical call in a
// row. The guard must neither mistake that for a new answer nor say it twice.
const REPEAT_REMINDER = 'times in a row with identical arguments. Analyze the result'

test("Tau's repeat reminder and the guard work together, without repeating each other", async () => {
  // Waiting on a job: both speak, they say different things, and the stop still comes.
  const id = newTaskId()
  writeLog(id, 'Resolving dependencies\n')
  const waiting = session([fixtureTool({ name: 'Probe', async call() { return { data: '8' } } })], { tasks: { [id]: runningShellTask(id) } })
  const blocked = await drive({ context: waiting.context, respond: () => [{ type: 'tool_use', id: `toolu_p${Math.random()}`, name: 'Probe', input: { what: 'sockets' } }] })
  assert.ok(sawText(blocked.requests[3], REPEAT_REMINDER) && sawText(blocked.requests[3], 'same result each time'))
  assert.equal(blocked.terminal.reason, 'wait_loop_stopped')
  assert.equal(blocked.requests.length, 7)

  // Nothing to wait for: the existing reminder alone, and no stop.
  const idle = session([fixtureTool({ name: 'CiStatus', async call() { return { data: '{"status":"in_progress"}' } } })])
  const { terminal, requests } = await drive({
    context: idle.context,
    respond: n => (n > 8 ? [{ type: 'text', text: 'Still in progress.' }] : [{ type: 'tool_use', id: `toolu_c${n}`, name: 'CiStatus', input: { run: 123 } }]),
  })
  assert.ok(sawText(requests[3], REPEAT_REMINDER))
  assert.ok(!requests.some(messages => sawText(messages, 'same result each time')))
  assert.notEqual(terminal.reason, 'wait_loop_stopped')
})

test('work that makes progress, with nothing in the background, is never interrupted', async () => {
  let runs = 0
  const testRunner = fixtureTool({ name: 'RunTests', async call() { runs++; return { data: `${Math.max(0, 6 - runs)} failed` } } })
  const editor = fixtureTool({ name: 'EditFile', async call(input) { return { data: `edited ${input.n}` } } })
  const { context } = session([testRunner, editor])
  const { terminal, requests } = await drive({
    context,
    respond: n => n > 12
      ? [{ type: 'text', text: 'All tests pass.' }]
      : n % 2
        ? [{ type: 'tool_use', id: `toolu_${n}`, name: 'EditFile', input: { n } }]
        : [{ type: 'tool_use', id: `toolu_${n}`, name: 'RunTests', input: {} }],
  })
  assert.notEqual(terminal.reason, 'wait_loop_stopped')
  assert.equal(requests.length, 13)
  assert.ok(!requests.some(messages => sawText(messages, 'same result each time') || sawText(messages, NUDGE)))
})
