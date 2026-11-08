import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, before, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

// The settings hook events as classic.* mod events, and the mods API calls
// beyond the filesystem: model, http, process.spawn, commands, agents, the
// prompt box and the session's own facts.
const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-api-')), project = join(root, 'project')
const config = join(root, 'config')
mkdirSync(project)
const write = (path, content) => { mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)) }
write(join(config, '.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty' })

// A Claude API stand-in: records each request; what it answers depends on the
// request alone, so a test never races it.
const requests = []
const systemText = body => typeof body.system === 'string' ? body.system : (body.system ?? []).map(block => block.text).join('\n')
const answerFor = body => {
  const text = JSON.stringify(body.messages)
  if (systemText(body).includes('You classify text')) return text.includes('crashes') ? 'bug' : 'something else'
  return 'model-answer'
}
// The project is a git repository from the start, before anything can cache
// that it is not one.
execFileSync('git', ['init', '-q'], { cwd: project })
execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example-owner/example-repo.git'], { cwd: project })
const api = createServer(async (request, response) => {
  if (request.method === 'HEAD') { response.end(); return }
  let raw = ''
  for await (const part of request) raw += part
  if (request.url.includes('count_tokens')) { response.end('{"input_tokens":1}'); return }
  const body = JSON.parse(raw)
  requests.push(body)
  const replyText = answerFor(body)
  if (JSON.stringify(body.messages).includes('fail please')) {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'refused by the fixture' } }))
    return
  }
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: replyText }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(anthropicReply(replyText, body.model))
})
await new Promise(done => api.listen(0, '127.0.0.1', done))

Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  // NODE_ENV=test turns on the VCR replay path, which throws on CI for a
  // fixture nobody committed; these checks answer from the local stand-in.
  CI: 'true', NODE_ENV: 'production',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ANTHROPIC_API_KEY: 'sk-ant-local-mod-api-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`,
  NO_PROXY: '127.0.0.1,localhost', TAU_TEST_NODE: process.execPath,
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[key]
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/sessionState.ts', 'src/utils/hooks.ts',
    'src/utils/plugins/mods/actionsApi.ts'],
  exports: ['startPluginMods', 'stopPluginMods', 'dispatchModEvent', 'hasModEvent', 'getModWarnings', 'getModCommands',
    'setInlinePlugins', 'resetSettingsCache', 'clearAllCaches', 'setOriginalCwd', 'setSessionTrustAccepted',
    'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath', 'bindModSession', 'beginModMainTurn',
    'updateHooksConfigSnapshot', 'executeHooks', 'executeHooksOutsideREPL', 'resolveWorktreeCreateHook',
    'executeSessionEndHooks', 'withModAgents', 'dispatchModAgentSpawn', 'getSessionId', 'createUserMessage'],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)

