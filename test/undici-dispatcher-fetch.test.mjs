// Node's built-in fetch and the undici package are separate copies of undici. Proxies,
// custom CA certificates and mTLS all use a dispatcher from the package, so these tests
// run those paths through the shipped bundle on whichever Node runs them. On Node 26,
// where the built-in copy is the newer major, this used to lose every response header.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { getNodeRuntimeIssue } from '../scripts/node-runtime.mjs'

// On these Node versions a process can die in shutdown after its work is done.
const exitMayCrash = getNodeRuntimeIssue(process.versions.node) === 'windows-shutdown'
const repositoryRoot = process.cwd()
const bundle = process.env.TAU_MCP_TEST_BUNDLE ?? resolve('dist/tau.mjs')
const helperUrl = new URL('./helpers/mcp-built-runtime.mjs', import.meta.url).href
const root = mkdtempSync(join(tmpdir(), 'tau undici é-'))
// Plain HTTP below, so its content never matters: its presence is what builds a dispatcher.
const extraCa = join(root, 'extra-ca.pem')
writeFileSync(extraCa, '-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n')

const message = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'test',
  content: [{ type: 'text', text: 'from the fake server' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
}
const streamEvents = [
  { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
  { type: 'message_stop' },
]

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => {
    body += chunk
  })
  request.on('end', () => {
    if (request.url.startsWith('/limited')) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }))
    } else if (request.url.startsWith('/mcp')) {
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      const rpc = JSON.parse(body)
      if (rpc.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const result =
        rpc.method === 'initialize'
          ? { protocolVersion: rpc.params.protocolVersion, serverInfo: { name: 'http', version: '1' }, capabilities: { tools: {} } }
          : { tools: [{ name: 'over_http', inputSchema: { type: 'object', properties: {} } }] }
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    } else if (JSON.parse(body || '{}').stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(streamEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    } else {
      response.writeHead(200, { 'content-type': 'application/json', 'x-demo': 'yes' })
      response.end(JSON.stringify(message))
    }
  })
}).listen(0, '127.0.0.1')
await new Promise(done => server.once('listening', done))
const target = `http://127.0.0.1:${server.address().port}`

