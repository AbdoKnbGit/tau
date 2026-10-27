import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-queue-'))
const project = join(root, 'project'), config = join(root, 'config')
mkdirSync(project)
mkdirSync(config)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/queueProcessor.ts', 'src/utils/handlePromptSubmit.ts', 'src/utils/QueryGuard.ts',
    'src/query.ts', 'src/utils/plugins/mods/manager.ts', 'src/utils/processUserInput/processUserInput.ts', 'src/history.ts'],
  exports: ['processQueueIfReady', 'handlePromptSubmit', 'QueryGuard', 'query', 'createAssistantMessage',
    'enqueue', 'getCommandQueueLength', 'clearCommandQueue', 'startPluginMods', 'stopPluginMods', 'hasModEvent',
    'getModWarnings', 'setInlinePlugins', 'clearAllCaches', 'resetSettingsCache', 'setOriginalCwd',
    'setSessionTrustAccepted', 'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath',
    'createStore', 'onChangeAppState', 'runCleanupFunctions',
    'getPromptQueueDeps: () => ({executeUserPromptSubmitHooks, getAttachmentMessages})',
    'setPromptQueueDeps: d => {executeUserPromptSubmitHooks=d.executeUserPromptSubmitHooks; getAttachmentMessages=d.getAttachmentMessages}',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setIsInteractive(false)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const originalDeps = r.getPromptQueueDeps()
const empty = () => (async function* () {})()
r.setPromptQueueDeps({ executeUserPromptSubmitHooks: empty, getAttachmentMessages: empty })
const permit = async (_tool, input) => ({ behavior: 'allow', updatedInput: input })

afterEach(async () => { r.clearCommandQueue(); await r.stopPluginMods() })
after(async () => {
  r.setPromptQueueDeps(originalDeps)
  await r.stopPluginMods()
  await r.runCleanupFunctions()
  process.chdir(original)
  rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})

let serial = 0
async function startDropHook() {
  const plugin = join(root, `plugin-${++serial}`)
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  mkdirSync(join(plugin, 'hooks'))
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: `queue-fixture-${serial}`, version: '1.0.0' }))
  writeFileSync(join(plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  writeFileSync(join(plugin, 'hooks/register.ts'), `export function register(on) {
    let starts=0,completes=0;
    on('prompt.submit',async($,e,next)=>e.text.startsWith('drop ')?{drop:'queue policy'}:next(e));
    on('turn.start',async($,e,next)=>{starts++;return next(e)});
    on('turn.complete',async($,e,next)=>{completes++;await $.fs.write('queue-turns.json',JSON.stringify({starts,completes}));return next(e)});
  }`)
  r.setInlinePlugins([plugin]); r.resetSettingsCache(); r.clearAllCaches()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  assert.equal(r.hasModEvent('prompt.submit'), true)
}

async function runQueue(values) {
  const base = fixtureContext([]).getAppState()
  const store = r.createStore({ ...base, tasks: {}, settings: {}, speculation: { status: 'idle' }, mainLoopModel: 'fixture-model' }, r.onChangeAppState)
  const context = fixtureContext([], {
    getAppState: store.getState, setAppState: store.setState, readFileState: new Map(),
    setMessages() {}, setResponseLength() {}, setInProgressToolUseIDs() {}, setHasInterruptibleToolInProgress() {},
    options: { tools: [], commands: [], mainLoopModel: 'fixture-model', mcpClients: [], isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
  })
  const queryGuard = new r.QueryGuard(), transcript = [], dispatches = [], requests = [], queryDecisions = [], restored = []
  for (const value of values) r.enqueue({ value, mode: 'prompt', uuid: randomUUID() })
  while (r.getCommandQueueLength()) {
    let execution
    const result = r.processQueueIfReady({ executeInput: commands => {
      dispatches.push(commands.map(command => command.value))
      execution = r.handlePromptSubmit({
        queuedCommands: commands, queryGuard, commands: [], messages: [...transcript], mainLoopModel: 'fixture-model',
        helpers: { setCursorOffset() {}, clearBuffer() {}, resetHistory() {} },
        onInputChange: input => restored.push(input), setPastedContents() {}, setToolJSX() {},
        getToolUseContext: messages => ({ ...context, messages }), setUserInputOnProcessing() {}, setAbortController() {},
        setAppState: store.setState, canUseTool: permit,
        onQuery: async (messages, abortController, shouldQuery) => {
          const generation = queryGuard.tryStart()
          assert.notEqual(generation, null)
          queryDecisions.push(shouldQuery)
          transcript.push(...messages)
          try {
            if (!shouldQuery) return
            for await (const message of r.query({
              messages: [...transcript], systemPrompt: [], userContext: {}, systemContext: {}, canUseTool: permit,
              toolUseContext: { ...context, messages: [...transcript], abortController }, querySource: 'repl_main_thread',
              deps: {
                uuid: randomUUID, microcompact: async messages => ({ messages }),
                autocompact: async () => ({ compactionResult: undefined, consecutiveFailures: 0 }),
                callModel: async function* ({ messages }) {
                  requests.push(messages)
                  const reply = r.createAssistantMessage({ content: [{ type: 'text', text: 'queue answer' }] })
                  reply.message.id = randomUUID()
                  yield reply
                },
              },
            })) {
              if (message.type === 'assistant') transcript.push(message)
            }
          } finally { queryGuard.end(generation) }
        },
      })
      return execution
    } })
    assert.equal(result.processed, true)
    assert.equal(queryGuard.isActive, true, 'dispatch reserves the guard before the queue can process again')
    await execution
    assert.equal(queryGuard.isActive, false)
  }
  return { dispatches, requests, queryDecisions, restored }
}

for (const values of [['drop first', 'accepted second'], ['accepted first', 'drop second']]) {
  test(`queued prompt hooks preserve independent results for ${values.join(' then ')}`, async () => {
    await startDropHook()
    const result = await runQueue(values)
    assert.deepEqual(result.dispatches, values.map(value => [value]))
    assert.deepEqual(result.queryDecisions, values.map(value => !value.startsWith('drop ')))
    assert.deepEqual(result.restored, values.filter(value => value.startsWith('drop ')))
    assert.equal(result.requests.length, 1, 'the accepted prompt reaches a model request')
    assert.ok(JSON.stringify(result.requests[0]).includes(values.find(value => value.startsWith('accepted '))))
    assert.ok(!JSON.stringify(result.requests[0]).includes(values.find(value => value.startsWith('drop '))))
    assert.deepEqual(JSON.parse(readFileSync(join(project, 'queue-turns.json'), 'utf8')), { starts: 1, completes: 1 }, 'a dropped prompt never starts a model turn')
    assert.deepEqual(r.getModWarnings(), [])
  })
}

test('queued prompts retain ordinary batching without submission hooks', async () => {
  assert.equal(r.hasModEvent('prompt.submit'), false)
  const values = ['ordinary first', 'ordinary second'], result = await runQueue(values)
  assert.deepEqual(result.dispatches, [values])
  assert.deepEqual(result.queryDecisions, [true])
  assert.deepEqual(result.restored, [])
  assert.equal(result.requests.length, 1)
  for (const value of values) assert.ok(JSON.stringify(result.requests[0]).includes(value))
})
