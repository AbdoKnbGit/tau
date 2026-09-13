import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, transform } from 'esbuild'
import ts from 'typescript'

const repository = fileURLToPath(new URL('../', import.meta.url))
const isCompactBoundaryMessage = message =>
  message?.type === 'system' && message.subtype === 'compact_boundary'
const roughEstimate = messages =>
  messages.reduce((total, message) => total + (message.estimatedTokens ?? 0), 0)

// Exercise the complete production accounting module. Its estimator and
// message constants are isolated so these tests need no CLI/account bootstrap.
const bundle = await build({
  absWorkingDir: repository,
  entryPoints: ['src/utils/tokens.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  plugins: [{
    name: 'accounting-dependencies',
    setup(builder) {
      builder.onResolve({ filter: /(?:tokenEstimation|messages|slowOperations)\.js$/ }, args =>
        ({ path: args.path, namespace: 'accounting-dependencies' }))
      builder.onLoad({ filter: /.*/, namespace: 'accounting-dependencies' }, args => ({
        contents: args.path.endsWith('tokenEstimation.js')
          ? `export const roughTokenCountEstimationForMessages = ${roughEstimate}`
          : args.path.endsWith('messages.js')
            ? `export const isCompactBoundaryMessage = ${isCompactBoundaryMessage}; export const SYNTHETIC_MODEL = '<synthetic>'; export const SYNTHETIC_MESSAGES = new Set(['synthetic']);`
            : 'export const jsonStringify = JSON.stringify;',
        loader: 'js',
      }))
    },
  }],
})
const module = { exports: {} }
new Function('module', 'exports', bundle.outputFiles[0].text)(module, module.exports)
const {
  tokenCountWithEstimation,
  tokenCountFromLastAPIResponse,
  finalContextTokensFromLastResponse,
  getCurrentUsage,
  getTokenUsage,
  messageTokenCountFromLastAPIResponse,
  doesMostRecentAssistantMessageExceed200k,
} = module.exports

// The relinker is private to a large storage module. Compile its exact source
// declaration, with only logging and the message guard supplied, so regression
// tests exercise the real resume algorithm without exporting a test-only API or
// initializing filesystem/session singletons.
const storageSource = await readFile(new URL('../src/utils/sessionStorage.ts', import.meta.url), 'utf8')
const storageAST = ts.createSourceFile('sessionStorage.ts', storageSource, ts.ScriptTarget.Latest, true)
const relinker = storageAST.statements.find(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'applyPreservedSegmentRelinks')
assert.ok(relinker, 'production preserved-segment relinker exists')
const relinkerJS = await transform(relinker.getText(storageAST), { loader: 'ts', target: 'node20' })
const relinkEvents = []
const applyPreservedSegmentRelinks = new Function('isCompactBoundaryMessage', 'logEvent',
  `${relinkerJS.code}; return applyPreservedSegmentRelinks;`)(isCompactBoundaryMessage,
  (name, data) => relinkEvents.push({ name, data }))

function user(uuid, estimatedTokens = 100, parentUuid = null) {
  return { type: 'user', uuid, parentUuid, estimatedTokens, message: { content: 'Context' } }
}

function assistant(uuid, { id = uuid, input = 190_000, output = 1_000, read = 15_000,
  estimatedTokens = 100, parentUuid = null, model = 'test-provider-model' } = {}) {
  return {
    type: 'assistant', uuid, parentUuid, estimatedTokens,
    message: {
      id, model, content: [{ type: 'text', text: 'Response' }],
      usage: { input_tokens: input, output_tokens: output,
        cache_read_input_tokens: read, cache_creation_input_tokens: 0 },
    },
  }
}

function boundary(uuid, segment) {
  return { type: 'system', subtype: 'compact_boundary', uuid,
    parentUuid: null, compactMetadata: { ...(segment ? { preservedSegment: segment } : {}) } }
}

function compacted() {
  const kept = assistant('kept')
  const result = user('result', 700, 'kept')
  const marker = boundary('boundary', { headUuid: kept.uuid, tailUuid: result.uuid, anchorUuid: 'summary' })
  return { kept, result, marker, messages: [marker, user('summary', 900, 'boundary'), kept, result] }
}

function assertNoCurrentUsage(messages) {
  assert.equal(tokenCountFromLastAPIResponse(messages), 0)
  assert.equal(finalContextTokensFromLastResponse(messages), 0)
  assert.equal(getCurrentUsage(messages), null)
  assert.equal(doesMostRecentAssistantMessageExceed200k(messages), false)
}

