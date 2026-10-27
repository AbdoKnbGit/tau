import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { after, afterEach, test } from 'node:test'
import { fixtureContext, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const original = process.cwd(), root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-skill-prompt-'))), project = join(root, 'project with spaces')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/skillPrompt.ts', 'src/utils/plugins/mods/manager.ts',
    'src/utils/plugins/loadPluginCommands.ts', 'src/skills/loadSkillsDir.ts',
    'src/utils/processUserInput/processSlashCommand.tsx', 'src/tools/SkillTool/SkillTool.ts',
    'src/utils/forkedAgent.ts', 'src/tools/AgentTool/runAgent.ts'],
  exports: ['applySkillPromptMods', 'expandSkillPrompt', 'createSkillMetadata', 'parseFrontmatter',
    'loadSkillsFromSkillsDir', 'loadSkillsFromCommandsDir', 'loadSkillsFromDirectory', 'getPluginCommands',
    'processPromptSlashCommand', 'prepareForkedCommandContext', 'SkillTool', 'getBuiltInAgents',
    'getInvokedSkills', 'clearInvokedSkills', 'getModWarnings', 'dispatchModEvent', 'withModToolContext',
    'startPluginMods', 'stopPluginMods', 'setInlinePlugins', 'clearAllCaches', 'resetSettingsCache',
    'setOriginalCwd', 'setSessionTrustAccepted', 'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath',
    'createAssistantMessage', 'createStore', 'onChangeAppState',
    'runAgent', 'createUserMessage', 'getSessionHooks',
    'getSkillPromptDeps: () => ({getAttachmentMessages,query})',
    'setSkillPromptDeps: d => {if(d.getAttachmentMessages)getAttachmentMessages=d.getAttachmentMessages;if(d.query)query=d.query}',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project); r.setSessionTrustAccepted(true, true); r.setIsInteractive(false)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const deps = r.getSkillPromptDeps()
r.setSkillPromptDeps({getAttachmentMessages: () => (async function* () {})()})
let serial = 0
const write = (path, data) => { mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)) }
const read = path => JSON.parse(readFileSync(join(project, path), 'utf8'))
async function mod(source, manifest = {}) {
  const path = join(root, `plugin-${++serial}`)
  write(join(path, '.claude-plugin/plugin.json'), {name: `skill-fixture-${serial}`, version: '1.0.0', ...manifest})
  write(join(path, 'hooks/hooks.json'), {modules: ['./register.ts']})
  write(join(path, 'hooks/register.ts'), `export function register(on){${source}}`)
  r.setInlinePlugins([path]); r.resetSettingsCache(); r.clearAllCaches()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  return path
}
afterEach(async () => { await r.stopPluginMods(); r.clearInvokedSkills(); r.setSkillPromptDeps({query:deps.query}) })
after(async () => {
  r.setSkillPromptDeps(deps); await r.stopPluginMods(); process.chdir(original)
  rmSync(root, {recursive: true, force: true, maxRetries: 20})
})
function context(tools = [], commands = [], agentId) {
  const base = fixtureContext(tools).getAppState()
  base.toolPermissionContext.additionalWorkingDirectories = new Map()
  const store = r.createStore({...base, mcp:{...base.mcp,commands:commands.map(c=>({...c,loadedFrom:'mcp'}))},
    tasks: {}, todos: {}, settings: {}, speculation:{status:'idle'}, mainLoopModel: 'claude-sonnet-4-6'}, r.onChangeAppState)
  return fixtureContext(tools, {getAppState: store.getState, setAppState: store.setState, readFileState: new Map(),
    ...(agentId ? {agentId} : {}),
    options: {tools, commands, mainLoopModel: 'claude-sonnet-4-6', mcpClients: [], isNonInteractiveSession: true,
      agentDefinitions: {activeAgents: r.getBuiltInAgents()}},
  })
}
const permit = async (_tool, input) => ({behavior: 'allow', updatedInput: input})
const text = blocks => typeof blocks === 'string' ? blocks : blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
const command = (extra = {}) => ({name: 'example', type: 'prompt', source: 'builtin', description: 'Example', contentLength: 8,
  progressMessage: 'loading', isEnabled: () => true, userInvocable: true, userFacingName: () => 'example',
  getPromptForCommand: async args => [{type: 'text', text: `original ${args}`}], ...extra})