let serial = 0, closeSession
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
async function loadMods(definitions) {
  const names = definitions.map((_, index) => `api-${++serial}-${index}`)
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
async function command(name, args = '') {
  const entry = r.getModCommands().find(item => item.name === name)
  assert.ok(entry, name)
  return (await entry.load()).call(args, fixtureContext([]))
}
const register = name => `on('session.start',async($,e,next)=>{await $.command.register({name:'${name}',description:'${name}'});return next(e)});`
const probe = (name, body) => `${register(name)} on('command.run',{command:'${name}'},async($,e)=>{const out=await (async()=>{${body}})();return {text:JSON.stringify(out===undefined?null:out)}});`
const run = async (name, args) => JSON.parse((await command(name, args)).value)
const base = event => ({ hook_event_name: event, session_id: r.getSessionId(), cwd: project, transcript_path: '' })
async function hooks(hookInput, toolUseID = 'fixture-call') {
  const results = []
  for await (const value of r.executeHooks({ hookInput, toolUseID, forceSyncExecution: true })) results.push(value)
  return results
}
afterEach(async () => { await r.stopPluginMods(); closeSession?.(); closeSession = undefined })
after(async () => {
  await r.stopPluginMods()
  api.closeAllConnections(); await new Promise(done => api.close(done))
  process.chdir(original); rmSync(root, {recursive: true, force: true, maxRetries: 10})
})

test('classic.PreToolUse takes the call envelope and answers allow, ask or deny with updated input', async () => {
  await loadMods([`on('classic.PreToolUse',{tool:'Bash'},async($,e,next)=>{
    await $.fs.write('pre-tool.json',JSON.stringify(e));
    if(e.command==='rm -rf /')return {deny:'Refused by the guard'};
    if(e.command==='ask me')return {ask:'Check this one'};
    return {allow:true,updatedInput:{command:e.command+' --safe'},additionalContext:['guarded']};
  });`])
  const input = command => ({ ...base('PreToolUse'), tool_name: 'Bash', tool_input: { command }, tool_use_id: 'call-1' })
  const denied = await hooks(input('rm -rf /'))
  assert.deepEqual(JSON.parse(read('pre-tool.json')), { command: 'rm -rf /', tool: 'Bash', tool_use_id: 'call-1' })
  assert.ok(denied.some(result => result.permissionBehavior === 'deny' && result.hookPermissionDecisionReason === 'Refused by the guard'))
  const asked = await hooks(input('ask me'))
  assert.ok(asked.some(result => result.permissionBehavior === 'ask' && result.hookPermissionDecisionReason === 'Check this one'))
  const allowed = await hooks(input('ls'))
  const decision = allowed.find(result => result.permissionBehavior === 'allow')
  assert.deepEqual(decision.updatedInput, { command: 'ls --safe' })
  assert.deepEqual(decision.additionalContexts, ['guarded'])
  // Another tool is not this hook's: nothing answers it.
  assert.deepEqual((await hooks({ ...base('PreToolUse'), tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 'call-2' }))
    .filter(result => result.permissionBehavior), [])
})

test('classic.* covers prompt, permission and stop events with each one\'s own result fields', async () => {
  await loadMods([`
    on('classic.UserPromptSubmit',async()=>({additionalContext:['from a mod'],suppressOriginalPrompt:true,sessionTitle:'Titled'}));
    on('classic.PermissionDenied',async()=>({retry:true}));
    on('classic.PermissionRequest',async()=>({decision:{behavior:'deny',message:'not today'}}));
    on('classic.TaskCreated',async()=>({block:'tasks are frozen'}));
    on('classic.PreModelSwitch',async()=>({permissionDecision:'deny',permissionDecisionReason:'stay on this model'}));
  `])
  const prompt = await hooks({ ...base('UserPromptSubmit'), prompt: 'hi' })
  assert.ok(prompt.some(result => result.additionalContexts?.includes('from a mod') && result.suppressOriginalPrompt && result.sessionTitle === 'Titled'))
  const denied = await hooks({ ...base('PermissionDenied'), tool_name: 'Bash', tool_input: {}, tool_use_id: 'x', reason: 'no' })
  assert.ok(denied.some(result => result.retry === true))
  const request = await hooks({ ...base('PermissionRequest'), tool_name: 'Bash', tool_input: {}, permission_suggestions: [] })
  assert.ok(request.some(result => result.permissionRequestResult?.behavior === 'deny' && result.permissionRequestResult.message === 'not today'))
  const task = await hooks({ ...base('TaskCreated'), task_id: 't', task_subject: 's' })
  assert.ok(task.some(result => result.blockingError?.blockingError === 'tasks are frozen'))
  const model = await hooks({ ...base('PreModelSwitch'), from_model: 'a', to_model: 'b', source: 'command' })
  assert.ok(model.some(result => result.permissionBehavior === 'deny' && result.hookPermissionDecisionReason === 'stay on this model'))
})

test('a classic result field of the wrong kind or another event\'s field skips the hook', async () => {
  await loadMods([`on('classic.Stop',async()=>({retry:true}));on('classic.UserPromptSubmit',async()=>({additionalContext:'not a list'}));`])
  assert.deepEqual((await hooks({ ...base('Stop'), stop_hook_active: false })).filter(result => result.retry), [])
  assert.ok(r.getModWarnings().some(text => text.includes('classic.Stop hook skipped') && text.includes('retry')))
  assert.deepEqual((await hooks({ ...base('UserPromptSubmit'), prompt: 'x' })).filter(result => result.additionalContexts), [])
})

test('events outside a turn reach mods: notifications, compaction vetoes, worktrees and session end in order', async () => {
  await loadMods([`
    on('classic.Notification',async($,e,next)=>{await $.fs.write('notified.txt',e.message);return next(e)});
    on('classic.PreCompact',{trigger:'manual'},async()=>({block:'not now'}));
    on('classic.WorktreeCreate',{name:'by-mod'},async()=>({worktreePath:'/tmp/mod-worktree'}));
    on('classic.SessionEnd',async($,e,next)=>{await $.fs.write('order.txt',(await $.fs.exists('order.txt')?await $.fs.read('order.txt'):'')+'classic,');return next(e)});
    on('session.end',async($,e,next)=>{await $.fs.write('order.txt',(await $.fs.exists('order.txt')?await $.fs.read('order.txt'):'')+'mod-end');return next(e)});
  `])
  assert.deepEqual(await r.executeHooksOutsideREPL({ hookInput: { ...base('Notification'), message: 'ping', notification_type: 'idle' } }), [])
  assert.equal(read('notified.txt'), 'ping')
  const compact = await r.executeHooksOutsideREPL({ hookInput: { ...base('PreCompact'), trigger: 'manual', custom_instructions: null } })
  assert.ok(compact.some(result => result.blocked && result.blockingReason === 'not now'))
  assert.deepEqual(await r.executeHooksOutsideREPL({ hookInput: { ...base('PreCompact'), trigger: 'auto', custom_instructions: null } }), [])
  assert.deepEqual(await r.resolveWorktreeCreateHook('by-mod'), { worktreePath: '/tmp/mod-worktree' })
  // A mod that leaves the path unset leaves creation to git.
  assert.equal(await r.resolveWorktreeCreateHook('other'), null)
  await r.executeSessionEndHooks('other')
  assert.equal(read('order.txt'), 'classic,mod-end')
})

test('model.complete sends its own request with cache breakpoints; failures answer, not reject', async () => {
  await loadMods([probe('complete', `
    const ok=await $.model.complete({model:'haiku',system:'Be brief.',prompt:[{text:'STATIC RULES',cache:true},{text:'varying part'}],maxTokens:50});
    const failed=await $.model.complete({model:'haiku',prompt:'fail please'});
    let refused;try{await $.model.complete({model:'haiku'})}catch(error){refused=error.message}
    return {ok,failed,refused};`)])
  requests.length = 0
  // The second request ('fail please') fails at the API.
  const out = await run('complete')
  assert.equal(out.ok.isAnswered, true)
  assert.equal(out.ok.text, 'model-answer')
  // The reply's own usage, as the API reported it (the fixture's stream says 100).
  assert.equal(out.ok.usage.input_tokens, requests[0].stream ? 100 : 11)
  const first = requests[0]
  assert.equal(first.max_tokens, 50)
  assert.equal(first.messages.length, 1)
  assert.deepEqual(first.messages[0].content.map(block => [block.text, !!block.cache_control]), [['STATIC RULES', true], ['varying part', false]])
  assert.ok(systemText(first).includes('Be brief.'))
  assert.equal(out.failed.isAnswered, false)
  assert.match(out.failed.reason, /^api-error/)
  assert.match(out.refused, /model\.complete takes \{ model, prompt \}/)
})

test('model.classify names one of the labels or none', async () => {
  await loadMods([probe('classify', `return [await $.model.classify('it crashes',['bug','feature']), await $.model.classify('hmm',['bug','feature'])]`)])
  requests.length = 0
  const [first, second] = await run('classify')
  assert.equal(first, 'bug')
  assert.equal(second, null)
  assert.ok(systemText(requests[0]).includes('"bug", "feature"'))
})

test('http.fetch follows redirects, drops credentials across origins and bounds bodies', async () => {
  const seen = []
  const other = createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers })
    response.writeHead(200, { 'x-origin': 'other' }); response.end('landed')
  })
  await new Promise(done => other.listen(0, '127.0.0.1', done))
  const server = createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers })
    if (request.url === '/hop') { response.writeHead(302, { location: `http://localhost:${other.address().port}/dest` }); response.end(); return }
    if (request.url === '/big') { response.writeHead(200, { 'content-length': String(5 * 1024 * 1024) }); response.end(); return }
    if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); return }
    response.writeHead(201, { 'content-type': 'text/plain' }); response.end('created')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const at = `http://127.0.0.1:${server.address().port}`
    await loadMods([probe('fetch', `
      const plain=await $.http.fetch('${at}/plain',{method:'POST',body:'x',headers:{'Content-Type':'text/plain'}});
      const hop=await $.http.fetch('${at}/hop',{headers:{authorization:'secret',accept:'text/plain'}});
      const errors=[];
      for(const path of ['/big','/loop'])try{await $.http.fetch('${at}'+path)}catch(error){errors.push(error.message)}
      try{await $.http.fetch('file:///etc/passwd')}catch(error){errors.push(error.message)}
      return {plain,hop,errors};`)])
    const out = await run('fetch')
    assert.deepEqual([out.plain.status, out.plain.ok, out.plain.text], [201, true, 'created'])
    assert.equal(out.hop.text, 'landed')
    const landed = seen.find(item => item.url === '/dest')
    assert.equal(landed.headers.authorization, undefined, 'a credential header must not follow a cross-origin redirect')
    assert.equal(landed.headers.accept, 'text/plain')
    assert.match(out.errors[0], /4194304-byte limit/)
    assert.match(out.errors[1], /five redirects/)
    assert.match(out.errors[2], /http and https/)
  } finally {
    server.closeAllConnections(); other.closeAllConnections()
    await Promise.all([new Promise(done => server.close(done)), new Promise(done => other.close(done))])
  }
})

