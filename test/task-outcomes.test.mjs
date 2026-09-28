import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// Every Tau instance loaded here shares one throwaway temp root, so a second
// instance is a restart of the first (a new process with a new session id).
const tempRoot = mkdtempSync(join(tmpdir(), 'tau-task-outcomes-'))
process.env.CLAUDE_CODE_TMPDIR = tempRoot

const distPath = resolve('dist/tau.mjs')
let bundle = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
bundle += `
export function __taskOutcomes() {
  init_state(); init_store(); init_framework(); init_diskOutput();
  init_taskOutcomes(); init_stopTask(); init_TaskStopTool();
  init_TaskOutputTool(); init_onChangeAppState(); init_LocalShellTask();
  init_messageQueueManager(); init_sdkEventQueue(); init_sessionStorage();
  return { createStore, onChangeAppState, registerTask, updateTaskState,
    generateTaskAttachments, applyTaskOffsetsAndEvictions, getTaskOutputPath,
    getTaskOutputDir, getSessionId, switchSession, findEndedTask, stopTask,
    TaskStopTool, TaskOutputTool, spawnShellTask, getCommandQueueSnapshot,
    getCommandsByMaxPriority, clearCommandQueue, taskNotificationSdkEvent,
    wrapCommandText, isLoggableMessage };
}
`

let loads = 0
async function loadTau() {
  const path = join(dirname(distPath), `.task-outcomes-${process.pid}-${loads++}.mjs`)
  writeFileSync(path, bundle)
  try {
    return (await import(pathToFileURL(path).href)).__taskOutcomes()
  } finally {
    unlinkSync(path)
  }
}

function session(tau) {
  const store = tau.createStore(
    {
      tasks: {},
      toolPermissionContext: { mode: 'default' },
      settings: {},
      speculation: { status: 'idle' },
    },
    tau.onChangeAppState,
  )
  const context = {
    getAppState: store.getState,
    setAppState: store.setState,
    abortController: new AbortController(),
  }
  return { store, context }
}

let idCounter = 0
function taskId(prefix = 'b') {
  return prefix + String(idCounter++).padStart(8, '0').slice(-8)
}

function shellTask(tau, id, overrides = {}) {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    description: 'Launch the dashboard',
    command: 'python -m streamlit run app.py',
    startTime: Date.now(),
    outputFile: tau.getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
    completionStatusSentInAttachment: false,
    shellCommand: { kill() {}, cleanup() {} },
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    ...overrides,
  }
}

