import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const r = await loadMcpRuntime()
const hookSource = readFileSync('src/services/mcp/useManageMCPConnections.ts', 'utf8')
const transpiled = ts.transpileModule(hookSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText
const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
let id = 0
function connection(name, config, cleanup = async () => {}) {
  const handlers = new Map()
  return { name, config, type: 'connected', capabilities: { tools: { listChanged: true } }, cleanup,
    client: { setRequestHandler() {}, setNotificationHandler(schema, fn) { handlers.set(schema, fn) } }, handlers }
}

// Execute the actual hook body/handlers/reducer. Only React scheduling and external
// services are substituted; cache and disposal use the shipped production bundle.
function mountHook() {
  let state = { authVersion: 0, settings: {}, plugins: { errors: [] },
    mcp: { clients: [], tools: [], commands: [], resources: {}, pluginReconnectKey: 0 } }
  const callbacks = []
  let reconnects = 0
  const acknowledgements = []
  const deps = new Proxy({}, { get: () => () => {} })
  const setAppState = update => { state = update(state) }
  const require = path => {
    if (path === 'react') return { useRef: current => ({ current }), useCallback: fn => { callbacks.push(fn); return fn }, useEffect() {} }
    if (path.includes('AppState')) return { useAppState: select => select(state), useAppStateStore: () => ({ getState: () => state }), useSetAppState: () => setAppState }
    if (path === './client.js') return { ...r, reconnectMcpServerImpl: async () => { reconnects++; throw new Error('unexpected reconnect') } }
    if (path === 'bun:bundle') return { feature: () => false }
    if (path.includes('notifications.js')) return { useNotifications: () => ({ addNotification() {} }) }
    if (path.includes('powerMode.js')) return { getPowerModeFromSettings: () => 'normal' }
    if (path.includes('mcpStringUtils')) return { getMcpPrefix: name => `mcp__${name}__` }
    if (path === './readiness.js') return { ...deps, acknowledgeMcpPublication: name => acknowledgements.push(name) }
    if (path.endsWith('omit.js')) return { __esModule: true, default: (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)) }
    if (path.endsWith('reject.js')) return { __esModule: true, default: (items, predicate) => items.filter(x => !predicate(x)) }
    return deps
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', transpiled)(require, module, module.exports)
  module.exports.useManageMCPConnections(undefined, true)
  const publish = callbacks.find(fn => fn.toString().includes('registerElicitationHandler'))
  const flush = callbacks.find(fn => fn.toString().includes('published.push'))
  assert.ok(publish && flush, 'production hook callbacks not captured')
  return { publish, flush, state: () => state, reconnects: () => reconnects, acknowledgements }
}

for (const type of ['stdio', 'http']) {
  test(`R3 actual ${type} close handler ignores a superseded cache owner`, async () => {
    const name = `lifecycle_${++id}`
    const config = { type, scope: 'local', url: 'https://fixture.invalid' }
    const old = connection(name, config)
    const newer = connection(name, config)
    const key = r.getServerCacheKey(name, config)
    const hook = mountHook()
    hook.publish({ client: old, tools: [{ name: `mcp__${name}__old` }], commands: [] })
    hook.flush()
    const replacement = Promise.resolve(newer)
    r.connectToServer.cache.set(key, replacement)
    await old.client.onclose()
    hook.flush()
    assert.equal(hook.state().mcp.clients[0].type, 'connected')
    assert.equal(hook.state().mcp.tools.length, 1)
    assert.equal(hook.reconnects(), 0)
    assert.equal(r.connectToServer.cache.get(key), replacement)
    r.connectToServer.cache.delete(key)
  })
}

test('R3 actual close handler cannot clear a replacement published during cleanup', async () => {
  const name = `lifecycle_${++id}`
  const config = { type: 'stdio', scope: 'local', command: 'fixture' }
  const gate = deferred()
  const old = connection(name, config, () => gate.promise)
  const next = connection(name, config)
  const key = r.getServerCacheKey(name, config)
  r.connectToServer.cache.set(key, Promise.resolve(old))
  const hook = mountHook()
  hook.publish({ client: old, tools: [], commands: [] })
  hook.flush()
  const closing = old.client.onclose()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  r.connectToServer.cache.set(key, Promise.resolve(next))
  hook.publish({ client: next, tools: [{ name: `mcp__${name}__new` }], commands: [] })
  // Keep the replacement in the real pending batch until after cleanup resolves.
  gate.resolve()
  await closing
  hook.flush()
  assert.equal(hook.state().mcp.clients[0].client, next.client)
  assert.equal(hook.state().mcp.clients[0].type, 'connected')
  assert.equal(hook.state().mcp.tools[0].name, `mcp__${name}__new`)
  r.connectToServer.cache.delete(key)
})

test('R3 a cancelled publisher cannot flush its queued catalog', () => {
  const name = `lifecycle_${++id}`
  const client = connection(name, { type: 'stdio', scope: 'local' })
  const hook = mountHook()
  let active = true
  hook.publish({ client, tools: [{ name: `mcp__${name}__old` }], commands: [] }, () => active)
  active = false
  hook.flush()
  assert.equal(hook.state().mcp.clients.length, 0)
  assert.deepEqual(hook.acknowledgements, [])
})

test('R3 a current close still removes its tools and resources', async () => {
  const name = `lifecycle_${++id}`
  const config = { type: 'stdio', scope: 'local' }
  const client = connection(name, config)
  const key = r.getServerCacheKey(name, config)
  r.connectToServer.cache.set(key, Promise.resolve(client))
  const hook = mountHook()
  hook.publish({ client, tools: [{ name: `mcp__${name}__old` }], commands: [], resources: [{ uri: 'fixture://old' }] })
  hook.flush()
  await client.client.onclose()
  hook.flush()
  assert.equal(hook.state().mcp.clients[0].type, 'failed')
  assert.equal(hook.state().mcp.tools.length, 0)
  assert.equal(hook.state().mcp.resources[name], undefined)
  assert.equal(r.connectToServer.cache.get(key), undefined)
})

test('R3 catalogs with the same name and different configurations never overlap', async () => {
  const name = `lifecycle_${++id}`
  const old = connection(name, { type: 'http', url: 'https://first.invalid', scope: 'local' })
  const next = connection(name, { type: 'http', url: 'https://second.invalid', scope: 'local' })
  const oldKey = r.getServerCacheKey(name, old.config)
  const nextKey = r.getServerCacheKey(name, next.config)
  old.client.request = async () => ({ tools: [{ name: 'old', inputSchema: { type: 'object' } }] })
  next.client.request = async () => ({ tools: [{ name: 'new', inputSchema: { type: 'object' } }] })
  r.connectToServer.cache.set(oldKey, Promise.resolve(old))
  r.connectToServer.cache.set(nextKey, Promise.resolve(next))
  try {
    assert.equal((await r.fetchToolsForClient(old))[0].mcpInfo.toolName, 'old')
    assert.equal((await r.fetchToolsForClient(next))[0].mcpInfo.toolName, 'new')
    await r.clearServerCache(name, old.config, old.client)
    assert.equal(r.fetchToolsForClient.cache.get(nextKey)[0].mcpInfo.toolName, 'new')
    assert.equal((await r.connectToServer.cache.get(nextKey)).client, next.client)
    // A duplicated late close on a vacant old key must also leave the new catalog alone.
    assert.equal(await r.clearServerCache(name, old.config, old.client), false)
    assert.equal(r.fetchToolsForClient.cache.get(nextKey)[0].mcpInfo.toolName, 'new')
  } finally { await r.clearServerCache(name, old.config); await r.clearServerCache(name, next.config) }
})

for (const fails of [false, true]) {
  test(`R3 a replaced listing cannot publish ${fails ? 'failure' : 'old tools'} over a new owner`, async () => {
    const name = `lifecycle_${++id}`
    const config = { type: 'stdio', command: 'fixture', scope: 'local' }
    const old = connection(name, config)
    const next = connection(name, config)
    const key = r.getServerCacheKey(name, config)
    const listed = deferred()
    const started = deferred()
    old.client.request = async () => { started.resolve(); await listed.promise; if (fails) throw new Error('old listing failed'); return { tools: [{ name: 'old', inputSchema: { type: 'object' } }] } }
    next.client.request = async () => ({ tools: [{ name: 'new', inputSchema: { type: 'object' } }] })
    const publications = []
    r.connectToServer.cache.set(key, Promise.resolve(old))
    const discovery = r.getMcpToolsCommandsAndResources(update => publications.push(update), { [name]: config })
    await started.promise
    await r.clearServerCache(name, config, old.client)
    r.connectToServer.cache.set(key, Promise.resolve(next))
    try {
      await r.getMcpToolsCommandsAndResources(update => publications.push(update), { [name]: config })
      listed.resolve()
      await discovery
      assert.ok(publications.length > 0)
      assert.ok(publications.every(update => update.client.client === next.client), 'obsolete listing overwrote the replacement')
      assert.equal(r.fetchToolsForClient.cache.get(key)[0].mcpInfo.toolName, 'new')
    } finally { listed.resolve(); await discovery; await r.clearServerCache(name, config) }
  })
}

test('R3 a stale HTTP tool failure cannot evict a newer session', async () => {
  const name = `lifecycle_${++id}`
  const config = { type: 'http', url: 'https://fixture.invalid', scope: 'local' }
  const old = connection(name, config)
  const next = connection(name, config)
  const key = r.getServerCacheKey(name, config)
  old.client.callTool = async () => { throw Object.assign(new Error('Connection closed'), { code: -32000 }) }
  const replacement = Promise.resolve(next)
  r.connectToServer.cache.set(key, replacement)
  try {
    await assert.rejects(r.callMCPTool({ client: old, tool: 'fixture', args: {}, signal: new AbortController().signal }), /session expired/)
    assert.equal(r.connectToServer.cache.get(key), replacement)
  } finally { await r.clearServerCache(name, config) }
})
