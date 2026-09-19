#!/usr/bin/env node
/**
 * Read-only analysis of Antigravity Gemini TAU_CACHE_DEBUG logs.
 *
 *   node scripts/analyze-antigravity-cache.mjs [log] [--since ISO] [--until ISO]
 *        [--legacy] [--cutoff TOKENS] [--json]
 *
 * The log defaults to <os tmpdir>/tau-cache-debug.jsonl, the file tau writes
 * with TAU_CACHE_DEBUG=1. This script only reads it: it never sends a request
 * or calls a model.
 *
 * Population. A completed request has a final usage row. Main-thread and agent
 * requests are analyzed; quota/count helpers and other side queries are only
 * counted. A stream is one conversation (or agent) on one model, query source,
 * account and project; each stream's first completed request is reported
 * separately from its follow-ups.
 *
 * Verdicts. Requests traced at the dispatch boundary (`dispatch` rows) are
 * judged on the final wire body, with identity and config changes kept apart
 * from prompt changes and the in-process gap and overlap. `--legacy` judges
 * every request from the pre-wrap request rows instead, the way the September
 * 2026 investigation did, so its table can be reproduced.
 *
 * The 8,192-token cutoff on the prior prompt is an analysis convention kept for
 * comparison with that investigation, not the server's minimum. Every prompt
 * band is shown as well, so results are not selected after the fact.
 */

import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_CUTOFF_TOKENS = 8192
// Blocks the implicit cache stores in; used by the severe-partial heuristic.
const CACHE_BLOCK_TOKENS = 4096
const CONTROL_ARM = 'off/baseline'
// The plan's treatment arms B, C and D. Skipped or rejected profiles and
// legacy rows are reported, never compared.
const TREATMENT_ARMS = ['minimal/baseline', 'off/keepalive', 'minimal/keepalive']
const SCREENING_FOLLOW_UPS = 100
const SCREENING_CLUSTERS = 5
const TARGET_RELATIVE_REDUCTION = 0.5
const BOOTSTRAP_ITERATIONS = 2000

// Disjoint idle-gap buckets, upper bound inclusive (seconds).
export const GAP_BUCKETS = [
  ['0-5 s', 5],
  ['>5-10 s', 10],
  ['>10-20 s', 20],
  ['>20-30 s', 30],
  ['>30-60 s', 60],
  ['>60-120 s', 120],
  ['>120-300 s', 300],
  ['>300 s', Infinity],
]

// Prior-prompt bands, upper bound exclusive (tokens).
export const PROMPT_BANDS = [
  ['<4k', 4096],
  ['4k-8k', 8192],
  ['8k-16k', 16384],
  ['16k-32k', 32768],
  ['32k-64k', 65536],
  ['64k-128k', 131072],
  ['128k+', Infinity],
]

export function gapBucket(gapMs) {
  if (typeof gapMs !== 'number' || !Number.isFinite(gapMs)) return 'unknown'
  if (gapMs < 0) return 'overlap'
  const seconds = gapMs / 1000
  return GAP_BUCKETS.find(([, max]) => seconds <= max)[0]
}

export function promptBand(tokens) {
  return PROMPT_BANDS.find(([, max]) => tokens < max)[0]
}

// Same grouping as antigravityCacheScope: every main-thread variant (and the
// SDK) is one conversation.
export function normalizeSource(querySource) {
  if (!querySource || querySource.startsWith('repl_main_thread') || querySource === 'sdk') {
    return 'conversation'
  }
  return querySource
}

export function roleOf(source) {
  if (source === 'conversation') return 'main'
  if (source.startsWith('agent:')) return 'agent'
  return 'helper'
}

// A requested keep-alive that was skipped (proxy, Bun) is its own arm: it is
// neither a treated sample nor a planned control.
function armOf(profile) {
  const skipped = profile?.transportSkipped ? ` (keepalive skipped: ${profile.transportSkipped})` : ''
  return `${profile?.trajectory ?? 'off'}/${profile?.transport ?? 'baseline'}${skipped}`
}

