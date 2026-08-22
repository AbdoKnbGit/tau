import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const envKeys = [
  'NODE_ENV',
  'USER_TYPE',
  'CLAUDE_INTERNAL_FC_OVERRIDES',
  'TAU_TOOL_PERSIST_THRESHOLD_CHARS',
  'CLAUDE_CODE_TOOL_PERSIST_THRESHOLD_CHARS',
  'TAU_TOOL_RESULTS_BUDGET_CHARS',
  'CLAUDE_CODE_TOOL_RESULTS_BUDGET_CHARS',
  'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
  'TEST_ENABLE_SESSION_PERSISTENCE',
  'ENABLE_SESSION_PERSISTENCE',
]
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]))
process.env.NODE_ENV = 'test'
process.env.USER_TYPE = 'ant'
process.env.CLAUDE_INTERNAL_FC_OVERRIDES = JSON.stringify({
  tengu_satin_quoll: {},
  tengu_hawthorn_window: null,
  tengu_hawthorn_steeple: false,
  tengu_amber_wren: {},
})

const distPath = resolve('dist/tau.mjs')
const auditPath = join(
  dirname(distPath),
  `.tool-result-budget-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __toolResultBudgetAudit() {
  init_growthbook(); init_powerMode(); init_toolResultStorage(); init_limits(); init_conversationRecovery(); init_QueryEngine();
  return {
    QueryEngine,
    getContentReplacementCCRWrite,
    dedupeContentReplacementRecords,
    resetGrowthBook, setSessionPowerMode,
    getPersistenceThreshold, getPerMessageBudgetLimit,
    getToolOutputRetrieveLimits, provisionContentReplacementState,
    provisionCheapContentReplacementStateForQuery,
    createContentReplacementState, enforceToolResultBudget,
    applyToolResultBudget,
    createEmptyContentReplacementStateLike,
    getContentReplacementStateBinding,
    reconstructContentReplacementState, reconstructForSubagentResume,
    extractTeleportResumeData,
    resetProjectForTesting, setSessionFileForTesting,
    setInternalEventWriter, createContentReplacementRecorder, flushSessionStorage,
    recordInheritedContentReplacementsForFork,
    allowsFreshContentReplacements, setRemoteIngressUrlForTesting,
    switchSession,
    getToolResultPath,
    persistToolResult, buildLargeToolResultMessage,
    retrievePersistedToolResult, processPreMappedToolResultBlock,
    getDefaultFileReadingLimits,
    DEFAULT_MAX_RESULT_SIZE_CHARS,
    CHEAP_MODE_MAX_RESULT_SIZE_CHARS,
    MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
    CHEAP_MODE_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
    CHEAP_MODE_TOOL_OUTPUT_RETRIEVE_BYTES,
    DEFAULT_MAX_OUTPUT_TOKENS, CHEAP_MODE_MAX_OUTPUT_TOKENS,
  };
}
`
writeFileSync(auditPath, source)

let audit
try {
  const module = await import(pathToFileURL(auditPath).href)
  audit = module.__toolResultBudgetAudit()
} finally {
  unlinkSync(auditPath)
}

function resetPolicyEnvironment() {
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_INTERNAL_FC_OVERRIDES = JSON.stringify({
    tengu_satin_quoll: {},
    tengu_hawthorn_window: null,
    tengu_hawthorn_steeple: false,
    tengu_amber_wren: {},
  })
  delete process.env.TAU_TOOL_PERSIST_THRESHOLD_CHARS
  delete process.env.CLAUDE_CODE_TOOL_PERSIST_THRESHOLD_CHARS
  delete process.env.TAU_TOOL_RESULTS_BUDGET_CHARS
  delete process.env.CLAUDE_CODE_TOOL_RESULTS_BUDGET_CHARS
  delete process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  delete process.env.ENABLE_SESSION_PERSISTENCE
  audit.resetGrowthBook()
  audit.getDefaultFileReadingLimits.cache.clear()
}

function userToolResults(entries) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: entries.map(entry => ({
        type: 'tool_result',
        tool_use_id: entry.id,
        content: entry.content,
      })),
    },
  }
}

function assistantBoundary(id) {
  return {
    type: 'assistant',
    message: { id, role: 'assistant', content: [] },
  }
}

function visibleToolResultChars(messages) {
  let total = 0
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (block.type !== 'tool_result' || !block.content) continue
      total +=
        typeof block.content === 'string'
          ? block.content.length
          : block.content.reduce(
              (sum, item) => sum + (item.type === 'text' ? item.text.length : 0),
              0,
            )
    }
  }
  return total
}

