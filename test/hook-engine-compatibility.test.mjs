import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const originalCwd = process.cwd()
const directory = mkdtempSync(join(tmpdir(), 'tau-hook-engine-'))
const project = join(directory, 'project with spaces')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(directory, 'config'),
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1', NO_PROXY: '127.0.0.1,localhost',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
after(() => {
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true, maxRetries: 10 })
})
const r = await loadMcpRuntime({
  paths: [
    'src/utils/hooks.ts', 'src/utils/hooks/hookPolicy.ts',
    'src/utils/hooks/execMcpToolHook.ts', 'src/utils/hooks/execHttpHook.ts',
    'src/query/stopHooks.ts', 'src/utils/sessionStorage.ts',
  ],
  exports: [
    'executeHooks', 'executeHooksOutsideREPL', 'execCommandHook',
    'execMcpToolHook', 'substituteHookInputPaths',
    'literalHookMatcherParts', 'defaultHookTimeoutMs', 'hookFailureBlockReason',
    'isAllowedTerminalSequence', 'getMatchingHooks', 'getSessionId', 'setIsInteractive',
    'emitHookTerminalSequence', 'inkInstances: instances_default',
    'parseHookOutput', 'registerHookCallbacks', 'clearRegisteredHooks',
    'executeSessionStartHooks', 'executeUserPromptSubmitHooks', 'handleStopHooks',
    'cacheSessionTitle', 'clearSessionMetadata', 'restoreSessionMetadata', 'switchSession',
  ],
})
r.setIsInteractive(false)

const input = event => ({
  session_id: r.getSessionId(), transcript_path: join(project, 'transcript.jsonl'),
  cwd: project, permission_mode: 'default', hook_event_name: event,
  tool_name: 'Write', tool_use_id: 'fixture-call', tool_input: { file_path: 'a b.txt', count: 0 },
  ...(event === 'PreModelSwitch' ? { from_model: 'claude-sonnet-4-6', to_model: 'claude-opus-4-6', requested_model: 'opus', source: 'slash_command' } : {}),
})
const command = (script, extra = {}) => ({ type: 'command', command: process.execPath, args: ['-e', script], ...extra })
const contextFor = (hook, event, clients = []) => {
  const context = fixtureContext([])
  context.options.mainLoopModel = 'claude-sonnet-4-6'
  const state = context.getAppState()
  state.mcp.clients = clients
  state.sessionHooks.set(r.getSessionId(), { hooks: { [event]: [{ matcher: '', hooks: [{ hook }] }] } })
  return { ...context, getAppState: () => state }
}
async function collect(generator) {
  const results = []
  for await (const result of generator) results.push(result)
  return results
}
async function run(hook, { event = 'PreToolUse', outside = false, signal, clients = [] } = {}) {
  const context = contextFor(hook, event, clients)
  if (outside) return r.executeHooksOutsideREPL({
    hookInput: input(event), getAppState: context.getAppState, signal, timeoutMs: 2000,
  })
  return collect(r.executeHooks({
    hookInput: input(event), toolUseID: 'fixture-call', toolUseContext: context,
    signal, timeoutMs: 2000,
  }))
}
const blocked = results => results.some(result => result.blocked || result.blockingError)

test('interactive host confirmation does not keep ordinary command-hook stdin open', async () => {
  const script = `let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreModelSwitch',permissionDecision:'ask',permissionDecisionReason:'EOF received'}})));`
  const context = contextFor(command(script), 'PreModelSwitch')
  const results = await collect(r.executeHooks({
    hookInput: input('PreModelSwitch'), toolUseID: 'stdin-fixture', toolUseContext: context,
    timeoutMs: 2000,
    requestPrompt: () => async () => { throw new Error('Host confirmation runs after hook completion') },
  }))
  assert.ok(results.some(result => result.permissionBehavior === 'ask' && result.hookPermissionDecisionReason === 'EOF received'))
  assert.equal(blocked(results), false)
})

