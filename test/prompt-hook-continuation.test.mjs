import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fixtureContext, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

// Prompt hooks against a fake Anthropic API, through the real CLI and, for what
// only the screen shows, through the Stop hook engine. On Stop and SubagentStop,
// ok:false sends the reason back to Claude and the turn goes on, unless the
// evaluator judges the condition impossible. On other events a block ends the
// turn, unless the hook sets continueOnBlock and the event can go on.

const TASK = 'SUBAGENT_FIXTURE_TASK'
const cli = resolve('dist/cli.mjs'), bundle = resolve('dist/tau.mjs')
const root = mkdtempSync(join(tmpdir(), 'tau-prompt-hooks-'))
const workspace = join(root, 'project'), config = join(root, 'config'), home = join(root, 'home')
for (const dir of [workspace, config, home, join(workspace, '.claude')]) mkdirSync(dir, { recursive: true })
const target = join(workspace, 'fixture.txt')

let script = {}, requests = [], env
const pick = (list, index) => list[Math.min(index, list.length - 1)]
const textOf = message => typeof message.content === 'string' ? message.content
  : message.content.map(block => block.text ?? '').join('\n')
// Only the evaluator asks for structured output; a subagent starts from the Agent call's prompt.
const kindOf = body => body.output_config?.format ? 'evaluator'
  : textOf(body.messages.find(message => message.role === 'user')).includes(TASK) ? 'subagent' : 'main'

const server = createServer((req, res) => {
  let raw = ''
  // Decode across chunks: a multi-byte character split between two chunks would
  // otherwise turn into U+FFFD and fake a changed prompt.
  req.setEncoding('utf8')
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    if (!req.url.includes('/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return
    }
    const body = JSON.parse(raw)
    const kind = kindOf(body)
    const answer = pick(script[kind] ?? ['Unexpected request.'], requests.filter(r => r.kind === kind).length)
    requests.push({ kind, body })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(anthropicReply(typeof answer === 'string' || Array.isArray(answer) ? answer : JSON.stringify(answer), body.model))
  })
})

before(async () => {
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_API_KEY: 'sk-ant-prompt-hook-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
  })
})

after(async () => {
  await new Promise(done => server.close(done))
  const child = relative(realpathSync(tmpdir()), realpathSync(root))
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  await rm(root, { recursive: true, force: true, maxRetries: 10 })
})

async function run(hooks, scripted, prompt, extraEnv = {}) {
  writeFileSync(join(workspace, '.claude', 'settings.json'), JSON.stringify({ hooks }))
  rmSync(target, { force: true })
  script = scripted
  requests = []
  const child = spawn(process.execPath, [cli, '-p', prompt, '--output-format', 'json',
    '--model', 'claude-sonnet-4-6', '--strict-mcp-config', '--setting-sources', 'project',
    '--dangerously-skip-permissions', '--max-turns', '6'], {
    cwd: workspace, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill(), 60_000)
  const code = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject) })
  clearTimeout(timer)
  let output = null
  try { output = JSON.parse(stdout) } catch {}
  const sent = kind => requests.filter(request => request.kind === kind).map(request => request.body)
  return { code, output, log: `exit ${code}\n${stderr}\n${stdout}`, main: sent('main'), evaluator: sent('evaluator'), subagent: sent('subagent') }
}

function transcript(sessionId) {
  const file = readdirSync(join(config, 'projects'), { recursive: true }).map(String)
    .find(name => name.endsWith(`${sessionId}.jsonl`))
  assert.ok(file, 'the session transcript was written')
  return readFileSync(join(config, 'projects', file), 'utf8')
}

// Prompt caching needs every continuation to resend the earlier request unchanged and add to its end.
const withoutCacheMarks = value => JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item)
function assertUnchanged(after, before, what) {
  const a = withoutCacheMarks(after), b = withoutCacheMarks(before)
  if (a === b) return
  let i = 0
  while (a[i] === b[i]) i++
  assert.fail(`${what} changed at character ${i}\n  before: ${b.slice(Math.max(0, i - 160), i + 80)}\n  after:  ${a.slice(Math.max(0, i - 160), i + 80)}`)
}
function assertAppendOnly(first, next) {
  assertUnchanged(next.system, first.system, 'the system prompt')
  assertUnchanged(next.tools, first.tools, 'the tool list')
  assert.ok(next.messages.length > first.messages.length)
  assertUnchanged(next.messages.slice(0, first.messages.length), first.messages, 'the earlier messages')
}

