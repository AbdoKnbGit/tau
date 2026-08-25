/**
 * Run: bun run src/lanes/gemini/antigravity_cache.test.ts
 */

import {
  antigravityPrefixPad,
  applyAntigravityPrefixPad,
  diagnoseAntigravityCacheBreak,
  freezeAntigravityVolatilePrefix,
  guardAntigravityCommitWindow,
  paceAntigravityAgentRequest,
  recordAntigravityCacheRead,
  writeAntigravityCacheDebugEntry,
  _getAntigravityPaceStateForTest,
  _resetAntigravityCacheStateForTest,
  _setAntigravityCommitWindowForTest,
} from './antigravity_cache.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir as realTmpdir } from 'node:os'

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

async function main(): Promise<void> {
  // Pad + pacing are opt-in (default off). Exercise the ENABLED behavior
  // here; the default-off path is covered by dedicated tests that clear it.
  process.env.TAU_ANTIGRAVITY_MAX_CACHE = '1'

  console.log('antigravity prefix pad:')

  await test('pad generation is deterministic and memoized', () => {
    const a = antigravityPrefixPad(2000)
    const b = antigravityPrefixPad(2000)
    assert(a === b, 'same size must return identical bytes')
    assert(a.startsWith('<cache_alignment_padding>'), 'missing opening tag')
    assert(a.endsWith('</cache_alignment_padding>'), 'missing closing tag')
  })

  await test('pad sizes scale with requested tokens', () => {
    const small = antigravityPrefixPad(500)
    const large = antigravityPrefixPad(5000)
    assert(large.length > small.length * 5, `small=${small.length} large=${large.length}`)
    // ~4.6 chars/token provisioning must be met.
    assert(large.length >= 5000 * 4.6, `large pad too small: ${large.length}`)
  })

  await test('small prompts get padded over the cache minimum', () => {
    const stable = 'You are a focused search agent.'.repeat(50) // ~1.5k chars
    const padded = applyAntigravityPrefixPad(stable, 10_000)
    assert(padded !== stable, 'small prompt must be padded')
    assert(padded.endsWith(stable), 'stable text must keep its position after the pad')
    // (stable + tools ≈ 11.7k chars ≈ 2.1k tokens) → missing ≈ 15.3k tokens
    // → ≥ 15.3k * 4.6 ≈ 70k chars of pad.
    assert(
      padded.length - stable.length > 60_000,
      `pad too small: ${padded.length - stable.length} chars`,
    )
  })

  await test('padding is byte-stable across turns for the same inputs', () => {
    const stable = 'agent persona text '.repeat(300)
    const a = applyAntigravityPrefixPad(stable, 42_000)
    const b = applyAntigravityPrefixPad(stable, 42_000)
    assert(a === b, 'same inputs must produce identical padded text')
  })

  await test('small tool-list drift within a size step keeps the pad identical', () => {
    const stable = 'agent persona text '.repeat(300)
    const a = applyAntigravityPrefixPad(stable, 42_000)
    const b = applyAntigravityPrefixPad(stable, 42_100) // < 500-token step
    assert(a === b, 'sub-step drift must not change the pad')
  })

  await test('over-minimum prompts are returned unchanged', () => {
    const big = 'x'.repeat(120_000) // ≈ 21.8k estimated tokens > target
    assert(
      applyAntigravityPrefixPad(big, 0) === big,
      'large prompt must not be padded',
    )
  })

  await test('TAU_ANTIGRAVITY_NO_PREFIX_PAD=1 disables padding', () => {
    process.env.TAU_ANTIGRAVITY_NO_PREFIX_PAD = '1'
    try {
      const stable = 'tiny'
      assert(
        applyAntigravityPrefixPad(stable, 0) === stable,
        'env override must disable the pad',
      )
    } finally {
      delete process.env.TAU_ANTIGRAVITY_NO_PREFIX_PAD
    }
  })

  await test('padding is OFF by default (no TAU_ANTIGRAVITY_MAX_CACHE)', () => {
    delete process.env.TAU_ANTIGRAVITY_MAX_CACHE
    try {
      const stable = 'You are a focused search agent.'.repeat(50) // ~1.5k chars
      assert(
        applyAntigravityPrefixPad(stable, 10_000) === stable,
        'a small prompt must NOT be padded when the discipline is off',
      )
    } finally {
      process.env.TAU_ANTIGRAVITY_MAX_CACHE = '1'
    }
  })

  console.log('antigravity volatile prefix freeze:')

  await test('volatile prefix freezes to the first value for a session', () => {
    _resetAntigravityCacheStateForTest()
    const first = freezeAntigravityVolatilePrefix('gemini:session-a', 'env v1')
    const second = freezeAntigravityVolatilePrefix('gemini:session-a', 'env v2')
    assert(first === 'env v1', 'first volatile prefix must pass through')
    assert(second === 'env v1', 'later volatile prefix must replay first bytes')
  })

  await test('volatile prefix replay survives an empty later value', () => {
    _resetAntigravityCacheStateForTest()
    freezeAntigravityVolatilePrefix('gemini:session-a', 'env v1')
    const second = freezeAntigravityVolatilePrefix('gemini:session-a', '')
    assert(second === 'env v1', 'empty later value must not erase frozen prefix')
  })

  await test('volatile prefix freeze is scoped by cache key', () => {
    _resetAntigravityCacheStateForTest()
    const a = freezeAntigravityVolatilePrefix('gemini:session-a', 'env a')
    const b = freezeAntigravityVolatilePrefix('gemini:session-b', 'env b')
    assert(a === 'env a', 'session a mismatch')
    assert(b === 'env b', 'session b mismatch')
  })

  console.log('antigravity commit-window pacing:')

  await test('first request arms without waiting', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(50)
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc')
    assert(Date.now() - start < 25, 'first request must not wait')
    const state = _getAntigravityPaceStateForTest('tau-agent-abc')
    assert(state !== undefined && state.pacedCount === 0, 'state must be armed')
  })

  await test('second request waits out the commit window', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await paceAntigravityAgentRequest('tau-agent-abc')
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc')
    const waited = Date.now() - start
    assert(waited >= 40, `second request must wait, waited=${waited}ms`)
    const state = _getAntigravityPaceStateForTest('tau-agent-abc')
    assert(state?.pacedCount === 1, `pacedCount=${state?.pacedCount}`)
  })

  await test('a qualifying cache hit latches pacing off', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await paceAntigravityAgentRequest('tau-agent-abc')
    recordAntigravityCacheRead('tau-agent-abc', 9000, 10_000) // 90% coverage
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc')
    assert(Date.now() - start < 25, 'hit-latched session must not wait')
  })

  await test('a partial hit below 70% coverage keeps pacing armed', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await paceAntigravityAgentRequest('tau-agent-abc')
    recordAntigravityCacheRead('tau-agent-abc', 2000, 10_000) // 20% coverage
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc')
    assert(Date.now() - start >= 40, 'partial hit must not latch pacing off')
  })

  await test('pacing gives up after two paced turns', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(40)
    await paceAntigravityAgentRequest('tau-agent-abc') // arm
    await paceAntigravityAgentRequest('tau-agent-abc') // paced 1 (re-arms)
    await paceAntigravityAgentRequest('tau-agent-abc') // paced 2 (re-arms)
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc') // must not pace
    assert(Date.now() - start < 25, 'pacing must cap at two paced turns')
  })

  await test('main-thread sessions are never paced', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await paceAntigravityAgentRequest('root-session-uuid')
    const start = Date.now()
    await paceAntigravityAgentRequest('root-session-uuid')
    assert(Date.now() - start < 25, 'main-thread session must not wait')
    assert(
      _getAntigravityPaceStateForTest('root-session-uuid') === undefined,
      'main-thread session must not be tracked',
    )
  })

  await test('abort during the pace wait unblocks promptly', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(5_000)
    await paceAntigravityAgentRequest('tau-agent-abc')
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 20)
    const start = Date.now()
    await paceAntigravityAgentRequest('tau-agent-abc', ctrl.signal)
    const waited = Date.now() - start
    assert(waited < 1_000, `abort must unblock the wait, waited=${waited}ms`)
  })

  await test('TAU_ANTIGRAVITY_NO_PACING=1 disables pacing', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    process.env.TAU_ANTIGRAVITY_NO_PACING = '1'
    try {
      await paceAntigravityAgentRequest('tau-agent-abc')
      const start = Date.now()
      await paceAntigravityAgentRequest('tau-agent-abc')
      assert(Date.now() - start < 25, 'env override must disable pacing')
    } finally {
      delete process.env.TAU_ANTIGRAVITY_NO_PACING
    }
  })

  await test('pacing is OFF by default (no TAU_ANTIGRAVITY_MAX_CACHE)', async () => {
    delete process.env.TAU_ANTIGRAVITY_MAX_CACHE
    try {
      _resetAntigravityCacheStateForTest()
      _setAntigravityCommitWindowForTest(60)
      await paceAntigravityAgentRequest('tau-agent-abc')
      const start = Date.now()
      await paceAntigravityAgentRequest('tau-agent-abc')
      assert(Date.now() - start < 25, 'agents must not be paced when the discipline is off')
    } finally {
      process.env.TAU_ANTIGRAVITY_MAX_CACHE = '1'
    }
  })

  console.log('antigravity session-start commit-window guard:')

  // Over the guard's cacheable-size gate (~90k chars ≈ 16.4k tokens).
  const BIG_PROMPT_CHARS = 120_000

  await test('guard holds the second over-minimum request by default', async () => {
    delete process.env.TAU_ANTIGRAVITY_MAX_CACHE
    try {
      _resetAntigravityCacheStateForTest()
      _setAntigravityCommitWindowForTest(60)
      await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
      const start = Date.now()
      await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
      const waited = Date.now() - start
      assert(waited >= 40, `second request must wait, waited=${waited}ms`)
    } finally {
      process.env.TAU_ANTIGRAVITY_MAX_CACHE = '1'
    }
  })

  await test('guard never holds sub-minimum prompts', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await guardAntigravityCommitWindow('main-session', undefined, 40_000)
    const start = Date.now()
    await guardAntigravityCommitWindow('main-session', undefined, 40_000)
    assert(Date.now() - start < 25, 'sub-minimum prompts must never wait')
  })

  await test('guard latches off after the first qualifying hit', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    recordAntigravityCacheRead('main-session', 9000, 10_000) // 90% coverage
    const start = Date.now()
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    assert(Date.now() - start < 25, 'hit-latched session must not wait')
  })

  await test('guard caps at two held turns per session', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(40)
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    const start = Date.now()
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    assert(Date.now() - start < 25, 'guard must cap at two held turns')
  })

  await test('a mid-session full cold re-arms the guard for the next request', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    recordAntigravityCacheRead('main-session', 30_000, 36_000) // warm, latched off
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    // Mid-session full cold on an over-minimum prompt (routing miss, TTL,
    // whatever): its replacement write commits async — next request must
    // wait it out instead of cascading a second full-price miss.
    recordAntigravityCacheRead('main-session', 0, 37_000)
    const start = Date.now()
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    const waited = Date.now() - start
    assert(waited >= 40, `request after a mid-session cold must wait, waited=${waited}ms`)
    const state = _getAntigravityPaceStateForTest('main-session')
    assert(state?.rearms === 1, `one re-arm expected, got ${state?.rearms}`)
  })

  await test('partial reads between quanta never re-arm the guard', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    recordAntigravityCacheRead('main-session', 30_000, 36_000) // warm, latched off
    recordAntigravityCacheRead('main-session', 20_000, 40_000) // 50% quantum-lag partial
    const start = Date.now()
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    assert(Date.now() - start < 25, 'a partial read is not a cold — no hold')
  })

  await test('sub-minimum colds never re-arm the guard', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    recordAntigravityCacheRead('main-session', 30_000, 36_000) // warm, latched off
    recordAntigravityCacheRead('main-session', 0, 10_000) // below 16,384 — uncommittable
    const start = Date.now()
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    assert(Date.now() - start < 25, 'sub-minimum cold must not re-arm')
  })

  await test('mid-session re-arms are bounded per session', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    for (let i = 0; i < 5; i++) {
      recordAntigravityCacheRead('main-session', 30_000, 36_000) // hit
      recordAntigravityCacheRead('main-session', 0, 37_000) // cold
    }
    const state = _getAntigravityPaceStateForTest('main-session')
    assert(state?.rearms === 4, `re-arms must cap at 4, got ${state?.rearms}`)
    assert(state?.hitSeen === true, 'past the cap the session stays latched off')
    const start = Date.now()
    await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
    assert(Date.now() - start < 25, 'past the cap no more holds')
  })

  await test('guard respects TAU_ANTIGRAVITY_NO_PACING=1', async () => {
    _resetAntigravityCacheStateForTest()
    _setAntigravityCommitWindowForTest(60)
    process.env.TAU_ANTIGRAVITY_NO_PACING = '1'
    try {
      await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
      const start = Date.now()
      await guardAntigravityCommitWindow('main-session', undefined, BIG_PROMPT_CHARS)
      assert(Date.now() - start < 25, 'env off-switch must disable the guard')
    } finally {
      delete process.env.TAU_ANTIGRAVITY_NO_PACING
    }
  })

  console.log('antigravity cache-break diagnosis:')

  await test('first request on a session is cold', () => {
    const v = diagnoseAntigravityCacheBreak(undefined, { system: 's', tools: 't', blocks: ['a'] })
    assert(v === 'cold', v)
  })

  await test('append-only growth is a clean prefix extension', () => {
    const prev = { system: 's', tools: 't', blocks: ['a', 'b'] }
    const cur = { system: 's', tools: 't', blocks: ['a', 'b', 'c', 'd'] }
    const v = diagnoseAntigravityCacheBreak(prev, cur)
    assert(v === 'ok: clean prefix extension', v)
  })

  await test('changed systemInstruction is flagged first (byte-0 break)', () => {
    const prev = { system: 's1', tools: 't', blocks: ['a'] }
    const cur = { system: 's2', tools: 't', blocks: ['a', 'b'] }
    assert(diagnoseAntigravityCacheBreak(prev, cur) === 'BREAK: systemInstruction', 'system')
  })

  await test('changed tools is flagged', () => {
    const prev = { system: 's', tools: 't1', blocks: ['a'] }
    const cur = { system: 's', tools: 't2', blocks: ['a', 'b'] }
    assert(diagnoseAntigravityCacheBreak(prev, cur) === 'BREAK: tools', 'tools')
  })

  await test('a rewritten history block names its index (the 0% multi-turn cause)', () => {
    // block 0 stable, block 1 rewritten in place, block 2 appended.
    const prev = { system: 's', tools: 't', blocks: ['a', 'b', 'c'] }
    const cur = { system: 's', tools: 't', blocks: ['a', 'B-rewritten', 'c', 'd'] }
    const v = diagnoseAntigravityCacheBreak(prev, cur)
    assert(v === 'BREAK: history block 1/3 rewritten', v)
  })

  await test('a changed leading content block is caught at index 0', () => {
    const prev = { system: 's', tools: 't', blocks: ['vol-v1', 'task'] }
    const cur = { system: 's', tools: 't', blocks: ['vol-v2', 'task', 'more'] }
    assert(diagnoseAntigravityCacheBreak(prev, cur) === 'BREAK: history block 0/2 rewritten', 'leading')
  })


  console.log('antigravity debug-snapshot keying:')
  // writeAntigravityCacheDebugEntry() appends to os.tmpdir(). Point tmpdir at a
  // throwaway directory for this suite so running the tests never touches (or
  // truncates) a real session's tau-cache-debug.jsonl.
  const _realTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  const _sandbox = mkdtempSync(join(realTmpdir(), 'tau-cache-test-'))
  process.env.TEMP = _sandbox
  process.env.TMP = _sandbox
  process.env.TMPDIR = _sandbox
  process.env.TAU_CACHE_DEBUG = '1'


  // Regression: background side-queries (quota check, session title, memory
  // extraction) reuse the ROOT sessionId but run on the cheap-tier model with
  // their own system prompt and tools. Keyed on session alone they occupied
  // the snapshot slot, so the next REAL turn diffed against a 2-token probe
  // and reported "BREAK: systemInstruction" for a cache that never broke.
  const probe = {
    systemInstruction: { parts: [{ text: 'quota-check system' }] },
    tools: [{ functionDeclarations: [] }],
    generationConfig: { maxOutputTokens: 1 },
    contents: [{ role: 'user', parts: [{ text: 'quota' }] }],
  }
  // Must clear DEBUG_MIN_CACHEABLE_CHARS (65,536) or the entry is recorded as a
  // non-participant and never diffed. 3,000 x 28 chars puts the system prompt
  // alone at ~84k, matching a real main-loop request.
  const realSystem = { parts: [{ text: '# Session-specific guidance '.repeat(3000) }] }
  const realTools = [{ functionDeclarations: [{ name: 'Read' }, { name: 'Bash' }] }]
  const turn = (n: number) => ({
    systemInstruction: realSystem,
    tools: realTools,
    generationConfig: { maxOutputTokens: 8192 },
    contents: Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `msg${i}` }],
    })),
  })

  await test('a side-query on another model does not break the next real turn', () => {
    _resetAntigravityCacheStateForTest()
    const SID = 'root-session'
    writeAntigravityCacheDebugEntry('gemini-3.5-flash-low', probe, SID)
    const v = writeAntigravityCacheDebugEntry('gemini-3.6-flash-medium', turn(1), SID)
    assert(v === 'cold', `first real turn should be cold, got: ${v}`)
  })

  await test('the real turns still extend cleanly after a side-query', () => {
    _resetAntigravityCacheStateForTest()
    const SID = 'root-session'
    writeAntigravityCacheDebugEntry('gemini-3.5-flash-low', probe, SID)
    writeAntigravityCacheDebugEntry('gemini-3.6-flash-medium', turn(1), SID)
    const v = writeAntigravityCacheDebugEntry('gemini-3.6-flash-medium', turn(3), SID)
    assert(v === 'ok: clean prefix extension', `got: ${v}`)
  })

  await test('a sub-minimum side-query is logged but never seeds the slot', () => {
    _resetAntigravityCacheStateForTest()
    const SID = 'root-session'
    // Same model as the main loop — the case the model key alone cannot fix.
    const v1 = writeAntigravityCacheDebugEntry('gemini-3.6-flash-medium', probe, SID)
    assert(v1 === 'n/a: below cache minimum', `probe verdict: ${v1}`)
    const v2 = writeAntigravityCacheDebugEntry('gemini-3.6-flash-medium', turn(1), SID)
    assert(v2 === 'cold', `real turn after same-model probe: ${v2}`)
  })

  await test('a tools break names the declaration that entered the block', () => {
    _resetAntigravityCacheStateForTest()
    const SID = 'root-session'
    const logPath = join(_sandbox, 'tau-cache-debug.jsonl')
    if (existsSync(logPath)) rmSync(logPath)
    const withTools = (names: string[]) => ({
      ...turn(1),
      tools: [{ functionDeclarations: names.map(name => ({ name, parameters: {} })) }],
    })
    writeAntigravityCacheDebugEntry('gemini-3.7-flash-high', withTools(['Read', 'Bash']), SID)
    const v = writeAntigravityCacheDebugEntry(
      'gemini-3.7-flash-high',
      withTools(['Read', 'Bash', 'WebFetch']),
      SID,
    )
    assert(v === 'BREAK: tools', `verdict: ${v}`)
    const rows = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const last = rows[rows.length - 1]
    assert(last.nTools === 3, `nTools=${last.nTools}`)
    assert(last.toolsDiff?.added?.join(',') === 'WebFetch', `added=${JSON.stringify(last.toolsDiff)}`)
    assert(last.toolsDiff.removed.length === 0, `removed=${JSON.stringify(last.toolsDiff.removed)}`)
    assert(last.toolsDiff.changed.length === 0, `changed=${JSON.stringify(last.toolsDiff.changed)}`)
  })
  await test('a genuine prefix break on the same model is still reported', () => {
    _resetAntigravityCacheStateForTest()
    const SID = 'root-session'
    writeAntigravityCacheDebugEntry('gemini-3.6-flash-medium', turn(1), SID)
    // Still well over DEBUG_MIN_CACHEABLE_CHARS — only the CONTENT differs, so
    // this is a real byte-0 prefix break rather than a non-participant.
    const churned = {
      ...turn(3),
      systemInstruction: { parts: [{ text: 'DIFFERENT SYSTEM PROMPT '.repeat(4000) }] },
    }
    const v = writeAntigravityCacheDebugEntry('gemini-3.6-flash-medium', churned, SID)
    assert(v === 'BREAK: systemInstruction', `got: ${v}`)
  })


  delete process.env.TAU_CACHE_DEBUG
  for (const [k, v] of Object.entries(_realTemp)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(_sandbox, { recursive: true, force: true })

  _resetAntigravityCacheStateForTest()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
