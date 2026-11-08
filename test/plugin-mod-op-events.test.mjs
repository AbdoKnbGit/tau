import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Every `$` call the host serves is an event for the mods above the caller;
// patterns select events by name, namespace or negation; and calls made after
// a hook returns (timers, then() callbacks) run in the mod's own context.
const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-op-events-')), project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
  TAU_TEST_NODE: process.execPath,
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/sessionState.ts', 'src/utils/plugins/mods/lifecycle.ts',
    'src/utils/plugins/mods/compiler.ts', 'src/utils/plugins/mods/runtime.ts'],
  exports: ['compileMod', 'ModRuntime', 'startPluginMods', 'stopPluginMods', 'dispatchModEvent', 'hasModEvent', 'getModWarnings', 'getModCommands',
    'setInlinePlugins', 'resetSettingsCache', 'clearAllCaches', 'setOriginalCwd', 'setSessionTrustAccepted',
    'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath', 'bindModSession', 'takeModLogs',
    'updateHooksConfigSnapshot'],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)

let serial = 0, closeSession
const write = (path, content) => { mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)) }
const read = name => existsSync(join(project, name)) ? readFileSync(join(project, name), 'utf8') : undefined
const pause = ms => new Promise(done => setTimeout(done, ms))
async function until(check, what, timeout = 10_000) {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - started < timeout, `timed out waiting for ${what}`)
    await pause(20)
  }
}
/** Loads one plugin per definition; the first is outermost in the chain. */
async function loadMods(definitions, { allowWarnings = false } = {}) {
  const names = definitions.map((_, index) => `op-${++serial}-${index}`)
  const paths = definitions.map((definition, index) => {
    const path = join(root, names[index])
    write(join(path, '.claude-plugin/plugin.json'), {name: names[index], version: '1.0.0',
      ...(index + 1 < names.length ? {dependencies: [names[index + 1] + '@inline']} : {})})
    write(join(path, 'hooks/hooks.json'), {modules: ['./register.ts']})
    write(join(path, 'hooks/register.ts'), `${definition.module ?? ''}\nexport function register(on) {${definition.hooks ?? definition}}`)
    return path
  })
  r.setInlinePlugins(paths); r.resetSettingsCache(); r.clearAllCaches(); r.updateHooksConfigSnapshot()
  await r.startPluginMods(true)
  if (!allowWarnings) assert.deepEqual(r.getModWarnings(), [])
  return names
}
async function command(name) {
  const entry = r.getModCommands().find(item => item.name === name)
  assert.ok(entry, name)
  return (await entry.load()).call('', fixtureContext([]))
}
const register = name => `on('session.start',async($,e,next)=>{await $.command.register({name:'${name}',description:'${name}'});return next(e)});`
afterEach(async () => { await r.stopPluginMods(); closeSession?.(); closeSession = undefined; r.takeModLogs() })
after(async () => { await r.stopPluginMods(); process.chdir(original); rmSync(root, {recursive: true, force: true, maxRetries: 10}) })