test('frontmatter snapshots preserve plain YAML data and explain omitted data without changing the parser output', () => {
  const parsed = r.parseFrontmatter('---\nname: sample\ncustom: {values: [true, null, 12]}\n---\nbody')
  const snapshot = r.createSkillMetadata(parsed.frontmatter, join(project, 'SKILL.md'))
  assert.deepEqual(snapshot.frontmatter, parsed.frontmatter)
  parsed.frontmatter.custom.values.push('later')
  assert.deepEqual(snapshot.frontmatter.custom.values, [true, null, 12])
  assert.equal(snapshot.path, join(project, 'SKILL.md')); assert.equal(snapshot.frontmatterProblem, undefined)
  for (const header of ['- one\n- two', 'true', 'word', 'null', '~', 'bad:\n  - [\n']) {
    const invalid = r.parseFrontmatter(`---\n${header}\n---\nretained body`)
    assert.equal(invalid.content, 'retained body'); assert.ok(invalid.frontmatterProblem)
  }
  const circular = {}; circular.self = circular
  const metadata = r.createSkillMetadata({valid: {count: 1}, circular, infinity: Infinity, date: new Date()})
  assert.deepEqual(metadata.frontmatter, {valid: {count: 1}}); assert.match(metadata.frontmatterProblem, /circular/)
  const proto = r.createSkillMetadata(JSON.parse('{"__proto__":{"x":1},"constructor":2}'))
  assert.equal(Object.getPrototypeOf(proto.frontmatter), Object.prototype)
  assert.deepEqual(Object.keys(proto.frontmatter), ['__proto__', 'constructor'])
  assert.equal({}.x, undefined)
  assert.equal(r.parseFrontmatter('---\n# no data\n---\nbody').frontmatterProblem, undefined)
})

test('real personal, project, managed, legacy and plugin loaders retain file provenance', async () => {
  for (const source of ['userSettings', 'projectSettings', 'policySettings']) {
    const path = join(root, source, 'skills', 'sample', 'SKILL.md')
    write(path, '---\ndescription: Sample\ncustom: retained\n---\nbody')
    const [{skill}] = await r.loadSkillsFromSkillsDir(dirname(dirname(path)), source)
    assert.equal(skill.source, source); assert.equal(skill.skillMetadata.path, path)
    assert.equal(skill.skillMetadata.frontmatter.custom, 'retained')
  }
  const legacy = join(project, '.claude/commands/legacy.md')
  write(legacy, '---\ndescription: Legacy\ncustom: old-format\n---\nlegacy body')
  const loaded = await r.loadSkillsFromCommandsDir(project)
  assert.equal(loaded.find(x => x.skill.name === 'legacy').skill.skillMetadata.path, legacy)
  const plugin = join(root, 'catalog'), path = join(plugin, 'skills/sample/SKILL.md')
  write(path, '---\nname: alternate\ndescription: Sample\ncustom: plugin-data\n---\nbody')
  const [skill] = await r.loadSkillsFromDirectory(dirname(path), 'manifest-name', 'install-id@catalog', {name: 'manifest-name'}, plugin, new Set())
  assert.equal(skill.skillMetadata.path, path); assert.equal(skill.skillMetadata.frontmatter.custom, 'plugin-data')
  await mod(`on('skill.prompt',async($,e,next)=>{await $.fs.write('event.json',JSON.stringify(e));return next(e)});`)
  await r.expandSkillPrompt(skill, '', context())
  assert.equal(read('event.json').pluginName, 'manifest-name')
  assert.equal(read('event.json').skill, skill.name)
})

test('inline plugin command metadata does not invent a local path or replace file frontmatter with execution overrides', async () => {
  await mod('', {commands: {inline: {content: '---\ncustom: embedded\nmodel: inherit\n---\nbody', description: 'manifest override'}}})
  const skill = (await r.getPluginCommands()).find(c => c.name.endsWith(':inline'))
  assert.ok(skill); assert.equal(skill.skillMetadata.path, undefined)
  assert.deepEqual(skill.skillMetadata.frontmatter, {custom: 'embedded', model: 'inherit'})
})