test('terminal sequences use the mounted console fallback and stay out of headless output', () => {
  const writes = []
  const consoleStream = { isTTY: true, write: value => writes.push(value) }
  const sequence = '\x1b]0;fixture title\x07'
  r.inkInstances.set(consoleStream, {})
  try {
    r.setIsInteractive(true)
    r.emitHookTerminalSequence(sequence)
    assert.deepEqual(writes, [sequence])
    r.setIsInteractive(false)
    r.emitHookTerminalSequence(sequence)
    assert.equal(writes.length, 1)
    r.setIsInteractive(true)
    r.emitHookTerminalSequence('\x1b]52;c;clipboard\x07')
    assert.equal(writes.length, 1)
  } finally {
    r.inkInstances.delete(consoleStream)
    r.setIsInteractive(false)
  }
})

test('exec-form command preserves argv boundaries, stdin and native plugin path substitution', async () => {
  const arguments_ = ['a b', '"quoted"', '; echo unsafe', '$(echo unsafe)', '', 'line\nbreak', 'λ', '${CLAUDE_PLUGIN_ROOT}/child path']
  const script = `let stdin='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>stdin+=chunk);process.stdin.on('end',()=>console.log(JSON.stringify({argv:process.argv.slice(1),input:JSON.parse(stdin)})));`
  const result = await r.execCommandHook(
    { ...command(script), args: ['-e', script, '--', ...arguments_] },
    'PreToolUse', 'fixture', JSON.stringify(input('PreToolUse')),
    new AbortController().signal, 'fixture-hook', 0, project,
  )
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed.argv, [...arguments_.slice(0, -1), `${project}/child path`])
  assert.deepEqual(parsed.input.tool_input, { file_path: 'a b.txt', count: 0 })
})

test('onFailure blocks command failures and bad JSON in both hook entry points', async () => {
  const failures = [
    command('process.stderr.write("failed");process.exitCode=1'),
    command('console.log(JSON.stringify({continue:"wrong type"}))'),
    // Starts with { and ends with }, so it is a parse failure, not plain text.
    command('process.stdout.write("{bad json}")'),
    { type: 'command', command: join(project, 'missing-program.exe'), args: [] },
  ]
  for (const outside of [false, true]) {
    for (const hook of failures) {
      assert.equal(blocked(await run({ ...hook, onFailure: 'block' }, { outside })), true, JSON.stringify({ outside, hook }))
      assert.equal(blocked(await run({ ...hook, onFailure: 'continue' }, { outside })), false, JSON.stringify({ outside, hook }))
    }
  }
})

test('exit two remains blocking even with success JSON or onFailure continue', async () => {
  const hook = command('console.log(JSON.stringify({decision:"approve"}));process.stderr.write("policy denied");process.exitCode=2', { onFailure: 'continue' })
  for (const outside of [false, true]) {
    assert.equal(blocked(await run(hook, { outside })), true)
  }
})

test('hook timeout blocks when requested; cancelling the caller never becomes a policy denial', async () => {
  for (const outside of [false, true]) {
    const hook = command('setInterval(()=>{},1000)', { timeout: 0.08, onFailure: 'block' })
    assert.equal(blocked(await run(hook, { outside })), true)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 50)
    try {
      assert.equal(blocked(await run({ ...hook, timeout: 5 }, { outside, signal: controller.signal })), false)
    } finally { clearTimeout(timer) }
  }
})