// ─── Parsing ─────────────────────────────────────────────────────

export function parseLog(text) {
  const rows = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row)
      else malformed++
    } catch {
      malformed++
    }
  }
  return { rows, malformed }
}

const byTs = (a, b) => Date.parse(a.ts) - Date.parse(b.ts)

/**
 * Join rows into logical requests on run + request id. Legacy rows have no run
 * id; their request ids are random UUIDs and still join exactly.
 */
export function buildRequests(rows) {
  const runs = new Map()
  const requests = new Map()
  const requestFor = row => {
    const key = `${row.runId ?? ''}|${row.requestId}`
    let request = requests.get(key)
    if (!request) {
      request = { key, runId: row.runId, requestId: row.requestId, dispatches: [], attempts: [], usageRows: [] }
      requests.set(key, request)
    }
    return request
  }
  for (const row of rows) {
    if (row.kind === 'run') {
      runs.set(row.runId, row)
      continue
    }
    if (typeof row.requestId !== 'string' || !row.requestId) continue
    if (row.kind === undefined) {
      requestFor(row).requestRow ??= row
    } else if (row.kind === 'usage') {
      // Only completed-response usage counts; a provisional row is not a miss.
      if (row.final !== false) requestFor(row).usageRows.push(row)
    } else if (row.kind === 'dispatch') {
      requestFor(row).dispatches.push(row)
    } else if (row.kind === 'attempt') {
      requestFor(row).attempts.push(row)
    }
  }

  const list = []
  for (const request of requests.values()) {
    request.dispatches.sort(byTs)
    request.attempts.sort(byTs)
    request.usageRows.sort(byTs)
    // A logical generation counts once, however many final rows it logged.
    request.usage = request.usageRows.at(-1)
    request.duplicateUsageRows = Math.max(0, request.usageRows.length - 1)
    const first = request.requestRow ?? request.dispatches[0] ?? request.usage ?? request.attempts[0]
    request.sessionId = first.sessionId
    request.querySource = first.querySource
    request.model = first.model
    request.source = normalizeSource(request.querySource)
    request.role = roleOf(request.source)
    request.servedAttempt = request.attempts.filter(a => a.outcome === 'completed').at(-1)
    request.servedDispatch = request.servedAttempt
      ? request.dispatches.find(d => d.attemptId === request.servedAttempt.attemptId)
      : undefined
    const reference = request.servedDispatch ?? request.dispatches.at(-1)
    request.traced = request.dispatches.length > 0
    request.account = reference?.account
    request.project = reference?.project
    request.arm = reference ? armOf(reference.profile) : 'legacy'
    request.orderMs = Date.parse((request.dispatches[0] ?? request.requestRow ?? request.usage ?? request.attempts[0]).ts)
    request.completed = !!request.usage && request.usage.prompt > 0
    list.push(request)
  }
  list.sort((a, b) => a.orderMs - b.orderMs)
  return { requests: list, runs }
}

// ─── Classification ──────────────────────────────────────────────

function streamKeyOf(request) {
  return JSON.stringify([
    request.account ?? '',
    request.project ?? '',
    request.sessionId ?? '',
    request.source,
    request.model ?? '',
  ])
}

/**
 * Classify every completed request against the previous completed request of
 * its stream. Categories:
 *   first            first completed request of the stream in the window
 *   boundary         new process or reset: nothing in-process to compare with
 *   prefix-change    the prompt was rewritten or truncated
 *   identity-change  model, project, account, session id or labels changed
 *   config-change    generationConfig or another body field changed
 *   stable           the prompt extends the previous one unchanged
 *   unknown-verdict  no usable verdict was logged
 */
