// Which credentials reach the wire, through the shipped bundle. @anthropic-ai/sdk 1.x takes one
// credential and throws on two, and it brings a credential chain and telemetry of its own, so
// each way of signing in is pinned here at the header level. A process per case: sign-in state
// and the client are memoized.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

const repositoryRoot = process.cwd()
const bundle = process.env.TAU_MCP_TEST_BUNDLE ?? resolve('dist/tau.mjs')
const helperUrl = new URL('./helpers/mcp-built-runtime.mjs', import.meta.url).href
const root = mkdtempSync(join(tmpdir(), 'tau sdk auth é-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

let caseNumber = 0

function requestHeaders(env, setup = '') {
  const source = `
    import { once } from 'node:events'
    import { createServer } from 'node:http'
    import { propagation } from '@opentelemetry/api'
    import { loadMcpRuntime } from ${JSON.stringify(helperUrl)}
    ${setup}
    const seen = []
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        seen.push(request.headers)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
      })
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = 'http://127.0.0.1:' + server.address().port
    if (process.env.CLAUDE_CODE_USE_AGENTROUTER) process.env.AGENTROUTER_BASE_URL = url
    else process.env.ANTHROPIC_BASE_URL = url
    const { getAnthropicClient } = await loadMcpRuntime({ paths: ['src/services/api/client.ts'], exports: ['getAnthropicClient'] })
    const client = await getAnthropicClient({ maxRetries: 0, model: 'claude-test-model' })
    const message = await client.beta.messages.create({ model: 'claude-test-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
    console.log('TAU_TEST_RESULT ' + JSON.stringify({ text: message.content[0].text, headers: seen[0] }))
    process.exit(0)
  `
  const childEnv = { ...process.env }
  for (const key of Object.keys(childEnv)) {
    // CI is cleared too: under CI=true an auth token alone is refused, which these cases are not about.
    if (/^(anthropic_|claude_code_use_|claude_code_oauth|agent_?router|https?_proxy|otel_|ci$)/i.test(key)) delete childEnv[key]
  }
  Object.assign(childEnv, {
    TAU_MCP_TEST_BUNDLE: bundle,
    CLAUDE_CONFIG_DIR: join(root, `config-${caseNumber++}`),
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    ...env,
  })
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repositoryRoot, env: childEnv, encoding: 'utf8', timeout: 90_000, windowsHide: true,
  })
  const line = result.stdout.split('\n').find(text => text.startsWith('TAU_TEST_RESULT '))
  assert.ok(line, `no result, exit ${result.status}\nstdout: ${result.stdout.slice(-400)}\nstderr: ${result.stderr.slice(-800)}`)
  const { text, headers } = JSON.parse(line.slice('TAU_TEST_RESULT '.length))
  assert.equal(text, 'ok')
  return headers
}

test('an API key goes in x-api-key alone', () => {
  const headers = requestHeaders({ ANTHROPIC_API_KEY: 'sk-ant-test-key' })
  assert.equal(headers['x-api-key'], 'sk-ant-test-key')
  assert.equal(headers.authorization, undefined)
  // The API version decides how the API behaves, so it only moves on purpose.
  assert.equal(headers['anthropic-version'], '2023-06-01')
})

test('a subscription token goes in Authorization alone', () => {
  const headers = requestHeaders({ CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token' })
  assert.equal(headers.authorization, 'Bearer test-oauth-token')
  assert.equal(headers['x-api-key'], undefined)
})

test('ANTHROPIC_AUTH_TOKEN goes in Authorization alone', () => {
  const headers = requestHeaders({ ANTHROPIC_AUTH_TOKEN: 'test-auth-token' })
  assert.equal(headers.authorization, 'Bearer test-auth-token')
  assert.equal(headers['x-api-key'], undefined)
})

test('AgentRouter gets its token in both headers, which the SDK no longer takes as two credentials', () => {
  const headers = requestHeaders({ CLAUDE_CODE_USE_AGENTROUTER: '1', AGENT_ROUTER_TOKEN: 'sk-test-agentrouter-token' })
  assert.equal(headers['x-api-key'], 'sk-test-agentrouter-token')
  assert.equal(headers.authorization, 'Bearer sk-test-agentrouter-token')
})

test('the SDK adds no trace headers of its own', () => {
  // A propagator an application registers is what the SDK would write into each request.
  const headers = requestHeaders({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }, `
    propagation.setGlobalPropagator({
      inject: (_context, carrier, setter) => setter.set(carrier, 'x-test-trace', 'from-sdk'),
      extract: context => context,
      fields: () => ['x-test-trace'],
    })
  `)
  assert.equal(headers['x-test-trace'], undefined)
})
