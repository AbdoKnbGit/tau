/**
 * Attachment-block handling across lanes.
 *
 * Anthropic `image` / `document` blocks reach every lane (pasted screenshots
 * arrive on the user message, `Read`/`@file.png` arrives inside a tool_result).
 * Two failures used to follow:
 *
 *   1. Compat + Codex stringified the block with JSON.stringify, dumping the
 *      whole base64 payload into the prompt as text — thousands of wasted
 *      tokens per attachment, replayed every turn, nothing the model can see.
 *   2. Pasted images had no `case 'image'` at all and were dropped, leaving
 *      the `[Image #N]` marker in the text with nothing behind it, so models
 *      confidently described an image they never received.
 *
 * Invariants asserted here:
 *   - raw base64 never appears as prompt text on any lane
 *   - lanes that can carry images natively (Codex, Gemini) do carry them
 *   - lanes that cannot emit a short deterministic marker instead
 *
 * Run: bun run src/lanes/shared/attachment_blocks.test.ts
 */

import assert from 'node:assert/strict'
import type { ProviderMessage } from '../../services/api/providers/base_provider.js'
import {
  _convertHistoryToOpenAIForTest,
  _toOllamaMessageForTest,
  _applyLastOnlyCacheBreakpointsForTest,
} from '../openai-compat/loop.js'
import { convertHistoryToCodex } from '../codex/loop.js'
import { _convertHistoryToGeminiForTest } from '../gemini/loop.js'
import { convertHistoryToQwen } from '../qwen/loop.js'
import { _convertMessages as _convertCursorMessages } from '../cursor/request.js'
import { _convertMessages as _convertKiroMessages } from '../kiro/request.js'
import { anthropicMessagesToOpenAI } from '../../services/api/adapters/anthropic_to_openai.js'
import {
  prefetchMediaText,
  _resetMediaExtractionForTest,
  _seedMediaExtractionForTest,
} from './media_extract.js'
import {
  recordModelVision,
  _resetVisionCapabilityForTest,
  _seedVisionCapabilityForTest,
} from './vision_capability.js'
import {
  openRouterModelAcceptsImages,
  toOpenRouterModelInfo,
} from '../../utils/model/openrouterCatalog.js'

// Hermetic: also stops the store reading this machine's real capability cache.
_resetVisionCapabilityForTest()

let passed = 0
let failed = 0

// Tests are queued on one chain so sync and async cases keep their order
// (and their section headers) in the output.
let chain: Promise<void> = Promise.resolve()

function test(name: string, fn: () => void | Promise<void>): void {
  chain = chain.then(async () => {
    try {
      await fn()
      passed++
      console.log(`  ok  ${name}`)
    } catch (e: any) {
      failed++
      console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
    }
  })
}

function section(title: string): void {
  chain = chain.then(() => { console.log(title) })
}

// A real 1x1 PNG. Long enough that any leak into prompt text is unmistakable.
const B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const imageBlock = { type: 'image' as const, source: { type: 'base64', media_type: 'image/png', data: B64 } }
// Distinct payload: extraction is keyed by content hash, so sharing bytes
// with the image fixture would make one seed resolve both.
const PDF_B64 = 'JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+'
const documentBlock = {
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 },
} as any

/** Pasted screenshot: text + image block on one user message. */
const pastedImage: ProviderMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'hey can you read [Image #1]' }, imageBlock] },
]

/** `@file.png` → Read tool → image block inside a tool_result. */
const readImage: ProviderMessage[] = [
  { role: 'user', content: 'read the screenshot' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.png' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [imageBlock] }] },
]

const pastedPdf: ProviderMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'read this spec' }, documentBlock] },
]

section('attachment blocks — openai-compat:')

test('pasted image becomes a marker, never base64', () => {
  const out = _convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest')
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes(B64), false, 'base64 leaked into the prompt')
  assert.match(serialized, /image not sent \(image\/png\)/)
  // The user's own text must survive alongside the marker.
  assert.match(serialized, /hey can you read/)
})

