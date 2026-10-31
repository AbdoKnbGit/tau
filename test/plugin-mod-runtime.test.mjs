import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const original = process.cwd(),
  // The real path, because the host reports real paths: TEMP can be an 8.3 short path on Windows.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tau-mod-runtime-')))
const project = join(root, 'project'),
  config = join(root, 'config'),
  managed = join(root, 'managed')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_SIMPLE: '0',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: [
    'src/utils/plugins/mods/compiler.ts',
    'src/utils/plugins/mods/runtime.ts',
    'src/utils/plugins/mods/manager.ts',
    'src/utils/plugins/mods/host.ts',
    'src/utils/hooks.ts',
    'src/utils/plugins/refresh.ts',
    'src/utils/plugins/validatePlugin.ts',
  ],
  exports: [
    'compileMod',
    'ModRuntime',
    'startPluginMods',
    'stopPluginMods',
    'endPluginMods',
    'getModCommands',
    'dispatchModEvent',
    'hasModEvent',
    'getModWarnings',
    'createModHost',
    'orderPluginMods',
    'getManagedFilePath',
    'setOriginalCwd',
    'setSessionTrustAccepted',
    'setAllowedSettingSources',
    'setIsInteractive',
    'setInlinePlugins',
    'clearAllCaches',
    'resetSettingsCache',
    'loadAllPlugins',
    'getCommands',
    'executeHooks',
    'getSessionId',
    'runModProcess',
    'refreshActivePlugins',
    'setPluginEnabledOp',
    'validatePluginContents',
  ],
})
r.getManagedFilePath.cache.set(undefined, managed)
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setIsInteractive(false)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const reset = () => {
  r.resetSettingsCache()
  r.clearAllCaches()
}
const hosts = new Set()
async function runtime(source, extra = {}) {
  const path = join(
    root,
    `mod-${hosts.size}-${Math.random().toString(36).slice(2)}`,
  )
  write(join(path, 'register.ts'), source)
  for (const [name, content] of Object.entries(extra))
    write(join(path, name), content)
  const compiled = await r.compileMod(path, join(path, 'register.ts'))
  const mod = new r.ModRuntime({ name: 'fixture', root: path }, compiled, {
    greeting: 'hello',
  })
  hosts.add(mod)
  await mod.initialize()
  return mod
}
const host = async () => {
  throw new Error('Unexpected API call')
}
after(async () => {
  await r.stopPluginMods()
  await Promise.allSettled([...hosts].map((mod) => mod.dispose()))
  process.chdir(original)
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

test('TypeScript modules import plugin-local helpers and preserve state across events', async () => {
  const mod = await runtime(
    `import { increment } from './helper.js'; let count: number = 0;
export function register(on, options) { on('command.run', {command:'count'}, async ($, e, next) => { count = increment(count); return {text:options.greeting + ':' + count}; }); }`,
    {
      'helper.ts':
        'export const increment = (value: number): number => value + 1;',
    },
  )
  assert.equal(
    (
      await mod.dispatch(
        'command.run',
        { command: 'count' },
        async () => ({}),
        host,
      )
    ).text,
    'hello:1',
  )
  assert.equal(
    (
      await mod.dispatch(
        'command.run',
        { command: 'count' },
        async () => ({}),
        host,
      )
    ).text,
    'hello:2',
  )
})

test('middleware applies nested regex filters after preceding rewrites and freezes inputs', async () => {
  const mod = await runtime(`export function register(on) {
on('command.run', async ($, e, next) => next({...e, args:'changed'}));
on('command.run', {args:/^changed$/}, async ($, e, next) => { let frozen=false; try {e.args='bad'} catch {frozen=true}; const result=await next(e); return {text:result.text+':'+frozen}; }); }`)
  const result = await mod.dispatch(
    'command.run',
    { command: 'test', args: 'before' },
    async (e) => ({ text: e.args }),
    host,
  )
  assert.equal(result.text, 'changed:true')
})

test('throw after next preserves its result without repeating the core action', async () => {
  const mod = await runtime(
    `export function register(on) { on('command.run', async ($, e, next) => { await next(e); throw new Error('after'); }); }`,
  )
  let calls = 0
  const result = await mod.dispatch(
    'command.run',
    { command: 'test' },
    async () => {
      calls++
      return { text: 'done' }
    },
    host,
  )
  assert.equal(result.text, 'done')
  assert.equal(calls, 1)
})

test('catch sees next.called and next.error; invalid results fall back to the chain', async () => {
  const mod = await runtime(`export function register(on) {
on('command.run', {command:'catch'}, async () => {throw new Error('before')}).catch(async ($, e, next) => ({text:next.error.kind+':'+next.called}));
on('command.run', {command:'invalid'}, async () => undefined); }`)
  assert.equal(
    (
      await mod.dispatch(
        'command.run',
        { command: 'catch' },
        async () => ({}),
        host,
      )
    ).text,
    'throw:false',
  )
  assert.equal(
    (
      await mod.dispatch(
        'command.run',
        { command: 'invalid' },
        async () => ({ text: 'fallback' }),
        host,
      )
    ).text,
    'fallback',
  )
})

test('ordinary repeated next calls repeat core while catch recovery reuses the last result', async () => {
  const mod = await runtime(
    `export function register(on) { on('command.run', async ($, e, next) => { await next(e); await next(e); throw new Error('after') }).catch(($,e,next)=>next(e)); }`,
  )
  let calls = 0
  assert.equal(
    (
      await mod.dispatch(
        'command.run',
        { command: 'test' },
        async () => ({ text: String(++calls) }),
        host,
      )
    ).text,
    '2',
  )
  assert.equal(calls, 2)
})

test('worker has no Node globals, and generated-code constructors cannot access the host', async () => {
  const mod =
    await runtime(`export function register(on) { on('command.run', async ($,e,next) => {
let blocked=false; try { ({}).constructor.constructor('return process')() } catch {blocked=true};
return {text:typeof process+':'+typeof require+':'+blocked}; }); }`)
  // require is a constrained module-local resolver, never Node's require.
  assert.equal(
    (await mod.dispatch('command.run', {}, async () => ({}), host)).text,
    'undefined:function:true',
  )
})

test('synchronous runaway mod is terminated without hanging the host', async () => {
  const mod = await runtime(
    `export function register(on) { on('command.run', async () => { while(true) {} }); }`,
  )
  const start = Date.now()
  assert.equal(
    (
      await mod.dispatch(
        'command.run',
        {},
        async () => ({ text: 'fallback' }),
        host,
        { timeoutMs: 100 },
      )
    ).text,
    'fallback',
  )
  assert.ok(Date.now() - start < 30_000)
})

test('awaiting core or host API work does not consume the hook execution budget', async () => {
  // A loaded machine can spend a short budget between the awaits. Each wait stays
  // longer than the budget, so if waits were charged to it every size would fail.
  const budgets = [60, 1000, 5000]
  for (const timeoutMs of budgets) {
    const waitMs = timeoutMs + 40
    const mod =
      await runtime(`export function register(on){on('command.run',async($,e,next)=>{
    await $.clock.sleep(${waitMs});const result=await next(e);return {text:result.text+':'+(next.budget.remainingMs>0)};
  })}`)
    const result = await mod.dispatch(
      'command.run',
      { command: 'wait' },
      async () => {
        await new Promise((done) => setTimeout(done, waitMs))
        return { text: 'done' }
      },
      async (method) => {
        assert.equal(method, 'clock.sleep')
        await new Promise((done) => setTimeout(done, waitMs))
      },
      { timeoutMs },
    )
    if (result.text !== 'done:true' && timeoutMs !== budgets.at(-1)) continue
    assert.equal(result.text, 'done:true')
    break
  }
})

test('abort terminates a synchronous runaway and does not run the core action', {timeout:10_000}, async () => {
  const mod = await runtime(
    `export function register(on) { on('command.run', async ($,e) => { if(e.args==='probe')return {text:'worker survived'};while(true) {} }); }`,
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100)
  let ran = false
  try {
    await assert.rejects(
      mod.dispatch(
        'command.run',
        {},
        async () => {
          ran = true
          return {}
        },
        host,
        { signal: controller.signal },
      ),
      /aborted/,
    )
  } finally {
    clearTimeout(timer)
  }
  assert.equal(ran, false)
  const warnings=[],started=Date.now()
  assert.equal((await mod.dispatch(
    'command.run', {args:'probe'}, async()=>({text:'fallback'}), host,
    {timeoutMs:5000,warn:message=>warnings.push(message)},
  )).text,'fallback')
  assert.ok(Date.now()-started<3000,'unresponsive worker is killed by the cancellation watchdog')
  assert.match(warnings.join('\n'),/Mod is unloaded/)
})

test('abort watchdog also terminates a runaway cancellation continuation', {timeout:10_000}, async () => {
  const mod=await runtime(`export function register(on){on('command.run',async($,e)=>{
    if(e.args==='probe')return {text:'worker survived'};
    try {await $.clock.sleep(30000)}catch{while(true){}}
    return {text:'unexpected'}
  })}`)
  const controller=new AbortController()
  let waiting=false
  const pending=mod.dispatch('command.run',{},async()=>({text:'unexpected core'}),async(method,_args,signal)=>{
    assert.equal(method,'clock.sleep')
    waiting=true
    await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('host wait aborted')),{once:true}))
  },{signal:controller.signal}).then(value=>({value}),error=>({error}))
  try {
    const deadline=Date.now()+3000
    while(!waiting){assert.ok(Date.now()<deadline,'worker reached its host wait');await new Promise(resolve=>setTimeout(resolve,10))}
    controller.abort()
    assert.match((await pending).error?.message??'',/Mod event aborted/)
    const warnings=[],started=Date.now()
    const result=await mod.dispatch('command.run',{args:'probe'},async()=>({text:'fallback'}),host,{timeoutMs:5000,warn:message=>warnings.push(message)})
    assert.equal(result.text,'fallback')
    assert.ok(Date.now()-started<3000,'cancelled catch-loop cannot falsely acknowledge cancellation')
    assert.match(warnings.join('\n'),/Mod is unloaded/)
  } finally {
    controller.abort()
    await pending
  }
})

