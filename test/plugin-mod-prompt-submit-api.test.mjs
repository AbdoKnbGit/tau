import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { after, afterEach, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-submit-api-')), project = join(root, 'project')
mkdirSync(project); mkdirSync(join(root, 'config'))
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/lifecycle.ts',
    'src/utils/plugins/mods/promptQueue.ts', 'src/utils/plugins/mods/sessionState.ts',
    'src/utils/processUserInput/processUserInput.ts'],
  exports: ['dispatchModEvent', 'startPluginMods', 'stopPluginMods', 'getModWarnings',
    'setInlinePlugins', 'clearAllCaches', 'resetSettingsCache', 'setOriginalCwd',
    'setSessionTrustAccepted', 'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath',
    'createStore', 'onChangeAppState', 'createAssistantMessage', 'runCleanupFunctions',
    'getCommandQueue', 'dequeue', 'clearCommandQueue', 'getQueuedModPrompt',
    'processUserInput', 'withModTurnLifecycle', 'bindModSession', 'resumeModSessionOnUserInput',
    'getSubmitApiDeps: () => ({executeUserPromptSubmitHooks, getAttachmentMessages})',
    'setSubmitApiDeps: d => {executeUserPromptSubmitHooks=d.executeUserPromptSubmitHooks; getAttachmentMessages=d.getAttachmentMessages}',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project); r.setSessionTrustAccepted(true, true); r.setIsInteractive(false)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const originalDeps = r.getSubmitApiDeps(), empty = () => (async function* () {})()
r.setSubmitApiDeps({ executeUserPromptSubmitHooks: empty, getAttachmentMessages: empty })
const transcript = [], release = r.bindModSession({ getMessages: () => transcript, getModel: () => 'fixture-model' })
afterEach(async () => { r.clearCommandQueue(); await r.stopPluginMods(); transcript.length = 0; r.resumeModSessionOnUserInput() })
after(async () => {
  release(); r.setSubmitApiDeps(originalDeps); await r.runCleanupFunctions()
  process.chdir(original); rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})

