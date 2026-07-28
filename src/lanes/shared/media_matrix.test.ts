/**
 * The attachment matrix: every combination of "is OCR configured" and "is a
 * vision describer configured", for both images and documents.
 *
 * The requirement under test is not "produces the best answer", it is
 * "produces an answer at all". An attachment must never break a request, so
 * every cell of this table has to render something a text-only model can read,
 * and nothing in here may throw.
 *
 * Run: bun run src/lanes/shared/media_matrix.test.ts
 */

import {
  prefetchMediaText,
  renderMediaForTextLane,
  shouldTryVisionDescription,
  substituteUnsendableMedia,
  unreadableReason,
  _resetMediaExtractionForTest,
  _seedMediaExtractionForTest,
} from './media_extract.js'

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

function imageBlock(seed: string): unknown {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from(`fake-png-${seed}`).toString('base64'),
    },
  }
}

function pdfBlock(seed: string): unknown {
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: Buffer.from(`fake-pdf-${seed}`).toString('base64'),
    },
  }
}

const asUserMessage = (block: unknown): unknown[] => [
  { role: 'user', content: [block] },
]

console.log('attachment matrix:')

// ── The decision table, exhaustively ────────────────────────────────

await test('images with no usable text are offered to a describer', () => {
  assert(shouldTryVisionDescription('image', 'empty'), 'empty image should be described')
  assert(
    shouldTryVisionDescription('image', 'unavailable'),
    'an image OCR could not touch should be described',
  )
})

await test('extracted text is never overwritten by a description', () => {
  assert(
    !shouldTryVisionDescription('image', 'text'),
    'OCR text beats prose about the picture it came from',
  )
  assert(
    !shouldTryVisionDescription('image', 'described'),
    'a description needs no second opinion',
  )
})

await test('documents never go to a vision model in any state', () => {
  // No vision API takes a PDF; sending one would be a guaranteed error.
  for (const status of ['text', 'empty', 'unavailable', 'described'] as const) {
    assert(
      !shouldTryVisionDescription('document', status),
      `document/${status} must not be sent to a describer`,
    )
  }
})

// ── Live runs: both subsystems off, which is the default install ────

await test('MATRIX no OCR + no vision: image renders a marker, no throw', async () => {
  _resetMediaExtractionForTest()
  process.env.TAU_OCR_DISABLED = '1'
  process.env.TAU_VISION_DISABLED = '1'

  const block = imageBlock('a')
  await prefetchMediaText(asUserMessage(block), { includeImages: () => true })
  const rendered = renderMediaForTextLane(block)

  assert(typeof rendered === 'string' && rendered.length > 0, 'must render something')
  assert(rendered.includes('image'), `marker should name the kind, got: ${rendered}`)
  assert(!rendered.includes('base64'), 'must never leak the payload into the prompt')
})

await test('MATRIX no OCR + no vision: PDF renders a marker, no throw', async () => {
  _resetMediaExtractionForTest()
  process.env.TAU_OCR_DISABLED = '1'
  process.env.TAU_VISION_DISABLED = '1'

  const block = pdfBlock('a')
  await prefetchMediaText(asUserMessage(block), { includeImages: () => true })
  const rendered = renderMediaForTextLane(block)

  assert(typeof rendered === 'string' && rendered.length > 0, 'must render something')
  assert(!rendered.includes('base64'), 'must never leak the payload into the prompt')
})

await test('MATRIX no describer available: marker is well-formed, no placeholders', async () => {
  // Vision stays disabled here on purpose. Leaving it on would make this test
  // hit whatever describer the machine has configured, which means a live paid
  // API call from a unit test. The "configured but unusable" case is covered
  // without a network by pickVisionModel's own tests.
  _resetMediaExtractionForTest()
  process.env.TAU_OCR_DISABLED = '1'
  process.env.TAU_VISION_DISABLED = '1'

  const block = imageBlock('b')
  await prefetchMediaText(asUserMessage(block), { includeImages: () => true })
  const rendered = renderMediaForTextLane(block)

  assert(typeof rendered === 'string' && rendered.length > 0, 'must render something')
  assert(!rendered.includes('undefined'), `no undefined in output, got: ${rendered}`)
  assert(!rendered.includes('null'), `no null in output, got: ${rendered}`)
})

