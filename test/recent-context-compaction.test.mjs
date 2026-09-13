import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { transformSync } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Run the production modules, replacing I/O at their import boundary. No
// provider requests, hooks, user configuration, or session files are touched.
function load(relativePath, dependencies) {
  const code = transformSync(
    readFileSync(resolve(root, relativePath), 'utf8'),
    {
      loader: 'ts',
      format: 'cjs',
      target: 'node20',
    },
  ).code
  const module = { exports: {} }
  runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: () => dependencies,
      process: { env: {} },
      clearInterval,
      setInterval,
    },
    { filename: relativePath },
  )
  return module.exports
}

const user = (uuid, content) => ({
  type: 'user',
  uuid,
  message: { role: 'user', content },
})
const assistant = (uuid, content, input = 1000) => ({
  type: 'assistant',
  uuid,
  message: {
    id: uuid,
    role: 'assistant',
    model: 'any-model',
    content,
    usage: { input_tokens: input, output_tokens: 50 },
    stop_reason: 'end_turn',
  },
})
const text = value => ({ type: 'text', text: value })

function setup({
  enabled = true,
  summary = 'Earlier decisions and latest work.',
  overhead = 0,
  hooks = [],
  threshold = 20000,
  fail = false,
} = {}) {
  let nextId = 0
  const events = { requests: [], pre: [], post: [], session: [], deltas: [] }
  const noop = () => {}
  const deps = {
    feature: () => false,
    markPostCompaction: noop,
    logEvent: noop,
    logError: noop,
    logForDebugging: noop,
    logPermissionContextForAnts: noop,
    getInvokedSkillsForAgent: () => new Map(),
    getFeatureValue_CACHED_MAY_BE_STALE: (_key, fallback) => fallback,
    setCompactProgress: noop,
    reAppendSessionMetadata: noop,
    getPlan: () => null,
    getPlanFilePath: () => 'plan',
    isSessionActivityTrackingActive: () => false,
    getTranscriptPath: () => 'session-transcript',
    getMaxOutputTokensForModel: () => 20000,
    COMPACT_MAX_OUTPUT_TOKENS: 20000,
    createUserMessage: ({ content, ...options }) => ({
      ...user(`new-${nextId++}`, content),
      ...options,
    }),
    createCompactBoundaryMessage: (trigger, preTokens, uuid) => ({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: `new-${nextId++}`,
      compactMetadata: { trigger, preTokens },
      logicalParentUuid: uuid,
    }),
    createAttachmentMessage: attachment => ({
      type: 'attachment',
      uuid: `new-${nextId++}`,
      attachment,
    }),
    getAssistantMessageText: message =>
      message.message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join(''),
    getLastAssistantMessage: messages =>
      messages.findLast(m => m.type === 'assistant'),
    isCompactBoundaryMessage: m =>
      m.type === 'system' && m.subtype === 'compact_boundary',
    normalizeAttachmentForAPI: att => [user('attachment', att.content ?? '')],
    getMessagesAfterCompactBoundary: messages => messages,
    normalizeMessagesForAPI: messages => messages,
    extractDiscoveredToolNames: () => new Set(['Read']),
    isToolSearchEnabled: () => false,
    isToolReferenceBlock: () => false,
    jsonStringify: JSON.stringify,
    cacheToObject: cache => Object.fromEntries(cache),
    cleanMessagesForLogging: messages =>
      messages.filter(m => !['attachment', 'progress'].includes(m.type)),
    isChainParticipant: m => m.type !== 'progress',
    executePreCompactHooks: async value => {
      events.pre.push(value)
      return {}
    },
    executePostCompactHooks: async value => {
      events.post.push(value)
      return {}
    },
    processSessionStartHooks: async trigger => {
      events.session.push(trigger)
      return hooks
    },
    getDeferredToolsDeltaAttachment: (_tools, _model, messages) => {
      events.deltas.push(messages)
      return []
    },
    getAgentListingDeltaAttachment: () => [],
    getMcpInstructionsDeltaAttachment: () => [],
    runForkedAgent: async options => {
      events.requests.push(options)
      const response = assistant('summary', [
        text(fail ? 'API Error: interrupted' : summary),
      ])
      return { messages: [response], totalUsage: response.message.usage }
    },
    startsWithApiErrorPrefix: value => value.startsWith('API Error:'),
    PROMPT_TOO_LONG_ERROR_MESSAGE: 'Prompt is too long',
    tokenCountFromLastAPIResponse: () => 1050,
    getTokenUsage: m => m.message.usage,
    SYNTHETIC_MESSAGES: new Set(),
    SYNTHETIC_MODEL: '<synthetic>',
    getConfiguredThresholdPercent: () => undefined,
    getConfiguredWindowCap: () => undefined,
    isRecentContextPreservationEnabled: () => enabled,
    getGlobalConfig: () => ({ autoCompactEnabled: true }),
    getContextWindowForModel: () => threshold + 33000,
    getSdkBetas: () => [],
    isEnvTruthy: () => false,
    hasExactErrorMessage: (err, value) => err.message === value,
    trySessionMemoryCompaction: async () => null,
    setLastSummarizedMessageId: noop,
    runPostCompactCleanup: noop,
  }
  Object.assign(deps, load('src/services/tokenEstimation.ts', deps))
  deps.tokenCountWithEstimation = messages =>
    deps.roughTokenCountEstimationForMessages(messages) + overhead
  Object.assign(deps, load('src/services/compact/prompt.ts', deps))
  Object.assign(deps, load('src/services/compact/grouping.ts', deps))
  Object.assign(deps, load('src/services/compact/recentContext.ts', deps))
  Object.assign(deps, load('src/utils/compactionSettings.ts', deps))
  const compact = load('src/services/compact/compact.ts', deps)
  Object.assign(deps, compact)
  const auto = load('src/services/compact/autoCompact.ts', deps)
  const context = {
    options: {
      mainLoopModel: 'any-model',
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
    },
    readFileState: new Map(),
    loadedNestedMemoryPaths: new Set(['memory']),
    getAppState: () => ({
      toolPermissionContext: { mode: 'default' },
      tasks: {},
    }),
    abortController: new AbortController(),
  }
  const messages = [
    user('old-user', 'Old project history '.repeat(5000)),
    assistant('old-assistant', [text('Old decisions')]),
    user('recent-user', 'Fix EXACT_ERROR_42, keep the public API unchanged.'),
    assistant('tool-call', [
      {
        type: 'thinking',
        thinking: 'Inspect the failure.',
        signature: 'original-signature',
      },
      {
        type: 'tool_use',
        id: 'read-1',
        name: 'Read',
        input: { file_path: 'src/example.ts' },
      },
    ]),
    user('tool-result', [
      {
        type: 'tool_result',
        tool_use_id: 'read-1',
        content: 'EXACT_ERROR_42 at example.ts:17',
      },
    ]),
  ]
  const params = {
    systemPrompt: ['stable system'],
    userContext: { rules: 'stable' },
    systemContext: { environment: 'stable' },
    toolUseContext: context,
    forkContextMessages: messages,
  }
  const info = {
    autoCompactThreshold: threshold,
    querySource: 'repl_main_thread',
    isRecompactionInChain: false,
    turnsSincePreviousCompact: 0,
  }
  const run = (isAuto = true, preserve = enabled) =>
    compact.compactConversation(
      messages,
      context,
      params,
      true,
      undefined,
      isAuto,
      info,
      preserve,
    )
  return { compact, auto, context, messages, params, info, run, events, deps }
}

