import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {after,afterEach,test} from 'node:test'
import {loadMcpRuntime,fixtureContext} from './helpers/mcp-built-runtime.mjs'
import {anthropicReply} from './mcp-instructions/anthropic-reply.mjs'
const original=process.cwd(),root=mkdtempSync(join(tmpdir(),'tau auto mods ')),project=join(root,'project')
mkdirSync(project)
const write=(p,value)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,typeof value==='string'?value:JSON.stringify(value))}
const requests=[]
const server=createServer(async(req,res)=>{if(req.method==='HEAD')return res.end();let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);res.writeHead(200,{'content-type':'text/event-stream'});res.end(anthropicReply('native automatic summary',body.model))})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
Object.assign(process.env,{CLAUDE_CONFIG_DIR:join(root,'config'),CLAUDE_CODE_PLUGIN_CACHE_DIR:join(root,'cache'),
  CLAUDE_CODE_PLUGIN_DIRS:'',CLAUDE_CODE_SIMPLE:'0',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ANTHROPIC_API_KEY:'sk-ant-local-auto',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,
  ENABLE_TOOL_SEARCH:'false',CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:'0.001',TAU_MCP_TEST_BUNDLE:resolve(process.env.TAU_MCP_TEST_BUNDLE??'dist/tau.mjs')})
write(join(root,'config/.claude.json'),{hasCompletedOnboarding:true,autoCompactEnabled:true,activeProvider:'firstParty'})
process.chdir(project)
const r=await loadMcpRuntime({paths:['src/utils/plugins/mods/manager.ts','src/services/compact/autoCompact.ts','src/utils/fileStateCache.ts','src/state/AppState.tsx'],
  exports:['autoCompactIfNeeded','startPluginMods','stopPluginMods','setInlinePlugins','getModWarnings','setOriginalCwd','setSessionTrustAccepted','setAllowedSettingSources','setIsInteractive','resetSettingsCache','clearAllCaches','getManagedFilePath','getDefaultAppState','createFileStateCacheWithSizeLimit','createUserMessage','createAssistantMessage','buildPostCompactMessages','updateHooksConfigSnapshot',
    'recordSidechainTranscript','flushSessionStorage','getAgentTranscript','roughTokenCountEstimationForMessages','createCompactBoundaryMessage','getMessagesAfterCompactBoundary']})
r.getManagedFilePath.cache.set(undefined,join(root,'managed'));r.setOriginalCwd(project);r.setSessionTrustAccepted(true,true);r.setAllowedSettingSources(['projectSettings']);r.setIsInteractive(false)
let serial=0
async function load(body){const plugin=join(root,'plugin-'+(++serial));write(join(plugin,'.claude-plugin/plugin.json'),{name:'auto-history-'+serial,version:'1.0.0'});write(join(plugin,'hooks/hooks.json'),{modules:['./register.ts']});write(join(plugin,'hooks/register.ts'),`export function register(on){${body}}`);r.setInlinePlugins([plugin]);r.resetSettingsCache();r.clearAllCaches();r.updateHooksConfigSnapshot();await r.startPluginMods(true)}
function context(agentId,rows){const messages=rows??[r.createUserMessage({content:'original '+('context '.repeat(250))}),r.createAssistantMessage({content:[{type:'text',text:'previous answer'}]})];
  const c=fixtureContext([],{messages,agentId,readFileState:r.createFileStateCacheWithSizeLimit(10),loadedNestedMemoryPaths:new Set(['memory']),getAppState:()=>r.getDefaultAppState(),canUseTool:async()=>({behavior:'allow'})});
  c.options.mainLoopModel='claude-sonnet-4-6';c.options.querySource=agentId?'agent:custom':'sdk';
  return {c,messages,params:{systemPrompt:[],userContext:{},systemContext:{},toolUseContext:c,forkContextMessages:messages}}
}
const auto=({c,messages,params},tracking)=>r.autoCompactIfNeeded(messages,c,params,c.options.querySource,tracking)
afterEach(async()=>{await r.stopPluginMods();rmSync(join(project,'.claude/settings.json'),{force:true});r.resetSettingsCache();r.updateHooksConfigSnapshot()})
after(async()=>{await r.stopPluginMods();server.closeAllConnections();await new Promise(done=>server.close(done));process.chdir(original);rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})})