test('HTTP failures, malformed responses, timeouts and cancellation obey failure policy', async () => {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      if (request.url === '/timeout') return
      if (request.url === '/error') response.statusCode = 503
      response.end(request.url === '/invalid' ? 'not JSON' : '{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    for (const outside of [false, true]) {
      for (const path of ['/error', '/invalid', '/timeout']) {
        const hook = { type: 'http', url: base + path, onFailure: 'block', timeout: 0.15 }
        assert.equal(blocked(await run(hook, { outside })), true, `${outside} ${path}`)
        assert.equal(blocked(await run({ ...hook, onFailure: 'continue' }, { outside })), false, `${outside} ${path}`)
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 50)
      try {
        assert.equal(blocked(await run({ type: 'http', url: base + '/timeout', onFailure: 'block', timeout: 5 }, { outside, signal: controller.signal })), false)
      } finally { clearTimeout(timer) }
      assert.equal(blocked(await run({ type: 'http', url: base + '/ok', onFailure: 'block' }, { outside })), false)
    }
    assert.ok(requests.length > 0)
    assert.equal(requests[0].hook_event_name, 'PreToolUse')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('MCP hooks substitute nested paths, call the named server and parse text JSON', async () => {
  const seen = []
  const hook = { type: 'mcp_tool', server: 'policy', tool: 'check', input: {
    file: '${tool_input.file_path}', nested: ['${tool_input.count}', '${missing}'], whole: '${tool_input}',
  } }
  const clients = [{ name: 'policy', type: 'connected', client: {
    async callTool(args, schema, options) {
      seen.push({ args, schema, options })
      return { content: [{ type: 'image', data: 'ignored' }, { type: 'text', text: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'MCP policy' } }) }] }
    },
  } }]
  const output = await run(hook, { clients })
  assert.equal(output.some(result => result.permissionBehavior === 'deny'), true)
  assert.deepEqual(seen[0].args, { name: 'check', arguments: {
    file: 'a b.txt', nested: ['0', ''], whole: JSON.stringify(input('PreToolUse').tool_input),
  } })
  assert.equal(seen[0].options.timeout, 2000)
  assert.ok(seen[0].options.signal instanceof AbortSignal)
})

test('MCP error results and absent server context are distinguished from valid hook JSON', async () => {
  const hook = { type: 'mcp_tool', server: 'policy', tool: 'check' }
  const arguments_ = { hook, hookEvent: 'PreToolUse', hookInput: input('PreToolUse'), timeoutMs: 1000, signal: new AbortController().signal }
  assert.match((await r.execMcpToolHook(arguments_)).skipped, /no MCP client context/)
  assert.equal((await r.execMcpToolHook({ ...arguments_, getClients: () => [] })).status, 1)
  const errored = await r.execMcpToolHook({ ...arguments_, getClients: () => [{ name: 'policy', type: 'connected', client: { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'tool unavailable' }] }) } }] })
  assert.equal(errored.status, 1)
  assert.equal(errored.stderr, 'tool unavailable')
  assert.equal(errored.stdout, '')
  const malformed = await run(hook, { clients: [{ name: 'policy', type: 'connected', client: { callTool: async () => ({ content: [{ type: 'text', text: '{bad json}' }] }) } }] })
  assert.ok(malformed.some(result => result.message?.attachment?.type === 'hook_non_blocking_error'))
  assert.equal(blocked(malformed), false)
})

test('literal comma matchers and event timeouts match the documented contracts', async () => {
  assert.deepEqual(r.literalHookMatcherParts('Read, Write|Edit', 'PreToolUse'), ['Read', 'Write', 'Edit'])
  assert.equal(r.literalHookMatcherParts('mcp__.*', 'PreToolUse'), undefined)
  assert.equal(r.literalHookMatcherParts('foo,bar', 'FileChanged'), undefined)
  assert.equal(r.literalHookMatcherParts('foo-bar', 'StopFailure'), undefined)
  const hook = command('')
  const context = contextFor(hook, 'PreToolUse')
  context.getAppState().sessionHooks.get(r.getSessionId()).hooks.PreToolUse[0].matcher = 'Read, Write'
  assert.equal((await r.getMatchingHooks(context.getAppState(), r.getSessionId(), 'PreToolUse', input('PreToolUse'))).length, 1)
  assert.equal((await r.getMatchingHooks(context.getAppState(), r.getSessionId(), 'PreToolUse', { ...input('PreToolUse'), tool_name: 'Bash' })).length, 0)
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolBatch']) assert.equal(r.defaultHookTimeoutMs(event), 600000)
  for (const event of ['UserPromptSubmit', 'PreModelSwitch', 'PostModelSwitch']) assert.equal(r.defaultHookTimeoutMs(event), 30000)
  assert.equal(r.defaultHookTimeoutMs('MessageDisplay'), 10000)
  assert.equal(r.hookFailureBlockReason({ type: 'command', onFailure: 'block' }, 'Stop', false), undefined)
  assert.equal(r.hookFailureBlockReason({ type: 'command', onFailure: 'block', async: true }, 'PreToolUse', false), undefined)
  assert.ok(r.hookFailureBlockReason({ type: 'command', onFailure: 'continue' }, 'PreModelSwitch', true))
})

