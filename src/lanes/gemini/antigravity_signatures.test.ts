/**
 * Antigravity thought signatures that arrive on a part of their own:
 * Claude 4.6 budget thinking, and Gemini plain-text replies (on unless
 * TAU_GEMINI_TEXT_SIGNATURES=0).
 *
 * Run: bun run src/lanes/gemini/antigravity_signatures.test.ts
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const sandbox = realpathSync(mkdtempSync(join(realpathSync(os.tmpdir()), 'tau-agy-sig-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))

for (const key of ['TAU_GEMINI_TEXT_SIGNATURES', 'TAU_ANTIGRAVITY_CLAUDE_THINKING', 'MAX_THINKING_TOKENS', 'TAU_GEMINI_INCLUDE_THOUGHTS']) {
  delete process.env[key]
}

let replyParts: Record<string, unknown>[] = []
const requests: Record<string, any>[] = []
mock.module('./api.js', () => ({
  TAU_STABLE_SESSION_ID_FIELD: '__tauStableSessionId',
  TAU_QUERY_SOURCE_FIELD: '__tauQuerySource',
  isGeminiRetryableNetworkError: () => false,
  geminiApi: {
    supportsServerCache: () => false,
    async *streamGenerateContent(request: Record<string, unknown>) {
      requests.push(structuredClone(request))
      yield {
        usageMetadata: { promptTokenCount: 30_000, candidatesTokenCount: 5, cachedContentTokenCount: 29_000 },
        candidates: [{ content: { role: 'model', parts: replyParts }, finishReason: 'STOP' }],
      }
    },
  },
}))

let scheduled = 0
mock.module('./antigravity_claude_keepalive.js', () => ({
  cancelAntigravityClaudeKeepAlive: () => {},
  scheduleAntigravityClaudeKeepAlive: () => { scheduled++ },
}))

const { GeminiLane, _convertHistoryToGeminiForTest } = await import('./loop.js')
const { resolveThinkingConfig } = await import('./thinking.js')
const { SIGNATURE_CARRIER_KEY } = await import('./signature_carrier.js')
const { wrapForCodeAssist } = await import('../../services/api/providers/gemini_code_assist.js')

type Block = Record<string, any>

/**
 * Blocks as claude.ts stores them: the start block spread, deltas applied,
 * and one stored row per block in the order the blocks close.
 */
function assemble(events: any[]): Block[] {
  const open = new Map<number, Block>()
  const json = new Map<number, string>()
  const stored: Block[] = []
  for (const e of events) {
    if (e.type === 'content_block_start') {
      open.set(e.index, e.content_block.type === 'thinking'
        ? { ...e.content_block, thinking: '', signature: '' }
        : e.content_block.type === 'text' ? { ...e.content_block, text: '' } : { ...e.content_block })
    } else if (e.type === 'content_block_delta') {
      const b = open.get(e.index)!
      if (e.delta.type === 'text_delta') b.text += e.delta.text
      else if (e.delta.type === 'thinking_delta') b.thinking += e.delta.thinking
      else if (e.delta.type === 'input_json_delta') json.set(e.index, (json.get(e.index) ?? '') + e.delta.partial_json)
    } else if (e.type === 'content_block_stop') {
      const b = open.get(e.index)!
      if (json.has(e.index)) b.input = JSON.parse(json.get(e.index)!)
      stored.push(b)
    }
  }
  return stored
}

/** What `-p`, agents and other readers take as the reply's answer. */
const answerOf = (blocks: Block[]) => {
  const last = blocks.at(-1)
  return last?.type === 'text' ? last.text : ''
}

async function turn(model: string, messages: any[], opts: { thinking?: any; querySource?: string; maxTokens?: number } = {}) {
  const events: any[] = []
  for await (const e of new GeminiLane().streamAsProvider({
    model,
    providerHint: 'antigravity',
    sessionId: `sig-${model}`,
    querySource: opts.querySource ?? 'repl_main_thread',
    signal: new AbortController().signal,
    system: 'Answer briefly.',
    messages,
    tools: [],
    max_tokens: opts.maxTokens ?? 32_000,
    thinking: opts.thinking ?? { type: 'adaptive' },
  } as any)) events.push(e)
  return { events, blocks: assemble(events), request: requests.at(-1)! }
}