test('automatic mod replacement receives its own agent transcript and uses the normal compact result',async()=>{
  await load(`on('session.compact',async($,e)=>{await $.fs.write('auto-input.json',JSON.stringify(e));return {messages:[{role:'user',text:'replacement',toolUses:[]}]}})`)
  const s=context('child-agent'),before=requests.length,result=await auto(s)
  assert.ok(existsSync(join(project,'auto-input.json')),'automatic compaction must dispatch session.compact')
  const e=JSON.parse(readFileSync(join(project,'auto-input.json'),'utf8'))
  assert.equal(e.trigger,'auto');assert.equal(e.agentId,'child-agent');assert.match(e.messages[0].text,/original context/)
  assert.equal(result.wasCompacted,true);assert.equal(requests.length,before,'replacement needs no paid summary')
  assert.equal(r.buildPostCompactMessages(result.compactionResult)[1].message.content[0].text,'replacement')
})

test('automatic skip is once per turn with no failure, cache mutation or model request',async()=>{
  await load(`on('session.compact',async($,e)=>{await $.fs.write('auto-skipped','yes');return {skip:'policy keeps this turn'}})`)
  const s=context(),before=requests.length;s.c.readFileState.set('anchor',{content:'old',timestamp:1})
  const result=await auto(s)
  assert.equal(result.wasCompacted,false,'a mod veto must keep the conversation')
  assert.equal(result.skipReason,'policy keeps this turn');assert.equal(result.consecutiveFailures,undefined)
  assert.equal(requests.length,before);assert.equal(s.c.readFileState.get('anchor').content,'old');assert.deepEqual([...s.c.loadedNestedMemoryPaths],['memory'])
  rmSync(join(project,'auto-skipped'));await auto(s)
  assert.equal(existsSync(join(project,'auto-skipped')),false,'veto is not asked again in this turn')
  s.c.abortController=new AbortController();await auto(s);assert.equal(existsSync(join(project,'auto-skipped')),true,'next turn can reconsider policy')
})

test('classic automatic PreCompact refusal and cancellation do not count as summary failures',async()=>{
  const script=join(project,'block.cjs');write(script,"process.stderr.write('keep context');process.exitCode=2")
  write(join(project,'.claude/settings.json'),{hooks:{PreCompact:[{hooks:[{type:'command',command:process.execPath,args:[script]}]}]}})
  r.resetSettingsCache();r.updateHooksConfigSnapshot()
  const s=context(),before=requests.length,result=await auto(s,{compacted:false,turnId:'turn',turnCounter:1,consecutiveFailures:2})
  assert.equal(result.consecutiveFailures,undefined,'a classic policy refusal is not a failed summarizer')
  assert.equal(result.skipReason,'keep context');assert.equal(requests.length,before)
  s.c.abortController.abort();const aborted=await auto(contextWithSignal(s));assert.equal(aborted.consecutiveFailures,undefined)
})
function contextWithSignal(s){return {...s,c:{...s.c,abortController:s.c.abortController}}}

test('automatic late veto preserves Read state and does not run completion hooks',async()=>{
  await load(`on('session.compact',async($,e,next)=>{await next(e);return {skip:'late policy'}})`)
  const script=join(project,'post.cjs');write(script,"require('node:fs').writeFileSync('auto-post','ran')")
  write(join(project,'.claude/settings.json'),{hooks:{PostCompact:[{hooks:[{type:'command',command:process.execPath,args:[script]}]}]}});r.updateHooksConfigSnapshot()
  const s=context(),original=[...s.messages];s.c.readFileState.set('anchor',{content:'old',timestamp:1})
  const result=await auto(s)
  assert.equal(result.skipReason,'late policy');assert.equal(result.wasCompacted,false);assert.equal(s.c.readFileState.get('anchor').content,'old')
  assert.deepEqual(s.messages,original);assert.equal(existsSync(join(project,'auto-post')),false)
})

