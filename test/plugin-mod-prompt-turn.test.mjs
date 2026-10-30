import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { after, afterEach, test } from 'node:test'
import { fixtureContext, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-turn-')), project = join(root, 'project')
mkdirSync(project)
mkdirSync(join(root, 'config'))
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/query.ts', 'src/utils/plugins/mods/lifecycle.ts', 'src/utils/plugins/mods/manager.ts',
    'src/utils/processUserInput/processUserInput.ts', 'src/history.ts'],
  exports: ['query', 'withModTurnLifecycle', 'replaceSubmittedPromptText', 'processUserInput', 'dispatchModEvent', 'startPluginMods', 'stopPluginMods',
    'getModWarnings', 'setInlinePlugins', 'clearAllCaches', 'resetSettingsCache', 'setOriginalCwd',
    'setSessionTrustAccepted', 'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath',
    'createUserMessage', 'createAssistantMessage', 'createStore', 'onChangeAppState', 'normalizeMessagesForAPI',
    'addToHistory', 'capturePromptHistoryEntry', 'revisePromptHistoryEntry', 'getHistory', 'enqueue', 'dequeueAllMatching', 'clearCommandQueue',
    'getHistoryControl: () => ({flushPromptHistory, immediateFlushHistory, pending: pendingEntries.length, isWriting, currentFlushPromise})',
    'setHistoryAutoFlush: fn => {flushPromptHistory=fn}',
    'getPromptTurnDeps: () => ({executeUserPromptSubmitHooks, getAttachmentMessages})',
    'setPromptTurnDeps: d => {executeUserPromptSubmitHooks=d.executeUserPromptSubmitHooks; getAttachmentMessages=d.getAttachmentMessages}',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setIsInteractive(false)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const originalDeps = r.getPromptTurnDeps()
const empty = () => (async function* () {})()
r.setPromptTurnDeps({ executeUserPromptSubmitHooks: empty, getAttachmentMessages: empty })
let serial = 0
const write = (path, value) => { mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
async function mod(source) {
  const path = join(root, `plugin-${++serial}`)
  write(join(path, '.claude-plugin/plugin.json'), {name: `turn-fixture-${serial}`, version: '1.0.0'})
  write(join(path, 'hooks/hooks.json'), {modules: ['./register.ts']})
  write(join(path, 'hooks/register.ts'), `export function register(on){${source}}`)
  r.setInlinePlugins([path]); r.resetSettingsCache(); r.clearAllCaches()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
}
afterEach(async () => { await r.stopPluginMods() })
after(async () => {
  r.setPromptTurnDeps(originalDeps); await r.stopPluginMods(); await settleHistory(); process.chdir(original)
  rmSync(root, {recursive: true, force: true, maxRetries: 10})
})
function context(tools = [], commands = [], agentId) {
  const base = fixtureContext(tools).getAppState()
  const store = r.createStore({...base, tasks: {}, settings: {}, speculation: {status: 'idle'}, mainLoopModel: 'fixture-model'}, r.onChangeAppState)
  return fixtureContext(tools, {
    getAppState: store.getState, setAppState: store.setState, readFileState: new Map(),
    setMessages() {}, setResponseLength() {}, setInProgressToolUseIDs() {}, setHasInterruptibleToolInProgress() {},
    ...(agentId ? {agentId} : {}),
    options: {tools, commands, mainLoopModel: 'fixture-model', mcpClients: [], isNonInteractiveSession: true, agentDefinitions: {activeAgents: []}},
  })
}
const permit = async (_tool, input) => ({behavior: 'allow', updatedInput: input})
const submit = (input, ctx = context(), extra = {}) => r.processUserInput({input, mode: 'prompt', context: ctx, canUseTool: permit, setToolJSX() {}, skipAttachments: true, ...extra})
async function drain(iterator) {
  const output = []
  for (;;) { const next = await iterator.next(); if (next.done) return {output, terminal: next.value}; output.push(next.value) }
}
async function historyEntries(runtime = r) { const entries=[];for await(const entry of runtime.getHistory())entries.push(entry);return entries }
function promptText(result) {
  const content=result.messages.find(message=>message.type==='user').message.content
  return typeof content==='string'?content:content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
}
async function settleHistory() {
  const deadline=Date.now()+10_000
  while(r.getHistoryControl().pending || r.getHistoryControl().isWriting) {
    assert.ok(Date.now()<deadline,'history flush completed')
    await new Promise(resolve=>setTimeout(resolve,20))
  }
}
function assistant(id, text, usage) {
  const result = r.createAssistantMessage({content: typeof text === 'string' ? [{type: 'text', text}] : text})
  result.message.id = id
  if (usage) result.message.usage = usage
  return result
}
const usage = {input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7}

test('prompt rewrite reaches transcript, settings hooks and history while preserving SDK attachments', async () => {
  await mod(`on('prompt.submit',async($,e,next)=>next({...e,text:'rewritten',context:['private guidance']}));`)
  let hookText
  r.setPromptTurnDeps({executeUserPromptSubmitHooks: text => {hookText=text;return empty()}, getAttachmentMessages: empty})
  // Use an opaque document attachment to avoid the image resizer's network path.
  const attachment = {type: 'document', source: {type: 'text', media_type: 'text/plain', data: 'attachment bytes'}}
  const result = await submit([attachment, {type: 'text', text: 'original'}])
  assert.equal(result.shouldQuery, true)
  assert.equal(result.messages[0].message.content[0], attachment)
  assert.equal(result.messages[0].message.content.at(-1).text, 'rewritten')
  assert.match(hookText, /rewritten/)
  assert.match(JSON.stringify(result.messages), /private guidance/)
  const historyId=randomUUID()
  r.addToHistory('original history',historyId)
  await submit('original history',context(),{uuid:historyId})
  assert.equal((await historyEntries())[0].display, 'rewritten')
})

test('prompt drop prevents settings hooks and skill interpolation and restores typed text', async () => {
  await mod(`on('prompt.submit',async()=>({drop:'policy refused'}));`)
  let expanded=0, hooked=0
  r.setPromptTurnDeps({executeUserPromptSubmitHooks: () => {hooked++;return empty()}, getAttachmentMessages: empty})
  const skill = {name:'fixture', type:'prompt', getPromptForCommand:async()=>{expanded++;return []}, isEnabled:()=>true, userInvocable:true}
  const result = await submit('/fixture secret', context([], [skill]))
  assert.equal(result.shouldQuery, false); assert.equal(expanded, 0); assert.equal(hooked, 0)
  assert.match(result.resultError, /Prompt dropped by a hook: policy refused/)
  assert.equal(result.nextInput, '/fixture secret')
  assert.doesNotMatch(JSON.stringify(result.messages), /secret/)
})

test('a prompt answer without next enters nothing and post-next context cannot change what entered', async () => {
  await mod(`on('prompt.submit',async()=>({text:'handled without next'}));`)
  const handled = await submit('original')
  assert.equal(handled.shouldQuery, false)
  assert.doesNotMatch(JSON.stringify(handled.messages), /handled without next/)
  await mod(`on('prompt.submit',async($,e,next)=>{const result=await next({...e,text:'accepted',context:['early context']});return {...result,context:['late context']}});`)
  const accepted = await submit('original')
  assert.equal(accepted.shouldQuery, true)
  assert.equal(promptText(accepted), 'accepted')
  assert.match(JSON.stringify(accepted.messages), /early context/)
  assert.doesNotMatch(JSON.stringify(accepted.messages), /late context/)
})

test('an own-turn abort at turn.start returns normally without sampling or a hook warning', async () => {
  await mod(`on('turn.start',async($,e,next)=>{await $.turn.abort({turnId:e.turnId});return next(e)});on('turn.complete',async($,e,next)=>{await $.fs.write('own-abort-complete.json',JSON.stringify(e));return next(e)});`)
  const ctx = context()
  let sampled = false
  const result = await drain(r.query({messages:[r.createUserMessage({content:'abort before sampling'})],systemPrompt:[],userContext:{},systemContext:{},canUseTool:permit,toolUseContext:ctx,querySource:'repl_main_thread',deps:{
    callModel:async function*(){sampled=true;throw new Error('aborted turn sampled')},
  }}))
  assert.equal(sampled, false)
  assert.deepEqual(result.terminal, {reason:'aborted_tools'})
  assert.equal(JSON.parse(readFileSync(join(project,'own-abort-complete.json'),'utf8')).isAborted, true)
  assert.deepEqual(r.getModWarnings(), [])
})

test('local commands bypass prompt hooks; late drops reuse the accepted result once', async () => {
  await mod(`on('prompt.submit',async($,e,next)=>{await next({...e,text:'accepted'});return {drop:'too late'}});`)
  let calls=0
  const accepted = await r.dispatchModEvent('prompt.submit', {text:'before',origin:{kind:'sdk'},wait:true,turnId:'p'}, async e=>{calls++;return {text:e.text}})
  assert.deepEqual(accepted,{text:'accepted'}); assert.equal(calls,1)
  assert.match(r.getModWarnings().join('\n'), /a drop after its next\(\) was answered/)
  const local = {name:'local-fixture',type:'local',isEnabled:()=>true,load:async()=>({call:async()=>({type:'text',value:'local output'})})}
  assert.equal((await submit('/local-fixture',context([], [local]))).shouldQuery,false)
})

test('prompt and turn identity fields cannot be rewritten', async () => {
  await mod(`on('prompt.submit',async($,e,next)=>next({...e,origin:{kind:'forged'},wait:false,turnId:'forged'}));on('turn.start',async($,e,next)=>next({...e,turnId:'forged'}));`)
  let received
  await r.dispatchModEvent('prompt.submit',{text:'unchanged',origin:{kind:'sdk'},wait:true,turnId:'stable'},async e=>{received=e;return {text:e.text}})
  assert.deepEqual(received,{text:'unchanged',origin:{kind:'sdk'},wait:true,turnId:'stable'})
  assert.deepEqual(await r.dispatchModEvent('turn.start',{turnId:'stable'},async e=>({turnId:e.turnId})),{turnId:'stable'})
})

test('query emits one lifecycle pair across tool iterations; totals dedupe response blocks and preserve cache prefix', async () => {
  await mod(`let started;on('turn.start',async($,e,next)=>{started=e.turnId;return next(e)});on('turn.complete',async($,e,next)=>{await $.fs.write('completion.json',JSON.stringify({...e,started}));return {text:'UI completion line'}});`)
  const probe = fixtureTool(), ctx=context([probe]), requests=[]
  const prefix = Object.freeze(['frozen prefix']), tools=ctx.options.tools
  const result = await drain(r.query({messages:[r.createUserMessage({content:'go'})],systemPrompt:prefix,userContext:{},systemContext:{},canUseTool:permit,toolUseContext:ctx,querySource:'repl_main_thread',deps:{
    uuid:()=>`request-${requests.length}`,microcompact:async messages=>({messages}),autocompact:async()=>({compactionResult:undefined,consecutiveFailures:0}),
    callModel:async function*(params){requests.push(params);if(requests.length===1)yield assistant('request-one',[{type:'tool_use',id:'tool-fixture',name:'FixtureTool',input:{}}],usage);else {yield assistant('request-two','final answer',usage);yield assistant('request-two','second block',usage)}},
  }}))
  assert.equal(requests.length,2); assert.equal(probe.calls.length,1)
  const completion=JSON.parse(readFileSync(join(project,'completion.json'),'utf8'))
  assert.equal(completion.started,completion.turnId);assert.equal(completion.isAborted,false)
  assert.equal(completion.answer,'final answer\nsecond block')
  assert.deepEqual(completion.usage,Object.fromEntries(Object.entries(usage).map(([k,v])=>[k,2*v])))
  assert.equal(result.output.at(-1).content,'UI completion line')
  assert.ok(result.output.some(m=>m.type==='assistant'&&m.message.content.some(b=>b.text==='final answer')))
  assert.doesNotMatch(JSON.stringify(r.normalizeMessagesForAPI(result.output,tools)),/UI completion line/)
  assert.deepEqual(prefix,['frozen prefix']);assert.equal(ctx.options.tools,tools)
})

test('turn.complete runs once on return, throw and abort, including agents without turn.start', async () => {
  await mod(`let starts=0,completes=0;on('turn.start',async($,e,next)=>{starts++;return next(e)});on('turn.complete',async($,e,next)=>{completes++;await $.fs.write('termination.json',JSON.stringify({starts,completes,...e}));return next(e)});`)
  let expected=0
  for (const kind of ['return','throw','abort']) {
    const ctx=context([],[],kind==='abort'?'agent-fixture':undefined)
    const source=(async function*(){yield assistant('termination','partial',usage);if(kind==='throw')throw new Error('fixture failed');if(kind==='abort')ctx.abortController.abort();return 'done'})()
    const wrapped=r.withModTurnLifecycle(source,ctx,permit)
    await wrapped.next()
    if(kind==='return')await wrapped.return()
    else if(kind==='throw')await assert.rejects(wrapped.next(),/fixture failed/)
    else await drain(wrapped)
    const event=JSON.parse(readFileSync(join(project,'termination.json'),'utf8'))
    assert.equal(event.completes,++expected);assert.equal(event.isAborted,true)
    if(kind==='abort'){assert.equal(event.agentId,'agent-fixture');assert.equal(event.starts,2)}
  }
})

test('aborting an active turn.start host wait preserves completion and later hooks', {timeout:10_000}, async () => {
  await mod(`let starts=0,completes=0;on('turn.start',async($,e,next)=>{
    starts++;
    if(starts===1){
      next.signal.addEventListener('abort',()=>{throw new Error('abort listener failed')});
      next.signal.addEventListener('abort',async()=>{await Promise.resolve();throw new Error('async abort listener failed')});
      try {await Promise.all([$.clock.sleep(30000),$.fs.write('abort-waiting.txt','waiting')])}
      catch {await $.fs.write('after-cancel.txt','must not run')}
    }
    return next(e)
  });on('turn.complete',async($,e,next)=>{
    if(completes===0){const end=Date.now()+1200;while(Date.now()<end){}}
    await $.fs.write('abort-completion.json',JSON.stringify({starts,completes:++completes,...e}));return next(e)
  });`)
  const ctx=context()
  let ran=false
  const wrapped=r.withModTurnLifecycle((async function*(){ran=true;return 'aborted source'})(),ctx,permit)
  // Attach a rejection handler before waiting for the worker's marker.
  const pending=wrapped.next().then(value=>({value}),error=>({error}))
  try {
    const deadline=Date.now()+3000
    while(!existsSync(join(project,'abort-waiting.txt'))) {
      assert.ok(Date.now()<deadline,'turn.start reached its active clock.sleep')
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    ctx.abortController.abort()
    assert.match((await pending).error?.message??'',/Mod event aborted/)
    assert.equal(ran,false)
    const aborted=JSON.parse(readFileSync(join(project,'abort-completion.json'),'utf8'))
    // This completion legitimately runs longer than the old invocation's
    // cancellation watchdog; it must start only after that watchdog is cleared.
    assert.equal(aborted.starts,1);assert.equal(aborted.completes,1);assert.equal(aborted.isAborted,true)
    assert.equal(existsSync(join(project,'after-cancel.txt')),false,'cancelled handlers cannot issue later host effects')

    const normal=await drain(r.withModTurnLifecycle((async function*(){return 'next source'})(),context(),permit))
    assert.equal(normal.terminal,'next source')
    const completed=JSON.parse(readFileSync(join(project,'abort-completion.json'),'utf8'))
    assert.equal(completed.starts,2);assert.equal(completed.completes,2);assert.equal(completed.isAborted,false)
    assert.deepEqual(r.getModWarnings(),[])
  } finally {
    ctx.abortController.abort()
    await pending
    await wrapped.return()
  }
})

test('history revisions retain explicit entry identity when another prompt arrives', async () => {
  const firstId=randomUUID(),secondId=randomUUID()
  r.addToHistory('first',firstId);const token=r.capturePromptHistoryEntry(firstId)
  r.addToHistory('second',secondId);r.revisePromptHistoryEntry(token,'first rewritten')
  const displays=[];for await(const entry of r.getHistory()){displays.push(entry.display);if(displays.length===2)break}
  assert.deepEqual(displays,['second','first rewritten'])
  const second=r.capturePromptHistoryEntry(secondId);r.revisePromptHistoryEntry(second,null)
  const rest=[];for await(const entry of r.getHistory())rest.push(entry.display)
  assert.ok(!rest.includes('second'))
})

test('large pasted text creates its history identity synchronously before rewrite or drop', async () => {
  await mod(`on('prompt.submit',async($,e,next)=>e.text.startsWith('drop ')?{drop:'paste refused'}:next({...e,text:'large paste rewritten'}));`)
  const pasted='pasted content '.repeat(200), pastedContents={1:{id:1,type:'text',content:pasted}}
  for(const action of ['rewrite','drop']) {
    const display=`${action} [Pasted text #1]`
    const id=randomUUID()
    assert.equal(r.addToHistory({display,pastedContents},id),id,'history identity exists synchronously before paste storage')
    const result=await submit(`${action} ${pasted}`,context(),{uuid:id,preExpansionInput:display,pastedContents})
    const entries=[];for await(const entry of r.getHistory())entries.push(entry)
    assert.ok(!entries.some(entry=>entry.display===display))
    if(action==='rewrite') {
      assert.equal(result.shouldQuery,true)
      assert.equal(entries[0].display,'large paste rewritten')
      assert.equal(entries[0].pastedContents[1].content,pasted)
    } else {
      assert.equal(result.shouldQuery,false)
      assert.match(result.resultError,/paste refused/)
    }
  }
})

test('compact, summary and prompt helper queries do not emit conversation lifecycle events', async () => {
  await mod(`on('turn.start',async($,e,next)=>{await $.fs.write('helper-events.txt','start');return next(e)});on('turn.complete',async($,e,next)=>{await $.fs.write('helper-events.txt','complete');return next(e)});`)
  for(const querySource of ['compact','tool_use_summary_generation','hook_prompt']) {
    let calls=0
    await drain(r.query({messages:[r.createUserMessage({content:'helper'})],systemPrompt:[],userContext:{},systemContext:{},canUseTool:permit,toolUseContext:context(),querySource,deps:{
      uuid:()=>`helper-${querySource}`,microcompact:async messages=>({messages}),autocompact:async()=>({compactionResult:undefined,consecutiveFailures:0}),
      callModel:async function*(){calls++;yield assistant(querySource,'helper output',usage)},
    }}))
    assert.equal(calls,1)
    assert.equal(existsSync(join(project,'helper-events.txt')),false,querySource)
  }
})

test('prompt and turn hooks receive the active permission host and tool inventory', async () => {
  await mod(`on('prompt.submit',async($,e,next)=>{await $.tool.call({tool:'FixtureTool',path:'prompt'});return next(e)});on('turn.start',async($,e,next)=>{await $.tool.call({tool:'FixtureTool',path:'start'});return next(e)});on('turn.complete',async($,e,next)=>{await $.tool.call({tool:'FixtureTool',path:'complete'});return next(e)});`)
  const candidate=fixtureTool({isEnabled:()=>true,inputSchema:{parse:value=>value,safeParse:value=>({success:true,data:value})}})
  const ctx=context([candidate])
  const decisions=[]
  const canUseTool=async(tool,input)=>{decisions.push([tool.name,input.path]);return {behavior:'allow',updatedInput:input}}
  await submit('use active tools',ctx,{canUseTool})
  await drain(r.withModTurnLifecycle((async function*(){yield assistant('bound-tools','answer',usage);return 'done'})(),ctx,canUseTool))
  assert.deepEqual(candidate.calls,[{path:'prompt'},{path:'start'},{path:'complete'}])
  assert.deepEqual(decisions,[['FixtureTool','prompt'],['FixtureTool','start'],['FixtureTool','complete']])
  assert.deepEqual(r.getModWarnings(),[])
})

test('SDK prompt hooks inspect all text blocks and rewriting removes earlier text without touching attachments', async () => {
  await mod(`on('prompt.submit',async($,e,next)=>{await $.fs.write('sdk-prompt.txt',e.text);return next({...e,text:'safe replacement'})});`)
  const before={type:'document',source:{type:'text',media_type:'text/plain',data:'before bytes'}}
  const between={type:'document',source:{type:'text',media_type:'text/plain',data:'between bytes'}}
  const after={type:'document',source:{type:'text',media_type:'text/plain',data:'after bytes'}}
  const result=await submit([before,{type:'text',text:'first secret'},between,{type:'text',text:'last text'},after])
  assert.equal(readFileSync(join(project,'sdk-prompt.txt'),'utf8'),'first secret\nlast text')
  const content=result.messages[0].message.content
  assert.deepEqual(content.filter(block=>block.type==='text').map(block=>block.text),['safe replacement'])
  const documents=content.filter(block=>block.type==='document')
  assert.deepEqual(documents,[before,between,after]);assert.equal(documents[0],before);assert.equal(documents[1],between);assert.equal(documents[2],after)
  assert.doesNotMatch(JSON.stringify(result.messages),/first secret|last text/)

  await mod(`on('prompt.submit',async($,e,next)=>next(e));`)
  const unchanged=[{type:'text',text:'one'},between,{type:'text',text:'two'}]
  const same=await submit(unchanged)
  assert.equal(r.replaceSubmittedPromptText(unchanged,'one\ntwo'),unchanged,'an unchanged hook preserves the exact input array')
  assert.deepEqual(same.messages[0].message.content,unchanged)
})

test('SDK command-like text followed by a document is submitted through the drop hook', async () => {
  await mod(`on('prompt.submit',async($,e,next)=>e.text.includes('secret')||e.text.includes('/local-fixture')?{drop:'SDK policy'}:next(e));`)
  let localCalls=0
  const local={name:'local-fixture',type:'local',isEnabled:()=>true,load:async()=>({call:async()=>{localCalls++;return {type:'text',value:'local output'}}})}
  const document={type:'document',source:{type:'text',media_type:'text/plain',data:'attachment'}}
  for(const input of [[{type:'text',text:'/local-fixture'},document],[{type:'text',text:'first secret'},document,{type:'text',text:'innocent last'}]]) {
    const result=await submit(input,context([],[local]))
    assert.equal(result.shouldQuery,false);assert.match(result.resultError,/SDK policy/)
  }
  assert.equal(localCalls,0)
})

test('completed usage reads native final mutations after assistant yield and deduplicates provider response IDs', async () => {
  await mod(`on('turn.complete',async($,e,next)=>{await $.fs.write('late-usage.json',JSON.stringify(e));return next(e)});`)
  let requests=0
  const probe=fixtureTool({backfillObservableInput:input=>{input.observable=true}}),ctx=context([probe])
  await drain(r.query({messages:[r.createUserMessage({content:'late streaming usage'})],systemPrompt:[],userContext:{},systemContext:{},canUseTool:permit,toolUseContext:ctx,querySource:'sdk',deps:{
    uuid:()=>`late-${requests}`,microcompact:async messages=>({messages}),autocompact:async()=>({compactionResult:undefined,consecutiveFailures:0}),
    callModel:async function*(){
      requests++
      const id=`provider-response-${requests}`
      yield {type:'stream_event',event:{type:'message_start',message:{id}}}
      const completed=assistant(id,requests===1?[{type:'tool_use',id:'late-tool',name:'FixtureTool',input:{}}]:'complete text',{...usage,output_tokens:0})
      yield completed
      completed.message.usage={...usage,output_tokens:requests===1?41:13}
      yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:requests===1?'tool_use':'end_turn'},usage:{output_tokens:requests===1?41:13}}}
    },
  }}))
  const event=JSON.parse(readFileSync(join(project,'late-usage.json'),'utf8'))
  assert.equal(requests,2);assert.equal(event.usage.output_tokens,54)
  assert.equal(event.usage.input_tokens,4);assert.equal(event.usage.cache_read_input_tokens,10)
})

