/**
 * Account-level quota cache tests.
 *
 * Run: bun run src/services/api/providerQuotaCache.test.ts
 */

import {
  _classifyReport,
  _noteOutcome,
  _retryDelay,
  _shouldFetch,
  getProviderQuotaOutcome,
  providerHasAccountQuota,
  resetProviderQuotaCache,
} from './providerQuotaCache.js'
import { hasProviderUsageReporter } from './providerUsageCoverage.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  resetProviderQuotaCache()
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const report = (status: string, metrics?: Array<Record<string, unknown>>) =>
  ({ status, ...(metrics && { metrics }) }) as any

const MINUTE = 60_000

console.log('provider quota cache:')

// ─── coverage ────────────────────────────────────────────────────────

test('covers the providers that publish an account balance', () => {
  for (const provider of [
    'openrouter',
    'deepseek',
    'openai',
    'firstParty',
    'kiro',
    'moonshot',
    'minimax',
    'glm',
  ]) {
    assert(
      providerHasAccountQuota(provider),
      `${provider} should have an account reporter`,
    )
  }
})

test('excludes local providers, which have no account to query', () => {
  for (const provider of ['ollama', 'lmstudio']) {
    assert(
      !providerHasAccountQuota(provider),
      `${provider} runs locally and has no account quota`,
    )
  }
})

test('includes antigravity, via its read-only status reporter', () => {
  assert(
    providerHasAccountQuota('antigravity'),
    'antigravity quota is now available to the bar',
  )
})

test('refreshes antigravity faster than a credit balance', () => {
  const now = Date.now()
  const reading = { kind: 'reading', usedPercent: 40, summary: null, label: null } as const

  _noteOutcome('antigravity', reading, now)
  _noteOutcome('deepseek', reading, now)

  // Its pool moves within a session, so it refreshes faster than a balance.
  assert(_shouldFetch('deepseek', now + 2 * MINUTE) === false, 'deepseek holds at 2min')
  assert(_shouldFetch('antigravity', now + 4 * MINUTE) === true, 'antigravity refetches at 3min')
  assert(_shouldFetch('deepseek', now + 6 * MINUTE) === true, 'deepseek refetches at 5min')
})

test('reports no account quota for a provider with no reporter', () => {
  assert(
    !providerHasAccountQuota('not-a-provider'),
    'an unknown provider cannot be fetched',
  )
  assert(
    !hasProviderUsageReporter('not-a-provider'),
    'and it has no /usage reporter either',
  )
})

// ─── classification ──────────────────────────────────────────────────

test('classifies a failed lookup as transient, never as an answer', () => {
  assert(
    _classifyReport(report('error')) === null,
    'an errored report must not settle into an outcome',
  )
})

test('classifies a reachable provider with no metrics as absent', () => {
  // MiMo's shape: connected, but it publishes no quota API at all.
  assert(
    _classifyReport(report('connected'))?.kind === 'absent',
    'connected with no metrics is a genuine absence',
  )
  assert(
    _classifyReport(report('unsupported'))?.kind === 'absent',
    'unsupported is an absence',
  )
})

test('classifies a missing credential as unconfigured, not absent', () => {
  assert(
    _classifyReport(report('not_configured'))?.kind === 'unconfigured',
    'a missing key is user-fixable and distinct from having no quota API',
  )
})

test('prefers the session window over the larger weekly one', () => {
  const outcome = _classifyReport(
    report('ok', [
      { label: 'Current session', usedPercent: 12 },
      { label: 'Current week (all models)', usedPercent: 58 },
      { label: 'Current week (Opus only)', usedPercent: 71 },
    ]),
  )
  assert(outcome?.kind === 'reading', 'metrics should produce a reading')
  assert(
    outcome.usedPercent === 12,
    `expected the session window, got ${outcome.usedPercent}`,
  )
})

