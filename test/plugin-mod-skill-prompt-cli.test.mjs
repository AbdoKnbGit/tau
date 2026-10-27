import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const write = (path, data) => { mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)) }

test('real CLI skill expansion reaches the model, keeps its cache prefix, and respects disable/restart', {timeout: 240_000}, async () => {
  const cli = resolve('dist/cli.mjs'), root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-skill-prompt-cli-')))
  const project = join(root, 'workspace'), config = join(root, 'config'), plugin = join(root, 'plugin')
  mkdirSync(project)
  const original = `ORIGINAL-${randomUUID()}`, rewritten = `REWRITTEN-${randomUUID()}`, receipt = randomUUID(), argument = randomUUID()
  const name = 'review-' + randomUUID(), skillPath = join(project, '.claude/skills', name, 'SKILL.md')
  const skillText = `---\ndescription: Local test skill\ncustom: ${receipt}\nallowed-tools: Read\n---\n${original} $ARGUMENTS`
  write(skillPath, skillText)
  write(join(project, 'policy.json'), {text: rewritten}); write(join(project, 'receipt.txt'), receipt)
  write(join(config, '.claude.json'), {hasCompletedOnboarding: true, lastOnboardingVersion:'99.0.0', activeProvider:'firstParty'})
  write(join(plugin, '.claude-plugin/plugin.json'), {name:'skill-observer', version:'1.0.0'})
  write(join(plugin, 'hooks/hooks.json'), {modules:['./register.ts']})
  write(join(plugin, 'hooks/register.ts'), `export function register(on){
    let count=0;
    on('skill.prompt',async($,e,next)=>{await $.fs.write('expanded.json',JSON.stringify({...e,count:++count}));
      const policy=JSON.parse(await $.fs.read('policy.json'));return next({...e,text:policy.text})});
  }`)
  const requests = []
  const server = createServer(async (request, response) => {
    if(request.method==='HEAD'){response.end();return}
    let raw='';for await(const part of request)raw+=part
    if(request.url.includes('count_tokens')){response.end('{"input_tokens":1}');return}
    const body=JSON.parse(raw);requests.push(body)
    response.writeHead(200,{'content-type':'text/event-stream'})
    response.end(anthropicReply(requests.length%2===1?[{name:'Read',input:{file_path:join(project,'receipt.txt')}}]:'SKILL-COMPLETE',body.model))
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  Object.assign(env,{CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_PLUGIN_CACHE_DIR:join(root,'cache'),CI:'true',NODE_ENV:'production',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1',
    CLAUDE_CODE_USE_NATIVE_FILE_SEARCH:'1',
    TAU_SKIP_PREFLIGHT:'1',ANTHROPIC_API_KEY:'sk-ant-local-skill-test',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,
    NO_PROXY:'127.0.0.1,localhost',ENABLE_TOOL_SEARCH:'false'})
  async function run(enabled) {
    write(join(project,'.claude/settings.local.json'),{enabledPlugins:{'skill-observer@inline':enabled}})
    const debugPath=join(root,`debug-${requests.length}.log`)
    const child=spawn(process.execPath,[cli,'-p',`/${name} ${argument}`,'--plugin-dir',plugin,'--model','claude-sonnet-4-6',
      '--tools','Read','--strict-mcp-config','--setting-sources','project,local','--no-session-persistence','--debug-file',debugPath,
      '--dangerously-skip-permissions','--max-turns','3'],{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='';child.stdout.on('data',part=>{stdout+=part});child.stderr.on('data',part=>{stderr+=part})
    const timer=setTimeout(()=>child.kill(),70_000)
    try{const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done)});assert.equal(code,0,stdout+stderr+(code!==0&&existsSync(debugPath)?readFileSync(debugPath,'utf8').split('\n').slice(-40).join('\n'):''));assert.match(stdout,/SKILL-COMPLETE/)}
    finally{clearTimeout(timer)}
  }
  function verifyPair(index, expected, excluded) {
    const [first,second]=requests.slice(index,index+2)
    assert.ok(first&&second,JSON.stringify(requests))
    assert.ok(JSON.stringify(first.messages).includes(expected));assert.ok(!JSON.stringify(first.messages).includes(excluded))
    assert.ok(JSON.stringify(second.messages).includes(receipt),'The native Read must reach the next model request')
    const prefix=body=>body.system.filter(block=>!block.text?.startsWith('x-anthropic-billing-header:'))
    assert.deepEqual(prefix(second),prefix(first));assert.deepEqual(second.tools,first.tools)
  }
  try {
    await run(true);verifyPair(0,rewritten,original)
    const evidence=JSON.parse(readFileSync(join(project,'expanded.json'),'utf8'))
    assert.equal(evidence.count,1);assert.equal(evidence.skill,name);assert.equal(evidence.source,'projectSettings')
    assert.equal(evidence.path,skillPath);assert.equal(evidence.frontmatter.custom,receipt)
    assert.ok(evidence.text.includes(`${original} ${argument}`),'The hook sees interpolation before rewriting')
    await run(false);verifyPair(2,original,rewritten)
    assert.deepEqual(JSON.parse(readFileSync(join(project,'expanded.json'),'utf8')),evidence)
    const restored='RESTORED-'+randomUUID();write(join(project,'policy.json'),{text:restored})
    await run(true);verifyPair(4,restored,rewritten)
    assert.equal(requests.length,6);assert.equal(readFileSync(skillPath,'utf8'),skillText)
  } finally {
    server.closeAllConnections();await new Promise(done=>server.close(done))
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})
  }
})