test('tool_result image becomes a marker, never base64', () => {
  const out = _convertHistoryToOpenAIForTest(readImage, '', 'mistral', 'devstral-latest')
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes(B64), false, 'base64 leaked into the tool result')
  const toolMessage = out.find(m => m.role === 'tool')
  assert.match(String(toolMessage?.content), /image not sent \(image\/png\)/)
})

test('pdf document block becomes a marker', () => {
  const out = _convertHistoryToOpenAIForTest(pastedPdf, '', 'mistral', 'devstral-latest')
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes(B64), false)
  assert.match(serialized, /document not sent \(application\/pdf\)/)
})

test('deepseek converter gets the same treatment', () => {
  const out = _convertHistoryToOpenAIForTest(pastedImage, '', 'deepseek', 'deepseek-v4-pro')
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes(B64), false)
  assert.match(serialized, /image not sent \(image\/png\)/)
})

test('conversion is deterministic (cached prefix cannot drift)', () => {
  const a = JSON.stringify(_convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest'))
  const b = JSON.stringify(_convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest'))
  assert.equal(a, b)
})

test('histories without attachments are untouched', () => {
  const plain: ProviderMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ]
  const out = _convertHistoryToOpenAIForTest(plain, 'sys', 'mistral', 'devstral-latest')
  assert.deepEqual(out, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ])
})

section('attachment blocks — codex:')

test('pasted image is sent as input_image', () => {
  const out = convertHistoryToCodex(pastedImage, new Map())
  const message = out.find(i => i.type === 'message') as any
  const imagePart = message.content.find((p: any) => p.type === 'input_image')
  assert.ok(imagePart, 'no input_image part emitted')
  assert.equal(imagePart.image_url, `data:image/png;base64,${B64}`)
})

test('tool_result image rides in a trailing user message, not in the output string', () => {
  const out = convertHistoryToCodex(readImage, new Map())
  const output = out.find(i => i.type === 'function_call_output') as any
  assert.ok(output, 'no function_call_output emitted')
  assert.equal(String(output.output).includes(B64), false, 'base64 leaked into the tool output')
  assert.match(String(output.output), /image attached below/)

  const trailing = out[out.length - 1] as any
  assert.equal(trailing.type, 'message')
  assert.equal(trailing.role, 'user')
  assert.equal(trailing.content[0].type, 'input_image')
  assert.equal(trailing.content[0].image_url, `data:image/png;base64,${B64}`)
})

test('pdf document block becomes a marker, never base64', () => {
  const out = convertHistoryToCodex(pastedPdf, new Map())
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes(B64), false)
  assert.match(serialized, /document not sent \(application\/pdf\)/)
})

test('assistant-side image never emits an input_image part', () => {
  const weird: ProviderMessage[] = [{ role: 'assistant', content: [imageBlock] }]
  const out = convertHistoryToCodex(weird, new Map())
  assert.equal(JSON.stringify(out).includes('input_image'), false)
  assert.equal(JSON.stringify(out).includes(B64), false)
})

section('attachment blocks — gemini:')

test('pasted image is sent as inlineData', () => {
  const out = _convertHistoryToGeminiForTest(pastedImage)
  const parts = (out[0] as any).parts
  const inline = parts.find((p: any) => p.inlineData)
  assert.ok(inline, 'no inlineData part emitted')
  assert.equal(inline.inlineData.mimeType, 'image/png')
  assert.equal(inline.inlineData.data, B64)
})

test('tool_result image path still works (regression guard)', () => {
  const out = _convertHistoryToGeminiForTest(readImage)
  const withImage = out.find((c: any) => c.parts.some((p: any) => p.inlineData))
  assert.ok(withImage, 'tool_result image no longer reaches the model')
})

test('pdf document block becomes a marker', () => {
  const out = _convertHistoryToGeminiForTest(pastedPdf)
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes(B64), false)
  assert.match(serialized, /document not sent \(application\/pdf\)/)
})

section('attachment blocks — qwen:')