test('terminal sequences allow notifications only and reject unsafe sequences in their entirety', () => {
  for (const sequence of ['\x07', '\x1b]0;title\x07', '\x1b]9;done\x1b\\', '\x1b]9;4;1;50\x07', '\x1b]99;message\x07', '\x1b]777;notify;title;body\x07', '\x07\x1b]2;title\x07']) {
    assert.equal(r.isAllowedTerminalSequence(sequence), true, JSON.stringify(sequence))
  }
  for (const sequence of ['', 'text', '\x1b[2J', '\x1b]52;c;clipboard\x07', '\x1b]8;;https://example.com\x07', '\x1b]0;title\nunsafe\x07', '\x1b]0;title\x07text', '\x07\x1b[2J', '\x1b]0;unterminated']) {
    assert.equal(r.isAllowedTerminalSequence(sequence), false, JSON.stringify(sequence))
  }
})

test('PreModelSwitch bounds callbacks that ignore their signal and keeps the current model', async () => {
  // The hook timeout is unref'd, and a real host's REPL or SDK transport keeps
  // the process alive. Node 20 and 22 end a test with nothing else pending.
  const host = setInterval(() => {}, 1000)
  try {
    for (const outside of [false, true]) {
      const startedAt = Date.now()
      const output = await run({ type: 'callback', timeout: 0.05, callback: () => new Promise(() => {}) }, { event: 'PreModelSwitch', outside })
      assert.equal(blocked(output), true)
      assert.ok(Date.now() - startedAt < 1500, 'a callback that ignores AbortSignal must still be bounded')
    }
  } finally { clearInterval(host) }
})

test('callback errors are isolated and do not prevent other hooks from delivering context', async () => {
  const first = { type: 'callback', callback: async () => { throw new Error('fixture callback failed') } }
  const second = { type: 'callback', callback: async () => ({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'surviving callback context' } }) }
  const context = contextFor(first, 'PostToolBatch')
  context.getAppState().sessionHooks.get(r.getSessionId()).hooks.PostToolBatch[0].hooks.push({ hook: second })
  const output = await collect(r.executeHooks({ hookInput: { ...input('PostToolBatch'), tool_calls: [] }, toolUseID: 'fixture-batch', toolUseContext: context }))
  assert.equal(blocked(output), false)
  assert.ok(output.some(result => result.additionalContexts?.includes('surviving callback context')))
  assert.ok(output.some(result => /fixture callback failed/.test(JSON.stringify(result))))
})

test('an already-aborted MCP hook never calls a server', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const output = await r.execMcpToolHook({
    hook: { type: 'mcp_tool', server: 'policy', tool: 'check' }, hookEvent: 'PreToolUse',
    hookInput: input('PreToolUse'), timeoutMs: 1000, signal: controller.signal,
    getClients: () => [{ name: 'policy', type: 'connected', client: { callTool: async () => { calls++; return { content: [] } } } }],
  })
  assert.equal(calls, 0)
  assert.equal(output.aborted, true)
})

test('headless defer is passed to the tool runner without pretending to deny permission', async () => {
  const hook = command('console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"defer"}}))')
  const output = await run(hook)
  assert.equal(blocked(output), false)
  assert.ok(output.some(result => result.deferTool === true))
})