const carriers = (blocks: Block[]) => blocks.filter(b => b[SIGNATURE_CARRIER_KEY])
const claudeReply = [
  { text: '' },
  { thought: true, text: 'The user wants ' },
  { thought: true, text: 'a short plan.' },
  { thought: true, text: '', thoughtSignature: 'SIG-CLAUDE' },
  { text: 'Here is the plan.' },
  { text: '' },
]
const geminiReply = [
  { text: 'The number 23' },
  { text: ' is prime.' },
  { text: '', thoughtSignature: 'SIG-GEMINI' },
]

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  requests.length = 0
  scheduled = 0
  try {
    await fn()
  } finally {
    for (const key of ['TAU_GEMINI_TEXT_SIGNATURES', 'TAU_ANTIGRAVITY_CLAUDE_THINKING', 'MAX_THINKING_TOKENS']) delete process.env[key]
  }
  passed++
  console.log(`  ok  ${name}`)
}

console.log('antigravity signatures:')

await test('Claude 4.6 adaptive thinking becomes a budget the bridge honors', () => {
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
    assert.deepEqual(resolveThinkingConfig(model, -1, { type: 'adaptive' }, 32_000), { thinkingBudget: 8192, includeThoughts: true })
  }
  assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', -1, undefined, 1_025), { thinkingBudget: 1024, includeThoughts: true })
  // An output cap too small for Claude's 1024 minimum keeps the old request.
  assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', -1, undefined, 1_024), { thinkingBudget: -1, includeThoughts: true })
  assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', -1), { thinkingBudget: -1, includeThoughts: true })
})

await test('the budget follows MAX_THINKING_TOKENS and the off switch', () => {
  process.env.MAX_THINKING_TOKENS = '16000'
  assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', -1, undefined, 32_000), { thinkingBudget: 16000, includeThoughts: true })
  process.env.MAX_THINKING_TOKENS = '500'
  assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', -1, undefined, 32_000), { thinkingBudget: 1024, includeThoughts: true })
  process.env.MAX_THINKING_TOKENS = '90000'
  assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', -1, undefined, 32_000), { thinkingBudget: 31999, includeThoughts: true })
  delete process.env.MAX_THINKING_TOKENS
  process.env.TAU_ANTIGRAVITY_CLAUDE_THINKING = '0'
  assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', -1, undefined, 32_000), { thinkingBudget: -1, includeThoughts: true })
})

await test('other thinking settings and models are unchanged', () => {
  assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', 0, { type: 'disabled' }, 32_000), { thinkingBudget: 0, includeThoughts: false })
  assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', 4096, { type: 'enabled', budget_tokens: 4096 }, 32_000), { thinkingBudget: 4096, includeThoughts: true })
  assert.deepEqual(resolveThinkingConfig('claude-opus-5-5-high', -1, { type: 'adaptive' }, 32_000), { thinkingBudget: -1, includeThoughts: true })
  assert.deepEqual(resolveThinkingConfig('gemini-3.8-flash-high', -1, { type: 'adaptive' }, 32_000), { thinkingLevel: 'high', includeThoughts: true })
  assert.deepEqual(resolveThinkingConfig('gemini-2.5-pro', -1, undefined, 32_000), { thinkingBudget: -1, includeThoughts: true })
})

await test('a Claude 4.6 turn sends the budget and keeps its signature in a carrier', async () => {
  replyParts = claudeReply
  const { request, blocks } = await turn('claude-sonnet-4-6', [{ role: 'user', content: 'Plan it.' }])
  assert.deepEqual(request.generationConfig.thinkingConfig, { thinkingBudget: 8192, includeThoughts: true })
  const thinking = blocks.find(b => b.type === 'thinking' && b.thinking)
  assert.equal(thinking?.thinking, 'The user wants a short plan.', 'thinking text must stay whole')
  assert.deepEqual(carriers(blocks).map(b => b[SIGNATURE_CARRIER_KEY]), [{ kind: 'thought', signature: 'SIG-CLAUDE', model: 'claude-sonnet-4-6' }])
  const carrierAt = blocks.findIndex(b => b[SIGNATURE_CARRIER_KEY])
  assert.equal(blocks[carrierAt - 1], thinking, 'the carrier follows the thinking it signs')
  assert.equal(answerOf(blocks), 'Here is the plan.', 'the answer must stay the last stored block')
  assert.equal(carriers(blocks)[0]!.thinking, '', 'a carrier shows nothing')
  assert.equal(scheduled, 0, 'a budget-thinking turn must not schedule a keep-alive that would 400')
})