async function removeIfCreated(path) {
  try {
    await unlink(path)
  } catch {
    // Best-effort cleanup; preserve the primary assertion failure.
  }
}

test('cheap policy changes cheap mode only and env overrides win', () => {
  resetPolicyEnvironment()

  audit.setSessionPowerMode('normal')
  assert.equal(
    audit.getPersistenceThreshold('Bash', 100_000),
    audit.DEFAULT_MAX_RESULT_SIZE_CHARS,
  )
  assert.equal(
    audit.getPerMessageBudgetLimit(),
    audit.MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  )
  assert.equal(audit.getToolOutputRetrieveLimits().defaultBytes, 20_000)
  assert.equal(audit.provisionContentReplacementState(), undefined)

  audit.setSessionPowerMode('cheap')
  assert.equal(
    audit.getPersistenceThreshold('Bash', 100_000),
    audit.CHEAP_MODE_MAX_RESULT_SIZE_CHARS,
  )
  assert.equal(
    audit.getPerMessageBudgetLimit(),
    audit.CHEAP_MODE_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  )
  assert.equal(
    audit.getToolOutputRetrieveLimits().maxBytes,
    audit.CHEAP_MODE_TOOL_OUTPUT_RETRIEVE_BYTES,
  )
  assert.ok(audit.provisionContentReplacementState())

  process.env.TAU_TOOL_PERSIST_THRESHOLD_CHARS = '17000'
  process.env.TAU_TOOL_RESULTS_BUDGET_CHARS = '31000'
  process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS = '21000'
  audit.getDefaultFileReadingLimits.cache.clear()
  assert.equal(audit.getPersistenceThreshold('Bash', 100_000), 17_000)
  assert.equal(audit.getPerMessageBudgetLimit(), 31_000)
  assert.equal(audit.getDefaultFileReadingLimits().maxTokens, 21_000)

  delete process.env.TAU_TOOL_PERSIST_THRESHOLD_CHARS
  delete process.env.TAU_TOOL_RESULTS_BUDGET_CHARS
  delete process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS
  audit.setSessionPowerMode('full')
  assert.equal(
    audit.getPersistenceThreshold('Bash', 100_000),
    audit.DEFAULT_MAX_RESULT_SIZE_CHARS,
  )
  assert.equal(
    audit.getPerMessageBudgetLimit(),
    audit.MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  )
})

test('Read limit cache is mode-keyed and normal default is unchanged', () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('normal')
  const normal = audit.getDefaultFileReadingLimits()
  assert.equal(normal.maxTokens, audit.DEFAULT_MAX_OUTPUT_TOKENS)

  audit.setSessionPowerMode('cheap')
  assert.equal(
    audit.getDefaultFileReadingLimits().maxTokens,
    audit.CHEAP_MODE_MAX_OUTPUT_TOKENS,
  )

  audit.setSessionPowerMode('normal')
  assert.equal(audit.getDefaultFileReadingLimits(), normal)
})

test('normal-to-cheap lazy provisioning freezes historical bytes', async () => {
  resetPolicyEnvironment()
  const id = `old-${randomUUID()}`
  const messages = [userToolResults([{ id, content: 'x'.repeat(30_000) }])]

  audit.setSessionPowerMode('normal')
  assert.equal(
    audit.provisionCheapContentReplacementStateForQuery(messages),
    undefined,
  )

  audit.setSessionPowerMode('cheap')
  const state = audit.provisionCheapContentReplacementStateForQuery(messages)
  assert.ok(state)
  assert.ok(state.seenIds.has(id))
  const result = await audit.enforceToolResultBudget(messages, state)
  assert.equal(result.messages, messages)
  assert.equal(result.newlyReplaced.length, 0)
})

test('swarm initialization and compaction reset preserve non-cheap policy', () => {
  resetPolicyEnvironment()
  const reconstructedNormal = audit.createContentReplacementState(false)
  reconstructedNormal.seenIds.add('historical-id')
  reconstructedNormal.replacements.set('historical-id', 'saved preview')

  const initialized = audit.createEmptyContentReplacementStateLike(
    reconstructedNormal,
  )
  assert.equal(initialized.enabledOutsideCheap, false)
  assert.equal(initialized.seenIds.size, 0)
  assert.equal(initialized.replacements.size, 0)

  audit.setSessionPowerMode('cheap')
  audit.setSessionPowerMode('normal')
  const afterCompaction = audit.createEmptyContentReplacementStateLike(
    initialized,
  )
  assert.equal(afterCompaction.enabledOutsideCheap, false)
})

