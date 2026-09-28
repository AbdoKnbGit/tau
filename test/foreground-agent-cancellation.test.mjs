import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// Exercise the shipped AgentTool and task registry. Only the model-backed
// iterator is replaced, with a pending request that observes its actual signal.
const tempRoot = mkdtempSync(join(tmpdir(), 'tau-agent-cancellation-'))
process.env.CLAUDE_CODE_TMPDIR = tempRoot
process.env.CLAUDE_CONFIG_DIR = tempRoot
delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
delete process.env.CLAUDE_AUTO_BACKGROUND_TASKS

const distPath = resolve('dist/tau.mjs')
let bundle = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
const agentToolName = bundle.match(/(AgentTool\d*) = buildTool\(/)?.[1]
assert.ok(agentToolName, 'AgentTool must be present in the built runtime')
bundle += `
export function __agentCancellation(makeStream) {
  init_AgentTool(); init_LocalAgentTask(); init_store(); init_sdkEventQueue();
  runAgent = makeStream;
  return { AgentTool: ${agentToolName}, LocalAgentTask, backgroundAgentTask, createStore,
    AbortError, drainSdkEvents, getCommandQueueSnapshot, clearCommandQueue };
}
`
const auditPath = join(dirname(distPath), `.agent-cancellation-${process.pid}.mjs`)
writeFileSync(auditPath, bundle)
let loadRuntime
try {
  loadRuntime = (await import(pathToFileURL(auditPath).href)).__agentCancellation
} finally {
  unlinkSync(auditPath)
}
test.after(() => rmSync(tempRoot, { recursive: true, force: true }))

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function fixture() {
  const started = deferred()
  const finished = deferred()
  const completion = deferred()
  let request
  let starts = 0
  const runtime = loadRuntime(async function* (params) {
    starts++
    request = params
    const signal = params.override.abortController.signal
    started.resolve()
    try {
      const onAbort = () => completion.resolve({ error: new runtime.AbortError() })
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      try {
        const { error } = await completion.promise
        if (error) throw error
        yield {
          type: 'assistant', uuid: 'test-response', timestamp: new Date().toISOString(),
          message: { id: 'test-response', role: 'assistant', model: 'test-model',
            content: [{ type: 'text', text: 'Done.' }],
            usage: { input_tokens: 2, output_tokens: 1 } },
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    } finally {
      finished.resolve()
    }
  })
  runtime.drainSdkEvents()
  runtime.clearCommandQueue()
  const store = runtime.createStore({
    tasks: {},
    toolPermissionContext: {
      mode: 'default', additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
    },
    mcp: { clients: [], tools: [] },
    speculation: { status: 'idle' },
  })
  const parent = new AbortController()
  const context = {
    getAppState: store.getState,
    setAppState: store.setState,
    abortController: parent,
    toolUseId: 'foreground-test-tool',
    messages: [],
    options: {
      tools: [], mcpClients: [], mainLoopModel: 'test-model',
      agentDefinitions: { activeAgents: [{
        agentType: 'cancellation-test', source: 'projectSettings',
        getSystemPrompt: () => 'Test agent.',
      }] },
    },
  }
  const outcome = runtime.AgentTool.call({
    subagent_type: 'cancellation-test', description: 'Test cancellation', prompt: 'Wait.',
  }, context, async () => ({ behavior: 'allow' }), {
    message: { id: 'foreground-test-message' },
  }).then(value => ({ value }), error => ({ error }))
  return { runtime, store, parent, context, outcome, started, finished, completion,
    request: () => request, starts: () => starts }
}

async function withRunningAgent(fn) {
  const f = fixture()
  try {
    await Promise.race([
      f.started.promise,
      f.outcome.then(outcome => { throw outcome.error ?? new Error('Agent never started') }),
    ])
    await fn(f, Object.values(f.store.getState().tasks)[0])
  } finally {
    f.request()?.override.abortController.abort()
    await f.outcome
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('dialog kill aborts the running foreground request without cancelling the turn', async () => {
  await withRunningAgent(async (f, task) => {
    assert.equal(task.isBackgrounded, false)
    await f.runtime.LocalAgentTask.kill(task.id, f.store.setState)
    assert.equal(f.request().override.abortController.signal.aborted, true)
    assert.equal(f.parent.signal.aborted, false)
    assert.equal(f.starts(), 1)
    assert.ok((await f.outcome).error instanceof f.runtime.AbortError)
    assert.equal(f.store.getState().tasks[task.id], undefined)
    assert.equal(getEventListeners(f.parent.signal, 'abort').length, 0)
    assert.equal(getEventListeners(task.abortController.signal, 'abort').length, 0)
    const terminal = f.runtime.drainSdkEvents().filter(e => e.subtype === 'task_notification')
    assert.equal(terminal.length, 1)
    assert.equal(terminal[0].status, 'stopped')
  })
})

test('background handoff keeps the same request and can still be killed', async () => {
  await withRunningAgent(async (f, task) => {
    const request = f.request()
    assert.equal(f.runtime.backgroundAgentTask(task.id, f.store.getState, f.store.setState), true)
    assert.equal((await f.outcome).value.data.status, 'async_launched')
    f.parent.abort()
    assert.equal(request.override.abortController.signal.aborted, false)
    await f.runtime.LocalAgentTask.kill(task.id, f.store.setState)
    assert.equal(request.override.abortController.signal.aborted, true)
    await f.finished.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.request(), request)
    assert.equal(f.starts(), 1)
    assert.equal(f.store.getState().tasks[task.id].status, 'killed')
    assert.equal(getEventListeners(f.parent.signal, 'abort').length, 0)
    assert.equal(getEventListeners(task.abortController.signal, 'abort').length, 0)
  })
})

test('kill during background handoff does not dereference a cleared controller', async () => {
  await withRunningAgent(async (f, task) => {
    f.runtime.backgroundAgentTask(task.id, f.store.getState, f.store.setState)
    // No await: kill clears the registry's controller before handoff resumes.
    void f.runtime.LocalAgentTask.kill(task.id, f.store.setState)
    const outcome = await f.outcome
    assert.ok(!outcome.error || outcome.error instanceof f.runtime.AbortError, String(outcome.error))
    assert.equal(f.request().override.abortController.signal.aborted, true)
    assert.equal(f.parent.signal.aborted, false)
    assert.equal(f.store.getState().tasks[task.id].status, 'killed')
  })
})

test('Esc still aborts foreground execution and reports stopped', async () => {
  await withRunningAgent(async (f) => {
    f.parent.abort('Esc')
    assert.equal(f.request().override.abortController.signal.reason, 'Esc')
    assert.ok((await f.outcome).error instanceof f.runtime.AbortError)
    const terminal = f.runtime.drainSdkEvents().filter(e => e.subtype === 'task_notification')
    assert.equal(terminal[0].status, 'stopped')
  })
})

for (const error of [undefined, new Error('request failed')]) {
  test(`${error ? 'failure' : 'completion'} removes task and parent cancellation listeners`, async () => {
    await withRunningAgent(async (f, task) => {
      f.completion.resolve({ error })
      const outcome = await f.outcome
      if (error) assert.equal(outcome.error, error)
      else assert.equal(outcome.value.data.status, 'completed')
      assert.equal(f.parent.signal.aborted, false)
      assert.equal(f.store.getState().tasks[task.id], undefined)
      assert.equal(getEventListeners(f.parent.signal, 'abort').length, 0)
      assert.equal(getEventListeners(task.abortController.signal, 'abort').length, 0)
      task.abortController.abort()
      assert.equal(f.request().override.abortController.signal.aborted, false)
    })
  })
}
