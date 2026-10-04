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
  OPENAI_AGENT_MODEL,
  OPENROUTER_AGENT_MODEL,
  isOpenAIAgentAliasParent,
  pinnedAgentModelOutranksAlias,
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

  test('Antigravity subagents with no model of their own get the family agent model', () => {
    for (const spec of [undefined, 'inherit']) {
      for (const parent of ['gemini-3.8-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.6-flash-low', 'gemini-3.1-pro-high']) {
        for (const plan of ['free-tier', 'g1-pro-tier', 'g1-ultra-tier', null]) {
          const model = resolveAntigravityOpus46AgentModel(spec, parent, 'antigravity', plan)
          assert(model === 'gemini-3.7-flash-low', `${plan} ${parent}/${spec}=${model}`)
        }
      }
      for (const parent of ['claude-opus-5-5-medium', 'claude-opus-5-5-high', 'claude-sonnet-5-5-high', 'claude-sonnet-5-5-low']) {
        for (const plan of ['g1-pro-tier', 'g1-ultra-tier', null]) {
          const model = resolveAntigravityOpus46AgentModel(spec, parent, 'antigravity', plan)
          assert(model === 'claude-sonnet-5-5-low', `${plan} ${parent}/${spec}=${model}`)
        }
      }
      for (const parent of ['claude-opus-4-6-thinking', 'claude-sonnet-4-6']) {
        const model = resolveAntigravityOpus46AgentModel(spec, parent, 'antigravity', 'free-tier')
        assert(model === 'claude-sonnet-4-6', `free ${parent}/${spec}=${model}`)
      }
    }
  })

  test('Antigravity explicit model ids are honoured on either family', () => {
    for (const explicit of ['claude-opus-5-5-high', 'gemini-3.8-flash-high', 'claude-sonnet-4-6']) {
      for (const parent of ['claude-opus-5-5-medium', 'gemini-3.8-flash-high']) {
        const model = resolveAntigravityOpus46AgentModel(explicit, parent, 'antigravity', 'g1-pro-tier')
        assert(model === null, `${parent}/${explicit} was redirected to ${model}`)
      }
    }
  })

  test('Antigravity aliases from a Gemini parent use its fast agent model', () => {
    for (const alias of ROUTED_ALIASES) {
      for (const plan of [null, 'free-tier', 'g1-pro-tier']) {
        const resolved = resolveAntigravityOpus46AgentModel(alias, 'gemini-3.1-pro-high', 'antigravity', plan)
        assert(resolved === 'gemini-3.7-flash-low', `${plan}/${alias}=${resolved}`)
      }
    }
  })

  test('Antigravity aliases from a Claude parent follow the plan', () => {
    for (const alias of ROUTED_ALIASES) {
      for (const parent of ['claude-opus-4-6-thinking', 'claude-opus-5-5-high', 'claude-sonnet-5-5-medium']) {
        const paid = resolveAntigravityOpus46AgentModel(alias, parent, 'antigravity', 'g1-pro-tier')
        const ultra = resolveAntigravityOpus46AgentModel(alias, parent, 'antigravity', 'g1-ultra-tier')
        const free = resolveAntigravityOpus46AgentModel(alias, parent, 'antigravity', 'free-tier')
        assert(paid === 'claude-sonnet-5-5-low', `pro ${parent}/${alias}=${paid}`)
        assert(ultra === 'claude-sonnet-5-5-low', `ultra ${parent}/${alias}=${ultra}`)
        assert(free === 'claude-sonnet-4-6', `free ${parent}/${alias}=${free}`)
      }
      // Plan not discovered yet: a 5.5 parent implies a paid plan.
      const unknown55 = resolveAntigravityOpus46AgentModel(alias, 'claude-opus-5-5-high', 'antigravity', null)
      const unknown46 = resolveAntigravityOpus46AgentModel(alias, 'claude-sonnet-4-6', 'antigravity', null)
      assert(unknown55 === 'claude-sonnet-5-5-low', `unknown 5.5/${alias}=${unknown55}`)
      assert(unknown46 === 'claude-sonnet-4-6', `unknown 4.6/${alias}=${unknown46}`)
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

  test('direct OpenAI agent-alias parents cover every GPT-5-or-later family', () => {
    for (const parent of [
      'gpt-5',
      'gpt-5-codex',
      'gpt-5.2',
      'gpt-5.3-codex',
      'gpt-5.4',
      'gpt-5.5-pro',
      'gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-6-astra',
    ]) {
      assert(isOpenAIAgentAliasParent(parent), `parent=${parent}`)
    }
    for (const parent of ['o4-mini', 'gpt-4.1', 'gpt-oss-120b', 'my-azure-deployment']) {
      assert(!isOpenAIAgentAliasParent(parent), `${parent} is not in policy`)
    }
  })

  test('direct OpenAI aliases all use GPT-5.6 Luna, whatever GPT parent runs', () => {
    assert(OPENAI_AGENT_MODEL === 'gpt-5.6-luna', `agent model=${OPENAI_AGENT_MODEL}`)
    for (const parent of ['gpt-5.2-codex', 'gpt-5.6-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna']) {
      for (const alias of ROUTED_ALIASES) {
        const resolved = resolveAgentAliasPolicy(alias, parent, 'openai')
        assert(resolved === OPENAI_AGENT_MODEL, `${parent}/${alias}=${resolved}`)
        assert(!resolved.startsWith('openai/'), `OpenAI route was namespaced: ${resolved}`)
      }
    }
  })

  test('other direct OpenAI parents inherit', () => {
    for (const parent of ['o4-mini', 'gpt-4.1', 'custom-openai-model']) {
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

  test('Antigravity aliases: Gemini parents get the fast agent model, Claude parents stay on Claude', () => {
    // No plan discovered in tests, so the parent's generation decides.
    const expected: Array<[string, string]> = [
      ['claude-opus-4-6-thinking', 'claude-sonnet-4-6'],
      ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
      ['claude-opus-5-5-high', 'claude-sonnet-5-5-low'],
      ['gemini-3.1-pro-high', 'gemini-3.7-flash-low'],
      ['gemini-3.5-flash-low', 'gemini-3.7-flash-low'],
    ]
    for (const [parent, model] of expected) {
      for (const alias of ROUTED_ALIASES) {
        const resolved = resolveAgentAliasPolicy(alias, parent, 'antigravity')
        assert(resolved === model, `${parent}/${alias}=${resolved}`)
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

  // A pinned agent keeps its own model when the spawning model guesses a tier.
  // Regression: the Agent tool schema offers `model` for every agent, so an
  // LLM passes `haiku` to a provider-pinned agent without knowing it is
  // pinned. The alias then resolved either to the parent session model (a 404
  // on the pinned lane) or to the provider's own fixed agent model. Either
  // way the user's pin was discarded.
  const PINNED: Array<[APIProvider, string]> = [
    ['fireworks', 'accounts/fireworks/models/deepseek-v4-flash-0731'],
    ['ollama', 'llama4:70b'],
    ['moonshot', 'kimi-k2.6'],
    ['openai', 'gpt-5.6'],
    ['openrouter', 'qwen/qwen3-max'],
    ['antigravity', 'gemini-3-pro-high'],
    ['firstParty', 'claude-opus-4-6'],
  ]

  test('a tier alias never displaces a pinned agent model', () => {
    for (const [provider, model] of PINNED) {
      for (const alias of ROUTED_ALIASES) {
        assert(
          pinnedAgentModelOutranksAlias(alias, model, provider),
          `${provider}/${model} lost the pin to ${alias}`,
        )
      }
    }
  })

  test('a concrete model id from the caller still overrides the pin', () => {
    for (const [provider, model] of PINNED) {
      assert(
        !pinnedAgentModelOutranksAlias('kimi-k2.6', model, provider),
        `${provider} refused a concrete override`,
      )
      assert(
        !pinnedAgentModelOutranksAlias(
          'accounts/fireworks/models/glm-5',
          model,
          provider,
        ),
        `${provider} refused a fully-qualified override`,
      )
    }
  })

  test('an unpinned agent is untouched, so subagents still inherit', () => {
    for (const alias of ROUTED_ALIASES) {
      assert(
        !pinnedAgentModelOutranksAlias(alias, undefined, undefined),
        `bare agent suppressed ${alias}`,
      )
      assert(
        !pinnedAgentModelOutranksAlias(alias, 'sonnet', undefined),
        `agent with a model but no provider suppressed ${alias}`,
      )
      // A provider with no model, or with `inherit`, is not a pin. Agent
      // loading rejects both, but a built definition could still carry them.
      assert(
        !pinnedAgentModelOutranksAlias(alias, undefined, 'fireworks'),
        `provider without a model suppressed ${alias}`,
      )
      assert(
        !pinnedAgentModelOutranksAlias(alias, 'inherit', 'fireworks'),
        `inherit was treated as a pin for ${alias}`,
      )
      assert(
        !pinnedAgentModelOutranksAlias(alias, 'Inherit', 'fireworks'),
        `cased inherit was treated as a pin for ${alias}`,
      )
    }
  })

  test('no tool-specified model leaves the pin resolution alone', () => {
    for (const [provider, model] of PINNED) {
      assert(
        !pinnedAgentModelOutranksAlias(undefined, model, provider),
        `${provider} short-circuited with no override`,
      )
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