test('abort during an automatic hook preserves state without a failure count',async()=>{
  await load(`on('session.compact',async($,e)=>{await $.fs.write('auto-waiting','ready');await $.clock.sleep(30000);return {messages:[]}})`)
  const s=context(),before=requests.length;s.c.readFileState.set('anchor',{content:'old',timestamp:1})
  const pending=auto(s,{compacted:false,turnId:'turn',turnCounter:1,consecutiveFailures:2})
  const deadline=Date.now()+5000
  while(!existsSync(join(project,'auto-waiting'))){assert.ok(Date.now()<deadline,'automatic hook entered');await new Promise(done=>setTimeout(done,10))}
  s.c.abortController.abort(new Error('user-cancel'))
  const result=await pending
  assert.equal(result.wasCompacted,false);assert.equal(result.consecutiveFailures,undefined)
  assert.equal(requests.length,before);assert.equal(s.c.readFileState.get('anchor').content,'old');assert.deepEqual([...s.c.loadedNestedMemoryPaths],['memory'])
})

test('a subagent automatic replacement retains its native tool results after disk resume',async()=>{
  await load(`on('session.compact',async($,e)=>({messages:[{role:'user',text:'child replacement',toolUses:[]},...e.messages.filter(row=>row.toolUses.length||row.toolResults?.length)]}))`)
  const s=context('child-resume-'+serial)
  s.messages.push(r.createAssistantMessage({content:[{type:'tool_use',id:'child-call',name:'Read',input:{file_path:'child.txt'}}]}),
    r.createUserMessage({content:[{type:'tool_result',tool_use_id:'child-call',content:'child retained receipt'}],toolUseResult:{receipt:'child retained receipt'}}))
  await r.recordSidechainTranscript(s.messages,s.c.agentId)
  const result=await auto(s)
  const next=r.buildPostCompactMessages(result.compactionResult)
  await r.recordSidechainTranscript([...next,r.createUserMessage({content:'continue child'})],s.c.agentId)
  await r.flushSessionStorage()
  const resumed=await r.getAgentTranscript(s.c.agentId)
  assert.ok(resumed,'subagent transcript is readable')
  assert.match(JSON.stringify(resumed.messages),/child replacement/)
  assert.match(JSON.stringify(resumed.messages),/child retained receipt/)
  assert.doesNotMatch(JSON.stringify(resumed.messages),/original context/)
})

test('accepted automatic native compaction includes completion context in its final token estimate',async()=>{
  await load(`on('session.compact',async($,e,next)=>next(e))`)
  const script=join(project,'auto-context.cjs')
  write(script,'process.stdout.write('+JSON.stringify(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'retained completion context '.repeat(100)}}))+')')
  write(join(project,'.claude/settings.json'),{hooks:{SessionStart:[{matcher:'compact',hooks:[{type:'command',command:process.execPath,args:[script]}]}]}})
  r.updateHooksConfigSnapshot()
  const result=await auto(context())
  const rows=r.buildPostCompactMessages(result.compactionResult)
  assert.ok(rows.some(row=>row.attachment?.type==='hook_additional_context'))
  assert.equal(result.compactionResult.truePostCompactTokenCount,r.roughTokenCountEstimationForMessages(rows),'final size must include accepted completion context')
})

