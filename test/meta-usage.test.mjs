import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// /usage for Meta, through the shipped bundle: the reporter table, the auth
// key lookup and the rate-limit store, with Meta's recorded wire format.
const tempRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(tempRoot, 'tau-meta-usage-'))
process.env.CLAUDE_CONFIG_DIR = fixture
process.env.DISABLE_TELEMETRY = '1'
process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
process.env.TAU_META_THINKING_STORE = join(fixture, 'meta-thinking.json')
process.env.TAU_META_MODEL_CATALOG_STORE = join(fixture, 'meta-models.json')
for (const name of ['META_BASE_URL', 'META_MODEL_API_KEY', 'MODEL_API_KEY', 'CLAUDE_CODE_EFFORT_LEVEL']) delete process.env[name]
process.env.META_API_KEY = 'LLM_1607358788850350_fixture'
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Meta usage tests must not access the network') }

const r = await loadMcpRuntime({
  paths: ['src/services/api/providerUsage.ts', 'src/lanes/openai-compat/meta_responses.ts'],
  // Test seams are tree-shaken out of the bundle; this process starts with no
  // spend and no rate-limit reading, which is the state the first test needs.
  exports: ['fetchProviderUsageFor', 'streamMetaResponses'],
})

test.after(() => {
  globalThis.fetch = originalFetch
  delete process.env.META_API_KEY
  const resolved = realpathSync(fixture)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup')
  rmSync(resolved, { recursive: true, force: true })
})

// One recorded muse-spark-1.3 turn: 570 prompt tokens (113 cached), 92 output.
function sse() {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Sunny, 18°C.' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sunny, 18°C.' }] } },
    { type: 'response.completed', response: { usage: {
      input_tokens: 570, input_tokens_details: { cached_tokens: 113 },
      output_tokens: 92, output_tokens_details: { reasoning_tokens: 25 }, total_tokens: 662,
    } } },
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

async function drain(gen) {
  let step = await gen.next()
  while (!step.done) step = await gen.next()
  return step.value
}

test('/usage reports the key, this session\'s spend at published rates and rate-limit headroom', async () => {
  globalThis.fetch = async url => String(url).endsWith('/responses')
    ? new Response(sse(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-ratelimit-limit-requests': '3000', 'x-ratelimit-remaining-requests': '2400' },
      })
    : Response.json({ object: 'list', data: [{ id: 'muse-spark-1.3' }, { id: 'muse-wonder-1.0' }] })
  await drain(r.streamMetaResponses({ apiKey: process.env.META_API_KEY, baseUrl: '' }, {
    model: 'muse-spark-1.3', system: 'You are Tau.', messages: [{ role: 'user', content: 'weather?' }],
    tools: [], max_tokens: 1024, signal: new AbortController().signal,
  }, 'sess-usage'))
  const report = await r.fetchProviderUsageFor('meta')
  assert.equal(report.name, 'Meta')
  assert.equal(report.status, 'ok')
  assert.equal(report.auth, 'api_key')
  assert.equal(report.summary, 'API key active, 2 models available.')
  // (457 × 1.25 + 113 × 0.15 + 92 × 4.25) / 1M = $0.0009792
  assert.match(report.detail, /This session: \$0\.0010 over 1 request, priced from Meta's published rates\./)
  assert.match(report.detail, /no balance or spend API/)
  assert.deepEqual(report.metrics, [{ label: 'Rate limit: requests', usedPercent: 20, summary: '2,400 of 3,000 left' }])
  assert.deepEqual(report.links.map(link => link.url), ['https://dev.meta.ai/usage', 'https://dev.meta.ai/billing'])
})

test('/usage names a rejected key with Meta\'s own reason', async () => {
  globalThis.fetch = async () => Response.json(
    { error: { code: 'invalid_api_key', message: 'Unauthorized', param: null, type: 'authentication_error' } },
    { status: 401 },
  )
  const report = await r.fetchProviderUsageFor('meta')
  assert.equal(report.status, 'error')
  assert.equal(report.summary, 'Meta rejected the API key (401): Unauthorized (invalid_api_key)')
})