test('renaming the registration parameter cannot silently register an unsupported event', async () => {
  await assert.rejects(
    runtime(
      `export function register(subscribe) { subscribe('tool.describe', async ($,e,next)=>next(e)); }`,
    ),
    /does not yet support mod event/,
  )
})

test('command identity cannot be rewritten; downstream results are frozen', async () => {
  const mod = await runtime(`export function register(on) {
on('command.run', async ($,e,next)=>{let refused=false;try{await next({...e,command:'different'})}catch{refused=true}
const result=await next(e);let frozen=false;try{result.text='mutated'}catch{frozen=true};return {text:result.text+':'+refused+':'+frozen};}); }`)
  let calls = 0
  const result = await mod.dispatch(
    'command.run',
    { command: 'original' },
    async (e) => {
      calls++
      return { text: e.command }
    },
    host,
  )
  assert.equal(result.text, 'original:true:true')
  assert.equal(calls, 1)
})

test('static validation rejects unsupported APIs and imports without evaluating top-level code', async () => {
  const path = join(root, 'invalid'),
    entry = join(path, 'register.js')
  for (const [source, expected] of [
    [
      "import fs from 'node:fs'; export function register(on){}",
      /plugin-relative/,
    ],
    [
      "export function register(on){on('tool.describe', async ($,e,next)=>next(e))}",
      /does not yet support mod event/,
    ],
    [
      "export function register(on){on('command.run', async ($)=>$.ui.open({}))}",
      /does not yet support mod API/,
    ],
    [
      "export function register(on){const name='command.run';on(name,()=>({}))}",
      /string literal/,
    ],
    [
      "export function register(on){on('command.run', async ($)=>{ const fs=$.fs; return {}; })}",
      /cannot be aliased/,
    ],
    ["import('./x.js');export function register(on){}", /Dynamic import/],
  ]) {
    write(entry, source)
    await assert.rejects(r.compileMod(path, entry), expected)
  }
  write(
    entry,
    'throw new Error("do not execute"); export function register(on) {}',
  )
  await r.compileMod(path, entry)
  write(join(root, 'outside.js'), 'export const value=1')
  write(
    entry,
    "import {value} from '../outside.js'; export function register(on) {}",
  )
  await assert.rejects(r.compileMod(path, entry), /escapes plugin/)
})

