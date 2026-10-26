import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const original = process.cwd(),
  root = mkdtempSync(join(tmpdir(), 'tau-mod-registration-'))
const project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '',
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: [
    'src/utils/plugins/mods/tools.ts',
    'src/utils/plugins/mods/manager.ts',
    'src/utils/plugins/refresh.ts',
    'src/utils/toolPool.ts',
  ],
  exports: [
    'createModToolRegistry',
    'publishModToolRegistries',
    'getModTools',
    'getModToolRevision',
    'subscribeModTools',
    'filterCurrentModTools',
    'getToolSchemaCache',
    'assembleToolPool',
    'getMergedTools',
    'mergeAndFilterTools',
    'checkMcpArguments',
    'getDefaultAppState',
    'getManagedFilePath',
    'setOriginalCwd',
    'setSessionTrustAccepted',
    'setAllowedSettingSources',
    'setIsInteractive',
    'setInlinePlugins',
    'clearAllCaches',
    'resetSettingsCache',
    'startPluginMods',
    'stopPluginMods',
    'getModWarnings',
    'refreshActivePlugins',
    'setPluginEnabledOp',
    'getModCommands',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setIsInteractive(false)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const reset = () => {
  r.resetSettingsCache()
  r.clearAllCaches()
}
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
afterEach(async () => {
  await r.stopPluginMods()
  await r.publishModToolRegistries([])
  r.setInlinePlugins([])
  reset()
})
after(() => {
  process.chdir(original)
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

test('registered tool metadata has stable schemas, names and conservative permissions', async () => {
  let current = true
  const registry = r.createModToolRegistry({
    plugin: 'pricing-test',
    isCurrent: () => current,
    reserved: new Map(),
    changed: async () => {},
  })
  const schema = {
    type: 'object',
    properties: { units: { type: 'integer', minimum: 1 } },
    required: ['units'],
    additionalProperties: false,
  }
  assert.deepEqual(
    await registry.register({
      name: 'quote',
      description: 'Calculate an amount',
      inputSchema: schema,
    }),
    { tool: 'mcp__pricing-test__quote' },
  )
  await r.publishModToolRegistries([registry])
  const tool = r.getModTools()[0]
  assert.equal(tool.isMcp, true)
  assert.equal(tool.shouldDefer, true)
  assert.equal(tool.alwaysLoad, false)
  assert.deepEqual(tool.mcpInfo, {
    serverName: 'pricing-test',
    toolName: 'quote',
  })
  assert.deepEqual(tool.inputJSONSchema, schema)
  assert.equal(tool.isReadOnly({}), false)
  assert.equal(tool.isConcurrencySafe({}), false)
  assert.equal((await tool.checkPermissions({})).behavior, 'passthrough')
  assert.equal(r.checkMcpArguments(tool, { units: 3 }).ok, true)
  assert.equal(r.checkMcpArguments(tool, { units: 'wrong' }).ok, false)
  assert.equal(
    r.checkMcpArguments(tool, { units: 3, invented: true }).ok,
    false,
  )
  await registry.register({
    name: 'quote',
    description: 'Calculate an amount',
    inputSchema: schema,
  })
  assert.equal(
    r.getModTools()[0],
    tool,
    'Unchanged registrations retain the schema object',
  )
  current = false
  assert.equal(r.getModTools().length, 0)
  assert.equal((await tool.checkPermissions({})).behavior, 'deny')
  await assert.rejects(tool.call({}), /no longer available/)
})

test('metadata replacement refreshes only its own schema cache and rejects malformed specs', async () => {
  const registry = r.createModToolRegistry({
    plugin: 'metadata',
    isCurrent: () => true,
    reserved: new Map(),
    changed: async () => {},
  })
  await registry.register({ name: 'count', description: 'First description' })
  await r.publishModToolRegistries([registry])
  const first = r.getModTools()[0],
    cache = r.getToolSchemaCache()
  const unrelated = {
    name: 'Read',
    description: 'Original Read prompt',
    input_schema: { type: 'object' },
  }
  cache.set('Read', unrelated)
  cache.set(first.name + ':' + JSON.stringify(first.inputJSONSchema), {
    name: first.name,
    description: 'First description',
    input_schema: first.inputJSONSchema,
  })
  const before = r.getModToolRevision()
  let notifications = 0
  const unsubscribe = r.subscribeModTools(() => {
    notifications++
  })
  try {
    await registry.register({
      name: 'count',
      description: 'Changed description',
      isDeferred: false,
    })
  } finally {
    unsubscribe()
  }
  const replaced = r.getModTools()[0]
  assert.notEqual(first, replaced)
  assert.equal(first.isEnabled(), false)
  assert.equal(await replaced.prompt({}), 'Changed description')
  assert.equal(replaced.alwaysLoad, true)
  assert.equal(cache.get('Read'), unrelated)
  assert.equal(
    [...cache.values()].some((value) => value.name === first.name),
    false,
  )
  assert.ok(r.getModToolRevision() > before)
  assert.equal(notifications, 1)
  for (const value of [
    null,
    { name: 'bad name', description: 'Bad' },
    { name: 'valid', description: 3 },
    { name: 'valid', description: 'x', inputSchema: [] },
    { name: 'valid', description: 'x', inputSchema: { type: 'string' } },
    {
      name: 'valid',
      description: 'x',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'invalid-type' } },
      },
    },
  ])
    await assert.rejects(registry.register(value))
  const cyclic = {}
  cyclic.self = cyclic
  await assert.rejects(
    registry.register({ name: 'cycle', description: '', inputSchema: cyclic }),
    /cycles/,
  )
  await assert.rejects(
    registry.register({
      name: 'function',
      description: '',
      inputSchema: { type: 'object', value() {} },
    }),
    /JSON data/,
  )
})