await test('without budget thinking nothing changes for Claude', async () => {
  replyParts = claudeReply
  let r = await turn('claude-sonnet-4-6', [{ role: 'user', content: 'Plan it.' }], { thinking: { type: 'disabled' } })
  assert.equal(carriers(r.blocks).length, 0, 'thinking off must not store signatures')
  assert.equal(scheduled, 1, 'keep-alive stays on when thinking is off')
  process.env.TAU_ANTIGRAVITY_CLAUDE_THINKING = '0'
  r = await turn('claude-sonnet-4-6', [{ role: 'user', content: 'Plan it.' }])
  assert.deepEqual(r.request.generationConfig.thinkingConfig, { thinkingBudget: -1, includeThoughts: true })
  assert.equal(carriers(r.blocks).length, 0)
  assert.equal(scheduled, 2)
  delete process.env.TAU_ANTIGRAVITY_CLAUDE_THINKING
  r = await turn('claude-opus-5-5-high', [{ role: 'user', content: 'Plan it.' }])
  assert.equal(carriers(r.blocks).length, 0, 'Claude 5.5 is unchanged')
  assert.equal(scheduled, 3, 'Claude 5.5 keeps its keep-alive')
})

await test('Gemini text signatures are kept by default; TAU_GEMINI_TEXT_SIGNATURES=0 turns them off', async () => {
  replyParts = geminiReply
  process.env.TAU_GEMINI_TEXT_SIGNATURES = '0'
  const off = await turn('gemini-3.8-flash-high', [{ role: 'user', content: 'A prime?' }])
  assert.equal(carriers(off.blocks).length, 0)
  assert.deepEqual(off.blocks.map(b => [b.type, b.text ?? b.thinking]), [['text', 'The number 23 is prime.']], 'switched off, output must be exactly as before')
  delete process.env.TAU_GEMINI_TEXT_SIGNATURES
  const on = await turn('gemini-3.8-flash-high', [{ role: 'user', content: 'A prime?' }])
  assert.deepEqual(carriers(on.blocks).map(b => b[SIGNATURE_CARRIER_KEY]), [{ kind: 'text', signature: 'SIG-GEMINI', model: 'gemini-3.8-flash-high' }])
  // The signature arrives after the answer, but the answer must stay the
  // reply's last stored block: `-p` and agents read the answer from there.
  assert.equal(answerOf(on.blocks), 'The number 23 is prime.')
  assert.equal(on.blocks.length, 2)
  const starts = on.events.filter(e => e.type === 'content_block_start').map(e => e.index)
  assert.equal(new Set(starts).size, starts.length, 'block indexes must not repeat')
})

await test('with TAU_GEMINI_INCLUDE_THOUGHTS=1 too, the summary shows, the answer stays last, and the replay keeps Google order', async () => {
  process.env.TAU_GEMINI_INCLUDE_THOUGHTS = '1'
  try {
    // The shape Antigravity sent with includeThoughts on (live, 2026-11-14).
    replyParts = [
      { thought: true, text: 'Primes between 20 and 30 are 23 and 29.' },
      { text: 'The number 23' },
      { text: ' is prime.' },
      { text: '', thoughtSignature: 'SIG-GEMINI' },
    ]
    const { blocks, request } = await turn('gemini-3.8-flash-high', [{ role: 'user', content: 'A prime?' }])
    assert.equal(request.generationConfig.thinkingConfig.includeThoughts, true)
    assert.deepEqual(blocks.map(b => (b[SIGNATURE_CARRIER_KEY] ? 'carrier' : b.type)), ['thinking', 'carrier', 'text'])
    assert.equal(blocks[0]!.thinking, 'Primes between 20 and 30 are 23 and 29.', 'the summary is shown as thinking')
    assert.equal(answerOf(blocks), 'The number 23 is prime.')
    const history = [{ role: 'user', content: 'A prime?' }, { role: 'assistant', content: blocks }, { role: 'user', content: 'Another?' }]
    const contents = _convertHistoryToGeminiForTest(history as any, new Map(), { model: 'gemini-3.8-flash-high', claude: false })
    assert.deepEqual(contents.find((c: any) => c.role === 'model')?.parts, [
      { thought: true, text: 'Primes between 20 and 30 are 23 and 29.' },
      { text: 'The number 23 is prime.' },
      { text: '', thoughtSignature: 'SIG-GEMINI' },
    ])
  } finally {
    delete process.env.TAU_GEMINI_INCLUDE_THOUGHTS
  }
})