test('external process bridge preserves argv, stdin, cwd, output and nonzero exit codes', async () => {
  const script = join(project, 'process helper.cjs')
  write(
    script,
    `let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{console.log(JSON.stringify({arg:process.argv[2],text,cwd:process.cwd()}));process.exitCode=7})`,
  )
  const result = await r.runModProcess(
    [process.execPath, script, 'space ; $ literal'],
    { stdin: 'input' },
  )
  assert.equal(result.exitCode, 7)
  assert.deepEqual(JSON.parse(result.stdout), {
    arg: 'space ; $ literal',
    text: 'input',
    cwd: project,
  })
})

test('host filesystem and store contracts preserve bytes, ordering, concurrent writes and plugin isolation', async () => {
  const context = {
    id: 'host-a@fixture',
    name: 'host-a',
    commands: new Map(),
    reserved: new Set(['help']),
    commandsChanged: async () => {},
    log() {},
  }
  const signal = new AbortController().signal
  const api = r.createModHost(context),
    other = r.createModHost({ ...context, id: 'host-b@fixture' })
  const call = (method, ...args) => api(method, args, signal)
  await call('fs.write', 'created/nested/value.txt', 'héllo')
  assert.deepEqual(
    await call('fs.read', 'created/nested/value.txt', { as: 'bytes' }),
    { base64: Buffer.from('héllo').toString('base64') },
  )
  assert.equal(
    (await call('fs.stat', 'created/nested/value.txt')).realPath,
    undefined,
  )
  assert.equal(
    (await call('fs.stat', 'created/nested/value.txt', { resolve: true }))
      .realPath,
    join(project, 'created/nested/value.txt'),
  )
  assert.equal(await call('fs.exists', 'missing.txt'), false)
  await assert.rejects(call('fs.read', '//foreign/share/value'), /network/)
  await assert.rejects(
    call('fs.write', 'oversize.txt', 'x'.repeat(4 * 1024 * 1024 + 1)),
    /4 MiB/,
  )
  await Promise.all([
    call('store.set', '__proto__', 'a'),
    call('store.set', 'constructor', { value: 1 }),
    call('store.set', 'later', 3),
  ])
  await call('store.set', 'constructor', { value: 2 })
  assert.deepEqual(await call('store.keys'), [
    '__proto__',
    'constructor',
    'later',
  ])
  assert.equal(await other('store.get', ['__proto__'], signal), undefined)
  const fresh = r.createModHost(context)
  assert.deepEqual(await fresh('store.get', ['constructor'], signal), {
    value: 2,
  })
  await call('store.delete', '__proto__')
  assert.equal(await call('store.get', '__proto__'), undefined)
  await assert.rejects(
    call('store.set', 'too-big', 'x'.repeat(4 * 1024 * 1024)),
    /4 MiB/,
  )
  assert.deepEqual(await call('store.keys'), ['constructor', 'later'])
  assert.deepEqual(
    await call('command.register', { name: 'mine', description: 'first' }),
    { command: 'mine' },
  )
  await call('command.register', { name: 'mine', description: 'second' })
  assert.equal(context.commands.get('mine').description, 'second')
  await assert.rejects(
    call('command.register', { name: 'help', description: 'collision' }),
    /already registered/,
  )
})

