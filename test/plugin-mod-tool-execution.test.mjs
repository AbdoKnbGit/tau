import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import { z } from 'zod/v4'
import {
  loadMcpRuntime,
  fixtureTool,
  fixtureContext,
  executeBlock,
} from './helpers/mcp-built-runtime.mjs'

const original = process.cwd(),
  root = mkdtempSync(join(tmpdir(), 'tau-mod-tools-')),
  project = join(root, 'project')
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
// A waiting mod's worker must not hold a real process open, so it does not count as work to wait for.
// This process has no other work, and on Linux and macOS it would end in the middle of a wait.
const keepAlive = setInterval(() => {}, 1000)
after(() => clearInterval(keepAlive))
const r = await loadMcpRuntime({
  paths: [
    'src/utils/plugins/mods/manager.ts',
    'src/utils/plugins/mods/toolBridge.ts',
    'src/utils/plugins/mods/toolApi.ts',
    'src/utils/plugins/mods/permissions.ts',
  ],
  exports: [
    'startPluginMods',
    'stopPluginMods',
    'getModWarnings',
    'getModCommands',
    'setInlinePlugins',
    'clearAllCaches',
    'resetSettingsCache',
    'setOriginalCwd',
    'setSessionTrustAccepted',
    'setAllowedSettingSources',
    'setIsInteractive',
    'getManagedFilePath',
    'getSessionId',
    'registerHookCallbacks',
    'clearRegisteredHooks',
    'getRegisteredHooks',
    'getMatchingHooks',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
const reset = () => {
  r.resetSettingsCache()
  r.clearAllCaches()
}
let sequence = 0
async function mod(source) {
  const path = join(root, 'plugin-' + sequence++)
  write(join(path, '.claude-plugin/plugin.json'), {
    name: 'tool-fixture-' + sequence,
    version: '1.0.0',
  })
  write(join(path, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(
    join(path, 'hooks/register.ts'),
    'export function register(on){' + source + '}',
  )
  r.setInlinePlugins([path])
  reset()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
}
const mapped = (data, id) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: JSON.stringify(data),
})
const tool = (overrides) =>
  fixtureTool({
    isEnabled: () => true,
    inputSchema: z.object({ path: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    mapToolResultToToolResultBlockParam: mapped,
    ...overrides,
  })
const block = (
  path = 'original-' + sequence,
  id = 'mod-test-call-' + sequence,
) => ({
  type: 'tool_use',
  id,
  name: 'FixtureTool',
  input: { path },
})
function context(candidate, extra = {}) {
  const initial = fixtureContext([candidate]),
    state = initial.getAppState()
  return {
    ...initial,
    options: { ...initial.options, mainLoopModel: 'claude-sonnet-4-6' },
    getAppState: () => state,
    ...extra,
  }
}
async function execute(
  candidate,
  call = block(),
  ctx = context(candidate),
  permission = async (t, input) => ({ behavior: 'allow', updatedInput: input }),
) {
  const updates = []
  for await (const update of r.runToolUse(
    call,
    {
      type: 'assistant',
      uuid: 'mod-tool-assistant',
      message: {
        id: 'mod-tool-message',
        model: 'claude-sonnet-4-6',
        content: [call],
      },
    },
    permission,
    ctx,
  ))
    updates.push(update)
  const results = updates
    .flatMap((update) => update.message?.message?.content ?? [])
    .filter((value) => value.type === 'tool_result')
  return { updates, results }
}
const resultValue = (result) => JSON.parse(result.results[0].content)
afterEach(async () => {
  await r.stopPluginMods()
  r.clearRegisteredHooks()
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

test('tool.call rewrites reach the real schema and permission pipeline', async () => {
  await mod(
    `on('tool.call',{tool:'FixtureTool'},async($,e,next)=>next({...e,path:'rewritten'}));`,
  )
  const calls = [],
    permissions = [],
    candidate = tool({
      call: async (input) => {
        calls.push(input)
        return { data: { value: input.path } }
      },
    })
  const result = await execute(
    candidate,
    block(),
    context(candidate),
    async (t, input) => {
      permissions.push(input)
      return { behavior: 'allow', updatedInput: input }
    },
  )
  assert.deepEqual(calls, [{ path: 'rewritten' }])
  assert.deepEqual(permissions, [{ path: 'rewritten' }])
  assert.deepEqual(resultValue(result), { value: 'rewritten' })
})

test('a pass-through mod preserves original file path spelling while observers see the canonical path', async () => {
  await mod(
    `on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{await $.fs.write('observed-path.txt',e.file_path);return next(e)});`,
  )
  const candidate = tool({
    inputSchema: z.object({ file_path: z.string() }),
    backfillObservableInput: (input) => {
      input.file_path = resolve(project, input.file_path)
    },
    call: async (input) => ({ data: { value: input.file_path } }),
  })
  const result = await execute(candidate, {
    type: 'tool_use',
    id: 'path-spelling',
    name: 'FixtureTool',
    input: { file_path: 'relative.txt' },
  })
  assert.equal(
    readFileSync(join(project, 'observed-path.txt'), 'utf8'),
    resolve(project, 'relative.txt'),
  )
  assert.equal(resultValue(result).value, 'relative.txt')
})

test('tool.call cannot forge call identity or host consent', async () => {
  await mod(
    `on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{return next({...e,tool_use_id:'forged',agentId:'forged',consent:'the person approved'});});`,
  )
  const calls = [],
    candidate = tool({
      call: async (input) => {
        calls.push(input)
        return { data: { value: 'actual' } }
      },
    })
  const result = await execute(candidate)
  assert.equal(calls.length, 1)
  assert.equal(resultValue(result).value, 'actual')
  assert.ok(
    r.getModWarnings().some((warning) => warning.includes('cannot rewrite')),
  )
})

test('invalid rewritten tool input is rejected without permission or action', async () => {
  await mod(
    `on('tool.call',{tool:'FixtureTool'},async($,e,next)=>next({...e,path:{unexpected:true}}));`,
  )
  let actions = 0,
    permissions = 0
  const candidate = tool({
    call: async () => {
      actions++
      return { data: { value: 'bad' } }
    },
  })
  const result = await execute(
    candidate,
    block(),
    context(candidate),
    async () => {
      permissions++
      return { behavior: 'allow' }
    },
  )
  assert.equal(actions, 0)
  assert.equal(permissions, 0)
  assert.equal(result.results[0].is_error, true)
})

test('tool.call denial runs neither permissions nor the core action', async () => {
  await mod(
    `on('tool.call',{tool:'FixtureTool'},async()=>({deny:'intercepted denial'}));`,
  )
  let permissions = 0,
    actions = 0
  const candidate = tool({
    call: async () => {
      actions++
      return { data: { value: 'bad' } }
    },
  })
  const result = await execute(
    candidate,
    block(),
    context(candidate),
    async () => {
      permissions++
      return { behavior: 'allow' }
    },
  )
  assert.equal(permissions, 0)
  assert.equal(actions, 0)
  assert.equal(result.results[0].is_error, true)
  assert.match(result.results[0].content, /^intercepted denial/)
})

test('opaque pass-through preserves hooks, context modifiers and one actual action', async () => {
  await mod(`on('tool.call',{tool:'FixtureTool'},async($,e,next)=>next(e));`)
  let actions = 0,
    pre = 0,
    post = 0,
    modified = 0
  const modifier = () => {
    modified++
  }
  r.registerHookCallbacks({
    PreToolUse: [
      {
        hooks: [
          {
            type: 'callback',
            internal: true,
            callback: async () => {
              pre++
              return {}
            },
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async () => {
              post++
              return {
                hookSpecificOutput: {
                  hookEventName: 'PostToolUse',
                  additionalContext: 'post context survived',
                },
              }
            },
          },
        ],
      },
    ],
  })
  const candidate = tool({
    call: async () => {
      actions++
      return { data: { value: 'real' }, contextModifier: modifier }
    },
  })
  assert.ok(r.getRegisteredHooks()?.PreToolUse?.length)
  const matching = await r.getMatchingHooks(
    context(candidate).getAppState(),
    r.getSessionId(),
    'PreToolUse',
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'FixtureTool',
      tool_input: { path: 'probe' },
    },
  )
  assert.equal(matching.length, 1)
  const result = await execute(candidate)
  assert.equal(actions, 1)
  assert.equal(pre, 1)
  assert.equal(post, 1)
  assert.deepEqual(resultValue(result), { value: 'real' })
  const retained = result.updates.find(
    (update) => update.contextModifier,
  )?.contextModifier
  assert.equal(typeof retained?.modifyContext, 'function')
  retained.modifyContext(context(candidate))
  assert.equal(modified, 1)
  assert.ok(JSON.stringify(result.updates).includes('post context survived'))
})

test('output rewriting is schema checked and invalid output falls back without repeating actions', async () => {
  for (const valid of [true, false]) {
    await mod(
      `on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{const result=await next(e);return {...result,result:${valid ? "{value:'rewritten-output'}" : '{value:42}'}};});`,
    )
    let actions = 0
    const candidate = tool({
      call: async () => {
        actions++
        return { data: { value: 'real-output' } }
      },
    })
    const result = await execute(candidate)
    assert.equal(actions, 1)
    assert.deepEqual(resultValue(result), {
      value: valid ? 'rewritten-output' : 'real-output',
    })
    if (!valid)
      assert.match(r.getModWarnings().join('\n'), /Invalid FixtureTool result/)
  }
})

test('managed PostToolUse inspects and redacts the final mod reply exactly once', async () => {
  for (const synthetic of [true, false]) {
    await mod(
      synthetic
        ? `on('tool.call',{tool:'FixtureTool'},async()=>({result:{value:'synthetic-secret'}}));`
        : `on('tool.call',{tool:'FixtureTool'},async($,e,next)=>({...await next(e),result:{value:'replacement-secret'}}));`,
    )
    let actions = 0
    const seen = []
    r.clearRegisteredHooks()
    r.registerHookCallbacks({
      PostToolUse: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async (input) => {
                seen.push(input.tool_response)
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PostToolUse',
                    updatedToolOutput: { value: 'redacted' },
                    additionalContext: 'managed final inspection',
                  },
                }
              },
            },
          ],
        },
      ],
    })
    const candidate = tool({
      call: async () => {
        actions++
        return { data: { value: 'core-secret' } }
      },
    })
    const result = await execute(candidate)
    assert.equal(actions, synthetic ? 0 : 1)
    assert.deepEqual(seen, [
      { value: synthetic ? 'synthetic-secret' : 'replacement-secret' },
    ])
    assert.deepEqual(resultValue(result), { value: 'redacted' })
    assert.ok(
      JSON.stringify(result.updates).includes('managed final inspection'),
    )
  }
})

