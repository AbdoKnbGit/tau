import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const originalCwd = process.cwd()
const directory = mkdtempSync(join(tmpdir(), 'tau-lifecycle-hooks-'))
const project = join(directory, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(directory, 'config'), CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
after(() => {
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true, maxRetries: 10 })
})

const r = await loadMcpRuntime({
  paths: [
    'src/utils/hooks/lifecycleHooks.ts', 'src/utils/processUserInput/processUserInput.ts',
    'src/utils/processUserInput/processSlashCommand.tsx', 'src/utils/sessionStart.ts',
    'src/bridge/bridgeMessaging.ts',
  ],
  exports: [
    'processUserInput', 'checkModelSwitchHooks', 'dispatchPostModelSwitchHooks',
    'dispatchDirectoryAddedHooks', 'takePendingLifecycleHookMessages', 'observeModelSwitch',
    'applyHookSessionTitle', 'formatBlockedPrompt', 'modelSwitchContextTokens', 'getSessionId',
    'handleServerControlRequest', 'getPromptId', 'normalizeAttachmentForAPI',
    'getLifecycleDeps: () => ({ executeHooks, executeHooksOutsideREPL, executeUserPromptSubmitHooks, runAgent, getAttachmentMessages, saveCustomTitle, saveAgentName })',
    `setLifecycleDeps: d => {
      if (d.executeHooks) executeHooks = d.executeHooks;
      if (d.executeHooksOutsideREPL) executeHooksOutsideREPL = d.executeHooksOutsideREPL;
      if (d.executeUserPromptSubmitHooks) executeUserPromptSubmitHooks = d.executeUserPromptSubmitHooks;
      if (d.runAgent) runAgent = d.runAgent;
      if (d.getAttachmentMessages) getAttachmentMessages = d.getAttachmentMessages;
      if (d.saveCustomTitle) saveCustomTitle = d.saveCustomTitle;
      if (d.saveAgentName) saveAgentName = d.saveAgentName;
    }`,
  ],
})

const iterable = values => (async function* () { yield* values })()
async function using(dependencies, run) {
  const original = r.getLifecycleDeps()
  r.setLifecycleDeps({
    executeHooks: () => iterable([]), executeUserPromptSubmitHooks: () => iterable([]),
    getAttachmentMessages: () => iterable([]), ...dependencies,
  })
  try { return await run() } finally { r.setLifecycleDeps(original) }
}
function contextFor(commands = []) {
  const state = { ...fixtureContext([]).getAppState(), mainLoopModel: 'claude-sonnet-4-6', mainLoopModelForSession: null }
  return fixtureContext([], {
    getAppState: () => state,
    setAppState: update => Object.assign(state, update(state)),
    setMessages() {}, setResponseLength() {},
    options: { tools: [], mcpClients: [], commands, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [{ agentType: 'general-purpose' }] } },
  })
}
function skill(overrides = {}) {
  return { name: 'example', type: 'prompt', description: 'fixture', progressMessage: 'fixture',
    source: 'plugin', loadedFrom: 'plugin', isEnabled: () => true, userInvocable: true,
    getPromptForCommand: async () => [{ type: 'text', text: 'expanded fixture' }], ...overrides }
}
const submit = (input, context) => r.processUserInput({ input, mode: 'prompt', context,
  setToolJSX() {}, skipAttachments: true })
const request = context => ({ fromModel: 'claude-sonnet-4-6', toModel: 'claude-opus-4-6',
  requestedModel: 'opus', source: 'command', context })

test('submission blocks before any regular or forked skill expansion and suppresses the original text', async () => {
  for (const fork of [false, true]) {
    let expanded = 0
    let forked = 0
    const context = contextFor([skill({ context: fork ? 'fork' : undefined,
      getPromptForCommand: async () => { expanded++; return [] } })])
    await using({
      executeUserPromptSubmitHooks: () => iterable([{ blockingError: { blockingError: 'policy rejected', command: 'fixture' }, suppressOriginalPrompt: true }]),
      runAgent: () => { forked++; return iterable([]) },
    }, async () => {
      const result = await submit('/example confidential', context)
      assert.equal(result.shouldQuery, false)
      assert.equal(expanded, 0)
      assert.equal(forked, 0)
      assert.match(JSON.stringify(result.messages), /policy rejected/)
      assert.doesNotMatch(JSON.stringify(result.messages), /confidential|Original prompt/)
    })
  }
})