const promptHook = (prompt, extra = {}) => [{ hooks: [{ type: 'prompt', prompt, ...extra }] }]
const onWrite = (prompt, extra = {}) => [{ matcher: 'Write', hooks: [{ type: 'prompt', prompt, ...extra }] }]
const writeCall = [{ name: 'Write', input: { file_path: target, content: 'fixture' } }]
const toolResults = request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  .filter(block => block.type === 'tool_result')

test('Stop: ok:false sends the reason back and the turn goes on until the condition holds', { timeout: 120_000 }, async () => {
  const { output, main, evaluator, log } = await run({ Stop: promptHook('The fixture check ran.') }, {
    main: ['First answer.', 'Checked and done.'],
    evaluator: [{ ok: false, reason: 'Run the fixture check first.' }, { ok: true, reason: 'It ran.' }],
  }, 'Do the fixture task.')
  assert.equal(main.length, 2, `the reason sends Claude back to work once\n${log}`)
  assert.equal(evaluator.length, 2)
  assert.equal(output.result, 'Checked and done.')
  assert.ok(JSON.stringify(main[1].messages).includes('Run the fixture check first.'))
  assertAppendOnly(main[0], main[1])
})

test('Stop: the continuation cap still ends a condition that never holds', { timeout: 120_000 }, async () => {
  const { main, evaluator, log } = await run({ Stop: promptHook('A condition that never holds.') }, {
    main: ['Still working.'], evaluator: [{ ok: false, reason: 'Not yet.' }],
  }, 'Loop fixture.', { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '2' })
  assert.equal(main.length, 3, `two continuations, then the cap ends the turn\n${log}`)
  assert.equal(evaluator.length, 3)
})

test('Stop: an impossible condition ends the turn and keeps the answer', { timeout: 120_000 }, async () => {
  // -p writes the records after the last answer lazily; flush them before the result.
  const { output, main, evaluator, log } = await run({ Stop: promptHook('The change is deployed.') }, {
    main: ['There is no deploy access here.', 'Unexpected second turn.'],
    evaluator: [{ ok: false, impossible: true, reason: 'No deploy access in this session.' }],
  }, 'Deploy the fixture.', { CLAUDE_CODE_EAGER_FLUSH: '1' })
  assert.equal(main.length, 1, log)
  assert.equal(output.result, 'There is no deploy access here.')
  const { schema } = evaluator[0].output_config.format
  assert.equal(schema.properties.impossible?.type, 'boolean', 'the Stop evaluator may answer impossible')
  assert.ok(!transcript(output.session_id).includes('Stop hook feedback'), 'nothing is left for Claude to read next turn')
})

test('Stop: an impossible condition tells the user why the stop went ahead', { timeout: 120_000 }, async () => {
  // -p keeps display-only notices out of its output and transcript, so ask the engine.
  const cwd = process.cwd()
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: join(root, 'engine-config'), ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, NO_PROXY: env.NO_PROXY, TAU_MCP_TEST_BUNDLE: bundle,
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
  })
  process.chdir(workspace)
  process.argv.push('--bare')
  try {
    const r = await loadMcpRuntime({ paths: ['src/utils/hooks.ts', 'src/query/stopHooks.ts'],
      exports: ['handleStopHooks', 'getSessionId', 'setIsInteractive'] })
    r.setIsInteractive(false)
    const context = fixtureContext([])
    const state = context.getAppState()
    state.sessionHooks.set(r.getSessionId(), { hooks: { Stop: [{ matcher: '', hooks: [{ hook: { type: 'prompt', prompt: 'The change is deployed.' } }] }] } })
    Object.assign(context, { getAppState: () => state, setResponseLength: () => {} })
    script = { evaluator: [{ ok: false, impossible: true, reason: 'No deploy access in this session.' }] }
    requests = []
    const generator = r.handleStopHooks([], [], [], {}, {}, context, 'fixture')
    const yielded = []
    let next
    while (!(next = await generator.next()).done) yielded.push(next.value)
    assert.equal(requests.length, 1)
    assert.deepEqual({ blockingErrors: next.value.blockingErrors.length, preventContinuation: next.value.preventContinuation },
      { blockingErrors: 0, preventContinuation: false }, 'the stop goes ahead')
    assert.deepEqual(yielded.filter(message => message.attachment?.type === 'hook_system_message').map(message => message.attachment.content),
      ['Prompt hook condition cannot be met, stopping anyway: No deploy access in this session.'])
    assert.ok(!yielded.some(message => message.type === 'user'), 'nothing is queued for Claude')
  } finally {
    process.argv.pop()
    process.chdir(cwd)
  }
})