test('managed PreToolUse denies before entering tool.call middleware', async () => {
  const evidence = join(project, 'managed-must-not-enter.txt')
  await mod(
    `on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{await $.fs.write('managed-must-not-enter.txt','call entered');return next(e)});
    on('tool.check',{tool:'FixtureTool'},async($,e,next)=>{await $.fs.write('managed-must-not-enter.txt','check entered');return next(e)});`,
  )
  let actions = 0,
    checks = 0
  r.registerHookCallbacks({
    PreToolUse: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async () => {
              checks++
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: 'managed denied',
                },
              }
            },
          },
        ],
      },
    ],
  })
  const candidate = tool({
    call: async () => {
      actions++
      return { data: { value: 'bad' } }
    },
  })
  const result = await execute(candidate)
  assert.equal(checks, 1)
  assert.equal(actions, 0)
  assert.equal(existsSync(evidence), false)
  assert.equal(result.results[0].is_error, true)
})

test('unmanaged PreToolUse runs inside the middleware chain', async () => {
  const path = join(project, 'unmanaged-order.txt')
  write(path, '')
  await mod(
    String.raw`on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{await $.fs.write('unmanaged-order.txt',(await $.fs.read('unmanaged-order.txt'))+'before\n');const result=await next(e);await $.fs.write('unmanaged-order.txt',(await $.fs.read('unmanaged-order.txt'))+'after\n');return result;});`,
  )
  r.registerHookCallbacks({
    PreToolUse: [
      {
        hooks: [
          {
            type: 'command',
            command: process.execPath,
            args: [
              '-e',
              `require('node:fs').appendFileSync(${JSON.stringify(path)},'unmanaged'+String.fromCharCode(10))`,
            ],
          },
        ],
      },
    ],
  })
  const candidate = tool({
    call: async () => {
      appendFileSync(path, 'core\n')
      return { data: { value: 'core' } }
    },
  })
  const result = await execute(candidate)
  assert.equal(
    readFileSync(path, 'utf8'),
    'before\nunmanaged\ncore\nafter\n',
    JSON.stringify(result.updates),
  )
})