test('mods above a caller observe, rewrite, refuse and answer its host calls; its own and lower hooks never see them', async () => {
  write(join(project, 'target.txt'), 'target contents')
  process.env.TAU_OP_PINNED = 'pinned-value'
  const [guard, caller] = await loadMods([
    `on('fs.read',async($,e,next)=>e.path==='redirect.txt'?next({...e,path:'target.txt'}):next(e));
     on('fs.write',{path:/blocked/},async()=>({deny:'Writes to blocked files are refused'}));
     on('store.get',{key:'answered'},async()=>({value:'from the guard'}));
     on('process.run',async($,e,next)=>{const result=await next(e);return {value:{...result.value,stdout:'observed:'+result.value.stdout}}});
     on('env.get',{name:'TAU_OP_PINNED'},async($,e,next)=>next({...e,name:'PATH'}));
     on('ui.log',async($,e,next)=>next({...e,to:'debug'}));
     on('session.cwd',async($,e,next)=>{const result=await next(e);return {value:result.value+'#seen'}});`,
    `${register('op-probe')}
     on('fs.read',async()=>({value:'own hooks never see own calls'}));
     on('command.run',{command:'op-probe'},async($)=>{
       const out={};
       out.read=await $.fs.read('redirect.txt');
       try{await $.fs.write('blocked.txt','x');out.write='written'}catch(error){out.write=error.message}
       await $.fs.write('allowed.txt','kept');
       out.answered=await $.store.get('answered');
       out.process=(await $.process.run([await $.env.get('TAU_TEST_NODE'),'-e','process.stdout.write("hi")'])).stdout;
       out.pinned=await $.env.get('TAU_OP_PINNED');
       $.ui.log('quiet line');
       out.cwd=await $.session.cwd();
       return {text:JSON.stringify(out)};
     });`,
    `on('fs.read',async()=>({value:'mods below the caller never see its calls'}));
     on('store.get',async()=>({value:'below'}));`,
  ])
  const out = JSON.parse((await command('op-probe')).value)
  assert.equal(out.read, 'target contents')
  assert.equal(out.write, `${caller}: $.fs.write: Writes to blocked files are refused`)
  assert.equal(read('blocked.txt'), undefined)
  assert.equal(read('allowed.txt'), 'kept')
  assert.equal(out.answered, 'from the guard')
  assert.equal(out.process, 'observed:hi')
  // A name pins what the call acts on: the rewrite fails and the call goes on unchanged.
  assert.equal(out.pinned, 'pinned-value')
  assert.ok(r.getModWarnings().some(text => text.startsWith(`${guard}: env.get hook skipped`) && text.includes('cannot rewrite name')), r.getModWarnings().join('\n'))
  assert.equal(out.cwd, project + '#seen')
  // The guard sent the line to the debug log alone.
  assert.deepEqual(r.takeModLogs(), [])
})

test('patterns select events by name, namespace or negation; next.event and next.is name the one running', async () => {
  const [observer] = await loadMods([
    `const seen=[];
     on('*',async($,e,next)=>{seen.push(next.event+(next.is('fs.*',e)?' fs':''));return next(e)});
     on('!fs.*',async($,e,next)=>{if(next.is('fs.read',e))throw new Error('a negation selected what it excludes');return next(e)});
     on('classic.*',async($,e,next)=>next(e));
     ${register('glob-seen')}
     on('command.run',{command:'glob-seen'},async()=>({text:JSON.stringify(seen)}));`,
    `${register('glob-probe')}
     on('command.run',{command:'glob-probe'},async($)=>{await $.fs.exists('target.txt');await $.store.keys();return {text:'probed'}});`,
  ])
  assert.equal((await command('glob-probe')).value, 'probed')
  const seen = JSON.parse((await command('glob-seen')).value)
  for (const event of ['session.start', 'command.register', 'command.run', 'fs.exists fs', 'store.keys'])
    assert.ok(seen.includes(event), `${event} not in ${seen}`)
  assert.deepEqual(r.getModWarnings(), [])
  // A glob covers the events Tau raises to mods, except MessageDisplay, which
  // would turn every reply into line-by-line streaming for a mere observer.
  assert.equal(r.hasModEvent('classic.Stop'), true)
  assert.equal(r.hasModEvent('classic.PreToolUse'), true)
  assert.equal(r.hasModEvent('classic.MessageDisplay'), false)
  assert.equal(r.hasModEvent('agent.offer'), false)
  assert.ok(observer)
})

test('patterns that select nothing a mod could mean, and events Tau does not raise, refuse the module', async () => {
  for (const pattern of ['*.*', '!*', 'nope.*', '!nope.event', 'agent.offer', 'turn.offer']) {
    await loadMods([`on('${pattern}',async($,e,next)=>next(e));`], {allowWarnings: true})
    assert.ok(r.getModWarnings().some(text => text.includes('mod did not load') && text.includes(pattern)), `${pattern}: ${r.getModWarnings()}`)
    assert.equal(r.getModCommands().length, 0)
  }
  // A namespace Tau raises nothing under yet is accepted; its hook just never runs.
  await loadMods([`on('agent.*',async($,e,next)=>next(e));on('!agent.spawn',async($,e,next)=>next(e));`])
})