test('keeps exact recent tool exchanges and the existing cache-sharing summary request', async () => {
  const s = setup()
  const before = JSON.stringify(s.messages)
  const result = await s.run()
  assert.ok(result.messagesToKeep.some(m => m.uuid === 'recent-user'))
  for (const kept of result.messagesToKeep)
    assert.equal(
      kept,
      s.messages.find(m => m.uuid === kept.uuid),
    )
  assert.equal(JSON.stringify(s.messages), before)
  assert.equal(s.events.requests.length, 1)
  const request = s.events.requests[0]
  assert.equal(request.cacheSafeParams, s.params)
  assert.equal(request.cacheSafeParams.forkContextMessages, s.messages)
  assert.equal(request.skipCacheWrite, true)
  assert.equal(request.maxTurns, 1)
  assert.equal(request.maxOutputTokens, undefined)
  assert.equal(request.overrides.abortController, s.context.abortController)
  assert.match(result.summaryMessages[0].message.content, /preserved verbatim/)
  const segment = result.boundaryMarker.compactMetadata.preservedSegment
  assert.equal(segment.headUuid, result.messagesToKeep[0].uuid)
  assert.equal(segment.tailUuid, 'tool-result')
  assert.equal(segment.anchorUuid, result.summaryMessages[0].uuid)
  assert.deepEqual(Array.from(segment.messageUuids), Array.from(result.messagesToKeep, m => m.uuid))
  const rebuilt = s.compact.buildPostCompactMessages(result)
  assert.equal(rebuilt[2], result.messagesToKeep[0])
  assert.equal(
    result.truePostCompactTokenCount,
    s.deps.roughTokenCountEstimationForMessages(rebuilt),
  )
  assert.equal(s.events.pre[0].trigger, 'auto')
  assert.equal(s.events.post[0].trigger, 'auto')
  assert.deepEqual(s.events.session, ['compact'])
})

