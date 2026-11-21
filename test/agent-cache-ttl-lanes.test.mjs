import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

// An agent's experimental.cacheTtl ("5m" or "1h") on every lane that has a
// cache-lifetime control: Anthropic cache markers (Anthropic, Bedrock, Vertex,
// Foundry), OpenRouter's Claude rows and Gemini's explicit cache. Every other
// lane ignores it, and a session without it sends what it always sent.
const cwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-agent-cache-ttl-'))
mkdirSync(join(root, 'config'))
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  TAU_OPENROUTER_REASONING_CATALOG: '0',
})
delete process.env.ENABLE_PROMPT_CACHING_1H_OPENROUTER
process.chdir(root)
after(async () => {
  process.chdir(cwd)
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const r = await loadBuiltRuntime({
  paths: ['src/services/api/claude.ts', 'src/lanes/openai-compat/transformers/openrouter.ts',
    'src/services/api/providers/gemini_cache.ts'],
  exports: ['getCacheControl', 'buildSystemPromptBlocks', 'addCacheBreakpoints', 'resolveMarkerCacheTtl',
    'openrouterTransformer', 'getOrCreateCacheWithUsage'],
})

const markers = value => JSON.stringify(value).match(/"cache_control":\{[^}]*\}/g) ?? []

test('Anthropic markers carry the agent lifetime on every breakpoint, both ways', () => {
  assert.equal(r.getCacheControl({ querySource: 'agent:custom' }).ttl, undefined)
  assert.equal(r.getCacheControl({ querySource: 'agent:custom', agentTtl: '1h' }).ttl, '1h')
  // "5m" never takes the hour, whatever the session's 1h rules say.
  assert.equal(r.getCacheControl({ querySource: 'agent:custom', agentTtl: '5m' }).ttl, undefined)

  const system = r.buildSystemPromptBlocks(['You are a helper.', 'Follow the rules.'], true,
    { querySource: 'agent:custom', agentTtl: '1h' })
  const user = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Do it.' } }
  const assistant = { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }
  const messages = r.addCacheBreakpoints([user, assistant, { ...user, uuid: 'u2' }], true, 'agent:custom',
    false, null, [], false, '1h')
  const stamped = [...markers(system), ...markers(messages)]
  assert.ok(stamped.length >= 2)
  assert.ok(stamped.every(marker => marker.includes('"ttl":"1h"')), stamped.join(' '))
  const session = r.addCacheBreakpoints([user, assistant, { ...user, uuid: 'u2' }], true, 'agent:custom')
  assert.ok(markers(session).every(marker => !marker.includes('ttl')))
})

test('only native Anthropic providers carry the lifetime inside markers', () => {
  for (const provider of ['firstParty', 'bedrock', 'vertex', 'foundry']) {
    assert.equal(r.resolveMarkerCacheTtl(provider, '1h'), '1h')
    assert.equal(r.resolveMarkerCacheTtl(provider, '5m'), '5m')
  }
  // AgentRouter speaks the Messages wire but takes no TTL; lanes get a field.
  for (const provider of ['agentrouter', 'openrouter', 'gemini', 'openai', 'cline', 'kilocode', 'deepseek']) {
    assert.equal(r.resolveMarkerCacheTtl(provider, '1h'), undefined)
  }
  assert.equal(r.resolveMarkerCacheTtl('firstParty', undefined), undefined)
})

function openRouterBody(model) {
  return {
    model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'System.', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello.', cache_control: { type: 'ephemeral' } }] },
    ],
    tools: [{ type: 'function', function: { name: 'Read', description: 'Read', parameters: { type: 'object' } } }],
  }
}
const transform = (model, promptCacheTtl) => r.openrouterTransformer.transformRequest(openRouterBody(model), {
  model, isReasoning: false, reasoningEffort: null, ...(promptCacheTtl && { promptCacheTtl }),
})

test('OpenRouter Claude rows take the agent lifetime over the env var, both ways', () => {
  const claude = 'anthropic/claude-sonnet-4.6'
  assert.ok(markers(transform(claude)).every(marker => !marker.includes('ttl')))
  assert.ok(markers(transform(claude, '1h')).every(marker => marker.includes('"ttl":"1h"')))
  assert.equal(markers(transform(claude, '1h')).length, 3)
  process.env.ENABLE_PROMPT_CACHING_1H_OPENROUTER = '1'
  try {
    assert.ok(markers(transform(claude)).every(marker => marker.includes('"ttl":"1h"')))
    assert.ok(markers(transform(claude, '5m')).every(marker => !marker.includes('ttl')))
  } finally {
    delete process.env.ENABLE_PROMPT_CACHING_1H_OPENROUTER
  }
  // Other families keep their own cache lifetimes.
  assert.ok(markers(transform('openai/gpt-5.1', '1h')).every(marker => !marker.includes('ttl')))
})

test('Gemini explicit cache keeps an hour for an agent that asks, as its own entry', async () => {
  const bodies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ name: `cachedContents/c${bodies.length}`, usageMetadata: { totalTokenCount: 5000 } }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const args = {
      model: 'gemini-2.5-flash',
      baseUrl: 'http://127.0.0.1:9/v1beta',
      apiKey: 'test-key',
      systemInstruction: { parts: [{ text: `ttl test ${Date.now()} ${'x'.repeat(20000)}` }] },
      tools: undefined,
    }
    const hour = await r.getOrCreateCacheWithUsage({ ...args, ttlSeconds: 3600 })
    assert.equal(bodies.at(-1).ttl, '3900s')
    const again = await r.getOrCreateCacheWithUsage({ ...args, ttlSeconds: 3600 })
    assert.equal(again.cacheName, hour.cacheName)
    assert.equal(bodies.length, 1, 'a fresh one-hour entry is reused')
    const session = await r.getOrCreateCacheWithUsage(args)
    assert.equal(bodies.at(-1).ttl, '600s')
    assert.notEqual(session.cacheName, hour.cacheName)
  } finally {
    globalThis.fetch = realFetch
  }
})