await test('a lane that carries images natively is never asked to extract', async () => {
  // includeImages() === false is how a native-media lane declares it will send
  // the pixels itself. Nothing should resolve, so nothing can be substituted.
  //
  // Both subsystems are deliberately left ENABLED here, unlike the tests above.
  // The guard under test is the lane's, not the env switches', and disabling
  // them would make the assertion vacuous. prefetchInner filters the target out
  // before any resolver runs, so this still reaches no network.
  _resetMediaExtractionForTest()
  delete process.env.TAU_OCR_DISABLED
  delete process.env.TAU_VISION_DISABLED

  const block = imageBlock('native')
  await prefetchMediaText(asUserMessage(block), { includeImages: () => false })
  const rendered = renderMediaForTextLane(block)

  assert(
    !rendered.includes('description from'),
    'a native-media lane must never receive a description',
  )
  assert(!rendered.includes('extracted with OCR'), 'nor OCR text')
})

await test('an unresolved attachment still renders, it never throws', () => {
  _resetMediaExtractionForTest()
  const rendered = renderMediaForTextLane(imageBlock('unresolved'))
  assert(typeof rendered === 'string' && rendered.length > 0, 'must render a marker')
})

await test('a malformed block renders instead of throwing', () => {
  for (const junk of [null, undefined, {}, { type: 'image' }, { type: 'image', source: {} }]) {
    const rendered = renderMediaForTextLane(junk)
    assert(typeof rendered === 'string', `expected a string for ${JSON.stringify(junk)}`)
  }
})

// ── A dead end must point somewhere the model can actually go ───────

await test('an unreadable PDF tells the model to parse it itself', () => {
  const reason = unreadableReason('document', 'no text extractor is configured')

  assert(reason.includes('pdftotext') || reason.includes('pypdf'), `got: ${reason}`)
  assert(reason.includes('Bash'), 'must name the tool that can do it')
  assert(
    !/set MISTRAL_API_KEY[^(]*$/.test(reason),
    'must not end on an env var the model cannot set',
  )
})

await test('an unreadable image points at /vision-model', () => {
  const reason = unreadableReason('image', 'text extraction failed')
  assert(reason.includes('/vision-model'), `got: ${reason}`)
})

await test('the live no-extractor PDF path carries the self-help hint', async () => {
  _resetMediaExtractionForTest()
  process.env.TAU_OCR_DISABLED = '1'
  process.env.TAU_VISION_DISABLED = '1'

  const block = pdfBlock('selfhelp')
  await prefetchMediaText(asUserMessage(block), { includeImages: () => true })
  const rendered = renderMediaForTextLane(block)

  assert(
    rendered.includes('pdftotext') || rendered.includes('pypdf'),
    `the marker should offer a way forward, got: ${rendered}`,
  )
})

// ── Rendering, one case per outcome the resolver can produce ────────

await test('RENDER ocr text is attributed to OCR', () => {
  _resetMediaExtractionForTest()
  const block = imageBlock('r1')
  _seedMediaExtractionForTest(block, 'Error: connection refused')

  const rendered = renderMediaForTextLane(block)
  assert(rendered.includes('extracted with OCR'), `got: ${rendered}`)
  assert(rendered.includes('Error: connection refused'), 'text must reach the prompt')
})

await test('RENDER description is attributed to the model that wrote it', () => {
  _resetMediaExtractionForTest()
  const block = imageBlock('r2')
  _seedMediaExtractionForTest(block, 'A login form with the submit button overlapping the footer.', {
    model: 'firstParty/claude-haiku-4-5-20251001',
  })

  const rendered = renderMediaForTextLane(block)
  assert(
    rendered.includes('firstParty/claude-haiku-4-5-20251001'),
    `description must name its author, got: ${rendered}`,
  )
  assert(rendered.includes('overlapping the footer'), 'description must reach the prompt')
})

await test('RENDER empty says OCR found nothing rather than staying silent', () => {
  _resetMediaExtractionForTest()
  const block = imageBlock('r3')
  _seedMediaExtractionForTest(block, '')

  const rendered = renderMediaForTextLane(block)
  assert(rendered.length > 0, 'must render a marker')
  assert(rendered.toLowerCase().includes('no text'), `should explain itself, got: ${rendered}`)
})

await test('RENDER unavailable surfaces the reason', () => {
  _resetMediaExtractionForTest()
  const block = imageBlock('r4')
  _seedMediaExtractionForTest(block, '', { reason: 'set MISTRAL_API_KEY to extract their text' })

  const rendered = renderMediaForTextLane(block)
  assert(rendered.includes('MISTRAL_API_KEY'), `reason must survive, got: ${rendered}`)
})

// ── Router lanes: substitute rather than ship pixels blindly ────────

await test('SUBSTITUTE a top-level image becomes its marker text', () => {
  _resetMediaExtractionForTest()
  const block = imageBlock('sub1')
  _seedMediaExtractionForTest(block, 'Error: connection refused')

  const [msg] = substituteUnsendableMedia(asUserMessage(block)) as any[]
  const parts = msg.content

  assert(parts.length === 1, `expected 1 block, got ${parts.length}`)
  assert(parts[0].type === 'text', `expected text, got ${parts[0].type}`)
  assert(parts[0].text.includes('connection refused'), 'resolved text must survive')
  assert(!('source' in parts[0]), 'the base64 payload must not survive')
})

await test('SUBSTITUTE an image inside a tool_result is replaced too', () => {
  // Browser screenshots arrive this way, nested in tool_result content.
  _resetMediaExtractionForTest()
  const block = imageBlock('sub2')
  _seedMediaExtractionForTest(block, '', { reason: 'no describer configured' })

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [block] },
      ],
    },
  ]
  const [msg] = substituteUnsendableMedia(messages) as any[]
  const inner = msg.content[0].content

  assert(inner[0].type === 'text', `expected nested text, got ${inner[0].type}`)
  assert(inner[0].text.includes('no describer configured'), 'reason must survive')
  assert(msg.content[0].tool_use_id === 't1', 'tool_use_id must be preserved')
})