test('expansion runs after submission and before prompt interpolation with the original command input', async () => {
  const order = []
  const command = skill({ getPromptForCommand: async () => { order.push('expanded'); return [{ type: 'text', text: 'expanded fixture' }] } })
  await using({
    executeUserPromptSubmitHooks: () => { order.push('submitted'); return iterable([]) },
    executeHooks: ({ hookInput }) => {
      assert.equal(hookInput.hook_event_name, 'UserPromptExpansion')
      assert.equal(hookInput.prompt, '/example  one two')
      assert.equal(hookInput.command_name, 'example')
      assert.equal(hookInput.command_source, 'plugin')
      order.push('expansion hook')
      return iterable([{ additionalContexts: ['expansion guidance'] }])
    },
  }, async () => {
    const result = await submit('/example  one two', contextFor([command]))
    assert.equal(result.shouldQuery, true)
    assert.deepEqual(order, ['submitted', 'expansion hook', 'expanded'])
    assert.match(JSON.stringify(result.messages), /expansion guidance/)
  })
})

test('an expansion denial prevents interpolation and fork startup', async () => {
  const command = skill({ context: 'fork', getPromptForCommand: async () => { throw new Error('must not expand') } })
  await using({ executeHooks: () => iterable([{ blockingError: { blockingError: 'deployment denied', command: 'fixture' } }]) }, async () => {
    const result = await submit('/example', contextFor([command]))
    assert.equal(result.shouldQuery, false)
    assert.match(JSON.stringify(result.messages), /deployment denied/)
  })
})

test('forked skills receive both submission and expansion hook context', async () => {
  let forkPrompt
  await using({
    executeUserPromptSubmitHooks: () => iterable([{ additionalContexts: ['submission guidance'] }]),
    executeHooks: () => iterable([{ additionalContexts: ['expansion guidance'] }]),
    runAgent: options => { forkPrompt = options.promptMessages; return iterable([]) },
  }, async () => {
    const result = await submit('/example', contextFor([skill({ context: 'fork' })]))
    assert.equal(result.shouldQuery, false)
    assert.match(JSON.stringify(forkPrompt), /submission guidance/)
    assert.match(JSON.stringify(forkPrompt), /expansion guidance/)
  })
})

test('MCP prompt expansion reports its distinct expansion type', async () => {
  await using({ executeHooks: ({ hookInput }) => {
    assert.equal(hookInput.expansion_type, 'mcp_prompt')
    return iterable([{ blockingError: { blockingError: 'stop before server call', command: 'fixture' } }])
  } }, async () => {
    assert.equal((await submit('/example', contextFor([skill({ source: 'mcp', loadedFrom: 'mcp' })]))).shouldQuery, false)
  })
})

test('input starting with / that names no command still runs submission hooks once', async () => {
  let submitted = 0
  await using({ executeUserPromptSubmitHooks: () => { submitted++; return iterable([{ additionalContexts: ['path policy'] }]) } }, async () => {
    const result = await submit('/tmp/no-such-dir/app.log why does this fail', contextFor())
    assert.equal(result.shouldQuery, true)
    assert.equal(submitted, 1)
    assert.match(JSON.stringify(result.messages), /path policy/)
    // An unknown command name is refused locally and never reaches the hook.
    const unknown = await submit('/unknowncommand', contextFor())
    assert.equal(unknown.shouldQuery, false)
    assert.equal(submitted, 1)
  })
})

test('submission hooks see the id the prompt is then processed under', async () => {
  let seen
  await using({ executeUserPromptSubmitHooks: () => { seen = r.getPromptId(); return iterable([]) } }, async () => {
    const before = r.getPromptId()
    assert.equal((await submit('plain prompt', contextFor())).shouldQuery, true)
    assert.ok(seen)
    assert.notEqual(seen, before)
    assert.equal(r.getPromptId(), seen)
  })
})