test('no mod preserves exact content block identity; rewritten text retains nontext attachments', async () => {
  const image = {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'fixture'}}
  const blocks = [{type: 'text', text: 'first'}, image, {type: 'text', text: 'last'}]
  const skill = command({getPromptForCommand: async () => blocks})
  assert.equal(await r.expandSkillPrompt(skill, '', context()), blocks)
  await mod(`on('skill.prompt',async($,e,next)=>next({...e,text:e.text+' changed'}));`)
  const result = await r.expandSkillPrompt(skill, '', context())
  assert.equal(result[0], image); assert.equal(result[1].text, 'first\nlast changed')
  assert.equal(blocks[0].text, 'first'); assert.equal(blocks[2].text, 'last')
})

test('middleware passes frontmatter downstream without changing command permissions, hooks or the next expansion', async () => {
  await mod(`let calls=0;
    on('skill.prompt',{source:'plugin'},async($,e,next)=>next({...e,frontmatter:{...e.frontmatter,'allowed-tools':'Bash',count:++calls},text:e.text+' rewritten'}));
    on('skill.prompt',{skill:/example/},async($,e,next)=>{await $.fs.write('downstream.json',JSON.stringify(e));return next(e)});`)
  const skill = command({source: 'plugin', pluginInfo: {pluginManifest: {name:'real-plugin'}, repository:'different-id@market'},
    allowedTools: ['Read'], hooks: {}, skillMetadata: r.createSkillMetadata({'allowed-tools':'Read'})})
  for (let i = 1; i <= 2; i++) {
    assert.equal(text(await r.expandSkillPrompt(skill, String(i), context())), `original ${i} rewritten`)
    assert.equal(read('downstream.json').frontmatter.count, i)
    assert.equal(read('downstream.json').pluginName, 'real-plugin')
  }
  assert.deepEqual(skill.allowedTools, ['Read']); assert.deepEqual(skill.hooks, {})
  assert.deepEqual(skill.skillMetadata.frontmatter, {'allowed-tools':'Read'})
})

test('invalid identity rewrites and invalid results fall back to the unchanged expansion once', async () => {
  for (const change of ["skill:'forged'", "source:'plugin'", "path:'/forged'", "pluginName:'forged'", "frontmatterProblem:'forged'", "frontmatter:[]", "text:null"]) {
    await mod(`on('skill.prompt',async($,e,next)=>next({...e,${change}}));`)
    let expansions = 0
    const skill = command({getPromptForCommand:async()=>{expansions++;return [{type:'text',text:'original'}]}})
    assert.equal(text(await r.expandSkillPrompt(skill, '', context())), 'original')
    assert.equal(expansions, 1); assert.ok(r.getModWarnings().length)
  }
  for (const result of ['{text:null}', '{text:"bad",frontmatter:{}}', '{}']) {
    await mod(`on('skill.prompt',async()=>(${result}));`)
    assert.equal(text(await r.expandSkillPrompt(command(), 'argument', context())), 'original argument')
    assert.match(r.getModWarnings().join('\n'), /must return/)
  }
})

test('failure after next and a second next preserve the first downstream result without duplicate execution', async () => {
  for (const tail of ['throw Error("late")', 'return next(e)']) {
    await mod(`on('skill.prompt',async($,e,next)=>{await next({...e,text:'accepted'});${tail}});`)
    let calls = 0
    const result = await r.dispatchModEvent('skill.prompt', {skill:'sample',source:'built-in',text:'before',frontmatter:{}}, async e => {calls++;return {text:e.text}})
    assert.deepEqual(result, {text:'accepted'}); assert.equal(calls, 1)
  }
})

test('slash expansion records rewritten text for compaction and re-runs only on a new invocation', async () => {
  await mod(`let count=0;on('skill.prompt',async($,e,next)=>next({...e,text:e.text+' expansion-'+(++count)}));`)
  const skill = command(), ctx = context([], [skill]), options = ctx.options
  for (let i = 1; i <= 2; i++) {
    const result = await r.processPromptSlashCommand('example', 'arg', [skill], ctx)
    assert.ok(JSON.stringify(result.messages).includes(`original arg expansion-${i}`))
    assert.ok([...r.getInvokedSkills().values()].some(s => JSON.stringify(s).includes(`original arg expansion-${i}`)))
    assert.equal(ctx.options, options)
  }
  await r.stopPluginMods()
  const result = await r.processPromptSlashCommand('example', 'arg', [skill], ctx)
  assert.doesNotMatch(JSON.stringify(result.messages), /expansion-/)
})