test('pasted image and tool_result image become markers, never base64', () => {
  for (const history of [pastedImage, readImage]) {
    const out = convertHistoryToQwen(history, new Map())
    const serialized = JSON.stringify(out)
    assert.equal(serialized.includes(B64), false, 'base64 leaked into the qwen prompt')
    assert.match(serialized, /image not sent \(image\/png\)/)
  }
})

section('attachment blocks — cursor:')

test('pasted image and tool_result image become markers, never base64', () => {
  for (const history of [pastedImage, readImage]) {
    const out = _convertCursorMessages(history, '')
    const serialized = JSON.stringify(out)
    assert.equal(serialized.includes(B64), false, 'base64 leaked into the cursor prompt')
    assert.match(serialized, /image not sent \(image\/png\)/)
  }
})

section('attachment blocks — kiro:')

test('pasted image and tool_result image become markers, never base64', () => {
  for (const history of [pastedImage, readImage]) {
    const out = _convertKiroMessages(history, '', [], 'claude-sonnet-4-5')
    const serialized = JSON.stringify(out)
    assert.equal(serialized.includes(B64), false, 'base64 leaked into the kiro payload')
    assert.match(serialized, /image not sent \(image\/png\)/)
  }
})

section('attachment blocks — shared adapter (cline / kilo):')

test('adapter already forwards images natively (regression guard)', () => {
  const out = anthropicMessagesToOpenAI(pastedImage)
  const userMessage = out.find(m => m.role === 'user' && Array.isArray(m.content)) as any
  const imagePart = userMessage?.content.find((p: any) => p.type === 'image_url')
  assert.ok(imagePart, 'adapter stopped emitting image_url parts')
  assert.equal(imagePart.image_url.url, `data:image/png;base64,${B64}`)
})

section('attachment extraction (Mistral OCR layer):')

test('extracted text replaces the marker, base64 still never appears', () => {
  _resetMediaExtractionForTest()
  _seedMediaExtractionForTest(imageBlock, 'Error: ENOENT no such file build.mjs')
  const out = _convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest')
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes(B64), false)
  assert.match(serialized, /extracted with OCR/)
  assert.match(serialized, /ENOENT no such file build.mjs/)
  _resetMediaExtractionForTest()
})

