// Run after `node build.mjs`: node --test test/agent-name-session-lifecycle.test.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const tempRoot = mkdtempSync(join(tmpdir(), 'tau-agent-names-'))
Object.assign(process.env, {
  NODE_ENV: 'test', USER_TYPE: 'external',
  CLAUDE_CONFIG_DIR: tempRoot, CLAUDE_CODE_TMPDIR: tempRoot,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
})

// Exercise the shipped session transitions, without invoking the CLI or a model.
// These modules use build-only shims, so import them from the production bundle.
const distPath = resolve('dist/tau.mjs')
let bundle = readFileSync(distPath, 'utf8')
const invocation = /\nvoid main\d*\(\);\r?\n/g
assert.equal(bundle.match(invocation)?.length, 1)
bundle = bundle.replace(invocation, '\n')
bundle += `
export function __agentNameLifecycle() {
  init_conversation(); init_sessionRestore(); init_AppStateStore(); init_store();
  init_SendMessageTool(); init_LocalAgentTask(); init_framework(); init_resumeParity();
  // Only replace model-backed resumption. Keep real name resolution, task
  // lifecycle, message queues, and session cleanup.
  const resumeCalls = [];
  resumeAgentBackground = async ({ agentId }) => {
    resumeCalls.push(agentId);
    return { outputFile: 'fixture-output' };
  };
  return { clearConversation, restoreSessionStateFromLog, getDefaultAppState, createStore,
    SendMessageTool, resumeCalls, completeAgentTask, failAgentTask, killAsyncAgent,
    evictTerminalTask, unregisterAgentForeground, rememberAgentConversation, getAgentConversation };
}
`
const auditPath = join(dirname(distPath), `.agent-name-lifecycle-${randomUUID()}.mjs`)
writeFileSync(auditPath, bundle)
let runtime
try {
  runtime = (await import(pathToFileURL(auditPath).href)).__agentNameLifecycle()
} finally {
  unlinkSync(auditPath)
}
after(() => rmSync(tempRoot, { recursive: true, force: true }))

function fixture() {
  const store = runtime.createStore(runtime.getDefaultAppState())
  const names = new Map([
    ['audit-review', 'a11111111'],
    ['completed-review', 'a22222222'],
    ['failed-review', 'a33333333'],
    ['evicted-review', 'a44444444'],
    ['still-working', 'a55555555'],
    ['pending-review', 'a66666666'],
    ['foreground-review', 'a77777777'],
  ])
  const tasks = {}
  for (const [name, status] of [
    ['audit-review', 'killed'], ['completed-review', 'completed'],
    ['failed-review', 'failed'], ['still-working', 'running'],
    ['pending-review', 'pending'], ['foreground-review', 'running'],
  ]) {
    const id = names.get(name)
    tasks[id] = {
      id, agentId: id, type: 'local_agent', agentType: 'general-purpose', status,
      isBackgrounded: name !== 'foreground-review',
      abortController: new AbortController(), pendingMessages: [],
    }
  }
  store.setState(prev => ({ ...prev, tasks, agentNameRegistry: names }))
  return store
}

function send(store, to) {
  return runtime.SendMessageTool.call({ to, message: 'Follow up.', summary: 'Follow up' }, {
    getAppState: store.getState, setAppState: store.setState,
  }, async () => ({ behavior: 'allow' }))
}

for (const transition of ['clear', 'resume']) {
  test(`${transition} drops previous-session names and preserves active background agents`, async () => {
    const store = fixture()
    const before = store.getState()
    const cachedConversation = [
      { type: 'user', message: { role: 'user', content: 'Review the implementation.' } },
      { type: 'attachment', attachment: { type: 'system_reminder', content: 'Keep this cached prefix.' } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'Reviewing.' },
      ] } },
    ]
    runtime.rememberAgentConversation('a55555555', cachedConversation)
    const cachedPrefix = JSON.stringify(runtime.getAgentConversation('a55555555'))
    if (transition === 'clear') {
      await runtime.clearConversation({
        setMessages: () => {}, readFileState: new Map(),
        getAppState: store.getState, setAppState: store.setState,
      })
    } else {
      runtime.restoreSessionStateFromLog({}, store.setState)
    }
    assert.deepEqual([...store.getState().agentNameRegistry.keys()], [
      'still-working', 'pending-review',
    ])
    assert.equal(before.agentNameRegistry.size, 7, 'do not mutate prior state')
    assert.equal(JSON.stringify(runtime.getAgentConversation('a55555555')), cachedPrefix,
      'preserve the exact cached agent conversation, including attachments')
    for (const name of ['still-working', 'pending-review']) {
      const id = before.agentNameRegistry.get(name)
      assert.equal(store.getState().tasks[id], before.tasks[id])
      assert.equal(before.tasks[id].abortController.signal.aborted, false)
    }
    assert.equal((await send(store, 'still-working')).data.success, true)
    assert.deepEqual(store.getState().tasks.a55555555.pendingMessages, ['Follow up.'])
    const resumes = runtime.resumeCalls.length
    const stale = await send(store, 'audit-review')
    assert.equal(stale.data.success, false)
    assert.match(stale.data.message, /No agent named "audit-review" in this session/)
    assert.equal(runtime.resumeCalls.length, resumes, 'do not resume an old-session name')
  })
}

for (const status of ['completed', 'failed', 'killed', 'foreground-completed']) {
  test(`${status} agents remain addressable in the current session, including after eviction`, async () => {
    const store = fixture()
    const id = status === 'foreground-completed' ? 'a77777777' : 'a55555555'
    const name = status === 'foreground-completed' ? 'foreground-review' : 'still-working'
    if (status === 'completed') runtime.completeAgentTask({ agentId: id }, store.setState)
    else if (status === 'failed') runtime.failAgentTask(id, 'Test failure', store.setState)
    else if (status === 'killed') runtime.killAsyncAgent(id, store.setState)
    else runtime.unregisterAgentForeground(id, store.setState)

    assert.equal(store.getState().agentNameRegistry.get(name), id)
    if (status !== 'foreground-completed') {
      assert.equal((await send(store, name)).data.success, true)
      assert.equal(runtime.resumeCalls.at(-1), id)
      // Expire the UI's retention window without waiting for its timer.
      store.setState(prev => ({ ...prev, tasks: { ...prev.tasks,
        [id]: { ...prev.tasks[id], notified: true, retain: false, evictAfter: 0 },
      } }))
      runtime.evictTerminalTask(id, store.setState)
    }
    assert.equal(store.getState().tasks[id], undefined)
    assert.equal((await send(store, name)).data.success, true)
    assert.equal(runtime.resumeCalls.at(-1), id, 'current-session transcript remains resumable')
  })
}

test('session switches do not carry aborted agents or unrelated task types', () => {
  const store = fixture()
  store.getState().tasks.a55555555.abortController.abort()
  store.setState(prev => ({ ...prev, tasks: { ...prev.tasks,
    a66666666: { ...prev.tasks.a66666666, type: 'local_bash' },
    a77777777: { ...prev.tasks.a77777777, isBackgrounded: true, agentType: 'main-session' },
  } }))
  runtime.restoreSessionStateFromLog({}, store.setState)
  assert.equal(store.getState().agentNameRegistry.size, 0)
})