test('off and manual compact keep the full-summary shape and identical summary prompt', async () => {
  for (const [auto, preserve] of [
    [true, false],
    [false, true],
  ]) {
    const s = setup()
    const result = await s.run(auto, preserve)
    assert.equal(result.messagesToKeep, undefined)
    assert.equal(
      result.boundaryMarker.compactMetadata.preservedSegment,
      undefined,
    )
    assert.doesNotMatch(
      result.summaryMessages[0].message.content,
      /preserved verbatim/,
    )
    assert.equal(s.events.pre[0].trigger, auto ? 'auto' : 'manual')
    assert.equal(s.events.post[0].trigger, auto ? 'auto' : 'manual')
    const enabled = setup()
    await enabled.run()
    assert.equal(
      s.events.requests[0].promptMessages[0].message.content,
      enabled.events.requests[0].promptMessages[0].message.content,
    )
  }
})

test('large prompt overhead, hook output, or a tiny window omit retention without a second summary', async () => {
  const largeHook = {
    type: 'attachment',
    uuid: 'hook',
    attachment: { content: 'h'.repeat(100000) },
  }
  for (const options of [
    { overhead: 16000 },
    { hooks: [largeHook] },
    { threshold: 50 },
  ]) {
    const s = setup(options)
    const result = await s.run()
    assert.equal(result.messagesToKeep, undefined)
    assert.equal(s.events.requests.length, 1)
    assert.match(
      result.summaryMessages[0].message.content,
      /Earlier decisions and latest work/,
    )
  }
})

test('transient trailing attachments never become transcript splice endpoints', async () => {
  const s = setup()
  const transient = {
    type: 'attachment',
    uuid: 'not-on-disk',
    attachment: { content: 'current reminder' },
  }
  s.messages.push(transient)
  const result = await s.run()
  assert.equal(result.messagesToKeep.at(-1), transient)
  assert.equal(
    result.boundaryMarker.compactMetadata.preservedSegment.tailUuid,
    'tool-result',
  )
  assert.ok(!result.boundaryMarker.compactMetadata.preservedSegment.messageUuids.includes(transient.uuid))
})

