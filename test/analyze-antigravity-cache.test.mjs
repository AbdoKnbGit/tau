import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyze,
  buildRequests,
  classifyRequests,
  clusterBootstrapDifference,
  formatReport,
  gapBucket,
  parseLog,
  promptBand,
} from '../scripts/analyze-antigravity-cache.mjs'

const T0 = Date.parse('2026-09-20T10:00:00.000Z')
const at = seconds => new Date(T0 + seconds * 1000).toISOString()

// ── Legacy rows (pre-wrap request row + final usage row) ──
function legacy(id, { session = 's1', source = 'repl_main_thread', model = 'gemini-3.8-flash-medium', t, verdict, prompt, cached, doneAfter = 2 }) {
  return [
    { ts: at(t), model, sessionId: session, querySource: source, requestId: id, break: verdict },
    { ts: at(t + doneAfter), kind: 'usage', sessionId: session, model, querySource: source, requestId: id, final: true, cacheRead: cached, prompt },
  ]
}

// ── Traced rows (dispatch + attempt + usage), one run per call site ──
function traced(id, {
  run = 'run-a', session = 's1', source = 'repl_main_thread', model = 'gemini-3.8-flash-medium',
  t, verdict, prompt, cached, cacheField = 'explicit', gapMs, profile = { trajectory: 'off', transport: 'baseline' },
  identityChanges, configChanges, streamInflight = 0, inflight = 0, hop = 0, origin = 'cloudcode-pa.googleapis.com',
  outcome = 'completed', usage = true, extraDispatches = [], connection = { observed: true, reuse: 'reused', id: 'c1', priorRequests: 1, protocol: 'http/1.1' },
}) {
  const rows = []
  for (const [i, extra] of extraDispatches.entries()) {
    const attemptId = `${id}:1.${i}`
    rows.push({ ts: at(t - 1 + i * 0.1), kind: 'dispatch', runId: run, requestId: id, attemptId, attempt: 1, hop: i, sessionId: session, querySource: source, model, account: 'acct', project: 'proj', profile, origin, verdict, gapMs, streamInflight, inflight })
    rows.push({ ts: at(t - 0.9 + i * 0.1), kind: 'attempt', runId: run, requestId: id, attemptId, outcome: extra, status: extra === 'http-error' ? 503 : undefined })
  }
  const attemptId = `${id}:${extraDispatches.length ? 2 : 1}.0`
  rows.push({
    ts: at(t), kind: 'dispatch', runId: run, requestId: id, attemptId, attempt: extraDispatches.length ? 2 : 1, hop,
    sessionId: session, querySource: source, model, account: 'acct', project: 'proj', profile, origin, verdict,
    ...(identityChanges && { identityChanges }), ...(configChanges && { configChanges }),
    ...(gapMs !== undefined && { gapMs }), streamInflight, inflight,
  })
  rows.push({ ts: at(t + 2), kind: 'attempt', runId: run, requestId: id, attemptId, outcome, status: 200, headersMs: 800, firstContentMs: 900, totalMs: 2000, connection, usage: { prompt, cached, cacheField } })
  if (outcome === 'completed' && usage) {
    rows.push({ ts: at(t + 2), kind: 'usage', runId: run, sessionId: session, model, querySource: source, requestId: id, final: true, cacheRead: cached, cacheField, prompt })
  }
  return rows
}

test('gap buckets are disjoint with inclusive upper bounds', () => {
  assert.equal(gapBucket(0), '0-5 s')
  assert.equal(gapBucket(5000), '0-5 s')
  assert.equal(gapBucket(5001), '>5-10 s')
  assert.equal(gapBucket(10_000), '>5-10 s')
  assert.equal(gapBucket(300_000), '>120-300 s')
  assert.equal(gapBucket(300_001), '>300 s')
  assert.equal(gapBucket(-1), 'overlap')
  assert.equal(gapBucket(undefined), 'unknown')
  assert.equal(promptBand(8191), '4k-8k')
  assert.equal(promptBand(8192), '8k-16k')
})