test('model Skill tool and fork preparation use the shared expansion exactly once', async () => {
  await mod(`let count=0;on('skill.prompt',async($,e,next)=>next({...e,text:e.text+' invocation-'+(++count)}));`)
  const skill = command(), ctx = context([], [skill])
  const parent = r.createAssistantMessage({content:[{type:'tool_use',id:'skill-use',name:'Skill',input:{skill:'example'}}]})
  const result = await r.SkillTool.call({skill:'example',args:'model'}, ctx, permit, parent)
  assert.match(JSON.stringify(result.newMessages), /original model invocation-1/)
  const fork = await r.prepareForkedCommandContext({...skill, context:'fork', agent:'Explore'}, 'fork', ctx)
  assert.match(fork.skillContent, /original fork invocation-2/)
  assert.ok(fork.baseAgent.disallowedTools.includes('Write'))
})

test('MCP and built-in content retain their provenance and scoped tool API uses the invoking context', async () => {
  await mod(`on('skill.prompt',async($,e,next)=>{await $.fs.write('scope.json',JSON.stringify({event:e,tools:await $.tool.list()}));return next(e)});`)
  const childOnly = fixtureTool({name:'ChildOnly'}), ctx = context([childOnly], [], 'child-fixture')
  for (const source of ['mcp', 'builtin', 'bundled']) {
    await r.expandSkillPrompt(command({source}), '', ctx)
    const event = read('scope.json').event
    assert.equal(event.source, source === 'mcp' ? 'mcp' : 'built-in')
    assert.deepEqual(event.frontmatter, {}); assert.equal(event.path, undefined)
    assert.match(JSON.stringify(read('scope.json').tools), /ChildOnly/)
  }
})

test('same-context nested tool calls retain the caller permission callback', async () => {
  await mod(`on('skill.prompt',async($,e,next)=>{const result=await $.tool.call({tool:'FixtureTool'});return {text:result.text}});`)
  const tool = fixtureTool({isEnabled:()=>true,inputSchema:{parse:x=>x,safeParse:data=>({success:true,data})}}), ctx = context([tool]); let checked = 0
  const result = await r.withModToolContext({toolUseContext:ctx,assistantMessage:r.createAssistantMessage({content:[]}),
    canUseTool:async()=>{checked++;return {behavior:'deny',message:'denied by caller'}}}, () => r.expandSkillPrompt(command(), '', ctx))
  assert.match(text(result), /denied by caller/, r.getModWarnings().join('\n')); assert.equal(checked, 1); assert.equal(tool.calls.length, 0)
  const skill=command(),permission=async()=>{checked++;return {behavior:'deny',message:'explicit host denial'}}
  const slash=await r.processPromptSlashCommand(skill.name,'',[skill],ctx,[],permission)
  assert.match(JSON.stringify(slash.messages),/explicit host denial/)
  const fork=await r.prepareForkedCommandContext({...skill,agent:'Explore'},'',ctx,permission)
  assert.match(fork.skillContent,/explicit host denial/)
  assert.equal(checked,3);assert.equal(tool.calls.length,0)
})