await test('SUBSTITUTE a conversation with no attachments is returned by identity', () => {
  // The cache-safety property. A conversation that never had an attachment must
  // not be rewritten, or every router-lane turn would shift its own prefix.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: 'a plain string' },
  ]
  assert(
    substituteUnsendableMedia(messages) === messages,
    'must return the same array reference when nothing changed',
  )
})

await test('SUBSTITUTE does not mutate the caller\'s messages', () => {
  _resetMediaExtractionForTest()
  const block = imageBlock('sub3')
  _seedMediaExtractionForTest(block, 'some text')

  const messages = asUserMessage(block) as any[]
  const before = (messages[0].content[0] as any).type
  substituteUnsendableMedia(messages)

  assert(before === 'image', 'precondition')
  assert(
    (messages[0].content[0] as any).type === 'image',
    'the original message must be untouched',
  )
})

await test('SUBSTITUTE a PDF is replaced as well', () => {
  _resetMediaExtractionForTest()
  const block = pdfBlock('sub4')
  _seedMediaExtractionForTest(block, 'page one text')

  const [msg] = substituteUnsendableMedia(asUserMessage(block)) as any[]
  assert(msg.content[0].type === 'text', 'documents substitute too')
  assert(msg.content[0].text.includes('page one text'), 'extracted text must survive')
})

// ── The cache-safety invariant ──────────────────────────────────────

await test('every outcome renders byte-identically on replay', () => {
  _resetMediaExtractionForTest()
  const cases: [unknown, string, { model?: string; reason?: string } | undefined][] = [
    [imageBlock('d1'), 'ocr text', undefined],
    [imageBlock('d2'), 'a description', { model: 'openai/gpt-4o-mini' }],
    [imageBlock('d3'), '', undefined],
    [imageBlock('d4'), '', { reason: 'no key' }],
  ]

  for (const [block, text, opts] of cases) {
    _seedMediaExtractionForTest(block, text, opts)
    const first = renderMediaForTextLane(block)
    const second = renderMediaForTextLane(block)
    assert(first === second, `replay must be byte-identical: ${first} !== ${second}`)
  }
})

await test('a resolved attachment is never re-resolved by a later prefetch', async () => {
  // The pinning rule. Once bytes have been rendered into a prompt, a later turn
  // must not be able to produce different ones for the same block.
  _resetMediaExtractionForTest()
  process.env.TAU_OCR_DISABLED = '1'
  process.env.TAU_VISION_DISABLED = '1'

  const block = imageBlock('pin')
  _seedMediaExtractionForTest(block, 'pinned text')
  const before = renderMediaForTextLane(block)

  await prefetchMediaText(asUserMessage(block), { includeImages: () => true })
  const after = renderMediaForTextLane(block)

  assert(before === after, `pinned outcome changed: ${before} !== ${after}`)
})

delete process.env.TAU_OCR_DISABLED
delete process.env.TAU_VISION_DISABLED

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