test('extraction is deterministic across turns (cached prefix cannot drift)', () => {
  _resetMediaExtractionForTest()
  _seedMediaExtractionForTest(imageBlock, 'same text every turn')
  const a = JSON.stringify(_convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest'))
  const b = JSON.stringify(_convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest'))
  assert.equal(a, b)
  _resetMediaExtractionForTest()
})

test('an image with no text says so instead of going silent', () => {
  _resetMediaExtractionForTest()
  _seedMediaExtractionForTest(imageBlock, '')
  const out = _convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest')
  assert.match(JSON.stringify(out), /OCR found no text in it/)
  _resetMediaExtractionForTest()
})

test('prefetch with OCR disabled never calls out and explains the fix', async () => {
  _resetMediaExtractionForTest()
  const previous = process.env.TAU_OCR_DISABLED
  process.env.TAU_OCR_DISABLED = '1'
  try {
    await prefetchMediaText(pastedImage, { includeImages: () => true })
    const out = _convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest')
    assert.match(JSON.stringify(out), /set MISTRAL_API_KEY/)
  } finally {
    if (previous === undefined) delete process.env.TAU_OCR_DISABLED
    else process.env.TAU_OCR_DISABLED = previous
    _resetMediaExtractionForTest()
  }
})

test('image-capable lanes are skipped by the prefetch (pixels beat transcripts)', async () => {
  _resetMediaExtractionForTest()
  const previous = process.env.TAU_OCR_DISABLED
  process.env.TAU_OCR_DISABLED = '1'
  try {
    // includeImages:false is what the bridge passes for gemini/codex/cline/kilo.
    await prefetchMediaText(pastedImage, { includeImages: () => false })
    const out = _convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest')
    // Untouched by extraction: the plain marker, with no OCR wording.
    assert.match(JSON.stringify(out), /image not sent \(image\/png\)/)
    assert.equal(JSON.stringify(out).includes('MISTRAL_API_KEY'), false)
    // And Gemini still sends the real pixels.
    const gem = _convertHistoryToGeminiForTest(pastedImage)
    assert.ok((gem[0] as any).parts.some((p: any) => p.inlineData))
  } finally {
    if (previous === undefined) delete process.env.TAU_OCR_DISABLED
    else process.env.TAU_OCR_DISABLED = previous
    _resetMediaExtractionForTest()
  }
})

test('PDF text reaches a text-only lane', () => {
  _resetMediaExtractionForTest()
  _seedMediaExtractionForTest(documentBlock, '# API Spec\nGET /v1/things')
  const out = _convertHistoryToOpenAIForTest(pastedPdf, '', 'mistral', 'devstral-latest')
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes(PDF_B64), false)
  assert.match(serialized, /GET \/v1\/things/)
  _resetMediaExtractionForTest()
})

test('gemini and codex are left alone: OCR never touches those lanes', () => {
  _resetMediaExtractionForTest()
  _seedMediaExtractionForTest(documentBlock, '# API Spec\nGET /v1/things')
  // Both keep their own static marker even when extraction is available.
  const gem = JSON.stringify(_convertHistoryToGeminiForTest(pastedPdf))
  assert.match(gem, /this lane forwards images only/)
  assert.equal(gem.includes('GET /v1/things'), false)
  const cdx = JSON.stringify(convertHistoryToCodex(pastedPdf, new Map()))
  assert.match(cdx, /this lane forwards images only/)
  assert.equal(cdx.includes('GET /v1/things'), false)
  _resetMediaExtractionForTest()
})

section('vision capability (compat is per-model, not per-lane):')

test('OpenRouter modalities are parsed, not guessed', () => {
  assert.equal(
    openRouterModelAcceptsImages({ architecture: { input_modalities: ['text', 'image'] } }),
    true,
  )
  assert.equal(
    openRouterModelAcceptsImages({ architecture: { input_modalities: ['text'] } }),
    false,
  )
  // Legacy single-string form.
  assert.equal(
    openRouterModelAcceptsImages({ architecture: { modality: 'text+image->text' } }),
    true,
  )
  assert.equal(openRouterModelAcceptsImages({}), false)
})

test('catalog mapping tags vision models and records the capability', () => {
  _resetVisionCapabilityForTest()
  const info = toOpenRouterModelInfo({
    id: 'moonshotai/kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    architecture: { input_modalities: ['text', 'image'] },
  })
  assert.ok(info?.tags?.includes('vision'))
  // Recorded under openrouter, and reachable from another gateway reselling
  // the same model id.
  const out = _convertHistoryToOpenAIForTest(
    pastedImage, '', 'openrouter', 'moonshotai/kimi-k2.7-code',
  )
  const message = out.find(m => Array.isArray(m.content)) as any
  assert.ok(message, 'a vision-capable model should get content parts')
  assert.ok(message.content.some((p: any) => p.type === 'image_url'))
})

test('a vision-capable compat model receives the real image', () => {
  _resetVisionCapabilityForTest()
  _seedVisionCapabilityForTest('commandcode', 'moonshotai/Kimi-K2.7-Code', true)
  const out = _convertHistoryToOpenAIForTest(
    pastedImage, '', 'commandcode', 'moonshotai/Kimi-K2.7-Code',
  )
  const message = out.find(m => Array.isArray(m.content)) as any
  const imagePart = message.content.find((p: any) => p.type === 'image_url')
  assert.ok(imagePart, 'no image_url part emitted')
  assert.equal(imagePart.image_url.url, `data:image/png;base64,${B64}`)
  // The user's text still travels with it.
  assert.ok(message.content.some((p: any) => p.type === 'text' && /hey can you read/.test(p.text)))
})

test('tool_result images reach a vision model in a following user message', () => {
  _resetVisionCapabilityForTest()
  _seedVisionCapabilityForTest('openrouter', 'vision-model', true)
  const out = _convertHistoryToOpenAIForTest(readImage, '', 'openrouter', 'vision-model')
  const toolMessage = out.find(m => m.role === 'tool') as any
  assert.match(String(toolMessage.content), /image attached below/)
  assert.equal(String(toolMessage.content).includes(B64), false)
  const trailing = out[out.length - 1] as any
  assert.equal(trailing.role, 'user')
  assert.ok(trailing.content.some((p: any) => p.type === 'image_url'))
})

test('a model known NOT to see gets text, never an image part', () => {
  _resetVisionCapabilityForTest()
  _seedVisionCapabilityForTest('mistral', 'devstral-latest', false)
  const out = _convertHistoryToOpenAIForTest(pastedImage, '', 'mistral', 'devstral-latest')
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes('image_url'), false)
  assert.equal(serialized.includes(B64), false)
  assert.match(serialized, /image not sent \(image\/png\)/)
})

