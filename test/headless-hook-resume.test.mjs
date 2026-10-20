import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

test('headless hook deferral survives restart, rechecks hooks, and keeps the cached prefix', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-hook-resume-'))
  const workspace = join(root, 'project'), config = join(root, 'config')
  for (const dir of [workspace, config, join(root, 'home'), join(workspace, '.claude')]) mkdirSync(dir, { recursive: true })
  const target = join(workspace, 'result.txt')
  const log = join(root, 'hook.jsonl')
  const settings = join(workspace, '.claude', 'settings.json')
  const hookScript = join(root, 'hook.cjs')
  const decisionFile = join(root, 'decision.txt')
  writeFileSync(decisionFile, 'defer')
  writeFileSync(hookScript, `
const fs=require('fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{
const input=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(input)+'\\n');
const permissionDecision=fs.readFileSync(${JSON.stringify(decisionFile)},'utf8');
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision,
...(permissionDecision==='allow'?{updatedInput:{...input.tool_input,content:'approved after resume'}}:{})}}));});`)
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [
    { type: 'command', command: process.execPath, args: [hookScript] },
  ] }] } }))
  const requests = []
  let mode = 'defer'
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', b => { raw += b })
    req.on('end', () => {
      if (!req.url.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return
      }
      const body = JSON.parse(raw)
      requests.push(body)
      const hasResult = body.messages.some(message => Array.isArray(message.content) &&
        message.content.some(block => block.type === 'tool_result'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicReply(mode === 'stop' ? 'Stop fixture response.' : hasResult ? 'Deferred work complete.' :
        [{ name: 'Write', input: { file_path: target, content: 'original model input' } }], body.model))
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  Object.assign(env, {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_API_KEY: 'sk-ant-hook-resume-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
  })
  async function run(args, expectedCode = 0) {
    const child = spawn(process.execPath, [resolve('dist/cli.mjs'), '-p', ...args, '--output-format', 'json',
      '--model', 'claude-sonnet-4-6', '--strict-mcp-config', '--setting-sources', 'project',
      '--dangerously-skip-permissions', '--max-turns', '3'], {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    const timer = setTimeout(() => child.kill(), 35_000)
    const code = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject) })
    clearTimeout(timer)
    assert.equal(code, expectedCode, `${stderr}\n${stdout}`)
    return JSON.parse(stdout)
  }
  try {
    const first = await run(['Write the fixture file now.'])
    assert.equal(first.stop_reason, 'tool_deferred')
    assert.equal(first.deferred_tool_use.name, 'Write')
    assert.equal(existsSync(target), false)
    assert.equal(requests.length, 1)
    const repeated = await run(['--resume', first.session_id])
    assert.equal(repeated.stop_reason, 'tool_deferred')
    assert.deepEqual(repeated.deferred_tool_use, first.deferred_tool_use)
    assert.equal(existsSync(target), false)
    assert.equal(requests.length, 1, 'repeated deferral must not call the model')
    const beforeMissing = readFileSync(log, 'utf8')
    const unavailable = await run(['--resume', first.session_id, '--tools', 'Read'], 1)
    assert.equal(unavailable.stop_reason, 'tool_deferred_unavailable')
    assert.deepEqual(unavailable.deferred_tool_use, first.deferred_tool_use)
    assert.equal(readFileSync(log, 'utf8'), beforeMissing, 'missing tool must be detected before hooks run')
    assert.equal(requests.length, 1, 'missing tool must not call the model')
    writeFileSync(decisionFile, 'allow')
    const approved = await run(['--resume', first.session_id])
    assert.equal(approved.is_error, false)
    assert.equal(approved.result, 'Deferred work complete.')
    assert.equal(readFileSync(target, 'utf8'), 'approved after resume')
    assert.equal(requests.length, 2)
    const resultMessage = requests[1].messages.find(message => Array.isArray(message.content) &&
      message.content.some(block => block.type === 'tool_result'))
    assert.equal(resultMessage.content[0].type, 'tool_result', 'tool result must precede resumed user text')
    // The existing billing header has a per-prompt fingerprint.
    const cachedSystem = request => request.system.filter(block => !block.text?.startsWith('x-anthropic-billing-header:'))
    assert.deepEqual(cachedSystem(requests[1]), cachedSystem(requests[0]), 'hooks must not rewrite the cached system prefix')
    const inputs = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(inputs.length, 3)
    for (const input of inputs) {
      assert.equal(input.tool_use_id, first.deferred_tool_use.id)
      assert.equal(input.tool_input.content, 'original model input')
    }
    mode = 'stop'
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [
      { type: 'command', command: process.execPath, args: ['-e',
        `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'Stop',additionalContext:'HOOK_FEEDBACK_RUN_AGAIN'}}))`] },
    ] }] } }))
    const beforeStop = requests.length
    const stopped = await run(['Stop continuation fixture.'])
    assert.equal(stopped.result, 'Stop fixture response.')
    assert.equal(requests.length - beforeStop, 9, 'eight continuations then the next Stop ends the turn')
    const stopRequests = requests.slice(beforeStop)
    assert.ok(JSON.stringify(stopRequests[1].messages).includes('HOOK_FEEDBACK_RUN_AGAIN'))
    for (const request of stopRequests.slice(1)) {
      assert.deepEqual(request.system, stopRequests[0].system, 'Stop feedback leaves the prompt prefix unchanged')
    }
    env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = '2'
    const beforeOverride = requests.length
    await run(['Stop cap override fixture.'])
    assert.equal(requests.length - beforeOverride, 3)
  } finally {
    await new Promise(done => server.close(done))
    const child = relative(realpathSync(tmpdir()), realpathSync(root))
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
    await rm(root, { recursive: true, force: true, maxRetries: 10 })
  }
})
