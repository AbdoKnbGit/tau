import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { transformSync } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Exercise the real cleanup -> section reset -> snapshot reset chain. Only
// unrelated I/O and feature flags are replaced; no user state or API is used.
function load(relativePath, dependencies) {
  const code = transformSync(readFileSync(resolve(root, relativePath), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node20',
  }).code
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, require: () => dependencies, structuredClone,
  }, { filename: relativePath })
  return module.exports
}

function fixture() {
  const noop = () => {}
  const deps = {
    createHash,
    feature: () => false,
    getSessionId: () => 'root-session',
    getUserContext: { cache: { clear: noop } },
    resetGetMemoryFilesCache: noop,
    clearSystemPromptSectionState: noop,
    clearBetaHeaderLatches: noop,
    clearSpeculativeChecks: noop,
    clearClassifierApprovals: noop,
    clearSessionMessagesCache: noop,
    clearBetaTracingState: noop,
    resetMicrocompactState: noop,
  }
  for (const path of [
    'src/services/api/cacheAffinity.ts',
    'src/lanes/openai-compat/openrouter_context.ts',
    'src/lanes/shared/volatile_freeze.ts',
    'src/constants/systemPromptSections.ts',
    'src/services/compact/postCompactCleanup.ts',
  ]) Object.assign(deps, load(path, deps))

  const session = agentId => deps.resolveProviderRequestSessionId({
    provider: 'mistral', rootSessionId: 'root-session', agentId,
    querySource: agentId ? 'agent:builtin:general-purpose' : 'repl_main_thread',
  })
  const key = (agentId, system, route = 'mistral:https://api.mistral.ai/v1', model = 'mistral-large-4', source) =>
    deps.openRouterContextKey(route, model, session(agentId),
      source ?? (agentId ? 'agent:builtin:general-purpose' : 'repl_main_thread'), [], system)
  const tool = (name, description = name) => ({
    type: 'function', function: { name, description, parameters: { type: 'object' } },
  })
  const seed = (agentId, system, route, model) => {
    const k = key(agentId, system, route, model)
    deps.freezeOpenRouterSystem(k, system)
    const tools = deps.freezeOpenRouterTools(k, [tool('B'), tool('A')])
    return { k, system, tools }
  }
  const retained = snapshot => {
    assert.equal(deps.freezeOpenRouterSystem(snapshot.k, 'changed'), snapshot.system)
    assert.equal(JSON.stringify(deps.freezeOpenRouterTools(snapshot.k,
      [tool('A', 'new A'), tool('B', 'new B')])), JSON.stringify(snapshot.tools))
  }
  const refreshed = snapshot => {
    assert.equal(deps.freezeOpenRouterSystem(snapshot.k, 'changed'), 'changed')
    const tools = deps.freezeOpenRouterTools(snapshot.k, [tool('A', 'new A'), tool('B', 'new B')])
    assert.equal(tools.map(t => t.function.name).join(','), 'A,B')
    assert.equal(tools[0].function.description, 'new A')
  }
  return { ...deps, session, key, seed, retained, refreshed }
}

test('worker compaction refreshes only its Mistral snapshots across models and endpoints', () => {
  const f = fixture()
  const main = f.seed(undefined, 'main system')
  const worker = f.seed('worker-a', 'worker A system')
  const sibling = f.seed('worker-b', 'worker B system')
  const workerOtherRoute = f.seed('worker-a', 'other route', 'mistral:https://other.example/v1')
  const workerOtherModel = f.seed('worker-a', 'other model', undefined, 'mistral-large-2512')
  f.runPostCompactCleanup('agent:builtin:general-purpose', 'worker-a')

  // Conversation lookup must survive for the main, and be cleared for the
  // compacted worker. Otherwise its helpers can resurrect a stale snapshot.
  assert.equal(f.key(undefined, 'main system', undefined, undefined, 'prompt_suggestion'), main.k)
  assert.notEqual(f.key('worker-a', 'worker A system', undefined, undefined, 'agent_summary'), worker.k)
  f.retained(main)
  f.retained(sibling)
  for (const snapshot of [worker, workerOtherRoute, workerOtherModel]) f.refreshed(snapshot)
})

test('unknown worker identity, helper compaction, and synthetic fork compaction preserve Mistral parents', () => {
  for (const [source, id] of [
    [undefined, 'worker-a'],
    ['agent:builtin:general-purpose', undefined],
    ['agent:builtin:fork', 'synthetic-fork'],
    ['prompt_suggestion', 'helper'],
    ['compact', 'helper'],
    ['agent_summary', 'helper'],
    // Even if a registered helper uses an agent source, it does not own the
    // snapshot: its private compaction must not reset the parent's prefix.
    ['agent:builtin:general-purpose', 'helper'],
  ]) {
    const f = fixture()
    const main = f.seed(undefined, 'main system')
    const worker = f.seed('worker-a', 'worker system')
    const release = f.registerForkedAgent('helper', 'worker-a')
    try {
      f.runPostCompactCleanup(source, id)
      f.retained(main)
      f.retained(worker)
    } finally { release() }
  }
})

test('main compaction and explicit prompt rebuild still refresh all Mistral snapshots', () => {
  for (const source of [undefined, 'repl_main_thread', 'repl_main_thread:outputStyle:Explanatory', 'sdk']) {
    const f = fixture()
    const main = f.seed(undefined, 'main system')
    const worker = f.seed('worker-a', 'worker system')
    f.runPostCompactCleanup(source)
    f.refreshed(main)
    f.refreshed(worker)
  }
  const f = fixture()
  const main = f.seed(undefined, 'mode before')
  f.clearSystemPromptSections()
  f.refreshed(main)
})

test('background cleanup preserves existing reset behavior for other providers', () => {
  const f = fixture()
  const main = f.seed(undefined, 'Mistral main')
  const native = f.seed(undefined, 'OpenRouter native', 'native')
  const legacy = f.seed(undefined, 'OpenRouter legacy', 'legacy')
  f.freezeSessionVolatileText('deepseek:fixture', 'old environment')
  f.runPostCompactCleanup('agent:builtin:general-purpose', 'worker-a')
  f.retained(main)
  f.refreshed(native)
  f.refreshed(legacy)
  assert.equal(f.freezeSessionVolatileText('deepseek:fixture', 'new environment'), 'new environment')
})
