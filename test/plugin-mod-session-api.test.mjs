import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-session-api-')), project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/sessionState.ts', 'src/utils/plugins/mods/lifecycle.ts'],
  exports: ['startPluginMods', 'stopPluginMods', 'dispatchModEvent', 'getModWarnings', 'getModCommands',
    'setInlinePlugins', 'resetSettingsCache', 'clearAllCaches', 'setOriginalCwd', 'setSessionTrustAccepted',
    'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath', 'createUserMessage', 'createAssistantMessage',
    'bindModSession', 'beginModMainTurn', 'isModSessionStopped', 'withModToolContext', 'withModTurnLifecycle'],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)
let serial = 0, closeSession
const write = (path, content) => { mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)) }
async function loadMods(definitions) {
  const names = definitions.map((_, index) => `session-${++serial}-${index}`)
  const paths = definitions.map((definition, index) => {
    const path = join(root, names[index])
    write(join(path, '.claude-plugin/plugin.json'), {name: names[index], version: '1.0.0',
      ...(index + 1 < names.length ? {dependencies: [names[index + 1] + '@inline']} : {})})
    write(join(path, 'hooks/hooks.json'), {modules: ['./register.ts']})
    write(join(path, 'hooks/register.ts'), `export function register(on) {${definition}}`)
    return path
  })
  r.setInlinePlugins(paths); r.resetSettingsCache(); r.clearAllCaches()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  return names
}
const bind = binding => { closeSession = r.bindModSession({getTools: () => [], ...binding}) }
const permit = async (_tool, input) => ({behavior: 'allow', updatedInput: input})
const user = content => r.createUserMessage({content})
async function command(name, context = fixtureContext([])) {
  const entry = r.getModCommands().find(item => item.name === name)
  assert.ok(entry, name)
  return (await entry.load()).call('', context)
}
afterEach(async () => { await r.stopPluginMods(); closeSession?.(); closeSession = undefined })
after(async () => { await r.stopPluginMods(); process.chdir(original); rmSync(root, {recursive: true, force: true, maxRetries: 10}) })

test('worker session reads use live main state; only hooks above the caller intercept', async () => {
  let model = 'main-model-one', messages = [user('first main prompt')]
  bind({getModel: () => model, getMessages: () => messages})
  const names = await loadMods([
    `on('session.model', async($,e,next)=>{ const r=await next(e);return {value:'wrapped:'+r.value} });
     on('session.turns', async($,e,next)=>{ const r=await next(e);return {value:r.value+10} });
     on('session.messages', async($,e,next)=>{const r=await next(e);return {value:[...r.value,{role:'user',text:'observer',toolUses:[]}]} });`,
    `on('session.start',async($,e,next)=>{await $.command.register({name:'session-probe',description:'Inspect session'});return next(e)});
     on('session.model',async()=>({value:'must not intercept own call'}));
     on('command.run',async($,e,next)=>e.command==='session-probe'?{text:JSON.stringify({model:await $.session.model(),turns:await $.session.turns(),messages:await $.session.messages()})}:next(e));`,
    `on('session.model',async()=>({value:'must not intercept below caller'}));
     on('session.turns',async()=>({value:-1}));
     on('session.messages',async()=>({value:[]}));`,
  ])
  const stale = fixtureContext([], {messages: [user('stale child snapshot')], agentId: 'child'})
  stale.options.mainLoopModel = 'stale-child-model'
  let value = JSON.parse((await command('session-probe', stale)).value)
  assert.equal(value.model, 'wrapped:main-model-one')
  assert.equal(value.turns, 11)
  assert.deepEqual(value.messages.map(row => row.text), ['first main prompt', 'observer'])
  model = 'main-model-two'; messages = [...messages, user('second main prompt')]
  value = JSON.parse((await command('session-probe', stale)).value)
  assert.equal(value.model, 'wrapped:main-model-two')
  assert.equal(value.turns, 12)
  assert.deepEqual(value.messages.map(row => row.text), ['first main prompt', 'second main prompt', 'observer'])
  assert.equal(names.length, 3)
  assert.deepEqual(r.getModWarnings(), [])
})