await test('a Gemini reply ending in a tool call keeps its order and the call signature', async () => {
  process.env.TAU_GEMINI_TEXT_SIGNATURES = '1'
  replyParts = [
    { text: 'Let me check.' },
    { functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'SIG-CALL' },
    { text: '' },
  ]
  const { blocks } = await turn('gemini-3.8-flash-high', [{ role: 'user', content: 'Weather?' }])
  assert.equal(carriers(blocks).length, 0, 'an unsigned trailing text part stores nothing')
  assert.deepEqual(blocks.map(b => b.type), ['text', 'tool_use', 'text'])
  assert.equal(blocks[1]!._gemini_thought_signature, 'SIG-CALL')
})

const claudeHistory = (model: string) => [
  { role: 'user', content: 'Plan it.' },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: 'The user wants a short plan.', signature: '' },
    { type: 'thinking', thinking: '', signature: '', [SIGNATURE_CARRIER_KEY]: { kind: 'thought', signature: 'SIG-CLAUDE', model } },
    { type: 'text', text: 'Here is the plan.' },
  ] },
  { role: 'user', content: 'Go on.' },
]
// Stored the way the lane writes it: the signature before the answer.
const geminiCarrier = { type: 'thinking', thinking: '', signature: '', [SIGNATURE_CARRIER_KEY]: { kind: 'text', signature: 'SIG-GEMINI', model: 'gemini-3.8-flash-high' } }
const geminiHistory = [
  { role: 'user', content: 'A prime?' },
  { role: 'assistant', content: [geminiCarrier, { type: 'text', text: 'The number 23 is prime.' }] },
  { role: 'user', content: 'Another?' },
]
const modelParts = (contents: any[]) => contents.find(c => c.role === 'model')?.parts
const claudeThinkingTarget = { model: 'claude-sonnet-4-6', claude: true, claudeThinking: true }

await test('Claude gets its own thinking back as one signed part', () => {
  const parts = modelParts(_convertHistoryToGeminiForTest(claudeHistory('claude-sonnet-4-6') as any, new Map(), claudeThinkingTarget))
  assert.deepEqual(parts, [
    { thought: true, text: 'The user wants a short plan.', thoughtSignature: 'SIG-CLAUDE' },
    { text: 'Here is the plan.' },
  ])
})

await test('a Claude request that does not think gets no signed thinking', () => {
  const parts = modelParts(_convertHistoryToGeminiForTest(claudeHistory('claude-sonnet-4-6') as any, new Map(), { model: 'claude-sonnet-4-6', claude: true, claudeThinking: false }))
  assert.deepEqual(parts, [{ thought: true, text: 'The user wants a short plan.' }, { text: 'Here is the plan.' }], 'unsigned thinking, which the Claude content fix drops')
})

await test('a signature never goes to a model that did not write it', () => {
  const other = modelParts(_convertHistoryToGeminiForTest(claudeHistory('claude-sonnet-4-6') as any, new Map(), { ...claudeThinkingTarget, model: 'claude-opus-4-6-thinking' }))
  assert.deepEqual(other, [{ thought: true, text: 'The user wants a short plan.' }, { text: 'Here is the plan.' }])
  const toGemini = modelParts(_convertHistoryToGeminiForTest(claudeHistory('claude-sonnet-4-6') as any, new Map(), { model: 'gemini-3.8-flash-high', claude: false }))
  assert.deepEqual(toGemini, [{ thought: true, text: 'The user wants a short plan.' }, { text: 'Here is the plan.' }])
  const toClaude = modelParts(_convertHistoryToGeminiForTest(geminiHistory as any, new Map(), claudeThinkingTarget))
  assert.deepEqual(toClaude, [{ text: 'The number 23 is prime.' }])
  const otherGemini = modelParts(_convertHistoryToGeminiForTest(geminiHistory as any, new Map(), { model: 'gemini-3.7-flash-medium', claude: false }))
  assert.deepEqual(otherGemini, [{ text: 'The number 23 is prime.' }])
})