test('retained usage cannot immediately trigger another compaction or a stale context display', () => {
  const { kept, messages } = compacted()
  const original = structuredClone(messages)
  assert.equal(tokenCountWithEstimation(messages), 1_700)
  assertNoCurrentUsage(messages)
  assert.deepEqual(getTokenUsage(kept), kept.message.usage)
  assert.equal(messageTokenCountFromLastAPIResponse(messages), 1_000,
    'output-only historical response measurements remain available')
  assert.deepEqual(messages, original, 'accounting never mutates retained messages')
})

test('all messages added after compaction are estimated until a fresh usage-bearing response', () => {
  const { messages } = compacted()
  messages.push(user('new-request', 300), assistant('synthetic', { model: '<synthetic>', estimatedTokens: 20 }))
  assert.equal(tokenCountWithEstimation(messages), 2_020)
  assertNoCurrentUsage(messages)
})

test('fresh provider usage resumes normal accounting, including interleaved parallel tool results', () => {
  const { messages } = compacted()
  const fresh = assistant('fresh-1', { id: 'response-id', input: 2_000, output: 100, read: 8_000, estimatedTokens: 30 })
  messages.push(fresh, user('tool-result-1', 300),
    assistant('fresh-2', { id: 'response-id', input: 2_000, output: 100, read: 8_000, estimatedTokens: 40 }),
    user('tool-result-2', 600))
  assert.equal(tokenCountWithEstimation(messages), 11_040)
  assert.equal(tokenCountFromLastAPIResponse(messages), 10_100)
  assert.equal(finalContextTokensFromLastResponse(messages), 2_100)
  assert.deepEqual(getCurrentUsage(messages), fresh.message.usage)
})

test('the latest full/manual boundary prevents stale scrollback and old preserved metadata from leaking', () => {
  const { messages } = compacted()
  messages.push(boundary('manual'), user('manual-summary', 400))
  assert.equal(tokenCountWithEstimation(messages), 400)
  assertNoCurrentUsage(messages)
})

test('repeated preserved compaction only trusts responses after the latest preserved tail', () => {
  const { messages } = compacted()
  const newer = assistant('newer')
  messages.push(newer, boundary('second-boundary', {
    headUuid: newer.uuid, tailUuid: newer.uuid, anchorUuid: 'second-summary',
  }), user('second-summary', 250), newer)
  assert.equal(tokenCountWithEstimation(messages), 350)
  assertNoCurrentUsage(messages)
})

test('a missing preserved tail degrades to a complete estimate instead of trusting historical usage', () => {
  const { marker, kept } = compacted()
  const messages = [marker, user('summary', 900), kept]
  assert.equal(tokenCountWithEstimation(messages), 1_000)
  assertNoCurrentUsage(messages)
})

test('ordinary sessions retain provider counts, cache tokens, task iterations, and 200k detection', () => {
  const response = assistant('ordinary')
  response.message.usage.iterations = [{ input_tokens: 10_000, output_tokens: 350 }]
  const messages = [user('request'), response, user('pending', 150)]
  assert.equal(tokenCountWithEstimation(messages), 206_150)
  assert.equal(tokenCountFromLastAPIResponse(messages), 206_000)
  assert.equal(finalContextTokensFromLastResponse(messages), 10_350)
  assert.equal(doesMostRecentAssistantMessageExceed200k(messages), true)
  assert.equal(tokenCountWithEstimation([]), 0)
})

test('resume splices retained records without rewriting their original provider usage', () => {
  const { kept, result, marker } = compacted()
  kept.parentUuid = 'old-request'
  const summary = user('summary', 900, 'boundary')
  const attachment = user('attachment', 200, 'summary')
  const transcript = new Map([user('old-request'), kept, result, marker, summary, attachment].map(message => [message.uuid, message]))
  const originalUsage = structuredClone(kept.message.usage)
  applyPreservedSegmentRelinks(transcript)
  assert.equal(transcript.has('old-request'), false)
  assert.equal(transcript.get('kept').parentUuid, 'summary')
  assert.equal(transcript.get('attachment').parentUuid, 'result')
  assert.deepEqual(transcript.get('kept').message.usage, originalUsage)
  const resumed = ['boundary', 'summary', 'kept', 'result', 'attachment'].map(uuid => transcript.get(uuid))
  assert.equal(tokenCountWithEstimation(resumed), 1_900)
  assertNoCurrentUsage(resumed)
  resumed.push(assistant('after-resume', { input: 3_000, output: 100, read: 0 }))
  assert.equal(tokenCountWithEstimation(resumed), 3_100)
})