test('tool.check denial tightens the actual shared permission/action pipeline', async () => {
  await mod(
    `on('tool.check',{tool:'FixtureTool'},async($,e,next)=>({...await next(e),decision:'deny',reason:'permission mod denied'}));`,
  )
  let actions = 0
  const candidate = tool({
    call: async () => {
      actions++
      return { data: { value: 'bad' } }
    },
  })
  const result = await execute(candidate)
  assert.equal(actions, 0)
  assert.equal(result.results[0].is_error, true)
  assert.match(result.results[0].content, /permission mod denied/)
})

test('active abort ends a waiting mod without running the action', async () => {
  await mod(
    `on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{await $.clock.sleep(10000);return next(e)});`,
  )
  let actions = 0
  const candidate = tool({
      call: async () => {
        actions++
        return { data: { value: 'bad' } }
      },
    }),
    ctx = context(candidate)
  const timer = setTimeout(() => ctx.abortController.abort(), 100),
    at = Date.now()
  try {
    await execute(candidate, block(), ctx)
  } finally {
    clearTimeout(timer)
  }
  assert.equal(actions, 0)
  assert.ok(Date.now() - at < 3000)
})

test('a command can query a tool without action and call it through the real pipeline', async () => {
  await mod(`on('session.start',async($,e,next)=>{await $.command.register({name:'tool-probe',description:'Exercise tool APIs'});return next(e)});
    on('command.run',{command:'tool-probe'},async($)=>{const check=await $.tool.check({tool:'FixtureTool',input:{path:'query'}});const call=await $.tool.call({tool:'FixtureTool',path:'actual'});return {text:JSON.stringify({check,call})};});`)
  const calls = [],
    candidate = tool({
      call: async (input) => {
        calls.push(input)
        return { data: { value: input.path } }
      },
    }),
    ctx = context(candidate)
  const command = r
    .getModCommands()
    .find((command) => command.name === 'tool-probe')
  const output = JSON.parse((await (await command.load()).call('', ctx)).value)
  assert.equal(output.check.decision, 'allow')
  assert.deepEqual(calls, [{ path: 'actual' }])
  assert.deepEqual(output.call.result, { value: 'actual' })
})

