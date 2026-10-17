import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Text that tells the model to load tools with ToolSearch must appear exactly
// when the request carries ToolSearch. Providers that receive every schema
// eagerly were told to "load X with ToolSearch" and "First call ToolSearch";
// OpenCode's step-5-preview-free then refused EnterWorktree, which was in its
// tool list, because no ToolSearch existed to load it (2026-10-10).
// Run after `node build.mjs`: node --test test/tool-search-wording.test.mjs
const testDirectory = mkdtempSync(join(tmpdir(), 'tau-tool-search-wording-'))
process.env.CLAUDE_CONFIG_DIR = testDirectory
delete process.env.ENABLE_TOOL_SEARCH
delete process.env.TAU_NATIVE_LAZY_TOOLS
delete process.env.ANTHROPIC_BASE_URL
test.after(() => rmSync(testDirectory, { recursive: true, force: true }))

const r = await loadMcpRuntime({
  paths: ['src/utils/toolSearch.ts', 'src/services/api/providers/nativeLaneReadiness.ts',
    'src/utils/forcedProvider.ts', 'src/utils/powerMode.ts', 'src/lanes/shared/mcp_bridge.ts',
    'src/lanes/kilo/loop.ts', 'src/lanes/cline/loop.ts'],
  exports: ['isToolSearchOfferedForModel', 'installNativeLaneReadinessResolver',
    'runWithForcedProvider', 'setSessionPowerMode', 'getUsingYourToolsSection', 'buildOpenAICompatToolUsageRules',
    'OPENAI_COMPAT_TOOL_USAGE_RULES', 'KiloLane', 'ClineLane'],
})
// Every native lane counts as routed, as it is once its credentials load.
// Nothing has asked about a provider yet, so no eager latch exists.
r.installNativeLaneReadinessResolver(() => true)
r.setSessionPowerMode('normal')
const as = (provider, fn) => r.runWithForcedProvider({ provider }, fn)

const LOADING = 'First call ToolSearch'
const EAGER = 'Every available callable tool has its full schema in this request.'
// Requests keep ToolSearch: client-side discovery lanes and Anthropic tool search.
const LAZY = [['ollama', 'qwen3:8b'], ['lmstudio', 'qwen3-8b'], ['firstParty', 'claude-sonnet-4-6']]
// Requests get every schema eagerly and no ToolSearch.
const EAGER_PROVIDERS = [['openrouter', 'deepseek/deepseek-v4-flash'], ['opencode', 'kimi-k2.6'],
  ['opencodego', 'kimi-k2.6'], ['deepseek', 'deepseek-v4-flash'], ['mimo', 'mimo-v2.6-flash'],
  ['alibaba', 'qwen3-coder-plus'], ['fireworks', 'accounts/fireworks/models/kimi-k3'], ['moonshot', 'kimi-k2.6'],
  ['cloudflare', '@cf/qwen/qwen3-30b'], ['mistral', 'mistral-large-4'], ['lxd', 'gpt-5.4'], ['nim', 'qwen/qwen3-coder'],
  ['groq', 'llama-3.1-8b-instant'], ['antigravity', 'gemini-3.8-flash-medium'], ['openai', 'gpt-6-luna'],
  ['kiro', 'claude-sonnet-4.5'], ['kilocode', 'anthropic/claude-sonnet-4.5'], ['cline', 'anthropic/claude-sonnet-4.5'],
  ['agentrouter', 'gpt-5.4'], ['firstParty', 'claude-haiku-4-5'], ['glm', 'glm-4.7'], ['minimax', 'MiniMax-M2.7'],
  ['copilot', 'gpt-4.1'], ['vercel', 'openai/gpt-5.4'], ['requesty', 'openai/gpt-5.4'], ['groq', 'moonshotai/kimi-k2-instruct'],
  ['gemini', 'gemini-2.5-pro'], ['modelrouter', 'gpt-4.1-mini'], ['iflow', 'qwen3-coder-plus']]

test('ToolSearch is offered only where a discovery transport runs for the provider and model', t => {
  t.after(() => r.setSessionPowerMode('normal'))
  const offered = (provider, model) => `${provider} ${model}: ${as(provider, () => r.isToolSearchOfferedForModel(model))}`
  for (const [provider, model] of LAZY) assert.equal(offered(provider, model), `${provider} ${model}: true`)
  for (const [provider, model] of EAGER_PROVIDERS) assert.equal(offered(provider, model), `${provider} ${model}: false`)
  // Cheap mode never defers, on any provider.
  r.setSessionPowerMode('cheap')
  for (const [provider, model] of LAZY) assert.equal(offered(provider, model), `${provider} ${model}: false`)
})