test('falls back to the metric nearest its ceiling', () => {
  const outcome = _classifyReport(
    report('ok', [
      { label: 'Credits', usedPercent: 30 },
      { label: 'Requests', usedPercent: 82 },
    ]),
  )
  assert(outcome?.kind === 'reading' && outcome.usedPercent === 82, 'worst wins')
})

test('reports a balance that has no percentage', () => {
  const outcome = _classifyReport(
    report('ok', [{ label: 'USD balance', summary: '$12.34 remaining' }]),
  )
  assert(outcome?.kind === 'reading', 'an amount is still a reading')
  assert(outcome.usedPercent === null, 'a balance has no proportion')
  assert(outcome.summary === '$12.34 remaining', 'the amount should survive')
})

test('prefers a percentage over a bare summary when both exist', () => {
  const outcome = _classifyReport(
    report('ok', [
      { label: 'USD balance', summary: '$12.34 remaining' },
      { label: 'Credits', usedPercent: 40 },
    ]),
  )
  assert(outcome?.kind === 'reading' && outcome.usedPercent === 40, 'measurable wins')
})

test('reports whole percentages, never a float tail', () => {
  // Antigravity derives usedPercent from remainingFraction and lands on
  // values like 61.775999999999996.
  const outcome = _classifyReport(
    report('ok', [{ label: 'Gemini 3 Flash', usedPercent: 61.775999999999996 }]),
  )
  assert(outcome?.kind === 'reading', 'should be a reading')
  assert(outcome.usedPercent === 62, `expected 62, got ${outcome.usedPercent}`)
  assert(Number.isInteger(outcome.usedPercent), 'must be a whole number')
})

test('clamps an out-of-range percentage', () => {
  const outcome = _classifyReport(report('ok', [{ label: 'C', usedPercent: 140 }]))
  assert(outcome?.kind === 'reading' && outcome.usedPercent === 100, 'clamps to 100')
})

// ─── the window shown must follow the model in use ───────────────────

const ANTIGRAVITY_POOLS = report('ok', [
  { label: 'Claude Sonnet 4.6 (Thinking)', usedPercent: 0 },
  { label: 'Claude Opus 4.6 (Thinking)', usedPercent: 0 },
  { label: 'Gemini 3 Flash', usedPercent: 71 },
  { label: 'Gemini 3.1 Pro (High)', usedPercent: 71 },
])

test('shows the pool belonging to the active model, not the tightest one', () => {
  _noteOutcome('antigravity', _classifyReport(ANTIGRAVITY_POOLS)!)

  // Antigravity meters Claude and Gemini separately. Running Claude at 0%
  // must not be told it is 71% spent because the Gemini pool is.
  const onClaude = getProviderQuotaOutcome('antigravity', 'claude-sonnet-4-6')
  assert(onClaude?.kind === 'reading', 'should still be a reading')
  assert(onClaude.usedPercent === 0, `expected the Claude pool, got ${onClaude.usedPercent}`)

  const onGemini = getProviderQuotaOutcome('antigravity', 'gemini-3-flash')
  assert(
    onGemini?.kind === 'reading' && onGemini.usedPercent === 71,
    'a Gemini session should see the Gemini pool',
  )
})

test('falls back to the tightest pool when no window matches the model', () => {
  _noteOutcome('antigravity', _classifyReport(ANTIGRAVITY_POOLS)!)
  const unknown = getProviderQuotaOutcome('antigravity', 'some-unlisted-model')
  assert(
    unknown?.kind === 'reading' && unknown.usedPercent === 71,
    'an unmatched model keeps the worst-window default',
  )
})

test('matches model ids to labels across punctuation and case', () => {
  _noteOutcome('antigravity', _classifyReport(ANTIGRAVITY_POOLS)!)
  const outcome = getProviderQuotaOutcome('antigravity', 'CLAUDE-OPUS-4-6-THINKING')
  assert(
    outcome?.kind === 'reading' && outcome.label?.startsWith('Claude Opus'),
    `expected the Opus pool, got ${outcome?.kind === 'reading' ? outcome.label : '(none)'}`,
  )
})