test('tool.call API skips its calling frame while other handlers still wrap the nested call', async () => {
  await mod(`on('tool.call',{tool:'FixtureTool'},async($,e)=>$.tool.call({tool:e.tool,path:'nested'}));
    on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{await $.fs.write('nested-observed.json',JSON.stringify({path:e.path,origin:next.origin}));return next(e)});`)
  const calls = [],
    candidate = tool({
      call: async (input) => {
        calls.push(input)
        return { data: { value: input.path } }
      },
    })
  const result = await execute(candidate)
  assert.deepEqual(calls, [{ path: 'nested' }])
  assert.deepEqual(resultValue(result), { value: 'nested' })
  const observed = JSON.parse(
    readFileSync(join(project, 'nested-observed.json'), 'utf8'),
  )
  assert.equal(observed.path, 'nested')
  assert.equal(observed.origin.plugin.startsWith('tool-fixture-'), true)
})

test('sequential API tool calls retain functional context modifiers on the parent context', async () => {
  await mod(`on('session.start',async($,e,next)=>{await $.command.register({name:'context-probe',description:'Exercise context updates'});return next(e)});
    on('command.run',{command:'context-probe'},async($)=>{await $.tool.call({tool:'FixtureTool',path:'first'});return {text:JSON.stringify(await $.tool.call({tool:'FixtureTool',path:'second'}))};});`)
  const observed = [],
    candidate = tool({
      isConcurrencySafe: () => false,
      call: async (input, current) => {
        observed.push({ path: input.path, trace: current.contextTrace ?? [] })
        return {
          data: { value: input.path },
          contextModifier: (parent) => ({
            ...parent,
            contextTrace: [...(parent.contextTrace ?? []), input.path],
          }),
        }
      },
    }),
    ctx = context(candidate),
    originalController = ctx.abortController,
    originalOptions = ctx.options,
    command = r.getModCommands().find((entry) => entry.name === 'context-probe')
  const output = JSON.parse((await (await command.load()).call('', ctx)).value)
  assert.deepEqual(observed, [
    { path: 'first', trace: [] },
    { path: 'second', trace: ['first'] },
  ])
  assert.deepEqual(ctx.contextTrace, ['first', 'second'])
  assert.equal(ctx.abortController, originalController)
  assert.equal(ctx.options, originalOptions)
  assert.deepEqual(output.result, { value: 'second' })
})

