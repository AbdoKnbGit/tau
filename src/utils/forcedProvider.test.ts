import {
  canApplyAgentProvider,
  driveInProviderScope,
  getForcedProvider,
  getForcedProviderContext,
  getScopedProvider,
  runOutsideProviderScope,
  runWithAgentProvider,
  runWithForcedProvider,
} from './forcedProvider.js'
import { createStore } from '../state/store.js'

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

  await test('a driven agent runs on its route while its consumer stays on the session', async () => {
    const route = { provider: 'alibaba', source: 'spawn' } as const
    const agentSaw: Array<string | undefined> = []
    async function* agent(): AsyncGenerator<number, void> {
      agentSaw.push(getScopedProvider())
      yield 1
      await Promise.resolve()
      agentSaw.push(getScopedProvider())
      yield 2
    }
    const consumerSaw: Array<string | undefined> = []
    for await (const _step of driveInProviderScope(route, agent())) {
      consumerSaw.push(getScopedProvider())
    }
    assert(agentSaw.join() === 'alibaba,alibaba', `agent saw ${agentSaw.join()}`)
    assert(consumerSaw.length === 2 && consumerSaw.every(p => p === undefined), `consumer saw ${consumerSaw.join()}`)
  })

  await test('a consumer that stops early closes the agent on its route', async () => {
    let closedOn: string | undefined
    async function* agent(): AsyncGenerator<number, void> {
      try {
        yield 1
        yield 2
      } finally {
        closedOn = getScopedProvider()
      }
    }
    for await (const _step of driveInProviderScope({ provider: 'alibaba', source: 'spawn' }, agent())) break
    assert(closedOn === 'alibaba', `closed on ${closedOn}`)
  })

  await test("an update from inside a sub-agent's scope re-renders the main screen outside it", async () => {
    const store = createStore({ n: 0 }, undefined, runOutsideProviderScope)
    let updaterSaw: string | undefined
    let listenerSaw: string | undefined = 'never called'
    let scheduledSaw: string | undefined = 'never ran'
    let scheduled!: Promise<void>
    store.subscribe(() => {
      listenerSaw = getScopedProvider()
      // React schedules its render from the listener; the render inherits
      // whatever scope the listener ran in.
      scheduled = new Promise(resolve => setImmediate(() => {
        scheduledSaw = getScopedProvider()
        resolve()
      }))
    })
    runWithForcedProvider({ provider: 'alibaba', source: 'spawn' }, () =>
      store.setState(prev => {
        updaterSaw = getScopedProvider()
        return { n: prev.n + 1 }
      }),
    )
    await scheduled
    assert(updaterSaw === 'alibaba', 'the update itself runs where its caller is')
    assert(listenerSaw === undefined, `listener saw ${listenerSaw}`)
    assert(scheduledSaw === undefined, `scheduled render saw ${scheduledSaw}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