test('dependency ordering wraps the correct catalog dependency, independent of discovery order', () => {
  const plugin = (source, dependencies = []) => ({
    source,
    name: source.split('@')[0],
    manifest: { dependencies },
  })
  const a = plugin('rules@north'),
    b = plugin('rules@south'),
    consumer = plugin('audit@north', ['rules'])
  const result = r.orderPluginMods([a, b, consumer]).map((p) => p.source)
  assert.ok(result.indexOf(consumer.source) < result.indexOf(a.source))
  const local = plugin('local@inline', ['rules'])
  assert.ok(
    r.orderPluginMods([a, local]).indexOf(local) <
      r.orderPluginMods([a, local]).indexOf(a),
  )
})

test('real plugin discovery stays inert; session startup registers commands and hooks; reload disables them', async () => {
  const path = join(root, 'plugin'),
    id = 'mod-fixture@inline'
  write(join(path, '.claude-plugin/plugin.json'), {
    name: 'mod-fixture',
    version: '1.0.0',
    userConfig: {
      label: {
        type: 'string',
        title: 'Label',
        description: 'Output label',
        default: 'default-label',
      },
    },
  })
  write(join(path, 'hooks/hooks.json'), {
    modules: ['./register.ts'],
    hooks: {
      PostToolUse: [
        {
          matcher: 'Read',
          hooks: [
            {
              type: 'command',
              command: `${JSON.stringify(process.execPath)} -e "console.log('classic-kept')"`,
            },
          ],
        },
      ],
    },
  })
  write(
    join(path, 'hooks/register.ts'),
    `export function register(on, options) {
on('session.start', async ($,e,next)=>{await $.command.register({name:'mod-check',description:'Check a receipt'}); return next(e)});
on('command.run',{command:'mod-check'},async ($,e)=>{const commands=await $.command.list();if(!commands.some(c=>c.name==='mod-check')||commands.some(c=>typeof c.description!=='string'))throw new Error('Invalid real command inventory');const value=await $.fs.read('receipt.txt');await $.store.set('last',value);return {text:options.label+':'+value};});
on('classic.PostToolUse', {tool_name:'Read'}, async ($,e,next)=>{ const result=await next(e); return {...result, additionalContext:[...(result.additionalContext||[]),'MOD-CONTEXT']}; });
on('session.end', async ($,e,next)=>{await $.fs.write('ended.txt',e.reason);return next(e)});
}`,
  )
  write(join(project, 'receipt.txt'), 'receipt-opaque')
  r.setInlinePlugins([path])
  reset()
  const loaded = await r.loadAllPlugins()
  assert.ok(
    loaded.enabled.some((p) => p.source === id && p.modEntries.length === 1),
  )
  assert.ok(
    !r.getModCommands().some((c) => c.name === 'mod-check'),
    'discovery must not execute register',
  )
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  const command = (await r.getCommands(project)).find(
    (c) => c.name === 'mod-check',
  )
  assert.ok(command, 'real command inventory includes registered mod command')
  assert.equal(
    (
      await (
        await command.load()
      ).call('', { abortController: new AbortController() })
    ).value,
    'default-label:receipt-opaque',
  )
  const entry = join(path, 'hooks/register.ts')
  const originalSource = readFileSync(entry, 'utf8')
  write(
    entry,
    originalSource.replace(
      "options.label+':'+value",
      "'changed:'+await $.store.get('last')",
    ),
  )
  const app = r.createStore(r.getDefaultAppState())
  await r.refreshActivePlugins(app.setState)
  const changed = r.getModCommands().find((c) => c.name === 'mod-check')
  assert.equal(
    (
      await (
        await changed.load()
      ).call('', { abortController: new AbortController() })
    ).value,
    'changed:receipt-opaque',
    'reload reads new module code and preserves store',
  )
  const results = []
  for await (const value of r.executeHooks({
    hookInput: {
      hook_event_name: 'PostToolUse',
      session_id: r.getSessionId(),
      cwd: project,
      transcript_path: '',
      tool_name: 'Read',
      tool_input: { file_path: 'receipt.txt' },
      tool_response: { text: 'receipt-opaque' },
      tool_use_id: 'fixture-call',
    },
    toolUseID: 'fixture-call',
    forceSyncExecution: true,
  }))
    results.push(value)
  assert.ok(
    results
      .flatMap((value) => value.additionalContexts ?? [])
      .includes('MOD-CONTEXT'),
  )
  assert.ok(
    results.some((value) => value.message),
    'declarative hook output remains observable',
  )
  assert.equal((await r.setPluginEnabledOp(id, false)).success, true)
  await r.refreshActivePlugins(app.setState)
  assert.ok(!(await r.getCommands(project)).some((c) => c.name === 'mod-check'))
  assert.equal(r.hasModEvent('classic.PostToolUse'), false)
  assert.equal((await r.setPluginEnabledOp(id, true)).success, true)
  await r.refreshActivePlugins(app.setState)
  await r.endPluginMods('user_exit')
  assert.equal(readFileSync(join(project, 'ended.txt'), 'utf8'), 'user_exit')
  r.setInlinePlugins([])
  reset()
})