test('SubagentStop: ok:false keeps the subagent working until the condition holds', { timeout: 120_000 }, async () => {
  const { output, main, subagent, evaluator, log } = await run({ SubagentStop: promptHook('The subagent finished its task.') }, {
    main: [[{ name: 'Agent', input: { description: 'Fixture task', prompt: `${TASK}: report done.`, subagent_type: 'general-purpose' } }], 'Main done.'],
    subagent: ['Sub first.', 'Sub second.'],
    evaluator: [{ ok: false, reason: 'Finish the fixture task.' }, { ok: true, reason: 'Finished.' }],
  }, 'Delegate the fixture task.')
  assert.equal(subagent.length, 2, `the subagent went back to work once\n${log}`)
  assert.equal(evaluator.length, 2)
  assert.ok(JSON.stringify(subagent[1].messages).includes('Finish the fixture task.'))
  assertAppendOnly(subagent[0], subagent[1])
  assert.equal(main.length, 2)
  assert.ok(JSON.stringify(toolResults(main[1])).includes('Sub second.'), 'the main thread gets the final subagent answer')
  assert.equal(output.result, 'Main done.')
})

test('PreToolUse: a block ends the turn by default, and impossible counts only on stop events', { timeout: 120_000 }, async () => {
  const { main, evaluator, log } = await run({ PreToolUse: onWrite('Allow only safe writes.') }, {
    main: [writeCall, 'Unexpected second turn.'],
    evaluator: [{ ok: false, impossible: true, reason: 'Writes are frozen.' }],
  }, 'Write the fixture file.')
  assert.equal(main.length, 1, `the block ends the turn\n${log}`)
  assert.equal(existsSync(target), false, 'the write was denied')
  const { schema } = evaluator[0].output_config.format
  assert.deepEqual(Object.keys(schema.properties), ['ok', 'reason'], 'other events keep the answer shape they had')
})

test('PreToolUse: continueOnBlock returns the reason to Claude as the tool error', { timeout: 120_000 }, async () => {
  const { output, main, log } = await run({ PreToolUse: onWrite('Allow only safe writes.', { continueOnBlock: true }) }, {
    main: [writeCall, 'Skipped the write.'],
    evaluator: [{ ok: false, reason: 'Writes are frozen.' }],
  }, 'Write the fixture file.')
  assert.equal(main.length, 2, `Claude gets the denial and goes on\n${log}`)
  assert.equal(existsSync(target), false, 'the write was still denied')
  const [result] = toolResults(main[1])
  assert.equal(result.is_error, true)
  assert.ok(JSON.stringify(result.content).includes('Writes are frozen.'))
  assertAppendOnly(main[0], main[1])
  assert.equal(output.result, 'Skipped the write.')
})

test('PostToolUse: a block ends the turn unless continueOnBlock feeds it back', { timeout: 120_000 }, async () => {
  for (const continueOnBlock of [false, true]) {
    const { main, log } = await run({ PostToolUse: onWrite('Check the write.', continueOnBlock ? { continueOnBlock } : {}) }, {
      main: [writeCall, 'Fixed after the check.'],
      evaluator: [{ ok: false, reason: 'The file needs a header.' }],
    }, 'Write the fixture file.')
    assert.equal(existsSync(target), true, 'the tool ran before the hook')
    assert.equal(main.length, continueOnBlock ? 2 : 1, `continueOnBlock: ${continueOnBlock}\n${log}`)
    if (continueOnBlock) {
      assert.ok(JSON.stringify(main[1].messages).includes('The file needs a header.'))
      assertAppendOnly(main[0], main[1])
    }
  }
})

test('UserPromptSubmit: the prompt stays blocked whatever continueOnBlock says', { timeout: 120_000 }, async () => {
  const { main, evaluator, log } = await run({ UserPromptSubmit: promptHook('Refuse fixture prompts.', { continueOnBlock: true }) }, {
    main: ['Unexpected answer.'], evaluator: [{ ok: false, reason: 'Prompt refused by the fixture.' }],
  }, 'Blocked fixture prompt.')
  assert.equal(evaluator.length, 1, log)
  assert.equal(main.length, 0, 'the model never gets the prompt')
})

