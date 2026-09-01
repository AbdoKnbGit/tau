/**
 * Run: bun run src/services/api/cacheAffinity.test.ts
 */

import {
  providerUsesStableRequestSession,
  resolveProviderRequestSessionId,
} from './cacheAffinity.js'
import {
  API_PROVIDERS,
  SELECTABLE_PROVIDERS,
} from '../../utils/model/providerRegistry.js'
import type { AgentId } from '../../types/ids.js'
import type { QuerySource } from '../../constants/querySource.js'

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
    }
  })

  await test('routes report through the current root provider session', () => {
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

      assert(
        report === chat,
        `${provider} report session ${report} did not match chat ${chat}`,
      )
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

      assert(report === chat, `${provider}: report route ${report} != chat route ${chat}`)
      assert(retry === report, `${provider}: report retry changed route affinity`)

      if (providerUsesStableRequestSession(provider)) {
        assert(report === rootSessionId, `${provider}: root cache affinity was not preserved`)
      } else {
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