test('workflow guidance names ToolSearch only where requests carry it', () => {
  const tools = new Set(['ProjectWorkflow', 'GitHistorySearch', 'Browser', 'PackageManager', 'VisualDesignAudit'])
  const withSearch = new Set([...tools, 'ToolSearch'])
  for (const [provider, model] of EAGER_PROVIDERS) {
    // ToolSearch in the tool pool does not matter where requests strip it.
    for (const pool of [tools, withSearch]) {
      const section = as(provider, () => r.getUsingYourToolsSection(pool, model))
      assert.doesNotMatch(section, /ToolSearch|named deferred tool/, provider)
      assert.match(section, /call the named tool using its declared schema/, provider)
      assert.match(section, /call ProjectWorkflow/, provider)
    }
  }
  for (const [provider, model] of LAZY) {
    const section = as(provider, () => r.getUsingYourToolsSection(withSearch, model))
    assert.match(section, /load the named deferred tool with ToolSearch/, provider)
    assert.match(section, /load ProjectWorkflow with ToolSearch/, provider)
    // Without ToolSearch in the pool (disallowed), nothing can be loaded.
    assert.doesNotMatch(as(provider, () => r.getUsingYourToolsSection(tools, model)), /ToolSearch/, provider)
  }
})

const tool = (name, deferred = false) => ({
  name, description: `${name} tool`, input_schema: { type: 'object', properties: { value: { type: 'string' } } },
  ...(deferred && { defer_loading: true }),
})

async function compatSystem(provider, model, tools) {
  const lane = new r.OpenAICompatLane()
  lane.registerProvider(provider, 'fixture', 'https://fixture.invalid/v1')
  const bodies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    for await (const _ of lane.streamAsProvider({ model, providerHint: provider, sessionId: `${provider}-wording`,
      querySource: 'repl_main_thread', system: 'Main rules.', messages: [{ role: 'user', content: 'Hi.' }], tools,
      max_tokens: 100, signal: new AbortController().signal })) { /* drain */ }
  } finally {
    globalThis.fetch = realFetch
  }
  const body = bodies.at(-1)
  assert.ok(body, `${provider}: no request was sent`)
  return body.messages.filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : m.content.map(part => part.text ?? '').join('')).join('\n')
}

test('openai-compat rules follow the tools each request carries', async () => {
  const eagerTools = [tool('Read'), tool('WebFetch')]
  for (const [provider, model] of [['deepseek', 'deepseek-v4-flash'], ['mistral', 'mistral-large-4'],
    ['opencode', 'kimi-k2.6'], ['mimo', 'mimo-v2.6-flash'], ['moonshot', 'kimi-k2.6'], ['openrouter', 'deepseek/deepseek-v4-flash'],
    ['glm', 'glm-4.7'], ['minimax', 'MiniMax-M2.7']]) {
    const system = await as(provider, () => compatSystem(provider, model, eagerTools))
    assert.ok(system.includes(r.buildOpenAICompatToolUsageRules(false)), `${provider}: eager rules missing`)
    assert.doesNotMatch(system, /ToolSearch/, provider)
  }
  // A lane that defers keeps the loading rules, byte for byte.
  const ollama = await as('ollama', () => compatSystem('ollama', 'qwen3:8b', [tool('Read'), tool('ToolSearch'), tool('WebFetch', true)]))
  assert.ok(ollama.includes(r.OPENAI_COMPAT_TOOL_USAGE_RULES), 'ollama: loading rules missing')
  assert.match(ollama, new RegExp(LOADING))
})

test('Kilo and Cline rules follow the tools each request carries', () => {
  for (const Lane of [r.KiloLane, r.ClineLane]) {
    const prepend = tools => Lane.prototype._prependToolUsageRules.call(null, 'Main rules.', tools)
    assert.equal(prepend([]), 'Main rules.')
    const eager = prepend([{ name: 'Read' }, { name: 'WebFetch' }])
    assert.ok(eager.includes(EAGER), Lane.name)
    assert.doesNotMatch(eager, /ToolSearch/, Lane.name)
    assert.ok(eager.endsWith('\nMain rules.'), Lane.name)
    assert.match(prepend([{ name: 'Read' }, { name: 'ToolSearch' }]), new RegExp(LOADING), Lane.name)
  }
  assert.match(r.KiloLane.prototype._prependToolUsageRules.call(null, 'x', [{ name: 'Read' }]), /<kilocode_tool_quirks>/)
})