// The evaluator answers in JSON and never runs a tool. A check made of the hook
// prompt alone sends no tool list; one that carries the conversation keeps the
// session's, because its history holds tool calls.
test('Checks of the hook prompt alone send no tools; a Stop check keeps the session tools', { timeout: 120_000 }, async () => {
  const { main, evaluator, log } = await run({
    UserPromptSubmit: promptHook('Allow fixture prompts.'),
    PreToolUse: onWrite('Allow every fixture write.'),
    PostToolUse: onWrite('Accept every fixture write.'),
    Stop: promptHook('The fixture file was written.'),
  }, {
    main: [writeCall, 'Wrote the fixture.'],
    evaluator: [{ ok: true, reason: 'Fine.' }],
  }, 'Write the fixture file.')
  assert.equal(main.length, 2, log)
  const check = prompt => {
    const found = evaluator.filter(body => textOf(body.messages.at(-1)).startsWith(prompt))
    assert.equal(found.length, 1, `one check for "${prompt}"\n${log}`)
    return found[0]
  }
  for (const prompt of ['Allow fixture prompts.', 'Allow every fixture write.', 'Accept every fixture write.']) {
    assert.deepEqual(check(prompt).tools ?? [], [], `the "${prompt}" check sends no tools`)
  }
  const stop = check('The fixture file was written.')
  assertUnchanged(stop.tools, main[1].tools, 'the Stop check tool list')
  assert.ok(stop.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use')),
    'the Stop check history keeps the tool call')
})

// Tool descriptions are cached for the process by whichever request builds them
// first. A check that ran before the first request used to build them, with no
// agents, and the conversation's Agent tool then listed no agent types.
test('A check before the first request leaves the tool descriptions as they are without hooks', { timeout: 180_000 }, async () => {
  const hooked = await run({ UserPromptSubmit: promptHook('Allow fixture prompts.') }, {
    main: ['Done.'], evaluator: [{ ok: true, reason: 'Fine.' }],
  }, 'Answer the fixture.')
  assert.equal(hooked.evaluator.length, 1, hooked.log)
  const plain = await run({}, { main: ['Done.'] }, 'Answer the fixture.')
  assert.equal(plain.main.length, 1, plain.log)
  assertUnchanged(hooked.main[0].tools, plain.main[0].tools, 'the tool list')
})

test('A Stop check that rebuilds a tool description uses the session agents; a prompt-only check builds none', { timeout: 120_000 }, async () => {
  const cwd = process.cwd()
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: join(root, 'engine-config'), ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, NO_PROXY: env.NO_PROXY, TAU_MCP_TEST_BUNDLE: bundle,
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
  })
  process.chdir(workspace)
  process.argv.push('--bare')
  try {
    const r = await loadMcpRuntime({ paths: ['src/utils/hooks/execPromptHook.ts', 'src/utils/toolSchemaCache.ts'],
      exports: ['execPromptHook', 'getToolSchemaCache', 'createUserMessage'] })
    // Like the Agent tool, its description names the agents it is given.
    const probe = fixtureTool({
      name: 'AgentListProbe',
      prompt: async options => `Agents: ${(options?.agents ?? []).map(agent => agent.agentType).join(', ')}`,
    })
    const context = fixtureContext([probe])
    Object.assign(context, {
      setResponseLength: () => {},
      options: { ...context.options, agentDefinitions: { activeAgents: [{ agentType: 'fixture-reviewer' }] } },
    })
    const probeSchema = () => [...r.getToolSchemaCache().values()].find(schema => schema.name === 'AgentListProbe')
    const judge = (event, messages) => r.execPromptHook({ type: 'prompt', prompt: 'The fixture is done.' }, event, event,
      JSON.stringify({ hook_event_name: event }), new AbortController().signal, context, messages)
    script = { evaluator: [{ ok: true, reason: 'Done.' }] }

    requests = []
    r.getToolSchemaCache().clear()
    assert.equal((await judge('PreToolUse')).outcome, 'success')
    assert.deepEqual(requests.map(request => request.body.tools ?? []), [[]], 'a prompt-only check sends no tools')
    assert.equal(probeSchema(), undefined, 'and builds no tool description')

    // A settings change or a token refresh can clear the cache mid-turn, so a
    // Stop check may be the first request to build a description.
    requests = []
    assert.equal((await judge('Stop', [r.createUserMessage({ content: 'Write the fixture file.' })])).outcome, 'success')
    assert.equal(requests.length, 1)
    assert.equal(probeSchema()?.description, 'Agents: fixture-reviewer', 'the description names the session agents')
  } finally {
    process.argv.pop()
    process.chdir(cwd)
  }
})
