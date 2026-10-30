// Bedrock, Vertex and Foundry through the shipped bundle, against a local server.
// Their adapters are bundled, so these tests pin what has to keep working with
// Tau's @anthropic-ai/sdk: the wire shape each provider needs, streaming, and
// errors that are Tau's own APIError, which the retry paths rely on.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const repositoryRoot = process.cwd()
process.env.TAU_MCP_TEST_BUNDLE ??= resolve('dist/tau.mjs')
// The SDK copy the bundle itself resolves, which is the one that has to be shared.
const sdkEntry = createRequire(process.env.TAU_MCP_TEST_BUNDLE).resolve('@anthropic-ai/sdk')
const { APIError } = await import(pathToFileURL(join(dirname(sdkEntry), 'index.mjs')).href)
const root = mkdtempSync(join(tmpdir(), 'tau provider sdk é-'))
const project = join(root, 'project')
mkdirSync(project, { recursive: true })
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  API_TIMEOUT_MS: '20000',
})
process.chdir(project)

const { getAnthropicClient } = await loadMcpRuntime({
  paths: ['src/services/api/client.ts'],
  exports: ['getAnthropicClient'],
})

const streamEvents = [
  { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]

// Bedrock streams in AWS's binary event-stream format, not server-sent events.
function bedrockEventStream() {
  const { EventStreamCodec } = createRequire(import.meta.url)('@smithy/eventstream-codec')
  const codec = new EventStreamCodec(
    bytes => Buffer.from(bytes).toString('utf8'),
    text => Buffer.from(text, 'utf8'),
  )
  return Buffer.concat(
    streamEvents.map(event =>
      Buffer.from(
        codec.encode({
          headers: {
            ':event-type': { type: 'string', value: 'chunk' },
            ':content-type': { type: 'string', value: 'application/json' },
            ':message-type': { type: 'string', value: 'event' },
          },
          body: Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') })),
        }),
      ),
    ),
  )
}

const requests = []
let respondWith = 200
const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => {
    body += chunk
  })
  request.on('end', () => {
    requests.push({ url: request.url, headers: request.headers, body })
    if (respondWith !== 200) {
      response.writeHead(respondWith, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }))
    } else if (request.url.includes('invoke-with-response-stream')) {
      response.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
      response.end(bedrockEventStream())
    } else if (JSON.parse(body || '{}').stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(streamEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test',
        content: [{ type: 'text', text: 'from the fake server' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }))
    }
  })
}).listen(0, '127.0.0.1')
await new Promise(done => server.once('listening', done))
const baseUrl = `http://127.0.0.1:${server.address().port}`

