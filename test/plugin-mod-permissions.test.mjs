import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import { z } from 'zod/v4'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const original = process.cwd(),
  root = mkdtempSync(join(tmpdir(), 'tau-mod-permissions-'))
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
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: [
    'src/utils/plugins/mods/permissions.ts',
    'src/utils/plugins/mods/manager.ts',
    'src/services/tools/toolHooks.ts',
  ],
  exports: [
    'queryModToolPermission',
    'resolveModToolPermissionDecision',
    'hasPermissionsToUseTool',
    'hasPermissionsToUseToolInner',
    'resolveHookPermissionDecision',
    'startPluginMods',
    'stopPluginMods',
    'getModWarnings',
    'setInlinePlugins',
    'clearAllCaches',
    'resetSettingsCache',
    'setOriginalCwd',
    'setSessionTrustAccepted',
    'setIsInteractive',
    'setAllowedSettingSources',
    'getManagedFilePath',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setIsInteractive(false)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
const reset = () => {
  r.resetSettingsCache()
  r.clearAllCaches()
}
let sequence = 0
async function mod(body) {
  const path = join(root, 'mod-' + sequence++)
  write(join(path, '.claude-plugin/plugin.json'), {
    name: 'permission-fixture-' + sequence,
    version: '1.0.0',
  })
  write(join(path, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(
    join(path, 'hooks/register.ts'),
    `export function register(on){on('tool.check',async($,e,next)=>{${body}})}`,
  )
  r.setInlinePlugins([path])
  reset()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
}
function tool(result = { behavior: 'allow' }, overrides = {}) {
  return {
    name: 'FixtureTool',
    inputSchema: z.object({ path: z.string().optional() }).passthrough(),
    isReadOnly: () => true,
    requiresUserInteraction: () => false,
    checkPermissions: async () => result,
    ...overrides,
  }
}
function context(tools, permission = {}, extra = {}) {
  const state = r.getDefaultAppState()
  state.toolPermissionContext = {
    ...state.toolPermissionContext,
    mode: 'default',
    alwaysAllowRules: {},
    alwaysAskRules: {},
    alwaysDenyRules: {},
    ...permission,
  }
  return {
    abortController: new AbortController(),
    options: { tools, isNonInteractiveSession: true },
    getAppState: () => state,
    setAppState() {
      throw new Error('Pure permission query cannot persist state')
    },
    messages: [],
    ...extra,
  }
}
const message = {
  type: 'assistant',
  uuid: 'permissions-assistant',
  message: { id: 'permissions-message', content: [] },
}
afterEach(async () => {
  await r.stopPluginMods()
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

test('a compiled tool.check mod can tighten allow without executing tools or settling a query', async () => {
  await mod(
    `const result=await next(e);return {...result,decision:'deny',reason:'additional policy'};`,
  )
  const candidate = tool(),
    ctx = context([candidate])
  const result = await r.queryModToolPermission(
    candidate,
    { path: 'example' },
    ctx,
  )
  assert.equal(result.decision, 'deny')
  assert.equal(result.reason, 'additional policy')
  const actual = await r.hasPermissionsToUseTool(
    candidate,
    { path: 'example' },
    ctx,
    message,
    'real-check',
  )
  assert.equal(actual.behavior, 'deny')
  assert.equal(actual.message, 'additional policy')
})

test('declarative deny and explicit ask rules cannot be relaxed by a mod allow', async () => {
  await mod(`return {decision:'allow'};`)
  const candidate = tool()
  for (const behavior of ['deny', 'ask']) {
    const rules =
      behavior === 'deny'
        ? { alwaysDenyRules: { projectSettings: ['FixtureTool'] } }
        : { alwaysAskRules: { projectSettings: ['FixtureTool'] } }
    const result = await r.queryModToolPermission(
      candidate,
      {},
      context([candidate], rules),
    )
    assert.equal(result.decision, behavior)
    assert.equal(result.ceiling, behavior)
    assert.equal(result.rule, 'FixtureTool')
  }
})

test('PreToolUse deny and ask still run tool.check once and remain protected', async () => {
  const evidence = 'permission-calls.json'
  await mod(
    `const old=await $.fs.exists('${evidence}')?JSON.parse(await $.fs.read('${evidence}')):[];await $.fs.write('${evidence}',JSON.stringify([...old,{id:e.tool_use_id,tool:e.tool,readonly:e.isReadOnly}]));return {decision:'allow'};`,
  )
  const candidate = tool(),
    ctx = context([candidate])
  const callbacks = []
  const canUseTool = async (t, input, context, assistant, id, force) => {
    callbacks.push({ id, force })
    return force
  }
  for (const behavior of ['deny', 'ask']) {
    const hook = {
      behavior,
      message: 'explicit classic ' + behavior,
      decisionReason: { type: 'hook', hookName: 'PreToolUse:FixtureTool' },
    }
    const result = await r.resolveHookPermissionDecision(
      hook,
      candidate,
      {},
      ctx,
      canUseTool,
      message,
      'classic-' + behavior,
    )
    assert.equal(result.decision.behavior, behavior)
  }
  const calls = JSON.parse(readFileSync(join(project, evidence), 'utf8'))
  assert.deepEqual(calls, [
    { id: 'classic-deny', tool: 'FixtureTool', readonly: true },
    { id: 'classic-ask', tool: 'FixtureTool', readonly: true },
  ])
  assert.equal(callbacks.length, 1)
  assert.equal(callbacks[0].force.behavior, 'ask')
})

test('a PreToolUse allow still reaches mod checks and can be denied', async () => {
  await mod(`return {decision:'deny',reason:'mod denied classic allow'};`)
  const candidate = tool({
    behavior: 'ask',
    message: 'ordinary permission',
    decisionReason: { type: 'other', reason: 'ordinary permission' },
  })
  const result = await r.resolveHookPermissionDecision(
    {
      behavior: 'allow',
      decisionReason: { type: 'hook', hookName: 'PreToolUse' },
    },
    candidate,
    {},
    context([candidate]),
    async () => {
      throw new Error('Deny must not ask UI')
    },
    message,
    'hook-allow',
  )
  assert.equal(result.decision.behavior, 'deny')
  assert.equal(result.decision.message, 'mod denied classic allow')
})

test('plan writes, safety checks and mandatory user interaction retain their approval ceiling', async () => {
  await mod(`return {decision:'allow'};`)
  const writeTool = tool({ behavior: 'allow' }, { isReadOnly: () => false })
  assert.equal(
    (
      await r.queryModToolPermission(
        writeTool,
        {},
        context([writeTool], { mode: 'plan' }),
      )
    ).decision,
    'ask',
  )
  const safety = tool({
    behavior: 'ask',
    message: 'mandatory safety',
    decisionReason: {
      type: 'safetyCheck',
      reason: 'mandatory safety',
      classifierApprovable: false,
    },
  })
  assert.equal(
    (await r.queryModToolPermission(safety, {}, context([safety]))).decision,
    'ask',
  )
  const interaction = tool(
    {
      behavior: 'ask',
      message: 'interactive',
      decisionReason: { type: 'other', reason: 'interactive' },
    },
    { requiresUserInteraction: () => true },
  )
  assert.equal(
    (await r.queryModToolPermission(interaction, {}, context([interaction])))
      .decision,
    'ask',
  )
})

test('a mod ask cannot discard non-classifier-approvable safety metadata', async () => {
  await mod(`return {decision:'ask',reason:'custom approval message'};`)
  const candidate = tool({
    behavior: 'ask',
    message: 'mandatory safety',
    decisionReason: {
      type: 'safetyCheck',
      reason: 'mandatory safety',
      classifierApprovable: false,
    },
  })
  const result = await r.resolveModToolPermissionDecision(
    candidate,
    {},
    context([candidate]),
  )
  assert.equal(result.behavior, 'ask')
  assert.equal(result.message, 'custom approval message')
  assert.deepEqual(result.decisionReason, {
    type: 'safetyCheck',
    reason: 'mandatory safety',
    classifierApprovable: false,
  })
})

test('pure queries leave headless asks unsettled and omit real-call IDs and classic hooks', async () => {
  const evidence = 'pure-query.json'
  await mod(`await $.fs.write('${evidence}',JSON.stringify(e));return next(e);`)
  const candidate = tool({
    behavior: 'ask',
    message: 'needs approval',
    decisionReason: { type: 'other', reason: 'needs approval' },
  })
  const ctx = context([candidate], { shouldAvoidPermissionPrompts: true })
  const result = await r.queryModToolPermission(candidate, {}, ctx)
  assert.equal(result.decision, 'ask')
  const event = JSON.parse(readFileSync(join(project, evidence), 'utf8'))
  assert.equal(event.tool, 'FixtureTool')
  assert.equal(Object.hasOwn(event, 'tool_use_id'), false)
  const actual = await r.hasPermissionsToUseTool(
    candidate,
    {},
    ctx,
    message,
    'headless-actual',
  )
  assert.equal(actual.behavior, 'deny')
})

test('requireCanUseTool still invokes the host permission callback after mod approval', async () => {
  await mod(`return {decision:'allow'};`)
  const candidate = tool(),
    ctx = context([candidate], {}, { requireCanUseTool: true })
  let calls = 0
  const result = await r.resolveHookPermissionDecision(
    undefined,
    candidate,
    {},
    ctx,
    async (t, i, c, m, id, forced) => {
      calls++
      assert.equal(forced.behavior, 'allow')
      return {
        behavior: 'deny',
        message: 'host denied',
        decisionReason: { type: 'other', reason: 'host denied' },
      }
    },
    message,
    'required-host',
  )
  assert.equal(calls, 1)
  assert.equal(result.decision.behavior, 'deny')
})

test('direct permission hosts bind tool APIs and a nested query skips its calling check frame', async () => {
  await mod(`const nested=await $.tool.check({tool:e.tool,input:e.input});await $.fs.write('direct-api-check.json',JSON.stringify(nested));return next(e);`)
  let checks = 0
  const candidate = tool(undefined, {isEnabled:()=>true,checkPermissions:async()=>{checks++;return {behavior:'allow'}}}),
    decision = await r.hasPermissionsToUseTool(candidate, {path:'query'}, context([candidate]), message, 'direct-check')
  assert.equal(decision.behavior, 'allow')
  assert.equal(checks, 2)
  assert.equal(JSON.parse(readFileSync(join(project,'direct-api-check.json'),'utf8')).decision, 'allow')
  assert.deepEqual(r.getModWarnings(), [])
})
