import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { after, test } from 'node:test'
import { fixtureContext, fixtureTool, executeBlock, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'
import { z } from 'zod/v4'

const root = mkdtempSync(join(tmpdir(), 'tau-hook-parity-'))
Object.assign(process.env, { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' })
after(async () => {
  const child = relative(realpathSync(tmpdir()), realpathSync(root))
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  await rm(root, { recursive: true, force: true, maxRetries: 10 })
})
const r = await loadMcpRuntime({
  paths: ['src/utils/hooks/stopHookState.ts', 'src/utils/hooks/toolHookMetadata.ts',
    'src/utils/hooks/classifierContext.ts', 'src/utils/hooks/lifecycleHooks.ts',
    'src/utils/permissions/yoloClassifier.ts', 'src/services/tools/toolHooks.ts', 'src/utils/hooks.ts',
    'src/utils/conversationRecovery.ts', 'src/utils/hooks/deferredTool.ts', 'src/services/tools/toolOrchestration.ts'],
  exports: ['StopHookContinuationGuard', 'stopHookWorkState', 'toolHookServer', 'stopFailureHookError',
    'createHookClassifierAnnotation', 'classifierAnnotationIsTrusted', 'buildTranscriptForClassifier',
    'sessionStartResumeMetadata', 'getSessionEndHookTimeoutMs', 'getSessionEndHookDefaultTimeoutMs',
    'deferredHookMarker', 'pendingDeferredHookTool', 'deserializeMessagesWithInterruptDetection',
    'getSessionId', 'switchSession', 'setIsInteractive', 'executeHooks', 'executeHooksOutsideREPL',
    'normalizeMessagesForAPI', 'normalizeMessages', 'mergeUserMessages', 'createUserMessage',
    'runTools', 'takeDeferredHookTool', 'createAssistantMessage', 'setSessionPersistenceDisabled',
    'registerHookCallbacks', 'clearRegisteredHooks', 'executeSetupHooks',
    'getParityHookDeps: () => ({executePostToolHooks, executePostToolUseFailureHooks, getHooksConfigFromSnapshot})',
    'setParityHookDeps: d => { if(d.executePostToolHooks) executePostToolHooks=d.executePostToolHooks; if(d.executePostToolUseFailureHooks) executePostToolUseFailureHooks=d.executePostToolUseFailureHooks; if(d.getHooksConfigFromSnapshot) getHooksConfigFromSnapshot=d.getHooksConfigFromSnapshot; }'],
})

test('one deferred call executes nothing, batches ignore defer, and cancellation never runs tools', async () => {
  const original = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '0'
  r.setIsInteractive(false)
  r.setSessionPersistenceDisabled(false)
  let calls = 0
  const tool = fixtureTool({ call: async () => { calls++; return { data: { ok: true } } } })
  try {
    for (const count of [1, 2]) {
      calls = 0
      const blocks = Array.from({ length: count }, (_, i) => ({ type: 'tool_use', id: `batch-${i}`, name: tool.name, input: { path: 'fixture' } }))
      const assistant = r.createAssistantMessage({ content: blocks })
      const context = fixtureContext([tool])
      context.setInProgressToolUseIDs = () => {}
      context.messages = [assistant]
      context.options.mainLoopModel = 'claude-sonnet-4-6'
      const state = context.getAppState()
      context.getAppState = () => state
      state.sessionHooks.set(r.getSessionId(), { hooks: { PreToolUse: [{ matcher: '', hooks: [
        { hook: { type: 'callback', callback: async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }) } },
      ] }] } })
      const output = []
      for await (const update of r.runTools(blocks, [assistant], async (_tool, input) => ({ behavior: 'allow', updatedInput: input }), context)) output.push(update)
      const pending = r.takeDeferredHookTool(context)
      assert.equal(calls, count === 1 ? 0 : 2)
      assert.equal(pending?.id, count === 1 ? blocks[0].id : undefined)
      if (count === 1) {
        const checkpoint = r.deferredHookMarker(pending, assistant)
        const restored = r.deserializeMessagesWithInterruptDetection([assistant, checkpoint])
        assert.equal(r.pendingDeferredHookTool(restored.messages)?.call.id, pending.id)
        assert.equal(restored.turnInterruptionState.kind, 'none')
      }
      context.abortController.abort()
      calls = 0
      for await (const _ of r.runTools(blocks, [assistant], async () => ({ behavior: 'allow' }), context)) {}
      assert.equal(calls, 0)
    }
  } finally { process.env.CLAUDE_CODE_SIMPLE = original }
})

test('tool duration excludes time spent in PostToolUse hooks and is sent on failure too', async () => {
  const deps = r.getParityHookDeps()
  let successDuration, failureDuration
  const delay = ms => new Promise(done => setTimeout(done, ms))
  r.setParityHookDeps({
    executePostToolHooks: (...args) => (async function* () { successDuration = args[8]; await delay(100) })(),
    executePostToolUseFailureHooks: (...args) => (async function* () { failureDuration = args[9] })(),
  })
  try {
    const start = Date.now()
    const tool = fixtureTool({ call: async () => { await delay(30); return { data: {} } } })
    const block = { type: 'tool_use', id: 'duration-fixture', name: tool.name, input: { path: 'fixture' } }
    await executeBlock(r, block, tool)
    assert.ok(successDuration >= 20)
    assert.ok(Date.now() - start >= successDuration + 85, 'hook latency must not be part of duration_ms')
    await executeBlock(r, { ...block, id: 'failed-duration' }, fixtureTool({
      call: async () => { await delay(30); throw new Error('fixture failed') },
    }))
    assert.ok(failureDuration >= 20)
  } finally { r.setParityHookDeps(deps) }
})

test('Setup ignores JSON decisions and context even on exit two; unsupported handlers never run', async () => {
  const original = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '0'
  r.setIsInteractive(false)
  try {
    for (const exitCode of [0, 2]) {
      const context = fixtureContext([])
      context.options.mainLoopModel = 'claude-sonnet-4-6'
      const state = context.getAppState()
      state.sessionHooks.set(r.getSessionId(), { hooks: { Setup: [{ matcher: '', hooks: [
        { hook: { type: 'command', command: process.execPath, args: ['-e',
          `console.log(JSON.stringify({continue:false,decision:'block',systemMessage:'must-ignore',hookSpecificOutput:{hookEventName:'Setup',additionalContext:'must-ignore'}}));process.exitCode=${exitCode}`] } },
        { hook: { type: 'callback', callback: () => { throw new Error('Setup callback must not execute') } } },
      ] }] } })
      const results = []
      for await (const result of r.executeHooks({
        hookInput: { hook_event_name: 'Setup', trigger: 'init', session_id: r.getSessionId(), cwd: root, transcript_path: join(root, 'transcript.jsonl') },
        toolUseID: 'setup-fixture', toolUseContext: { ...context, getAppState: () => state }, timeoutMs: 1000,
      })) results.push(result)
      assert.equal(results.some(result => result.blockingError || result.preventContinuation || result.additionalContexts), false)
      assert.equal(results.some(result => result.message?.attachment?.type === 'hook_system_message'), false)
      assert.doesNotMatch(JSON.stringify(results), /Setup callback must not execute/)
    }
  } finally { process.env.CLAUDE_CODE_SIMPLE = original }
})

test('stop guard resets on a tool call, is per query, and rejects invalid caps', () => {
  const original = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
  try {
    for (const value of ['', '0', '-3', 'NaN', 'Infinity', '2.5']) {
      process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = value
      const guard = new r.StopHookContinuationGuard()
      for (let i = 0; i < 8; i++) assert.equal(guard.allowContinuation(), true)
      assert.equal(guard.allowContinuation(), false)
      assert.equal(new r.StopHookContinuationGuard().allowContinuation(), true)
      guard.resetAfterToolCall()
      assert.equal(guard.allowContinuation(), true)
    }
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
    else process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = original
  }
})

test('Stop reads current work state and caps long fields without mutating the registry', () => {
  const state = { tasks: { a: { id: 'a', type: 'local_bash', status: 'running',
    description: 'd'.repeat(1500), command: 'c'.repeat(1500), isBackgrounded: true },
    b: { id: 'b', type: 'local_agent', status: 'completed', description: 'done' } } }
  const before = JSON.stringify(state)
  const first = r.stopHookWorkState(state)
  assert.equal(first.background_tasks.length, 1)
  assert.equal(first.background_tasks[0].type, 'shell')
  assert.equal(first.background_tasks[0].description.length, 1000)
  assert.match(first.background_tasks[0].command, /… \[\+\d+ chars\]$/)
  assert.equal(JSON.stringify(state), before)
  state.tasks.a.status = 'completed'
  assert.deepEqual(r.stopHookWorkState(state).background_tasks, [])
})

test('SessionEnd settings budget grows independently of hook default and honors overrides', () => {
  const deps = r.getParityHookDeps()
  const original = process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  try {
    delete process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
    r.setParityHookDeps({ getHooksConfigFromSnapshot: () => ({ SessionEnd: [{ hooks: [{ type: 'command', timeout: 5 }] }] }) })
    assert.equal(r.getSessionEndHookTimeoutMs(), 5000)
    assert.equal(r.getSessionEndHookDefaultTimeoutMs(), 1500)
    r.setParityHookDeps({ getHooksConfigFromSnapshot: () => ({ SessionEnd: [{ hooks: [{ type: 'command', timeout: 120 }] }] }) })
    assert.equal(r.getSessionEndHookTimeoutMs(), 60000)
    process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = '7500'
    assert.equal(r.getSessionEndHookTimeoutMs(), 7500)
    assert.equal(r.getSessionEndHookDefaultTimeoutMs(), 7500)
    process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = '2000junk'
    assert.equal(r.getSessionEndHookDefaultTimeoutMs(), 1500)
  } finally {
    r.setParityHookDeps(deps)
    if (original === undefined) delete process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
    else process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = original
  }
})

test('MCP provenance uses config rather than server-name prefixes; richer failure codes survive', () => {
  const tool = fixtureTool({ name: 'anything', mcpInfo: { serverName: 'pretend-official', toolName: 'write' } })
  const context = fixtureContext([tool])
  const state = context.getAppState()
  context.getAppState = () => state
  state.mcp.clients.push({ name: 'pretend-official', type: 'connected', config: { scope: 'project', type: 'stdio' } })
  assert.deepEqual(r.toolHookServer(tool.name, context), { name: 'pretend-official', source: 'project' })
  state.mcp.clients[0].config.pluginSource = 'fixture@marketplace'
  assert.equal(r.toolHookServer(tool.name, context).source, 'plugin')
  for (const code of ['overloaded', 'oauth_org_not_allowed', 'account_on_hold', 'model_not_found', 'cloud_credential_error']) {
    assert.equal(r.stopFailureHookError('unknown', `API error: ${code}`), code)
  }
})

test('classifier annotations validate rewrites, cap combined notes, stay off the main prompt and lose trust on reload', async () => {
  const deps = r.getParityHookDeps()
  const tool = fixtureTool({
    name: 'FixtureTool', outputSchema: z.object({ value: z.string() }),
    call: async () => ({ data: { value: 'original' } }),
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(data) }),
    toAutoClassifierInput: input => input,
  })
  r.setParityHookDeps({ executePostToolHooks: () => (async function* () {
    yield { classifierContext: { text: 'independent', trusted: true } }
    yield { updatedToolOutput: { value: 'first' }, classifierContext: { text: 'superseded', trusted: true } }
    yield { updatedToolOutput: { wrong: true }, classifierContext: { text: 'rejected', trusted: true } }
    yield { updatedToolOutput: { value: 'last' }, classifierContext: { text: 'retained'.repeat(400), trusted: true } }
  })() })
  try {
    const block = { type: 'tool_use', id: 'classifier-fixture', name: tool.name, input: { path: 'fixture' } }
    const result = await executeBlock(r, block, tool)
    const message = result.messages.find(m => m.hookClassifierContext)
    assert.ok(message, JSON.stringify(result.messages))
    const annotation = message.hookClassifierContext
    assert.equal(annotation.text.length, 2000)
    assert.match(annotation.text, /^independent\nretained/)
    assert.doesNotMatch(annotation.text, /superseded|rejected/)
    assert.equal(r.classifierAnnotationIsTrusted(annotation), true)
    const classifier = r.buildTranscriptForClassifier([message], [tool])
    assert.match(classifier, /Live SDK callback/)
    assert.match(classifier, /independent/)
    const reloaded = JSON.parse(JSON.stringify(message))
    assert.match(r.buildTranscriptForClassifier([reloaded], [tool]), /Unverified application context/)
    const normalized = r.normalizeMessages([message])
    assert.match(r.buildTranscriptForClassifier(normalized, [tool]), /independent/)
    const merged = r.mergeUserMessages(r.createUserMessage({ content: 'user prompt' }), normalized[0])
    assert.match(r.buildTranscriptForClassifier([merged], [tool]), /independent/)
    assert.doesNotMatch(JSON.stringify(r.normalizeMessagesForAPI([message], [tool]).map(m => m.message)), /independent|retained|classifierContext/)
    assert.equal(r.buildTranscriptForClassifier([message], [{ ...tool, toAutoClassifierInput: () => '' }]), '')
    assert.equal(r.classifierAnnotationIsTrusted(r.createHookClassifierAnnotation('id', 'tool', {}, [
      { text: 'a', trusted: true }, { text: 'b', trusted: false },
    ])), false)
  } finally { r.setParityHookDeps(deps) }
})

test('resume hook metadata reads the latest transcript without changing its context', () => {
  const messages = [{ type: 'assistant', uuid: 'a', timestamp: new Date(1000).toISOString(),
    message: { model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } }]
  const before = JSON.stringify(messages)
  const warm = r.sessionStartResumeMetadata(messages, 'claude-sonnet-4-6', 2000)
  assert.equal(warm.seconds_since_last_response, 1)
  assert.equal(warm.context_tokens, 130)
  assert.equal(warm.prompt_cache_likely_expired, false)
  assert.equal(r.sessionStartResumeMetadata(messages, 'claude-sonnet-4-6', 7_201_000).prompt_cache_likely_expired, true)
  assert.equal(JSON.stringify(messages), before)
  assert.deepEqual(r.sessionStartResumeMetadata([]), {})
})