test('worker API message projection normalizes local commands without changing retained history', async () => {
  const messages = [user('prompt'), {type: 'system', subtype: 'local_command', uuid: 'local-output', timestamp: new Date().toISOString(), content: 'local command result'}]
  const before = structuredClone(messages)
  bind({getModel: () => 'fixture-model', getMessages: () => messages})
  await loadMods([`on('session.start',async($,e,next)=>{await $.command.register({name:'api-transcript',description:'Inspect API transcript'});return next(e)});
    on('command.run',async($,e,next)=>{
      if(e.command!=='api-transcript')return next(e);
      const rows=await $.session.messages({as:'api'});rows[0].content[0].text='mutated worker copy';
      return {text:JSON.stringify(await $.session.messages({as:'api'}))};
    });`])
  const value = JSON.parse((await command('api-transcript')).value)
  assert.equal(value[0].role, 'user')
  assert.match(JSON.stringify(value), /local command result/)
  assert.doesNotMatch(JSON.stringify(value), /mutated worker copy/)
  assert.deepEqual(messages, before)
  assert.deepEqual(r.getModWarnings(), [])
})

test('a worker can await its own turn abort acknowledgement; stale ids reject and stop latch stays clear', async () => {
  bind({getModel: () => 'fixture-model', getMessages: () => [user('request')]})
  await loadMods([`on('turn.abort',async($,e,next)=>next(e));`, `on('turn.start',async($,e,next)=>{
    let stale;
    try {await $.turn.abort({turnId:'not-'+e.turnId})} catch(error){stale=String(error)}
    await $.turn.abort({turnId:e.turnId});
    await $.fs.write('self-abort.json',JSON.stringify({turnId:e.turnId,stale,acknowledged:true}));
    return {turnId:e.turnId};
  });`])
  const context = fixtureContext([])
  const end = r.beginModMainTurn('worker-main-turn', context.abortController)
  try {
    const result = await r.withModToolContext({toolUseContext: context, canUseTool: permit,
      assistantMessage: r.createAssistantMessage({content: []})}, () =>
      r.dispatchModEvent('turn.start', {turnId: 'worker-main-turn'}, async e => ({turnId: e.turnId}), context.abortController.signal))
    assert.deepEqual(result, {turnId: 'worker-main-turn'})
    const receipt = JSON.parse(readFileSync(join(project, 'self-abort.json'), 'utf8'))
    assert.equal(receipt.acknowledged, true)
    assert.match(receipt.stale, /not-worker-main-turn.*worker-main-turn/)
    assert.equal(context.abortController.signal.reason, 'interrupt')
    assert.equal(r.isModSessionStopped(), false)
    assert.deepEqual(r.getModWarnings(), [])
  } finally { end() }
})

test('session API middleware can refuse without reading the core transcript', async () => {
  let reads = 0
  bind({getModel: () => 'fixture-model', getMessages: () => {reads++; return [user('hidden')]}})
  await loadMods([
    `on('session.messages',async()=>({deny:'Transcript access denied by policy'}));`,
    `on('session.start',async($,e,next)=>{await $.command.register({name:'denied-transcript',description:'Try transcript'});return next(e)});
     on('command.run',async($,e,next)=>{if(e.command!=='denied-transcript')return next(e);try {await $.session.messages();return {text:'unexpected'}}catch(error){return {text:String(error)}}});`,
  ])
  assert.match((await command('denied-transcript')).value, /session.messages refused: Transcript access denied by policy/)
  assert.equal(reads, 0)
  assert.deepEqual(r.getModWarnings(), [])
})

test('transparent API errors still reach an explicit catch handler without a spurious skipped-hook warning', async () => {
  await loadMods([`on('turn.abort',async($,e,next)=>next(e)).catch(async($,e,next)=>({deny:'Handled core refusal: '+next.error.message}));`])
  const result = await r.dispatchModEvent('turn.abort', {turnId:'ended'}, async () => {throw new Error('turn is no longer running')})
  assert.deepEqual(result, {deny:'Handled core refusal: turn is no longer running'})
  assert.deepEqual(r.getModWarnings(), [])
})
