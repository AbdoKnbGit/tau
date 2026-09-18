/**
 * Observer-only tool input fields must not reach the API.
 *
 * Run: bun run src/utils/observableInput.test.ts
 */
import { z as z3 } from 'zod'
import { z } from 'zod/v4'
import { stripObservableBackfill } from './observableInput.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

const json = (v: unknown) => JSON.stringify(v)

// Verbatim copy of SendMessageTool.backfillObservableInput
// (src/tools/SendMessageTool/SendMessageTool.ts). The tool module itself pulls
// in the agent runtime, which does not load outside the bundle.
function sendMessageBackfill(input: Record<string, unknown>): void {
  if ('type' in input) return
  if (typeof input.to !== 'string') return

  if (input.to === '*') {
    input.type = 'broadcast'
    if (typeof input.message === 'string') input.content = input.message
  } else if (typeof input.message === 'string') {
    input.type = 'message'
    input.recipient = input.to
    input.content = input.message
  } else if (typeof input.message === 'object' && input.message !== null) {
    const msg = input.message as {
      type?: string
      request_id?: string
      approve?: boolean
      reason?: string
      feedback?: string
    }
    input.type = msg.type
    input.recipient = input.to
    if (msg.request_id !== undefined) input.request_id = msg.request_id
    if (msg.approve !== undefined) input.approve = msg.approve
    const content = msg.reason ?? msg.feedback
    if (content !== undefined) input.content = content
  }
}

const sendMessage = {
  inputSchema: z.object({
    to: z.string(),
    summary: z.string().optional(),
    message: z.union([z.string(), z.object({ type: z.string() }).passthrough()]),
  }),
  backfillObservableInput: sendMessageBackfill,
}

// What query.ts yields (and the REPL keeps): a clone with the backfill applied.
function observed(original: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...original }
  sendMessageBackfill(copy)
  return copy
}

async function main(): Promise<void> {
  console.log('observable tool input:')

  await test('a backfilled message call goes back to exactly what the model wrote', () => {
    const original = { message: 'Read notes-c.txt', to: 'alpha', summary: 'follow up' }
    const kept = observed(original)
    assert('recipient' in kept && 'content' in kept && 'type' in kept, 'fixture must backfill')
    const sent = stripObservableBackfill(sendMessage, kept)
    assert(json(sent) === json(original), `sent=${json(sent)}`)
  })

  await test('survives a transcript round trip (resume from disk)', () => {
    const original = { to: 'beta', summary: 's', message: 'hi' }
    const fromDisk = JSON.parse(JSON.stringify(observed(original)))
    assert(json(stripObservableBackfill(sendMessage, fromDisk)) === json(original), 'round trip')
  })

  await test('broadcast and structured messages are undone too', () => {
    const broadcast = { to: '*', message: 'all hands' }
    assert(
      json(stripObservableBackfill(sendMessage, observed(broadcast))) === json(broadcast),
      'broadcast',
    )
    const structured = {
      to: 'alpha',
      message: { type: 'shutdown_response', request_id: 'r1', approve: true, reason: 'done' },
    }
    assert(
      json(stripObservableBackfill(sendMessage, observed(structured))) === json(structured),
      'structured',
    )
  })

  await test('the in-turn original is returned as the same object', () => {
    const original = { to: 'alpha', message: 'hi' }
    assert(stripObservableBackfill(sendMessage, original) === original, 'same reference')
  })

  await test('fields the model sent itself are kept', () => {
    const extra = { to: 'alpha', message: 'hi', note: 'model wrote this' }
    assert(stripObservableBackfill(sendMessage, extra) === extra, 'unknown key kept')
    // A model-written `type` makes the backfill a no-op, so nothing here was backfilled.
    const typed = { to: 'alpha', message: 'hi', type: 'message' }
    assert(stripObservableBackfill(sendMessage, typed) === typed, 'model type kept')
    // Backfilled-looking keys whose values the backfill would not produce.
    const odd = { to: 'alpha', message: 'hi', type: 'message', recipient: 'beta', content: 'hi' }
    assert(stripObservableBackfill(sendMessage, odd) === odd, 'non-derivable values kept')
  })

  await test('overwrite-only backfills (file tools) are left alone', () => {
    const fileRead = {
      inputSchema: z.object({ file_path: z.string(), offset: z.number().optional() }),
      backfillObservableInput(input: Record<string, unknown>) {
        if (typeof input.file_path === 'string') input.file_path = `/abs/${input.file_path}`
      },
    }
    const input = { file_path: 'a.ts' }
    assert(stripObservableBackfill(fileRead, input) === input, 'unchanged')
  })

  await test('tools without a backfill or without an object schema are untouched', () => {
    const plain = { inputSchema: z.object({ a: z.string() }) }
    const input = { a: 'x', extra: 1 }
    assert(stripObservableBackfill(plain, input) === input, 'no backfill')
    const union = {
      inputSchema: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
      backfillObservableInput: sendMessageBackfill,
    }
    assert(stripObservableBackfill(union, input) === input, 'non-object schema')
  })

  await test('works with zod v3 object schemas as well', () => {
    const v3 = { ...sendMessage, inputSchema: z3.object({ to: z3.string(), message: z3.string() }) }
    const original = { to: 'alpha', message: 'hi' }
    assert(json(stripObservableBackfill(v3, observed(original))) === json(original), 'v3')
  })

  await test('a throwing backfill never breaks the request', () => {
    const broken = {
      inputSchema: z.object({ a: z.string() }),
      backfillObservableInput() {
        throw new Error('boom')
      },
    }
    const input = { a: 'x', b: 'y' }
    assert(stripObservableBackfill(broken, input) === input, 'unchanged on throw')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