await test('Gemini gets its text signature back at the end of the turn, across levels of one wire model', () => {
  for (const model of ['gemini-3.8-flash-high', 'gemini-3.8-flash-low']) {
    for (const content of [[geminiCarrier, { type: 'text', text: 'The number 23 is prime.' }], [{ type: 'text', text: 'The number 23 is prime.' }, geminiCarrier]]) {
      const history = [geminiHistory[0], { role: 'assistant', content }, geminiHistory[2]]
      assert.deepEqual(modelParts(_convertHistoryToGeminiForTest(history as any, new Map(), { model, claude: false })), [
        { text: 'The number 23 is prime.' },
        { text: '', thoughtSignature: 'SIG-GEMINI' },
      ])
    }
  }
})

await test('history without carriers converts exactly as before', () => {
  const plain = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: '' }, { type: 'text', text: 'y' }, { type: 'text', text: '' }] },
  ]
  for (const target of [undefined, claudeThinkingTarget, { model: 'gemini-3.8-flash-high', claude: false }]) {
    assert.deepEqual(modelParts(_convertHistoryToGeminiForTest(plain as any, new Map(), target)), [{ thought: true, text: 'x' }, { text: 'y' }])
  }
})

await test('the Claude content fix keeps signed thinking and drops other signature parts', () => {
  const inner = () => ({ contents: [
    { role: 'user', parts: [{ text: 'Plan it.' }] },
    { role: 'model', parts: [
      { thought: true, text: 'Plan.', thoughtSignature: 'SIG-CLAUDE' },
      { thought: true, text: 'unsigned summary' },
      { text: '', thoughtSignature: 'SIG-GEMINI' },
      { text: 'Here is the plan.' },
      { functionCall: { name: 'read_file', args: {} }, thoughtSignature: 'SIG-CALL' },
    ] },
  ] })
  const claude = wrapForCodeAssist('claude-sonnet-4-6', 'p', inner(), '-1') as any
  assert.deepEqual(claude.request.contents[1].parts, [
    { thought: true, text: 'Plan.', thoughtSignature: 'SIG-CLAUDE' },
    { text: 'Here is the plan.' },
    { functionCall: { name: 'read_file', args: {} }, thoughtSignature: 'SIG-CALL' },
  ])
  const gemini = wrapForCodeAssist('gemini-3.8-flash-high', 'p', inner(), '-1') as any
  assert.deepEqual(gemini.request.contents[1].parts, inner().contents[1]!.parts, 'Gemini contents are not filtered')
})

await test('stored signatures replay byte-identically on every later turn', async () => {
  for (const [model, reply, env] of [
    ['claude-sonnet-4-6', claudeReply, undefined],
    ['gemini-3.8-flash-high', geminiReply, '1'],
  ] as const) {
    if (env) process.env.TAU_GEMINI_TEXT_SIGNATURES = env
    replyParts = reply
    const history: any[] = [{ role: 'user', content: 'Plan it.' }]
    const sent: any[][] = []
    for (const next of ['Go on.', 'And then?', 'Thanks.']) {
      const { blocks, request } = await turn(model, history)
      sent.push(request.contents)
      history.push({ role: 'assistant', content: blocks }, { role: 'user', content: next })
    }
    // Each request must start with the previous request's contents, unchanged.
    for (let i = 1; i < sent.length; i++) {
      assert.deepEqual(sent[i]!.slice(0, sent[i - 1]!.length), sent[i - 1], `${model}: turn ${i + 1} rewrote earlier history`)
    }
    const signatures = JSON.stringify(sent.at(-1)).match(/SIG-(CLAUDE|GEMINI)/g) ?? []
    assert.equal(signatures.length, 2, `${model}: each stored reply must carry its signature once`)
    delete process.env.TAU_GEMINI_TEXT_SIGNATURES
  }
})

