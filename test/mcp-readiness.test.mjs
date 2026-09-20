// The MCP launch barrier and the readiness registry it waits on.
//
// Both are exercised through the built bundle, the same way
// core-tool-contracts.test.mjs does, so the test runs the production code
// rather than a reimplementation of it.
//
// The registry is process-global and has no reset seam, so every case uses
// its own source and server ids. Cases that must observe an unsettled
// registry therefore open a source and settle it before they finish; a case
// that left one open would make every later case's wait hit the deadline
// instead of settling.

import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const auditPath = join(
  dirname(distPath),
  `.mcp-readiness-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __mcpReadiness() {
  init_readiness(); init_launchBarrier(); init_launchClock();
  return { beginMcpSource, settleMcpSource, skipMcpSource,
    beginMcpServer, settleMcpServer, isMcpDiscoverySettled,
    getMcpReadinessCounts, waitForMcpDiscovery,
    getMcpLaunchBudgetMs, waitForMcpLaunchBarrier,
    shouldWaitForMcpAtLaunch, disarmMcpLaunchBarrier,
    launchElapsedMs };
}
`
writeFileSync(auditPath, source)

let mcp
try {
  const module = await import(pathToFileURL(auditPath).href)
  mcp = module.__mcpReadiness()
} finally {
  unlinkSync(auditPath)
}

let uid = 0
const nextId = prefix => `${prefix}-${++uid}`

test('an empty registry is settled', () => {
  assert.equal(mcp.isMcpDiscoverySettled(), true)
})

test('a source that has begun keeps the registry unsettled', () => {
  const src = nextId('src')
  mcp.beginMcpSource(src)
  assert.equal(mcp.isMcpDiscoverySettled(), false)
  mcp.skipMcpSource(src)
  assert.equal(mcp.isMcpDiscoverySettled(), true)
})

test('an enumerating source with no clients yet is not settled', () => {
  // The 12:31 case from docs/mcp-tool-loading-investigation.md: the
  // connector list is in flight, so no client is pending, but 30 tools are
  // still coming. A pending-clients check alone would release here; the
  // source registration is what prevents that.
  const src = nextId('connectors')
  mcp.beginMcpSource(src)
  assert.equal(mcp.getMcpReadinessCounts().enumeratingSources >= 1, true)
  assert.equal(mcp.isMcpDiscoverySettled(), false)
  mcp.skipMcpSource(src)
})

test('settling a source registers its servers in the same transition', () => {
  const src = nextId('src')
  const server = nextId('server')
  mcp.beginMcpSource(src)
  mcp.settleMcpSource(src, [server])
  // The source is settled but its server is not, so discovery is not.
  assert.equal(mcp.isMcpDiscoverySettled(), false)
  mcp.settleMcpServer(server)
  assert.equal(mcp.isMcpDiscoverySettled(), true)
})

test('a server registered outside a source also holds readiness', () => {
  const server = nextId('server')
  mcp.beginMcpServer(server)
  assert.equal(mcp.isMcpDiscoverySettled(), false)
  mcp.settleMcpServer(server)
  assert.equal(mcp.isMcpDiscoverySettled(), true)
})

test('settling a server twice is not an error', () => {
  const server = nextId('server')
  mcp.beginMcpServer(server)
  mcp.settleMcpServer(server)
  mcp.settleMcpServer(server)
  assert.equal(mcp.isMcpDiscoverySettled(), true)
})

test('beginMcpServer does not reopen an already settled server', () => {
  // A mid-session reconnect must not make the registry unsettled again.
  const server = nextId('server')
  mcp.beginMcpServer(server)
  mcp.settleMcpServer(server)
  mcp.beginMcpServer(server)
  assert.equal(mcp.isMcpDiscoverySettled(), true)
})

test('waitForMcpDiscovery returns settled immediately when nothing is pending', async () => {
  const started = Date.now()
  assert.equal(await mcp.waitForMcpDiscovery(5_000), 'settled')
  assert.equal(Date.now() - started < 200, true)
})

test('waitForMcpDiscovery resolves when the last server settles, not at the deadline', async () => {
  const server = nextId('server')
  mcp.beginMcpServer(server)
  const started = Date.now()
  const waiting = mcp.waitForMcpDiscovery(5_000)
  setTimeout(() => mcp.settleMcpServer(server), 120)
  assert.equal(await waiting, 'settled')
  const elapsed = Date.now() - started
  assert.equal(elapsed >= 100, true, `released too early: ${elapsed}ms`)
  assert.equal(elapsed < 2_000, true, `waited to the deadline: ${elapsed}ms`)
})

test('waitForMcpDiscovery does not lose a settle that races the subscribe', async () => {
  // skipMcpSource runs in the same tick as the wait. Subscribe-then-check is
  // what makes this resolve instead of hanging to the deadline.
  const src = nextId('src')
  mcp.beginMcpSource(src)
  const waiting = mcp.waitForMcpDiscovery(3_000)
  mcp.skipMcpSource(src)
  assert.equal(await waiting, 'settled')
})

test('waitForMcpDiscovery gives up at its deadline and leaves discovery running', async () => {
  const server = nextId('server')
  mcp.beginMcpServer(server)
  const started = Date.now()
  assert.equal(await mcp.waitForMcpDiscovery(150), 'deadline')
  assert.equal(Date.now() - started >= 130, true)
  // Still registered as discovering: the wait gave up, the discovery did not.
  assert.equal(mcp.isMcpDiscoverySettled(), false)
  mcp.settleMcpServer(server)
})

test('a zero or negative remaining budget does not wait', async () => {
  const server = nextId('server')
  mcp.beginMcpServer(server)
  const started = Date.now()
  assert.equal(await mcp.waitForMcpDiscovery(0), 'deadline')
  assert.equal(await mcp.waitForMcpDiscovery(-500), 'deadline')
  assert.equal(Date.now() - started < 100, true)
  mcp.settleMcpServer(server)
})

test('aborting one waiter leaves other waiters and discovery alone', async () => {
  const server = nextId('server')
  mcp.beginMcpServer(server)
  const controller = new AbortController()
  const aborted = mcp.waitForMcpDiscovery(5_000, controller.signal)
  const other = mcp.waitForMcpDiscovery(5_000)
  controller.abort()
  assert.equal(await aborted, 'aborted')
  mcp.settleMcpServer(server)
  assert.equal(await other, 'settled')
})

test('a signal already aborted returns without waiting', async () => {
  const server = nextId('server')
  mcp.beginMcpServer(server)
  const controller = new AbortController()
  controller.abort()
  assert.equal(
    await mcp.waitForMcpDiscovery(5_000, controller.signal),
    'aborted',
  )
  mcp.settleMcpServer(server)
})

test('the launch budget defaults to 10s and honours its env var', () => {
  const original = process.env.TAU_MCP_LAUNCH_WAIT_MS
  try {
    delete process.env.TAU_MCP_LAUNCH_WAIT_MS
    assert.equal(mcp.getMcpLaunchBudgetMs(), 10_000)
    process.env.TAU_MCP_LAUNCH_WAIT_MS = '4000'
    assert.equal(mcp.getMcpLaunchBudgetMs(), 4_000)
    // 0 turns the wait off.
    process.env.TAU_MCP_LAUNCH_WAIT_MS = '0'
    assert.equal(mcp.getMcpLaunchBudgetMs(), 0)
    // A typo falls back to the default rather than silently disabling.
    process.env.TAU_MCP_LAUNCH_WAIT_MS = 'soon'
    assert.equal(mcp.getMcpLaunchBudgetMs(), 10_000)
    // Absurd values are capped, not honoured.
    process.env.TAU_MCP_LAUNCH_WAIT_MS = '999999999'
    assert.equal(mcp.getMcpLaunchBudgetMs(), 120_000)
    process.env.TAU_MCP_LAUNCH_WAIT_MS = '-1'
    assert.equal(mcp.getMcpLaunchBudgetMs(), 0)
  } finally {
    if (original === undefined) delete process.env.TAU_MCP_LAUNCH_WAIT_MS
    else process.env.TAU_MCP_LAUNCH_WAIT_MS = original
  }
})

test('a request with no MCP surface does not acquire the barrier', () => {
  assert.equal(mcp.shouldWaitForMcpAtLaunch(false), false)
})

test('the barrier is disabled when the budget is zero', () => {
  const original = process.env.TAU_MCP_LAUNCH_WAIT_MS
  try {
    process.env.TAU_MCP_LAUNCH_WAIT_MS = '0'
    assert.equal(mcp.shouldWaitForMcpAtLaunch(true), false)
  } finally {
    if (original === undefined) delete process.env.TAU_MCP_LAUNCH_WAIT_MS
    else process.env.TAU_MCP_LAUNCH_WAIT_MS = original
  }
})

test('the launch clock is monotonic and already past zero', () => {
  const first = mcp.launchElapsedMs()
  assert.equal(Number.isFinite(first) && first >= 0, true)
  assert.equal(mcp.launchElapsedMs() >= first, true)
})

// Kept last: waitForMcpLaunchBarrier consumes the process-wide barrier, so
// every case after this one would see 'disarmed'.
test('the launch barrier is consumed by its first use', async () => {
  assert.equal(mcp.shouldWaitForMcpAtLaunch(true), true)
  // Discovery is settled by now, so this returns without adding any wait.
  const first = await mcp.waitForMcpLaunchBarrier()
  assert.equal(first.outcome, 'already-settled')
  assert.equal(first.waitedMs, 0)

  // Consumed: a second request never waits, even with work outstanding.
  const server = nextId('server')
  mcp.beginMcpServer(server)
  assert.equal(mcp.shouldWaitForMcpAtLaunch(true), false)
  const second = await mcp.waitForMcpLaunchBarrier()
  assert.equal(second.outcome, 'disarmed')
  assert.equal(second.waitedMs, 0)
  mcp.settleMcpServer(server)
})