test('a veto stays with its own conversation when a subagent shares the signal',async()=>{
  await load(`on('session.compact',async($,e)=>{await $.fs.write('asked-'+(e.agentId??'main'),'yes');return e.agentId?{messages:[{role:'user',text:'child replacement',toolUses:[]}]}:{skip:'main policy'}})`)
  const main=context(),child=context('shared-signal-child')
  child.c.abortController=main.c.abortController
  for(const name of ['asked-main','asked-shared-signal-child'])rmSync(join(project,name),{force:true})
  assert.equal((await auto(main)).skipReason,'main policy')
  const result=await auto(child)
  assert.equal(existsSync(join(project,'asked-shared-signal-child')),true,'the subagent gets its own answer')
  assert.equal(result.wasCompacted,true)
  rmSync(join(project,'asked-main'));await auto(main)
  assert.equal(existsSync(join(project,'asked-main')),false,'main is still not asked twice in one turn')
})

test('a hook returning its list unchanged after an earlier compaction leaves one owning boundary',async()=>{
  await load(`on('session.compact',async($,e)=>({messages:e.messages}))`)
  const old=r.createCompactBoundaryMessage('auto',100)
  const rows=[old,r.createUserMessage({content:'old summary',isCompactSummary:true}),r.createUserMessage({content:'next '+('context '.repeat(250))}),r.createAssistantMessage({content:[{type:'text',text:'answer'}]})]
  const before=requests.length,result=await auto(context(undefined,rows)),c=result.compactionResult
  assert.equal(requests.length,before,'no summary was asked for')
  assert.equal(c.messagesToKeep.some(row=>row.subtype==='compact_boundary'),false)
  assert.equal(c.boundaryMarker.compactMetadata.preservedSegment.messageUuids.includes(old.uuid),false)
  assert.equal(r.getMessagesAfterCompactBoundary(r.buildPostCompactMessages(c))[0],c.boundaryMarker,'the new boundary owns the rows')
  assert.deepEqual(c.messagesToKeep.map(row=>row.uuid),rows.slice(1).map(row=>row.uuid))
})

test('Esc while PostCompact runs keeps the compaction its observers were told about',async()=>{
  await load(`on('session.compact',async($,e,next)=>next(e))`)
  const script=join(project,'post-wait.cjs');write(script,"require('node:fs').writeFileSync('post-started','yes');setTimeout(()=>{},1500)")
  rmSync(join(project,'post-started'),{force:true})
  write(join(project,'.claude/settings.json'),{hooks:{PostCompact:[{hooks:[{type:'command',command:process.execPath,args:[script]}]}]}})
  r.resetSettingsCache();r.updateHooksConfigSnapshot()
  const s=context();s.c.readFileState.set('anchor',{content:'old',timestamp:1})
  const pending=auto(s),deadline=Date.now()+60000
  while(!existsSync(join(project,'post-started'))){assert.ok(Date.now()<deadline,'PostCompact started');await new Promise(done=>setTimeout(done,5))}
  s.c.abortController.abort(new Error('user-cancel'))
  const result=await pending
  assert.equal(result.wasCompacted,true,'PostCompact already announced this compaction')
  assert.equal(result.consecutiveFailures,0)
})

test('a rejected automatic replacement tells the user a normal summary ran',async()=>{
  await load(`on('session.compact',async()=>({messages:[{role:'user',text:'row without toolUses'}]}))`)
  const s=context(),notices=[],before=requests.length
  s.c.addNotification=notice=>notices.push(notice)
  const result=await auto(s)
  assert.equal(result.wasCompacted,true)
  assert.equal(requests.length,before+1,'the rejection falls back to one summary')
  assert.equal(notices.length,1)
  assert.equal(notices[0].key,'mod-compact-fallback')
  assert.match(notices[0].text,/auto-history-\d+/)
  assert.match(notices[0].text,/A normal summary ran/)
  const pass=context(),quiet=[]
  await load(`on('session.compact',async($,e,next)=>next(e))`)
  pass.c.addNotification=notice=>quiet.push(notice)
  await auto(pass)
  assert.deepEqual(quiet,[],'an ordinary pass-through stays quiet')
})
