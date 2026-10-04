/**
 * Cache refresh scheduling for Claude on Antigravity.
 *
 * Run: bun run src/lanes/gemini/antigravity_claude_keepalive.test.ts
 */
import {
  antigravityClaudeKeepAliveWindowMs,
  cancelAntigravityClaudeKeepAlive,
  scheduleAntigravityClaudeKeepAlive,
} from './antigravity_claude_keepalive.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  } finally {
    cancelAntigravityClaudeKeepAlive()
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

console.log('antigravity claude keep-alive:')

await test('refreshes every interval until the window closes', async () => {
  let calls = 0
  scheduleAntigravityClaudeKeepAlive(async () => { calls++ }, { windowMs: 130, intervalMs: 40 })
  await sleep(260)
  assert(calls === 3, `expected 3 refreshes inside a 130 ms window, got ${calls}`)
})

await test('a new turn replaces the refresher', async () => {
  let first = 0
  let second = 0
  scheduleAntigravityClaudeKeepAlive(async () => { first++ }, { windowMs: 1000, intervalMs: 30 })
  await sleep(45)
  scheduleAntigravityClaudeKeepAlive(async () => { second++ }, { windowMs: 1000, intervalMs: 30 })
  await sleep(100)
  assert(first === 1, `old refresher kept running: ${first}`)
  assert(second >= 2, `new refresher did not run: ${second}`)
})

await test('stops once shouldContinue says no', async () => {
  let calls = 0
  let wanted = true
  scheduleAntigravityClaudeKeepAlive(async () => { calls++ }, {
    windowMs: 1000, intervalMs: 30, shouldContinue: () => wanted,
  })
  await sleep(45)
  wanted = false
  await sleep(120)
  assert(calls === 1, `expected 1 refresh before the provider switch, got ${calls}`)
})

await test('cancel stops it and aborts a refresh in flight', async () => {
  let aborted = false
  scheduleAntigravityClaudeKeepAlive(signal => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve() })
  }), { windowMs: 1000, intervalMs: 20 })
  await sleep(40)
  cancelAntigravityClaudeKeepAlive()
  assert(aborted, 'in-flight refresh was not aborted')
})

await test('a failed refresh ends the cycle', async () => {
  let calls = 0
  scheduleAntigravityClaudeKeepAlive(async () => { calls++; throw new Error('429') }, { windowMs: 1000, intervalMs: 20 })
  await sleep(120)
  assert(calls === 1, `kept refreshing after a failure: ${calls}`)
})

await test('window comes from TAU_ANTIGRAVITY_CLAUDE_KEEPALIVE_MINUTES, 0 turns it off', async () => {
  const saved = process.env.TAU_ANTIGRAVITY_CLAUDE_KEEPALIVE_MINUTES
  try {
    delete process.env.TAU_ANTIGRAVITY_CLAUDE_KEEPALIVE_MINUTES
    assert(antigravityClaudeKeepAliveWindowMs() === 30 * 60_000, 'default is 30 minutes')
    process.env.TAU_ANTIGRAVITY_CLAUDE_KEEPALIVE_MINUTES = '0'
    let calls = 0
    scheduleAntigravityClaudeKeepAlive(async () => { calls++ }, { intervalMs: 10 })
    await sleep(50)
    assert(calls === 0, 'refreshed while switched off')
  } finally {
    if (saved === undefined) delete process.env.TAU_ANTIGRAVITY_CLAUDE_KEEPALIVE_MINUTES
    else process.env.TAU_ANTIGRAVITY_CLAUDE_KEEPALIVE_MINUTES = saved
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
