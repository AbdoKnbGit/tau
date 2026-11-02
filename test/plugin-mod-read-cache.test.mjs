import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { after, test } from 'node:test'
import { loadMcpRuntime, fixtureContext } from './helpers/mcp-built-runtime.mjs'

const previousCwd = process.cwd()
// Node resolves cwd physically after chdir (e.g. macOS /var -> /private/var).
// This fixture tests absolute/relative spellings of that cwd, not distinct
// symlink aliases, which intentionally may carry separate Read histories.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-mod-read-cache-')))
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

// The bundle also contains a git helper named getChangedFiles.
const builtAttachments = readFileSync(process.env.TAU_MCP_TEST_BUNDLE, 'utf8').split('\n// src/utils/attachments.ts\n')[1]
const changedFiles = /\nasync function (getChangedFiles\d*)\(/.exec(builtAttachments)[1]
const r = await loadMcpRuntime({
  paths: [
    'src/tools/FileReadTool/FileReadTool.ts',
    'src/utils/fileStateCache.ts',
    'src/utils/plugins/mods/manager.ts',
    'src/utils/plugins/refresh.ts',
    'src/state/AppState.tsx',
    'src/state/store.ts',
    'src/utils/attachments.ts', 'src/services/compact/compact.ts',
    'src/tools/FileWriteTool/FileWriteTool.ts', 'src/tools/FileEditTool/FileEditTool.ts',
    'src/tools/NotebookEditTool/NotebookEditTool.ts', 'src/utils/queryHelpers.ts',
  ],
  exports: [
    'FileReadTool', 'createFileStateCacheWithSizeLimit',
    'startPluginMods', 'stopPluginMods', 'getModCommands', 'getModWarnings',
    'setInlinePlugins', 'clearAllCaches', 'resetSettingsCache', 'setOriginalCwd',
    'setSessionTrustAccepted', 'setAllowedSettingSources', 'setIsInteractive',
    'getManagedFilePath', 'getDefaultAppState', 'createStore',
    'setPluginEnabledOp', 'refreshActivePlugins', 'createAssistantMessage',
    'registerHookCallbacks','clearRegisteredHooks',
    `getChangedFiles: ${changedFiles}`, 'createAttachmentMessage', 'normalizeMessagesForAPI', 'createUserMessage',
    'FileWriteTool', 'FileEditTool', 'NotebookEditTool', 'createPostCompactFileAttachments', 'extractReadFilesFromMessages',
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

async function read(context, filePath, range = {}) {
  const call = { type: 'tool_use', id: randomUUID(), name: 'Read', input: { file_path: filePath, ...range } }
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
  assert.equal(await canWrite({ ...context, readFileState: r.extractReadFilesFromMessages(context.messages, project) }, file), false,
    'resuming a rewritten Read must not authorize writing the hidden contents')
  assert.equal(await canWrite(context, file), false, 'the replaced result did not expose the disk contents for Write')
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
    assert.equal(await canWrite({ ...context, readFileState: r.extractReadFilesFromMessages(context.messages, project) }, file), false,
      'resuming the classic hook result keeps the same protection')
    assert.equal(await canWrite(context, file), false, 'a classic output hook also hid the disk contents')
    r.clearRegisteredHooks()
    const original=await read(context,file)
    assert.equal(original.raw.type,'text')
    assert.ok(original.text.includes(body.trim()))
  } finally { r.clearRegisteredHooks() }
})

function fileNoticeContext() {
  const initial=fixtureContext([r.FileReadTool]),app=r.createStore(r.getDefaultAppState())
  return {...initial,options:{...initial.options,mainLoopModel:'claude-sonnet-4-6'},getAppState:app.getState,
    setAppState:app.setState,readFileState:r.createFileStateCacheWithSizeLimit(20),
    fileReadingLimits:{maxSizeBytes:1000000,maxTokens:1000000},updateFileHistoryState(){},canUseTool}
}

function externalChange(file, content) {
  const nextTime=statSync(file).mtimeMs+2000
  write(file,content)
  utimesSync(file,nextTime/1000,nextTime/1000)
}

test('whole-file Read changes appear only on the newest turn, once per external change',async()=>{
  await r.stopPluginMods();r.setInlinePlugins([]);r.resetSettingsCache();r.clearAllCaches()
  const file=join(project,'external-change.txt'),context=fileNoticeContext()
  const first='Original '+randomUUID()+'\n',second='Changed '+randomUUID()+'\n',third='Changed again '+randomUUID()+'\n'
  write(file,first)
  await read(context,file)
  assert.equal(context.readFileState.get(file).offset,1,'Read storage stays unchanged')
  context.messages.push(r.createAssistantMessage({content:[{type:'text',text:'Read complete'}]}))
  const prior=r.normalizeMessagesForAPI(context.messages,[r.FileReadTool],{model:'claude-sonnet-4-6'})
  const priorBytes=JSON.stringify(prior)
  const touched=statSync(file).mtimeMs+2000
  utimesSync(file,touched/1000,touched/1000)
  assert.deepEqual(await r.getChangedFiles(context),[],'Touching unchanged text produces no notice')
  externalChange(file,second)
  const notices=await r.getChangedFiles(context)
  assert.equal(notices.length,1,'A whole-file native Read must receive its external-change notice')
  assert.equal(notices[0].type,'edited_text_file')
  assert.ok(notices[0].snippet.includes(second.trim()))
  assert.deepEqual(await r.getChangedFiles(context),[],'The same change is delivered once')
  context.messages.push(r.createUserMessage({content:'Next turn'}),...notices.map(r.createAttachmentMessage))
  const next=r.normalizeMessagesForAPI(context.messages,[r.FileReadTool],{model:'claude-sonnet-4-6'})
  assert.equal(JSON.stringify(next.slice(0,prior.length)),priorBytes,'Earlier request bytes stay unchanged')
  assert.ok(JSON.stringify(next.slice(prior.length)).includes(second.trim()),'The next request carries the new text')
  assert.equal((await read(context,file)).raw.type,'text','A hidden diff must not become an unchanged-file Read stub')
  externalChange(file,third)
  const again=await r.getChangedFiles(context)
  assert.equal(again.length,1)
  assert.ok(again[0].snippet.includes(third.trim()))
  assert.deepEqual(await r.getChangedFiles(context),[])
  await read(context,file)
  await r.FileEditTool.call({file_path:file,old_string:third.trim(),new_string:'Model edited'},context,canUseTool,
    r.createAssistantMessage({content:[]}))
  assert.deepEqual(await r.getChangedFiles(context),[],'The model Edit produces no external-change notice')
  await r.FileWriteTool.call({file_path:file,content:'Model wrote\n'},context,canUseTool,
    r.createAssistantMessage({content:[]}))
  assert.deepEqual(await r.getChangedFiles(context),[],'The model Write produces no external-change notice')
  assert.equal(context.readFileState.get(file).offset,undefined)
  externalChange(file,'External change after Write\n')
  assert.equal((await r.getChangedFiles(context)).length,1,'An undefined whole-file offset remains tracked too')
})

test('changed-file notices skip ranged Reads but track files restored after compaction',async()=>{
  const context=fileNoticeContext()
  for(const [name,range]of [['offset',{offset:2}],['limit',{limit:1}]]) {
    const file=join(project,'ranged-'+name+'.txt')
    write(file,'first\nsecond\nthird\n')
    await read(context,file,range)
    externalChange(file,'changed first\nchanged second\nthird\n')
  }
  assert.deepEqual(await r.getChangedFiles(context),[],'Ranged content is not a whole-file anchor')
  const file=join(project,'post-compact-change.txt')
  write(file,'Restored original\n')
  await read(context,file)
  const restored=fileNoticeContext()
  const attachments=await r.createPostCompactFileAttachments({[file]:{timestamp:context.readFileState.get(file).timestamp}},restored,5)
  assert.equal(attachments.length,1,'The normal compaction restore performs its native file Read')
  assert.equal(restored.readFileState.get(file).offset,1)
  externalChange(file,'Restored changed\n')
  const notices=await r.getChangedFiles(restored)
  assert.equal(notices.length,1,'A compaction-restored whole-file Read is still tracked')
  assert.ok(notices[0].snippet.includes('Restored changed'))
})

const rows = (label, count = 1500) => Array.from({ length: count }, (_, i) => `line ${i} ${label} ${randomUUID()}`).join('\n') + '\n'
const canWrite = async (context, file) => (await r.FileWriteTool.validateInput({ file_path: file, content: 'from memory' }, context)).result

test('a complete change notice lets Write go on; one the model saw only in part asks for a real Read', async () => {
  const context = fileNoticeContext()
  const small = join(project, 'complete-notice.txt')
  write(small, 'first\nsecond\n')
  await read(context, small)
  externalChange(small, 'first\nchanged\n')
  assert.equal((await r.getChangedFiles(context))[0].snippet.includes('changed'), true)
  assert.equal(await canWrite(context, small), true, 'The model received the whole change')

  const big = join(project, 'truncated-notice.txt')
  write(big, rows('before'))
  await read(context, big)
  const after = rows('after')
  externalChange(big, after)
  const notices = await r.getChangedFiles(context)
  assert.match(notices[0].snippet, /lines truncated/)
  assert.equal(await canWrite(context, big), false, 'Write must not replace text the notice cut off')
  const line = after.split('\n')[1400]
  assert.equal((await r.FileEditTool.validateInput({ file_path: big, old_string: line, new_string: 'edited' }, context)).result, true,
    'Edit stays safe because old_string has to match the file on disk')
  assert.deepEqual(await r.getChangedFiles(context), [], 'The same change is delivered once')
})

test('a real Read after a partial notice restores Write', async () => {
  const context = fileNoticeContext(), big = join(project, 'partial-then-read.txt')
  write(big, rows('before'))
  await read(context, big)
  externalChange(big, rows('after'))
  await r.getChangedFiles(context)
  assert.equal(await canWrite(context, big), false)
  assert.equal((await read(context, big)).raw.type, 'text')
  assert.equal(await canWrite(context, big), true)
})

test('a notebook changed on disk stays stale until a real Read', async () => {
  const context = fileNoticeContext(), file = join(project, 'changed.ipynb')
  const notebook = source => JSON.stringify({ cells: [{ cell_type: 'code', id: 'cell-1', source: [source], metadata: {}, outputs: [], execution_count: null }],
    metadata: { language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 })
  const edit = { notebook_path: file, cell_id: 'cell-1', new_source: 'print(3)', edit_mode: 'replace' }
  write(file, notebook('print(1)\n'))
  await read(context, file)
  externalChange(file, notebook('print(2)\n'))
  assert.deepEqual(await r.getChangedFiles(context), [], 'A notebook has no diff to announce')
  assert.equal((await r.NotebookEditTool.validateInput(edit, context)).result, false, 'NotebookEdit must see the new cells first')
  assert.equal(await canWrite(context, file), false, 'Write must see the new cells first')
  await read(context, file)
  assert.equal((await r.NotebookEditTool.validateInput(edit, context)).result, true)
})

test('a replaced notebook Read does not authorize a cell edit until the cells are visible', async () => {
  const context = fileNoticeContext()
  const file = join(project, 'hidden-cells.ipynb')
  write(file, { cells: [{ cell_type: 'code', id: 'cell-1', source: ['print(1)'], metadata: {}, outputs: [], execution_count: null }],
    metadata: { language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 })
  const edit = { notebook_path: file, cell_id: 'cell-1', new_source: 'print(2)', edit_mode: 'replace' }
  r.registerHookCallbacks({ PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'callback', callback: async input => ({
    hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: {
      ...input.tool_response, file: { ...input.tool_response.file, cells: [] },
    } },
  }) }] }] })
  try {
    const replaced = await read(context, file)
    assert.ok(!JSON.stringify(replaced.text).includes('print(1)'), 'the hook hid the original cells')
    await r.FileReadTool.call({ file_path: file }, { ...context, readResultHidden: true })
    assert.equal((await r.NotebookEditTool.validateInput(edit, context)).result, false)
  } finally { r.clearRegisteredHooks() }
  await read(context, file)
  assert.equal((await r.NotebookEditTool.validateInput(edit, context)).result, true)
})

