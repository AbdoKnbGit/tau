import assert from 'node:assert/strict'
import test from 'node:test'

import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Phase 1/D: dispatch evidence and authoritative outcomes at the transport
// boundary. The fact under test throughout is the one the boundary used to
// lose — whether an operation may already have been carried out — because
// getting it wrong either duplicates a mutation or invents an acknowledgment.

const runtime = await loadMcpRuntime()

/** A connected-server stand-in whose callTool behaviour the test controls. */
function fixtureServer(callTool) {
  return {
    client: { callTool },
    name: 'fixture',
    config: { type: 'stdio' },
  }
}

const neverAborted = new AbortController().signal

test('a successful call records that it was sent and succeeded', async () => {
  const result = await runtime.callMCPTool({
    client: fixtureServer(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    tool: 'read',
    args: {},
    signal: neverAborted,
  })

  assert.equal(result.outcome.outcome, 'success')
  assert.equal(result.outcome.dispatch, 'sent')
  // Tool success is the tool's own word, never independent proof.
  assert.equal(result.outcome.verification, 'not_attempted')
  assert.equal(result.outcome.version, runtime.OUTCOME_RECORD_VERSION)
})

test('an abort after the request went out is unknown, not cancelled', async () => {
  // The server has already begun work when the user interrupts: the mutation
  // may well have landed, so "cancelled, did not run" would be a guess.
  let executions = 0
  const controller = new AbortController()
  const result = await runtime.callMCPTool({
    client: fixtureServer(async () => {
      executions += 1
      controller.abort()
      const abortError = new Error('aborted')
      abortError.name = 'AbortError'
      throw abortError
    }),
    tool: 'delete',
    args: {},
    signal: controller.signal,
  })

  assert.equal(executions, 1, 'the call must be attempted exactly once')
  assert.equal(result.outcome.outcome, 'unknown')
  assert.equal(result.outcome.dispatch, 'possibly_sent')
  assert.equal(
    runtime.mayHaveExecuted(result.outcome),
    true,
    'an operation that may have executed must never be auto-replayed',
  )
})

test('an ordinary transport failure still throws rather than reading as empty', async () => {
  // Only an AbortError takes the empty-result path. A genuine transport
  // failure must keep throwing, or a failed call would return the same shape
  // as a successful empty one.
  const result = await runtime
    .callMCPTool({
      client: fixtureServer(async () => {
        throw new Error('connection refused')
      }),
      tool: 'write',
      args: {},
      signal: neverAborted,
    })
    .then(
      value => ({ returned: value }),
      error => ({ thrown: error }),
    )

  assert.ok('thrown' in result, 'a non-abort failure must still throw')
  assert.match(result.thrown.message, /connection refused/)
})

test('an uncertain outcome tells the model to check rather than repeat', async () => {
  const controller = new AbortController()
  const result = await runtime.callMCPTool({
    client: fixtureServer(async () => {
      controller.abort()
      const abortError = new Error('aborted')
      abortError.name = 'AbortError'
      throw abortError
    }),
    tool: 'send_message',
    args: {},
    signal: controller.signal,
  })

  const described = runtime.describeOutcome(result.outcome)
  assert.match(described, /unknown whether/i)
  assert.match(described, /check the current state/i)
  // It must not assert either conclusion the boundary cannot support.
  assert.doesNotMatch(described, /did not run|rolled back|failed/i)
})

test('an outcome shape is validated before it is trusted', async () => {
  const { isOutcomeRecord, OUTCOME_RECORD_VERSION } = runtime
  assert.equal(isOutcomeRecord(undefined), false)
  assert.equal(isOutcomeRecord({ outcome: 'success' }), false, 'no version')
  assert.equal(
    isOutcomeRecord({
      version: OUTCOME_RECORD_VERSION + 1,
      dispatch: 'sent',
      outcome: 'success',
      verification: 'not_attempted',
    }),
    false,
    'a record from a future version is not silently accepted',
  )
  assert.equal(
    isOutcomeRecord({
      version: OUTCOME_RECORD_VERSION,
      dispatch: 'sent',
      outcome: 'success',
      verification: 'not_attempted',
    }),
    true,
  )
})

test('an outcome attached to a thrown error survives the throw', async () => {
  // A timeout's only channel is the throw, and the fact that matters — that
  // the request may already have executed — must not be reduced to prose.
  const error = new Error('timed out')
  const carried = {
    version: runtime.OUTCOME_RECORD_VERSION,
    dispatch: 'possibly_sent',
    outcome: 'unknown',
    verification: 'not_attempted',
  }
  // Written and read back through the real pair, so the two halves are
  // checked against each other rather than against a copied constant.
  runtime.attachOutcome(error, carried)

  const read = runtime.outcomeOf(error)
  assert.equal(read?.outcome, 'unknown')
  assert.equal(runtime.outcomeOf(new Error('plain')), undefined)
  assert.equal(runtime.outcomeOf(null), undefined)

  // The carrier must not leak into serialization or telemetry.
  assert.equal(Object.keys(error).includes('outcome'), false)
  assert.equal(JSON.stringify({ ...error }).includes('possibly_sent'), false)
})