test('queued submissions revise their explicit history IDs even with equal text and out-of-order processing', async () => {
  await mod(`let seen=0;on('prompt.submit',async($,e,next)=>next({...e,text:e.text+' rewritten '+(++seen)}));`)
  for(const [a,b] of [['queued distinct A','queued distinct B'],['queued identical','queued identical']]) {
    const aId=randomUUID(),bId=randomUUID()
    r.addToHistory(a,aId);r.enqueue({value:a,mode:'prompt',uuid:aId})
    r.addToHistory(b,bId);r.enqueue({value:b,mode:'prompt',uuid:bId})
    const queued=r.dequeueAllMatching(()=>true)
    assert.deepEqual(queued.map(command=>command.uuid),[aId,bId])
    // Process B before A to prove association does not depend on text or FIFO.
    const bResult=await submit(queued[1].value,context(),{uuid:queued[1].uuid})
    const aResult=await submit(queued[0].value,context(),{uuid:queued[0].uuid})
    await settleHistory()
    const rows=readFileSync(join(root,'config','history.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
    const latest=id=>rows.findLast(row=>row.id===id)
    assert.equal(latest(aId).display,promptText(aResult))
    assert.equal(latest(bId).display,promptText(bResult))
  }
  const savedId=r.addToHistory('saved Esc draft')
  const sdk=await submit('saved Esc draft')
  assert.equal(sdk.shouldQuery,true)
  assert.equal(r.capturePromptHistoryEntry(savedId),undefined,'unsent saved history is never eligible')
  assert.ok((await historyEntries()).some(entry=>entry.display==='saved Esc draft'))
})

test('history readers retain a pending snapshot while a flush clears the live queue', async () => {
  await settleHistory()
  const control=r.getHistoryControl()
  r.setHistoryAutoFlush(async()=>{})
  let reader
  try {
    r.addToHistory('snapshot older',randomUUID());r.addToHistory('snapshot newer',randomUUID())
    reader=r.getHistory()
    assert.equal((await reader.next()).value.display,'snapshot newer')
    await control.immediateFlushHistory()
    assert.equal(r.getHistoryControl().pending,0,'the flush cleared the live pending array')
    assert.equal((await reader.next()).value.display,'snapshot older')
  } finally { await reader?.return();r.setHistoryAutoFlush(control.flushPromptHistory) }
})

test('flushed history revisions and drops persist in original order when a fresh runtime reads the file', async () => {
  const firstId=randomUUID(),secondId=randomUUID()
  r.addToHistory('persist older',firstId);r.addToHistory('persist newer',secondId)
  await settleHistory()
  assert.ok(readFileSync(join(root,'config','history.jsonl'),'utf8').includes(firstId))
  r.revisePromptHistoryEntry(r.capturePromptHistoryEntry(firstId),'persist older revised')
  await settleHistory()
  const fresh=await loadMcpRuntime({paths:['src/history.ts'],exports:['getHistory','setOriginalCwd']})
  fresh.setOriginalCwd(project)
  assert.deepEqual((await historyEntries(fresh)).filter(entry=>entry.display.startsWith('persist ')).map(entry=>entry.display),['persist newer','persist older revised'])
  r.revisePromptHistoryEntry(r.capturePromptHistoryEntry(secondId),null)
  await settleHistory()
  assert.deepEqual((await historyEntries(fresh)).filter(entry=>entry.display.startsWith('persist ')).map(entry=>entry.display),['persist older revised'])
})

test('ordinary prompt processing and queue cancellation release their history submission IDs without mods', async () => {
  for(const [input,mode] of [['ordinary prompt','prompt'],['!!','bash']]) {
    const id=randomUUID()
    r.addToHistory(input,id)
    await submit(input,context(),{uuid:id,mode})
    assert.equal(r.capturePromptHistoryEntry(id),undefined,'processing consumed its identity even without a mod')
  }
  const canceled=randomUUID()
  r.addToHistory('canceled queued prompt',canceled)
  r.enqueue({value:'canceled queued prompt',mode:'prompt',uuid:canceled})
  r.clearCommandQueue()
  assert.equal(r.capturePromptHistoryEntry(canceled),undefined)
})

test('mid-turn user prompts wait for submission hooks while task notifications still reach the running query', async () => {
  await mod(`let submits=0;on('prompt.submit',async($,e,next)=>{await $.fs.write('deferred-submit.txt',String(++submits));return next({...e,text:'approved queued input'})});`)
  const id=randomUUID(),prompt='queued midturn secret',requests=[]
  r.addToHistory(prompt,id)
  r.enqueue({value:prompt,mode:'prompt',priority:'next',uuid:id})
  r.enqueue({value:'background finished',mode:'task-notification',priority:'next'})
  const probe=fixtureTool(),ctx=context([probe])
  r.setPromptTurnDeps({executeUserPromptSubmitHooks:empty,getAttachmentMessages:originalDeps.getAttachmentMessages})
  try {
    await drain(r.query({messages:[r.createUserMessage({content:'running turn'})],systemPrompt:[],userContext:{},systemContext:{},canUseTool:permit,toolUseContext:ctx,querySource:'repl_main_thread',deps:{
      uuid:()=>`queued-${requests.length}`,microcompact:async messages=>({messages}),autocompact:async()=>({compactionResult:undefined,consecutiveFailures:0}),
      callModel:async function*({messages}){requests.push(messages);yield assistant(`queue-response-${requests.length}`,requests.length===1?[{type:'tool_use',id:'queue-round',name:'FixtureTool',input:{}}]:'running turn finished',usage)},
    }}))
    assert.equal(requests.length,2)
    assert.doesNotMatch(JSON.stringify(requests),/queued midturn secret/)
    assert.match(JSON.stringify(requests[1]),/background finished/)
    assert.equal(existsSync(join(project,'deferred-submit.txt')),false)
    const queued=r.dequeueAllMatching(()=>true)
    assert.equal(queued.length,1);assert.equal(queued[0].uuid,id)
    const result=await submit(queued[0].value,ctx,{uuid:queued[0].uuid})
    assert.equal(promptText(result),'approved queued input')
    assert.equal(readFileSync(join(project,'deferred-submit.txt'),'utf8'),'1')
  } finally {r.clearCommandQueue();r.setPromptTurnDeps({executeUserPromptSubmitHooks:empty,getAttachmentMessages:empty})}
})
