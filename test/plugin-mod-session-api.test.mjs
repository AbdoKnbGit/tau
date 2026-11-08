import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  paths: ['src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/sessionState.ts', 'src/utils/plugins/mods/lifecycle.ts',
    'src/utils/plugins/mods/compactMessages.ts', 'src/utils/plugins/mods/compactApi.ts'],
  exports: ['startPluginMods', 'stopPluginMods', 'dispatchModEvent', 'getModWarnings', 'getModCommands',
    'setInlinePlugins', 'resetSettingsCache', 'clearAllCaches', 'setOriginalCwd', 'setSessionTrustAccepted',
    'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath', 'createUserMessage', 'createAssistantMessage',
    'bindModSession', 'beginModMainTurn', 'isModSessionStopped', 'withModToolContext', 'withModTurnLifecycle',
    'CompactMessageHandles', 'runCompactTransaction', 'updateHooksConfigSnapshot',
    'normalizeMessagesForAPI', 'annotateBoundaryWithPreservedSegment', 'createCompactBoundaryMessage',
    'addErrorNotificationIfNeeded', 'preserveModCompactionScrollback', 'withoutRepeatedRows'],
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
  r.setInlinePlugins(paths); r.resetSettingsCache(); r.clearAllCaches(); r.updateHooksConfigSnapshot()
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
  // Claude Code's refusal reads `<calling mod>: $.<method>: <reason>`.
  assert.match((await command('denied-transcript')).value, /: \$\.session\.messages: Transcript access denied by policy/)
  assert.equal(reads, 0)
  assert.deepEqual(r.getModWarnings(), [])
})

test('transparent API errors still reach an explicit catch handler without a spurious skipped-hook warning', async () => {
  await loadMods([`on('turn.abort',async($,e,next)=>next(e)).catch(async($,e,next)=>({deny:'Handled core refusal: '+next.error.message}));`])
  const result = await r.dispatchModEvent('turn.abort', {turnId:'ended'}, async () => {throw new Error('turn is no longer running')})
  assert.deepEqual(result, {deny:'Handled core refusal: turn is no longer running'})
  assert.deepEqual(r.getModWarnings(), [])
})

test('a racing turn cancels pending compaction and preserves history and Read anchors', async () => {
  let messages = [user('keep this history')], writes = 0
  const context = fixtureContext([], {messages, readFileState: new Map([['cached', 'read anchor']])})
  bind({getModel: () => 'main', getMessages: () => messages,
    setMessages: next => { writes++; messages = next }, getCompactContext: () => context})
  await loadMods([`on('session.start', async($,e,next)=>{
    await $.command.register({name:'request-compact',description:'Request compaction'});return next(e)
  });
  on('command.run',{command:'request-compact'},async($)=>{
    try{return {text:JSON.stringify(await $.session.compact())}}catch(error){return {text:String(error)}}
  });
  on('session.compact',async($,e)=>{
    if(await $.fs.exists('done-waiting'))return {skip:'idle again'};
    try{await $.session.compact();throw Error('recursive compact ran')}catch(error){await $.fs.write('nested-refusal',String(error))}
    await $.clock.sleep(30000);return {messages:[]}
  });`])
  const pending = command('request-compact', context)
  const deadline = Date.now() + 10_000
  while (!existsSync(join(project,'nested-refusal'))) {
    assert.ok(Date.now() < deadline, 'compaction entered its hook')
    await new Promise(done=>setTimeout(done,10))
  }
  assert.match(readFileSync(join(project,'nested-refusal'),'utf8'), /already in progress/)
  assert.match((await command('request-compact',context)).value, /already in progress/)
  const end = r.beginModMainTurn('new-turn', new AbortController())
  try {
    assert.match((await pending).value, /aborted|turn started/i)
    assert.match((await command('request-compact',context)).value, /turn is running/)
  } finally { end() }
  write(join(project,'done-waiting'),'true')
  assert.deepEqual(JSON.parse((await command('request-compact',context)).value),{skip:'idle again'})
  assert.equal(writes,0)
  assert.deepEqual(messages, context.messages)
  assert.equal(context.readFileState.get('cached'),'read anchor')
})

