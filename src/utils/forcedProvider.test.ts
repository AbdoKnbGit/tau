import {
  canApplyAgentProvider,
  getForcedProvider,
  getForcedProviderContext,
  runWithAgentProvider,
  runWithForcedProvider,
} from './forcedProvider.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  console.log('forced provider context:')

  await test('keeps an agent provider scoped across awaits', async () => {
    assert(getForcedProvider() === undefined, 'context leaked before run')

    await runWithForcedProvider(
      { provider: 'openai', source: 'agent' },
      async () => {
        await Promise.resolve()
        assert(getForcedProvider() === 'openai', 'provider was not retained')
        assert(
          getForcedProviderContext()?.source === 'agent',
          'agent source was not retained',
        )
      },
    )

    assert(getForcedProvider() === undefined, 'context leaked after run')
  })

  await test('restores an outer explicit provider after a nested scope', () => {
    runWithForcedProvider({ provider: 'kiro' }, () => {
      runWithForcedProvider(
        { provider: 'openrouter', source: 'agent' },
        () => assert(getForcedProvider() === 'openrouter', 'nested provider'),
      )
      assert(getForcedProvider() === 'kiro', 'outer provider was not restored')
      assert(
        getForcedProviderContext()?.source === undefined,
        'explicit context source changed',
      )
    })
  })

  await test('an agent provider applies at the top level', () => {
    assert(canApplyAgentProvider('fireworks'), 'agent provider was refused')
    runWithAgentProvider('fireworks', () => {
      assert(getForcedProvider() === 'fireworks', 'agent provider not applied')
      assert(
        getForcedProviderContext()?.source === 'agent',
        'agent source not recorded',
      )
    })
    assert(getForcedProvider() === undefined, 'context leaked after run')
  })

  await test('an explicit caller override outranks the agent file', () => {
    runWithForcedProvider({ provider: 'kiro' }, () => {
      assert(
        !canApplyAgentProvider('fireworks'),
        'agent provider overrode an explicit one',
      )
      runWithAgentProvider('fireworks', () =>
        assert(getForcedProvider() === 'kiro', 'explicit provider was replaced'),
      )
    })
  })

  await test('a nested agent replaces an inherited agent provider', () => {
    runWithAgentProvider('fireworks', () => {
      runWithAgentProvider('antigravity', () =>
        assert(
          getForcedProvider() === 'antigravity',
          'nested agent provider not applied',
        ),
      )
      assert(getForcedProvider() === 'fireworks', 'outer agent provider lost')
    })
  })

  await test('an agent with no provider changes nothing', () => {
    assert(!canApplyAgentProvider(undefined), 'undefined provider was accepted')
    runWithForcedProvider({ provider: 'kiro' }, () => {
      runWithAgentProvider(undefined, () =>
        assert(getForcedProvider() === 'kiro', 'ambient provider was disturbed'),
      )
    })
    runWithAgentProvider(undefined, () =>
      assert(getForcedProvider() === undefined, 'a provider appeared'),
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