test('hook output parsing follows the documented plain-text and JSON rules', () => {
  const kind = text => {
    const parsed = r.parseHookOutput(text)
    return parsed.validationError ? 'invalid' : parsed.json ? 'json' : 'plain'
  }
  assert.equal(kind('{"continue":true}'), 'json')
  assert.equal(kind('  {"continue":true}\n'), 'json')
  assert.equal(kind('plain text'), 'plain')
  assert.equal(kind('{ status line without a closing brace'), 'plain')
  assert.equal(kind('[1, 2]'), 'plain')
  assert.equal(kind('"quoted"'), 'plain')
  assert.equal(kind('{"event":"start"}\n{"event":"done"}'), 'plain', 'a JSON-lines log')
  assert.equal(kind('{"event":"start"}\n{"continue":false}'), 'invalid', 'a log line that sets an output field')
  assert.equal(kind('{not json}'), 'invalid')
  assert.equal(kind('{"continue":"wrong type"}'), 'invalid')
})

test('the second runner lets valid JSON decide for exit codes other than 0 and 2', async () => {
  const exiting = (code, output) => command(`process.stdout.write(${JSON.stringify(JSON.stringify(output))});process.stderr.write("stderr text");process.exitCode=${code}`)
  const [decided] = await run(exiting(1, { decision: 'block', hookSpecificOutput: { hookEventName: 'CwdChanged', watchPaths: [project] } }), { event: 'CwdChanged', outside: true })
  assert.equal(decided.blocked, true)
  assert.equal(decided.succeeded, true)
  assert.deepEqual(decided.watchPaths, [project])
  assert.equal(decided.output, '', 'consumers such as PreCompact never read raw JSON text as output')
  // Exit 2 blocks whatever the JSON says, with stderr as the reason; its fields are still read.
  const [exitTwo] = await run(exiting(2, { systemMessage: 'still read' }), { event: 'ConfigChange', outside: true })
  assert.equal(exitTwo.blocked, true)
  assert.equal(exitTwo.output, 'stderr text')
  assert.equal(exitTwo.systemMessage, 'still read')
  // A worktree hook fails on any non-zero exit, whatever its JSON says.
  const [worktree] = await run(exiting(1, { systemMessage: 'ignored' }), { event: 'WorktreeCreate', outside: true })
  assert.equal(worktree.succeeded, false)
  assert.equal(worktree.output, 'stderr text')
  // For a hook whose failure blocks, the exit is a failure even with valid JSON.
  const [policy] = await run({ ...exiting(1, {}), onFailure: 'block' }, { event: 'ConfigChange', outside: true })
  assert.equal(policy.blocked, true)
  assert.equal(policy.succeeded, false)
  const [plain] = await run(command('process.stdout.write("plain");process.exitCode=1'), { event: 'ConfigChange', outside: true })
  assert.equal(plain.succeeded, false)
  assert.equal(plain.blocked, false)
})

test('an mcp_tool hook skipped for lack of MCP context is not reported as a failure', async () => {
  r.registerHookCallbacks({ SessionEnd: [{
    matcher: '', hooks: [{ type: 'mcp_tool', server: 'policy', tool: 'check' }],
    pluginRoot: project, pluginName: 'fixture', pluginId: 'fixture@local',
  }] })
  try {
    const results = await r.executeHooksOutsideREPL({ hookInput: input('SessionEnd'), timeoutMs: 1000 })
    assert.equal(results.length, 1)
    assert.equal(results[0].succeeded, true)
    assert.equal(results[0].blocked, false)
  } finally {
    r.clearRegisteredHooks()
  }
})

test('command stdin and CLAUDE_EFFORT agree with the current model effort', async () => {
  const script = `let stdin='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>stdin+=chunk);process.stdin.on('end',()=>console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:JSON.parse(stdin).effort.level+'|'+process.env.CLAUDE_EFFORT}})));`
  const context = contextFor(command(script), 'PreToolUse')
  context.getAppState().effortValue = 'medium'
  const output = await collect(r.executeHooks({ hookInput: input('PreToolUse'), toolUseID: 'fixture-effort', toolUseContext: context }))
  assert.ok(output.some(result => result.additionalContexts?.includes('medium|medium')))
})