test('background hook context waits for a submission that reaches the model', async () => {
  await using({
    executeHooksOutsideREPL: async () => [{ succeeded: true, output: '', systemMessage: 'repository prepared' }],
    executeHooks: () => iterable([{ blockingError: { blockingError: 'expansion denied', command: 'fixture' } }]),
  }, async () => {
    r.dispatchDirectoryAddedHooks(project, contextFor())
    await new Promise(resolve => setImmediate(resolve))
    const denied = await submit('/example', contextFor([skill()]))
    assert.equal(denied.shouldQuery, false)
    assert.doesNotMatch(JSON.stringify(denied.messages), /repository prepared/)
    assert.match(JSON.stringify(await r.takePendingLifecycleHookMessages()), /repository prepared/)
  })
})

test('plain stdout from expansion and model-switch hooks reaches the model like submission stdout', () => {
  for (const event of ['UserPromptSubmit', 'SessionStart', 'UserPromptExpansion', 'PostModelSwitch']) {
    const messages = r.normalizeAttachmentForAPI({ type: 'hook_success', hookName: event, toolUseID: 'fixture', hookEvent: event, content: `${event} guidance` })
    assert.match(JSON.stringify(messages), new RegExp(`${event} guidance`), event)
  }
  assert.deepEqual(r.normalizeAttachmentForAPI({ type: 'hook_success', hookName: 'PreToolUse', toolUseID: 'fixture', hookEvent: 'PreToolUse', content: 'not context' }), [])
})

test('model switch deny wins over ask and never opens confirmation', async () => {
  let prompted = false
  const context = contextFor()
  context.requestPrompt = () => async () => { prompted = true; return { selected: 'allow' } }
  await using({ executeHooks: () => iterable([
    { permissionBehavior: 'ask', hookPermissionDecisionReason: 'confirm cost' },
    { permissionBehavior: 'deny', hookPermissionDecisionReason: 'policy refused' },
  ]) }, async () => {
    const result = await r.checkModelSwitchHooks({ ...request(context), allowConfirmation: true })
    assert.equal(result.allowed, false)
    assert.equal(result.reason, 'policy refused')
    assert.equal(prompted, false)
  })
})

test('ask confirms only when the caller explicitly supports interactive confirmation', async () => {
  let prompted = 0
  const context = contextFor()
  context.requestPrompt = () => async () => { prompted++; return { selected: 'allow' } }
  await using({ executeHooks: () => iterable([{ permissionBehavior: 'ask', hookPermissionDecisionReason: 'confirm cost' }]) }, async () => {
    assert.equal((await r.checkModelSwitchHooks({ ...request(context), source: 'sdk' })).allowed, false)
    assert.equal(prompted, 0)
    assert.equal((await r.checkModelSwitchHooks({ ...request(context), allowConfirmation: true })).allowed, true)
    assert.equal(prompted, 1)
  })
})

test('cancelling a model confirmation rejects the switch without throwing', async () => {
  const context = contextFor()
  context.requestPrompt = () => async () => { throw new Error('Prompt cancelled by user') }
  await using({ executeHooks: () => iterable([{ permissionBehavior: 'ask' }]) }, async () => {
    const result = await r.checkModelSwitchHooks({ ...request(context), allowConfirmation: true })
    assert.equal(result.allowed, false)
    assert.equal(result.reason, 'Model switch cancelled')
  })
})

test('model switch input counts all usage buckets and includes estimates; no-op switches skip hooks', async () => {
  const context = contextFor()
  context.messages = [{ type: 'assistant', timestamp: new Date().toISOString(), message: {
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 },
  } }]
  let calls = 0
  await using({ executeHooks: ({ hookInput }) => {
    calls++
    assert.equal(hookInput.context_tokens, 620)
    assert.equal(hookInput.from_model, 'claude-sonnet-4-6')
    assert.equal(hookInput.to_model, 'claude-opus-4-6')
    assert.equal(hookInput.requested_model, 'opus')
    assert.equal(hookInput.prompt_cache_warm, true)
    assert.ok(hookInput.estimated_cache_write_usd > 0)
    return iterable([])
  } }, async () => {
    await r.checkModelSwitchHooks(request(context))
    await r.checkModelSwitchHooks({ ...request(context), toModel: 'claude-sonnet-4-6' })
    assert.equal(calls, 1)
  })
})