test('legacy mode reproduces the category table from pre-wrap verdicts', () => {
  const rows = [
    ...legacy('a1', { t: 0, verdict: 'cold', prompt: 20_000, cached: 0 }),
    ...legacy('a2', { t: 10, verdict: 'ok: clean prefix extension', prompt: 24_000, cached: 16_384 }),
    ...legacy('a3', { t: 20, verdict: 'ok: clean prefix extension', prompt: 26_000, cached: 0 }),
    ...legacy('a4', { t: 30, verdict: 'BREAK: history block 1/6 rewritten', prompt: 27_000, cached: 4_096 }),
    // A helper is counted but never studied.
    ...legacy('q1', { t: 1, source: 'quota_check', verdict: 'cold', prompt: 10, cached: 0 }),
    // A request that never completed has no usage row.
    { ts: at(40), model: 'gemini-3.8-flash-medium', sessionId: 's1', querySource: 'repl_main_thread', requestId: 'a5', break: 'ok: clean prefix extension' },
  ]
  const result = analyze(rows, { legacy: true })
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.table).map(([k, v]) => [k, [v.n, v.input, v.cached]])),
    {
      first: [1, 20_000, 0],
      'stable-positive': [1, 24_000, 16_384],
      'stable-zero': [1, 26_000, 0],
      'prefix-change': [1, 27_000, 4_096],
    },
  )
  assert.deepEqual([result.totals.n, result.totals.input, result.totals.cached], [4, 97_000, 20_480])
  assert.equal(result.requests.helpers, 1)
  assert.equal(result.arms.legacy.reliability.legacyWithoutUsage, 1)
  // Legacy gaps: request row to the previous usage row.
  const followUps = classifyRequests(buildRequests(rows).requests.filter(r => r.role !== 'helper'), { legacy: true })
  assert.deepEqual(followUps.map(f => f.gapMs), [undefined, 8000, 8000, 8000])
  assert.match(formatReport(result), /Stable-prefix follow-up, zero cache\s+1\s+26,000\s+0/)
})

test('provisional and duplicate usage rows count once, from the final row', () => {
  const rows = [
    ...legacy('b1', { t: 0, verdict: 'cold', prompt: 20_000, cached: 0 }),
    ...legacy('b2', { t: 10, verdict: 'ok: clean prefix extension', prompt: 24_000, cached: 16_384 }),
    { ts: at(11), kind: 'usage', sessionId: 's1', model: 'gemini-3.8-flash-medium', querySource: 'repl_main_thread', requestId: 'b2', final: false, cacheRead: 0, prompt: 24_000 },
    { ts: at(12.5), kind: 'usage', sessionId: 's1', model: 'gemini-3.8-flash-medium', querySource: 'repl_main_thread', requestId: 'b2', final: true, cacheRead: 16_384, prompt: 24_000 },
  ]
  const result = analyze(rows, { legacy: true })
  assert.equal(result.totals.n, 2)
  assert.equal(result.table['stable-positive'].n, 1)
  assert.equal(result.table['stable-zero'], undefined, 'a provisional zero was counted as a miss')
  assert.equal(result.arms.legacy.reliability.duplicateUsageRows, 1)
})

test('final-wire rows separate prompt, identity, config and boundary changes', () => {
  const rows = [
    ...traced('w1', { t: 0, verdict: 'cold', prompt: 20_000, cached: 0 }),
    ...traced('w2', { t: 10, verdict: 'ok: clean prefix extension', prompt: 24_000, cached: 16_384, gapMs: 8000 }),
    ...traced('w3', { t: 20, verdict: 'ok: clean prefix extension', prompt: 26_000, cached: 0, cacheField: 'omitted', gapMs: 8000 }),
    ...traced('w4', { t: 30, verdict: 'ok: identical prompt', prompt: 26_000, cached: 20_480, gapMs: 8000, configChanges: ['generationConfig'] }),
    ...traced('w5', { t: 40, verdict: 'ok: clean prefix extension', prompt: 28_000, cached: 0, gapMs: 8000, identityChanges: ['wireSessionId'] }),
    ...traced('w6', { t: 50, verdict: 'BREAK: tools', prompt: 28_500, cached: 0, gapMs: 8000 }),
    // New process for the same conversation: a resume boundary.
    ...traced('w7', { run: 'run-b', t: 60, verdict: 'cold', prompt: 29_000, cached: 0 }),
  ]
  const result = analyze(rows)
  const counts = Object.fromEntries(Object.entries(result.table).map(([k, v]) => [k, v.n]))
  assert.deepEqual(counts, {
    first: 1,
    'stable-positive': 1,
    'stable-zero': 1,
    'config-change': 1,
    'identity-change': 1,
    'prefix-change': 1,
    boundary: 1,
  })
  const arm = result.arms['off/baseline']
  assert.equal(arm.primary.n, 2)
  assert.equal(arm.primary.cold, 1)
  assert.equal(arm.primary.inferredZero, 1, 'an omitted cached count must be reported as an inferred zero')
  assert.equal(result.coldExplained['stable prefix, unexplained'], 1)
  assert.equal(result.coldExplained['identity-change'], 1)
  assert.equal(result.coldExplained['prefix-change'], 1)
  assert.equal(result.coldExplained.boundary, 1)
  assert.deepEqual(Object.keys(arm.byGap), ['>5-10 s'])
  assert.equal(arm.latency.totalMs.p50, 2000)
})

