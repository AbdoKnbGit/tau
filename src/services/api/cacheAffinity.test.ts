/**
 * Run: bun run src/services/api/cacheAffinity.test.ts
 */

import {
  providerUsesStableRequestSession,
  registerForkedAgent,
  resolveProviderRequestSessionId,
} from './cacheAffinity.js'
import {
  API_PROVIDERS,
  SELECTABLE_PROVIDERS,
} from '../../utils/model/providerRegistry.js'
import type { AgentId } from '../../types/ids.js'
import type { QuerySource } from '../../constants/querySource.js'
import { runWithForcedProvider } from '../../utils/forcedProvider.js'
import { resolveEffectiveAPIProvider } from './providerRouting.js'
import {
  freezeOpenRouterSystem,
  openRouterContextKey,
  resetOpenRouterContext,
} from '../../lanes/openai-compat/openrouter_context.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

async function main(): Promise<void> {
  console.log('provider cache affinity:')

  await test('keeps the root Antigravity session for main-thread calls', () => {
    const sessionId = resolveProviderRequestSessionId({
      provider: 'antigravity',
      rootSessionId: 'root-session',
      querySource: 'repl_main_thread',
    })

    assert(sessionId === 'root-session', `sessionId=${sessionId}`)
  })

  await test('keeps the root Antigravity session for fork agents', () => {
    const sessionId = resolveProviderRequestSessionId({
      provider: 'antigravity',
      rootSessionId: 'root-session',
      agentId: 'agent-fork' as AgentId,
      querySource: 'agent:builtin:fork' as QuerySource,
    })

    assert(sessionId === 'root-session', `sessionId=${sessionId}`)
  })

  await test('derives stable per-agent Antigravity sessions for fresh subagents', () => {
    const a = resolveProviderRequestSessionId({
      provider: 'antigravity',
      rootSessionId: 'root-session',
      agentId: 'agent-a' as AgentId,
      querySource: 'agent:builtin:general-purpose' as QuerySource,
    })
    const aAgain = resolveProviderRequestSessionId({
      provider: 'antigravity',
      rootSessionId: 'root-session',
      agentId: 'agent-a' as AgentId,
      querySource: 'agent:builtin:general-purpose' as QuerySource,
    })
    const b = resolveProviderRequestSessionId({
      provider: 'antigravity',
      rootSessionId: 'root-session',
      agentId: 'agent-b' as AgentId,
      querySource: 'agent:builtin:general-purpose' as QuerySource,
    })

    assert(a === aAgain, `unstable sessionId: ${a} vs ${aAgain}`)
    assert(a !== 'root-session', `fresh subagent reused root session: ${a}`)
    assert(a !== b, `subagents collided: ${a}`)
    assert(typeof a === 'string' && a.startsWith('tau-agent-'), `sessionId=${a}`)
  })

  await test('forwards the root session for main-thread cache-aware provider calls', () => {
    const providers = [
      'copilot',
      'openrouter',
      'agentrouter',
      'opencode',
      'opencodego',
      'moonshot',
      'mistral',
      'fireworks',
    ] as const

    for (const provider of providers) {
      const sessionId = resolveProviderRequestSessionId({
        provider: provider as any,
        rootSessionId: 'root-session',
        agentId: 'agent-a' as AgentId,
        querySource: 'repl_main_thread',
      })
      assert(sessionId === 'root-session', `${provider} sessionId=${sessionId}`)
    }
  })

  await test('derives stable OpenRouter sessions for side-query sources', () => {
    const a = resolveProviderRequestSessionId({
      provider: 'openrouter',
      rootSessionId: 'root-session',
      querySource: 'generate_session_title' as QuerySource,
    })
    const aAgain = resolveProviderRequestSessionId({
      provider: 'openrouter',
      rootSessionId: 'root-session',
      querySource: 'generate_session_title' as QuerySource,
    })
    const b = resolveProviderRequestSessionId({
      provider: 'openrouter',
      rootSessionId: 'root-session',
      querySource: 'model_validation' as QuerySource,
    })

    assert(a === aAgain, `unstable sessionId: ${a} vs ${aAgain}`)
    assert(a !== 'root-session', `side query reused root session: ${a}`)
    assert(a !== b, `side query sources collided: ${a}`)
    assert(typeof a === 'string' && a.startsWith('tau-query-'), `sessionId=${a}`)
  })

  await test('derives stable OpenRouter sessions for fresh subagents', () => {
    const a = resolveProviderRequestSessionId({
      provider: 'openrouter',
      rootSessionId: 'root-session',
      agentId: 'agent-a' as AgentId,
      querySource: 'agent:builtin:general-purpose' as QuerySource,
    })
    const b = resolveProviderRequestSessionId({
      provider: 'openrouter',
      rootSessionId: 'root-session',
      agentId: 'agent-b' as AgentId,
      querySource: 'agent:builtin:general-purpose' as QuerySource,
    })
    const fork = resolveProviderRequestSessionId({
      provider: 'openrouter',
      rootSessionId: 'root-session',
      agentId: 'agent-fork' as AgentId,
      querySource: 'agent:builtin:fork' as QuerySource,
    })

    assert(a !== 'root-session', `fresh subagent reused root session: ${a}`)
    assert(a !== b, `subagents collided: ${a}`)
    assert(typeof a === 'string' && a.startsWith('tau-agent-'), `sessionId=${a}`)
    assert(fork === 'root-session', `fork sessionId=${fork}`)
  })

  await test('keeps OpenRouter forked helpers on the session of the conversation they fork', () => {
    const resolve = (agentId: string | undefined, querySource: string) => resolveProviderRequestSessionId({
      provider: 'openrouter',
      rootSessionId: 'root-session',
      ...(agentId && { agentId: agentId as AgentId }),
      querySource: querySource as QuerySource,
    })
    // Same session_id, prompt_cache_key and provider pin as the main thread.
    const release = registerForkedAgent('fork-main' as AgentId, undefined)
    try {
      for (const querySource of ['prompt_suggestion', 'compact', 'extract_memories', 'side_question']) {
        const sessionId = resolve('fork-main', querySource)
        assert(sessionId === 'root-session', `${querySource} left the root: ${sessionId}`)
      }
    } finally {
      release()
    }
    // A fork of a subagent stays on that subagent's session.
    const agent = resolve('agent-a', 'agent:builtin:general-purpose')
    const releaseFork = registerForkedAgent('fork-a' as AgentId, 'agent-a' as AgentId)
    try {
      assert(resolve('fork-a', 'compact') === agent, 'subagent compaction left the subagent session')
    } finally {
      releaseFork()
    }
    // Everything else keeps its own session: agents, hook agents, side queries.
    assert(agent !== 'root-session' && agent!.startsWith('tau-agent-'), `agent=${agent}`)
    assert(resolve('hook-1', 'hook_agent')!.startsWith('tau-agent-'), 'hook agent lost its own session')
    assert(resolve(undefined, 'generate_session_title')!.startsWith('tau-query-'), 'side query lost its own session')
  })

  await test('gives each Codex (openai) subagent a stable session of its own', () => {
    const resolve = (agentId: string | undefined, querySource: string) => resolveProviderRequestSessionId({
      provider: 'openai',
      rootSessionId: 'root-session',
      ...(agentId && { agentId: agentId as AgentId }),
      querySource: querySource as QuerySource,
    })
    const a = resolve('agent-a', 'agent:builtin:general-purpose')
    assert(typeof a === 'string' && a.startsWith('tau-agent-'), `sessionId=${a}`)
    // A SendMessage resume runs under the same agent id: same session, same
    // frozen env block, same cache routing.
    assert(a === resolve('agent-a', 'agent:custom'), `resume changed the session: ${a}`)
    assert(a !== resolve('agent-b', 'agent:builtin:general-purpose'), 'subagents collided')
    // Forks reuse the parent's prefix on purpose; the main thread and its
    // side queries keep the root.
    assert(resolve('agent-fork', 'agent:builtin:fork') === 'root-session', 'fork left the root')
    assert(resolve('agent-a', 'repl_main_thread') === 'root-session', 'main thread left the root')
    assert(resolve(undefined, 'compact') === 'root-session', 'main compaction left the root')
    // A hook agent is no conversation agent: it keeps the root.
    assert(resolve('hook-1', 'hook_agent') === 'root-session', 'hook agent left the root')
  })

  await test('isolates Mistral agent identities while preserving resume and root policies', () => {
    const resolve = (agentId: string | undefined, querySource: string, rootSessionId = 'mistral-root') => resolveProviderRequestSessionId({
      provider: 'mistral',
      rootSessionId,
      ...(agentId && { agentId: agentId as AgentId }),
      querySource: querySource as QuerySource,
    })
    const agent = resolve('mistral-a', 'agent:builtin:general-purpose')
    assert(agent?.startsWith('tau-agent-'), `agent=${agent}`)
    assert(agent !== resolve('mistral-b', 'agent:builtin:general-purpose'), 'independent agents collided')
    assert(agent === resolve('mistral-a', 'agent:custom'), 'resume changed agent identity')
    assert(agent !== resolve('mistral-a', 'agent:custom', 'another-root'), 'sessions collided')
    assert(resolve('fork-child', 'agent:builtin:fork') === 'mistral-root', 'synthetic fork left root')
    assert(resolve('mistral-a', 'repl_main_thread') === 'mistral-root', 'main thread left root')
    assert(resolve('mistral-a', 'sdk') === 'mistral-root', 'SDK left root')
    assert(resolve('hook-a', 'hook_agent') === 'mistral-root', 'unregistered helper policy changed')
    assert(resolve(undefined, 'generate_session_title') === 'mistral-root', 'side-query policy changed')
    assert(resolve('mistral-a', 'agent:custom', '   ') === undefined, 'empty root gained an identity')
  })

  await test('keeps Mistral registered helpers on their main or agent conversation through nested forks', () => {
    const resolve = (agentId: string, querySource: string) => resolveProviderRequestSessionId({
      provider: 'mistral',
      rootSessionId: 'mistral-root',
      agentId: agentId as AgentId,
      querySource: querySource as QuerySource,
    })
    const releaseMain = registerForkedAgent('mistral-main-helper' as AgentId, undefined)
    const releaseMainNested = registerForkedAgent('mistral-main-nested' as AgentId, 'mistral-main-helper' as AgentId)
    const releaseAgent = registerForkedAgent('mistral-agent-helper' as AgentId, 'mistral-a' as AgentId)
    const releaseNested = registerForkedAgent('mistral-agent-nested' as AgentId, 'mistral-agent-helper' as AgentId)
    const agent = resolve('mistral-a', 'agent:builtin:general-purpose')
    try {
      for (const source of ['prompt_suggestion', 'agent_summary', 'compact', 'session_memory', 'side_question']) {
        assert(resolve('mistral-main-helper', source) === 'mistral-root', `${source} main helper left root`)
        assert(resolve('mistral-main-nested', source) === 'mistral-root', `${source} nested main helper left root`)
        assert(resolve('mistral-agent-helper', source) === agent, `${source} helper left its agent`)
        assert(resolve('mistral-agent-nested', source) === agent, `${source} nested helper left its agent`)
      }
    } finally {
      releaseNested()
      releaseAgent()
      releaseMainNested()
      releaseMain()
    }
    assert(resolve('mistral-agent-helper', 'compact') === 'mistral-root', 'released helper kept stale affinity')
  })

  await test('Mistral same-type agents keep distinct frozen system prompts and helpers reuse the right snapshot', () => {
    resetOpenRouterContext()
    const resolve = (agentId: string, querySource: string) => resolveProviderRequestSessionId({
      provider: 'mistral',
      rootSessionId: 'mistral-snapshot-root',
      agentId: agentId as AgentId,
      querySource: querySource as QuerySource,
    })
    const key = (agentId: string, querySource: string, system: string) => openRouterContextKey(
      'mistral:https://api.mistral.ai/v1', 'mistral-large-2512',
      resolve(agentId, querySource), querySource, [], system,
    )
    const release = registerForkedAgent('mistral-snapshot-helper' as AgentId, 'mistral-snapshot-a' as AgentId)
    try {
      const a = key('mistral-snapshot-a', 'agent:builtin:general-purpose', 'Agent A working directory')
      assert(freezeOpenRouterSystem(a, 'Agent A working directory') === 'Agent A working directory', 'agent A system changed')
      const b = key('mistral-snapshot-b', 'agent:builtin:general-purpose', 'Agent B working directory')
      assert(a !== b, 'same-type agents shared a frozen snapshot')
      assert(freezeOpenRouterSystem(b, 'Agent B working directory') === 'Agent B working directory', 'agent B received agent A system')
      const helper = key('mistral-snapshot-helper', 'agent_summary', 'Agent A working directory')
      assert(helper === a, 'agent A helper followed the newest agent instead of its parent')
      assert(freezeOpenRouterSystem(helper, 'Agent A working directory') === 'Agent A working directory', 'agent A helper received another system')
      assert(key('mistral-snapshot-a', 'agent:builtin:general-purpose', 'Agent A working directory') === a, 'resumed agent lost its snapshot')
    } finally {
      release()
      resetOpenRouterContext()
    }
  })

  await test('Mistral synthetic-root-fork summaries retain root affinity, including nested helpers', () => {
    const resolve = (provider: 'mistral' | 'openai' | 'openrouter', agentId: string, querySource: string) => resolveProviderRequestSessionId({
      provider,
      rootSessionId: 'synthetic-root',
      agentId: agentId as AgentId,
      querySource: querySource as QuerySource,
    })
    const releaseSummary = registerForkedAgent(
      'synthetic-summary' as AgentId,
      'synthetic-fork' as AgentId,
      'agent:builtin:fork' as QuerySource,
    )
    const releaseNested = registerForkedAgent('synthetic-nested' as AgentId, 'synthetic-summary' as AgentId)
    try {
      assert(resolve('mistral', 'synthetic-fork', 'agent:builtin:fork') === 'synthetic-root', 'synthetic fork changed policy')
      assert(resolve('mistral', 'synthetic-summary', 'agent_summary') === 'synthetic-root', 'synthetic fork summary started cold')
      assert(resolve('mistral', 'synthetic-nested', 'compact') === 'synthetic-root', 'nested synthetic fork helper started cold')
      // The new parent-source metadata must not change another provider's
      // established routing. Only Mistral consumes it.
      for (const provider of ['openai', 'openrouter'] as const) {
        const existingOwner = resolve(provider, 'synthetic-fork', 'agent:builtin:general-purpose')
        assert(resolve(provider, 'synthetic-summary', 'agent_summary') === existingOwner, `${provider} routing changed`)
      }
    } finally {
      releaseNested()
      releaseSummary()
    }
  })

  await test('keeps Codex (openai) forked helpers on the cache of the conversation they fork', () => {
    const resolve = (agentId: string, querySource: string) => resolveProviderRequestSessionId({
      provider: 'openai',
      rootSessionId: 'root-session',
      agentId: agentId as AgentId,
      querySource: querySource as QuerySource,
    })
    // Every helper run gets a new agentId (runForkedAgent). On the main
    // thread's cache it reads the whole prefix; on an id of its own it would
    // start cold every run.
    const helpers = ['prompt_suggestion', 'speculation', 'extract_memories', 'session_memory', 'away_summary', 'compact', 'side_question', 'auto_dream']
    for (const querySource of helpers) {
      const release = registerForkedAgent('fork-main' as AgentId, undefined)
      try {
        const sessionId = resolve('fork-main', querySource)
        assert(sessionId === 'root-session', `${querySource} left the root: ${sessionId}`)
      } finally {
        release()
      }
    }
    // A fork of a subagent (its compaction, its progress summary) reads the
    // subagent's cache, also through a fork of that fork.
    const agent = resolve('agent-a', 'agent:builtin:general-purpose')
    const releaseFork = registerForkedAgent('fork-a' as AgentId, 'agent-a' as AgentId)
    const releaseNested = registerForkedAgent('fork-a2' as AgentId, 'fork-a' as AgentId)
    try {
      assert(resolve('fork-a', 'compact') === agent, 'subagent compaction left the subagent cache')
      assert(resolve('fork-a', 'agent_summary') === agent, 'agent summary left the subagent cache')
      assert(resolve('fork-a2', 'compact') === agent, 'nested fork left the subagent cache')
    } finally {
      releaseNested()
      releaseFork()
    }
    // Once released, a stale helper id falls back to the root, never to a
    // cold session of its own.
    assert(resolve('fork-a', 'compact') === 'root-session', 'released fork kept a session')
    // A fork that keeps its parent's id is that parent.
    const releaseSame = registerForkedAgent('agent-a' as AgentId, 'agent-a' as AgentId)
    try {
      assert(resolve('agent-a', 'agent:custom') === agent, 'self-registered agent lost its session')
    } finally {
      releaseSame()
    }
  })

  await test('keeps non-OpenRouter cache-aware side calls on the root session', () => {
    const sessionId = resolveProviderRequestSessionId({
      provider: 'fireworks',
      rootSessionId: 'root-session',
      querySource: 'generate_session_title' as QuerySource,
    })

    assert(sessionId === 'root-session', `sessionId=${sessionId}`)
  })

  await test('keeps root-policy Antigravity calls on the live session even with an agent id', () => {
    for (const querySource of [
      'repl_main_thread',
      'sdk',
      'report',
      'agent:builtin:fork',
    ] as const) {
      const sessionId = resolveProviderRequestSessionId({
        provider: 'antigravity',
        rootSessionId: 'root-session',
        agentId: 'preserved-parent-agent' as AgentId,
        querySource: querySource as QuerySource,
      })

      assert(
        sessionId === 'root-session',
        `${querySource} derived a separate Antigravity session: ${sessionId}`,
      )
    }
  })

  await test('keeps report retry affinity stable on cache-aware providers', () => {
    for (const provider of ['antigravity', 'openrouter', 'fireworks'] as const) {
      const first = resolveProviderRequestSessionId({
        provider,
        rootSessionId: 'root-session',
        querySource: 'report' as QuerySource,
      })
      const retry = resolveProviderRequestSessionId({
        provider,
        rootSessionId: 'root-session',
        querySource: 'report' as QuerySource,
      })

      assert(typeof first === 'string' && first.length > 0, `${provider} affinity missing`)
      assert(first === retry, `${provider} report retry changed affinity`)
      if (provider === 'antigravity') {
        assert(first === 'root-session', `${provider} report left the live session: ${first}`)
      } else {
        assert(first.startsWith('tau-query-'), `${provider} report was not isolated: ${first}`)
      }
    }
  })

  await test('reuses the live Antigravity session while isolating other report providers', () => {
    for (const provider of [
      'antigravity',
      'openrouter',
      'openai',
      'fireworks',
    ] as const) {
      const chat = resolveProviderRequestSessionId({
        provider,
        rootSessionId: 'current-provider-session',
        querySource: 'repl_main_thread' as QuerySource,
      })
      const report = resolveProviderRequestSessionId({
        provider,
        rootSessionId: 'current-provider-session',
        querySource: 'report' as QuerySource,
      })

      if (provider === 'antigravity') {
        assert(report === chat, `${provider} report session ${report} did not match chat ${chat}`)
      } else {
        assert(
          report !== chat && report?.startsWith('tau-query-'),
          `${provider} report session ${report} was not isolated from chat ${chat}`,
        )
      }
    }
  })

  await test('uses Antigravity report affinity after model/provider auto-routing', () => {
    const effectiveProvider = resolveEffectiveAPIProvider(
      'openai',
      'gemini-3.7-flash-high',
    )
    const report = resolveProviderRequestSessionId({
      provider: effectiveProvider,
      rootSessionId: 'auto-routed-root-session',
      querySource: 'report' as QuerySource,
    })

    assert(effectiveProvider === 'antigravity', `effective provider=${effectiveProvider}`)
    assert(report === 'auto-routed-root-session', `report session=${report}`)
  })

  await test('keeps every explicit provider pinned during model routing', () => {
    // Parity guard for the helper extracted out of client.ts: exactly the
    // providers the old _autoCorrectProvider() could rewrite still get
    // rewritten, and no others. Changing this set is a routing change.
    const routableProviders = new Set([
      'openai',
      'gemini',
      'fireworks',
      'cloudflare',
      'clinepass',
    ])
    for (const provider of API_PROVIDERS) {
      const routed = resolveEffectiveAPIProvider(provider, 'gemini-3.7-flash-high')
      const expected = routableProviders.has(provider) ? 'antigravity' : provider
      assert(routed === expected, `${provider}: routed unexpectedly to ${routed}`)
    }

    // Cross-domain correction stays scoped to the two legacy rows.
    assert(
      resolveEffectiveAPIProvider('openai', 'gemini-2.5-pro') === 'gemini',
      'openai did not correct a Gemini model',
    )
    assert(
      resolveEffectiveAPIProvider('gemini', 'gpt-5.4') === 'openai',
      'gemini did not correct an OpenAI model',
    )
    assert(
      resolveEffectiveAPIProvider('fireworks', 'gemini-2.5-pro') === 'fireworks',
      'fireworks lost its own Gemini-named model',
    )

    const forced = runWithForcedProvider({ provider: 'openai' }, () =>
      resolveEffectiveAPIProvider('openai', 'gemini-3.7-flash-high'))
    assert(forced === 'openai', `forced OpenAI request was routed to ${forced}`)
  })

  await test('gives Cline requests the stable session sent as X-Task-ID', () => {
    for (const provider of ['cline', 'clinepass'] as const) {
      assert(providerUsesStableRequestSession(provider), `${provider} has no stable session`)
      const chat = resolveProviderRequestSessionId({
        provider,
        rootSessionId: 'root-session',
        querySource: 'repl_main_thread' as QuerySource,
      })
      assert(chat === 'root-session', `${provider}: chat session=${chat}`)
    }
  })

  await test('does not add affinity keys for providers that do not use them', () => {
    const sessionId = resolveProviderRequestSessionId({
      provider: 'gemini',
      rootSessionId: 'root-session',
      agentId: 'agent-a' as AgentId,
      querySource: 'agent:builtin:general-purpose' as QuerySource,
    })

    assert(sessionId === undefined, `sessionId=${sessionId}`)
  })

  await test('keeps report routing and cache affinity correct for every provider', () => {
    const rootSessionId = 'provider-contract-root'
    const allProviders = new Set(API_PROVIDERS)

    assert(allProviders.size === API_PROVIDERS.length, 'provider registry contains duplicates')
    assert(
      SELECTABLE_PROVIDERS.every(provider => allProviders.has(provider)),
      'selectable provider is missing from the canonical registry',
    )

    for (const provider of API_PROVIDERS) {
      const chat = resolveProviderRequestSessionId({
        provider,
        rootSessionId,
        querySource: 'repl_main_thread' as QuerySource,
      })
      const report = resolveProviderRequestSessionId({
        provider,
        rootSessionId,
        agentId: 'preserved-parent-agent' as AgentId,
        querySource: 'report' as QuerySource,
      })
      const retry = resolveProviderRequestSessionId({
        provider,
        rootSessionId,
        agentId: 'preserved-parent-agent' as AgentId,
        querySource: 'report' as QuerySource,
      })

      assert(retry === report, `${provider}: report retry changed route affinity`)

      if (providerUsesStableRequestSession(provider)) {
        assert(chat === rootSessionId, `${provider}: chat root affinity was not preserved`)
        if (provider === 'antigravity') {
          assert(report === rootSessionId, `${provider}: report left the live session`)
        } else {
          assert(
            report !== rootSessionId && report?.startsWith('tau-query-'),
            `${provider}: report cache affinity was not isolated`,
          )
        }
      } else {
        assert(chat === undefined, `${provider}: unsupported chat affinity key was injected`)
        assert(report === undefined, `${provider}: unsupported affinity key was injected`)
      }
    }

    console.log(
      `      verified ${API_PROVIDERS.length} total providers (${SELECTABLE_PROVIDERS.length} selectable)`,
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