test('trust, bare mode and managed-only policy prevent mod startup side effects', async () => {
  const path = join(root, 'policy-plugin'),
    settings = join(managed, 'managed-settings.json')
  write(join(path, '.claude-plugin/plugin.json'), {
    name: 'policy-fixture',
    version: '1.0.0',
  })
  write(join(path, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(
    join(path, 'hooks/register.ts'),
    `export function register(on) {on('session.start',async($,e,next)=>{await $.fs.write('policy-ran.txt','ran');return next(e)})}`,
  )
  r.setInlinePlugins([path])
  r.setIsInteractive(true)
  r.setSessionTrustAccepted(false)
  reset()
  try {
    await r.startPluginMods(true)
    assert.equal(existsSync(join(project, 'policy-ran.txt')), false)
    r.setSessionTrustAccepted(true, true)
    process.env.CLAUDE_CODE_SIMPLE = '1'
    reset()
    await r.startPluginMods(true)
    assert.equal(existsSync(join(project, 'policy-ran.txt')), false)
    process.env.CLAUDE_CODE_SIMPLE = '0'
    write(settings, { allowManagedModsOnly: true })
    reset()
    await r.startPluginMods(true)
    assert.equal(existsSync(join(project, 'policy-ran.txt')), false)
    write(settings, {
      allowManagedModsOnly: true,
      enabledPlugins: { 'policy-fixture@inline': true },
    })
    reset()
    await r.startPluginMods(true)
    assert.equal(readFileSync(join(project, 'policy-ran.txt'), 'utf8'), 'ran')
    write(settings, {
      disableAllHooks: true,
      enabledPlugins: { 'policy-fixture@inline': true },
    })
    reset()
    await r.startPluginMods(true)
    assert.equal(r.hasModEvent('session.start'), false)
  } finally {
    await r.stopPluginMods()
    write(settings, {})
    process.env.CLAUDE_CODE_SIMPLE = '0'
    r.setIsInteractive(false)
    r.setSessionTrustAccepted(true, true)
    r.setInlinePlugins([])
    reset()
  }
})

test('normal and recovered tool results inherit downstream context without repeating the action', async () => {
  for (const recovery of [false, true]) {
    const outer = recovery
      ? `on('tool.call',async($,e,next)=>{await next(e);throw new Error('after')}).catch(async()=>({result:{value:'recovered'},context:['inner-note','recovery-note']}));`
      : `on('tool.call',async($,e,next)=>{const value=await next(e);return {...value,context:['inner-note','outer-note']}});`
    const mod = await runtime(`export function register(on){${outer}
      on('tool.call',async($,e,next)=>({...await next(e),context:['inner-note']}));}`)
    let calls = 0
    const validated = [],
      result = await mod.dispatch(
        'tool.call',
        { tool: 'FixtureTool', path: 'test' },
        async () => {
          calls++
          return { result: { value: 'core' }, context: ['core-note'] }
        },
        host,
        { validateResult: (value) => validated.push(value) },
      )
    assert.equal(calls, 1)
    assert.deepEqual(result.context, [
      'core-note',
      'inner-note',
      recovery ? 'recovery-note' : 'outer-note',
    ])
    assert.deepEqual(result.result, { value: recovery ? 'recovered' : 'core' })
    assert.deepEqual(validated.at(-1), result)
  }
})

test('unawaited host work cannot hide a synchronous runaway before or after an await', async () => {
  // The hook must reach its host call for this to test anything, and a loaded
  // machine can spend a short budget before it gets there. Only then, retry with more.
  const budgets = [100, 1000, 10_000]
  for (const afterAwait of [false, true]) {
    for (const timeoutMs of budgets) {
      const mod = await runtime(`export function register(on){on('command.run',async($)=>{
      ${afterAwait ? 'await $.clock.sleep(1);' : ''}
      void $.clock.sleep(600000);while(true){}
    })}`)
      const hangLimit = timeoutMs + 30_000,
        controller = new AbortController(),
        guard = setTimeout(() => controller.abort(), hangLimit),
        started = Date.now(),
        warnings = []
      let pendingWaits = 0,
        abortedWaits = 0,
        coreCalls = 0
      try {
        const result = await mod.dispatch(
          'command.run',
          { command: 'runaway' },
          async () => {
            coreCalls++
            return { text: 'fallback' }
          },
          async (method, args, signal) => {
            assert.equal(method, 'clock.sleep')
            if (args[0] === 1) return
            assert.equal(args[0], 600000)
            pendingWaits++
            await new Promise((resolve, reject) => {
              const aborted = () => {
                abortedWaits++
                reject(new Error('host wait aborted'))
              }
              if (signal.aborted) aborted()
              else signal.addEventListener('abort', aborted, { once: true })
            })
          },
          {
            timeoutMs,
            signal: controller.signal,
            warn: (message) => warnings.push(message),
          },
        )
        assert.equal(result.text, 'fallback')
        assert.equal(coreCalls, 1)
        assert.equal(controller.signal.aborted, false)
        assert.match(warnings.join('\n'), /timed out/)
        assert.ok(Date.now() - started < hangLimit)
        if (pendingWaits === 0 && timeoutMs !== budgets.at(-1)) continue
        assert.equal(pendingWaits, 1)
        assert.equal(abortedWaits, 1)
        break
      } finally {
        clearTimeout(guard)
      }
    }
  }
})
