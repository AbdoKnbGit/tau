import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

test('shipped CLI runs two mod-submitted turns independently and reads live history without changing cache prefixes', { timeout: 60_000 }, async () => {
  const cli = resolve('dist/cli.mjs'), root = mkdtempSync(join(tmpdir(), 'tau-submit-cli-'))
  const project = join(root, 'workspace'), config = join(root, 'config'), plugin = join(root, 'plugin')
  mkdirSync(project)
  const receipts = [randomUUID(), randomUUID()]
  receipts.forEach((receipt, i) => write(join(project, `receipt-${i}.txt`), receipt))
  write(join(config, '.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty' })
  write(join(plugin, '.claude-plugin/plugin.json'), { name: 'queue-observer', version: '1.0.0' })
  write(join(plugin, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(join(plugin, 'hooks/register.ts'), `
let starts = [], answers = [], receipts = [], prompts = [];
export function register(on) {
  on('session.start',async($,e,next)=>{await $.command.register({name:'queue-two',description:'Queue two turns'});return next(e)});
  on('command.run',async($,e,next)=>{if(e.command!=='queue-two')return next(e);
    for(let i=0;i<2;i++)void $.prompt.submit({text:'Read receipt-'+i+'.txt once and quote its contents.',...(i===1?{asUser:true}:{})}).then(value=>{receipts.push(value)});
    return {text:'Queued two turns'};
  });
  on('prompt.submit',async($,e,next)=>{prompts.push(e);return next({...e,context:['PRIVATE-QUEUE-CONTEXT']})});
  on('turn.start',async($,e,next)=>{starts.push(e.turnId);return next(e)});
  on('turn.complete',async($,e,next)=>{answers.push(e);
    await $.fs.write('state.json',JSON.stringify({starts,answers,receipts,prompts,model:await $.session.model(),turns:await $.session.turns(),rows:await $.session.messages(),api:await $.session.messages({as:'api'})}));return next(e);
  });
}`)
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') { response.end(); return }
    let raw = ''
    for await (const part of request) raw += part
    if (request.url.includes('count_tokens')) { response.end('{"input_tokens":1}'); return }
    const body = JSON.parse(raw)
    requests.push(body)
    const index = Math.floor((requests.length - 1) / 2)
    const reply = requests.length % 2 === 1
      ? [{ name: 'Read', input: { file_path: join(project, `receipt-${index}.txt`) } }]
      : `RESULT-${index}: ${receipts[index]}`
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply(reply, body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1',
    ANTHROPIC_API_KEY: 'sk-ant-local-queue-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false' })
  const child = spawn(process.execPath, [cli, '-p', '/queue-two', '--plugin-dir', plugin, '--model', 'claude-sonnet-4-6',
    '--tools', 'Read', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence',
    '--dangerously-skip-permissions', '--max-turns', '3'], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', part => { stdout += part }); child.stderr.on('data', part => { stderr += part })
  const timer = setTimeout(() => child.kill(), 45_000)
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    assert.equal(code, 0, stdout + stderr)
    assert.equal(requests.length, 4, stdout + stderr)
    const state = JSON.parse(readFileSync(join(project, 'state.json'), 'utf8'))
    assert.equal(state.starts.length, 2)
    assert.equal(new Set(state.starts).size, 2)
    assert.equal(state.answers.length, 2)
    assert.ok(state.answers.every(answer => !answer.isAborted))
    assert.equal(state.receipts.length, 2)
    assert.equal(state.prompts.length, 2)
    assert.equal(state.turns, 1, 'Only the user slash command counts; both plugin turns and tool replies do not')
    assert.equal(state.model, 'claude-sonnet-4-6')
    assert.deepEqual(state.prompts.map(prompt => prompt.origin), [
      { kind: 'plugin', name: 'queue-observer' }, { kind: 'plugin', name: 'queue-observer', asUser: true },
    ])
    for (let i = 0; i < 2; i++) {
      assert.ok(JSON.stringify(state.rows).includes(receipts[i]))
      assert.ok(JSON.stringify(state.api).includes(receipts[i]))
      assert.equal(readFileSync(join(project, `receipt-${i}.txt`), 'utf8'), receipts[i])
      assert.ok(JSON.stringify(requests[i * 2 + 1].messages).includes(receipts[i]))
    }
    assert.match(JSON.stringify(requests[0].messages), /The queue-observer plugin sent a message:/)
    assert.match(JSON.stringify(requests[0].messages), /PRIVATE-QUEUE-CONTEXT/)
    const prefix = body => body.system.filter(block => !block.text?.startsWith('x-anthropic-billing-header:'))
    for (const request of requests.slice(1)) {
      assert.deepEqual(prefix(request), prefix(requests[0]))
      assert.deepEqual(request.tools, requests[0].tools)
    }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    server.closeAllConnections(); await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