test('compact handles preserve whole native messages and reject stale, duplicate or malformed replacements', () => {
  const rows = Array.from({length:4100}, (_,i)=>user(String(i)))
  const signed = r.createAssistantMessage({content:[
    {type:'thinking',thinking:'retained',signature:'signed'},
    {type:'tool_use',id:'native-call',name:'Read',input:{file_path:'notes.txt'}},
  ]})
  const media = r.createUserMessage({content:[{type:'tool_result',tool_use_id:'native-call',content:[
    {type:'image',source:{type:'base64',media_type:'image/png',data:'native-bytes'}},
  ]}],toolUseResult:{privateRecord:'retained'}})
  rows.push(signed,media)
  const before = structuredClone(rows)
  const handles = new r.CompactMessageHandles(), view = handles.expose(rows)
  assert.equal(view.rows.length,4102,'compaction has no session.messages window truncation')
  const receipt = handles.result({messages:view.rows})
  assert.equal(handles.restore(receipt.messages,view),rows,'unchanged rows retain invisible native attachments too')
  const selected = handles.result({messages:[{...view.rows.at(-2),text:'ignored change'},view.rows.at(-1)]})
  assert.deepEqual(handles.restore(selected.messages,view),[signed,media])
  assert.equal(handles.restore(selected.messages,view)[0],signed)
  assert.deepEqual(rows,before)
  assert.throws(()=>handles.result({messages:[view.rows[0],view.rows[0]]}),/repeated/)
  assert.throws(()=>new r.CompactMessageHandles().result({messages:[view.rows[0]]}),/Unknown/)
  assert.throws(()=>handles.result({messages:[{role:'user',text:'',toolUses:[{tool_use_id:'x',tool:'Read',input:{}}]}]}),/role/)
  assert.throws(()=>handles.result({messages:[],usage:{input_tokens:NaN,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}))
  assert.throws(()=>handles.result({skip:' '}))
  const fresh = handles.result({messages:[{role:'user',text:'new summary',toolUses:[]}]})
  assert.equal(handles.restore(fresh.messages,view)[0].message.content[0].text,'new summary')
})

test('manual compaction cancelled in a completion hook leaves history and Read anchors untouched', async () => {
  let messages = [user('original conversation')], writes = 0
  const context = fixtureContext([], {messages,readFileState:new Map([['cached','original anchor']]),loadedNestedMemoryPaths:new Set(['memory'])})
  bind({getModel:()=> 'main',getMessages:()=>messages,setMessages:next=>{writes++;messages=next}})
  const script = join(project,'compact-hook.cjs'), started = join(project,'compact-hook-started')
  const settings = join(project,'.claude/settings.json')
  write(script,`require('node:fs').writeFileSync(${JSON.stringify(started)},'ready');setTimeout(()=>{},30000)`)
  write(settings,{hooks:{SessionStart:[{matcher:'compact',hooks:[{type:'command',command:process.execPath,args:[script]}]}]}})
  try {
    await loadMods([`on('session.compact',async()=>({messages:[{role:'user',text:'candidate',toolUses:[]}]}));`])
    const pending = r.runCompactTransaction(context,undefined,context.abortController.signal,'manual')
    const rejected = assert.rejects(pending,/aborted|cancelled/i)
    const deadline = Date.now()+10_000
    while(!existsSync(started)) {
      assert.ok(Date.now()<deadline,'completion hook started')
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    context.abortController.abort(new Error('manual compact cancelled'))
    await rejected
    assert.equal(writes,0)
    assert.equal(messages,context.messages)
    assert.equal(context.readFileState.get('cached'),'original anchor')
    assert.deepEqual([...context.loadedNestedMemoryPaths],['memory'])
  } finally {
    context.abortController.abort()
    rmSync(settings,{force:true})
    r.resetSettingsCache();r.clearAllCaches();r.updateHooksConfigSnapshot()
  }
})

// A classic hook that signals it has started, then stays busy if asked to.
function classicHook(name, busy) {
  const script = join(project, `${name}.cjs`), started = join(project, `${name}-started`)
  rmSync(started, {force: true})
  write(script, `require('node:fs').writeFileSync(${JSON.stringify(started)},'ready');${busy ? 'setTimeout(()=>{},30000)' : ''}`)
  return {hook: {type: 'command', command: process.execPath, args: [script]}, started}
}
async function untilExists(path, what) {
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, what)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function withClassicHooks(hooks, run) {
  const settings = join(project, '.claude/settings.json')
  write(settings, {hooks})
  try {
    await loadMods([`on('session.compact',async()=>({messages:[{role:'user',text:'candidate',toolUses:[]}]}));`])
    await run()
  } finally {
    rmSync(settings, {force: true})
    r.resetSettingsCache(); r.clearAllCaches(); r.updateHooksConfigSnapshot()
  }
}
const compactFixture = () => {
  const session = {messages: [user('original conversation')]}
  const context = fixtureContext([], {messages: session.messages, readFileState: new Map([['cached', 'original anchor']]), loadedNestedMemoryPaths: new Set(['memory'])})
  bind({getModel: () => 'main', getMessages: () => session.messages, setMessages: next => { session.messages = next }})
  return {session, context}
}

test('a plugin compaction cancelled after it commits stands, still runs PostCompact and resolves', async () => {
  const {session, context} = compactFixture()
  const start = classicHook('commit-session-start', true), post = classicHook('commit-post-compact', false)
  await withClassicHooks({SessionStart: [{matcher: 'compact', hooks: [start.hook]}], PostCompact: [{hooks: [post.hook]}]}, async () => {
    const pending = r.runCompactTransaction(context, undefined, context.abortController.signal, 'plugin')
    await untilExists(start.started, 'SessionStart runs after the commit')
    assert.equal(session.messages[0].subtype, 'compact_boundary', 'the replacement is already live')
    assert.ok(!existsSync(post.started))
    context.abortController.abort(new Error('stop waiting'))
    const {receipt} = await pending
    assert.equal(receipt.messages[0].text, 'candidate')
    assert.ok(existsSync(post.started), 'PostCompact hears about a compaction that took effect')
    assert.equal(session.messages[0].subtype, 'compact_boundary')
    assert.equal(context.readFileState.size, 0)
    assert.equal(context.loadedNestedMemoryPaths.size, 0)
  })
})

test('manual compaction cancelled during PostCompact stands, because its observers were told', async () => {
  const {context} = compactFixture()
  const post = classicHook('manual-post-compact', true)
  await withClassicHooks({PostCompact: [{hooks: [post.hook]}]}, async () => {
    const pending = r.runCompactTransaction(context, undefined, context.abortController.signal, 'manual')
    await untilExists(post.started, 'PostCompact started')
    context.abortController.abort(new Error('stop waiting'))
    const {result} = await pending
    assert.equal(result.boundaryMarker.subtype, 'compact_boundary')
    assert.equal(context.readFileState.size, 0, 'the accepted replacement clears removed Read anchors')
  })
})

test('manual compaction still refuses a conversation that changed during PostCompact', async () => {
  const {session, context} = compactFixture()
  const post = classicHook('changed-post-compact', true)
  await withClassicHooks({PostCompact: [{hooks: [post.hook]}]}, async () => {
    const pending = r.runCompactTransaction(context, undefined, context.abortController.signal, 'manual')
    const rejected = assert.rejects(pending, /Conversation changed/)
    await untilExists(post.started, 'PostCompact started')
    session.messages = [...session.messages, user('a message that arrived meanwhile')]
    context.abortController.abort(new Error('stop waiting'))
    await rejected
    assert.equal(context.readFileState.get('cached'), 'original anchor')
  })
})

test('manual compaction reports classic hook status lines from both ends of a replacement', async () => {
  const {context} = compactFixture()
  const pre = classicHook('status-pre-compact', false), post = classicHook('status-post-compact', false)
  await withClassicHooks({PreCompact: [{hooks: [pre.hook]}], PostCompact: [{hooks: [post.hook]}]}, async () => {
    const {result} = await r.runCompactTransaction(context, undefined, context.abortController.signal, 'manual')
    assert.match(result.userDisplayMessage, /PreCompact \[.*\] completed successfully/)
    assert.match(result.userDisplayMessage, /PostCompact \[.*\] completed successfully/)
  })
})

test('plugin compaction uses the display commit once and appends completion context without repeating it', async () => {
  const original = user('old scrollback')
  let messages = [original], commits = 0, appends = 0
  const context = fixtureContext([], {messages, readFileState: new Map(), loadedNestedMemoryPaths: new Set()})
  bind({getModel: () => 'main', getMessages: () => messages,
    commitCompaction: next => {commits++; messages = [original, ...next]},
    setMessages: next => {appends++; messages = next},
  })
  const script = join(project, 'fullscreen-completion.cjs')
  write(script, `process.stdout.write('completion context')`)
  await withClassicHooks({SessionStart: [{matcher: 'compact', hooks: [{type: 'command', command: process.execPath, args: [script]}]}]}, async () => {
    const {receipt} = await r.runCompactTransaction(context, undefined, context.abortController.signal, 'plugin')
    assert.equal(commits, 1, 'an accepted plugin compaction calls the dedicated display commit')
    assert.equal(appends, 1, 'completion context uses an ordinary append')
    assert.equal(messages.filter(message => message.uuid === original.uuid).length, 1)
    assert.equal(messages.filter(message => message.subtype === 'compact_boundary').length, 1)
    assert.equal(receipt.messages[0].text, 'candidate')
    assert.equal(messages[0], original, 'display scrollback remains before the API boundary')
  })
})

test('fullscreen compaction keeps one display interval without duplicate native row keys', () => {
  const original = user('previous display row'), kept = user('kept row')
  const boundary = r.createCompactBoundaryMessage('manual', 100), summary = user('new summary')
  const previous = [original, kept], next = [boundary, summary, kept]
  const before = structuredClone(previous), nextBefore = structuredClone(next)
  const displayed = r.preserveModCompactionScrollback(previous, next)
  assert.deepEqual(displayed, [original, boundary, summary, kept])
  assert.equal(new Set(displayed.map(message => message.uuid)).size, displayed.length)
  assert.deepEqual(previous, before)
  assert.deepEqual(next, nextBefore)
  assert.deepEqual(r.preserveModCompactionScrollback(next, [r.createCompactBoundaryMessage('manual', 50), user('next summary')]).slice(0, next.length), next)
})

test('fullscreen shows a kept row once, after its boundary, without changing the list', () => {
  const older = user('older row'), kept = user('kept row'), boundary = r.createCompactBoundaryMessage('auto', 100), summary = user('summary')
  const list = [older, kept, boundary, summary, kept]
  assert.deepEqual(r.withoutRepeatedRows(list), [older, boundary, summary, kept])
  assert.equal(list.length, 5, 'the transcript writer tracks this list by length')
  const unique = [older, kept]
  assert.equal(r.withoutRepeatedRows(unique), unique, 'an ordinary list is returned as it is')
})

test('a replacement drops kept thinking from requests only on models that bind it to the conversation', () => {
  const reply = (id, content) => {
    const message = r.createAssistantMessage({content})
    message.message.id = id
    return message
  }
  const summary = user('Replacement summary')
  const kept = [summary,
    reply('kept-reply', [{type: 'thinking', thinking: 'kept reasoning', signature: 'signed'}]),
    reply('kept-reply', [{type: 'tool_use', id: 'kept-call', name: 'Read', input: {file_path: 'notes.txt'}}]),
    r.createUserMessage({content: [{type: 'tool_result', tool_use_id: 'kept-call', content: 'kept result'}]}),
  ]
  const later = [user('the next prompt'),
    reply('later-reply', [{type: 'thinking', thinking: 'later reasoning', signature: 'signed'}]),
    reply('later-reply', [{type: 'text', text: 'later answer'}]),
    user('another prompt'),
  ]
  const boundary = r.createCompactBoundaryMessage('manual', 100)
  const history = [r.annotateBoundaryWithPreservedSegment(boundary, boundary.uuid, kept, true), ...kept, ...later]
  const before = structuredClone(history)
  const request = (model, messages = history) => JSON.stringify(r.normalizeMessagesForAPI(messages, [], {provider: 'firstParty', model}))
  const nativeBoundary = r.createCompactBoundaryMessage('auto', 100)
  const native = [r.annotateBoundaryWithPreservedSegment(nativeBoundary, summary.uuid, kept.slice(1), true), ...kept, ...later]
  const memoryBoundary = r.createCompactBoundaryMessage('auto', 100)
  const memory = [r.annotateBoundaryWithPreservedSegment(memoryBoundary, summary.uuid, kept.slice(1)), ...kept, ...later]
  const partialBoundary = r.createCompactBoundaryMessage('manual', 100)
  const partial = [r.annotateBoundaryWithPreservedSegment(partialBoundary, summary.uuid, kept.slice(1)), ...kept, ...later]
  const fromBoundary = r.createCompactBoundaryMessage('manual', 100)
  const from = [r.annotateBoundaryWithPreservedSegment(fromBoundary, fromBoundary.uuid, kept), ...kept, user('suffix summary'), ...later]
  for (const [shape, messages] of [['replacement', history], ['recent context', native], ['session memory', memory], ['partial up_to', partial]]) {
    const original = structuredClone(messages)
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5[1m]', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'anthropic/claude-opus-5.5']) {
      const sent = request(model, messages)
      assert.ok(!sent.includes('kept reasoning'), `${shape}: ${model} strips retained thinking`)
      assert.ok(sent.includes('kept-call') && sent.includes('kept result'), `${shape}: ${model} keeps the tool exchange`)
      assert.ok(sent.includes('later reasoning'), `${shape}: ${model} keeps thinking made after compaction`)
      assert.equal(request(model, messages), sent, `${shape}: ${model} sends stable bytes`)
    }
    assert.ok(request('claude-sonnet-4-6', messages).includes('kept reasoning'), `${shape}: older models keep thinking`)
    assert.ok(request('claude-opus-5', messages).includes('kept reasoning'), `${shape}: Opus 5 keeps thinking`)
    assert.deepEqual(messages, original, `${shape}: history stays whole`)
  }
  assert.ok(request('claude-opus-5-5', from).includes('kept reasoning'), 'partial from retains its unchanged prefix')
  assert.deepEqual(history.map(message => message.message?.content), before.map(message => message.message?.content), 'history stays whole')
})

test('compaction cancellation suppresses the error notification while real failures keep it', () => {
  for (const reason of ['user-cancel', new Error('Compaction cancelled')]) {
    const abortController = new AbortController(), notifications = []
    abortController.abort(reason)
    r.addErrorNotificationIfNeeded(reason, {abortController, addNotification: notice => notifications.push(notice)})
    assert.deepEqual(notifications, [], 'a fired abort signal suppresses cancellation errors')
  }
  const notifications = []
  r.addErrorNotificationIfNeeded(new Error('provider failed'), {
    abortController: new AbortController(), addNotification: notice => notifications.push(notice),
  })
  assert.equal(notifications.length, 1, 'a genuine compaction failure is still visible')
  assert.equal(notifications[0].key, 'error-compacting-conversation')
})

test('compact middleware pins identity and validates edits before running the next hook once', async () => {
  const discovered = 'mcp__session_' + serial + '__dynamic'
  let messages = [user('original'),
    r.createAssistantMessage({content:[{type:'tool_use',id:'discovered-call',name:discovered,input:{}}]}),
    r.createUserMessage({content:[{type:'tool_result',tool_use_id:'discovered-call',content:'original result'}]}),
  ]
  const context = fixtureContext([], {messages,readFileState:new Map([['old-file','old anchor']]),loadedNestedMemoryPaths:new Set(['old memory'])})
  bind({getModel:()=> 'main',getMessages:()=>messages,setMessages:next=>{messages=next},getCompactContext:()=>context})
  await loadMods([
    `on('session.start',async($,e,next)=>{await $.command.register({name:'validated-compact',description:'Compact'});return next(e)});
     on('command.run',{command:'validated-compact'},async($)=>({text:JSON.stringify(await $.session.compact())}));
     on('session.compact',async($,e,next)=>{
       const errors=[];
       for (const edited of [{...e,trigger:'auto'},{...e,agentId:'foreign'},{...e,instructions:42},{...e,messages:[{handle:'stale'}]}]) {
         try{await next(edited);throw Error('invalid edit reached next')}catch(error){errors.push(String(error))}
       }
       const result=await next(e);
       try{await next(e);throw Error('repeated next ran')}catch(error){errors.push(String(error))}
       await $.fs.write('compact-refusals.json',JSON.stringify(errors));
       return result;
     });`,
    `on('session.compact',async($,e)=>{
       const count=Number(await $.store.get('count')||0)+1;await $.store.set('count',count);
       await $.fs.write('compact-next-count',String(count));
       return {messages:[{role:'user',text:'validated summary',toolUses:[]}]};
     });`,
  ])
  const value = JSON.parse((await command('validated-compact',context)).value)
  assert.equal(value.messages[0].text,'validated summary')
  const errors=JSON.parse(readFileSync(join(project,'compact-refusals.json'),'utf8'))
  assert.equal(errors.length,5)
  assert.match(errors[0],/cannot rewrite trigger/)
  assert.match(errors[1],/cannot rewrite agentId/)
  assert.match(errors[2],/instructions/)
  assert.match(errors[3],/Unknown/)
  assert.match(errors[4],/already been called/)
  assert.equal(readFileSync(join(project,'compact-next-count'),'utf8'),'1')
  assert.equal(r.getModWarnings().length,0)
  assert.deepEqual(messages[0].compactMetadata.preCompactDiscoveredTools,[discovered],'custom replacement keeps deferred tool discovery')
  assert.equal(context.readFileState.size,0,'accepted replacement clears removed Read anchors')
  assert.equal(context.loadedNestedMemoryPaths.size,0)
})