export function classifyRequests(requests, { legacy = false } = {}) {
  const streams = new Map()
  for (const request of requests) {
    const key = streamKeyOf(request)
    const list = streams.get(key) ?? []
    list.push(request)
    streams.set(key, list)
  }
  const followUps = []
  for (const [streamKey, list] of streams) {
    let previous
    for (const request of list) {
      if (!request.completed) continue
      const wire = !legacy && request.servedDispatch ? request.servedDispatch : undefined
      const verdict = wire ? wire.verdict : request.requestRow?.break
      let category
      if (!previous) category = 'first'
      else if (verdict === 'cold' || (request.runId && previous.runId && request.runId !== previous.runId)) category = 'boundary'
      else if (typeof verdict !== 'string' || verdict.startsWith('n/a')) category = 'unknown-verdict'
      else if (verdict.startsWith('BREAK')) category = 'prefix-change'
      else if (wire?.identityChanges?.length) category = 'identity-change'
      else if (wire?.configChanges?.length) category = 'config-change'
      else if (verdict.startsWith('ok')) category = 'stable'
      else category = 'unknown-verdict'

      const usage = request.usage
      const cached = usage.cacheRead
      let gapMs
      let overlap = false
      if (previous) {
        if (wire) {
          gapMs = wire.gapMs
          overlap = (wire.streamInflight ?? 0) > 0
        } else {
          // Legacy rows: request creation (before pacing) to the previous
          // usage row, the approximation the earlier investigation used.
          gapMs = Date.parse(request.requestRow?.ts ?? usage.ts) - Date.parse(previous.usage.ts)
          overlap = gapMs < 0
        }
      }
      const prevPrompt = previous?.usage.prompt
      const hostChanged = !!wire && ((wire.hop ?? 0) > 0
        || (!!previous?.servedDispatch && previous.servedDispatch.origin !== wire.origin))
      followUps.push({
        request,
        streamKey,
        category,
        verdict,
        prompt: usage.prompt,
        cached,
        cacheField: usage.cacheField ?? (request.traced ? undefined : 'legacy'),
        prevPrompt,
        gapMs,
        gapBucket: overlap ? 'overlap' : gapBucket(gapMs),
        gapApproximate: !wire,
        hostChanged,
        connection: request.servedAttempt?.connection,
        inflight: wire?.inflight,
        latency: request.servedAttempt
          ? {
            headersMs: request.servedAttempt.headersMs,
            firstContentMs: request.servedAttempt.firstContentMs,
            totalMs: request.servedAttempt.totalMs,
          }
          : undefined,
        wireVerdictDisagrees: !!wire && typeof request.requestRow?.break === 'string'
          && request.requestRow.break.startsWith('ok') !== wire.verdict.startsWith('ok')
          && request.requestRow.break !== 'cold' && wire.verdict !== 'cold',
      })
      previous = request
    }
  }
  return followUps
}

// ─── Metrics ─────────────────────────────────────────────────────

function emptyTotals() {
  return { n: 0, input: 0, cached: 0, cold: 0, severePartial: 0, inferredZero: 0 }
}

function addTo(totals, followUp) {
  totals.n++
  totals.input += followUp.prompt
  totals.cached += followUp.cached
  if (followUp.cached === 0) {
    totals.cold++
    if (followUp.cacheField === 'omitted') totals.inferredZero++
  } else if (followUp.prevPrompt !== undefined
    && followUp.cached < 0.5 * Math.max(followUp.prevPrompt - CACHE_BLOCK_TOKENS, 0)) {
    totals.severePartial++
  }
  return totals
}

function tally(followUps, keyOf) {
  const out = {}
  for (const followUp of followUps) {
    const key = keyOf(followUp)
    if (key === undefined) continue
    addTo(out[key] ??= emptyTotals(), followUp)
  }
  return out
}

function quantile(sorted, q) {
  if (sorted.length === 0) return undefined
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[index]
}

function distribution(values) {
  const sorted = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  return { n: sorted.length, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) }
}

