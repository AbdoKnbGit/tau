/**
 * Run: bun run src/utils/model/agent.test.ts
 */

import {
  resolveAntigravityOpus46AgentModel,
} from './antigravityAgentModel.js'
import {
  isConcreteOpenAIGptModelForProvider,
  selectFreshOpenAIGptModelForProvider,
} from './openaiGptModels.js'
import {
  getRuntimeSkillModel,
  resolveSkillFrontmatterModel,
  shouldHonorSkillModelOverride,
} from './skillModel.js'
import {
  OPENAI_FAST_AGENT_MODEL,
  OPENROUTER_AGENT_MODEL,
  isDirectOpenAIFastAgentParent,
  resolveAgentAliasPolicy,
} from './agentAliasFallback.js'
import type { APIProvider } from './providers.js'

let passed = 0
let failed = 0
const ROUTED_ALIASES = [
  'haiku',
  'sonnet',
  'opus',
  'best',
  'opusplan',
  'sonnet[1m]',
  'opus[1m]',
] as const

function test(name: string, fn: () => void): void {
  try {
    fn()
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

function main(): void {
  console.log('agent model resolver:')

  test('Antigravity inherit remains the exact Claude or Gemini parent', () => {
    for (const parent of ['claude-opus-4-6-thinking', 'gemini-3.1-pro-high']) {
      const omitted = resolveAntigravityOpus46AgentModel(
        undefined,
        parent,
        'antigravity',
      )
      const inherited = resolveAntigravityOpus46AgentModel(
        'inherit',
        parent,
        'antigravity',
      )
      assert(omitted === parent, `${parent}/omitted=${omitted}`)
      assert(inherited === parent, `${parent}/inherit=${inherited}`)
    }
  })

  test('Antigravity aliases always use its Flash-low agent model', () => {
    for (const parent of ['claude-opus-4-6-thinking', 'gemini-3.1-pro-high']) {
      for (const alias of ROUTED_ALIASES) {
        const resolved = resolveAntigravityOpus46AgentModel(
          alias,
          parent,
          'antigravity',
        )
        assert(resolved === 'gemini-3.5-flash-low', `${parent}/${alias}=${resolved}`)
      }
    }
  })

  test('Antigravity concrete model ids are not redirected', () => {
    const resolved = resolveAntigravityOpus46AgentModel(
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'antigravity',
    )
    assert(resolved === null, `model=${resolved}`)
  })

  test('non-Antigravity providers are untouched', () => {
    const resolved = resolveAntigravityOpus46AgentModel(
      'haiku',
      'claude-opus-4-6-thinking',
      'openai',
    )
    assert(resolved === null, `model=${resolved}`)
  })

  test('OpenAI GPT selection helpers remain provider-scoped', () => {
    const concrete = isConcreteOpenAIGptModelForProvider(
      'openai/gpt-5.4',
      'openrouter',
    )
    const fresh = selectFreshOpenAIGptModelForProvider({
      fallback: 'openai/gpt-5.5',
      selected: 'openai/gpt-5.4',
      provider: 'openrouter',
      renderedMainLoopModel: 'openai/gpt-5.5',
    })
    const direct = isConcreteOpenAIGptModelForProvider(
      'gpt-5.4',
      'openai',
    )

    assert(concrete, 'OpenRouter openai/gpt-* should count as concrete GPT')
    assert(fresh === 'openai/gpt-5.4', `fresh=${fresh}`)
    assert(direct, 'direct OpenAI gpt-* should count as concrete GPT')
  })

  test('non-Cursor skill aliases inherit the caller model', () => {
    const openrouter = resolveSkillFrontmatterModel('sonnet', 'openrouter')
    const kiro = resolveSkillFrontmatterModel('gpt-5.4', 'kiro')
    const antigravity = resolveSkillFrontmatterModel(
      'claude-sonnet-4-6',
      'antigravity',
    )

    assert(openrouter === undefined, `openrouter=${openrouter}`)
    assert(kiro === undefined, `kiro=${kiro}`)
    assert(antigravity === undefined, `antigravity=${antigravity}`)
  })

  test('runtime skill models are ignored outside Cursor', () => {
    const openrouter = getRuntimeSkillModel('claude-sonnet-4-6', 'openrouter')
    const kiro = getRuntimeSkillModel('gpt-5.4', 'kiro')

    assert(openrouter === undefined, `openrouter=${openrouter}`)
    assert(kiro === undefined, `kiro=${kiro}`)
  })

  test('Cursor keeps existing skill model override behavior', () => {
    const resolved = getRuntimeSkillModel('sonnet', 'cursor')

    assert(shouldHonorSkillModelOverride('cursor'), 'cursor should be honored')
    assert(resolved === 'sonnet', `model=${resolved}`)
  })

  // ── live provider policy for spawned-agent tier aliases ─────────────

  test('direct OpenAI fast-agent parents cover the requested GPT families', () => {
    for (const parent of [
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5.4',
      'gpt-5.5-pro',
      'gpt-5.6-sol',
      'openai/gpt-5.6-terra',
    ]) {
      assert(isDirectOpenAIFastAgentParent(parent), `parent=${parent}`)
    }
    assert(!isDirectOpenAIFastAgentParent('gpt-5.3-codex'), '5.3 is not in policy')
    assert(!isDirectOpenAIFastAgentParent('o4-mini'), 'o-series is not in policy')
  })

  test('direct OpenAI aliases use native GPT-5.4 mini', () => {
    for (const parent of ['gpt-5.2-codex', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol']) {
      for (const alias of ROUTED_ALIASES) {
        const resolved = resolveAgentAliasPolicy(alias, parent, 'openai')
        assert(resolved === OPENAI_FAST_AGENT_MODEL, `${parent}/${alias}=${resolved}`)
        assert(!resolved.startsWith('openai/'), `OpenAI route was namespaced: ${resolved}`)
      }
    }
  })

  test('other direct OpenAI parents inherit', () => {
    for (const parent of ['gpt-5.3-codex', 'o4-mini', 'custom-openai-model']) {
      const resolved = resolveAgentAliasPolicy('haiku', parent, 'openai')
      assert(resolved === parent, `${parent}=${resolved}`)
    }
  })

  test('OpenRouter always uses the requested free Nemotron for aliases', () => {
    for (const parent of [
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.6',
      'deepseek/deepseek-v4-flash',
      'google/gemini-3.1-pro',
      OPENROUTER_AGENT_MODEL,
    ]) {
      for (const alias of ROUTED_ALIASES) {
        const resolved = resolveAgentAliasPolicy(alias, parent, 'openrouter')
        assert(resolved === OPENROUTER_AGENT_MODEL, `${parent}/${alias}=${resolved}`)
      }
    }
  })

  test('Antigravity always uses its Flash-low agent model for aliases', () => {
    for (const parent of [
      'claude-opus-4-6-thinking',
      'claude-sonnet-4-6',
      'gemini-3.1-pro-high',
      'gemini-3.5-flash-low',
    ]) {
      for (const alias of ROUTED_ALIASES) {
        const resolved = resolveAgentAliasPolicy(alias, parent, 'antigravity')
        assert(resolved === 'gemini-3.5-flash-low', `${parent}/${alias}=${resolved}`)
      }
    }
  })

  test('Anthropic-native providers retain normal tier resolution', () => {
    for (const provider of ['firstParty', 'bedrock', 'vertex', 'foundry'] as const) {
      for (const alias of ROUTED_ALIASES) {
        const resolved = resolveAgentAliasPolicy(alias, 'claude-sonnet-4-6', provider)
        assert(resolved === undefined, `${provider}/${alias}=${resolved}`)
      }
    }
  })

  test('every other provider inherits the exact parent model', () => {
    const cases: Array<[APIProvider, string]> = [
      ['gemini', 'gemini-3.1-pro-preview'],
      ['glm', 'glm-5-turbo'],
      ['copilot', 'claude-sonnet-4.7'],
      ['agentrouter', 'deepseek-v3.2'],
      ['kiro', 'claude-sonnet-4-5'],
      ['cursor', 'composer-2'],
      ['cline', 'minimax-m2.5'],
      ['kilocode', 'qwen3-coder'],
      ['iflow', 'glm-4.7'],
      ['ollama', 'qwen3-coder:30b'],
      ['cloudflare', '@cf/openai/gpt-oss-120b'],
    ]
    for (const [provider, parent] of cases) {
      for (const alias of ROUTED_ALIASES) {
        const resolved = resolveAgentAliasPolicy(alias, parent, provider)
        assert(resolved === parent, `${provider}/${alias}=${resolved}`)
      }
    }
  })

  test('concrete model ids and inherit are outside alias policy', () => {
    for (const spec of [
      'inherit',
      'claude-haiku-4.5',
      'llama3.2:1b',
      'composer-2',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ]) {
      const resolved = resolveAgentAliasPolicy(spec, 'openai/gpt-5.6', 'openrouter')
      assert(resolved === undefined, `${spec} was redirected to ${resolved}`)
    }
  })

  test('alias matching is case and whitespace insensitive', () => {
    const resolved = resolveAgentAliasPolicy(
      '  Haiku  ',
      'deepseek/deepseek-v4-flash',
      'openrouter',
    )
    assert(resolved === OPENROUTER_AGENT_MODEL, `model=${resolved}`)
  })

  test('provider and parent changes are reflected without memoization', () => {
    const first = resolveAgentAliasPolicy(
      'haiku',
      'openai/gpt-5.6',
      'openrouter',
    )
    const second = resolveAgentAliasPolicy('haiku', 'glm-4.7', 'glm')
    const third = resolveAgentAliasPolicy(
      'haiku',
      'anthropic/claude-sonnet-4.6',
      'openrouter',
    )

    assert(first === OPENROUTER_AGENT_MODEL, `first=${first}`)
    assert(second === 'glm-4.7', `second=${second}`)
    assert(third === OPENROUTER_AGENT_MODEL, `third=${third}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