test('resume after a subsequent full compaction discards stale retained chains', () => {
  const { kept, result, marker } = compacted()
  const transcript = new Map([kept, result, marker, user('summary', 900, 'boundary'),
    boundary('manual'), user('manual-summary', 500, 'manual')].map(message => [message.uuid, message]))
  applyPreservedSegmentRelinks(transcript)
  assert.deepEqual([...transcript.keys()], ['manual', 'manual-summary'])
  assert.equal(tokenCountWithEstimation([...transcript.values()]), 500)
})

test('repeated compaction resumes a fresh suffix whose disk parents skip the previous retained segment', () => {
  const { kept, result, marker } = compacted()
  kept.parentUuid = 'old-request'
  // On disk, duplicate retained UUIDs are skipped. The first new message is
  // written as a child of the old summary, not of the preserved old tail.
  const nextRequest = user('next-request', 200, 'summary')
  const nextAssistant = assistant('next-response', { input: 4_000, read: 0, output: 250,
    parentUuid: nextRequest.uuid })
  const nextResult = user('next-result', 500, nextAssistant.uuid)
  const nextBoundary = boundary('next-boundary', {
    headUuid: nextRequest.uuid, tailUuid: nextResult.uuid, anchorUuid: 'next-summary',
  })
  const nextSummary = user('next-summary', 600, nextBoundary.uuid)
  const nextAttachment = user('next-attachment', 40, nextSummary.uuid)
  const transcript = new Map([user('old-request'), kept, result, marker,
    user('summary', 900, 'boundary'), nextRequest, nextAssistant, nextResult,
    nextBoundary, nextSummary, nextAttachment].map(message => [message.uuid, message]))
  applyPreservedSegmentRelinks(transcript)
  assert.equal(transcript.has('kept'), false)
  assert.equal(transcript.has('summary'), false)
  assert.equal(transcript.get(nextRequest.uuid).parentUuid, nextSummary.uuid)
  assert.equal(transcript.get(nextAttachment.uuid).parentUuid, nextResult.uuid)
  assert.deepEqual(transcript.get(nextAssistant.uuid).message.usage, nextAssistant.message.usage)
  const resumed = [nextBoundary.uuid, nextSummary.uuid, nextRequest.uuid,
    nextAssistant.uuid, nextResult.uuid, nextAttachment.uuid].map(uuid => transcript.get(uuid))
  assert.equal(tokenCountWithEstimation(resumed), 1_440)
  assertNoCurrentUsage(resumed)
})

test('manual prefix preservation also ignores retained usage when its summary follows the kept segment', () => {
  const kept = assistant('manual-kept')
  const marker = boundary('manual-partial', {
    headUuid: kept.uuid, tailUuid: kept.uuid, anchorUuid: 'manual-partial',
  })
  const messages = [marker, kept, user('manual-partial-summary', 450)]
  assert.equal(tokenCountWithEstimation(messages), 550)
  assertNoCurrentUsage(messages)
})

test('broken persisted segments leave the transcript intact for the existing recovery path', () => {
  const { kept, result, marker } = compacted()
  result.parentUuid = 'missing-record'
  const transcript = new Map([kept, result, marker, user('summary', 900, 'boundary')].map(message => [message.uuid, message]))
  const before = structuredClone(transcript)
  applyPreservedSegmentRelinks(transcript)
  assert.deepEqual(transcript, before)
  assert.equal(relinkEvents.at(-1).name, 'tengu_relink_walk_broken')
})

test('invalid ordered segments never partially rewrite or prune the transcript', () => {
  for (const order of [null, [], ['kept'], ['kept', 'missing', 'result'],
    ['kept', 'kept', 'result'], ['kept', 'summary', 'result'],
    ['kept', 'boundary', 'result'], ['result', 'kept']]) {
    const { kept, result, marker } = compacted()
    marker.compactMetadata.preservedSegment.messageUuids = order
    const transcript = new Map([kept, result, marker, user('summary', 900, 'boundary')]
      .map(message => [message.uuid, message]))
    const before = structuredClone(transcript)
    applyPreservedSegmentRelinks(transcript)
    assert.deepEqual(transcript, before)
    assert.equal(relinkEvents.at(-1).name, 'tengu_relink_order_invalid')
  }
})