test('tool pools keep registered tools deferred and omit denied or stale snapshots', async () => {
  let current = true
  const registry = r.createModToolRegistry({
    plugin: 'pool',
    isCurrent: () => current,
    reserved: new Map(),
    changed: async () => {},
  })
  await registry.register({ name: 'work', description: 'Pool work' })
  await r.publishModToolRegistries([registry])
  const tool = r.getModTools()[0],
    state = r.getDefaultAppState()
  const baseline = r.assembleToolPool(state.toolPermissionContext, [])
  assert.equal(baseline.filter((item) => item.name === tool.name).length, 1)
  const firstMcp = baseline.findIndex((item) => item.isMcp)
  assert.ok(baseline.slice(0, firstMcp).every((item) => !item.isMcp))
  const denied = {
    ...state.toolPermissionContext,
    alwaysDenyRules: { localSettings: [tool.name] },
  }
  assert.equal(
    r.assembleToolPool(denied, []).some((item) => item.name === tool.name),
    false,
  )
  assert.equal(
    r.getMergedTools(denied, []).some((item) => item.name === tool.name),
    false,
  )
  current = false
  await r.publishModToolRegistries([])
  const fresh = r.assembleToolPool(state.toolPermissionContext, [tool])
  assert.equal(
    fresh.some((item) => item.name === tool.name),
    false,
  )
  assert.equal(
    r
      .mergeAndFilterTools(
        [tool],
        fresh,
        state.toolPermissionContext.mode,
        state.settings,
      )
      .some((item) => item.name === tool.name),
    false,
  )
})

test('actual plugin startup registers metadata, disable removes it, and reload replaces changed schemas', async () => {
  const plugin = join(root, 'actual-plugin'),
    id = 'registered@inline'
  write(join(plugin, '.claude-plugin/plugin.json'), {
    name: 'registered',
    version: '1.0.0',
  })
  write(join(plugin, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  const source = (version) =>
    `export function register(on){on('session.start',async($,e,next)=>{const result=await $.tool.register({name:'calculate',description:'Description ${version}',inputSchema:{type:'object',properties:{value:{type:'${version === 1 ? 'integer' : 'string'}'}},required:['value']}});const list=await $.tool.list();await $.fs.write('startup-tool.json',JSON.stringify({result,listed:list.some(t=>t.name===result.tool)}));return next(e)});}`
  write(join(plugin, 'hooks/register.ts'), source(1))
  r.setInlinePlugins([plugin])
  reset()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  assert.deepEqual(
    JSON.parse(readFileSync(join(project, 'startup-tool.json'), 'utf8')),
    { result: { tool: 'mcp__registered__calculate' }, listed: true },
  )
  const first = r
    .getModTools()
    .find((tool) => tool.name === 'mcp__registered__calculate')
  assert.ok(first)
  const app = r.createStore(r.getDefaultAppState())
  const cache = r.getToolSchemaCache()
  const key = first.name + ':' + JSON.stringify(first.inputJSONSchema)
  const cached = {
    name: first.name,
    description: 'Description 1',
    input_schema: first.inputJSONSchema,
  }
  const unrelated = {
    name: 'Read',
    description: 'Unrelated stable tool',
    input_schema: { type: 'object' },
  }
  cache.set(key, cached)
  cache.set('Read', unrelated)
  await r.refreshActivePlugins(app.setState)
  assert.equal(
    cache.get(key),
    cached,
    'An unchanged mod reload preserves its rendered tool schema',
  )
  assert.equal(cache.get('Read'), unrelated)
  assert.notEqual(
    r.getModTools().find((tool) => tool.name === first.name),
    first,
    'Reload replaces the execution worker while retaining schema metadata',
  )
  write(join(plugin, 'hooks/register.ts'), source(2))
  await r.refreshActivePlugins(app.setState)
  const second = r.getModTools().find((tool) => tool.name === first.name)
  assert.notEqual(second, first)
  assert.equal(first.isEnabled(), false)
  assert.equal(await second.prompt({}), 'Description 2')
  assert.equal(second.inputJSONSchema.properties.value.type, 'string')
  assert.equal(
    cache.has(key),
    false,
    'A changed mod definition invalidates the old tool schema',
  )
  assert.equal(cache.get('Read'), unrelated)
  assert.equal((await r.setPluginEnabledOp(id, false)).success, true)
  await r.refreshActivePlugins(app.setState)
  assert.equal(
    r.getModTools().some((tool) => tool.name === first.name),
    false,
  )
  await assert.rejects(second.call({}), /no longer available/)
})