let tunnels = 0
const proxy = createServer((_request, response) => response.writeHead(405).end())
proxy.on('connect', (request, client, head) => {
  tunnels++
  const [host, port] = request.url.split(':')
  const upstream = connect(Number(port), host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  upstream.on('error', () => client.destroy())
  client.on('error', () => upstream.destroy())
})
proxy.listen(0, '127.0.0.1')
await new Promise(done => proxy.once('listening', done))
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`

after(() => {
  server.close()
  server.closeAllConnections()
  proxy.close()
  proxy.closeAllConnections()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

let caseNumber = 0

// A process per case: certificates and proxies are read once and memoized.
function runInProcess(source, env) {
  const childEnv = { ...process.env }
  for (const key of Object.keys(childEnv)) {
    if (/^(https?_proxy|no_proxy|all_proxy|node_extra_ca_certs|claude_code_client_)/i.test(key)) delete childEnv[key]
  }
  Object.assign(childEnv, {
    TAU_MCP_TEST_BUNDLE: bundle,
    CLAUDE_CONFIG_DIR: join(root, `config-${caseNumber++}`),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    TARGET: target,
    ...env,
  })
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repositoryRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => {
      stdout += data
    })
    child.stderr.on('data', data => {
      stderr += data
    })
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error(`timed out\nstdout: ${stdout.slice(-400)}\nstderr: ${stderr.slice(-400)}`))
    }, 90_000)
    child.on('exit', code => {
      clearTimeout(timer)
      if ((code === 0 || exitMayCrash) && stdout.includes('TAU_TEST_DONE')) done(stdout)
      else fail(new Error(`exit ${code}\nstdout: ${stdout.slice(-400)}\nstderr: ${stderr.slice(-800)}`))
    })
  })
}

const load = (paths, exports) => `
  import assert from 'node:assert/strict'
  import { createRequire } from 'node:module'
  import { loadMcpRuntime } from ${JSON.stringify(helperUrl)}
  const target = process.env.TARGET
  const runtime = await loadMcpRuntime({ paths: ${JSON.stringify(paths)}, exports: ${JSON.stringify(exports)} })
`
const finish = `console.log('TAU_TEST_DONE'); process.exit(0)`

test('a custom CA certificate leaves the API client its headers', { timeout: 120_000 }, async () => {
  await runInProcess(
    `${load(['src/services/api/client.ts'], ['getAnthropicClient'])}
    const request = { model: 'claude-test-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }
    const client = await runtime.getAnthropicClient({ maxRetries: 0, model: 'claude-test-model' })

    const { data, response } = await client.beta.messages.create(request).withResponse()
    assert.equal(data.content?.[0].text, 'from the fake server')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-demo'), 'yes')

    const types = []
    for await (const event of await client.beta.messages.create({ ...request, stream: true })) types.push(event.type)
    assert.deepEqual(types, ['message_start', 'message_stop'])

    const limited = await runtime.getAnthropicClient({ maxRetries: 0, model: 'claude-test-model' })
    limited.baseURL = target + '/limited'
    await assert.rejects(limited.beta.messages.create(request), error => {
      assert.equal(error.status, 429)
      assert.equal(error.headers?.get('retry-after'), '7')
      return true
    })
    ${finish}`,
    { NODE_EXTRA_CA_CERTS: extraCa, ANTHROPIC_API_KEY: 'sk-ant-fixture', ANTHROPIC_BASE_URL: target },
  )
})

test('an HTTP MCP server connects through a proxy', { timeout: 120_000 }, async () => {
  const before = tunnels
  await runInProcess(
    `${load([], [])}
    const client = await runtime.connectToServer('over_proxy', { type: 'http', url: target + '/mcp', scope: 'local' })
    assert.equal(client.type, 'connected', client.error)
    const { tools } = await client.client.listTools()
    assert.equal(tools[0].name, 'over_http')
    ${finish}`,
    { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl },
  )
  assert.ok(tunnels > before, 'the request did not go through the proxy')
})

test('plain fetch follows the global proxy and keeps its headers', { timeout: 120_000 }, async () => {
  const before = tunnels
  await runInProcess(
    `${load(['src/utils/proxy.ts'], ['configureGlobalAgents'])}
    runtime.configureGlobalAgents()
    const response = await fetch(target + '/plain', { method: 'POST', body: '{}' })
    assert.equal(response.headers.get('x-demo'), 'yes')
    assert.equal((await response.json()).id, 'msg_test')
    ${finish}`,
    { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl },
  )
  assert.ok(tunnels > before, 'the request did not go through the proxy')
})

test('the on-by-default Antigravity keep-alive dispatcher keeps its headers', { timeout: 120_000 }, async () => {
  await runInProcess(
    `${load(['src/lanes/gemini/antigravity_transport.ts'], ['antigravityTransportFor'])}
    const url = target + '/gemini'
    const { dispatcher, profile } = runtime.antigravityTransportFor(url)
    assert.equal(profile.dispatcher, 'keepalive')
    const response = await fetch(url, { method: 'POST', body: '{}', dispatcher })
    assert.equal(response.headers.get('x-demo'), 'yes')
    assert.equal((await response.json()).id, 'msg_test')
    await dispatcher.close()
    ${finish}`,
    {},
  )
})

test("fetch only stays on Node's built-in copy when that copy is known to fit", { timeout: 120_000 }, async () => {
  await runInProcess(
    `${load(['src/utils/mtls.ts'], ['getTLSFetchOptions'])}
    // Distribution builds of Node may not report a version at all.
    const major = version => Number(version?.split('.')[0])
    const packaged = createRequire(process.env.TAU_MCP_TEST_BUNDLE)('undici/package.json').version
    const builtin = globalThis.fetch
    const { dispatcher } = runtime.getTLSFetchOptions()
    assert.ok(dispatcher)
    const replaced = globalThis.fetch !== builtin
    assert.equal(replaced, !(major(process.versions.undici) <= major(packaged)))
    ${finish}`,
    { NODE_EXTRA_CA_CERTS: extraCa },
  )
})

test("a fetch someone else installed is left in place", { timeout: 120_000 }, async () => {
  await runInProcess(
    `${load(['src/utils/mtls.ts'], ['getTLSFetchOptions'])}
    const mine = async (input, init) => new Response('{}')
    globalThis.fetch = mine
    const { dispatcher } = runtime.getTLSFetchOptions()
    assert.ok(dispatcher)
    assert.equal(globalThis.fetch, mine)
    ${finish}`,
    { NODE_EXTRA_CA_CERTS: extraCa },
  )
})