test('process.spawn streams output, reports its exit, stops on an early break, and a guard above can refuse it', async () => {
  await loadMods([
    `on('process.spawn',async($,e,next)=>e.argv.includes('forbidden')?{deny:'not that one'}:next(e));`,
    probe('spawn', `
      const node=await $.env.get('TAU_TEST_NODE');
      const chunks=[];
      const proc=$.process.spawn([node,'-e','for(let i=0;i<3;i++)console.log("line"+i);console.error("warn");process.exitCode=4']);
      for await(const chunk of proc)chunks.push(chunk);
      const result=await proc.result;
      const endless=$.process.spawn([node,'-e','setInterval(()=>console.log("tick"),20)']);
      let ticks=0;for await(const chunk of endless){ticks++;if(ticks>=2)break}
      let refused;try{const blocked=$.process.spawn([node,'-e','1','forbidden']);await blocked.result}catch(error){refused=error.message}
      return {text:chunks.filter(c=>c.stream==='stdout').map(c=>c.text).join(''),stderr:chunks.filter(c=>c.stream==='stderr').map(c=>c.text).join(''),result,ticks,refused};`),
  ])
  const out = await run('spawn')
  assert.equal(out.text.replace(/\r/g, ''), 'line0\nline1\nline2\n')
  assert.equal(out.stderr.trim(), 'warn')
  assert.equal(out.result.exitCode, 4)
  assert.ok(out.ticks >= 2)
  assert.match(out.refused, /\$\.process\.spawn: not that one/)
})