// ─── the cache problem this module exists to avoid ───────────────────

test('a transient failure never overwrites a good reading', () => {
  _noteOutcome('deepseek', { kind: 'reading', usedPercent: 40, summary: null, label: 'Credits' })
  _noteOutcome('deepseek', null)
  _noteOutcome('deepseek', null)

  const outcome = getProviderQuotaOutcome('deepseek')
  assert(outcome?.kind === 'reading', 'the reading must survive the outage')
  assert(outcome.usedPercent === 40, 'and keep its value')
})

test('a transient failure with no prior reading stays pending, not n/a', () => {
  _noteOutcome('deepseek', null)
  assert(
    getProviderQuotaOutcome('deepseek') === undefined,
    'a failure must not settle into "absent" - that would render n/a',
  )
})

test('a settled absence does persist, so n/a can be shown', () => {
  _noteOutcome('mimo', { kind: 'absent' })
  assert(getProviderQuotaOutcome('mimo')?.kind === 'absent', 'absence is an answer')
})

test('a later success replaces a stale reading and clears the failure streak', () => {
  const now = Date.now()
  _noteOutcome('deepseek', { kind: 'reading', usedPercent: 40, summary: null, label: null })
  _noteOutcome('deepseek', null)
  _noteOutcome('deepseek', { kind: 'reading', usedPercent: 55, summary: null, label: null })

  assert(getProviderQuotaOutcome('deepseek')?.kind === 'reading', 'still a reading')
  assert(
    (getProviderQuotaOutcome('deepseek') as any).usedPercent === 55,
    'the newer value wins',
  )
  assert(
    _shouldFetch('deepseek', now + 10) === false,
    'a fresh success should suppress the backoff retry',
  )
})

// ─── staleness ───────────────────────────────────────────────────────

test('stops showing a reading that has gone too stale, without claiming n/a', () => {
  const longAgo = Date.now() - 31 * MINUTE
  _noteOutcome(
    'deepseek',
    { kind: 'reading', usedPercent: 40, summary: null, label: null },
    longAgo,
  )
  assert(
    getProviderQuotaOutcome('deepseek') === undefined,
    'an ancient reading should not be presented as current',
  )
})

test('an absence does not go stale, because it is not a measurement', () => {
  const longAgo = Date.now() - 10 * 60 * MINUTE
  _noteOutcome('mimo', { kind: 'absent' }, longAgo)
  assert(
    getProviderQuotaOutcome('mimo')?.kind === 'absent',
    'a provider with no quota API still has none an hour later',
  )
})

// ─── backoff: what makes "do not cache failures" safe ────────────────

test('backs off after a failure instead of retrying every render', () => {
  const now = Date.now()
  _noteOutcome('deepseek', null, now)

  assert(_shouldFetch('deepseek', now + 1_000) === false, 'no immediate retry')
  assert(_shouldFetch('deepseek', now + 31_000) === true, 'retries after 30s')
})

test('backoff grows with consecutive failures and stays capped', () => {
  assert(_retryDelay(1) === 30_000, '1st retry after 30s')
  assert(_retryDelay(2) === 60_000, '2nd after 60s')
  assert(_retryDelay(3) === 120_000, '3rd after 120s')
  assert(_retryDelay(9) === 5 * MINUTE, 'capped at the normal refresh interval')
})

test('a fresh settled outcome suppresses fetching entirely', () => {
  const now = Date.now()
  _noteOutcome('deepseek', { kind: 'reading', usedPercent: 40, summary: null, label: null }, now)
  assert(_shouldFetch('deepseek', now + MINUTE) === false, 'still fresh')
  assert(_shouldFetch('deepseek', now + 6 * MINUTE) === true, 'stale, refetch')
})

test('fetches when nothing is known yet', () => {
  assert(_shouldFetch('deepseek', Date.now()) === true, 'first look should fetch')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