test('two SDK submit context rebuilds retain one replacement map', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('cheap')
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const messages = [
    userToolResults([
      { id: ids[0], content: 'A'.repeat(9_000) },
      { id: ids[1], content: 'B'.repeat(8_500) },
      { id: ids[2], content: 'C'.repeat(8_000) },
    ]),
  ]
  const owner = { current: undefined }

  try {
    const firstSubmitContext = audit.getContentReplacementStateBinding(owner)
    const firstState = audit.createContentReplacementState(false)
    firstSubmitContext.setContentReplacementState(firstState)
    const first = await audit.applyToolResultBudget(messages, owner.current)
    const firstBytes = JSON.stringify(first)

    const secondSubmitContext = audit.getContentReplacementStateBinding(owner)
    assert.equal(secondSubmitContext.contentReplacementState, firstState)
    const second = await audit.applyToolResultBudget(
      messages,
      secondSubmitContext.contentReplacementState,
    )
    assert.equal(JSON.stringify(second), firstBytes)
  } finally {
    await Promise.all(
      ids.map(id => removeIfCreated(audit.getToolResultPath(id, false))),
    )
  }
})

test('two one-shot QueryEngine turns retain byte-identical headless previews', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('cheap')
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const messages = [
    userToolResults([
      { id: ids[0], content: 'A'.repeat(9_000) },
      { id: ids[1], content: 'B'.repeat(8_500) },
      { id: ids[2], content: 'C'.repeat(8_000) },
    ]),
  ]
  const owner = { current: undefined }
  const makeConfig = initialMessages => ({
    cwd: process.cwd(),
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => ({}),
    setAppState: () => {},
    initialMessages,
    readFileCache: new Map(),
    contentReplacementStateRef: owner,
  })

  try {
    // runHeadlessStreaming constructs one QueryEngine per dequeued command.
    // These two instances model consecutive one-shot ask() turns sharing the
    // runner-owned ref.
    new audit.QueryEngine(makeConfig([]))
    const firstState = owner.current
    assert.ok(firstState)
    const first = await audit.enforceToolResultBudget(messages, firstState)
    assert.equal(first.newlyReplaced.length, 1)
    const firstBytes = JSON.stringify(first.messages)

    new audit.QueryEngine(makeConfig(messages))
    assert.equal(owner.current, firstState)
    const second = await audit.applyToolResultBudget(messages, owner.current)
    assert.equal(JSON.stringify(second), firstBytes)

    const printSource = readFileSync(resolve('src/cli/print.ts'), 'utf8')
    assert.match(
      printSource,
      /const contentReplacementStateRef: ContentReplacementStateRef =/,
    )
    assert.match(
      printSource,
      /initialContentReplacements,\s*contentReplacementStateRef,\s*getReadFileCache:/,
    )
  } finally {
    await Promise.all(
      ids.map(id => removeIfCreated(audit.getToolResultPath(id, false))),
    )
  }
})

test('aggregate decisions reapply byte-identically after resume', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('cheap')
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const messages = [
    userToolResults([
      { id: ids[0], content: 'A'.repeat(9_000) },
      { id: ids[1], content: 'B'.repeat(8_500) },
      { id: ids[2], content: 'C'.repeat(8_000) },
    ]),
  ]
  const state = audit.createContentReplacementState(false)

  try {
    const first = await audit.enforceToolResultBudget(messages, state)
    assert.equal(first.newlyReplaced.length, 1)
    const firstBytes = JSON.stringify(first.messages)

    const reapplied = await audit.enforceToolResultBudget(messages, state)
    assert.equal(JSON.stringify(reapplied.messages), firstBytes)
    assert.equal(reapplied.newlyReplaced.length, 0)

    const resumed = audit.reconstructContentReplacementState(
      messages,
      first.newlyReplaced,
      undefined,
      false,
    )
    const afterResume = await audit.enforceToolResultBudget(messages, resumed)
    assert.equal(JSON.stringify(afterResume.messages), firstBytes)
  } finally {
    await Promise.all(
      ids.map(id => removeIfCreated(audit.getToolResultPath(id, false))),
    )
  }
})