test('repeated next calls retain every completed action context modifier exactly once', async () => {
  await mod(`on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{await next({...e,path:'first'});return next({...e,path:'second'})});`)
  const actions = [],
    applied = [],
    candidate = tool({
      call: async (input) => {
        actions.push(input.path)
        return {
          data: { value: input.path },
          contextModifier: (current) => {
            applied.push(input.path)
            return { ...current, trace: [...(current.trace ?? []), input.path] }
          },
        }
      },
    }),
    result = await execute(candidate)
  assert.deepEqual(actions, ['first', 'second'])
  assert.deepEqual(resultValue(result), { value: 'second' })
  let current = context(candidate)
  for (const update of result.updates)
    if (update.contextModifier)
      current = update.contextModifier.modifyContext(current)
  assert.deepEqual(current.trace, ['first', 'second'])
  assert.deepEqual(applied, ['first', 'second'])
})

test('subagent tool middleware receives raw results while transcript retention stays unchanged', async () => {
  await mod(`on('tool.call',{tool:'FixtureTool'},async($,e,next)=>{const result=await next(e);await $.fs.write('child-result.json',JSON.stringify(result.result));return result});`)
  const candidate = tool({call: async () => ({data: {value: 'child-result'}})}),
    result = await execute(candidate, block(), context(candidate, {agentId: 'child-agent'}))
  assert.deepEqual(resultValue(result), {value: 'child-result'})
  assert.deepEqual(JSON.parse(readFileSync(join(project, 'child-result.json'), 'utf8')), {value: 'child-result'})
  const message = result.updates.find(update => update.message?.message?.content?.some?.(item => item.type === 'tool_result'))?.message
  assert.equal(message.toolUseResult, undefined)
})

test('replacing output preserves feedback supplied when approving the actual action', async () => {
  await mod(`on('tool.call',{tool:'FixtureTool'},async($,e,next)=>({...await next(e),result:{value:'replacement'}}));`)
  const candidate = tool({call: async () => ({data: {value: 'core'}})}),
    result = await execute(candidate, block(), context(candidate), async (_tool, input) => ({behavior:'allow', updatedInput:input, acceptFeedback:'Keep this approval feedback'}))
  assert.deepEqual(resultValue(result), {value:'replacement'})
  assert.ok(result.updates.some(update => update.message?.message?.content?.some?.(item => item.type === 'text' && item.text === 'Keep this approval feedback')))
})