test('only the latest model switch contributes context and it is consumed once', async () => {
  const context = contextFor()
  let releaseOld
  await using({ executeHooks: ({ hookInput }) => (async function* () {
    if (hookInput.to_model === 'old-target') await new Promise(resolve => { releaseOld = resolve })
    yield { additionalContexts: [hookInput.to_model] }
  })() }, async () => {
    r.dispatchPostModelSwitchHooks({ ...request(context), toModel: 'old-target' })
    r.dispatchPostModelSwitchHooks({ ...request(context), toModel: 'latest-target' })
    releaseOld()
    const messages = await r.takePendingLifecycleHookMessages()
    assert.match(JSON.stringify(messages), /latest-target/)
    assert.doesNotMatch(JSON.stringify(messages), /old-target/)
    assert.deepEqual(await r.takePendingLifecycleHookMessages(), [])
  })
})

test('explicit model switch sources suppress duplicate automatic state notifications', async () => {
  const context = contextFor()
  const sources = []
  await using({ executeHooks: ({ hookInput }) => { sources.push(hookInput.source); return iterable([]) } }, async () => {
    r.observeModelSwitch(context.getAppState(), { ...context.getAppState(), mainLoopModel: 'claude-opus-4-6' })
    r.dispatchPostModelSwitchHooks(request(context))
    await r.takePendingLifecycleHookMessages()
    assert.deepEqual(sources, ['command'])
  })
})

test('DirectoryAdded runs in the background and delivers context without starting a turn', async () => {
  let complete
  await using({ executeHooksOutsideREPL: args => {
    assert.equal(args.hookInput.directory, project)
    assert.equal(args.hookInput.source, 'slash_command')
    assert.equal(args.timeoutMs, 600000)
    return new Promise(resolve => { complete = resolve })
  } }, async () => {
    assert.equal(r.dispatchDirectoryAddedHooks(project, contextFor()), undefined)
    assert.deepEqual(await r.takePendingLifecycleHookMessages(), [])
    complete([{ succeeded: true, output: 'stdout ignored', systemMessage: 'repository prepared' }])
    await Promise.resolve()
    assert.match(JSON.stringify(await r.takePendingLifecycleHookMessages()), /repository prepared/)
    assert.deepEqual(await r.takePendingLifecycleHookMessages(), [])
  })
})

test('successive automatic model changes retain the last target', async () => {
  const state = contextFor().getAppState()
  const middle = { ...state, mainLoopModel: 'claude-opus-4-6' }
  const last = { ...state, mainLoopModel: 'claude-haiku-4-5' }
  const targets = []
  await using({ executeHooks: ({ hookInput }) => { targets.push(hookInput.to_model); return iterable([]) } }, async () => {
    r.observeModelSwitch(state, middle)
    r.observeModelSwitch(middle, last)
    await Promise.resolve()
    await r.takePendingLifecycleHookMessages()
    assert.deepEqual(targets, ['claude-haiku-4-5'])
  })
})

test('bridge model control waits for hooks and sends refusals instead of false success', async () => {
  const writes = []
  let complete
  r.handleServerControlRequest({ type: 'control_request', request_id: 'model-request', request: { subtype: 'set_model', model: 'opus' } }, {
    transport: { write: event => { writes.push(event); return Promise.resolve() } }, sessionId: 'fixture-session',
    onSetModel: () => new Promise(resolve => { complete = resolve }),
  })
  assert.equal(writes.length, 0)
  complete({ ok: false, error: 'blocked by model policy' })
  await Promise.resolve()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].response.subtype, 'error')
  assert.equal(writes[0].response.error, 'blocked by model policy')
})

test('hook session titles update persisted names and live state; whitespace cannot erase a title', async () => {
  const saved = []
  const context = contextFor()
  await using({
    saveCustomTitle: async (...args) => saved.push(['title', ...args]),
    saveAgentName: async (...args) => saved.push(['agent', ...args]),
  }, async () => {
    await r.applyHookSessionTitle('  Hook title  ', context)
    await r.applyHookSessionTitle('   ', context)
    assert.equal(saved.length, 2)
    assert.equal(saved[0][2], 'Hook title')
    assert.equal(context.getAppState().standaloneAgentContext.name, 'Hook title')
  })
})