test('aggregate target accounts for replacement and existing-preview bytes', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('cheap')
  const manyIds = Array.from({ length: 13 }, () => randomUUID())
  const fixedIds = Array.from({ length: 11 }, () => randomUUID())

  try {
    const manyMessages = [
      userToolResults(
        manyIds.map((id, i) => ({
          id,
          content: String(i).padStart(2, '0') + 'x'.repeat(1_998),
        })),
      ),
    ]
    const many = await audit.enforceToolResultBudget(
      manyMessages,
      audit.createContentReplacementState(false),
    )
    assert.ok(many.newlyReplaced.length >= 2)
    assert.ok(
      visibleToolResultChars(many.messages) <=
        audit.CHEAP_MODE_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
    )

    const fixedPreview =
      '<persisted-output>\n' + 'p'.repeat(2_000) + '\n</persisted-output>'
    const mixedMessages = [
      userToolResults([
        { id: `fixed-${randomUUID()}`, content: fixedPreview },
        ...fixedIds.map((id, i) => ({
          id,
          content: String(i).padStart(2, '0') + 'y'.repeat(1_998),
        })),
      ]),
    ]
    const mixed = await audit.enforceToolResultBudget(
      mixedMessages,
      audit.createContentReplacementState(false),
    )
    assert.ok(
      mixed.newlyReplaced.length >= 1,
      'fixed persisted preview must count toward the aggregate target',
    )
    assert.ok(
      visibleToolResultChars(mixed.messages) <=
        audit.CHEAP_MODE_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
    )
  } finally {
    await Promise.all(
      [...manyIds, ...fixedIds].map(id =>
        removeIfCreated(audit.getToolResultPath(id, false)),
      ),
    )
  }
})

test('fresh normal resume reapplies cheap records but makes no new decisions', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('cheap')
  const oldIds = [randomUUID(), randomUUID(), randomUUID()]
  const newIds = [randomUUID(), randomUUID(), randomUUID()]
  const oldMessages = [
    userToolResults([
      { id: oldIds[0], content: 'A'.repeat(9_000) },
      { id: oldIds[1], content: 'B'.repeat(8_500) },
      { id: oldIds[2], content: 'C'.repeat(8_000) },
    ]),
  ]

  try {
    const cheapState = audit.createContentReplacementState(false)
    const cheap = await audit.enforceToolResultBudget(oldMessages, cheapState)
    assert.equal(cheap.newlyReplaced.length, 1)
    const cheapBytes = JSON.stringify(cheap.messages)

    audit.setSessionPowerMode('normal')
    const resumed = audit.provisionContentReplacementState(
      oldMessages,
      cheap.newlyReplaced,
    )
    assert.ok(resumed, 'stored records must provision state with GB off')
    assert.equal(resumed.enabledOutsideCheap, false)
    const reapplied = await audit.applyToolResultBudget(oldMessages, resumed)
    assert.equal(JSON.stringify(reapplied), cheapBytes)

    const withFreshNormalResults = [
      ...oldMessages,
      assistantBoundary(`boundary-${randomUUID()}`),
      userToolResults([
        { id: newIds[0], content: 'D'.repeat(25_000) },
        { id: newIds[1], content: 'E'.repeat(25_000) },
        { id: newIds[2], content: 'F'.repeat(25_000) },
      ]),
    ]
    const normal = await audit.applyToolResultBudget(
      withFreshNormalResults,
      resumed,
    )
    const freshMessage = normal.at(-1)
    assert.equal(
      freshMessage.message.content[0].content,
      'D'.repeat(25_000),
      'normal mode must not create fresh replacements when GB is off',
    )
    for (const id of newIds) assert.ok(resumed.seenIds.has(id))
  } finally {
    await Promise.all(
      [...oldIds, ...newIds].map(id =>
        removeIfCreated(audit.getToolResultPath(id, false)),
      ),
    )
  }
})

test('normal parent resumes saved cheap sidechain previews without parent state', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('normal')
  const id = randomUUID()
  const original = 'sidechain raw output'.repeat(2_000)
  const replacement = '<persisted-output>saved sidechain preview</persisted-output>'
  const messages = [userToolResults([{ id, content: original }])]
  const records = [{ kind: 'tool-result', toolUseId: id, replacement }]

  const resumed = audit.reconstructForSubagentResume(
    undefined,
    messages,
    records,
  )
  assert.ok(resumed)
  assert.equal(resumed.enabledOutsideCheap, false)
  assert.equal(resumed.replacements.get(id), replacement)
  const reapplied = await audit.applyToolResultBudget(messages, resumed)
  assert.equal(reapplied[0].message.content[0].content, replacement)
  assert.equal(
    audit.reconstructForSubagentResume(undefined, messages, []),
    undefined,
  )
})

