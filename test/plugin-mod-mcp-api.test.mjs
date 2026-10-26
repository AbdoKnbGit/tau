import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  loadMcpRuntime,
  fixtureContext,
  fixtureTool,
} from './helpers/mcp-built-runtime.mjs'

const originalCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-mod-mcp-api-'))
const project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
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
    'src/utils/plugins/mods/toolApi.ts',
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
    'readModToolSnapshot',
    'getModTools',
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
  process.chdir(originalCwd)
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

test('mod list, check and call use one live MCP snapshot and reject removed tools', async () => {
  const receipt = randomBytes(8).toString('hex')
  const name = 'live-' + randomBytes(4).toString('hex')
  const server = new Server(
    { name, version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  const client = new Client({ name: 'mod-mcp-freshness', version: '1.0.0' })
  const calls = []
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'inspect',
        description: 'Read a live receipt',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        annotations: { readOnlyHint: true },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    calls.push(request.params)
    return {
      content: [
        { type: 'text', text: receipt + ':' + request.params.arguments.value },
      ],
    }
  })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const connection = {
      name,
      type: 'connected',
      config: { type: 'sdk', scope: 'project' },
      capabilities: client.getServerCapabilities(),
      client,
    }
    const [discovered] = await r.fetchToolsForClient(connection)
    const seenClients = []
    const current = {
      ...discovered,
      async call(...args) {
        seenClients.push(args[1].options.mcpClients)
        return discovered.call(...args)
      },
    }
    const removed = fixtureTool({
      name: 'mcp__removed__old',
      isEnabled: () => true,
    })
    const context = fixtureContext([removed])
    const oldClients = [
      {
        name: 'removed',
        type: 'failed',
        config: { type: 'sdk', scope: 'project' },
      },
    ]
    const currentClients = [connection]
    const currentTools = [current]
    let refreshes = 0
    context.options = {
      ...context.options,
      mcpClients: oldClients,
      refreshTools() {
        throw new Error('Atomic MCP refresh must take precedence')
      },
      refreshMcpContext() {
        refreshes++
        return { tools: currentTools, mcpClients: currentClients }
      },
    }
    context.canUseTool = async (_tool, input) => ({
      behavior: 'allow',
      updatedInput: input,
    })
    const plugin = join(root, 'plugin')
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
    mkdirSync(join(plugin, 'hooks'))
    writeFileSync(
      join(plugin, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'mcp-probe', version: '1.0.0' }),
    )
    writeFileSync(
      join(plugin, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    )
    writeFileSync(
      join(plugin, 'hooks/register.ts'),
      `export function register(on) {
      on('session.start', async($,e,next)=>{await $.command.register({name:'live-probe',description:'Inspect live tools'});return next(e)});
      on('command.run',{command:'live-probe'},async($,e)=>{
        const inventory=await $.tool.list();
        const check=await $.tool.check({tool:e.args,input:{value:'query'}});
        const call=await $.tool.call({tool:e.args,value:'actual'});
        let removed='';
        try { await $.tool.call({tool:'mcp__removed__old',value:'obsolete'}) } catch(error) { removed=String(error) }
        return {text:JSON.stringify({inventory,check,call,removed})};
      });
    }`,
    )
    r.setInlinePlugins([plugin])
    r.resetSettingsCache()
    r.clearAllCaches()
    await r.startPluginMods(true)
    assert.deepEqual(r.getModWarnings(), [])
    const command = r
      .getModCommands()
      .find(entry => entry.name === 'live-probe')
    const answer = JSON.parse(
      (await (await command.load()).call(current.name, context)).value,
    )
    assert.ok(answer.inventory.some(tool => tool.name === current.name))
    assert.equal(
      answer.inventory.some(tool => tool.name === removed.name),
      false,
    )
    assert.ok(['allow', 'ask'].includes(answer.check.decision))
    assert.equal(
      calls.length,
      1,
      'A query and a rejected removed tool must not execute an MCP request',
    )
    assert.equal(calls[0].arguments.value, 'actual')
    assert.equal(answer.call.text, receipt + ':actual')
    assert.equal(answer.call.result[0].text, receipt + ':actual')
    assert.match(answer.removed, /Tool is not available: mcp__removed__old/)
    assert.deepEqual(
      seenClients,
      [currentClients],
      'Execution must inherit the clients paired with its tool snapshot',
    )
    assert.ok(
      refreshes >= 4,
      'Each list/check/call resolves its current inventory',
    )
    assert.equal(
      context.options.mcpClients,
      oldClients,
      'An API invocation must not replace the parent snapshot',
    )
  } finally {
    await r.stopPluginMods()
    r.fetchToolsForClient.cache.clear()
    await client.close()
    await server.close()
  }
})

test('tool snapshot fallback supports legacy refresh and fixed inventories', () => {
  const initial = fixtureTool(),
    refreshed = fixtureTool({ name: 'refreshed' })
  const context = fixtureContext([initial])
  assert.equal(r.readModToolSnapshot(context).tools, context.options.tools)
  context.options.refreshTools = () => [refreshed]
  assert.deepEqual(r.readModToolSnapshot(context), {
    tools: [refreshed],
    mcpClients: context.options.mcpClients,
  })
})