test('many changed files share one diff budget, and each change is announced once', async () => {
  const context = fileNoticeContext(), files = []
  for (let n = 0; n < 12; n++) {
    const file = join(project, `budget-${n}.txt`)
    files.push(file)
    write(file, rows('before', 500))
    await read(context, file)
  }
  for (const file of files) externalChange(file, rows('after', 500))
  const notices = await r.getChangedFiles(context)
  assert.equal(notices.length, files.length, 'Every changed file is still named')
  const hidden = notices.filter(notice => notice.snippet.startsWith('[Changes not shown'))
  assert.ok(hidden.length > 0 && hidden.length < files.length)
  const total = notices.reduce((sum, notice) => sum + notice.snippet.length, 0)
  assert.ok(total <= 42 * 1024, `one round carries about 32 KB of diffs, got ${total}`)
  for (const notice of hidden) assert.equal(await canWrite(context, notice.filename), false, 'An unseen change needs a real Read')
  assert.deepEqual(await r.getChangedFiles(context), [])
})

test('touching a file with an inline source map gives no notice and keeps its unchanged Read', async () => {
  const context = fileNoticeContext(), file = join(project, 'mapped.js')
  const map = Buffer.from(JSON.stringify({ version: 3, sources: ['a.ts'], mappings: 'AAAA', names: [] })).toString('base64')
  write(file, `function a() { return 1 }\n//# sourceMappingURL=data:application/json;base64,${map}\n`)
  await read(context, file)
  const touched = statSync(file).mtimeMs + 2000
  utimesSync(file, touched / 1000, touched / 1000)
  assert.deepEqual(await r.getChangedFiles(context), [])
  assert.equal((await read(context, file)).raw.type, 'file_unchanged', 'The model still has this text')
})