test('a matcher against an array field holds when some element matches', async () => {
  await loadMods([
    `on('command.run',{tags:'beta'},async()=>({text:'scalar'}));
     on('command.run',{notes:/secret/},async()=>({text:'regex'}));
     on('command.run',{edits:{old:'b'}},async()=>({text:'object'}));
     on('command.run',{tags:['x','gamma']},async()=>({text:'any-of'}));`,
  ])
  const run = event => r.dispatchModEvent('command.run', {command: 'probe', ...event}, async () => ({text: 'core'}))
  assert.equal((await run({tags: ['alpha', 'beta']})).text, 'scalar')
  assert.equal((await run({notes: ['plain', 'top secret']})).text, 'regex')
  assert.equal((await run({edits: [{old: 'a'}, {old: 'b'}]})).text, 'object')
  assert.equal((await run({tags: ['gamma']})).text, 'any-of')
  assert.equal((await run({tags: ['alpha'], notes: ['plain'], edits: [{old: 'a'}]})).text, 'core')
  assert.equal((await run({tags: []})).text, 'core')
})

test('a call a hook did not await finishes after it returns, and a stray rejection leaves the mod loaded', async () => {
  const dir = join(root, 'stray')
  write(join(dir, 'register.ts'), `export function register(on) {
    on('command.run', async ($, e) => { $.store.set('last', e.command); $.fs.read('missing-' + e.command); return { text: 'ran ' + e.command } })
  }`)
  const mod = new r.ModRuntime({ name: 'stray', root: dir }, await r.compileMod(dir, join(dir, 'register.ts')))
  await mod.initialize()
  const calls = []
  // Settles after the hook returned, honouring its signal as the real host does.
  const host = async (method, _args, signal) => {
    calls.push(method)
    await pause(30)
    signal.throwIfAborted()
    if (method === 'fs.read') throw new Error('ENOENT: no such file')
  }
  try {
    for (const command of ['first', 'second', 'third']) {
      const result = await mod.dispatch('command.run', {command}, async () => ({text: 'core'}), host)
      assert.equal(result.text, 'ran ' + command)
      await pause(60)
    }
    assert.equal(calls.filter(method => method === 'store.set').length, 3)
  } finally { await mod.dispose() }
})

test('timers and then() callbacks call $ after their hook returned; cancel and unload stop them', async () => {
  await loadMods([{
    module: 'let ticks=0,timer;',
    hooks: `on('session.start',async($,e,next)=>{
      timer=$.clock.every(15,async()=>{ticks++;if(ticks===4)timer.cancel();await $.fs.write('ticks.txt',String(ticks));if(ticks===2)throw new Error('a failing tick keeps its interval')});
      $.clock.after(5,()=>{$.fs.write('after.txt','fired')});
      $.clock.now().then(async()=>{await $.fs.write('late.txt','written after the hook returned')});
      return next(e)});
     let saved;
     ${register('late-next')}
     on('command.run',{command:'late-next'},async($,e,next)=>{saved=next;$.clock.now().then(async()=>{try{await saved(e)}catch(error){await $.fs.write('late-next.txt',error.message)}});return {text:'returned'}});`,
  }])
  await until(() => read('ticks.txt') === '4', 'four ticks')
  await until(() => read('after.txt') === 'fired', 'the one-shot timer')
  await until(() => read('late.txt'), 'the late then() write')
  assert.equal((await command('late-next')).value, 'returned')
  assert.match(await until(() => read('late-next.txt'), 'the late next() refusal'), /next\(\) was called after its hook returned/)
  await pause(150)
  assert.equal(read('ticks.txt'), '4', 'a cancelled interval fired again')
})