test('mod APIs preserve restricted invocation scopes while live refresh includes new registrations', async () => {
  const inspect = `
    const tool='mcp__scoped-probe__calculate';
    const inventory=await $.tool.list();
    let check,call;
    try { check=await $.tool.check({tool,input:{value:19}}) } catch(error) { check={error:String(error)} }
    try { call=await $.tool.call({tool,value:19}) } catch(error) { call={error:String(error)} }
    const observed={inventory,check,call};
  `
  const plugin = join(root, 'scoped-plugin')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  mkdirSync(join(plugin, 'hooks'))
  writeFileSync(
    join(plugin, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'scoped-probe', version: '1.0.0' }),
  )
  writeFileSync(
    join(plugin, 'hooks/hooks.json'),
    JSON.stringify({ modules: ['./register.ts'] }),
  )
  writeFileSync(
    join(plugin, 'hooks/register.ts'),
    `export function register(on) {
    on('session.start',async($,e,next)=>{
      await $.tool.register({name:'calculate',description:'Calculate a value',isDeferred:false,
        inputSchema:{type:'object',properties:{value:{type:'integer'}},required:['value']}});
      await $.command.register({name:'scope-probe',description:'Inspect scoped tools'});return next(e);
    });
    on('command.run',{command:'scope-probe'},async($)=>{${inspect}return {text:JSON.stringify(observed)}});
    on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{
      ${inspect}await $.fs.write('scoped-api-observed.json',JSON.stringify(observed));return next(e);
    });
    on('tool.call',{tool:'mcp__scoped-probe__calculate'},async($,e)=>{
      await $.fs.write('registered-api-entered.json',JSON.stringify(e));return {result:{value:e.value*2}};
    });
  }`,
  )
  r.setInlinePlugins([plugin])
  r.resetSettingsCache()
  r.clearAllCaches()
  await r.startPluginMods(true)
  try {
    assert.deepEqual(
      r.getModWarnings(),
      [],
      'The compiled mod must load before testing its scope',
    )
    const candidate = fixtureTool({ isEnabled: () => true })
    const context = fixtureContext([candidate], {
      agentId: 'restricted-child',
    })
    context.canUseTool = async (_tool, input) => ({
      behavior: 'allow',
      updatedInput: input,
    })
    const call = {
      type: 'tool_use',
      id: 'restricted-model-call',
      name: candidate.name,
      input: {},
    }
    const updates = []
    for await (const _update of r.runToolUse(
      call,
      {
        type: 'assistant',
        uuid: 'restricted-assistant',
        message: { id: 'restricted-message', content: [call] },
      },
      context.canUseTool,
      context,
    )) {
      updates.push(_update)
    }
    assert.equal(
      existsSync(join(project, 'scoped-api-observed.json')),
      true,
      JSON.stringify({ warnings: r.getModWarnings(), updates }),
    )
    const excluded = JSON.parse(
      readFileSync(join(project, 'scoped-api-observed.json'), 'utf8'),
    )
    const registeredName = 'mcp__scoped-probe__calculate'
    assert.equal(
      excluded.inventory.some(tool => tool.name === registeredName),
      false,
    )
    assert.match(excluded.check.error, /Tool is not available/)
    assert.match(excluded.call.error, /Tool is not available/)
    assert.equal(
      candidate.calls.length,
      1,
      'The permitted model action must still execute',
    )
    const command = r
      .getModCommands()
      .find(entry => entry.name === 'scope-probe')
    const main = fixtureContext([candidate])
    main.canUseTool = context.canUseTool
    const restrictedMain = JSON.parse(
      (await (await command.load()).call('', main)).value,
    )
    assert.equal(
      restrictedMain.inventory.some(tool => tool.name === registeredName),
      false,
    )
    assert.match(restrictedMain.call.error, /Tool is not available/)
    assert.equal(
      existsSync(join(project, 'registered-api-entered.json')),
      false,
      'Excluded registrations must never enter their mod handler',
    )
    for (const mode of ['refreshTools', 'refreshMcpContext']) {
      const fresh = fixtureContext([candidate])
      fresh.canUseTool = context.canUseTool
      fresh.options[mode] =
        mode === 'refreshTools'
          ? () => [candidate, ...r.getModTools()]
          : () => ({ tools: [candidate, ...r.getModTools()], mcpClients: [] })
      const included = JSON.parse(
        (await (await command.load()).call('', fresh)).value,
      )
      assert.equal(
        included.inventory.some(tool => tool.name === registeredName),
        true,
      )
      assert.equal(included.check.decision, 'ask')
      assert.deepEqual(included.call.result, { value: 38 })
    }
    assert.deepEqual(r.getModWarnings(), [])
    const previous = r.getModTools()[0]
    const scoped = fixtureContext([candidate, previous])
    await r.startPluginMods(true)
    const replacement = r
      .getModTools()
      .find(tool => tool.name === registeredName)
    assert.notEqual(previous, replacement)
    assert.deepEqual(
      r.readModToolSnapshot(scoped).tools,
      [candidate, replacement],
      'Reload must refresh an already permitted name',
    )
    await r.stopPluginMods()
    assert.deepEqual(
      r.readModToolSnapshot(scoped).tools,
      [candidate],
      'Disabling must remove stale permitted registrations',
    )
  } finally {
    await r.stopPluginMods()
  }
})