test('teleport transport metadata reaches normal resume replacement state', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('normal')
  const id = randomUUID()
  const replacement = '<persisted-output>remote saved preview</persisted-output>'
  const remoteMessage = {
    ...userToolResults([{ id, content: 'remote raw output'.repeat(2_000) }]),
    isSidechain: false,
  }
  const sidechainMessage = {
    ...userToolResults([
      { id: `side-${randomUUID()}`, content: 'sidechain output' },
    ]),
    isSidechain: true,
  }
  const entries = [
    remoteMessage,
    sidechainMessage,
    {
      type: 'content-replacement',
      sessionId: 'remote-session',
      replacements: [{ kind: 'tool-result', toolUseId: id, replacement }],
    },
    {
      type: 'content-replacement',
      sessionId: 'remote-session',
      agentId: 'side-agent',
      replacements: [
        {
          kind: 'tool-result',
          toolUseId: 'side-result',
          replacement: 'sidechain preview',
        },
      ],
    },
  ]

  const resumedData = audit.extractTeleportResumeData(entries)
  assert.deepEqual(resumedData.log, [remoteMessage])
  assert.deepEqual(resumedData.contentReplacements, [
    { kind: 'tool-result', toolUseId: id, replacement },
  ])

  const state = audit.provisionContentReplacementState(
    resumedData.log,
    resumedData.contentReplacements,
  )
  assert.ok(state)
  assert.equal(state.enabledOutsideCheap, false)
  const applied = await audit.applyToolResultBudget(resumedData.log, state)
  assert.equal(applied[0].message.content[0].content, replacement)

  const printSource = readFileSync(resolve('src/cli/print.ts'), 'utf8')
  assert.match(
    printSource,
    /contentReplacements: teleportResult\.contentReplacements/,
  )
  const mainSource = readFileSync(resolve('src/main.tsx'), 'utf8')
  assert.match(
    mainSource,
    /contentReplacements: teleportContentReplacements/,
  )

  const withoutMetadata = audit.extractTeleportResumeData([remoteMessage])
  assert.deepEqual(withoutMetadata.contentReplacements, [])
  assert.equal(
    audit.provisionContentReplacementState(
      withoutMetadata.log,
      withoutMetadata.contentReplacements,
    ),
    undefined,
    'normal/v1 fallback must leave historical originals untouched',
  )
  audit.setSessionPowerMode('cheap')
  const cheapFallback = audit.provisionContentReplacementState(
    withoutMetadata.log,
    withoutMetadata.contentReplacements,
  )
  assert.ok(cheapFallback.seenIds.has(id))
  assert.equal(cheapFallback.replacements.size, 0)
  const frozenOriginal = await audit.applyToolResultBudget(
    withoutMetadata.log,
    cheapFallback,
  )
  assert.equal(JSON.stringify(frozenOriginal), JSON.stringify(withoutMetadata.log))
})

