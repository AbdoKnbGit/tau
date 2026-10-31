import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
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

test('real CLI helper rewrites and drops prompts, preserves cache prefixes and reports final streaming usage', { timeout: 400_000 }, async () => {
  const cli = resolve('dist/cli.mjs'), root = mkdtempSync(join(tmpdir(), 'tau-prompt-turn-cli-'))
  const project = join(root, 'workspace'), config = join(root, 'config'), plugin = join(root, 'plugin')
  mkdirSync(project)
  const policy = { original: 'original-' + randomUUID(), rewritten: 'rewritten-' + randomUUID(),
    context: 'private-context-' + randomUUID(), drop: 'drop-' + randomUUID(), receipt: randomUUID() }
  const policyText = JSON.stringify(policy), outputTokens = randomInt(19, 70)
  write(join(project, 'policy.json'), policyText)
  write(join(project, 'receipt.txt'), policy.receipt)
  write(join(config, '.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty' })
  write(join(plugin, '.claude-plugin/plugin.json'), { name: 'lifecycle-observer', version: '1.0.0' })
  write(join(plugin, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(join(plugin, 'hooks/register.ts'), `
async function prepare($,text){
  const policy=JSON.parse(await $.fs.read('policy.json'));
  if(text===policy.drop)return {drop:'Submission refused: '+policy.receipt};
  return {text:policy.rewritten,context:[policy.context]};
}
export function register(on){
  on('prompt.submit',async($,e,next)=>{const result=await prepare($,e.text);return result.drop?result:next({...e,...result})});
  on('turn.start',async($,e,next)=>{await $.fs.write('start.json',JSON.stringify(e));return next(e)});
  on('turn.complete',async($,e)=>{await $.fs.write('complete.json',JSON.stringify(e));return {text:'Completion observed'}});
}`)
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') { response.end(); return }
    let raw = ''
    for await (const part of request) raw += part
    if (request.url.includes('count_tokens')) { response.end('{"input_tokens":1}'); return }
    const body = JSON.parse(raw)
    requests.push(body)
    let reply = anthropicReply(requests.length === 1
      ? [{ name: 'Read', input: { file_path: join(project, 'receipt.txt') } }]
      : 'ANSWER-COMPLETE', body.model)
    reply = reply.replace(/^data: (.+)$/gm, (_line, json) => {
      const event = JSON.parse(json)
      if (event.type === 'message_start') event.message.usage.output_tokens = 0
      if (event.type === 'message_delta') event.usage.output_tokens = outputTokens
      return 'data: ' + JSON.stringify(event)
    })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(reply)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1',
    ANTHROPIC_API_KEY: 'sk-ant-local-lifecycle-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false' })
  async function run(prompt) {
    const child = spawn(process.execPath, [cli, '-p', prompt, '--plugin-dir', plugin, '--model', 'claude-sonnet-4-6',
      '--tools', 'Read', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence',
      '--dangerously-skip-permissions', '--max-turns', '3'], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', part => { stdout += part }); child.stderr.on('data', part => { stderr += part })
    // Only guards against a hang: the CLI first loads the whole bundle, slow on a busy machine.
    const timer = setTimeout(() => child.kill(), 120_000)
    try {
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
      return { code, stdout, stderr }
    } finally { clearTimeout(timer) }
  }
  try {
    const result = await run(policy.original)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /ANSWER-COMPLETE/)
    assert.equal(requests.length, 2)
    const first = JSON.stringify(requests[0].messages)
    assert.ok(first.includes(policy.rewritten)); assert.ok(first.includes(policy.context)); assert.ok(!first.includes(policy.original))
    assert.ok(JSON.stringify(requests[1].messages).includes(policy.receipt), 'A real Read must reach the next provider request')
    assert.deepEqual(requests[1].tools, requests[0].tools)
    const prefix = body => body.system.filter(block => !block.text?.startsWith('x-anthropic-billing-header:'))
    assert.deepEqual(prefix(requests[1]), prefix(requests[0]))
    const start = JSON.parse(readFileSync(join(project, 'start.json'), 'utf8'))
    const completeText = readFileSync(join(project, 'complete.json'), 'utf8')
    const complete = JSON.parse(completeText)
    assert.equal(complete.turnId, start.turnId); assert.equal(complete.answer, 'ANSWER-COMPLETE'); assert.equal(complete.isAborted, false)
    assert.equal(complete.usage.input_tokens, 200)
    assert.equal(complete.usage.output_tokens, 2 * outputTokens, 'Completion must observe usage finalized after assistant content blocks')
    const dropped = await run(policy.drop)
    assert.equal(dropped.code, 1, dropped.stdout + dropped.stderr)
    assert.ok((dropped.stdout + dropped.stderr).includes('Submission refused: ' + policy.receipt))
    assert.equal(requests.length, 2, 'A dropped prompt must never reach the model')
    assert.equal(readFileSync(join(project, 'complete.json'), 'utf8'), completeText, 'A dropped prompt must not begin or complete another turn')
    assert.equal(readFileSync(join(project, 'policy.json'), 'utf8'), policyText)
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