test('retries, hops, failures and completed responses without usage are reliability, not cache results', () => {
  const rows = [
    ...traced('r1', { t: 0, verdict: 'cold', prompt: 20_000, cached: 0 }),
    // A hop then a retry before success.
    ...traced('r2', { t: 10, verdict: 'ok: clean prefix extension', prompt: 24_000, cached: 16_384, gapMs: 7000, extraDispatches: ['http-error', 'network-error'] }),
    // Aborted mid-stream: no usage.
    ...traced('r3', { t: 20, verdict: 'ok: clean prefix extension', prompt: 26_000, cached: 0, gapMs: 7000, outcome: 'aborted' }),
    // Completed at the transport but the lane logged no usage: unknown.
    ...traced('r4', { t: 30, verdict: 'ok: clean prefix extension', prompt: 26_000, cached: 0, gapMs: 7000, usage: false }),
  ]
  const result = analyze(rows)
  const rel = result.arms['off/baseline'].reliability
  assert.equal(rel.logicalRequests, 4)
  assert.equal(rel.completed, 2)
  assert.equal(rel.failedOrAborted, 1)
  assert.equal(rel.completedWithoutUsage, 1)
  assert.equal(rel.retriedRequests, 1)
  assert.equal(rel.hopDispatches, 1)
  assert.deepEqual(rel.attemptOutcomes, { completed: 3, 'http-error': 1, 'network-error': 1, aborted: 1 })
  // Only the two completed requests enter the cache table.
  assert.equal(result.totals.n, 2)
})

test('agents, models and query sources are independent streams; overlap is its own bucket', () => {
  const rows = [
    ...traced('m1', { t: 0, verdict: 'cold', prompt: 20_000, cached: 0 }),
    ...traced('g1', { t: 1, session: 'tau-agent-1', source: 'agent:builtin:general-purpose', verdict: 'cold', prompt: 30_000, cached: 0 }),
    ...traced('x1', { t: 2, model: 'gemini-3.8-flash-high', verdict: 'cold', prompt: 20_000, cached: 0 }),
    ...traced('m2', { t: 10, verdict: 'ok: clean prefix extension', prompt: 24_000, cached: 16_384, gapMs: 8000 }),
    ...traced('g2', { t: 11, session: 'tau-agent-1', source: 'agent:builtin:general-purpose', verdict: 'ok: clean prefix extension', prompt: 32_000, cached: 0, gapMs: 1000, streamInflight: 1, inflight: 2 }),
  ]
  const result = analyze(rows)
  assert.equal(result.streams, 3)
  assert.equal(result.table.first.n, 3)
  const arm = result.arms['off/baseline']
  assert.deepEqual(Object.keys(arm.byRole).sort(), ['agent', 'main'])
  assert.equal(arm.byGap.overlap.n, 1)
  assert.equal(arm.byConcurrency['other requests in flight'].n, 1)
})

test('arm comparison reports insufficient data below the screening checkpoint and a CI above it', () => {
  const small = [
    ...traced('c1', { t: 0, verdict: 'cold', prompt: 20_000, cached: 0 }),
    ...traced('c2', { t: 10, verdict: 'ok: clean prefix extension', prompt: 24_000, cached: 0, gapMs: 8000 }),
    ...traced('t1', { run: 'run-t', session: 's2', t: 0, verdict: 'cold', prompt: 20_000, cached: 0, profile: { trajectory: 'minimal', transport: 'baseline' } }),
    ...traced('t2', { run: 'run-t', session: 's2', t: 10, verdict: 'ok: clean prefix extension', prompt: 24_000, cached: 16_384, gapMs: 8000, profile: { trajectory: 'minimal', transport: 'baseline' } }),
  ]
  const [comparison] = analyze(small).comparisons
  assert.equal(comparison.treatment, 'minimal/baseline')
  assert.equal(comparison.screened, false)
  assert.match(comparison.reading, /insufficient data/)

  // 6 control clusters at 30% cold vs 6 treatment clusters at 0%.
  const clusters = rate => Array.from({ length: 6 }, () => ({ n: 20, cold: Math.round(20 * rate) }))
  const interval = clusterBootstrapDifference(clusters(0.3), clusters(0))
  assert.ok(interval.low > 0 && interval.high <= 0.31, JSON.stringify(interval))
  // Deterministic: the same clusters always give the same interval.
  assert.deepEqual(clusterBootstrapDifference(clusters(0.3), clusters(0)), interval)
})

test('parseLog skips malformed lines instead of failing', () => {
  const { rows, malformed } = parseLog('{"kind":"run","runId":"x"}\nnot json\n\n[1,2]\n')
  assert.equal(rows.length, 1)
  assert.equal(malformed, 2)
})