test('model-switch matchers filter canonical Claude IDs and run all hooks for unknown IDs', async () => {
  for (const event of ['PreModelSwitch', 'PostModelSwitch']) {
    const makeHook = name => ({ type: 'callback', name, callback: async () => ({}) })
    const hooks = [
      { matcher: '^claude-', hooks: [{ hook: makeHook('claude') }] },
      { matcher: '^gemini-', hooks: [{ hook: makeHook('gemini') }] },
      { matcher: 'deepseek-chat', hooks: [{ hook: makeHook('deepseek') }] },
      { matcher: '', hooks: [{ hook: makeHook('all') }] },
    ]
    const context = contextFor(makeHook('unused'), event)
    context.getAppState().sessionHooks.get(r.getSessionId()).hooks[event] = hooks
    for (const [model, expected] of [
      ['gemini-3-pro', ['claude', 'gemini', 'deepseek', 'all']],
      ['deepseek-chat', ['claude', 'gemini', 'deepseek', 'all']],
      ['gpt-6-luna', ['claude', 'gemini', 'deepseek', 'all']],
      ['us.anthropic.claude-sonnet-4-6-v1:0[1m]', ['claude', 'all']],
    ]) {
      const matched = await r.getMatchingHooks(context.getAppState(), r.getSessionId(), event, { ...input(event), to_model: model })
      assert.deepEqual(matched.map(result => result.hook.name), expected, `${event}: ${model}`)
    }
  }
})

test('session and prompt inputs contain the current resumed or renamed title', async () => {
  const seen = []
  const hook = { type: 'callback', callback: async value => { seen.push(value); return {} } }
  r.registerHookCallbacks({ SessionStart: [{ matcher: '', hooks: [hook] }] })
  const context = contextFor(hook, 'UserPromptSubmit')
  try {
    r.clearSessionMetadata()
    await collect(r.executeSessionStartHooks('startup', undefined, undefined, undefined, undefined, 1000))
    assert.equal(seen.at(-1).session_title, undefined)
    r.restoreSessionMetadata({ customTitle: 'Resumed lab title' })
    await collect(r.executeSessionStartHooks('resume', undefined, undefined, undefined, undefined, 1000))
    assert.equal(seen.at(-1).session_title, 'Resumed lab title')
    r.cacheSessionTitle('Renamed lab title')
    await collect(r.executeUserPromptSubmitHooks('hello', 'default', context))
    assert.equal(seen.at(-1).session_title, 'Renamed lab title')
    await collect(r.executeSessionStartHooks('startup', 'unrelated-session', undefined, undefined, undefined, 1000))
    assert.equal(seen.at(-1).session_title, undefined, 'never borrow another session title')
  } finally {
    r.clearRegisteredHooks()
    r.clearSessionMetadata()
  }
})

test('Stop and SubagentStop JSON context survives validation and execution', async () => {
  for (const event of ['Stop', 'SubagentStop']) {
    const json = { hookSpecificOutput: { hookEventName: event, additionalContext: `${event} context` } }
    assert.equal(r.parseHookOutput(JSON.stringify(json)).validationError, undefined)
    const output = await run(command(`console.log(${JSON.stringify(JSON.stringify(json))})`), { event })
    assert.ok(output.some(result => result.additionalContexts?.includes(`${event} context`)))
    assert.equal(blocked(output), false, 'feedback continues without being reported as a blocking error')
  }
})

