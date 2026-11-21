import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { transformSync } from 'esbuild'

// Where the request session pins requests to the server holding their prompt
// cache, a hook (a prompt hook's check, an agent hook) gets a session per hook
// kind, apart from the conversation's: on Mistral a Stop check sent beside an
// agent hook on the conversation's key missed its cache. Everything else keeps
// the session it had.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const code = transformSync(readFileSync(resolve(root, 'src/services/api/cacheAffinity.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node20',
}).code
const module = { exports: {} }
runInNewContext(code, { module, exports: module.exports, require: () => ({ createHash }) }, { filename: 'cacheAffinity.ts' })
const affinity = module.exports

const ROOT = 'root-session'
const session = (provider, querySource, agentId) =>
  affinity.resolveProviderRequestSessionId({ provider, rootSessionId: ROOT, agentId, querySource })
const PINNING = ['mistral', 'xai', 'fireworks', 'cloudflare', 'lxd', 'openrouter']
const SUBAGENT = 'aagent00000000001'
const HOOK_RUNS = ['hook-agent-0000-run1', 'hook-agent-0000-run2']

test('on providers that pin a session to a server, the main thread\'s hooks have a session per hook kind', () => {
  for (const provider of PINNING) {
    const check = session(provider, 'hook_prompt')
    const agents = new Set([undefined, SUBAGENT, ...HOOK_RUNS].map(agentId => session(provider, 'hook_agent', agentId)))
    assert.equal(agents.size, 1, `${provider}: every agent hook run shares one session`)
    const [agent] = agents
    assert.notEqual(check, ROOT, `${provider}: not the conversation's session`)
    assert.notEqual(agent, ROOT, `${provider}: not the conversation's session`)
    assert.notEqual(check, agent, `${provider}: prompt checks and agent hooks apart`)
  }
})

// A subagent's Stop or PostToolBatch check carries the subagent's conversation
// and tools. On the main thread's check session it shared a frozen tool list
// with the main thread's checks and reordered it (OpenRouter, Mistral).
test('a subagent\'s checks keep the subagent\'s session, apart from the main thread\'s checks', () => {
  for (const provider of PINNING) {
    const subagentCheck = session(provider, 'hook_prompt', SUBAGENT)
    assert.notEqual(subagentCheck, session(provider, 'hook_prompt'), `${provider}: apart from the main thread's checks`)
    assert.notEqual(subagentCheck, ROOT, `${provider}: apart from the conversation`)
    assert.equal(subagentCheck, session(provider, 'hook_prompt', SUBAGENT), `${provider}: stable`)
  }
  // On providers that give a subagent a session of its own, it is that session.
  for (const provider of ['mistral', 'xai', 'openrouter']) {
    assert.equal(session(provider, 'hook_prompt', SUBAGENT), session(provider, 'agent:builtin:general-purpose', SUBAGENT), provider)
  }
})

test('the conversation and its forks keep the root session on those providers', () => {
  for (const provider of PINNING) {
    for (const querySource of ['repl_main_thread', 'sdk', 'agent:builtin:fork']) {
      assert.equal(session(provider, querySource), ROOT, `${provider} ${querySource}`)
    }
  }
})

test('providers whose session also groups, dedups or does not pin requests keep what hooks had', () => {
  for (const provider of ['openai', 'copilot', 'cline', 'antigravity', 'deepseek', 'glm', 'moonshot', 'agentrouter']) {
    assert.equal(session(provider, 'hook_prompt'), ROOT, `${provider}: a check from the main thread`)
  }
  // Antigravity still gives an agent hook's own agent the session it had.
  assert.notEqual(session('antigravity', 'hook_agent', 'hook-agent-0000-run1'), session('antigravity', 'hook_agent', 'hook-agent-0000-run2'))
  // A provider without a stable request session gets none, hooks included.
  assert.equal(session('firstParty', 'hook_prompt'), undefined)
})
