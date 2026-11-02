import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const execute = promisify(execFile)
const write = (path, data) => {
  mkdirSync(dirname(path), {recursive:true})
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

test('real compact calls honor vetoes, use the native summary request, and resume the accepted conversation', {timeout:600_000}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tau mod compact '))
  const project = join(root, 'project'), plugin = join(root, 'plugin'), config = join(root, 'config')
  const session = randomUUID(), seed = randomUUID(), keep = randomUUID(), summary = randomUUID()
  const read = name => JSON.parse(readFileSync(join(project, name), 'utf8'))
  write(join(config, '.claude.json'), {hasCompletedOnboarding:true, lastOnboardingVersion:'99.0.0', activeProvider:'firstParty'})
  write(join(project, 'input.txt'), keep)
  write(join(project, 'policy.cjs'), `
const fs=require('node:fs')
const e=JSON.parse(fs.readFileSync(0,'utf8'))
fs.appendFileSync('policy.jsonl',JSON.stringify({event:e.hook_event_name,summary:e.compact_summary})+'\\n')
if (e.hook_event_name==='PreCompact' && fs.existsSync('veto')) {process.stderr.write('Policy kept the history');process.exitCode=2}
`)
  const policy = {type:'command',command:process.execPath,args:[join(project,'policy.cjs')]}
  write(join(project,'.claude/settings.json'), {hooks:{PreCompact:[{hooks:[policy]}],PostCompact:[{hooks:[policy]}]}})
  const hookEvents = () => readFileSync(join(project,'policy.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  write(join(plugin, '.claude-plugin/plugin.json'), {name:'history-review',version:'1.0.0'})
  write(join(plugin, 'hooks/hooks.json'), {modules:['./register.ts']})
  write(join(plugin, 'hooks/register.ts'), `
export function register(on) {
  on('session.start', async ($,e,next) => {
    await $.command.register({name:'reduce-history',description:'Compact the current conversation'})
    return next(e)
  })
  on('command.run', {command:'reduce-history'}, async ($,e) => {
    const before = await $.session.messages({as:'api'})
    const receipt = await $.session.compact({instructions:e.args})
    const after = await $.session.messages({as:'api'})
    await $.fs.write('receipt.json', JSON.stringify({before,receipt,after}))
    return {text:'review completed'}
  })
  on('session.compact', async ($,e,next) => {
    const mode = await $.fs.read('mode.txt')
    await $.fs.write('event.json', JSON.stringify({trigger:e.trigger,instructions:e.instructions}))
    if(mode==='replace') return {messages:[{role:'user',text:'Replacement summary',toolUses:[]},...e.messages.filter(row=>row.toolUses.length || row.toolResults?.length)]}
    const result = await next({...e,instructions:e.instructions+' reviewed'})
    if(mode==='late veto') return {skip:'Keep current history'}
    return result
  })
}`)
  const requests = [], readInput = [{name:'Read',input:{file_path:join(project,'input.txt')}}]
  const toolReplies = [readInput]
  let responseText = 'seed'
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') return response.end()
    if (request.url.includes('count_tokens')) return response.end('{"input_tokens":1}')
    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw)
    requests.push(body)
    const reply = toolReplies.shift() ?? responseText
    response.writeHead(200, {'content-type':'text/event-stream'})
    response.end(anthropicReply(reply, body.model))
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_)/i.test(key)))
  Object.assign(env, {CLAUDE_CONFIG_DIR:config, CLAUDE_CODE_PLUGIN_CACHE_DIR:join(root,'cache'), CI:'true', TAU_SKIP_PREFLIGHT:'1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', DISABLE_TELEMETRY:'1', DISABLE_ERROR_REPORTING:'1', DISABLE_AUTOUPDATER:'1',
    ANTHROPIC_API_KEY:'sk-ant-local-compact', ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`, NO_PROXY:'127.0.0.1,localhost', ENABLE_TOOL_SEARCH:'false'})
  const run = (prompt, resume=true) => execute(process.execPath, [resolve('dist/cli.mjs'),'-p',prompt,
    resume?'--resume':'--session-id',session,'--plugin-dir',plugin,'--setting-sources','project','--strict-mcp-config',
    '--model','claude-sonnet-4-6','--tools','Read','--dangerously-skip-permissions'], {cwd:project,env,timeout:60_000,windowsHide:true})
  try {
    await run(seed,false)
    assert.equal(requests.length,2)
    responseText = summary
    write(join(project,'mode.txt'),'late veto')
    await run('/reduce-history preserve receipts')
    let result = read('receipt.json')
    assert.deepEqual(result.receipt,{skip:'Keep current history'})
    assert.deepEqual(result.after,result.before)
    assert.ok(JSON.stringify(result.before).includes(keep))
    assert.equal(requests.length,3)
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('preserve receipts reviewed'))
    assert.deepEqual(read('event.json'),{trigger:'plugin',instructions:'preserve receipts'})
    assert.deepEqual(hookEvents().map(e=>e.event),['PreCompact'])

    write(join(project,'mode.txt'),'replace')
    write(join(project,'veto'),'enabled')
    await run('/reduce-history keep the read')
    result = read('receipt.json')
    assert.deepEqual(result.receipt,{skip:'Policy kept the history'})
    assert.deepEqual(result.before,result.after)
    assert.deepEqual(hookEvents().map(e=>e.event),['PreCompact','PreCompact'])
    rmSync(join(project,'veto'))
    await run('/reduce-history keep the read')
    result = read('receipt.json')
    assert.equal(requests.length,3,'hook replacement needs no summarizer request')
    assert.ok(JSON.stringify(result.after).includes(keep))
    assert.ok(!JSON.stringify(result.after).includes(seed))
    assert.equal(result.receipt.messages[0].text,'Replacement summary')
    assert.ok(result.receipt.messages.some(row=>row.toolResults?.some(tool=>tool.text.includes(keep))))

    write(join(project,'mode.txt'),'native')
    await run('/reduce-history native summary')
    result = read('receipt.json')
    assert.ok(JSON.stringify(result.before).includes('Replacement summary'),'resumed replacement')
    assert.ok(JSON.stringify(result.before).includes(keep),'resumed native tool blocks')
    assert.ok(!JSON.stringify(result.before).includes(seed),'old history stayed behind the boundary')
    assert.ok(JSON.stringify(result.after).includes(summary))
    assert.ok(result.receipt.usage.output_tokens > 0)
    assert.ok(result.receipt.tokensAfter > 0)
    assert.equal(hookEvents().at(-1).summary, summary)
    const prefix = request => request.system.filter(block => !block.text?.startsWith('x-anthropic-billing-header:'))
    assert.deepEqual(requests.at(-1).tools, requests[2].tools)
    assert.deepEqual(prefix(requests.at(-1)), prefix(requests[2]))
    await run('continue')
    assert.ok(JSON.stringify(requests.at(-1).messages).includes(summary),'resumed native summary')
    assert.ok(!JSON.stringify(requests.at(-1).messages).includes(seed))
    const retained = randomUUID()
    write(join(project,'input.txt'),retained)
    toolReplies.push(readInput)
    await run('read it again')
    const beforeManual = requests.length
    write(join(project,'mode.txt'),'replace')
    await run('/compact manual scope')
    assert.deepEqual(read('event.json'),{trigger:'manual',instructions:'manual scope'})
    assert.equal(requests.length,beforeManual)
    await run('continue after manual compaction')
    const resumed = JSON.stringify(requests.at(-1).messages)
    assert.ok(resumed.includes('Replacement summary'),'manual replacement survives resume')
    assert.ok(resumed.includes(retained),'the tool result the replacement kept survives resume')
    assert.ok(resumed.indexOf('Replacement summary') < resumed.indexOf(retained),'resume keeps the replacement order')
    assert.ok(!resumed.includes(seed),'manual resume keeps the boundary')
    assert.match(resumed,/PreCompact \[[^\]]*\] completed successfully/,'/compact reports classic hooks when a mod listens')
    assert.match(resumed,/PostCompact \[[^\]]*\] completed successfully/,'/compact reports classic hooks when a mod listens')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})
  }
})

test('invalid compact replacements visibly explain the normal summary fallback', {timeout:90_000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'tau compact warning ')), project=join(root,'project'), plugin=join(root,'plugin'), config=join(root,'config')
  write(join(config,'.claude.json'),{hasCompletedOnboarding:true,lastOnboardingVersion:'99.0.0',activeProvider:'firstParty'})
  write(join(plugin,'.claude-plugin/plugin.json'),{name:'invalid-history',version:'1.0.0'})
  write(join(plugin,'hooks/hooks.json'),{modules:['./register.ts']})
  write(join(plugin,'hooks/register.ts'),`export function register(on){
    on('session.start',async($,e,next)=>{await $.command.register({name:'reduce-history',description:'Compact'});return next(e)});
    on('command.run',{command:'reduce-history'},async($)=>{await $.session.compact();return {text:'done'}});
    on('session.compact',async($,e,next)=>e.trigger==='auto' && await $.fs.exists('allow-native')
      ? next(e) : {messages:[{role:'user',text:'invalid summary'}]});
  }`)
  mkdirSync(project,{recursive:true})
  const requests=[]
  const server=createServer(async(req,res)=>{
    if(req.method==='HEAD')return res.end()
    if(req.url.includes('count_tokens'))return res.end('{"input_tokens":1}')
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw);requests.push(body)
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(anthropicReply('normal summary',body.model))
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_)/i.test(key)))
  Object.assign(env,{CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_PLUGIN_CACHE_DIR:join(root,'cache'),CI:'true',TAU_SKIP_PREFLIGHT:'1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1',
    ANTHROPIC_API_KEY:'sk-ant-local-warning',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,NO_PROXY:'127.0.0.1,localhost',ENABLE_TOOL_SEARCH:'false'})
  function run(text, session, resume, { automatic = false, withPlugin = true, stream = false } = {}) {
    const pending = execute(process.execPath, [
      process.env.PROBE_CLI ?? resolve('dist/cli.mjs'), '-p', text, resume ? '--resume' : '--session-id', session,
      ...(withPlugin ? ['--plugin-dir', plugin] : []), ...(stream ? ['--verbose','--output-format','stream-json'] : []),
      '--setting-sources','project','--strict-mcp-config','--model','claude-sonnet-4-6','--tools','','--dangerously-skip-permissions',
    ], { cwd: project, env: { ...env, DISABLE_AUTO_COMPACT: automatic ? '0' : '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '0.001' },
      timeout: 30_000, windowsHide: true })
    pending.child.stdin.end()
    return pending
  }
  try{
    for(const command of ['/compact','/reduce-history']){
      const session=randomUUID();await run('seed history',session,false)
      const before=requests.length,result=await run(command,session,true)
      assert.equal(requests.length,before+1,'invalid replacement keeps the native fallback')
      assert.match(result.stdout,/invalid-history.*session\.compact[\s\S]*toolUses[\s\S]*normal summary/i,command+' must visibly name the plugin, reason and paid fallback')
    }
    // Replay the same seed. The summary names its transcript, so different
    // session IDs would change real request bytes even for identical hooks.
    const session = randomUUID()
    await run('seed history', session, false)
    const projects = join(config, 'projects')
    const relativeTranscript = readdirSync(projects, { recursive: true }).find(path => path.endsWith(session + '.jsonl'))
    assert.ok(relativeTranscript, 'seed transcript exists')
    const transcript = join(projects, relativeTranscript)
    const seed = readFileSync(transcript)
    let firstHistory
    for (const mode of ['invalid', 'invalid-stream', 'pass', 'no-listener']) {
      if (mode === 'pass') write(join(project, 'allow-native'), 'yes')
      const stream = mode === 'invalid-stream', withPlugin = mode !== 'no-listener'
      writeFileSync(transcript, seed)
      const before = requests.length
      const result = await run('answer after compaction', session, true, { automatic: true, stream, withPlugin })
      const bodies = requests.slice(before)
      assert.equal(bodies.filter(body => JSON.stringify(body.messages).includes('create a detailed summary')).length, 1,
        'each scenario must reach exactly one automatic summarizer')
      const diagnostic = /invalid-history.*session\.compact[\s\S]*toolUses[\s\S]*normal summary/i
      if (mode.startsWith('invalid')) {
        assert.match(result.stderr, diagnostic, 'headless callers receive the fallback reason on stderr')
        assert.equal(result.stderr.split('A normal summary ran').length - 1, 1, 'report the fallback once')
      } else assert.doesNotMatch(result.stderr, diagnostic)
      assert.doesNotMatch(result.stdout, /A normal summary ran/)
      if (stream) {
        const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
        assert.equal(events.at(-1).type, 'result')
      }
      const history = JSON.stringify(bodies.map(body => body.messages))
      assert.doesNotMatch(history, /A normal summary ran|invalid summary/)
      if (withPlugin) {
        firstHistory ??= history
        assert.equal(history, firstHistory, 'the diagnostic must not change any summary or follow-up message bytes')
      }
    }
  }finally{server.closeAllConnections();await new Promise(done=>server.close(done));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