after(() => {
  server.close()
  server.closeAllConnections()
  process.chdir(repositoryRoot)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

const model = 'claude-test-model'
const request = { model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }

async function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// Bedrock also lists inference profiles in the background, through client-bedrock.
const modelRequests = () => requests.filter(r => !r.url.startsWith('/inference-profiles'))

async function exerciseProvider(env, checkCall, checkStream) {
  await withEnv(env, async () => {
    const client = await getAnthropicClient({ maxRetries: 0, model })

    respondWith = 200
    requests.length = 0
    const message = await client.beta.messages.create(request)
    assert.equal(message.content[0].text, 'from the fake server')
    assert.equal(modelRequests().length, 1, requests.map(r => r.url).join(', '))
    checkCall(modelRequests()[0])

    requests.length = 0
    const stream = await client.beta.messages.create({ ...request, stream: true })
    const types = []
    for await (const event of stream) types.push(event.type)
    assert.deepEqual(types, streamEvents.map(event => event.type))
    checkStream(modelRequests()[0])

    // The same class Tau imports, not a look-alike from a second SDK copy.
    respondWith = 429
    await assert.rejects(client.beta.messages.create(request), error => {
      assert.ok(error instanceof APIError, `not Tau's APIError: ${error?.constructor?.name}`)
      assert.equal(error.status, 429)
      return true
    })
    respondWith = 200
  })
}

const bedrockEnv = {
  CLAUDE_CODE_USE_BEDROCK: '1',
  ANTHROPIC_BEDROCK_BASE_URL: baseUrl,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST',
  AWS_SECRET_ACCESS_KEY: 'test-secret-key',
}

test('Bedrock rewrites the URL, signs with AWS, streams, and shares the SDK', () =>
  exerciseProvider(
    bedrockEnv,
    ({ url, headers, body }) => {
      assert.match(url, /\/model\/claude-test-model\/invoke$/)
      assert.match(headers.authorization, /^AWS4-HMAC-SHA256 /)
      assert.equal('model' in JSON.parse(body), false)
      assert.equal(JSON.parse(body).anthropic_version, 'bedrock-2023-05-31')
    },
    ({ url }) => assert.match(url, /\/model\/claude-test-model\/invoke-with-response-stream$/),
  ))

test('Bedrock API keys and proxies skip AWS signing', async () => {
  for (const [env, expected] of [
    [{ AWS_BEARER_TOKEN_BEDROCK: 'test-bearer' }, 'Bearer test-bearer'],
    [{ CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1' }, undefined],
  ]) {
    await withEnv({ ...bedrockEnv, ...env }, async () => {
      const client = await getAnthropicClient({ maxRetries: 0, model })
      requests.length = 0
      await client.beta.messages.create(request)
      assert.equal(modelRequests()[0].headers.authorization, expected)
    })
  }
})

test('Bedrock lists inference profiles through client-bedrock', async () => {
  await withEnv(bedrockEnv, async () => {
    requests.length = 0
    const client = await getAnthropicClient({ maxRetries: 0, model })
    await client.beta.messages.create(request)
    for (let i = 0; i < 100 && !requests.some(r => r.url.startsWith('/inference-profiles')); i++) {
      await new Promise(done => setTimeout(done, 20))
    }
    const listing = requests.find(r => r.url.startsWith('/inference-profiles'))
    // Memoized for the process, so an earlier test may have made the call already.
    if (listing) assert.match(listing.headers.authorization, /^AWS4-HMAC-SHA256 /)
  })
})

const vertexEnv = {
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
  ANTHROPIC_VERTEX_PROJECT_ID: 'tau-test-project',
  CLOUD_ML_REGION: 'us-east5',
}

test('Vertex rewrites the URL, streams, and shares the SDK', () =>
  exerciseProvider(
    { ...vertexEnv, ANTHROPIC_VERTEX_BASE_URL: baseUrl },
    ({ url, body }) => {
      assert.match(url, /\/projects\/tau-test-project\/locations\/us-east5\/publishers\/anthropic\/models\/claude-test-model:rawPredict/)
      assert.equal('model' in JSON.parse(body), false)
      assert.equal(JSON.parse(body).anthropic_version, 'vertex-2023-10-16')
    },
    ({ url }) => assert.match(url, /claude-test-model:streamRawPredict/),
  ))

test('Vertex reaches the multi-region endpoints', async () => {
  for (const [region, host] of [
    ['us-east5', 'https://us-east5-aiplatform.googleapis.com/v1'],
    ['global', 'https://aiplatform.googleapis.com/v1'],
    ['us', 'https://aiplatform.us.rep.googleapis.com/v1'],
    ['eu', 'https://aiplatform.eu.rep.googleapis.com/v1'],
  ]) {
    await withEnv({ ...vertexEnv, CLOUD_ML_REGION: region, ANTHROPIC_VERTEX_BASE_URL: undefined }, async () => {
      const client = await getAnthropicClient({ maxRetries: 0, model })
      assert.equal(client.baseURL, host)
    })
  }
  await withEnv({ ...vertexEnv, CLOUD_ML_REGION: 'global', ANTHROPIC_VERTEX_BASE_URL: baseUrl }, async () => {
    const client = await getAnthropicClient({ maxRetries: 0, model })
    assert.equal(client.baseURL, baseUrl)
  })
})

const foundryEnv = { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: baseUrl }

test('Foundry sends its API key, streams, and shares the SDK', () =>
  exerciseProvider(
    { ...foundryEnv, ANTHROPIC_FOUNDRY_API_KEY: 'test-foundry-key' },
    ({ headers }) => {
      assert.equal(headers['x-api-key'], 'test-foundry-key')
      assert.equal(headers['anthropic-version'], '2023-06-01')
    },
    ({ headers }) => assert.equal(headers['x-api-key'], 'test-foundry-key'),
  ))

test('Foundry with auth skipped sends no credentials', async () => {
  await withEnv({ ...foundryEnv, ANTHROPIC_FOUNDRY_API_KEY: undefined, CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1' }, async () => {
    const client = await getAnthropicClient({ maxRetries: 0, model })
    requests.length = 0
    await client.beta.messages.create(request)
    assert.equal(requests[0].headers['x-api-key'], undefined)
    assert.equal(requests[0].headers.authorization, undefined)
  })
})

test('Foundry without a key explains the optional sign-in package', async t => {
  try {
    createRequire(join(repositoryRoot, 'package.json')).resolve('@azure/identity')
    return t.skip('@azure/identity is installed here')
  } catch {
    // Not installed: the case under test.
  }
  await withEnv({ ...foundryEnv, ANTHROPIC_FOUNDRY_API_KEY: undefined }, () =>
    assert.rejects(
      getAnthropicClient({ maxRetries: 0, model }),
      /@azure\/identity.*ANTHROPIC_FOUNDRY_API_KEY/,
    ),
  )
})
