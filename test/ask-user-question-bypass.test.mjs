import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import React from 'react'
import { KEYS, loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// Run against the shipped bundle (npm run build first), with isolated settings.
const repoDir = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tau-bypass-questions-'))
const projectDir = join(scratch, 'project')
mkdirSync(join(projectDir, '.git'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = join(scratch, 'config')
process.env.CLAUDE_CODE_TMPDIR = join(scratch, 'tmp')
process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
process.env.DISABLE_TELEMETRY = '1'
process.chdir(projectDir)

after(async () => {
  process.chdir(repoDir)
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 100 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
})

const r = await loadBuiltRuntime({
  paths: [
    'src/hooks/useCanUseTool.tsx',
    'src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx',
    'src/services/tools/toolExecution.ts',
    'src/utils/permissions/permissions.ts',
    'src/utils/settings/types.ts',
    'src/utils/api.ts',
    'src/constants/prompts.ts',
    'src/utils/model/providerRegistry.ts',
    'src/utils/forcedProvider.ts',
    'src/lanes/gemini/tools.ts',
    'src/lanes/cursor/tools.ts',
    'src/lanes/kilo/tool_args.ts',
  ],
  exports: [
    'AskUserQuestionTool', 'AskUserQuestionPermissionRequest', 'useCanUseTool',
    'hasPermissionsToUseTool', 'runToolUse', 'resolveHookPermissionDecision',
    'getEmptyToolPermissionContext', 'setSessionBypassPermissionsMode',
    'SettingsSchema', 'updateSettingsForSource', 'getInitialSettings',
    'toolToAPISchema', 'getSystemPrompt', 'API_PROVIDERS', 'runWithForcedProvider',
    'GEMINI_TOOL_REGISTRY', 'resolveCursorToolCall', 'normalizeKiloToolCallArguments',
  ],
})
const tool = r.AskUserQuestionTool
const input = { questions: [{
  question: 'Should the app support guest checkout?', header: 'Checkout',
  options: [
    { label: 'Yes', description: 'Let guests buy without an account.' },
    { label: 'No', description: 'Require an account before checkout.' },
  ],
}] }
const assistant = { type: 'assistant', uuid: 'fixture-assistant',
  message: { id: 'fixture-message', content: [] } }

function settings(value, extra = {}, source = 'userSettings') {
  assert.equal(r.updateSettingsForSource(source, {
    askQuestionsInBypassMode: value, ...extra,
  }).error, null)
}

function context(overrides = {}) {
  const state = r.getDefaultAppState()
  state.toolPermissionContext = {
    ...r.getEmptyToolPermissionContext(), mode: 'bypassPermissions', ...overrides,
  }
  return {
    abortController: new AbortController(), messages: [],
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [] }, mainLoopModel: 'fixture-model' },
    getAppState: () => state,
    setAppState: update => Object.assign(state, update(state)),
  }
}

const permission = (ctx = context(), candidate = tool, args = input) =>
  r.hasPermissionsToUseTool(candidate, args, ctx, assistant, 'question-1')

beforeEach(() => {
  r.setSessionBypassPermissionsMode(false)
  settings(undefined, { selfLearningEnabled: false, autoMemoryEnabled: true })
})

test('setting is an optional boolean, with no schema-injected default', () => {
  const schema = r.SettingsSchema()
  assert.equal(schema.parse({}).askQuestionsInBypassMode, undefined)
  for (const value of [true, false]) {
    assert.equal(schema.parse({ askQuestionsInBypassMode: value }).askQuestionsInBypassMode, value)
  }
  for (const value of ['true', 1, null]) {
    assert.equal(schema.safeParse({ askQuestionsInBypassMode: value }).success, false)
  }
})

test('unset and false auto-select answers; true takes effect without restarting', async () => {
  const ctx = context()
  for (const value of [undefined, false, true, false, true]) {
    settings(value)
    const result = await permission(ctx)
    assert.equal(result.behavior, value === true ? 'ask' : 'allow')
    if (result.behavior === 'allow') {
      const output = await tool.call(result.updatedInput, ctx)
      assert.deepEqual(output.data.answers, { [input.questions[0].question]: 'Yes' })
      assert.deepEqual(output.data.autoAnsweredQuestions, [input.questions[0].question])
    }
  }
})

test('CLI/session bypass and explicit bypass mode both honor the setting', async () => {
  settings(true)
  assert.equal((await permission()).behavior, 'ask')
  r.setSessionBypassPermissionsMode(true)
  assert.equal((await permission(context({ mode: 'default' }))).behavior, 'ask')
  settings(false)
  assert.equal((await permission(context({ mode: 'default' }))).behavior, 'allow')
})

test('effective settings respect source precedence and revert immediately after deletion', async () => {
  settings(true)
  try {
    settings(false, {}, 'projectSettings')
    assert.equal((await permission()).behavior, 'allow')
    settings(true, {}, 'localSettings')
    assert.equal((await permission()).behavior, 'ask')
    settings(undefined, {}, 'localSettings')
    assert.equal((await permission()).behavior, 'allow')
    settings(undefined, {}, 'projectSettings')
    assert.equal((await permission()).behavior, 'ask')
  } finally {
    settings(undefined, {}, 'localSettings')
    settings(undefined, {}, 'projectSettings')
  }
})

test('normal questions, self-learning, and plan approval keep their existing behavior', async () => {
  for (const value of [undefined, false, true]) {
    settings(value)
    assert.equal((await permission(context({ mode: 'default' }))).behavior, 'ask')
    r.setSessionBypassPermissionsMode(true)
    assert.equal((await permission(context({ mode: 'plan' }))).behavior, 'ask')
    const exitPlan = { ...tool, name: 'ExitPlanMode' }
    assert.equal((await permission(context(), exitPlan)).behavior, 'ask')
    r.setSessionBypassPermissionsMode(false)
  }
  settings(false, { selfLearningEnabled: true })
  assert.equal((await permission()).behavior, 'ask')
  settings(false, { autoMemoryEnabled: false })
  assert.equal((await permission()).behavior, 'allow')
  settings(true)
  assert.equal((await permission()).behavior, 'ask', 'new setting must not depend on auto-memory')
})

test('only questions opt out; ordinary tool approvals still bypass', async () => {
  settings(true)
  for (const name of ['Read', 'Write', 'Edit', 'Bash', 'PowerShell', 'OtherInteractiveTool']) {
    // Use the same ask decision to isolate permission routing, without running commands.
    const candidate = { ...tool, name, requiresUserInteraction: () => name === 'OtherInteractiveTool' }
    assert.equal((await permission(context(), candidate)).behavior, 'allow', name)
  }
})

test('deny rules still win, and allow rules cannot discard required answers', async () => {
  settings(true)
  assert.equal((await permission(context({ alwaysDenyRules: { userSettings: ['AskUserQuestion'] } }))).behavior, 'deny')
  assert.equal((await permission(context({ alwaysAllowRules: { userSettings: ['AskUserQuestion'] } }))).behavior, 'ask')
  const denied = { ...tool, checkPermissions: async () => ({ behavior: 'deny', message: 'Denied' }) }
  assert.equal((await permission(context(), denied)).behavior, 'deny')
})

test('headless/background sessions return a denial when no interaction is available', async () => {
  settings(true)
  const result = await permission(context({ shouldAvoidPermissionPrompts: true }))
  assert.equal(result.behavior, 'deny')
  assert.equal(result.decisionReason.type, 'asyncAgent')
})

test('hooks retain their answer-supplying path, but bare approval still requires interaction', async () => {
  settings(true)
  const ctx = context()
  const decide = hook => r.resolveHookPermissionDecision(hook, tool, input, ctx,
    r.hasPermissionsToUseTool, assistant, 'question-1')
  assert.equal((await decide({ behavior: 'allow' })).decision.behavior, 'ask')
  const answered = { ...input, answers: { [input.questions[0].question]: 'No' } }
  const result = await decide({ behavior: 'allow', updatedInput: answered })
  assert.equal(result.decision.behavior, 'allow')
  assert.deepEqual(result.input.answers, answered.answers)
})

test('every registered provider honors the shared decision and auto-answers when the tool is available', async t => {
  for (const provider of r.API_PROVIDERS) {
    await t.test(provider, () => r.runWithForcedProvider({ provider }, async () => {
      // NIM's default fast-tool subset excludes AskUserQuestion entirely.
      const previousFullTools = process.env.NIM_FULL_TOOLS
      if (provider === 'nim') process.env.NIM_FULL_TOOLS = '1'
      try {
        settings(true)
        assert.equal((await permission()).behavior, 'ask')
        settings(false)
        assert.equal((await permission()).behavior, 'allow')
        const { results } = await executeQuestion(input)
        assert.equal(results.length, 1)
        assert.notEqual(results[0].is_error, true)
        assert.match(results[0].content, /"Should the app support guest checkout\?"="Yes" \(automatically selected\)/)
        assert.doesNotMatch(results[0].content, /User has answered/)
      } finally {
        if (previousFullTools === undefined) delete process.env.NIM_FULL_TOOLS
        else process.env.NIM_FULL_TOOLS = previousFullTools
      }
    }))
  }
})

test('automatic answers do not bypass NIM fast-tool restrictions', async () => {
  const flags = ['NIM_FULL_TOOLS', 'CLAUDEX_NIM_FULL_TOOLS', 'NIM_NO_OPTIMIZE', 'CLAUDEX_NIM_NO_OPTIMIZE']
  const previous = flags.map(flag => process.env[flag])
  for (const flag of flags) delete process.env[flag]
  try {
    await r.runWithForcedProvider({ provider: 'nim' }, async () => {
      const { results } = await executeQuestion(input)
      assert.equal(results.length, 1)
      assert.equal(results[0].is_error, true)
      assert.match(results[0].content, /NIM fast-tool/)
      assert.doesNotMatch(results[0].content, /automatically selected/)
    })
  } finally {
    flags.forEach((flag, index) => {
      if (previous[index] === undefined) delete process.env[flag]
      else process.env[flag] = previous[index]
    })
  }
})

test('Gemini, Cursor, and Kilo native question formats reach the same override', async () => {
  settings(true)
  const gemini = r.GEMINI_TOOL_REGISTRY.find(entry => entry.nativeName === 'ask_user')
  const cursor = r.resolveCursorToolCall('ask_question', { prompt: 'Pick an approach?', options: ['Simple', 'Advanced'] })
  assert.equal(gemini.implId, tool.name)
  assert.equal(cursor.implId, tool.name)
  const inputs = [
    gemini.adaptInput({ question: 'Pick an approach?' }), cursor.input,
    r.normalizeKiloToolCallArguments(tool.name, { questions: JSON.stringify(input.questions) }),
  ]
  for (const args of inputs) {
    assert.equal(tool.inputSchema.safeParse(args).success, true)
    assert.equal((await permission(context(), tool, args)).behavior, 'ask')
    settings(false)
    const { results } = await executeQuestion(args)
    assert.equal(results.length, 1)
    assert.notEqual(results[0].is_error, true)
    assert.match(results[0].content, /automatically selected/)
    settings(true)
  }
})

test('toggling preserves model-visible system prompt and tool schema bytes', async () => {
  const tools = [tool]
  const options = { tools, agents: [], model: 'fixture-model',
    getToolPermissionContext: async () => context().getAppState().toolPermissionContext }
  for (const provider of r.API_PROVIDERS) {
    await r.runWithForcedProvider({ provider }, async () => {
      settings(false)
      const before = JSON.stringify({
        system: await r.getSystemPrompt(tools, options.model),
        schema: await r.toolToAPISchema(tool, options),
        prompt: await tool.prompt(), enabled: tool.isEnabled(),
      })
      await executeQuestion(input)
      settings(true)
      assert.equal(JSON.stringify({
        system: await r.getSystemPrompt(tools, options.model),
        schema: await r.toolToAPISchema(tool, options),
        prompt: await tool.prompt(), enabled: tool.isEnabled(),
      }), before, provider)
    })
  }
})

async function executeQuestion(args, ctx = context()) {
  const block = { type: 'tool_use', name: tool.name, id: 'question-1', input: args }
  const updates = []
  for await (const update of r.runToolUse(block,
    { ...assistant, message: { ...assistant.message, content: [block] } },
    r.hasPermissionsToUseTool, ctx)) updates.push(update)
  const messages = updates.map(update => update.message).filter(message => message?.type === 'user')
  return { messages, results: messages.flatMap(message => message.message.content)
    .filter(block => block.type === 'tool_result') }
}

function question(questionText, labels, multiSelect = false) {
  return { question: questionText, header: 'Choice', multiSelect,
    options: labels.map(label => ({ label, description: `Choose ${label}.` })) }
}

test('selection uses the marked recommendation, with deterministic first-option fallback', async () => {
  const questions = [
    question('Recommendation is second?', ['First', 'Second (Recommended)']),
    question('No recommendation?', ['Default', 'Alternative']),
    question('Case and spacing?', ['First', 'Second ( recommended ) ']),
    question('Misleading label?', ['First', 'Second (Not recommended)']),
  ]
  const output = await tool.call({ questions }, context())
  assert.deepEqual(output.data.answers, {
    'Recommendation is second?': 'Second (Recommended)',
    'No recommendation?': 'Default',
    'Case and spacing?': 'Second ( recommended ) ',
    'Misleading label?': 'First',
  })
  assert.deepEqual(output.data.autoAnsweredQuestions, questions.map(q => q.question))
  assert.deepEqual(tool.outputSchema.parse(output.data), output.data)
})

test('multi-select chooses all recommendations; single-select and unmarked questions choose one', async () => {
  const labels = ['First', 'Second (Recommended)', 'Third (Recommended)']
  const questions = [
    question('Multiple?', labels, true), question('Single?', labels),
    question('Unmarked multi?', ['Default', 'Alternative'], true),
  ]
  const { data } = await tool.call({ questions }, context())
  assert.deepEqual(data.answers, {
    'Multiple?': 'Second (Recommended), Third (Recommended)',
    'Single?': 'Second (Recommended)', 'Unmarked multi?': 'Default',
  })
})

test('supplied answers and annotations survive; only missing answers are filled without mutating input', async () => {
  const questions = [
    question('Answered?', ['Default', 'Alternative']),
    question('Explicitly empty?', ['Default', 'Alternative']),
    question('Needs answer?', ['Default', 'Alternative (Recommended)']),
  ]
  questions[2].options[1].preview = 'Selected preview'
  const supplied = {
    questions,
    answers: { 'Answered?': 'My own answer', 'Explicitly empty?': '' },
    annotations: { 'Answered?': { notes: 'User note', preview: 'Existing preview' } },
  }
  const before = JSON.stringify(supplied)
  Object.freeze(supplied.answers)
  Object.freeze(supplied.annotations)
  const { data } = await tool.call(supplied, context())
  assert.deepEqual(data.answers, { ...supplied.answers, 'Needs answer?': 'Alternative (Recommended)' })
  assert.deepEqual(data.autoAnsweredQuestions, ['Needs answer?'])
  assert.deepEqual(data.annotations, { ...supplied.annotations, 'Needs answer?': { preview: 'Selected preview' } })
  assert.equal(JSON.stringify(supplied), before)
  const result = tool.mapToolResultToToolResultBlockParam(data, 'question-1')
  assert.match(result.content, /"Answered\?"="My own answer" \(provided answer\)/)
  assert.match(result.content, /"Needs answer\?"="Alternative \(Recommended\)" \(automatically selected\)/)
  assert.match(result.content, /selected preview:\nSelected preview/)
  assert.match(result.content, /user notes: User note/)
  assert.doesNotMatch(result.content, /User has answered/)
})

test('fully supplied answers keep the existing result and transcript wording', async () => {
  const supplied = { ...input, answers: { [input.questions[0].question]: 'No' } }
  const { data } = await tool.call(supplied, context())
  assert.deepEqual(data, supplied)
  const result = tool.mapToolResultToToolResultBlockParam(data, 'question-1')
  assert.match(result.content, /^User has answered your questions:/)
  const panel = await mount(r, tool.renderToolResultMessage(data))
  try {
    assert.match(panel.frame(), /User answered Tau's questions:/)
    assert.doesNotMatch(panel.frame(), /automatically selected/)
  } finally { panel.close() }
})

test('automatic-answer provenance survives serialization and is visible in the transcript', async () => {
  const { messages } = await executeQuestion(input)
  const data = JSON.parse(JSON.stringify(messages[0].toolUseResult))
  assert.deepEqual(data.autoAnsweredQuestions, [input.questions[0].question])
  const result = tool.mapToolResultToToolResultBlockParam(data, 'question-1')
  assert.match(result.content, /Treat automatic selections as assumptions/)
  const panel = await mount(r, tool.renderToolResultMessage(data), { columns: 120 })
  try {
    assert.match(panel.frame(), /Question answers \(bypass mode\):/)
    assert.match(panel.frame(), /Yes \(automatically selected\)/)
    assert.doesNotMatch(panel.frame(), /User answered/)
  } finally { panel.close() }
})

test('the execution fallback respects normal mode, plan mode, the question toggle, and self-learning', async () => {
  const unanswered = async ctx => {
    const { data } = await tool.call(input, ctx)
    assert.deepEqual(data.answers, {})
    assert.equal(data.autoAnsweredQuestions, undefined)
  }
  await unanswered(context({ mode: 'default' }))
  r.setSessionBypassPermissionsMode(true)
  await unanswered(context({ mode: 'plan' }))
  const { data } = await tool.call(input, context({ mode: 'default' }))
  assert.deepEqual(data.answers, { [input.questions[0].question]: 'Yes' })
  settings(true)
  await unanswered(context())
  settings(false, { selfLearningEnabled: true })
  await unanswered(context())
})

test('headless DSP can auto-answer; explicit question denial still prevents execution', async () => {
  const { results } = await executeQuestion(input, context({ shouldAvoidPermissionPrompts: true }))
  assert.match(results[0].content, /automatically selected/)
  const denied = await executeQuestion(input, context({ alwaysDenyRules: { userSettings: [tool.name] } }))
  assert.equal(denied.results[0].is_error, true)
  assert.doesNotMatch(denied.results[0].content, /automatically selected/)
})

test('question text that matches object properties still receives an own answer', async () => {
  const questions = ['toString', '__proto__'].map(text => question(text, ['First', 'Second']))
  const { data } = await tool.call({ questions }, context())
  for (const q of questions) {
    assert.equal(Object.hasOwn(data.answers, q.question), true)
    assert.equal(data.answers[q.question], 'First')
  }
  assert.deepEqual(data.autoAnsweredQuestions, ['toString', '__proto__'])
})

test('real executor pauses at the question dialog and returns the selected answer', async () => {
  settings(true, { syntaxHighlightingDisabled: true })
  const ctx = context()
  let canUseTool
  let pendingQuestion
  function Harness() {
    const [queue, setQueue] = React.useState([])
    pendingQuestion = queue[0]
    canUseTool = r.useCanUseTool(setQueue, next => { ctx.getAppState().toolPermissionContext = next })
    return queue[0] ? React.createElement(r.AskUserQuestionPermissionRequest, {
      toolUseConfirm: queue[0], toolUseContext: ctx,
      onDone: () => setQueue([]), onReject: () => {},
    }) : null
  }
  const panel = await mount(r, React.createElement(Harness), { columns: 100, rows: 40 })
  let completed = false
  const block = { type: 'tool_use', name: tool.name, id: 'question-1', input }
  const execution = (async () => {
    const updates = []
    for await (const update of r.runToolUse(block,
      { ...assistant, message: { ...assistant.message, content: [block] } }, canUseTool, ctx)) updates.push(update)
    completed = true
    return updates
  })()
  try {
    await panel.waitFor(/Should the app support guest checkout/)
    assert.equal(completed, false, 'execution must wait for an actual answer')
    await pendingQuestion.recheckPermission()
    assert.equal(completed, false, 'a bypass-mode recheck must not auto-approve the question')
    await panel.press(KEYS.down)
    await panel.press(KEYS.enter)
    const updates = await execution
    const results = updates.flatMap(update => update.message?.type === 'user'
      ? update.message.message.content : []).filter(block => block.type === 'tool_result')
    assert.equal(results.length, 1)
    assert.notEqual(results[0].is_error, true)
    assert.match(results[0].content, /"Should the app support guest checkout\?"="No"/)
  } finally {
    ctx.abortController.abort()
    panel.close()
  }
})