test('offset 0 reads the whole file, and a file emptied on disk is still announced', async () => {
  const context = fileNoticeContext(), whole = join(project, 'offset-zero.txt'), emptied = join(project, 'emptied.txt')
  write(whole, 'first\nsecond\n')
  await read(context, whole, { offset: 0 })
  externalChange(whole, 'first\nchanged\n')
  assert.match((await r.getChangedFiles(context))[0].snippet, /changed/)
  write(emptied, 'first\nsecond\n')
  await read(context, emptied)
  externalChange(emptied, '')
  const notices = await r.getChangedFiles(context)
  assert.equal(notices.length, 1, 'Removing every line is a change the model must hear about')
  assert.match(notices[0].snippet, /Changes not shown/)
  assert.equal(await canWrite(context, emptied), false)
})

async function partialNoticeFile(name) {
  const context = fileNoticeContext(), file = join(project, `${name}.txt`)
  write(file, rows('before'))
  await read(context, file)
  const content = rows('after')
  externalChange(file, content)
  assert.match((await r.getChangedFiles(context))[0].snippet, /lines truncated/)
  assert.equal(context.readFileState.get(file).isPartialView, true)
  return { context, file, content }
}

test('failed Edit validation cannot authorize Write after a partial change notice', async () => {
  for (const failure of ['missing', 'ambiguous', 'already-applied']) {
    const { context, file, content } = await partialNoticeFile(`partial-edit-${failure}`)
    const input = {
      file_path: file,
      old_string: failure === 'ambiguous' ? 'after' : `missing-${randomUUID()}`,
      new_string: failure === 'already-applied' ? content.split('\n')[1400] : `replacement-${randomUUID()}`,
    }
    const rejected = await r.FileEditTool.validateInput(input, context)
    assert.equal(rejected.result, false)
    assert.equal(rejected.message.includes(content), false, 'This refusal did not expose the whole file')
    assert.equal(await canWrite(context, file), false, `${failure} Edit must not authorize an unseen replacement`)
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})

test('successful and no-op Edits retain partial visibility until a real Read', async () => {
  for (const noOp of [false, true]) {
    const { context, file, content } = await partialNoticeFile(`partial-edit-${noOp ? 'noop' : 'success'}`)
    const old_string = content.split('\n')[0]
    const input = { file_path: file, old_string, new_string: noOp ? old_string : `edited-${randomUUID()}` }
    assert.equal((await r.FileEditTool.validateInput(input, context)).result, true)
    await r.FileEditTool.call(input, context, canUseTool, r.createAssistantMessage({ content: [] }))
    assert.equal(await canWrite(context, file), false, `${noOp ? 'No-op' : 'Successful'} Edit did not expose the whole file`)
    assert.equal((await read(context, file)).raw.type, 'text', 'A real Read must expose previously hidden contents')
    assert.equal(await canWrite(context, file), true, 'A whole-file Read restores Write')
  }
})

test('reading a single line after a partial notice cannot authorize replacing the rest', async () => {
  const { context, file } = await partialNoticeFile('partial-edit-range')
  await read(context, file, { offset: 2, limit: 1 })
  assert.equal(await canWrite(context, file), false)
  await r.FileReadTool.call({ file_path: file }, { ...context, readResultHidden: true })
  assert.equal(await canWrite(context, file), false, 'an internal read did not reveal the rest either')
  await read(context, file)
  assert.equal(await canWrite(context, file), true)
})

test('resume keeps the partial change notice through a successful Edit and a refused Write', async () => {
  const { context, file } = await partialNoticeFile('partial-edit-resume')
  // Replay the actual persisted message shapes through the CLI's cache restorer.
  // Use a fresh change because the first notice was consumed by the fixture.
  const changed = rows('resumed')
  externalChange(file, changed)
  const [notice] = await r.getChangedFiles(context)
  assert.match(notice.snippet, /lines truncated/)
  context.messages.push(r.createAttachmentMessage(notice))
  for (const [tool, input] of [
    [r.FileEditTool, { file_path: file, old_string: changed.split('\n')[0], new_string: 'changed' }],
    [r.FileWriteTool, { file_path: file, content: 'attempted replacement' }],
  ]) {
    const id = randomUUID()
    const assistant = r.createAssistantMessage({ content: [{ type: 'tool_use', id, name: tool.name, input }] })
    const validation = await tool.validateInput(input, context)
    assert.equal(validation.result, tool === r.FileEditTool)
    const result = validation.result
      ? tool.mapToolResultToToolResultBlockParam((await tool.call(input, context, canUseTool, assistant)).data, id)
      : { type: 'tool_result', tool_use_id: id, content: validation.message, is_error: true }
    context.messages.push(assistant, r.createUserMessage({ content: [result] }))
    const restored = { ...context, readFileState: r.extractReadFilesFromMessages(context.messages, project) }
    assert.equal(await canWrite(restored, file), false, tool.name + ' must not authorize a blind replacement on resume')
  }
  await read(context, file)
  const restored = { ...context, readFileState: r.extractReadFilesFromMessages(context.messages, project) }
  assert.equal(restored.readFileState.get(file)?.isPartialView, undefined, 'a later whole-file Read supersedes the partial notice')
})

test('an Edit refusal exposing a complete small file restores Write, while ordinary Edit stays writable', async () => {
  const context = fileNoticeContext(), file = join(project, 'small-partial-edit.txt')
  const content = `first ${randomUUID()}\nsecond ${randomUUID()}\n`
  write(file, content)
  await read(context, file)
  context.readFileState.set(file, { ...context.readFileState.get(file), isPartialView: true })
  const rejected = await r.FileEditTool.validateInput({ file_path: file, old_string: 'absent', new_string: 'replacement' }, context)
  assert.equal(rejected.result, false)
  assert.ok(rejected.message.includes(content), 'The refusal exposes every line')
  assert.equal(await canWrite(context, file), true, 'The complete refusal is a real exposure')
  const input = { file_path: file, old_string: content.split('\n')[0], new_string: 'edited' }
  assert.equal((await r.FileEditTool.validateInput(input, context)).result, true)
  await r.FileEditTool.call(input, context, canUseTool, r.createAssistantMessage({ content: [] }))
  assert.equal(await canWrite(context, file), true, 'An ordinary fully visible Edit still permits Write')
})