let serial = 0
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
async function mod(source) {
  const name = `submit-fixture-${++serial}`, path = join(root, name)
  write(join(path, '.claude-plugin/plugin.json'), { name, version: '1.0.0' })
  write(join(path, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(join(path, 'hooks/register.ts'), `export function register(on) { ${source} }`)
  r.setInlinePlugins([path]); r.resetSettingsCache(); r.clearAllCaches()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  return name
}
function context(messages = transcript) {
  const base = fixtureContext([]).getAppState()
  const store = r.createStore({ ...base, tasks: {}, settings: {}, speculation: { status: 'idle' }, mainLoopModel: 'fixture-model' }, r.onChangeAppState)
  return fixtureContext([], {
    getAppState: store.getState, setAppState: store.setState, readFileState: new Map(), messages,
    setMessages() {}, setResponseLength() {}, setInProgressToolUseIDs() {}, setHasInterruptibleToolInProgress() {},
    options: { tools: [], commands: [], mainLoopModel: 'fixture-model', mcpClients: [], isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
  })
}
const permit = async (_tool, input) => ({ behavior: 'allow', updatedInput: input })
const command = name => r.dispatchModEvent('command.run', { command: name, args: '', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } }, async () => ({ text: 'unhandled' }))
const submit = (input, extra = {}) => r.processUserInput({ input, mode: 'prompt', context: context(), canUseTool: permit, setToolJSX() {}, skipAttachments: true, ...extra })
async function beginQueued() {
  const queued = r.dequeue()
  assert.ok(queued?.modPrompt)
  const result = await submit(queued.value, { uuid: queued.uuid, modPrompt: true })
  return { queued, result }
}
async function finishTurn(result) {
  transcript.push(...result.messages)
  const source = (async function* () { yield r.createAssistantMessage({ content: [{ type: 'text', text: 'answer' }] }); return 'complete' })()
  const output = []
  for await (const message of r.withModTurnLifecycle(source, context(), permit)) output.push(message)
  return output
}
async function state() { return JSON.parse((await command('state')).text) }

test('fire-and-forget command submission survives its handler and acknowledges only its own turn start', async () => {
  const name = await mod(`
    let receipt = null, submitted = 0;
    on('command.run', async($,e,next) => {
      if (e.command === 'queue') { void $.prompt.submit({ text: '/literal @not-a-file', asUser: true }).then(value => { receipt = value }); return { text: 'queued' }; }
      if (e.command === 'state') return { text: JSON.stringify({ receipt, submitted }) };
      return next(e);
    });
    on('prompt.submit', async($,e,next) => { submitted++; return next({ ...e, text: e.text + ' rewritten', context: ['context before next'] }); });
  `)
  assert.deepEqual(await command('queue'), { text: 'queued' })
  assert.equal(r.getCommandQueue().length, 1)
  assert.deepEqual(await state(), { receipt: null, submitted: 0 })
  const { queued, result } = await beginQueued()
  assert.equal(result.shouldQuery, true)
  assert.ok(r.getQueuedModPrompt(queued.uuid), 'normal command completion did not cancel the submission')
  assert.equal((await state()).receipt, null, 'processing alone does not acknowledge a model turn')
  await finishTurn(result)
  const evidence = await state()
  assert.equal(evidence.submitted, 1)
  assert.deepEqual(evidence.receipt, { text: '/literal @not-a-file rewritten', context: ['context before next'], origin: { kind: 'plugin', name, asUser: true } })
  const user = result.messages.find(message => message.uuid === queued.uuid)
  assert.deepEqual(user.origin, evidence.receipt.origin)
  assert.doesNotMatch(JSON.stringify(user), /The .* plugin sent a message/)
  assert.deepEqual(r.getModWarnings(), [])
})

test('session.start can submit a framed independent prompt with runtime-owned provenance', async () => {
  const name = await mod(`
    let receipt = null;
    on('session.start', async($,e,next) => { void $.prompt.submit({ text: 'startup request' }).then(value => { receipt = value }); return next(e); });
    on('command.run', async($,e,next) => e.command === 'state' ? { text: JSON.stringify({ receipt }) } : next(e));
  `)
  assert.equal(r.getCommandQueue().length, 1)
  const { result } = await beginQueued()
  assert.equal(result.shouldQuery, true)
  assert.match(JSON.stringify(result.messages), new RegExp(`The ${name} plugin sent a message:`))
  await finishTurn(result)
  assert.deepEqual((await state()).receipt, { text: 'startup request', origin: { kind: 'plugin', name } })
  assert.deepEqual(r.getModWarnings(), [])
})

test('nested submission skips only its calling prompt hook while sibling hooks still run', async () => {
  await mod(`
    const observations = []; let receipt = null;
    on('prompt.submit', async($,e,next) => {
      observations.push('first:' + e.text);
      if (e.text === 'trigger') void $.prompt.submit({ text: 'child request' }).then(value => { receipt = value });
      return next(e);
    });
    on('prompt.submit', async($,e,next) => { observations.push('second:' + e.text); return next(e); });
    on('command.run', async($,e,next) => e.command === 'state' ? { text: JSON.stringify({ receipt, observations }) } : next(e));
  `)
  const initial = await submit('trigger', { uuid: randomUUID() })
  assert.equal(initial.shouldQuery, true)
  await finishTurn(initial)
  assert.equal((await state()).receipt, null, 'another prompt starting cannot acknowledge the child')
  const { result } = await beginQueued()
  await finishTurn(result)
  const evidence = await state()
  assert.deepEqual(evidence.observations, ['first:trigger', 'second:trigger', 'second:child request'])
  assert.equal(evidence.receipt.text, 'child request')
  assert.deepEqual(r.getModWarnings(), [])
})

test('unloading the submitting runtime removes queued work before a later runner can use it', async () => {
  await mod(`on('command.run', async($,e,next) => { if (e.command !== 'queue') return next(e); void $.prompt.submit({ text: 'must not run' }); return { text: 'queued' }; });`)
  await command('queue')
  const queued = r.getCommandQueue()[0]
  assert.ok(r.getQueuedModPrompt(queued.uuid))
  await r.stopPluginMods()
  assert.equal(r.getCommandQueue().length, 0)
  assert.equal(r.getQueuedModPrompt(queued.uuid), undefined)
  const result = await submit(queued.value, { uuid: queued.uuid, modPrompt: true })
  assert.equal(result.shouldQuery, false)
  assert.deepEqual(result.messages, [])
})

test('a queued hook refusal keeps its exact API reason and visible rejection without restoring the composer', async () => {
  await mod(`let receipt;
    on('command.run',async($,e,next)=>{
      if(e.command==='queue'){void $.prompt.submit({text:'refuse me'}).then(value=>{receipt=value});return {text:'queued'}}
      if(e.command==='state')return {text:JSON.stringify({receipt})};return next(e)
    });
    on('prompt.submit',async()=>({drop:'exact policy refusal'}));`)
  await command('queue')
  const {result} = await beginQueued()
  assert.equal(result.shouldQuery, false)
  assert.equal(result.nextInput, undefined)
  assert.match(JSON.stringify(result.messages), /Prompt dropped by a hook: exact policy refusal/)
  assert.deepEqual((await state()).receipt, {drop:'exact policy refusal'})
  assert.deepEqual(r.getModWarnings(), [])
})
