import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadMcpRuntime, fixtureContext } from './helpers/mcp-built-runtime.mjs'

const original = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau direct mcp é-'))
const project = join(root, 'workspace')
const config = join(root, 'config')
const write = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '',
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  TAU_MCP_TEST_BUNDLE: resolve(
    process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs',
  ),
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: [
    'src/utils/plugins/mods/manager.ts',
    'src/utils/plugins/mods/mcpApi.ts',
  ],
  exports: [
    'startPluginMods',
    'stopPluginMods',
    'getModCommands',
    'getModWarnings',
    'setInlinePlugins',
    'clearAllCaches',
    'resetSettingsCache',
    'setOriginalCwd',
    'setSessionTrustAccepted',
    'setAllowedSettingSources',
    'setIsInteractive',
    'getManagedFilePath',
    'setModMcpSessionOptions',
    'registerModMcpPublisher',
    'runModMcpAPI',
    'withModToolContext',
    'loadAllPluginsCacheOnly',
    'setMcpServerEnabled',
    'getPluginMcpServers',
    'updateSettingsForSource',
    'getInitialSettings',
    'AllowedMcpServerEntrySchema',
    'DeniedMcpServerEntrySchema',
    'applyModMcpUpdate',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)
after(async () => {
  await r.stopPluginMods()
  r.setInlinePlugins([])
  r.setModMcpSessionOptions({ strict: false, dynamic: {} })
  process.chdir(original)
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

function plugin(name, code, manifest = {}) {
  const path = join(root, name)
  write(join(path, '.claude-plugin/plugin.json'), {
    name,
    version: '1.0.0',
    ...manifest,
  })
  write(join(path, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(
    join(path, 'hooks/register.ts'),
    `export function register(on) { ${code} }`,
  )
  return path
}
async function load(paths) {
  await r.stopPluginMods()
  r.setInlinePlugins(paths)
  r.resetSettingsCache()
  r.clearAllCaches()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
}
async function command(name, input, context) {
  const entry = r.getModCommands().find(item => item.name === name)
  assert.ok(entry, `Missing command ${name}: ${r.getModWarnings()}`)
  return JSON.parse(
    (await (await entry.load()).call(JSON.stringify(input), context)).value,
  )
}

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for fixture evidence')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('direct mod MCP calls preserve raw results and run earlier API middleware exactly once', async () => {
  const receipt = randomUUID()
  const calls = []
  const server = new Server(
    { name: 'raw-mcp', version: '1' },
    { capabilities: { tools: {} } },
  )
  const client = new Client({ name: 'direct-mod-test', version: '1' })
  const content = [
    { type: 'text', text: receipt },
    { type: 'resource_link', uri: 'test://receipt', name: 'receipt' },
    { type: 'image', mimeType: 'image/png', data: 'YWJj' },
  ]
  server.setRequestHandler(CallToolRequestSchema, async request => {
    calls.push(request.params)
    return {
      content,
      structuredContent: { receipt, input: request.params.arguments },
      isError: request.params.name === 'error',
    }
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const connection = {
    name: 'Stock service',
    type: 'connected',
    client,
    config: { type: 'sdk', scope: 'project' },
    capabilities: { tools: {} },
  }
  const context = fixtureContext([])
  let live = [connection]
  context.options.refreshMcpContext = () => ({ tools: [], mcpClients: live })
  context.canUseTool = () => {
    throw new Error('Direct MCP APIs must not use model permissions')
  }
  const caller = plugin(
    'raw-caller',
    `
    on('session.start',async($,e,next)=>{await $.command.register({name:'raw-call',description:'Call MCP'});return next(e)});
    on('command.run',{command:'raw-call'},async($,e)=>{
      const input=JSON.parse(e.args);
      try { return {text:JSON.stringify(await $.mcp.call(input.server,input.tool,input.args))} }
      catch(error){return {text:JSON.stringify({error:String(error)})}}
    });`,
  )
  const observer = plugin(
    'raw-observer',
    `
    on('mcp.call',async($,e,next)=>{
      if(e.tool==='blocked')return {deny:'DENIED-BY-OBSERVER'};
      if(e.tool==='synthetic')return {value:{content:[{type:'text',text:'synthetic'}],isError:false}};
      const answer=await next({...e,args:{...e.args,observed:true}});
      if(e.tool==='double')await next(e);
      return answer;
    });`,
    { dependencies: ['raw-caller'] },
  )
  try {
    await load([caller, observer])
    const snapshot = context.options
    const result = await command(
      'raw-call',
      { server: 'Stock_service', tool: 'inspect', args: { value: receipt } },
      context,
    )
    assert.deepEqual(result.content, content)
    assert.equal(result.isError, false)
    assert.deepEqual(result.structuredContent.input, {
      value: receipt,
      observed: true,
    })
    const error = await command(
      'raw-call',
      { server: connection.name, tool: 'error' },
      context,
    )
    assert.equal(error.isError, true, JSON.stringify(error))
    assert.deepEqual(
      error.content,
      content,
      'Server errors keep every raw content block',
    )
    assert.match(
      (
        await command(
          'raw-call',
          { server: connection.name, tool: 'blocked' },
          context,
        )
      ).error,
      /DENIED-BY-OBSERVER/,
    )
    assert.equal(
      (
        await command(
          'raw-call',
          { server: connection.name, tool: 'synthetic' },
          context,
        )
      ).content[0].text,
      'synthetic',
    )
    assert.equal(
      calls.length,
      2,
      'A refusal and synthetic result execute no MCP request',
    )
    await command(
      'raw-call',
      { server: connection.name, tool: 'double' },
      context,
    )
    assert.equal(
      calls.length,
      3,
      'Failure after next must never replay a completed MCP request',
    )
    assert.equal(
      context.options,
      snapshot,
      'Direct calls leave model tool/cache inputs alone',
    )
    live = [connection, { ...connection, name: 'Stock.service' }]
    assert.match(
      (
        await command(
          'raw-call',
          { server: 'Stock_service', tool: 'inspect' },
          context,
        )
      ).error,
      /Ambiguous/,
    )
    live = []
    assert.match(
      (
        await command(
          'raw-call',
          { server: connection.name, tool: 'inspect' },
          context,
        )
      ).error,
      /not available/,
    )
    assert.equal(calls.length, 3)
  } finally {
    await r.stopPluginMods()
    await client.close()
    await server.close()
  }
})

test('manifest MCP connect works at startup, deduplicates, refuses unavailable servers, and survives reload', async () => {
  const receipt = randomUUID()
  const script = join(root, 'server with spaces é.mjs')
  write(
    script,
    `import {createInterface} from 'node:readline';
    import {appendFileSync,existsSync} from 'node:fs';
    appendFileSync(process.argv[2], 'start\\n');
    createInterface({input:process.stdin}).on('line',line=>{
      const q=JSON.parse(line);if(q.id===undefined)return;
      let result={};
      if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{},prompts:{}}};
      if(q.method==='prompts/list'){
        const timer=setInterval(()=>{if(existsSync(process.argv[4])){clearInterval(timer);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{prompts:[{name:'receipt',description:'Inspect receipt'}]}})+'\\n')}},10);
        return;
      }
      if(q.method==='tools/list')result={tools:[{name:'inspect',description:'Inspect receipt',inputSchema:{type:'object'}}]};
      if(q.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({receipt:process.argv[3],args:q.params.arguments})}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
    });`,
  )
  const starts = join(root, 'starts.txt')
  const allowPrompts = join(root, 'allow-prompts')
  const serverConfig = {
    command: process.execPath,
    args: [script, starts, receipt, allowPrompts],
  }
  const directory = plugin(
    'connect-probe',
    `
    on('session.start',async($,e,next)=>{
      await $.command.register({name:'connect-probe',description:'Connect server'});
      const result=await $.mcp.connect('inventory');
      await $.fs.write('startup-connect.json',JSON.stringify(result));
      return next(e);
    });
    on('command.run',{command:'connect-probe'},async($,e)=>{
      const result=await $.mcp.connect(JSON.parse(e.args));
      return {text:JSON.stringify(result.isConnected ? {...result,reply:await $.mcp.call(result.server,'inspect',{receipt:'runtime'})} : result)};
    });`,
    { mcpServers: { inventory: serverConfig } },
  )
  const updates = []
  const guards = new Map()
  const release = r.registerModMcpPublisher((update, isCurrent) => {
    updates.push(update)
    guards.set(update.client.name, isCurrent)
  })
  const context = fixtureContext([])
  try {
    await load([directory])
    const startup = JSON.parse(
      readFileSync(join(project, 'startup-connect.json'), 'utf8'),
    )
    assert.deepEqual(startup, {
      isConnected: true,
      server: 'plugin:connect-probe:inventory',
    })
    assert.equal(
      updates.some(update => update.commands?.length),
      false,
      'Tools can be ready before prompts',
    )
    write(allowPrompts, 'ready')
    await until(() =>
      updates.some(update =>
        update.commands?.some(command => command.name.includes('receipt')),
      ),
    )
    const first = await command('connect-probe', 'inventory', context)
    assert.equal(first.isConnected, true)
    assert.deepEqual(JSON.parse(first.reply.content[0].text), {
      receipt,
      args: { receipt: 'runtime' },
    })
    assert.ok(
      updates.some(update =>
        update.tools?.some(tool => tool.mcpInfo?.toolName === 'inspect'),
      ),
    )
    await r.startPluginMods(true)
    assert.equal(
      (await command('connect-probe', 'inventory', context)).isConnected,
      true,
    )
    assert.equal(
      readFileSync(starts, 'utf8').trim().split('\n').length,
      1,
      'Reload must reuse the session connection',
    )
    assert.equal(
      (await command('connect-probe', 'unlisted', context)).reason,
      'unlisted',
    )
    r.setMcpServerEnabled(startup.server, false)
    assert.equal(
      (await command('connect-probe', 'inventory', context)).reason,
      'disabled',
    )
    r.setMcpServerEnabled(startup.server, true)
    r.setModMcpSessionOptions({ strict: true, dynamic: {} })
    assert.equal(
      (await command('connect-probe', 'inventory', context)).reason,
      'unlisted',
    )
    r.setModMcpSessionOptions({ strict: false, dynamic: {} })
    const owner = (await r.loadAllPluginsCacheOnly()).enabled.find(
      item => item.name === 'connect-probe',
    )
    r.setIsInteractive(true)
    assert.equal(
      (
        await r.runModMcpAPI(
          'mcp.connect',
          { server: 'inventory' },
          new AbortController().signal,
          { ...owner, discoveryScope: 'project' },
        )
      ).reason,
      'unapproved',
    )
    r.setIsInteractive(false)
    const policyUpdate = r.updateSettingsForSource('userSettings', {
      deniedMcpServers: [{ serverName: startup.server }],
    })
    assert.equal(policyUpdate.error, null)
    assert.ok(r.getInitialSettings().deniedMcpServers?.length)
    assert.equal(
      (await command('connect-probe', 'inventory', context)).reason,
      'policy',
    )
    r.updateSettingsForSource('userSettings', { deniedMcpServers: [] })
    const declared = (await r.getPluginMcpServers(owner))[startup.server]
    const publicationGuard = guards.get(startup.server)
    assert.equal(publicationGuard(), true)
    await r.clearServerCache(startup.server, declared)
    assert.equal(
      publicationGuard(),
      false,
      'A queued UI update must reject a replaced connection',
    )
    r.setModMcpSessionOptions({
      strict: false,
      dynamic: {
        'shared inventory': {
          ...declared,
          pluginSource: undefined,
          scope: 'dynamic',
        },
      },
    })
    const dedup = await command('connect-probe', 'inventory', context)
    assert.equal(dedup.server, 'shared inventory')
    assert.equal(dedup.isConnected, true)
    context.options.refreshMcpContext = () => ({
      tools: [],
      mcpClients: [
        updates.findLast(update => update.client.name === dedup.server).client,
      ],
    })
    r.setModMcpSessionOptions({ strict: false, dynamic: {} })
    assert.equal(
      (await command('connect-probe', 'inventory', context)).server,
      dedup.server,
      'Live dynamically-added servers participate in duplicate resolution',
    )
    await r.clearServerCache(dedup.server, {
      ...declared,
      pluginSource: undefined,
      scope: 'dynamic',
    })
    r.setModMcpSessionOptions({ strict: false, dynamic: {} })
  } finally {
    release()
    await r.stopPluginMods()
    const owner = (await r.loadAllPluginsCacheOnly()).enabled.find(
      item => item.name === 'connect-probe',
    )
    if (owner)
      for (const [name, config] of Object.entries(
        (await r.getPluginMcpServers(owner)) ?? {},
      ))
        await r.clearServerCache(name, config)
  }
})

test('cancellation and invalid direct MCP inputs cannot silently succeed or start another request', async () => {
  const server = new Server(
    { name: 'slow', version: '1' },
    { capabilities: { tools: {} } },
  )
  const client = new Client({ name: 'abort-test', version: '1' })
  let calls = 0
  server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    calls++
    await new Promise(resolve =>
      extra.signal.addEventListener('abort', resolve, { once: true }),
    )
    return { content: [] }
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const connection = {
    name: 'slow',
    type: 'connected',
    client,
    config: { type: 'sdk', scope: 'dynamic' },
  }
  const context = fixtureContext([])
  context.options.mcpClients = [connection]
  const bound = {
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' }),
  }
  const invoke = (input, signal) =>
    r.withModToolContext(bound, () =>
      r.runModMcpAPI('mcp.call', input, signal, {}),
    )
  try {
    const signal = new AbortController().signal
    await assert.rejects(
      invoke({ server: 'slow', tool: 'inspect', args: [] }, signal),
      /argument object/,
    )
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(
      invoke({ server: 'slow', tool: 'inspect' }, aborted.signal),
    )
    assert.equal(calls, 0)
    const controller = new AbortController()
    const pending = invoke(
      { server: 'slow', tool: 'inspect' },
      controller.signal,
    )
    const timer = setTimeout(() => controller.abort(), 100)
    await assert.rejects(pending, /interrupted|abort/i)
    clearTimeout(timer)
    assert.equal(calls, 1)
    const previousTimeout = process.env.MCP_TOOL_TIMEOUT
    process.env.MCP_TOOL_TIMEOUT = '30'
    try {
      await assert.rejects(
        invoke({ server: 'slow', tool: 'inspect' }, signal),
        /timed out|timeout/i,
      )
      assert.equal(calls, 2, 'Timeout must not replay a request')
    } finally {
      if (previousTimeout === undefined) delete process.env.MCP_TOOL_TIMEOUT
      else process.env.MCP_TOOL_TIMEOUT = previousTimeout
    }
    assert.equal(context.options.mcpClients[0], connection)
  } finally {
    await client.close()
    await server.close()
  }
})

test('an MCP connection finishing after its plugin is removed cannot publish stale tools', async () => {
  const script = join(root, 'late-server.mjs')
  const entered = join(root, 'late-entered')
  const released = join(root, 'late-released')
  write(
    script,
    `import {createInterface} from 'node:readline';import {existsSync,writeFileSync} from 'node:fs';
    createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;
      const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
      if(q.method==='initialize')return reply({protocolVersion:q.params.protocolVersion,serverInfo:{name:'late',version:'1'},capabilities:{tools:{}}});
      if(q.method==='tools/list'){
        writeFileSync(process.argv[2],'entered');
        const timer=setInterval(()=>{if(existsSync(process.argv[3])){clearInterval(timer);reply({tools:[{name:'late',description:'Late tool',inputSchema:{type:'object'}}]})}},10);
        return;
      }
      reply({});
    });`,
  )
  const directory = plugin('late-probe', '', {
    mcpServers: {
      late: { command: process.execPath, args: [script, entered, released] },
    },
  })
  await load([directory])
  const owner = (await r.loadAllPluginsCacheOnly()).enabled.find(
    item => item.name === 'late-probe',
  )
  const [server, config] = Object.entries(await r.getPluginMcpServers(owner))[0]
  const updates = []
  const release = r.registerModMcpPublisher(update => updates.push(update))
  const controller = new AbortController()
  const pending = r.runModMcpAPI(
    'mcp.connect',
    { server: 'late' },
    controller.signal,
    owner,
  )
  pending.catch(() => {})
  try {
    await until(() => existsSync(entered))
    r.setInlinePlugins([])
    r.clearAllCaches()
    write(released, 'released')
    assert.equal((await pending).isConnected, false)
    assert.equal(updates.length, 0)
    await assert.rejects(
      r.runModMcpAPI(
        'mcp.call',
        { server, tool: 'late' },
        controller.signal,
        owner,
      ),
      /not available/,
    )
  } finally {
    controller.abort()
    write(released, 'released')
    await pending.catch(() => {})
    release()
    await r.clearServerCache(server, config)
    await r.stopPluginMods()
  }
})

test('policy names address real plugin and Unicode server names while rejecting control characters', () => {
  for (const schema of [
    r.AllowedMcpServerEntrySchema(),
    r.DeniedMcpServerEntrySchema(),
  ]) {
    for (const serverName of [
      'plugin:reports:ledger',
      'Inventory service',
      'équipe',
      'plain-name',
    ])
      assert.deepEqual(schema.parse({ serverName }), { serverName })
    for (const serverName of ['', ' ', 'bad\nname', 'bad\0name', '\x1b[31m'])
      assert.equal(schema.safeParse({ serverName }).success, false)
  }
})

test('publishing an unchanged MCP catalog preserves model tool ordering and unrelated state', () => {
  const client = { name: 'catalog', type: 'connected' }
  const a = { name: 'Read' },
    b = {
      name: 'mcp__catalog__inspect',
      mcpInfo: { serverName: 'catalog', toolName: 'inspect' },
      inputJSONSchema: { type: 'object' },
    },
    c = { name: 'Write' }
  const current = {
    clients: [client],
    tools: [a, b, c],
    commands: [],
    resources: {},
    pluginReconnectKey: 19,
  }
  const before = JSON.stringify(current)
  const updated = r.applyModMcpUpdate(current, {
    client,
    tools: [{ ...b }],
    commands: [],
  })
  assert.equal(JSON.stringify(updated), before)
  assert.equal(
    JSON.stringify(current),
    before,
    'Publication does not mutate an in-flight request snapshot',
  )
  assert.equal(updated.tools[0], a)
  assert.equal(updated.tools[2], c)
})

test('pending direct calls are revoked when the server is disabled, removed, or reconfigured', async () => {
  const server = new Server(
    { name: 'revocation', version: '1' },
    { capabilities: { tools: {} } },
  )
  const client = new Client({ name: 'revocation', version: '1' })
  let calls = 0
  server.setRequestHandler(CallToolRequestSchema, async () => {
    calls++
    return { content: [{ type: 'text', text: 'side effect' }] }
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  try {
    for (const mutation of ['disabled', 'removed', 'reconfigured']) {
      const name = 'revocation-' + mutation
      const config = {
        type: 'http',
        url: 'https://original.invalid/mcp',
        scope: 'local',
      }
      const connection = {
        name,
        config,
        type: 'connected',
        client,
        capabilities: { tools: {} },
      }
      const context = fixtureContext([])
      context.options.mcpClients = [connection]
      r.setModMcpSessionOptions({ strict: true, dynamic: { [name]: config } })
      let resolveConnection, started
      const waiting = new Promise(resolve => {
        started = resolve
      })
      const pending = new Promise(resolve => {
        resolveConnection = resolve
      })
      const then = pending.then.bind(pending)
      pending.then = (...args) => {
        started()
        return then(...args)
      }
      const key = r.getServerCacheKey(name, config)
      r.connectToServer.cache.set(key, pending)
      const result = r.withModToolContext({ toolUseContext: context }, () =>
        r.runModMcpAPI(
          'mcp.call',
          { server: name, tool: 'act' },
          new AbortController().signal,
          {},
        ),
      )
      const rejected = assert.rejects(
        result,
        /disabled|configuration changed|not available/,
      )
      await waiting
      if (mutation === 'disabled') r.setMcpServerEnabled(name, false)
      else
        r.setModMcpSessionOptions({
          strict: true,
          dynamic:
            mutation === 'removed'
              ? {}
              : {
                  [name]: { ...config, url: 'https://replacement.invalid/mcp' },
                },
        })
      resolveConnection(connection)
      await rejected
      assert.equal(
        calls,
        0,
        mutation + ' server received a side-effect request',
      )
      r.setMcpServerEnabled(name, true)
      r.connectToServer.cache.delete(key)
    }
  } finally {
    r.setModMcpSessionOptions({ strict: false, dynamic: {} })
    await client.close()
    await server.close()
  }
})

test('catalog updates preserve exact ownership when server names normalize alike', () => {
  const name = 'Stock service'
  const own = {
    name: 'mcp__Stock_service__inspect',
    mcpInfo: { serverName: name },
  }
  const other = { name: own.name, mcpInfo: { serverName: 'Stock.service' } }
  const current = {
    clients: [],
    tools: [own, other],
    commands: [],
    resources: { [name]: [{ uri: 'old://receipt' }] },
  }
  const replacement = { ...own }
  const updated = r.applyModMcpUpdate(current, {
    client: { name, type: 'connected' },
    tools: [replacement],
    commands: [],
  })
  assert.deepEqual(updated.tools, [replacement, other])
  assert.equal(updated.tools[1], other)
  const removed = r.applyModMcpUpdate(updated, {
    client: { name, type: 'failed' },
  })
  assert.deepEqual(removed.tools, [other])
  assert.equal(removed.resources[name], undefined)
  assert.deepEqual(current.tools, [own, other])
})