function writeOutput(tau, id, text) {
  const path = tau.getTaskOutputPath(id)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// The framework's own lazy GC: a terminal task is evicted as soon as its
// notification is queued (notified), before the model has read it.
async function evictFinished(tau, store) {
  const { updatedTaskOffsets, evictedTaskIds } =
    await tau.generateTaskAttachments(store.getState())
  tau.applyTaskOffsetsAndEvictions(store.setState, updatedTaskOffsets, evictedTaskIds)
}

function finishShell(tau, store, id, code) {
  tau.updateTaskState(id, store.setState, task => ({
    ...task,
    status: code === 0 ? 'completed' : 'failed',
    result: { code, interrupted: false },
    shellCommand: null,
    endTime: Date.now(),
    notified: true,
  }))
}

const first = await loadTau()
const firstSession = first.getSessionId()
const failedId = taskId()

test.after(() => rmSync(tempRoot, { recursive: true, force: true }))

test('a finished task keeps its outcome after eviction', async () => {
  const { store, context } = session(first)
  first.registerTask(shellTask(first, failedId), store.setState)
  writeOutput(first, failedId, 'Email: ')
  finishShell(first, store, failedId, 127)
  await evictFinished(first, store)
  assert.equal(store.getState().tasks[failedId], undefined)

  const input = { task_id: failedId }
  assert.deepEqual(await first.TaskStopTool.validateInput(input, context), { result: true })
  const stopped = await first.TaskStopTool.call(input, context)
  assert.match(
    stopped.data.message,
    /already finished \(status: failed, exit code 127\); nothing to stop/,
  )
  assert.ok(stopped.data.message.includes(first.getTaskOutputPath(failedId)))
  assert.equal(stopped.data.not_stopped, 'already finished (status: failed, exit code 127)')
  assert.equal(stopped.data.command, 'python -m streamlit run app.py')

  const outputInput = { task_id: failedId, block: false, timeout: 0 }
  assert.deepEqual(
    await first.TaskOutputTool.validateInput(outputInput, context),
    { result: true },
  )
  const output = await first.TaskOutputTool.call(outputInput, context)
  assert.equal(output.data.retrieval_status, 'success')
  assert.equal(output.data.task.status, 'failed')
  assert.equal(output.data.task.exitCode, 127)
  assert.equal(output.data.task.description, 'Launch the dashboard')
  assert.equal(output.data.task.output, 'Email: ')

  // The SDK stop_task request shares the lookup.
  await assert.rejects(
    () => first.stopTask(failedId, context),
    error =>
      error.code === 'not_running' &&
      /not running \(status: failed, exit code 127\)/.test(error.message),
  )
  assert.ok(existsSync(join(first.getTaskOutputDir(), `${failedId}.outcome.json`)))
})

async function waitFor(condition) {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(condition(), 'condition never became true')
}

// The reported case end to end: a background command exits 0.7 s after
// launch; the model, still in its turn, then stops it.
test('a background command that exits at once: notified at the next tool round, and stoppable as finished', async () => {
  const { store, context } = session(first)
  first.clearCommandQueue()
  const id = taskId()
  writeOutput(first, id, 'Welcome!\n\n      Email: ')
  let exit
  const shellCommand = {
    taskOutput: { taskId: id, flush: async () => {} },
    background: () => true,
    result: new Promise(resolve => {
      exit = resolve
    }),
    status: 'running',
    cleanup() {},
    kill() {},
  }
  await first.spawnShellTask(
    {
      command: 'python -m streamlit run app.py',
      description: 'Launch Streamlit dashboard',
      shellCommand,
      toolUseId: 'toolu_launch',
    },
    context,
  )
  exit({ code: 127, interrupted: false, stdout: '', stderr: '' })
  await waitFor(() => store.getState().tasks[id]?.notified === true)

  const queued = first
    .getCommandQueueSnapshot()
    .filter(command => command.value.includes(`<task-id>${id}</task-id>`))
  assert.equal(queued.length, 1)
  assert.equal(queued[0].mode, 'task-notification')
  // 'next' is what the mid-turn drain takes after a tool round.
  assert.equal(queued[0].priority, 'next')
  assert.ok(first.getCommandsByMaxPriority('next').includes(queued[0]))

  // The attachment pass that hands it over also evicts the task.
  await evictFinished(first, store)
  assert.equal(store.getState().tasks[id], undefined)
  const stopped = await first.TaskStopTool.call({ task_id: id }, context)
  assert.match(
    stopped.data.message,
    /already finished \(status: failed, exit code 127\); nothing to stop/,
  )
  first.clearCommandQueue()
})

test('a notification handed over mid-turn still closes the task for SDK consumers', () => {
  const xml = status =>
    `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/t/b1.output</output-file>${status}\n<summary>Background command "x" failed with exit code 127</summary>\n</task-notification>`
  assert.deepEqual(first.taskNotificationSdkEvent(xml('\n<status>failed</status>')), {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'b1',
    tool_use_id: 'toolu_1',
    status: 'failed',
    output_file: '/t/b1.output',
    summary: 'Background command "x" failed with exit code 127',
    usage: undefined,
  })
  assert.equal(first.taskNotificationSdkEvent(xml('\n<status>killed</status>')).status, 'stopped')
  assert.equal(first.taskNotificationSdkEvent(xml('\n<status>completed</status>')).status, 'completed')
  // A stall or progress ping has no <status> and must not close the task.
  assert.equal(first.taskNotificationSdkEvent(xml('')), null)
  const agent = first.taskNotificationSdkEvent(
    `${xml('\n<status>completed</status>')}<usage><total_tokens>12</total_tokens><tool_uses>3</tool_uses><duration_ms>40</duration_ms></usage>`,
  )
  assert.deepEqual(agent.usage, { total_tokens: 12, tool_uses: 3, duration_ms: 40 })
  assert.match(
    first.wrapCommandText('<task-notification/>', { kind: 'task-notification' }),
    /^A background task sent an update while you were working:\n/,
  )
})

// A notification handed over mid-turn is an attachment; attachments are not
// saved for external builds, so a resumed session lost it (and the history
// the model had seen, i.e. its prompt cache). One delivered between turns is
// a user message and was always saved.
test('a task notification handed over mid-turn is saved in the transcript', () => {
  const attachment = (commandMode, type = 'queued_command') => ({
    type: 'attachment',
    uuid: 'u1',
    attachment: { type, prompt: '<task-notification/>', commandMode },
  })
  assert.equal(first.isLoggableMessage(attachment('task-notification')), true)
  // Everything else keeps the external-build rule.
  assert.equal(first.isLoggableMessage(attachment('prompt')), false)
  assert.equal(first.isLoggableMessage(attachment(undefined, 'todo_reminder')), false)
  assert.equal(first.isLoggableMessage({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'hi' } }), true)
})

test('a running task is still stopped, and its stop is recorded', async () => {
  const { store, context } = session(first)
  const id = taskId()
  first.registerTask(shellTask(first, id), store.setState)
  const stopped = await first.TaskStopTool.call({ task_id: id }, context)
  assert.match(stopped.data.message, /^Successfully stopped task/)
  assert.equal(stopped.data.not_stopped, undefined)
  await evictFinished(first, store)
  const again = await first.TaskStopTool.call({ task_id: id }, context)
  assert.match(again.data.message, /already finished \(status: killed\)/)
})