// Deterministic PRNG so the same log always gives the same interval.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Cluster bootstrap of control-minus-treatment full-cold rate. Clusters are
 * tau runs where available (a conversation and its agents share one), else
 * streams, so requests from one conversation are resampled together.
 */
export function clusterBootstrapDifference(control, treatment, seed = 0x5eed) {
  const random = mulberry32(seed)
  const resample = clusters => {
    let n = 0
    let cold = 0
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]
      n += cluster.n
      cold += cluster.cold
    }
    return { n, cold }
  }
  const diffs = []
  for (let i = 0; i < BOOTSTRAP_ITERATIONS; i++) {
    const c = resample(control)
    const t = resample(treatment)
    if (c.n > 0 && t.n > 0) diffs.push(c.cold / c.n - t.cold / t.n)
  }
  diffs.sort((a, b) => a - b)
  return { low: quantile(diffs, 0.025), high: quantile(diffs, 0.975) }
}

function clustersOf(followUps) {
  const clusters = new Map()
  for (const followUp of followUps) {
    const key = followUp.request.runId ?? followUp.streamKey
    const cluster = clusters.get(key) ?? { n: 0, cold: 0 }
    cluster.n++
    if (followUp.cached === 0) cluster.cold++
    clusters.set(key, cluster)
  }
  return [...clusters.values()]
}

function compareArms(primaryByArm) {
  const control = primaryByArm[CONTROL_ARM]
  const comparisons = []
  for (const [arm, followUps] of Object.entries(primaryByArm)) {
    if (!control || !TREATMENT_ARMS.includes(arm)) continue
    const c = clustersOf(control)
    const t = clustersOf(followUps)
    const cn = control.length
    const tn = followUps.length
    const cRate = control.filter(f => f.cached === 0).length / cn
    const tRate = followUps.filter(f => f.cached === 0).length / tn
    const interval = clusterBootstrapDifference(c, t)
    const screened = cn >= SCREENING_FOLLOW_UPS && tn >= SCREENING_FOLLOW_UPS
      && c.length >= SCREENING_CLUSTERS && t.length >= SCREENING_CLUSTERS
    const relativeReduction = cRate > 0 ? (cRate - tRate) / cRate : undefined
    let reading
    if (!screened) reading = 'insufficient data (below the screening checkpoint)'
    else if (interval.low === undefined) reading = 'inconclusive'
    else if (interval.low > 0) {
      reading = relativeReduction !== undefined && relativeReduction >= TARGET_RELATIVE_REDUCTION
        ? 'interval favors the treatment and meets the 50% reduction target'
        : 'interval favors the treatment, below the 50% reduction target'
    } else if (interval.high < 0) reading = 'interval favors the control'
    else reading = 'inconclusive (interval includes zero)'
    comparisons.push({
      control: CONTROL_ARM,
      treatment: arm,
      control_n: cn,
      treatment_n: tn,
      control_clusters: c.length,
      treatment_clusters: t.length,
      control_cold_rate: cRate,
      treatment_cold_rate: tRate,
      difference: cRate - tRate,
      interval95: interval,
      relativeReduction,
      screened,
      reading,
    })
  }
  return comparisons
}

function reliabilityOf(requests) {
  const outcomes = {}
  let attempts = 0
  let retried = 0
  let hops = 0
  let failed = 0
  let unknownUsage = 0
  let completed = 0
  let duplicateUsageRows = 0
  let untracedWithoutUsage = 0
  for (const request of requests) {
    duplicateUsageRows += request.duplicateUsageRows
    if (request.completed) completed++
    for (const attempt of request.attempts) {
      attempts++
      outcomes[attempt.outcome] = (outcomes[attempt.outcome] ?? 0) + 1
    }
    if (request.dispatches.length > 1) retried++
    hops += request.dispatches.filter(d => (d.hop ?? 0) > 0).length
    if (!request.completed) {
      if (request.servedAttempt) unknownUsage++
      else if (request.attempts.length > 0) failed++
      else untracedWithoutUsage++
    }
  }
  return {
    logicalRequests: requests.length,
    completed,
    failedOrAborted: failed,
    completedWithoutUsage: unknownUsage,
    legacyWithoutUsage: untracedWithoutUsage,
    duplicateUsageRows,
    attempts,
    attemptOutcomes: outcomes,
    retriedRequests: retried,
    hopDispatches: hops,
  }
}