test('an unknown model stays on the safe text path', () => {
  _resetVisionCapabilityForTest()
  const out = _convertHistoryToOpenAIForTest(pastedImage, '', 'groq', 'some-new-model')
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes('image_url'), false)
  assert.match(serialized, /image not sent \(image\/png\)/)
})

test('sending real images stays deterministic across turns', () => {
  _resetVisionCapabilityForTest()
  _seedVisionCapabilityForTest('openrouter', 'vision-model', true)
  const a = JSON.stringify(_convertHistoryToOpenAIForTest(pastedImage, '', 'openrouter', 'vision-model'))
  const b = JSON.stringify(_convertHistoryToOpenAIForTest(pastedImage, '', 'openrouter', 'vision-model'))
  assert.equal(a, b)
  _resetVisionCapabilityForTest()
})

section('cache stability:')

test('a capability that flips mid-session does NOT rewrite sent messages', () => {
  _resetVisionCapabilityForTest()
  // Turn 1: nothing known yet, so the image renders as text.
  const turn1 = JSON.stringify(
    _convertHistoryToOpenAIForTest(pastedImage, '', 'openrouter', 'late-catalog-model'),
  )
  assert.match(turn1, /image not sent/)

  // The catalog loads (user opens /models) and now says the model can see.
  recordModelVision('openrouter', 'late-catalog-model', true)

  // Turn 2 must render the SAME bytes: rewriting an already-sent message
  // would invalidate the whole cached prefix and re-bill the conversation.
  const turn2 = JSON.stringify(
    _convertHistoryToOpenAIForTest(pastedImage, '', 'openrouter', 'late-catalog-model'),
  )
  assert.equal(turn1, turn2)
  _resetVisionCapabilityForTest()
})

test('a session with no attachments never freezes the decision', () => {
  _resetVisionCapabilityForTest()
  const plain: ProviderMessage[] = [{ role: 'user', content: 'hello' }]
  _convertHistoryToOpenAIForTest(plain, '', 'openrouter', 'late-model-2')
  // Catalog arrives afterwards; the first attachment still gets the pixels.
  recordModelVision('openrouter', 'late-model-2', true)
  const out = _convertHistoryToOpenAIForTest(pastedImage, '', 'openrouter', 'late-model-2')
  assert.match(JSON.stringify(out), /image_url/)
  _resetVisionCapabilityForTest()
})

test('Ollama gets images in its sibling field, never inside content', () => {
  const shaped = _toOllamaMessageForTest({
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } },
    ],
  } as any)
  assert.equal(shaped.content, 'what is this')
  assert.deepEqual(shaped.images, [B64])
  assert.equal(String(shaped.content).includes(B64), false)
})

test('a message ending in an image still receives its cache breakpoint', () => {
  const messages: any[] = [
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } },
      ],
    },
  ]
  _applyLastOnlyCacheBreakpointsForTest(messages, 'anthropic/claude-sonnet-4.5')
  const textPart = messages[1].content.find((p: any) => p.type === 'text')
  assert.ok(textPart.cache_control, 'breakpoint dropped when the message ends with an image')
})

await chain
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