test('an unknown id still fails and names the running tasks', async () => {
  const { store, context } = session(first)
  const running = taskId()
  first.registerTask(shellTask(first, running), store.setState)
  const missing = await first.TaskStopTool.validateInput({ task_id: 'bnotatask' }, context)
  assert.equal(missing.result, false)
  assert.match(missing.message, /^No task found with ID: bnotatask\. Running tasks: /)
  assert.ok(missing.message.includes(`${running} (Launch the dashboard)`))

  const empty = session(first)
  const none = await first.TaskOutputTool.validateInput(
    { task_id: 'bnotatask', block: false, timeout: 0 },
    empty.context,
  )
  assert.equal(none.message, 'No task found with ID: bnotatask. No background task is running.')
  await assert.rejects(() => first.stopTask('bnotatask', empty.context), error => error.code === 'not_found')
})

test('ids that are not file names never reach the file system', async () => {
  const { context } = session(first)
  for (const id of ['../x', '..\\x', 'a/b', 'C:x', '']) {
    assert.equal(await first.findEndedTask(id), null)
  }
  assert.equal((await first.TaskStopTool.validateInput({ task_id: '../x' }, context)).result, false)
})

test('a task that leaves before finishing is not recorded', async () => {
  const { store } = session(first)
  const id = taskId()
  first.registerTask(shellTask(first, id, { isBackgrounded: false }), store.setState)
  store.setState(prev => {
    const { [id]: _, ...rest } = prev.tasks
    return { ...prev, tasks: rest }
  })
  assert.equal(await first.findEndedTask(id), null)
})

test('a task that finishes again after a resume replaces its outcome', async () => {
  const { store, context } = session(first)
  const id = taskId()
  first.registerTask(shellTask(first, id), store.setState)
  finishShell(first, store, id, 1)
  first.registerTask(shellTask(first, id), store.setState)
  finishShell(first, store, id, 0)
  await evictFinished(first, store)
  const stopped = await first.TaskStopTool.call({ task_id: id }, context)
  assert.match(stopped.data.message, /already finished \(status: completed, exit code 0\)/)
  const saved = JSON.parse(
    readFileSync(join(first.getTaskOutputDir(), `${id}.outcome.json`), 'utf8'),
  )
  assert.equal(saved.status, 'completed')
  assert.equal(saved.exitCode, 0)
})

test("a sub-agent's final answer outlives its task", async () => {
  const { store, context } = session(first)
  const id = 'a0123456789abcdef'
  first.registerTask(
    {
      ...shellTask(first, id),
      type: 'local_agent',
      description: 'Review the parser',
      agentId: id,
      prompt: 'Review it',
      agentType: 'general-purpose',
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    },
    store.setState,
  )
  writeOutput(first, id, '{"type":"transcript line"}\n')
  first.updateTaskState(id, store.setState, task => ({
    ...task,
    status: 'completed',
    result: { agentId: id, content: [{ type: 'text', text: 'The parser is fine.' }] },
    endTime: Date.now(),
    evictAfter: 0,
    notified: true,
  }))
  await evictFinished(first, store)
  assert.equal(store.getState().tasks[id], undefined)
  const output = await first.TaskOutputTool.call({ task_id: id, block: false, timeout: 0 }, context)
  assert.equal(output.data.task.status, 'completed')
  assert.equal(output.data.task.output, 'The parser is fine.')
  const stopped = await first.TaskStopTool.call({ task_id: id }, context)
  assert.match(stopped.data.message, /already finished \(status: completed\)/)
  assert.equal(stopped.data.command, 'Review the parser')
})

test('an output file without an outcome is reported as not running here', async () => {
  const { context } = session(first)
  const id = taskId()
  writeOutput(first, id, 'old output')
  const stopped = await first.TaskStopTool.call({ task_id: id }, context)
  assert.match(stopped.data.message, /is not running in this Tau process .*nothing to stop here/)
  const output = await first.TaskOutputTool.call({ task_id: id, block: false, timeout: 0 }, context)
  assert.equal(output.data.task.status, 'unknown')
  assert.equal(output.data.task.output, 'old output')
})

test('after a restart, outcomes are found in the earlier session', async () => {
  const restarted = await loadTau()
  assert.notEqual(restarted.getSessionId(), firstSession)
  const { context } = session(restarted)
  const stopped = await restarted.TaskStopTool.call({ task_id: failedId }, context)
  assert.match(stopped.data.message, /already finished \(status: failed, exit code 127\)/)
  const output = await restarted.TaskOutputTool.call(
    { task_id: failedId, block: false, timeout: 0 },
    context,
  )
  assert.equal(output.data.task.exitCode, 127)
  assert.equal(output.data.task.output, 'Email: ')
})

test('after --resume, outcomes are read from the session folder', async () => {
  const resumed = await loadTau()
  resumed.switchSession(firstSession)
  assert.equal(resumed.getTaskOutputDir(), first.getTaskOutputDir())
  const ended = await resumed.findEndedTask(failedId)
  assert.equal(ended.kind, 'recorded')
  assert.equal(ended.outcome.exitCode, 127)
})