test('command.run answers through another mod\'s command; agents register, list and spawn hooks decide', async () => {
  const [, caller] = await loadMods([
    `${register('hello')} on('command.run',{command:'hello'},async($,e)=>({text:'hello '+e.args+' from '+e.origin.name}));
     on('agent.spawn',async($,e,next)=>e.prompt.includes('forbidden')?{deny:'no forbidden agents'}:next({...e,model:'haiku'}));`,
    probe('caller', `
      const ran=await $.command.run({command:'hello',args:'there'});
      let unknown;try{await $.command.run({command:'no-such-command'})}catch(error){unknown=error.message}
      const registered=await $.agent.register({name:'runner',description:'Runs things',prompt:'You run things.',tools:['Read']});
      let refused;try{await $.agent.register({name:'bad',description:'x',prompt:'y',permissionMode:'bypassPermissions'})}catch(error){refused=error.message}
      return {ran,unknown,registered,refused,agents:await $.agent.list()};`),
  ])
  const out = await run('caller')
  assert.equal(out.ran.text, `hello there from ${caller}`)
  assert.match(out.unknown, /Unknown command \/no-such-command/)
  assert.equal(out.registered.agent, `${caller}:runner`)
  assert.match(out.refused, /cannot set permissionMode/)
  assert.deepEqual(out.agents, [])
  const merged = r.withModAgents([{ agentType: 'general-purpose' }])
  const runner = merged.find(agent => agent.agentType === `${caller}:runner`)
  assert.equal(runner.getSystemPrompt(), 'You run things.')
  assert.deepEqual(runner.tools, ['Read'])
  assert.deepEqual(await r.dispatchModAgentSpawn({ prompt: 'do forbidden work', subagentType: 'general-purpose' }, new AbortController().signal), { deny: 'no forbidden agents' })
  assert.deepEqual(await r.dispatchModAgentSpawn({ prompt: 'fine', subagentType: 'general-purpose' }, new AbortController().signal), { model: 'haiku' })
  // Unloading forgets the mod's agent types.
  await r.stopPluginMods()
  assert.equal(r.withModAgents([]).length, 0)
})

