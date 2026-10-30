// The whole chain through the shipped CLI: a plugin whose server is an .mcpb file,
// a model that calls its tool, and the server's answer coming back to the model.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { getNodeRuntimeIssue } from '../scripts/node-runtime.mjs'

// On these Node versions a process can die in shutdown after its work is done.
const exitMayCrash = getNodeRuntimeIssue(process.versions.node) === 'windows-shutdown'
const cli = resolve('dist/cli.mjs')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value))
}

const SERVER = `const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line)
  if (q.id === undefined) return
  let result = {}
  if (q.method === 'initialize') result = { protocolVersion: q.params.protocolVersion, serverInfo: { name: 'echo', version: '1' }, capabilities: { tools: {} } }
  if (q.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a greeting', inputSchema: { type: 'object', properties: {} } }] }
  if (q.method === 'tools/call') result = { content: [{ type: 'text', text: 'greeting from the bundled server: ' + process.env.BUNDLE_TAG }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n')
})
`

const sse = events =>
  events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
const start = {
  type: 'message_start',
  message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
}
const toolName = 'mcp__plugin_bundle-plugin_echo__echo'
const callTool = sse([
  start,
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_test', name: toolName, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
])
const finish = sse([
  start,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'all done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
])

test('a plugin with an .mcpb server works through the real CLI', { timeout: 240_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'tau mcpb CLI é '))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const workspace = join(root, 'workspace')
  const config = join(root, 'config')
  const plugin = join(root, 'plugin')
  mkdirSync(workspace)

  // Written the way mcpb init writes it: manifest 0.2, plain "node".
  const manifest = {
    manifest_version: '0.2',
    name: 'echo',
    version: '1.0.0',
    author: { name: 'Tau Test' },
    description: 'Echo server',
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { BUNDLE_TAG: 'tag-from-manifest' } },
    },
  }
  write(join(plugin, '.claude-plugin/plugin.json'), {
    name: 'bundle-plugin',
    version: '1.0.0',
    mcpServers: './mcp/echo.mcpb',
  })
  write(
    join(plugin, 'mcp/echo.mcpb'),
    zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'server/index.js': strToU8(SERVER),
    }),
  )

  const modelBodies = []
  const model = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      modelBodies.push(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(body.includes('greeting from the bundled server') ? finish : callTool)
    })
  })
  await new Promise(done => model.listen(0, '127.0.0.1', done))
  t.after(() => {
    model.close()
    model.closeAllConnections()
  })

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key),
    ),
  )
  Object.assign(env, {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
    CI: 'true',
    NODE_ENV: 'production',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    TAU_SKIP_PREFLIGHT: '1',
    ENABLE_TOOL_SEARCH: 'false',
    ANTHROPIC_API_KEY: 'sk-ant-fixture',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`,
    NO_PROXY: '127.0.0.1,localhost',
  })
  write(join(config, '.claude.json'), {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    activeProvider: 'firstParty',
  })

  const debugFile = join(workspace, 'cli-debug.log')
  const child = spawn(
    process.execPath,
    [
      cli,
      '-p',
      'say hello with the tool',
      '--model',
      'claude-sonnet-4-6',
      '--plugin-dir',
      plugin,
      '--setting-sources',
      'project',
      '--allowedTools',
      toolName,
      '--no-session-persistence',
      '--debug-file',
      debugFile,
    ],
    { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', value => {
    stdout += value
  })
  child.stderr.on('data', value => {
    stderr += value
  })
  const code = await new Promise((done, fail) => {
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error(`timed out\n${stdout}\n${stderr}`))
    }, 120_000)
    child.on('exit', exitCode => {
      clearTimeout(timer)
      done(exitCode)
    })
  })
  const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8').slice(-6000) : 'no debug log'

  if (!exitMayCrash) assert.equal(code, 0, `${stdout}\n${stderr}\n${debug}`)
  assert.doesNotMatch(`${stdout}\n${stderr}\n${debug}`, /Cannot find package|Failed to extract MCPB/)
  assert.ok(modelBodies.length >= 2, `model requests: ${modelBodies.length}\n${debug}`)
  // Any request: on a busy machine the server can still be starting during the first one.
  assert.ok(modelBodies.some(body => body.includes(toolName)), `the model was not offered the plugin's tool\n${debug}`)
  assert.ok(
    modelBodies.at(-1).includes('greeting from the bundled server: tag-from-manifest'),
    `the server's answer never reached the model\n${debug}`,
  )
  assert.match(stdout, /all done/)
})
