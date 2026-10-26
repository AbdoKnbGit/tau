import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { after, test } from 'node:test'
import { loadMcpRuntime, fixtureContext } from './helpers/mcp-built-runtime.mjs'

const previousCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-mod-read-cache-'))
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
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)

const r = await loadMcpRuntime({
  paths: [
    'src/tools/FileReadTool/FileReadTool.ts',
    'src/utils/fileStateCache.ts',
    'src/utils/plugins/mods/manager.ts',
    'src/utils/plugins/refresh.ts',
    'src/state/AppState.tsx',
    'src/state/store.ts',
  ],
  exports: [
    'FileReadTool', 'createFileStateCacheWithSizeLimit',
    'startPluginMods', 'stopPluginMods', 'getModCommands', 'getModWarnings',
    'setInlinePlugins', 'clearAllCaches', 'resetSettingsCache', 'setOriginalCwd',
    'setSessionTrustAccepted', 'setAllowedSettingSources', 'setIsInteractive',
    'getManagedFilePath', 'getDefaultAppState', 'createStore',
    'setPluginEnabledOp', 'refreshActivePlugins', 'createAssistantMessage',
    'registerHookCallbacks','clearRegisteredHooks',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

after(async () => {
  await r.stopPluginMods()
  r.clearRegisteredHooks()
  r.setInlinePlugins([])
  r.resetSettingsCache()
  r.clearAllCaches()
  process.chdir(previousCwd)
  rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})

const canUseTool = async (_tool, input) => ({ behavior: 'allow', updatedInput: input })

async function read(context, filePath) {
  const call = { type: 'tool_use', id: randomUUID(), name: 'Read', input: { file_path: filePath } }
  const assistant = r.createAssistantMessage({ content: [call] })
  const updates = []
  for await (const update of r.runToolUse(call, assistant, canUseTool, context))
    updates.push(update)
  context.messages.push(assistant)
  for (const update of updates) {
    if (update.contextModifier) {
      const changed = update.contextModifier.modifyContext(context)
      if (changed !== context) Object.assign(context, changed)
    }
    if (update.message) context.messages.push(update.message)
  }
  const result = updates.find(update => update.message?.message?.content?.some?.(
    block => block.type === 'tool_result' && block.tool_use_id === call.id,
  ))?.message
  assert.ok(result, 'The shipped tool pipeline must return a result for this exact Read')
  const block = result.message.content.find(block => block.type === 'tool_result' && block.tool_use_id === call.id)
  assert.notEqual(block.is_error, true, JSON.stringify(block))
  return { raw: result.toolUseResult, text: block.content }
}

test('redirected native Reads survive disable and re-enable in one session without clearing ordinary caches', async () => {
  const suffix = randomBytes(5).toString('hex')
  const requested = join(project, `requested-${suffix}.txt`)
  const target = join(project, `target-${suffix}.txt`)
  const unrelated = join(project, `unrelated-${suffix}.txt`)
  const apiFile = join(project, `api-${suffix}.txt`)
  const targetText = `Target receipt: ${randomUUID()}\n`
  const decoyText = `Original receipt: ${randomUUID()}\n`
  const unrelatedText = `Unrelated receipt: ${randomUUID()}\n`
  const apiText = `API receipt: ${randomUUID()}\n`
  for (const [path, text] of [[requested, decoyText], [target, targetText], [unrelated, unrelatedText], [apiFile, apiText]])
    write(path, text)

  const plugin = join(root, 'plugin')
  const pluginName = 'redirect-' + suffix
  const commandName = 'read-pair-' + suffix
  const id = pluginName + '@inline'
  write(join(plugin, '.claude-plugin/plugin.json'), { name: pluginName, version: '1.0.0' })
  write(join(plugin, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(join(plugin, 'hooks/register.ts'), `export function register(on) {
    on('session.start', async ($, e, next) => {
      await $.command.register({name:${JSON.stringify(commandName)},description:'Read twice through the host API'});
      return next(e);
    });
    on('tool.call', {tool:'Read'}, async ($, e, next) => {
      return next(e.file_path === ${JSON.stringify(requested)} ? {...e,file_path:${JSON.stringify(target)}} : e);
    });
    on('command.run', {command:${JSON.stringify(commandName)}}, async ($) => {
      const first = await $.tool.call({tool:'Read',file_path:${JSON.stringify(apiFile)}});
      const second = await $.tool.call({tool:'Read',file_path:${JSON.stringify(apiFile)}});
      return {text:JSON.stringify({first,second})};
    });
  }`)
  r.setInlinePlugins([plugin])
  r.resetSettingsCache()
  r.clearAllCaches()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])

  const app = r.createStore(r.getDefaultAppState())
  const initial = fixtureContext([r.FileReadTool])
  const context = {
    ...initial,
    options: { ...initial.options, mainLoopModel: 'claude-sonnet-4-6' },
    getAppState: app.getState,
    setAppState: app.setState,
    readFileState: r.createFileStateCacheWithSizeLimit(20),
    fileReadingLimits: { maxSizeBytes: 1_000_000, maxTokens: 1_000_000 },
    updateFileHistoryState() {},
    canUseTool,
  }
  const sameContext = context
  const sameCache = context.readFileState
  const sameMessages = context.messages
  assert.equal((await read(context, unrelated)).raw.type, 'text')
  const unrelatedState = sameCache.get(unrelated)
  assert.equal((await read(context, unrelated)).raw.type, 'file_unchanged', 'Ordinary model Read dedup must remain enabled')

  const baseline = await read(context, requested)
  assert.equal(baseline.raw.type, 'text')
  assert.equal(baseline.raw.file.content, targetText)
  assert.ok(baseline.text.includes(targetText.trim()))
  assert.equal(sameCache.get(target).hiddenRead, true, 'A redirected body cannot be reused under its original tool input identity')

  assert.equal((await r.setPluginEnabledOp(id, false)).success, true)
  await r.refreshActivePlugins(app.setState)
  const disabled = await read(context, requested)
  assert.equal(disabled.raw.type, 'text')
  assert.equal(disabled.raw.file.content, decoyText)
  assert.equal(sameCache.get(unrelated), unrelatedState)

  assert.equal((await r.setPluginEnabledOp(id, true)).success, true)
  await r.refreshActivePlugins(app.setState)
  assert.deepEqual(r.getModWarnings(), [])
  const restored = await read(context, requested)
  assert.equal(restored.raw.type, 'text', 'The restored rewrite must return the target body rather than an unchanged-file stub')
  assert.equal(restored.raw.file.content, targetText)
  assert.ok(restored.text.includes(targetText.trim()))
  assert.ok(!restored.text.includes(decoyText.trim()))
  assert.equal(context, sameContext)
  assert.equal(context.readFileState, sameCache)
  assert.equal(context.messages, sameMessages)
  assert.equal(sameCache.get(unrelated), unrelatedState, 'Reload must not clear unrelated file state')

  const direct = await read(context, target)
  assert.equal(direct.raw.type, 'text', 'The first direct Read must not refer back to an aliased result')
  assert.equal(direct.raw.file.content, targetText)
  assert.equal((await read(context, relative(project, target))).raw.type, 'file_unchanged', 'Equivalent direct paths still dedup after a visible native Read')
  assert.equal((await read(context, unrelated)).raw.type, 'file_unchanged')
  assert.equal(sameCache.get(unrelated), unrelatedState)

  assert.equal((await read(context, apiFile)).raw.type, 'text')
  assert.equal((await read(context, apiFile)).raw.type, 'file_unchanged', 'Prewarm the exact API target through ordinary native Read')
  assert.equal(context.readResultHidden, undefined)
  const command = r.getModCommands().find(command => command.name === commandName)
  assert.ok(command, 'Re-enabled mod must restore its local API command')
  const api = JSON.parse((await (await command.load()).call('', context)).value)
  for (const result of [api.first, api.second]) {
    assert.equal(result.result.type, 'text', 'Each code-consumed Read needs the real body, even with a warm cache')
    assert.equal(result.result.file.content, apiText)
    assert.ok(result.text.includes(apiText.trim()))
    assert.equal(result.isError, undefined)
  }
  assert.equal(context.readFileState, sameCache)
  assert.equal(context.readResultHidden, undefined, 'Temporary API read policy must not leak onto the parent context')
  assert.equal((await read(context, unrelated)).raw.type, 'file_unchanged', 'Ordinary dedup still works after nested API calls')
  assert.equal(sameCache.get(unrelated), unrelatedState)
  for (const [path, text] of [[requested, decoyText], [target, targetText], [unrelated, unrelatedText], [apiFile, apiText]])
    assert.equal(readFileSync(path, 'utf8'), text)
})

test('a replaced Read body is not reused as a cache anchor after the plugin is disabled',async()=>{
  await r.stopPluginMods()
  const file=join(project,'rewritten-output.txt'),body='Actual disk receipt: '+randomUUID()+'\n'
  write(file,body)
  const plugin=join(root,'output-plugin')
  write(join(plugin,'.claude-plugin/plugin.json'),{name:'output-view',version:'1.0.0'})
  write(join(plugin,'hooks/hooks.json'),{modules:['./register.ts']})
  write(join(plugin,'hooks/register.ts'),`export function register(on){on('tool.call',{tool:'Read'},async($,e,next)=>{const r=await next(e);return {...r,result:{...r.result,file:{...r.result.file,content:'Replaced visible view'}}}})}`)
  r.setInlinePlugins([plugin]);r.resetSettingsCache();r.clearAllCaches();await r.startPluginMods(true)
  const initial=fixtureContext([r.FileReadTool]),app=r.createStore(r.getDefaultAppState())
  const context={...initial,options:{...initial.options,mainLoopModel:'claude-sonnet-4-6'},getAppState:app.getState,setAppState:app.setState,readFileState:r.createFileStateCacheWithSizeLimit(20),fileReadingLimits:{maxSizeBytes:1000000,maxTokens:1000000},updateFileHistoryState(){},canUseTool}
  assert.ok((await read(context,file)).text.includes('Replaced visible view'))
  assert.equal((await r.setPluginEnabledOp('output-view@inline',false)).success,true)
  await r.refreshActivePlugins(app.setState)
  const actual=await read(context,file)
  assert.equal(actual.raw.type,'text','The model never received the cached disk body')
  assert.ok(actual.text.includes(body.trim()))
  assert.equal(readFileSync(file,'utf8'),body)
})

test('classic PostToolUse output replacement invalidates only the affected native Read view',async()=>{
  await r.stopPluginMods();r.setInlinePlugins([]);r.resetSettingsCache();r.clearAllCaches()
  const file=join(project,'classic-output.txt'),body='Classic original receipt: '+randomUUID()+'\n'
  write(file,body)
  const initial=fixtureContext([r.FileReadTool]),app=r.createStore(r.getDefaultAppState())
  const context={...initial,options:{...initial.options,mainLoopModel:'claude-sonnet-4-6'},getAppState:app.getState,setAppState:app.setState,readFileState:r.createFileStateCacheWithSizeLimit(20),fileReadingLimits:{maxSizeBytes:1000000,maxTokens:1000000},updateFileHistoryState(){},canUseTool}
  r.registerHookCallbacks({PostToolUse:[{matcher:'Read',hooks:[{type:'callback',callback:async input=>({hookSpecificOutput:{hookEventName:'PostToolUse',updatedToolOutput:{...input.tool_response,file:{...input.tool_response.file,content:'Classic replacement view'}}}})}]}]})
  try {
    assert.ok((await read(context,file)).text.includes('Classic replacement view'))
    r.clearRegisteredHooks()
    const original=await read(context,file)
    assert.equal(original.raw.type,'text')
    assert.ok(original.text.includes(body.trim()))
  } finally { r.clearRegisteredHooks() }
})