test('session facts, the prompt box and appended rows (held while a turn runs)', async () => {
  const rows = [], box = { text: 'draft', cursor: 2 }
  let suggested
  closeSession = r.bindModSession({
    getMessages: () => rows, getModel: () => 'claude-sonnet-4-6', setMessages: next => rows.splice(0, rows.length, ...next),
    readPrompt: () => box,
    fillPrompt: (text, mode) => { box.text = mode === 'insert' ? box.text.slice(0, box.cursor) + text + box.text.slice(box.cursor) : text; return true },
    suggestPrompt: text => { suggested = text; return true },
  })
  mkdirSync(join(project, 'a/b'), { recursive: true })
  write(join(project, 'AGENTS.md'), 'root rules\n@./included.md')
  write(join(project, 'included.md'), 'included text')
  write(join(project, 'a/b/AGENTS.md'), 'deep rules')
  // A link that leads nowhere (a junction on Windows needs no privilege).
  symlinkSync(join(project, 'missing-target'), join(project, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
  await loadMods([probe('facts', `
    const dangling=await $.fs.stat('dangling',{resolve:true});
    const version=await $.session.version();
    const usage=await $.session.usage();
    const read=await $.prompt.read();
    const filled=await $.prompt.fill({text:'XY',mode:'insert'});
    const shown=await $.prompt.suggest({text:'try this'});
    const ancestors=await $.fs.ancestors({names:['AGENTS.md'],of:'a/b/file.txt',below:${JSON.stringify(dirname(project))}});
    const identity=await $.session.identity();
    const sent=await $.session.send({to:{agentId:'nobody'},text:'hi'});
    return {dangling,version,usage,read,filled,shown,ancestors,identity,sent,repo:await $.session.repo()};`)])
  const out = await run('facts')
  // Answered from the link itself, with no realPath for a guard to trust.
  assert.equal(out.dangling.kind, 'other')
  assert.equal(out.dangling.isLink, true)
  assert.equal('realPath' in out.dangling, false)
  // The Claude Code release whose mods contract Tau implements, so a mod's
  // version gate holds; Tau's own release beside it.
  assert.equal(out.version.version, '2.1.319')
  assert.equal(out.version.base, '2.1.319')
  assert.match(out.version.tau, /^\d+\.\d+\.\d+/)
  assert.equal(out.usage.context.window > 0, true)
  assert.deepEqual(out.usage.rateLimits, [])
  assert.deepEqual(out.read, { text: 'draft', cursor: 2 })
  assert.equal(out.filled.isFilled, true)
  assert.equal(box.text, 'drXYaft')
  assert.equal(out.shown.isShown, true)
  assert.equal(suggested, 'try this')
  assert.deepEqual(out.ancestors.map(entry => [entry.dir, entry.content.includes('root rules'), entry.content.includes('included text')]),
    [[project, true, true], [join(project, 'a', 'b'), false, false]])
  assert.match(out.identity.deny, /managed settings/)
  assert.equal(out.sent.isDelivered, false)
  assert.equal(out.repo.name, 'example-owner/example-repo')
  assert.equal(out.repo.internal, false)
  // A row appended during a turn waits for it, so it never splits a tool call from its result.
  const end = r.beginModMainTurn('turn-1', new AbortController())
  await loadMods([probe('append', `return await $.session.append({message:{type:'user',content:[{type:'text',text:'note for the model'}]}})`)])
  const appended = command('append')
  await pause(100)
  assert.equal(rows.length, 0)
  end()
  const result = JSON.parse((await appended).value)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].isMeta, true)
  assert.equal(result.uuid, rows[0].uuid)
})
