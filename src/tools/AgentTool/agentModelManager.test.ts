/**
 * Run: bun run src/tools/AgentTool/agentModelManager.test.ts
 *
 * Guards the display bug this registry exists to fix: the Agent tool tag used
 * to render the tier alias the caller passed, so a provider-pinned agent
 * spawned with `model: haiku` was labelled "Haiku" while it ran on its pin.
 */
import {
  getAgentResolvedModel,
  setAgentResolvedModel,
} from './agentModelManager.js'

let passed = 0
let failed = 0

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
  console.log('agent resolved-model registry:')

  test('a pinned agent round-trips both model and lane', () => {
    setAgentResolvedModel('pin-fireworks', {
      model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
      provider: 'fireworks',
    })
    const got = getAgentResolvedModel('pin-fireworks')
    assert(
      got?.model === 'accounts/fireworks/models/deepseek-v4-flash-0731',
      `model was ${got?.model}`,
    )
    assert(got?.provider === 'fireworks', `provider was ${got?.provider}`)
  })

  test('an unpinned agent records a model with no lane', () => {
    setAgentResolvedModel('explore', { model: 'claude-haiku-4-5-20251001' })
    const got = getAgentResolvedModel('explore')
    assert(got?.model === 'claude-haiku-4-5-20251001', `model was ${got?.model}`)
    assert(got?.provider === undefined, `provider leaked: ${got?.provider}`)
  })

  test('a later spawn replaces the earlier resolution', () => {
    setAgentResolvedModel('reviewer', { model: 'sonnet-first' })
    setAgentResolvedModel('reviewer', {
      model: 'kimi-k2.6',
      provider: 'moonshot',
    })
    const got = getAgentResolvedModel('reviewer')
    assert(got?.model === 'kimi-k2.6', `stale model ${got?.model}`)
    assert(got?.provider === 'moonshot', `stale provider ${got?.provider}`)
  })

  test('clearing an entry removes it rather than leaving a stale tag', () => {
    setAgentResolvedModel('temp', { model: 'gpt-5.5' })
    setAgentResolvedModel('temp', undefined)
    assert(getAgentResolvedModel('temp') === undefined, 'entry survived')
  })

  test('an empty model is treated as no resolution', () => {
    setAgentResolvedModel('blank', { model: 'gpt-5.5' })
    setAgentResolvedModel('blank', { model: '' })
    assert(getAgentResolvedModel('blank') === undefined, 'empty model stored')
  })

  test('an unknown agent type has no resolution', () => {
    assert(
      getAgentResolvedModel('never-spawned') === undefined,
      'invented a resolution',
    )
  })

  test('a missing agent type is undefined, not a crash', () => {
    assert(getAgentResolvedModel(undefined) === undefined, 'undefined threw')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