test('real agent preload expands once with child tools, preserves the parent prefix and cleans up', async () => {
  const name = 'preload-' + randomUUID(), skillPath = join(project, '.claude/skills', name, 'SKILL.md')
  write(skillPath, '---\ndescription: Preload fixture\n---\npreload original')
  await mod(`on('skill.prompt',async($,e,next)=>{await $.fs.write('preload.json',JSON.stringify({event:e,tools:await $.tool.list()}));return next({...e,text:e.text+' child expansion'})});`)
  const parentOnly = fixtureTool({name:'ParentOnly'}), childOnly = fixtureTool({name:'ChildOnly'})
  const ctx = context([parentOnly, childOnly]), prefix = ['frozen child prefix'], tools = ctx.options.tools
  let seen
  r.setSkillPromptDeps({query:async function*(params){seen={content:JSON.stringify(params.messages),context:params.toolUseContext,system:params.systemPrompt};yield r.createAssistantMessage({content:[{type:'text',text:'done'}]})}})
  for await (const _ of r.runAgent({agentDefinition:{agentType:'fixture-child',source:'projectSettings',skills:[name],getSystemPrompt:()=>''},
    promptMessages:[r.createUserMessage({content:'go'})],toolUseContext:ctx,canUseTool:permit,isAsync:false,querySource:'agent:custom',
    availableTools:[childOnly],useExactTools:true,
    override:{agentId:'a0123456789abcdef',userContext:{},systemContext:{},systemPrompt:prefix},
  })) { /* consume the real agent lifecycle with a local model stub */ }
  assert.match(seen.content, /preload original child expansion/)
  assert.equal(seen.context.agentId, 'a0123456789abcdef')
  assert.deepEqual(seen.system, prefix); assert.equal(ctx.options.tools, tools)
  const evidence = read('preload.json')
  assert.equal(evidence.event.path, skillPath)
  assert.match(JSON.stringify(evidence.tools), /ChildOnly/); assert.doesNotMatch(JSON.stringify(evidence.tools), /ParentOnly/)
  assert.deepEqual(r.getModWarnings(), [])
})

test('an explicit permission callback does not reset the nested mod call limit', async () => {
  await mod(`on('skill.prompt',async($,e,next)=>{try{await $.tool.call({tool:'FixtureTool'});return {text:'unexpected execution'}}catch(error){return {text:String(error)}}});`)
  const tool=fixtureTool({isEnabled:()=>true,inputSchema:{parse:x=>x,safeParse:data=>({success:true,data})}}),ctx=context([tool]),skill=command()
  const result=await r.withModToolContext({toolUseContext:ctx,assistantMessage:r.createAssistantMessage({content:[]}),canUseTool:permit,depth:16},
    ()=>r.processPromptSlashCommand(skill.name,'',[skill],ctx,[],permit))
  assert.match(JSON.stringify(result.messages),/nested call limit/);assert.equal(tool.calls.length,0)
})

test('aborting a preloaded skill runs agent cleanup before any model request', {timeout:15_000}, async t => {
  // Mod workers intentionally do not keep a headless process alive on their own.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const name='cancel-'+randomUUID(), marker='preload-started-'+randomUUID()+'.txt'
  write(join(project,'.claude/skills',name,'SKILL.md'),'---\ndescription: Cancellation fixture\n---\noriginal')
  write(join(project,'.claude/skills',name+'-second','SKILL.md'),'---\ndescription: Second cancellation fixture\n---\noriginal')
  await mod(`on('skill.prompt',async($,e,next)=>{await $.fs.write('${marker}','ready');await $.clock.sleep(10_000);return next(e)});`)
  const ctx=context(), agentId='a1123456789abcdef';let queried=false
  r.setSkillPromptDeps({query:async function*(){queried=true}})
  const running=(async()=>{for await(const _ of r.runAgent({
    agentDefinition:{agentType:'cancel-fixture',source:'projectSettings',skills:[name,name+'-second'],getSystemPrompt:()=>'',
      hooks:{SubagentStop:[{hooks:[{type:'command',command:'echo stopped'}]}]}},
    promptMessages:[],toolUseContext:ctx,canUseTool:permit,isAsync:false,querySource:'agent:custom',availableTools:[],
    override:{agentId,userContext:{},systemContext:{},systemPrompt:['stable']},
  })) {}})()
  const rejection=assert.rejects(running,/abort/i)
  const deadline=Date.now()+5000
  while(!existsSync(join(project,marker))){assert.ok(Date.now()<deadline,'preload handler must start');await new Promise(done=>setTimeout(done,20))}
  assert.ok(r.getSessionHooks(ctx.getAppState(),agentId).size>0)
  ctx.abortController.abort();await rejection
  assert.equal(queried,false);assert.equal(r.getSessionHooks(ctx.getAppState(),agentId).size,0)
})
