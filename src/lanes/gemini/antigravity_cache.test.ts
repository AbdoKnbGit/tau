/**
 * Run: bun run src/lanes/gemini/antigravity_cache.test.ts
 */

import {
  antigravityPrefixPad,
  applyAntigravityPrefixPad,
  diagnoseAntigravityCacheBreak,
  paceAntigravityAgentRequest,
  recordAntigravityCacheRead,
  _getAntigravityPaceStateForTest,
  _resetAntigravityCacheStateForTest,
  _setAntigravityCommitWindowForTest,
} from './antigravity_cache.js'

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
  console.log('antigravity prefix pad:')

  await test('pad generation is deterministic and memoized', () => {
    const a = antigravityPrefixPad(2000)
    const b = antigravityPrefixPad(2000)
    assert(a === b, 'same size must return identical bytes')
    assert(a.startsWith('<cache_alignment_padding>'), 'missing opening tag')
    assert(a.endsWith('</cache_alignment_padding>'), 'missing closing tag')
  })

  await test('pad sizes scale with requested tokens', () => {
    const small = antigravityPrefixPad(500)
    const large = antigravityPrefixPad(5000)
    assert(large.length > small.length * 5, `small=${small.length} large=${large.length}`)
    // ~4.6 chars/token provisioning must be met.
    assert(large.length >= 5000 * 4.6, `large pad too small: ${large.length}`)
  })

  await test('small prompts get padded over the cache minimum', () => {
    const stable = 'You are a focused search agent.'.repeat(50) // ~1.5k chars
    const padded = applyAntigravityPrefixPad(stable, 10_000)
    assert(padded !== stable, 'small prompt must be padded')
    assert(padded.endsWith(stable), 'stable text must keep its position after the pad')
    // (stable + tools ≈ 11.7k chars ≈ 2.1k tokens) → missing ≈ 15.3k tokens
    // → ≥ 15.3k * 4.6 ≈ 70k chars of pad.
    assert(
      padded.length - stable.length > 60_000,
      `pad too small: ${padded.length - stable.length} chars`,
    )
  })

  await test('padding is byte-stable across turns for the same inputs', () => {
    const stable = 'agent persona text '.repeat(300)
    const a = applyAntigravityPrefixPad(stable, 42_000)
    const b = applyAntigravityPrefixPad(stable, 42_000)
    assert(a === b, 'same inputs must produce identical padded text')
  })

  await test('small tool-list drift within a size step keeps the pad identical', () => {
    const stable = 'agent persona text '.repeat(300)
    const a = applyAntigravityPrefixPad(stable, 42_000)
    const b = applyAntigravityPrefixPad(stable, 42_100) // < 500-token step
    assert(a === b, 'sub-step drift must not change the pad')
  })

  await test('over-minimum prompts are returned unchanged', () => {
    const big = 'x'.repeat(120_000) // ≈ 21.8k estimated tokens > target
    assert(
      applyAntigravityPrefixPad(big, 0) === big,
      'large prompt must not be padded',
    )
  })

  await test('TAU_ANTIGRAVITY_NO_PREFIX_PAD=1 disables padding', () => {
    process.env.TAU_ANTIGRAVITY_NO_PREFIX_PAD = '1'
    try {
      const stable = 'tiny'
      assert(
        applyAntigravityPrefixPad(stable, 0) === stable,
        'env override must disable the pad',
      )
    } finally {
      delete process.env.TAU_ANTIGRAVITY_NO_PREFIX_PAD
    }
  })

  console.log('antigravity commit-window pacing:')

  await test('first request arms without waiting', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(50)
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc')
    assert(Date.now() - start < 25, 'first request must not wait')
    const state = _getAntigravityPaceStateForTest('tau-agent-abc')
    assert(state !== undefined && state.pacedCount === 0, 'state must be armed')
  })

  await test('second request waits out the commit window', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await paceAntigravityAgentRequest('tau-agent-abc')
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc')
    const waited = Date.now() - start
    assert(waited >= 40, `second request must wait, waited=${waited}ms`)
    const state = _getAntigravityPaceStateForTest('tau-agent-abc')
    assert(state?.pacedCount === 1, `pacedCount=${state?.pacedCount}`)
  })

  await test('a qualifying cache hit latches pacing off', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await paceAntigravityAgentRequest('tau-agent-abc')
    recordAntigravityCacheRead('tau-agent-abc', 9000, 10_000) // 90% coverage
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc')
    assert(Date.now() - start < 25, 'hit-latched session must not wait')
  })

  await test('a partial hit below 70% coverage keeps pacing armed', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await paceAntigravityAgentRequest('tau-agent-abc')
    recordAntigravityCacheRead('tau-agent-abc', 2000, 10_000) // 20% coverage
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc')
    assert(Date.now() - start >= 40, 'partial hit must not latch pacing off')
  })

  await test('pacing gives up after two paced turns', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(40)
    await paceAntigravityAgentRequest('tau-agent-abc') // arm
    await paceAntigravityAgentRequest('tau-agent-abc') // paced 1 (re-arms)
    await paceAntigravityAgentRequest('tau-agent-abc') // paced 2 (re-arms)
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc') // must not pace
    assert(Date.now() - start < 25, 'pacing must cap at two paced turns')
  })

  await test('main-thread sessions are never paced', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await paceAntigravityAgentRequest('root-session-uuid')
    const start = Date.now()
    await paceAntigravityAgentRequest('root-session-uuid')
    assert(Date.now() - start < 25, 'main-thread session must not wait')
    assert(
      _getAntigravityPaceStateForTest('root-session-uuid') === undefined,
      'main-thread session must not be tracked',
    )
  })

  await test('abort during the pace wait unblocks promptly', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(5_000)
    await paceAntigravityAgentRequest('tau-agent-abc')
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 20)
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc', ctrl.signal)
    const waited = Date.now() - start
    assert(waited < 1_000, `abort must unblock the wait, waited=${waited}ms`)
  })

  await test('TAU_ANTIGRAVITY_NO_PACING=1 disables pacing', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    process.env.TAU_ANTIGRAVITY_NO_PACING = '1'
    try {
      await paceAntigravityAgentRequest('tau-agent-abc')
      const start = Date.now()
      await paceAntigravityAgentRequest('tau-agent-abc')
      assert(Date.now() - start < 25, 'env override must disable pacing')
    } finally {
      delete process.env.TAU_ANTIGRAVITY_NO_PACING
    }
  })

  console.log('antigravity cache-break diagnosis:')

  await test('first request on a session is cold', () => {
    const v = diagnoseAntigravityCacheBreak(undefined, { system: 's', tools: 't', blocks: ['a'] })
    assert(v === 'cold', v)
  })

  await test('append-only growth is a clean prefix extension', () => {
    const prev = { system: 's', tools: 't', blocks: ['a', 'b'] }
    const cur = { system: 's', tools: 't', blocks: ['a', 'b', 'c', 'd'] }
    const v = diagnoseAntigravityCacheBreak(prev, cur)
    assert(v === 'ok: clean prefix extension', v)
  })

  await test('changed systemInstruction is flagged first (byte-0 break)', () => {
    const prev = { system: 's1', tools: 't', blocks: ['a'] }
    const cur = { system: 's2', tools: 't', blocks: ['a', 'b'] }
    assert(diagnoseAntigravityCacheBreak(prev, cur) === 'BREAK: systemInstruction', 'system')
  })

  await test('changed tools is flagged', () => {
    const prev = { system: 's', tools: 't1', blocks: ['a'] }
    const cur = { system: 's', tools: 't2', blocks: ['a', 'b'] }
    assert(diagnoseAntigravityCacheBreak(prev, cur) === 'BREAK: tools', 'tools')
  })

  await test('a rewritten history block names its index (the 0% multi-turn cause)', () => {
    // block 0 stable, block 1 rewritten in place, block 2 appended.
    const prev = { system: 's', tools: 't', blocks: ['a', 'b', 'c'] }
    const cur = { system: 's', tools: 't', blocks: ['a', 'B-rewritten', 'c', 'd'] }
    const v = diagnoseAntigravityCacheBreak(prev, cur)
    assert(v === 'BREAK: history block 1/3 rewritten', v)
  })

  await test('a changed leading content block is caught at index 0', () => {
    const prev = { system: 's', tools: 't', blocks: ['vol-v1', 'task'] }
    const cur = { system: 's', tools: 't', blocks: ['vol-v2', 'task', 'more'] }
    assert(diagnoseAntigravityCacheBreak(prev, cur) === 'BREAK: history block 0/2 rewritten', 'leading')
  })

  _resetAntigravityCacheStateForTest()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
