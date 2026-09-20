// The launch barrier against real MCP servers.
//
// mcp-readiness.test.mjs covers the registry and the wait in isolation. This
// drives the production discovery path — getMcpToolsCommandsAndResources,
// which spawns a real stdio child, completes a real JSON-RPC handshake and
// lists real tools — so the readiness reporting wired into it is exercised
// rather than assumed.
//
// The fixture server is test/fixtures/slow-mcp-server.mjs.

import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const fixturePath = resolve('test/fixtures/slow-mcp-server.mjs')
const auditPath = join(
  dirname(distPath),
  `.mcp-barrier-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
// The bundle emits one `init_<basename>` per module and suffixes duplicates
// in bundle order — several modules are named client.ts, so the MCP one is
// not simply `init_client`. Look each one up by the source path its
// initializer names, rather than pinning a suffix a rebundle could renumber.
const initializerFor = path => {
  const pattern = new RegExp(
    'var (init_\\w+) = __esm\\(\\{\\s*"' +
      path.replace(/[.]/g, '\\.') +
      '"\\(\\)',
  )
  const match = source.match(pattern)
  assert.ok(match, `no initializer found for ${path}`)
  return match[1]
}
const initMcpClient = initializerFor('src/services/mcp/client.ts')
const initMcpConfig = initializerFor('src/services/mcp/config.ts')

source += `
export function __mcpBarrier() {
  ${initMcpClient}(); ${initMcpConfig}(); init_readiness();
  return { getMcpToolsCommandsAndResources, isMcpDiscoverySettled,
    waitForMcpDiscovery, beginMcpSource, settleMcpSource, skipMcpSource,
    getMcpReadinessCounts, acknowledgeMcpPublication, registerMcpPublisher };
}
`
writeFileSync(auditPath, source)

let m
try {
  const module = await import(pathToFileURL(auditPath).href)
  m = module.__mcpBarrier()
} finally {
  unlinkSync(auditPath)
}

let uid = 0
/** A distinct server name per case: the registry is process-global. */
const nextName = () => `fixture_${++uid}`

const serverConfig = (env = {}) => ({
  type: 'stdio',
  command: process.execPath,
  args: [fixturePath],
  env: { ...env },
  scope: 'local',
})

// Every connected fixture holds a live child process. They are closed after
// the whole file so the runner can exit, and so a later case cannot be served
// an earlier case's memoized connection.
const openClients = []

test.after(async () => {
  await Promise.all(
    openClients.map(client => client.cleanup().catch(() => {})),
  )
})

/** Collect every publication the discovery path makes for one run. */
function collector() {
  const published = []
  return {
    published,
    onConnectionAttempt: update => {
      published.push(update)
      if (update.client.type === 'connected') openClients.push(update.client)
    },
    toolsFor: name =>
      published
        .filter(u => u.client.name === name)
        .flatMap(u => u.tools ?? [])
        .filter(t => t.mcpInfo?.serverName === name),
    lastClientFor: name =>
      published.filter(u => u.client.name === name).at(-1)?.client,
  }
}

test('a connected server publishes its tools and settles', async () => {
  const name = nextName()
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_TOOL_COUNT: '3' }),
  })
  assert.equal(c.lastClientFor(name)?.type, 'connected')
  assert.deepEqual(
    c.toolsFor(name).map(t => t.mcpInfo.toolName),
    ['tool_0', 'tool_1', 'tool_2'],
  )
  assert.equal(m.isMcpDiscoverySettled(), true)
})

test('tools past the first page reach the catalog', async () => {
  // End to end through the real transport, not just the pagination helper.
  const name = nextName()
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_TOOL_COUNT: '5', FIXTURE_PAGE_SIZE: '2' }),
  })
  assert.deepEqual(
    c.toolsFor(name).map(t => t.mcpInfo.toolName),
    ['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4'],
  )
})

test('an MCP tool carries its server schema, which the model is declared', async () => {
  const name = nextName()
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_TOOL_COUNT: '1' }),
  })
  const [tool] = c.toolsFor(name)
  assert.deepEqual(tool.inputJSONSchema, {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  })
})

test('the wait releases when a slow server finishes, not at the deadline', async () => {
  const name = nextName()
  const c = collector()
  const started = Date.now()

  // Registered before the discovery starts, exactly as the production
  // callers do, so a wait entered in between still sees work outstanding.
  const sourceId = `source_${name}`
  m.beginMcpSource(sourceId)
  m.settleMcpSource(sourceId, [name])
  assert.equal(m.isMcpDiscoverySettled(), false)

  const discovery = m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_CONNECT_DELAY_MS: '400' }),
  })
  // A generous deadline: the point is that it does not run out.
  const outcome = await m.waitForMcpDiscovery(10_000)
  const waited = Date.now() - started

  assert.equal(outcome, 'settled')
  assert.equal(waited >= 350, true, `released before the server: ${waited}ms`)
  assert.equal(waited < 9_000, true, `waited to the deadline: ${waited}ms`)
  assert.equal(c.lastClientFor(name)?.type, 'connected')
  await discovery
})

test('a server slower than the deadline does not hold the wait open', async () => {
  const name = nextName()
  const c = collector()
  const sourceId = `source_${name}`
  m.beginMcpSource(sourceId)
  m.settleMcpSource(sourceId, [name])

  const discovery = m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_CONNECT_DELAY_MS: '1500' }),
  })
  const started = Date.now()
  const outcome = await m.waitForMcpDiscovery(250)
  const waited = Date.now() - started

  assert.equal(outcome, 'deadline')
  assert.equal(waited < 1_000, true, `waited past the deadline: ${waited}ms`)

  // Discovery kept running: the wait gave up, the connection did not.
  await discovery
  assert.equal(c.lastClientFor(name)?.type, 'connected')
  assert.equal(m.isMcpDiscoverySettled(), true)
})

test('a server whose tools/list fails is published failed, and settles', async () => {
  // A failed listing must not read as "this server has no tools", and must
  // not hold the barrier open to its deadline either.
  const name = nextName()
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_LIST_FAILS: '1' }),
  })
  assert.equal(c.lastClientFor(name)?.type, 'failed')
  assert.equal(m.isMcpDiscoverySettled(), true)
})

test('a server whose listing failed leaves no child process behind', async () => {
  // Its handshake succeeded, so a live connection exists and the memoize
  // cache holds it, but the server is published failed and no one will ever
  // close it. Without an explicit disposal a stdio server's child would run
  // for the rest of the session; this counts the processes to prove it does
  // not. (Measured as active handles: the child and its three pipes.)
  const before = process._getActiveHandles().length
  const name = nextName()
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_LIST_FAILS: '1' }),
  })
  assert.equal(c.lastClientFor(name)?.type, 'failed')
  // Disposal is asynchronous; give the close a turn to land.
  await new Promise(resolve => setTimeout(resolve, 300))
  const after = process._getActiveHandles().length
  assert.equal(
    after <= before,
    true,
    `handles grew from ${before} to ${after}: the failed connection was orphaned`,
  )
})

test('a server that cannot start settles rather than hanging the wait', async () => {
  const name = nextName()
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: {
      type: 'stdio',
      command: process.execPath,
      args: [resolve('test/fixtures/this-file-does-not-exist.mjs')],
      env: {},
      scope: 'local',
    },
  })
  assert.equal(c.lastClientFor(name)?.type, 'failed')
  assert.equal(m.isMcpDiscoverySettled(), true)
})

test('several servers settle independently and none is lost', async () => {
  const names = [nextName(), nextName(), nextName()]
  const c = collector()
  const configs = {
    [names[0]]: serverConfig({ FIXTURE_TOOL_COUNT: '1' }),
    [names[1]]: serverConfig({
      FIXTURE_TOOL_COUNT: '1',
      FIXTURE_CONNECT_DELAY_MS: '200',
    }),
    [names[2]]: serverConfig({ FIXTURE_LIST_FAILS: '1' }),
  }
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, configs)

  assert.equal(c.lastClientFor(names[0])?.type, 'connected')
  assert.equal(c.lastClientFor(names[1])?.type, 'connected')
  assert.equal(c.lastClientFor(names[2])?.type, 'failed')
  assert.equal(c.toolsFor(names[0]).length, 1)
  assert.equal(c.toolsFor(names[1]).length, 1)
  assert.equal(m.isMcpDiscoverySettled(), true)
})

test('ready tools publish without waiting for a slow prompts list', async () => {
  // F08. Tools and the ancillary collections were awaited together, so a
  // server whose prompts/list was slow kept its ready tools out of the
  // catalog for as long as the slowest collection took — time the launch
  // barrier then spent waiting for tools that had already arrived.
  const name = nextName()
  const c = collector()
  const started = Date.now()

  const sourceId = `source_${name}`
  m.beginMcpSource(sourceId)
  m.settleMcpSource(sourceId, [name])

  // A registered publisher acknowledges as soon as its write is readable,
  // which is what lets the tools settle ahead of the ancillary listing.
  const acknowledging = update => {
    c.onConnectionAttempt(update)
    m.acknowledgeMcpPublication(update.client.name)
  }
  const release = m.registerMcpPublisher(acknowledging)

  const discovery = m.getMcpToolsCommandsAndResources(acknowledging, {
    [name]: serverConfig({
      FIXTURE_TOOL_COUNT: '2',
      FIXTURE_WITH_PROMPTS: '1',
      FIXTURE_PROMPTS_DELAY_MS: '1200',
    }),
  })

  // Readiness releases on the tools, not on the whole catalog.
  assert.equal(await m.waitForMcpDiscovery(10_000), 'settled')
  const waited = Date.now() - started
  assert.equal(
    waited < 900,
    true,
    `tools waited ${waited}ms on the ancillary listing`,
  )
  assert.equal(c.toolsFor(name).length, 2)

  await discovery
  release()
  assert.equal(c.lastClientFor(name)?.type, 'connected')
})

test('a publication carrying only tools does not erase commands', async () => {
  // The incremental publish leaves commands undefined, which the reducer
  // reads as "unchanged" — it must not be read as "none".
  const name = nextName()
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_TOOL_COUNT: '1', FIXTURE_WITH_PROMPTS: '1' }),
  })
  const updates = c.published.filter(u => u.client.name === name)
  const toolsOnly = updates.find(u => u.tools !== undefined)
  assert.ok(toolsOnly, 'expected a tools publication')
  assert.equal(toolsOnly.commands, undefined)
  // And a later publication carries the ancillary results.
  const ancillary = updates.find(u => u.commands !== undefined)
  assert.ok(ancillary, 'expected an ancillary publication')
  assert.equal(ancillary.tools, undefined)
})

test('readiness waits for the catalog to be readable, not just discovered', async () => {
  // F01. Discovery settled the server immediately, but the UI publishes its
  // updates on a batching timer, so a request released by the barrier could
  // still read zero tools — the one outcome the barrier exists to prevent.
  //
  // This models that publisher: updates land in `store` only after a delay,
  // and only then is publication acknowledged.
  const name = nextName()
  const store = { tools: [] }
  const PUBLISH_DELAY_MS = 250
  const pending = []

  const publisher = update => {
    if (update.client.type === 'connected') openClients.push(update.client)
    const timer = setTimeout(() => {
      if (update.tools !== undefined) store.tools.push(...update.tools)
      m.acknowledgeMcpPublication(update.client.name)
    }, PUBLISH_DELAY_MS)
    pending.push(timer)
  }
  // Only a registered publisher defers a server's settle, so that a caller
  // which never acknowledges cannot hold the barrier open.
  const release = m.registerMcpPublisher(publisher)

  const sourceId = `source_${name}`
  m.beginMcpSource(sourceId)
  m.settleMcpSource(sourceId, [name])

  const discovery = m.getMcpToolsCommandsAndResources(publisher, {
    [name]: serverConfig({ FIXTURE_TOOL_COUNT: '2' }),
  })

  assert.equal(await m.waitForMcpDiscovery(10_000), 'settled')
  // The whole point: by the time readiness says so, the catalog a request
  // would read actually holds the tools.
  assert.equal(
    store.tools.length,
    2,
    'readiness released before the catalog was readable',
  )

  await discovery
  release()
  for (const timer of pending) clearTimeout(timer)
})

test('a server that never publishes still settles when it fails', async () => {
  // The counterpart: only a published result defers settling. A terminal
  // outcome must settle immediately or it would hold the barrier to its
  // deadline.
  const name = nextName()
  const c = collector()
  const sourceId = `source_${name}`
  m.beginMcpSource(sourceId)
  m.settleMcpSource(sourceId, [name])

  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_LIST_FAILS: '1' }),
  })
  assert.equal(m.isMcpDiscoverySettled(), true)
})