test('failed summary leaves conversation and read state intact', async () => {
  const s = setup({ fail: true })
  const snapshot = { content: 'original file', timestamp: 123 }
  s.context.readFileState.set('src/example.ts', snapshot)
  const before = JSON.stringify(s.messages)
  await assert.rejects(s.run(), /API Error: interrupted/)
  assert.equal(JSON.stringify(s.messages), before)
  assert.equal(s.context.readFileState.get('src/example.ts'), snapshot)
  assert.equal(s.context.loadedNestedMemoryPaths.size, 1)
  assert.equal(s.events.post.length, 0)
})

test('conversation records changed or omitted by transcript logging decline retention', async () => {
  for (const transform of ['omit', 'change']) {
    const s = setup()
    s.deps.cleanMessagesForLogging = messages =>
      transform === 'omit'
        ? messages.filter(m => m.uuid !== 'tool-call')
        : messages.map(m =>
            m.uuid === 'tool-result'
              ? {
                  ...m,
                  message: { ...m.message, content: 'transformed result' },
                }
              : m,
          )
    const result = await s.run()
    assert.equal(result.messagesToKeep, undefined)
    assert.equal(
      result.boundaryMarker.compactMetadata.preservedSegment,
      undefined,
    )
    assert.doesNotMatch(
      result.summaryMessages[0].message.content,
      /preserved verbatim/,
    )
    assert.equal(s.events.requests.length, 1)
  }
})

test('optional retention failure still returns the successful full summary', async () => {
  const s = setup()
  s.deps.prepareRecentContext = () => {
    throw new Error('unavailable estimate')
  }
  const result = await s.run()
  assert.equal(result.messagesToKeep, undefined)
  assert.equal(
    result.boundaryMarker.compactMetadata.preservedSegment,
    undefined,
  )
  assert.match(
    result.summaryMessages[0].message.content,
    /Earlier decisions and latest work/,
  )
  assert.equal(s.events.requests.length, 1)
  assert.equal(s.events.post.length, 1)
})

test('repeated compaction only retains a fresh suffix beyond the previous saved segment', async () => {
  const s = setup()
  const first = await s.run()
  const fresh = [
    user('fresh-request', 'Now fix EXACT_ERROR_43'),
    assistant('fresh-call', [
      {
        type: 'tool_use',
        id: 'shell-1',
        name: 'Bash',
        input: { command: 'test' },
      },
    ]),
    user('fresh-result', [
      {
        type: 'tool_result',
        tool_use_id: 'shell-1',
        content: 'EXACT_ERROR_43',
      },
    ]),
  ]
  const active = [...s.compact.buildPostCompactMessages(first), ...fresh]
  const result = await s.compact.compactConversation(
    active,
    s.context,
    { ...s.params, forkContextMessages: active },
    true,
    undefined,
    true,
    s.info,
    true,
  )
  assert.equal(result.messagesToKeep.length, fresh.length)
  result.messagesToKeep.forEach((message, index) =>
    assert.equal(message, fresh[index]),
  )
  assert.equal(
    result.boundaryMarker.compactMetadata.preservedSegment.headUuid,
    'fresh-request',
  )
  assert.equal(
    result.boundaryMarker.compactMetadata.preservedSegment.tailUuid,
    'fresh-result',
  )
  assert.equal(s.events.requests.length, 2)
})

test('automatic opt-in reaches the engine only for main conversations', async () => {
  for (const source of [
    'repl_main_thread',
    'repl_main_thread:resume',
    'sdk',
    'agent:custom',
    'agent:builtin:fork',
    'compact',
    undefined,
  ]) {
    const s = setup()
    const result = await s.auto.autoCompactIfNeeded(
      s.messages,
      s.context,
      s.params,
      source,
    )
    const main = source?.startsWith('repl_main_thread') || source === 'sdk'
    if (source === 'compact') assert.equal(result.wasCompacted, false)
    else {
      assert.equal(result.wasCompacted, true)
      assert.equal(
        Boolean(result.compactionResult.messagesToKeep),
        Boolean(main),
        String(source),
      )
    }
  }
})