test('CCR metadata writer round-trips main records and rejects agent scope', async () => {
  resetPolicyEnvironment()
  const tempDir = await mkdtemp(join(tmpdir(), 'tau-ccr-replacements-'))
  const transcriptPath = join(tempDir, 'session.jsonl')
  const sessionId = randomUUID()
  const toolUseId = randomUUID()
  const replacement = '<persisted-output>CCR exact preview</persisted-output>'
  const records = [{ kind: 'tool-result', toolUseId, replacement }]
  const writes = []
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'

  try {
    writeFileSync(transcriptPath, '')
    audit.resetProjectForTesting()
    audit.switchSession(sessionId)
    audit.setSessionFileForTesting(transcriptPath)
    audit.setInternalEventWriter(async (eventType, payload, options) => {
      writes.push({ eventType, payload, options })
    })
    assert.equal(audit.allowsFreshContentReplacements(), true)

    audit.createContentReplacementRecorder()(records)
    await audit.flushSessionStorage()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].eventType, 'transcript')
    assert.equal(writes[0].payload.type, 'content-replacement')
    assert.deepEqual(writes[0].payload.replacements, records)
    assert.equal(writes[0].options, undefined)

    // CCRClient supplies a UUID to opaque payloads that do not have one.
    const ccrPayload = { ...writes[0].payload, uuid: randomUUID() }
    const roundTrip = audit.extractTeleportResumeData([ccrPayload])
    assert.deepEqual(roundTrip.contentReplacements, records)

    const agentEntry = {
      type: 'content-replacement',
      sessionId,
      agentId: 'agent-sidechain',
      replacements: records,
    }
    assert.equal(
      audit.getContentReplacementCCRWrite(agentEntry),
      undefined,
      'agent records must not enter the foreground CCR stream',
    )
  } finally {
    audit.resetProjectForTesting()
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('headless fork seeds inherited records once, restamped and deduped', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('normal')
  const tempDir = await mkdtemp(join(tmpdir(), 'tau-fork-replacements-'))
  const transcriptPath = join(tempDir, 'fork.jsonl')
  const forkSessionId = randomUUID()
  const firstId = randomUUID()
  const secondId = randomUUID()
  const firstReplacement =
    '<persisted-output>latest inherited preview</persisted-output>'
  const secondReplacement =
    '<persisted-output>second inherited preview</persisted-output>'
  const inherited = [
    {
      kind: 'tool-result',
      toolUseId: firstId,
      replacement: '<persisted-output>stale preview</persisted-output>',
    },
    { kind: 'tool-result', toolUseId: secondId, replacement: secondReplacement },
    { kind: 'tool-result', toolUseId: firstId, replacement: firstReplacement },
  ]
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'

  try {
    writeFileSync(transcriptPath, '')
    audit.resetProjectForTesting()
    audit.switchSession(forkSessionId)
    audit.setSessionFileForTesting(transcriptPath)
    await audit.recordInheritedContentReplacementsForFork(inherited)
    await audit.recordInheritedContentReplacementsForFork(inherited)
    await audit.flushSessionStorage()

    const entries = readFileSync(transcriptPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line))
    const replacementEntries = entries.filter(
      entry => entry.type === 'content-replacement',
    )
    assert.equal(replacementEntries.length, 1)
    assert.equal(replacementEntries[0].sessionId, forkSessionId)
    assert.deepEqual(replacementEntries[0].replacements, [
      { kind: 'tool-result', toolUseId: secondId, replacement: secondReplacement },
      { kind: 'tool-result', toolUseId: firstId, replacement: firstReplacement },
    ])

    const messages = [
      userToolResults([
        { id: firstId, content: 'first raw inherited output' },
        { id: secondId, content: 'second raw inherited output' },
      ]),
    ]
    const resumed = audit.provisionContentReplacementState(
      messages,
      replacementEntries[0].replacements,
    )
    const reapplied = await audit.applyToolResultBudget(messages, resumed)
    assert.equal(reapplied[0].message.content[0].content, firstReplacement)
    assert.equal(reapplied[0].message.content[1].content, secondReplacement)

    const printSource = readFileSync(resolve('src/cli/print.ts'), 'utf8')
    assert.match(
      printSource,
      /options\.forkSession && initialContentReplacements\?\.length/,
    )
    assert.match(
      printSource,
      /recordInheritedContentReplacementsForFork\(\s*initialContentReplacements/,
    )
  } finally {
    audit.resetProjectForTesting()
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('legacy v1 freezes fresh results while preserving stored reapply', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('cheap')
  process.env.ENABLE_SESSION_PERSISTENCE = 'true'
  try {
    audit.resetProjectForTesting()
    audit.setRemoteIngressUrlForTesting(
      'https://legacy-session-ingress.invalid',
    )
    assert.equal(audit.allowsFreshContentReplacements(), false)

    const freshIds = [randomUUID(), randomUUID(), randomUUID()]
    const freshMessages = [
      userToolResults([
        { id: freshIds[0], content: 'A'.repeat(9_000) },
        { id: freshIds[1], content: 'B'.repeat(8_500) },
        { id: freshIds[2], content: 'C'.repeat(8_000) },
      ]),
    ]
    const state = audit.createContentReplacementState(false)
    let persisted = 0
    const first = await audit.applyToolResultBudget(
      freshMessages,
      state,
      () => persisted++,
      undefined,
      audit.allowsFreshContentReplacements(),
    )
    assert.equal(first, freshMessages)
    assert.equal(persisted, 0)
    assert.equal(state.replacements.size, 0)
    for (const id of freshIds) assert.ok(state.seenIds.has(id))

    const storedReplacement =
      '<persisted-output>v1 previously stored preview</persisted-output>'
    const storedState = audit.reconstructContentReplacementState(
      freshMessages,
      [
        {
          kind: 'tool-result',
          toolUseId: freshIds[0],
          replacement: storedReplacement,
        },
      ],
      undefined,
      false,
    )
    const reapplied = await audit.applyToolResultBudget(
      freshMessages,
      storedState,
      undefined,
      undefined,
      audit.allowsFreshContentReplacements(),
    )
    assert.equal(reapplied[0].message.content[0].content, storedReplacement)
    assert.equal(reapplied[0].message.content[1].content, 'B'.repeat(8_500))

    const querySource = readFileSync(resolve('src/query.ts'), 'utf8')
    assert.match(querySource, /allowsFreshContentReplacements\(\)/)
  } finally {
    audit.resetProjectForTesting()
    delete process.env.ENABLE_SESSION_PERSISTENCE
  }
})

test('a replacement record follows its own session across a switch', async () => {
  resetPolicyEnvironment()
  const sessionA = randomUUID()
  const sessionB = randomUUID()
  const records = [
    {
      kind: 'tool-result',
      toolUseId: randomUUID(),
      replacement: '<persisted-output>pinned</persisted-output>',
    },
  ]
  let transcriptA
  let transcriptB
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'

  try {
    audit.resetProjectForTesting()
    audit.switchSession(sessionA)
    // projectDir/<sessionId>/tool-results/<id>.txt → projectDir
    const projectDir = dirname(
      dirname(dirname(audit.getToolResultPath('probe', false))),
    )
    transcriptA = join(projectDir, `${sessionA}.jsonl`)
    transcriptB = join(projectDir, `${sessionB}.jsonl`)
    writeFileSync(transcriptA, '')
    writeFileSync(transcriptB, '')
    audit.setSessionFileForTesting(transcriptA)

    // Bound while sessionA owns the messages; the write lands after a switch.
    const record = audit.createContentReplacementRecorder()
    audit.switchSession(sessionB)
    audit.setSessionFileForTesting(transcriptB)
    record(records)
    await audit.flushSessionStorage()

    const writtenA = readFileSync(transcriptA, 'utf8').trim()
    assert.ok(writtenA, 'record did not reach the session that owns it')
    const entry = JSON.parse(writtenA)
    assert.equal(entry.type, 'content-replacement')
    assert.equal(entry.sessionId, sessionA)
    assert.deepEqual(entry.replacements, records)
    assert.equal(
      readFileSync(transcriptB, 'utf8').trim(),
      '',
      'record leaked into the session that happened to be current',
    )
  } finally {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    audit.resetProjectForTesting()
    if (transcriptA) await removeIfCreated(transcriptA)
    if (transcriptB) await removeIfCreated(transcriptB)
  }
})

test('aggregate persistence pins session path before mkdir await', async () => {
  resetPolicyEnvironment()
  audit.setSessionPowerMode('cheap')
  const sessionA = randomUUID()
  const sessionB = randomUUID()
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const messages = [
    userToolResults([
      { id: ids[0], content: 'A'.repeat(9_000) },
      { id: ids[1], content: 'B'.repeat(8_500) },
      { id: ids[2], content: 'C'.repeat(8_000) },
    ]),
  ]
  let persistedPath
  let sessionADir

  try {
    audit.switchSession(sessionA)
    sessionADir = dirname(dirname(audit.getToolResultPath(ids[0], false)))
    const pending = audit.enforceToolResultBudget(
      messages,
      audit.createContentReplacementState(false),
    )
    // The async enforcement has planned A and is awaiting recursive mkdir.
    audit.switchSession(sessionB)
    const result = await pending
    assert.equal(result.newlyReplaced.length, 1)
    const visible = result.messages[0].message.content.find(
      block => block.tool_use_id === ids[0],
    ).content
    const pathMatch = visible.match(/Full output saved to: ([^\r\n]+)/)
    assert.ok(pathMatch)
    persistedPath = pathMatch[1]
    assert.ok(persistedPath.includes(sessionA))
    assert.ok(!persistedPath.includes(sessionB))
    assert.equal(readFileSync(persistedPath, 'utf8'), 'A'.repeat(9_000))
  } finally {
    if (sessionADir) {
      await rm(sessionADir, { recursive: true, force: true })
    }
  }
})

test('cheap retrieval/search stays inline and full output remains pageable', async () => {
  resetPolicyEnvironment()
  const sourceId = `source-${randomUUID()}`
  const retrieveId = `retrieve-${randomUUID()}`
  const multibyteId = `multibyte-${randomUUID()}`
  const boundaryId = `boundary-${randomUUID()}`
  const invalidUtf8Id = `invalid-utf8-${randomUUID()}`
  const content = Array.from(
    { length: 1_500 },
    (_, i) => `${i}: ERROR deterministic saved output line`,
  ).join('\n')
  const sourcePath = audit.getToolResultPath(sourceId, false)
  const multibytePath = audit.getToolResultPath(multibyteId, false)
  const boundaryPath = audit.getToolResultPath(boundaryId, false)
  const invalidUtf8Path = audit.getToolResultPath(invalidUtf8Id, false)
  const nestedPath = audit.getToolResultPath(retrieveId, false)

  try {
    const persisted = await audit.persistToolResult(content, sourceId)
    assert.ok(!('error' in persisted))
    assert.match(audit.buildLargeToolResultMessage(persisted, content), /Full output saved to:/)

    audit.setSessionPowerMode('normal')
    const normal = await audit.retrievePersistedToolResult({
      toolUseId: sourceId,
      maxBytes: 50_000,
    })
    assert.equal(normal.ok, true)
    assert.equal(normal.content.length, 50_000)

    audit.setSessionPowerMode('cheap')
    const cheap = await audit.retrievePersistedToolResult({
      toolUseId: sourceId,
      maxBytes: 50_000,
    })
    assert.equal(cheap.ok, true)
    assert.equal(
      cheap.content.length,
      audit.CHEAP_MODE_TOOL_OUTPUT_RETRIEVE_BYTES,
    )
    assert.equal(cheap.truncated, true)

    const search = await audit.retrievePersistedToolResult({
      toolUseId: sourceId,
      query: 'ERROR',
    })
    assert.equal(search.ok, true)
    assert.ok(
      search.content.length <= audit.CHEAP_MODE_TOOL_OUTPUT_RETRIEVE_BYTES,
    )

    const mappedContent = [
      `Path: ${cheap.path}`,
      `Total bytes: ${cheap.totalBytes}`,
      `Range: ${cheap.range}`,
      `Truncated: ${cheap.truncated ? 'yes' : 'no'}`,
      '',
      cheap.content,
    ].join('\n')
    const processed = await audit.processPreMappedToolResultBlock(
      {
        type: 'tool_result',
        tool_use_id: retrieveId,
        content: mappedContent,
      },
      'ToolOutputRetrieve',
      130_000,
    )
    assert.equal(processed.content, mappedContent)

    const next = await audit.retrievePersistedToolResult({
      toolUseId: sourceId,
      startByte: audit.CHEAP_MODE_TOOL_OUTPUT_RETRIEVE_BYTES,
    })
    assert.equal(next.ok, true)
    assert.ok(next.content.length > 0)

    const multibyteContent = Array.from(
      { length: 100 },
      (_, i) => `${i}: ${'漢'.repeat(400)} needle`,
    ).join('\n')
    const multibytePersisted = await audit.persistToolResult(
      multibyteContent,
      multibyteId,
    )
    assert.ok(!('error' in multibytePersisted))
    for (const request of [
      { toolUseId: multibyteId, maxBytes: 50_000 },
      { toolUseId: multibyteId, startLine: 1, lineCount: 2_000 },
      { toolUseId: multibyteId, query: 'needle' },
    ]) {
      const page = await audit.retrievePersistedToolResult(request)
      assert.equal(page.ok, true)
      assert.ok(
        Buffer.byteLength(page.content, 'utf8') <=
          audit.CHEAP_MODE_TOOL_OUTPUT_RETRIEVE_BYTES,
        `${page.range} exceeded the UTF-8 byte cap`,
      )
    }

    const boundaryContent = `${'a'.repeat(7_999)}漢tail${'z'.repeat(3_000)}`
    const boundaryPersisted = await audit.persistToolResult(
      boundaryContent,
      boundaryId,
    )
    assert.ok(!('error' in boundaryPersisted))
    const firstBoundaryPage = await audit.retrievePersistedToolResult({
      toolUseId: boundaryId,
      maxBytes: 50_000,
    })
    assert.equal(firstBoundaryPage.ok, true)
    assert.equal(firstBoundaryPage.content, 'a'.repeat(7_999))
    assert.doesNotMatch(firstBoundaryPage.content, /�/)
    const firstRange = firstBoundaryPage.range.match(/^bytes (\d+)-(\d+) of/)
    assert.ok(firstRange)
    const secondBoundaryPage = await audit.retrievePersistedToolResult({
      toolUseId: boundaryId,
      startByte: Number(firstRange[2]) + 1,
      maxBytes: 50_000,
    })
    assert.equal(secondBoundaryPage.ok, true)
    assert.doesNotMatch(secondBoundaryPage.content, /�/)
    assert.equal(
      firstBoundaryPage.content + secondBoundaryPage.content,
      boundaryContent,
    )

    writeFileSync(invalidUtf8Path, Buffer.alloc(12_000, 0xff))
    const invalidUtf8Page = await audit.retrievePersistedToolResult({
      toolUseId: invalidUtf8Id,
      maxBytes: 50_000,
    })
    assert.equal(invalidUtf8Page.ok, true)
    assert.ok(
      Buffer.byteLength(invalidUtf8Page.content, 'utf8') <=
        audit.CHEAP_MODE_TOOL_OUTPUT_RETRIEVE_BYTES,
      'invalid UTF-8 expansion exceeded the byte cap',
    )
  } finally {
    await removeIfCreated(sourcePath)
    await removeIfCreated(multibytePath)
    await removeIfCreated(boundaryPath)
    await removeIfCreated(invalidUtf8Path)
    await removeIfCreated(nestedPath)
  }
})

test.after(() => {
  for (const key of envKeys) {
    const original = originalEnv.get(key)
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
  audit.resetGrowthBook()
})
