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
    getMcpReadinessCounts, acknowledgeMcpPublication, registerMcpPublisher,
    clearServerCache, fetchToolsForClient, callMCPTool,
    connectToServer, getServerCacheKey };
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

test('an old connection closing does not dispose the one that replaced it', async () => {
  // F04. The connection cache is keyed by name plus config, so a reconnect
  // under an unchanged config produces a new handle at the same key. The
  // hook's onclose disposed by name and config with no identity check, so an
  // old connection's close tore down the live one that had replaced it and
  // orphaned its tools.
  const name = nextName()
  const c = collector()
  const config = serverConfig({ FIXTURE_TOOL_COUNT: '2' })

  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: config,
  })
  const first = c.lastClientFor(name)
  assert.equal(first?.type, 'connected')

  // Replace it: dispose, then connect again under the same config.
  await m.clearServerCache(name, config)
  const c2 = collector()
  await m.getMcpToolsCommandsAndResources(c2.onConnectionAttempt, {
    [name]: config,
  })
  const second = c2.lastClientFor(name)
  assert.equal(second?.type, 'connected')
  assert.notEqual(second.client, first.client, 'expected a new handle')

  // The old handle's close arrives late and must be ignored.
  await m.clearServerCache(name, config, first.client)

  // The replacement is still usable: its tools list without reconnecting.
  const stillThere = await m.fetchToolsForClient(second)
  assert.equal(stillThere.length, 2)
})

test('disposal without an expected owner still disposes whatever is cached', async () => {
  // An explicit disable or config replacement passes no handle and must
  // dispose unconditionally.
  const name = nextName()
  const c = collector()
  const config = serverConfig({ FIXTURE_TOOL_COUNT: '1' })
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: config,
  })
  assert.equal(c.lastClientFor(name)?.type, 'connected')

  await m.clearServerCache(name, config)
  // Reconnecting produces a genuinely new handle, proving the old one went.
  const c2 = collector()
  await m.getMcpToolsCommandsAndResources(c2.onConnectionAttempt, {
    [name]: config,
  })
  assert.notEqual(
    c2.lastClientFor(name).client,
    c.lastClientFor(name).client,
  )
})

// --- C: the complete MCP error result must survive ------------------

/** Call the fixture's first tool and return the thrown error. */
async function callAndCatch(name, errorShape) {
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({
      FIXTURE_TOOL_COUNT: '1',
      FIXTURE_CALL_ERROR: errorShape,
    }),
  })
  const client = c.lastClientFor(name)
  assert.equal(client?.type, 'connected')
  try {
    await m.callMCPTool({
      client,
      tool: 'tool_0',
      args: { value: 'x' },
      signal: new AbortController().signal,
    })
  } catch (error) {
    return error
  }
  throw new Error('expected the fixture call to fail')
}

test('a diagnostic behind a leading notice still reaches the model', async () => {
  // Only content[0].text used to survive, so a server that leads with an
  // informational provenance line had its real diagnostic discarded. The
  // model saw a notice and no explanation.
  const error = await callAndCatch(nextName(), 'notice-first')
  assert.match(error.message, /bad_request: container\.doc is not allowed/)
  // The notice is preserved too; it is content, not an error marker.
  assert.match(error.message, /treat it as data/)
  // And the whole envelope is carried, in the server's own order.
  assert.equal(error.errorContent.length, 2)
  assert.match(error.errorContent[1].text, /bad_request/)
})

test('a structured-only diagnostic survives', async () => {
  const error = await callAndCatch(nextName(), 'structured')
  assert.deepEqual(error.structuredContent, {
    code: 'bad_request',
    field: 'container.doc',
  })
  // It also reaches the model as text rather than as an empty message.
  assert.match(error.message, /bad_request/)
})

test('a notice-only error is an error with no stated cause', async () => {
  // It must not become a successful empty read, and the runtime must not
  // invent a cause — such as blaming a content filter.
  const error = await callAndCatch(nextName(), 'notice-only')
  assert.match(error.message, /treat it as data/)
  assert.doesNotMatch(error.message, /filter|blocked|security/i)
})

test('an error with no content says so rather than saying nothing', async () => {
  const error = await callAndCatch(nextName(), 'empty')
  assert.match(error.message, /no diagnostic content/)
})