test('Stop context reaches the transcript and a blocked-stop continuation', async () => {
  // --bare suppresses unrelated background bookkeeping; SIMPLE remains off
  // so the real hook engine still runs against this local fixture.
  process.argv.push('--bare')
  try {
    for (const shouldBlock of [false, true]) {
      const output = { ...(shouldBlock ? { decision: 'block', reason: 'finish the fixture' } : {}),
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'carry this context' } }
      const context = contextFor(command(`console.log(${JSON.stringify(JSON.stringify(output))})`), 'Stop')
      const generator = r.handleStopHooks([], [], [], {}, {}, context, 'fixture')
      const messages = []
      let completion
      while (true) {
        const next = await generator.next()
        if (next.done) { completion = next.value; break }
        messages.push(next.value)
      }
      const contexts = messages.filter(message => message.attachment?.type === 'hook_additional_context')
      assert.equal(contexts.length, 1)
      assert.deepEqual(contexts[0].attachment.content, ['carry this context'])
      assert.deepEqual(completion.additionalContextMessages, contexts)
      assert.equal(completion.blockingErrors.length, shouldBlock ? 1 : 0)
      assert.equal(completion.preventContinuation, false)
    }
  } finally { process.argv.pop() }
})

test('classifier context stays paired with its hook provenance without warnings or main-model context', async () => {
  const sessionId = r.getSessionId()
  const hook = { type: 'callback', callback: async () => ({ systemMessage: 'ordinary notice',
    hookSpecificOutput: { hookEventName: 'PostToolUse', classifierContext: 'untrusted hint', additionalContext: 'normal context' } }) }
  try {
    for (let i = 0; i < 2; i++) {
      const output = await run(hook, { event: 'PostToolUse' })
      const notices = output.filter(result => result.message?.attachment?.type === 'hook_system_message')
      assert.equal(JSON.stringify(notices).includes('Tau ignored classifierContext'), false)
      assert.deepEqual(output.find(result => result.classifierContext)?.classifierContext,
        { text: 'untrusted hint', trusted: true })
      assert.ok(JSON.stringify(notices).includes('ordinary notice'))
      assert.ok(output.some(result => result.additionalContexts?.includes('normal context')))
      assert.equal(blocked(output), false)
    }
    r.switchSession('classifier-warning-new-session')
    const nextSession = await run(hook, { event: 'PostToolUse' })
    assert.equal(JSON.stringify(nextSession).includes('Tau ignored classifierContext'), false)
  } finally { r.switchSession(sessionId) }
})

test('outside-REPL policy results preserve JSON block reasons and exit-two stderr', async () => {
  const json = { decision: 'block', reason: 'settings are locked' }
  const script = `console.log(${JSON.stringify(JSON.stringify(json))});process.exitCode=1`
  const [commandResult] = await run(command(script), { event: 'ConfigChange', outside: true })
  assert.equal(commandResult.blockingReason, 'settings are locked')
  assert.equal(commandResult.output, '')
  const [callbackResult] = await run({ type: 'callback', callback: async () => json }, { event: 'ConfigChange', outside: true })
  assert.equal(callbackResult.blockingReason, 'settings are locked')
  const [exitTwo] = await run(command(`${script};process.stderr.write('exit-two reason');process.exitCode=2`), { event: 'ConfigChange', outside: true })
  assert.equal(exitTwo.blockingReason, 'exit-two reason')
  const [failed] = await run(command('process.stderr.write("policy crash");process.exitCode=1', { onFailure: 'block' }), { event: 'ConfigChange', outside: true })
  assert.equal(failed.blockingReason, 'policy crash')
  const server = createServer((_request, response) => response.end(JSON.stringify(json)))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const [httpResult] = await run({ type: 'http', url: `http://127.0.0.1:${server.address().port}` }, { event: 'ConfigChange', outside: true })
    assert.equal(httpResult.blockingReason, 'settings are locked')
    const clients = [{ name: 'policy', type: 'connected', client: { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(json) }] }) } }]
    const [mcpResult] = await run({ type: 'mcp_tool', server: 'policy', tool: 'check' }, { event: 'ConfigChange', outside: true, clients })
    assert.equal(mcpResult.blockingReason, 'settings are locked')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
