import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,unlinkSync,writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {anthropicReply} from './mcp-instructions/anthropic-reply.mjs'
import {replStartupReady} from './helpers/repl-startup.mjs'

const execute=promisify(execFile)
const PTY_MISSING=77
let pty
// node-pty is optional, and npm ships its macOS helper without the execute bit.
async function loadPty() {
  try {
    const loaded=await import('node-pty')
    pty=loaded.default??loaded
  } catch {process.exit(PTY_MISSING)}
  if(process.platform!=='darwin')return
  const helper=join(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')),'prebuilds',`darwin-${process.arch}`,'spawn-helper')
  if(existsSync(helper))chmodSync(helper,0o755)
}
const cli=resolve(process.env.PROBE_CLI??'dist/cli.mjs')
const pause=ms=>new Promise(done=>setTimeout(done,ms))
const write=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value))}
async function waitFor(check,label,ms=45000) {
  const end=Date.now()+ms
  while(Date.now()<end) {if(check())return;await pause(100)}
  throw new Error('timed out waiting for '+label)
}

async function checkIdentity(surface) {
    const root=mkdtempSync(join(tmpdir(),'tau-startup-id ')),project=join(root,'project'),config=join(root,'config'),plugin=join(root,'plugin')
    mkdirSync(project)
    const key='sk-ant-startup-test',session=randomUUID(),startup=join(project,'startup.json'),live=join(project,'live.json')
    write(join(config,'.claude.json'),{theme:'dark',hasCompletedOnboarding:true,lastOnboardingVersion:'99.0.0',activeProvider:'firstParty',
      customApiKeyResponses:{approved:[key.slice(-20)],rejected:[]},projects:{[project]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}}})
    write(join(plugin,'.claude-plugin/plugin.json'),{name:'startup-identity',version:'1.0.0'})
    write(join(plugin,'hooks/hooks.json'),{modules:['./register.ts']})
    write(join(plugin,'hooks/register.ts'),`export function register(on) {
      on('session.start',async($,e,next)=>{
        await $.command.register({name:'startup-identity',description:'Read live identity'});
        await $.fs.write('startup.json',JSON.stringify({id:await $.session.id()}));return next(e);
      });
      on('command.run',{command:'startup-identity'},async($)=>{
        const id=await $.session.id();await $.fs.write('live.json',JSON.stringify({id}));return {text:id};
      });
    }`)
    const server=createServer(async(request,response)=>{
      if(request.method==='HEAD')return response.end()
      if(request.url.includes('count_tokens'))return response.end('{"input_tokens":1}')
      let raw='';for await(const part of request)raw+=part
      const body=JSON.parse(raw)
      response.writeHead(200,{'content-type':'text/event-stream'});response.end(anthropicReply('seed completed',body.model))
    })
    await new Promise(done=>server.listen(0,'127.0.0.1',done))
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_)/i.test(key)))
    Object.assign(env,{CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_PLUGIN_CACHE_DIR:join(root,'cache'),TAU_SKIP_PREFLIGHT:'1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1',
      ANTHROPIC_API_KEY:key,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,NO_PROXY:'127.0.0.1,localhost',ENABLE_TOOL_SEARCH:'false'})
    const common=['--plugin-dir',plugin,'--setting-sources','project','--strict-mcp-config','--model','claude-sonnet-4-6','--tools','Read']
    let term
    const outcomes=[]
    try {
      await execute(process.execPath,[cli,'-p','seed','--session-id',session,...common],{cwd:project,env:{...env,CI:'true'},timeout:60000,windowsHide:true})
      assert.equal(JSON.parse(readFileSync(startup,'utf8')).id,session,'normal startup retains its identity')
      for(const variant of ['resume','continue','fork']) {
        unlinkSync(startup);if(existsSync(live))unlinkSync(live)
        const selection=variant==='continue'?['--continue']:['--resume',session,...(variant==='fork'?['--fork-session']:[])]
        if(surface==='print') {
          await execute(process.execPath,[cli,'-p','/startup-identity',...selection,...common],{cwd:project,env:{...env,CI:'true'},timeout:60000,windowsHide:true})
        } else {
          let raw='',exited=false
          term=pty.spawn(process.execPath,[cli,...selection,...common],{name:'xterm-256color',cols:130,rows:45,cwd:project,env})
          term.onData(value=>{raw+=value});term.onExit(()=>{exited=true})
          const ready = replStartupReady(term)
          await waitFor(()=>ready(raw)&&existsSync(startup),'resumed REPL').catch(error=>{
            throw new Error(error.message+'; screen='+raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'').slice(-2200))
          })
          await pause(2500);term.write('/startup-identity');await pause(350);term.write('\r')
          await waitFor(()=>existsSync(live),'live identity command')
          term.write('/exit');await pause(350);term.write('\r')
          await waitFor(()=>exited,'REPL exit',15000)
          term=undefined
        }
        const before=JSON.parse(readFileSync(startup,'utf8')).id,after=JSON.parse(readFileSync(live,'utf8')).id
        outcomes.push({variant,startup:before,live:after})
        if(variant==='fork')assert.notEqual(after,session,'fork keeps its fresh identity')
        else assert.equal(after,session,variant+' restores the source identity')
      }
      assert.deepEqual(outcomes.map(row=>({variant:row.variant,matches:row.startup===row.live})),[
        {variant:'resume',matches:true},{variant:'continue',matches:true},{variant:'fork',matches:true},
      ],'startup hooks must see the eventual session identity')
    } finally {
      if(term){term.kill();await pause(500)}
      server.closeAllConnections();await new Promise(done=>server.close(done))
      rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})
    }
}

// ConPTY keeps native handles alive after its terminal exits. Isolate that
// lifecycle so the test worker can finish after the real UI assertions.
if(process.argv.includes('--interactive-probe')) {
  await loadPty()
  try {await checkIdentity('interactive');process.exit(0)}
  catch(error) {process.stderr.write(String(error.stack??error)+'\n',()=>process.exit(1))}
} else {
  for(const surface of ['print','interactive']) {
    test(`${surface} session.start id matches normal startup, resume, continue and fork`,{timeout:240000},async t=>{
      if(surface==='print')return checkIdentity(surface)
      try {
        await execute(process.execPath,[fileURLToPath(import.meta.url),'--interactive-probe'],{
          env:process.env,timeout:230000,windowsHide:true,
        })
      } catch(error) {
        if(error.code!==PTY_MISSING)throw error
        t.skip('node-pty is not installed')
      }
    })
  }
}