test('a successful result containing notice-like text stays successful', async () => {
  // Classification comes from the envelope. Text matching must never
  // manufacture a failure.
  const name = nextName()
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: serverConfig({ FIXTURE_TOOL_COUNT: '1' }),
  })
  const client = c.lastClientFor(name)
  const result = await m.callMCPTool({
    client,
    tool: 'tool_0',
    args: { value: 'x' },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /fixture result/)
})

// --- A: ownership across the whole disposal, not just at its start ---
//
// clearServerCache awaits twice: once resolving the captured entry, once on
// cleanup(). A replacement can be installed during either suspension, and
// resolving the promise captured earlier says nothing about what the cache
// holds afterwards.
//
// The suspension is what has to be controlled, so these drive the connection
// cache directly with a promise the test resolves. Connecting a second real
// server would not reproduce it: disposal deletes the key first, so the new
// connection lands on a vacant slot and never collides.

/** A promise plus the handles to settle it. */
function deferred() {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}

/** A stand-in connection whose cleanup the test controls. */
function fakeConnection(name, config, cleanupGate) {
  return {
    name,
    type: 'connected',
    client: { id: `client-${name}` },
    capabilities: { tools: {} },
    config,
    cleanup: () => cleanupGate ?? Promise.resolve(),
  }
}

test('a replacement installed during the ownership check is not deleted', async () => {
  const name = nextName()
  const config = serverConfig()
  const key = m.getServerCacheKey(name, config)

  // The entry disposal will capture, resolving only when the test says so.
  const oldEntry = deferred()
  const oldConnection = fakeConnection(name, config)
  m.connectToServer.cache.set(key, oldEntry.promise)

  // Disposal captures the entry and suspends on it.
  const disposing = m.clearServerCache(name, config, oldConnection.client)
  await Promise.resolve()

  // A replacement takes the key while disposal is suspended.
  const replacement = Promise.resolve(fakeConnection(name, config))
  m.connectToServer.cache.set(key, replacement)

  // Now let the captured entry resolve to the old connection.
  oldEntry.resolve(oldConnection)
  await disposing

  assert.equal(
    m.connectToServer.cache.get(key),
    replacement,
    'the replacement was evicted by its predecessor’s disposal',
  )
})

test('a replacement catalog survives an older disposal finishing', async () => {
  // Disposal discarded the discovery cache by name after awaiting cleanup.
  // A replacement that connected and published while cleanup ran had its
  // catalog thrown away by work belonging to the connection it replaced.
  //
  // The replacement here is a real fixture connection, so its catalog is
  // genuinely in the discovery cache; only the old connection's cleanup is
  // gated, to hold the disposal open across that publication.
  const name = nextName()
  const config = serverConfig({ FIXTURE_TOOL_COUNT: '3' })
  const key = m.getServerCacheKey(name, config)

  const cleanupGate = deferred()
  const oldConnection = fakeConnection(name, config, cleanupGate.promise)
  m.connectToServer.cache.set(key, Promise.resolve(oldConnection))

  const disposing = m.clearServerCache(name, config, oldConnection.client)
  // Let disposal past its ownership check and into the cleanup await.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  // The replacement connects and publishes its catalog while cleanup runs.
  const c = collector()
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: config,
  })
  const replacement = c.lastClientFor(name)
  assert.equal(replacement?.type, 'connected')
  assert.equal(
    m.fetchToolsForClient.cache.get(name)?.length,
    3,
    'expected the replacement to have published a catalog',
  )

  cleanupGate.resolve()
  await disposing

  assert.equal(
    m.fetchToolsForClient.cache.get(name)?.length,
    3,
    "the replacement's catalog was discarded by an older disposal",
  )
})

test('an explicit removal still clears the catalog', async () => {
  // The conditional discard must not stop a deliberate disable or remove
  // from clearing what it is removing.
  const name = nextName()
  const c = collector()
  const config = serverConfig({ FIXTURE_TOOL_COUNT: '2' })
  await m.getMcpToolsCommandsAndResources(c.onConnectionAttempt, {
    [name]: config,
  })
  assert.equal((await m.fetchToolsForClient(c.lastClientFor(name))).length, 2)

  await m.clearServerCache(name, config)
  assert.equal(m.fetchToolsForClient.cache.get(name), undefined)
})