await test('a Claude side request without thinking sends no signed thinking', async () => {
  replyParts = claudeReply
  const first = await turn('claude-sonnet-4-6', [{ role: 'user', content: 'Plan it.' }])
  const history = [{ role: 'user', content: 'Plan it.' }, { role: 'assistant', content: first.blocks }, { role: 'user', content: 'Title?' }]
  const side = await turn('claude-sonnet-4-6', history, { thinking: { type: 'disabled' }, querySource: 'session_title' })
  assert.equal(JSON.stringify(side.request.contents).includes('SIG-CLAUDE'), false)
  const small = await turn('claude-sonnet-4-6', history, { maxTokens: 512, querySource: 'session_title' })
  assert.deepEqual(small.request.generationConfig.thinkingConfig, { thinkingBudget: -1, includeThoughts: true }, 'a cap below the minimum budget keeps the old request')
  assert.equal(JSON.stringify(small.request.contents).includes('SIG-CLAUDE'), false)
  const main = await turn('claude-sonnet-4-6', history)
  assert.equal(JSON.stringify(main.request.contents).includes('SIG-CLAUDE'), true, 'the thinking main thread still gets it back')
})

await test('every Gemini 4 row gets thought summaries and keeps its text signature like 3.8', async () => {
  const gemini4 = ['argon', 'carbon', 'hydrogen'].flatMap(family => ['low', 'medium', 'high'].map(level => `gemini-4-${family}-${level}`))
  for (const model of gemini4) {
    // Request: summaries on by default, kept through the Gemini 4 wire rewrite.
    const config = resolveThinkingConfig(model, -1, { type: 'adaptive' }, 32_000)
    assert.equal(config.includeThoughts, true, `${model}: summaries off`)
    const wire = wrapForCodeAssist(model, 'p', { contents: [{ role: 'user', parts: [{ text: 'q' }] }], generationConfig: { thinkingConfig: config } }, '-1') as any
    assert.equal(wire.request.generationConfig.thinkingConfig.includeThoughts, true, `${model}: the wire rewrite dropped includeThoughts`)
    // Response: the summary shows, the signature is kept, the answer stays last.
    replyParts = [
      { thought: true, text: 'Checking the range.' },
      { text: 'The number 23 is prime.' },
      { text: '', thoughtSignature: `SIG-${model}` },
    ]
    const { blocks } = await turn(model, [{ role: 'user', content: 'A prime?' }])
    assert.deepEqual(blocks.map(b => (b[SIGNATURE_CARRIER_KEY] ? 'carrier' : b.type)), ['thinking', 'carrier', 'text'], model)
    assert.deepEqual(carriers(blocks)[0]![SIGNATURE_CARRIER_KEY], { kind: 'text', signature: `SIG-${model}`, model })
    assert.equal(answerOf(blocks), 'The number 23 is prime.')
    // Replay: back to the same row, never to another level or family.
    const history = [{ role: 'user', content: 'A prime?' }, { role: 'assistant', content: blocks }, { role: 'user', content: 'Another?' }]
    const partsFor = (target: string) => (_convertHistoryToGeminiForTest(history as any, new Map(), { model: target, claude: false }) as any[])
      .find(c => c.role === 'model')!.parts
    assert.deepEqual(partsFor(model), [
      { thought: true, text: 'Checking the range.' },
      { text: 'The number 23 is prime.' },
      { text: '', thoughtSignature: `SIG-${model}` },
    ], `${model}: replay`)
    const other = model.endsWith('-high') ? model.replace(/-high$/, '-low') : model.replace(/-(low|medium)$/, '-high')
    assert.equal(JSON.stringify(partsFor(other)).includes('thoughtSignature'), false, `${model}: signature leaked to ${other}`)
    assert.equal(JSON.stringify(partsFor('gemini-3.8-flash-high')).includes('thoughtSignature'), false, `${model}: signature leaked to 3.8`)
  }
})

console.log(`\n${passed} passed, 0 failed`)