test('a mod above can refuse a timer period, which ends the interval; unloading stops every timer', async () => {
  await loadMods([
    `let periods=0;on('clock.every',{ms:60_000},async($,e,next)=>++periods>3?{deny:'three periods are enough'}:next({...e,ms:10}));`,
    { module: 'let ticks=0;',
      hooks: `on('session.start',async($,e,next)=>{$.clock.every(60_000,async()=>{ticks++;await $.fs.write('refused-ticks.txt',String(ticks))});
        $.clock.every(20,async()=>{await $.fs.write('unload-ticks.txt',String(Date.now()))});return next(e)});` },
  ])
  // The guard shortened the minute-long period to 10 ms, then refused the fourth.
  await until(() => read('refused-ticks.txt') === '3', 'three allowed periods')
  await pause(100)
  assert.equal(read('refused-ticks.txt'), '3')
  await until(() => read('unload-ticks.txt'), 'the unguarded timer')
  await r.stopPluginMods()
  await pause(60)
  const last = read('unload-ticks.txt')
  await pause(150)
  assert.equal(read('unload-ticks.txt'), last, 'a timer outlived its unloaded module')
})

test('$.env.set sets and clears a variable for this process; the name is pinned', async () => {
  delete process.env.TAU_OP_SET
  await loadMods([
    `on('env.set',async($,e,next)=>next({...e,name:'PATH'}));`,
    `${register('env-probe')}
     on('command.run',{command:'env-probe'},async($,e)=>{
       if(e.args==='clear'){await $.env.set('TAU_OP_SET');return {text:String(await $.env.get('TAU_OP_SET'))}}
       await $.env.set('TAU_OP_SET','one');return {text:await $.env.get('TAU_OP_SET')}});`,
  ])
  const path = process.env.PATH
  assert.equal((await command('env-probe')).value, 'one')
  assert.equal(process.env.TAU_OP_SET, 'one')
  assert.equal(process.env.PATH, path)
  const entry = r.getModCommands().find(item => item.name === 'env-probe')
  assert.equal((await (await entry.load()).call('clear', fixtureContext([]))).value, 'undefined')
  assert.equal('TAU_OP_SET' in process.env, false)
})

test('ui.log lines become their own transcript rows at once where a session draws them, in order', async () => {
  const [name] = await loadMods([
    `on('session.start',async($,e,next)=>{$.ui.log('started');return next(e)});
     on('prompt.submit',async($,e,next)=>{$.ui.log('one');$.ui.log('two',{to:'debug'});$.ui.log('three');return next(e)});
     ${register('log-probe')}
     on('command.run',{command:'log-probe'},async($)=>{$.ui.log('in a command');return {text:'output'}});`,
  ])
  // Logged before any transcript existed: shown once a session binds one.
  const notices = []
  closeSession = r.bindModSession({getMessages: () => [], getModel: () => 'model', appendNotice: text => notices.push(text)})
  await until(() => notices.length === 1, 'the held startup line')
  assert.deepEqual(notices, [`${name}: started`])
  await r.dispatchModEvent('prompt.submit', {text: 'hi', origin: {kind: 'human'}}, async e => ({text: e.text}))
  await until(() => notices.length === 3, 'the prompt hook lines')
  assert.deepEqual(notices, [`${name}: started`, `${name}: one`, `${name}: three`])
  // A command's input row is drawn with its output, after the run, so its
  // lines lead that output instead of landing above the input.
  assert.equal((await command('log-probe')).value, `${name}: in a command\noutput`)
  assert.equal(notices.length, 3)
  assert.deepEqual(r.takeModLogs(), [])
})

test('without a transcript, ui.log lines wait for the output that drains them', async () => {
  const [name] = await loadMods([`${register('held-probe')}
    on('command.run',{command:'held-probe'},async($)=>{$.ui.log('held');return {text:'output'}});`])
  closeSession = r.bindModSession({getMessages: () => [], getModel: () => 'model'})
  const result = await command('held-probe')
  assert.equal(result.value, `${name}: held\noutput`)
})