/** Analyze parsed rows. Pure: the same rows always give the same result. */
export function analyze(rows, options = {}) {
  const cutoff = options.cutoff ?? DEFAULT_CUTOFF_TOKENS
  const since = options.since ? Date.parse(options.since) : -Infinity
  const until = options.until ? Date.parse(options.until) : Infinity
  const { requests: all, runs } = buildRequests(rows)
  const inWindow = all.filter(r => r.orderMs >= since && r.orderMs < until)
  const studied = inWindow.filter(r => r.role !== 'helper')
  const helpers = inWindow.filter(r => r.role === 'helper')
  const followUps = classifyRequests(studied, { legacy: !!options.legacy })

  const table = {}
  for (const followUp of followUps) {
    const key = followUp.category === 'stable'
      ? (followUp.cached > 0 ? 'stable-positive' : 'stable-zero')
      : followUp.category
    addTo(table[key] ??= emptyTotals(), followUp)
  }
  const totals = followUps.reduce((acc, f) => addTo(acc, f), emptyTotals())

  const stable = followUps.filter(f => f.category === 'stable')
  const primary = stable.filter(f => f.prevPrompt !== undefined && f.prevPrompt >= cutoff)
  const primaryByArm = {}
  for (const followUp of primary) (primaryByArm[followUp.request.arm] ??= []).push(followUp)

  const arms = {}
  for (const arm of new Set(followUps.map(f => f.request.arm))) {
    const armFollowUps = followUps.filter(f => f.request.arm === arm)
    const armPrimary = primaryByArm[arm] ?? []
    const armRequests = studied.filter(r => r.arm === arm)
    arms[arm] = {
      conversations: new Set(armPrimary.map(f => f.request.runId ?? f.streamKey)).size,
      primary: armPrimary.reduce((acc, f) => addTo(acc, f), emptyTotals()),
      allCompleted: armFollowUps.reduce((acc, f) => addTo(acc, f), emptyTotals()),
      byRole: tally(armPrimary, f => f.request.role),
      byGap: tally(armPrimary, f => f.gapBucket),
      byPromptBand: tally(stable.filter(f => f.request.arm === arm && f.prevPrompt !== undefined), f => promptBand(f.prevPrompt)),
      byConnection: tally(armPrimary, f => f.connection
        ? (f.connection.observed ? f.connection.reuse : 'unobserved')
        : undefined),
      byConcurrency: tally(armPrimary, f => f.inflight === undefined ? undefined : f.inflight > 0 ? 'other requests in flight' : 'alone'),
      byHost: tally(armPrimary, f => f.gapApproximate ? undefined : f.hostChanged ? 'host changed' : 'same host'),
      latency: {
        headersMs: distribution(armPrimary.map(f => f.latency?.headersMs)),
        firstContentMs: distribution(armPrimary.map(f => f.latency?.firstContentMs)),
        totalMs: distribution(armPrimary.map(f => f.latency?.totalMs)),
      },
      reliability: reliabilityOf(armRequests),
    }
  }

  // Why follow-ups read nothing: the question each experiment must answer.
  const coldExplained = {}
  for (const followUp of followUps) {
    if (followUp.category === 'first' || followUp.cached !== 0) continue
    const reason = followUp.category !== 'stable'
      ? followUp.category
      : followUp.hostChanged
        ? 'stable prefix, host changed'
        : followUp.gapApproximate
          ? 'stable prefix (legacy row, transport unknown)'
          : 'stable prefix, unexplained'
    coldExplained[reason] = (coldExplained[reason] ?? 0) + 1
  }

  const armRuns = {}
  for (const request of studied) {
    const run = request.runId ? runs.get(request.runId) : undefined
    if (!run) continue
    const set = armRuns[request.arm] ??= new Map()
    set.set(run.runId, { build: run.build, flags: run.flags })
  }

  return {
    options: { cutoff, since: options.since, until: options.until, legacy: !!options.legacy },
    requests: {
      inWindow: inWindow.length,
      studied: studied.length,
      completedStudied: studied.filter(r => r.completed).length,
      helpers: helpers.length,
      helperSources: [...new Set(helpers.map(r => r.source))].sort(),
      traced: studied.filter(r => r.traced).length,
    },
    streams: new Set(followUps.map(f => f.streamKey)).size,
    table,
    totals,
    arms,
    comparisons: compareArms(primaryByArm),
    mixedProfileStreams: countMixedProfileStreams(followUps),
    coldExplained,
    wireVerdictDisagreements: followUps.filter(f => f.wireVerdictDisagrees).length,
    runsByArm: Object.fromEntries(Object.entries(armRuns).map(([arm, map]) => [arm, [...map.values()]])),
  }
}

