/**
 * Run: bun run src/services/api/antigravityAgentGate.test.ts
 */

import {
  _resetAntigravityAgentGateForTest,
  acquireAntigravityAgentTurn,
  antigravityAgentGateBusy,
  shouldSerializeAntigravityAgents,
} from './antigravityAgentGate.js'
import type { APIProvider } from '../../utils/model/providers.js'

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  console.log('antigravity agent gate:')

  await test('gates Antigravity Gemini models', () => {
    assert(
      shouldSerializeAntigravityAgents('antigravity' as APIProvider, 'gemini-3.5-flash-low'),
      'gemini-3.5-flash-low should serialize',
    )
    assert(
      shouldSerializeAntigravityAgents('antigravity' as APIProvider, 'gemini-3.1-pro-high'),
      'gemini-3.1-pro-high should serialize',
    )
  })

  await test('gates Claude models on Antigravity too (shared cache backend)', () => {
    assert(
      shouldSerializeAntigravityAgents('antigravity' as APIProvider, 'claude-sonnet-4-6'),
      'claude-sonnet-4-6 should serialize',
    )
    assert(
      shouldSerializeAntigravityAgents('antigravity' as APIProvider, 'claude-opus-4-6-thinking'),
      'claude-opus-4-6-thinking should serialize',
    )
  })

  await test('exempts every other provider', () => {
    assert(
      !shouldSerializeAntigravityAgents('gemini' as APIProvider, 'gemini-3-flash'),
      'gemini provider must not serialize',
    )
    assert(
      // A Claude id on the first-party Anthropic path must never serialize —
      // only the antigravity provider shares the implicit-cache backend.
      !shouldSerializeAntigravityAgents('firstParty' as APIProvider, 'claude-opus-4-8'),
      'firstParty must not serialize',
    )
  })

  await test('env escape hatch restores parallel spawns', () => {
    process.env.TAU_ANTIGRAVITY_PARALLEL_AGENTS = '1'
    try {
      assert(
        !shouldSerializeAntigravityAgents('antigravity' as APIProvider, 'gemini-3.5-flash-low'),
        'env override must disable the gate',
      )
    } finally {
      delete process.env.TAU_ANTIGRAVITY_PARALLEL_AGENTS
    }
  })

  await test('serializes concurrent holders in FIFO order', async () => {
    _resetAntigravityAgentGateForTest()
    const order: string[] = []
    let active = 0
    let maxActive = 0

    const work = async (name: string): Promise<void> => {
      const release = await acquireAntigravityAgentTurn()
      active++
      maxActive = Math.max(maxActive, active)
      order.push(`${name}:start`)
      await sleep(10)
      order.push(`${name}:end`)
      active--
      release()
    }

    await Promise.all([work('a'), work('b'), work('c')])
    assert(maxActive === 1, `overlapping holders: maxActive=${maxActive}`)
    assert(
      order.join(',') === 'a:start,a:end,b:start,b:end,c:start,c:end',
      `order=${order.join(',')}`,
    )
    assert(!antigravityAgentGateBusy(), 'gate should be idle after all released')
  })

  await test('release is idempotent and survives a throwing holder', async () => {
    _resetAntigravityAgentGateForTest()
    const releaseA = await acquireAntigravityAgentTurn()
    try {
      throw new Error('agent crashed')
    } catch {
      releaseA()
      releaseA() // double release must be a no-op
    }
    const releaseB = await acquireAntigravityAgentTurn()
    releaseB()
    assert(!antigravityAgentGateBusy(), 'double release corrupted holder count')
  })

  await test('pre-aborted waiter forfeits its slot without blocking the queue', async () => {
    _resetAntigravityAgentGateForTest()
    const releaseA = await acquireAntigravityAgentTurn()

    const ctrl = new AbortController()
    ctrl.abort()
    const releaseB = await acquireAntigravityAgentTurn(ctrl.signal) // resolves immediately
    releaseB() // no-op

    let cGotTurn = false
    const cPromise = acquireAntigravityAgentTurn().then(release => {
      cGotTurn = true
      return release
    })
    await sleep(5)
    assert(!cGotTurn, 'c must still wait for a')

    releaseA()
    const releaseC = await cPromise
    assert(cGotTurn, 'c never got its turn after a released')
    releaseC()
    assert(!antigravityAgentGateBusy(), 'holder count leaked')
  })

  await test('abort during the wait unblocks the waiter promptly', async () => {
    _resetAntigravityAgentGateForTest()
    const releaseA = await acquireAntigravityAgentTurn()

    const ctrl = new AbortController()
    let bResolved = false
    const bPromise = acquireAntigravityAgentTurn(ctrl.signal).then(release => {
      bResolved = true
      return release
    })
    await sleep(5)
    assert(!bResolved, 'b resolved while a still holds the gate')

    ctrl.abort()
    await bPromise
    assert(bResolved, 'abort did not unblock the waiter')

    releaseA()
    assert(!antigravityAgentGateBusy(), 'holder count leaked after abort')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
