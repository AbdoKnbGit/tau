/**
 * Rough token estimation, for the paths that never reach the API's counter.
 *
 * The failure this file exists to prevent is one-directional and expensive: a
 * base64 payload counted as text. Images and PDFs are billed by pixel count and
 * page count, so their base64 length says nothing about what they cost — but it
 * is enormous, and a `jsonStringify` catch-all will happily turn a 124KB image
 * into 31k tokens against a window where the API charges about two. That
 * reading drives the context meter, the /context breakdown, and how early
 * auto-compact fires.
 *
 * Run via: bun run src/services/tokenEstimation.test.ts
 */

import {
  MEDIA_BLOCK_TOKEN_ESTIMATE,
  roughTokenCountEstimation,
  roughTokenCountEstimationForRawBlock,
} from './tokenEstimation.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
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

/** A base64 blob of roughly the size a screenshot read produces. */
const BIG_BASE64 = 'A'.repeat(124_000)

function imageBlock() {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: BIG_BASE64 },
  }
}

// --- Media inside a tool result --------------------------------------------

test('an image tool_result is billed as media, not as its base64 length', () => {
  // FileReadTool returns exactly this shape for a PNG. The block's own type is
  // `tool_result`, so a check for `type === 'image'` on the outer block misses
  // it and the payload is counted character by character.
  const block = {
    type: 'tool_result',
    tool_use_id: 'toolu_01',
    content: [imageBlock()],
  }
  const tokens = roughTokenCountEstimationForRawBlock(block)
  assert(
    tokens <= MEDIA_BLOCK_TOKEN_ESTIMATE + 50,
    `a wrapped image must estimate near ${MEDIA_BLOCK_TOKEN_ESTIMATE}, got ${tokens}`,
  )
})

test('a bare image block is still billed as media', () => {
  const tokens = roughTokenCountEstimationForRawBlock(imageBlock())
  assert(tokens === MEDIA_BLOCK_TOKEN_ESTIMATE, `got ${tokens}`)
})

test('a document tool_result does not count its base64 either', () => {
  const block = {
    type: 'tool_result',
    tool_use_id: 'toolu_02',
    content: [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: BIG_BASE64,
        },
      },
    ],
  }
  const tokens = roughTokenCountEstimationForRawBlock(block)
  assert(tokens <= MEDIA_BLOCK_TOKEN_ESTIMATE + 50, `got ${tokens}`)
})

test('text mixed alongside an image is still counted', () => {
  // Suppressing the base64 must not suppress the block's real text.
  const block = {
    type: 'tool_result',
    tool_use_id: 'toolu_03',
    content: [{ type: 'text', text: 'x'.repeat(4000) }, imageBlock()],
  }
  const tokens = roughTokenCountEstimationForRawBlock(block)
  assert(
    tokens >= MEDIA_BLOCK_TOKEN_ESTIMATE + 900,
    `the 4000-char text must show up too, got ${tokens}`,
  )
})

// --- Ordinary blocks are unaffected ----------------------------------------

test('a text tool_result is counted by its length', () => {
  const block = {
    type: 'tool_result',
    tool_use_id: 'toolu_04',
    content: 'y'.repeat(4000),
  }
  const tokens = roughTokenCountEstimationForRawBlock(block)
  assert(tokens >= 900 && tokens <= 1100, `expected about 1000, got ${tokens}`)
})

test('a tool_use is counted by its serialized input', () => {
  const block = {
    type: 'tool_use',
    id: 'toolu_05',
    name: 'Bash',
    input: { command: 'z'.repeat(2000) },
  }
  const tokens = roughTokenCountEstimationForRawBlock(block)
  assert(tokens >= 450 && tokens <= 650, `expected about 500, got ${tokens}`)
})

test('a plain text block is counted by its length', () => {
  const tokens = roughTokenCountEstimationForRawBlock({
    type: 'text',
    text: 'w'.repeat(400),
  })
  assert(tokens === 100, `got ${tokens}`)
})

// --- Malformed input -------------------------------------------------------

test('raw blocks from a transcript cannot throw', () => {
  // These come off disk unvalidated; an estimator that throws takes the whole
  // context readout with it.
  for (const block of [
    null,
    undefined,
    42,
    { type: 'text' },
    { type: 'tool_result' },
    { type: 'image' },
    {},
  ]) {
    const tokens = roughTokenCountEstimationForRawBlock(block)
    assert(
      Number.isFinite(tokens) && tokens >= 0,
      `${JSON.stringify(block)} estimated as ${tokens}`,
    )
  }
})

test('a bare string block is counted', () => {
  assert(roughTokenCountEstimationForRawBlock('a'.repeat(400)) === 100, 'string')
  assert(roughTokenCountEstimation(undefined as never) === 0, 'non-string')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