function countMixedProfileStreams(followUps) {
  const armsByStream = new Map()
  for (const followUp of followUps) {
    const set = armsByStream.get(followUp.streamKey) ?? new Set()
    set.add(followUp.request.arm)
    armsByStream.set(followUp.streamKey, set)
  }
  return [...armsByStream.values()].filter(set => set.size > 1).length
}

// ─── Report ──────────────────────────────────────────────────────

const fmtInt = n => (n ?? 0).toLocaleString('en-US')
const pct = (num, den) => den > 0 ? `${fmtInt(num)}/${fmtInt(den)} (${((100 * num) / den).toFixed(1)}%)` : `${fmtInt(num)}/0 (n/a)`
const ms = value => value === undefined ? '-' : `${(value / 1000).toFixed(1)} s`

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)))
  const line = cells => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ')
  return [line(headers), widths.map(w => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}

const CATEGORY_LABELS = [
  ['first', 'First observed request per stream'],
  ['stable-positive', 'Stable-prefix follow-up, positive cache'],
  ['stable-zero', 'Stable-prefix follow-up, zero cache'],
  ['prefix-change', 'Detected prefix changes'],
  ['identity-change', 'Identity changes (model/project/session/labels)'],
  ['config-change', 'Config changes (generationConfig/other fields)'],
  ['boundary', 'Resume or reset boundaries'],
  ['unknown-verdict', 'No usable verdict'],
]

function totalsRow(label, t) {
  return [label, fmtInt(t.n), fmtInt(t.input), fmtInt(t.cached)]
}

function splitTable(title, split, order) {
  const keys = order ? order.filter(k => split[k]) : Object.keys(split).sort()
  if (keys.length === 0) return `${title}: no data`
  return `${title}\n` + table(
    ['bucket', 'full-cold', 'severe partial', 'coverage'],
    keys.map(k => {
      const t = split[k]
      return [k, pct(t.cold, t.n), pct(t.severePartial, t.n), pct(t.cached, t.input)]
    }),
  )
}

export function formatReport(result, file) {
  const out = []
  const r = result.requests
  out.push(`Antigravity Gemini cache analysis${file ? ` of ${file}` : ''}`)
  out.push(`Mode: ${result.options.legacy ? 'legacy (pre-wrap request rows)' : 'final-wire rows where traced, legacy rows otherwise'}; prior-prompt cutoff ${fmtInt(result.options.cutoff)} tokens (analysis convention, not a server minimum)`)
  if (result.options.since || result.options.until) out.push(`Window: ${result.options.since ?? 'start'} .. ${result.options.until ?? 'end'}`)
  out.push(`Requests: ${fmtInt(r.studied)} main/agent (${fmtInt(r.completedStudied)} completed, ${fmtInt(r.traced)} traced at dispatch) in ${fmtInt(result.streams)} streams; ${fmtInt(r.helpers)} helper requests excluded${r.helperSources.length ? ` (${r.helperSources.join(', ')})` : ''}`)
  out.push('')
  out.push('Completed main/agent requests')
  out.push(table(
    ['category', 'requests', 'input tokens', 'cached tokens'],
    [
      ...CATEGORY_LABELS.filter(([key]) => result.table[key]).map(([key, label]) => totalsRow(label, result.table[key])),
      totalsRow('Total', result.totals),
    ],
  ))
  const stableN = (result.table['stable-positive']?.n ?? 0) + (result.table['stable-zero']?.n ?? 0)
  out.push(`Cached-token coverage: ${pct(result.totals.cached, result.totals.input)}. Zero-cache stable follow-ups: ${pct(result.table['stable-zero']?.n ?? 0, stableN)} (all prompt sizes).`)
  const uncachedAll = result.totals.input - result.totals.cached
  const zero = result.table['stable-zero']
  if (zero && uncachedAll > 0) out.push(`Uncached input from zero-cache stable follow-ups: ${pct(zero.input, uncachedAll)} of all uncached input.`)
  out.push('')

  for (const [arm, a] of Object.entries(result.arms)) {
    const p = a.primary
    out.push(`== Arm ${arm}${arm === 'legacy' ? ' (historical rows, not a contemporaneous control)' : ''}`)
    out.push(`Primary population: stable follow-ups with prior prompt >= ${fmtInt(result.options.cutoff)} tokens, ${fmtInt(a.conversations)} clusters`)
    out.push(`  full-cold rate      ${pct(p.cold, p.n)}${p.inferredZero ? `, ${fmtInt(p.inferredZero)} inferred from an omitted count` : ''}`)
    out.push(`  severe partial      ${pct(p.severePartial, p.n)} (read < 0.5 x (prior prompt - 4096); heuristic, not a server rule)`)
    out.push(`  coverage            ${pct(p.cached, p.input)}`)
    out.push(`  uncached / request  ${p.n ? fmtInt(Math.round((p.input - p.cached) / p.n)) : '-'} tokens`)
    out.push(`  all completed       coverage ${pct(a.allCompleted.cached, a.allCompleted.input)}, full-cold ${pct(a.allCompleted.cold, a.allCompleted.n)}`)
    if (a.latency.totalMs.n > 0) {
      out.push(`  latency p50/p90     headers ${ms(a.latency.headersMs.p50)}/${ms(a.latency.headersMs.p90)}, first content ${ms(a.latency.firstContentMs.p50)}/${ms(a.latency.firstContentMs.p90)}, total ${ms(a.latency.totalMs.p50)}/${ms(a.latency.totalMs.p90)}`)
    }
    const rel = a.reliability
    out.push(`  reliability         ${fmtInt(rel.logicalRequests)} logical requests, ${fmtInt(rel.completed)} completed, ${fmtInt(rel.failedOrAborted)} failed/aborted, ${fmtInt(rel.completedWithoutUsage)} completed without usage (unknown), ${fmtInt(rel.retriedRequests)} with >1 dispatch, ${fmtInt(rel.hopDispatches)} hop dispatches`)
    if (rel.attempts > 0) out.push(`  attempt outcomes    ${Object.entries(rel.attemptOutcomes).map(([k, v]) => `${k} ${fmtInt(v)}`).join(', ')}`)
    if (rel.duplicateUsageRows) out.push(`  duplicate usage     ${fmtInt(rel.duplicateUsageRows)} extra final rows ignored`)
    out.push(splitTable('  by role', a.byRole, ['main', 'agent']))
    out.push(splitTable('  by idle gap (previous completed response -> dispatch)', a.byGap, [...GAP_BUCKETS.map(([label]) => label), 'overlap', 'unknown']))
    out.push(splitTable('  by prior prompt band (all stable follow-ups)', a.byPromptBand, PROMPT_BANDS.map(([label]) => label)))
    if (Object.keys(a.byConnection).length) out.push(splitTable('  by connection', a.byConnection, ['new', 'reused', 'unknown', 'unobserved']))
    if (Object.keys(a.byConcurrency).length) out.push(splitTable('  by concurrency', a.byConcurrency))
    if (Object.keys(a.byHost).length) out.push(splitTable('  by host', a.byHost))
    const runs = result.runsByArm[arm]
    if (runs?.length) {
      const builds = [...new Set(runs.map(run => run.build))]
      const flagSets = [...new Set(runs.map(run => JSON.stringify(run.flags ?? {})))]
      out.push(`  runs                ${fmtInt(runs.length)}; builds ${builds.join(', ')}; flag sets ${flagSets.join(' | ')}`)
    }
    out.push('')
  }

  if (Object.keys(result.coldExplained).length) {
    out.push('Zero-cache follow-ups by explanation')
    for (const [reason, n] of Object.entries(result.coldExplained).sort((a, b) => b[1] - a[1])) out.push(`  ${reason.padEnd(48)} ${fmtInt(n)}`)
    out.push('')
  }
  if (result.comparisons.length) {
    out.push('Arm comparison on the primary population (control minus treatment full-cold rate, 95% cluster bootstrap)')
    for (const c of result.comparisons) {
      const iv = c.interval95
      out.push(`  ${c.control} vs ${c.treatment}: ${(100 * c.control_cold_rate).toFixed(1)}% (n=${c.control_n}, ${c.control_clusters} clusters) vs ${(100 * c.treatment_cold_rate).toFixed(1)}% (n=${c.treatment_n}, ${c.treatment_clusters} clusters); difference ${(100 * c.difference).toFixed(1)} pts [${iv.low === undefined ? '-' : (100 * iv.low).toFixed(1)}, ${iv.high === undefined ? '-' : (100 * iv.high).toFixed(1)}]; relative reduction ${c.relativeReduction === undefined ? '-' : `${(100 * c.relativeReduction).toFixed(0)}%`}: ${c.reading}`)
    }
    out.push('')
  }
  if (result.mixedProfileStreams) out.push(`Warning: ${result.mixedProfileStreams} stream(s) changed experiment profile mid-stream; they mix arms.`)
  if (result.wireVerdictDisagreements) out.push(`Note: ${result.wireVerdictDisagreements} request(s) where the pre-wrap verdict and the final-wire verdict disagree.`)
  return out.join('\n')
}

// ─── CLI ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { file: join(tmpdir(), 'tau-cache-debug.jsonl') }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--since') options.since = argv[++i]
    else if (arg === '--until') options.until = argv[++i]
    else if (arg === '--cutoff') options.cutoff = Number(argv[++i])
    else if (arg === '--legacy') options.legacy = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (!arg.startsWith('--')) options.file = arg
    else throw new Error(`Unknown option ${arg}`)
  }
  for (const key of ['since', 'until']) {
    if (options[key] !== undefined && Number.isNaN(Date.parse(options[key]))) throw new Error(`--${key} needs an ISO date`)
  }
  if (options.cutoff !== undefined && !(options.cutoff >= 0)) throw new Error('--cutoff needs a token count')
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/analyze-antigravity-cache.mjs [log] [--since ISO] [--until ISO] [--legacy] [--cutoff TOKENS] [--json]')
    return
  }
  const { rows, malformed } = parseLog(readFileSync(options.file, 'utf8'))
  const result = analyze(rows, options)
  if (options.json) {
    console.log(JSON.stringify({ file: options.file, malformedLines: malformed, ...result }, null, 2))
    return
  }
  console.log(formatReport(result, options.file))
  if (malformed) console.log(`Skipped ${malformed} malformed line(s).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