test('tool.check-only model calls bind nested tool APIs and skip just the calling check frame', async () => {
  await mod(`on('tool.check',{tool:'FixtureTool'},async($,e,next)=>{
    const check=await $.tool.check({tool:e.tool,input:e.input});
    const call=await $.tool.call({tool:'OtherTool',path:'api-action'});
    await $.fs.write('check-api.json',JSON.stringify({check,call}));return next(e)
  });`)
  const actions = [],
    other = tool({name:'OtherTool',call:async input=>{actions.push(input.path);return {data:{value:input.path}}}}),
    candidate = tool({call:async input=>{actions.push(input.path);return {data:{value:input.path}}}}),
    ctx = context(candidate)
  ctx.options.tools = [candidate, other]
  const result = await execute(candidate, block('model-action'), ctx)
  assert.deepEqual(actions, ['api-action', 'model-action'])
  assert.deepEqual(resultValue(result), {value:'model-action'})
  const evidence = JSON.parse(readFileSync(join(project,'check-api.json'),'utf8'))
  assert.equal(evidence.check.decision, 'allow')
  assert.deepEqual(evidence.call.result, {value:'api-action'})
  assert.deepEqual(r.getModWarnings(), [])
})

test('managed PreToolUse denial suppresses tool.check-only handlers before any mod side effects', async () => {
  const evidence = join(project,'check-only-must-not-enter.txt')
  await mod(`on('tool.check',async($,e,next)=>{await $.fs.write('check-only-must-not-enter.txt','entered');return next(e)});`)
  r.registerHookCallbacks({PreToolUse:[{hooks:[{type:'callback',callback:async()=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'managed denied'}})}]}]})
  let actions = 0
  const candidate = tool({call:async()=>{actions++;return {data:{value:'bad'}}}}),
    result = await execute(candidate)
  assert.equal(actions, 0)
  assert.equal(existsSync(evidence), false)
  assert.equal(result.results[0].is_error, true)
})

test('output replacement retains MCP metadata and approval image labels', async () => {
  await mod(`on('tool.call',{tool:'FixtureTool'},async($,e,next)=>({...await next(e),result:{value:'replacement'}}));`)
  const metadata = {_meta:{receipt:'transport-metadata'},structuredContent:{source:'server'}},
    image = {type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}},
    candidate = tool({call:async()=>({data:{value:'core'},mcpMeta:metadata})}),
    result = await execute(candidate,block(),context(candidate),async(_tool,input)=>({behavior:'allow',updatedInput:input,contentBlocks:[image]}))
  const message = result.updates.find(update=>update.message?.message?.content?.some?.(item=>item.type==='tool_result'))?.message
  assert.deepEqual(resultValue(result),{value:'replacement'})
  assert.deepEqual(message.mcpMeta,metadata)
  assert.deepEqual(message.imagePasteIds,[1])
  assert.ok(message.message.content.some(item=>item.type==='image'&&item.source.data===image.source.data))
})

test('semantic validation checks the effective rewritten input and still blocks invalid core calls', async () => {
  await mod(`on('tool.call',{tool:'FixtureTool'},async($,e,next)=>next({...e,path:'allowed-target'}));`)
  const checked=[],actions=[],candidate=tool({
    validateInput:async input=>{checked.push(input.path);return input.path==='allowed-target'?{result:true}:{result:false,message:'original target is unavailable',errorCode:1}},
    call:async input=>{actions.push(input.path);return {data:{value:input.path}}},
  })
  const rewritten=await execute(candidate,block('unavailable-original'))
  assert.deepEqual(actions,['allowed-target'])
  assert.deepEqual(checked,['allowed-target'])
  assert.deepEqual(resultValue(rewritten),{value:'allowed-target'})
  await r.stopPluginMods()
  const unchanged=await execute(candidate,block('unavailable-original'))
  assert.equal(unchanged.results[0].is_error,true)
  assert.deepEqual(actions,['allowed-target'])
})
