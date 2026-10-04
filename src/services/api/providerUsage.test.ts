/**
 * Provider usage parser tests.
 *
 * Run: bun run src/services/api/providerUsage.test.ts
 */

import {
  parseAntigravityQuotaBuckets,
  parseAntigravityQuotaSummary,
  parseAntigravityUsage,
} from './antigravityUsageParser.js'
import {
  fireworksSummaryRange,
  parseFireworksBillingSummary,
  sumFireworksSpendSince,
} from './fireworksBillingParser.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function metricSummary(metrics: ReturnType<typeof parseAntigravityUsage>, label: string): string | undefined {
  return metrics.find(metric => metric.label === label)?.summary
}

function main(): void {
  console.log('provider usage:')

  test('shares the Antigravity Gemini quota display pool', () => {
    const metrics = parseAntigravityUsage({
      models: {
        'gemini-3.1-pro-high': {
          quotaInfo: { remainingFraction: 0.2 },
        },
        'gemini-3.1-pro-low': {
          quotaInfo: { remainingFraction: 0.6 },
        },
        'gemini-3-flash': {
          quotaInfo: { remainingFraction: 0.9 },
        },
      },
    })

    assert(
      metricSummary(metrics, 'Gemini 3.5 Flash (High)') === '20% remaining',
      '3.5 high should mirror the shared Antigravity Gemini quota',
    )
    assert(
      metricSummary(metrics, 'Gemini 3.5 Flash (Medium)') === '20% remaining',
      '3.5 medium should mirror the shared Antigravity Gemini quota',
    )
    assert(
      metricSummary(metrics, 'Gemini 3.5 Flash (Low)') === '20% remaining',
      '3.5 low should mirror the shared Antigravity Gemini quota',
    )
    assert(
      metricSummary(metrics, 'Gemini 3.1 Pro (High)') === '20% remaining',
      '3.1 high should use the shared Antigravity Gemini quota',
    )
    assert(
      metricSummary(metrics, 'Gemini 3.1 Pro (Low)') === '20% remaining',
      '3.1 low should use the shared Antigravity Gemini quota',
    )
    assert(
      metricSummary(metrics, 'Gemini 3 Flash') === '20% remaining',
      'Gemini 3 Flash should mirror the shared Antigravity Gemini quota',
    )
  })

  test('parses Antigravity app wire keys without aliasing 3.5 to 3 Flash', () => {
    const metrics = parseAntigravityUsage({
      models: {
        'gemini-3-flash': {
          displayName: 'Gemini 3 Flash',
          quotaInfo: { remainingFraction: 0.9 },
        },
        'gemini-3-flash-agent': {
          displayName: 'Gemini 3.5 Flash (High)',
          quotaInfo: { remainingFraction: 0.2 },
        },
        'gemini-3.5-flash-low': {
          displayName: 'Gemini 3.5 Flash (Medium)',
          quotaInfo: { remainingFraction: 0.2 },
        },
        'gemini-3.5-flash-extra-low': {
          displayName: 'Gemini 3.5 Flash (Low)',
          quotaInfo: { remainingFraction: 0.2 },
        },
        'claude-sonnet-4-6': {
          displayName: 'Claude Sonnet 4.6 · thinking (via Antigravity)',
          quotaInfo: { remainingFraction: 0.7 },
        },
      },
    })

    assert(
      metricSummary(metrics, 'Gemini 3.5 Flash (High)') === '20% remaining',
      '3.5 high should use the Antigravity app wire key gemini-3-flash-agent',
    )
    assert(
      metricSummary(metrics, 'Gemini 3.5 Flash (Medium)') === '20% remaining',
      '3.5 medium should use the Antigravity app wire key gemini-3.5-flash-low',
    )
    assert(
      metricSummary(metrics, 'Gemini 3.5 Flash (Low)') === '20% remaining',
      '3.5 low should use the Antigravity app wire key gemini-3.5-flash-extra-low',
    )
    assert(
      metricSummary(metrics, 'Gemini 3 Flash') === '20% remaining',
      'Gemini 3 Flash should remain a distinct row while sharing the Antigravity Gemini quota',
    )
    assert(
      !metrics.some(metric => metric.label.includes('thinking') || metric.label.includes('via Antigravity')),
      'usage labels should not include Antigravity thinking suffixes',
    )
  })

  test('shows one Antigravity row per Claude 5.5 model, keyed by every level', () => {
    // Shape of the daily host's catalog on a Google AI Pro account
    // (2026-10-04): the three levels of each model are metered together.
    const shared = { remainingFraction: 0.9533024, resetTime: '2099-01-01T00:00:00Z' }
    const metrics = parseAntigravityUsage({
      models: {
        'claude-opus-5-5-low': { displayName: 'Claude Opus 5.5 (Low)', quotaInfo: shared },
        'claude-opus-5-5-medium': { displayName: 'Claude Opus 5.5 (Medium)', quotaInfo: shared },
        'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', quotaInfo: shared },
        'claude-sonnet-5-5-low': { displayName: 'Claude Sonnet 5.5 (Low)', quotaInfo: shared },
        'claude-sonnet-5-5-medium': { displayName: 'Claude Sonnet 5.5 (Medium)', quotaInfo: shared },
        'claude-sonnet-5-5-high': { displayName: 'Claude Sonnet 5.5 (High)', quotaInfo: shared },
        'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6 (Thinking)', quotaInfo: { remainingFraction: 0.5 } },
      },
    })

    const opus = metrics.filter(metric => metric.label.startsWith('Claude Opus 5.5'))
    const sonnet = metrics.filter(metric => metric.label.startsWith('Claude Sonnet 5.5'))
    assert(opus.length === 1 && opus[0]!.label === 'Claude Opus 5.5', `opus rows: ${JSON.stringify(opus.map(m => m.label))}`)
    assert(sonnet.length === 1 && sonnet[0]!.label === 'Claude Sonnet 5.5', `sonnet rows: ${JSON.stringify(sonnet.map(m => m.label))}`)
    assert(opus[0]!.summary === '95% remaining', `opus summary ${opus[0]!.summary}`)
    assert(
      ['claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high']
        .every(id => opus[0]!.modelKeys?.includes(id)),
      `every Opus level must stay matchable: ${JSON.stringify(opus[0]!.modelKeys)}`,
    )
    assert(
      metricSummary(metrics, 'Claude Sonnet 4.6 (Thinking)') === '50% remaining',
      'Claude 4.6 keeps its own row and label',
    )
  })

  test('reads the weekly and 5-hour limits of each Antigravity model group', () => {
    // retrieveUserQuotaSummary as the daily host answered it on 2026-10-04.
    const metrics = parseAntigravityQuotaSummary({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2099-10-11T00:15:46Z', remainingFraction: 0.9989685 },
            { bucketId: 'gemini-5h', window: '5h', resetTime: '2099-10-04T13:59:15Z', remainingFraction: 0.9945082 },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', resetTime: '2099-10-10T23:04:59Z', remainingFraction: 0.7383004 },
            { bucketId: '3p-5h', window: '5h', resetTime: '2099-10-04T13:57:56Z', remainingFraction: 0.8882648 },
          ],
        },
      ],
    })

    assert(metrics.length === 4, `rows: ${JSON.stringify(metrics.map(m => m.label))}`)
    const weekly = metrics.find(m => m.label === 'Claude and GPT models · weekly limit')
    const fiveHour = metrics.find(m => m.label === 'Claude and GPT models · 5-hour session limit')
    assert(weekly?.summary === '74% remaining', `weekly: ${weekly?.summary}`)
    assert(fiveHour?.summary === '89% remaining', `5h: ${fiveHour?.summary}`)
    assert(weekly?.resetsAt === '2099-10-10T23:04:59.000Z', `weekly reset: ${weekly?.resetsAt}`)
    for (const id of ['claude-opus-5-5-high', 'claude-sonnet-5-5-low', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']) {
      assert(weekly?.modelKeys?.includes(id), `${id} belongs to the Claude and GPT group`)
    }
    assert(!weekly?.modelKeys?.some(id => id.startsWith('gemini')), 'no Gemini id in the Claude group')
    const gemini = metrics.find(m => m.label === 'Gemini Models · weekly limit')
    assert(gemini?.modelKeys?.includes('gemini-3.8-flash-high'), 'Gemini ids key the Gemini group')
    assert(!gemini?.modelKeys?.some(id => id.startsWith('claude')), 'no Claude id in the Gemini group')
    assert(parseAntigravityQuotaSummary({}).length === 0, 'no groups means no rows')
  })

  test('shares live Antigravity quota buckets across Gemini rows', () => {
    const metrics = parseAntigravityQuotaBuckets([
      {
        modelId: 'gemini-3.1-pro-low',
        remainingFraction: 0.2,
        resetTime: '2099-01-01T00:00:00Z',
      },
      {
        modelId: 'gemini-3-flash',
        remainingFraction: 0.85,
      },
      {
        modelId: 'claude-sonnet-4-6',
        remainingFraction: 0.65,
      },
    ])

    assert(
      metricSummary(metrics, 'Gemini 3.5 Flash (High)') === '20% remaining',
      '3.5 high should mirror the live shared Gemini bucket',
    )
    assert(
      metricSummary(metrics, 'Gemini 3.5 Flash (Medium)') === '20% remaining',
      '3.5 medium should mirror the live shared Gemini bucket',
    )
    assert(
      metricSummary(metrics, 'Gemini 3.5 Flash (Low)') === '20% remaining',
      '3.5 low should mirror the live shared Gemini bucket',
    )
    assert(
      metricSummary(metrics, 'Gemini 3.1 Pro (High)') === '20% remaining',
      '3.1 high should mirror the live shared Gemini bucket',
    )
    assert(
      metricSummary(metrics, 'Gemini 3 Flash') === '20% remaining',
      'Gemini 3 Flash should mirror the live shared Antigravity Gemini quota',
    )
    assert(
      metricSummary(metrics, 'Claude Sonnet 4.6') === '65% remaining',
      'Claude should stay on its own bucket',
    )
  })


  // Fireworks: the card reports dollars because the API has no balance to
  // report. Fixtures are trimmed captures of a real billing/summary response.
  const fireworksMonth = {
    lineItems: [
      { category: 'LLM input tokens (cached)', totalCost: { currencyCode: 'USD', units: '0', nanos: 369756920 } },
      { category: 'LLM output tokens', totalCost: { currencyCode: 'USD', units: '0', nanos: 220646080 } },
      { category: 'LLM input tokens (uncached)', totalCost: { currencyCode: 'USD', units: '0', nanos: 17494000 } },
    ],
    usageBuckets: [
      {
        startTime: '2026-08-26T00:00:00Z',
        endTime: '2026-08-27T00:00:00Z',
        lineItems: [{ totalCost: { units: '0', nanos: 230948000 } }],
      },
      { startTime: '2026-08-27T00:00:00Z', endTime: '2026-08-28T00:00:00Z', lineItems: [] },
      {
        startTime: '2026-08-28T00:00:00Z',
        endTime: '2026-08-28T00:08:12Z',
        lineItems: [{ totalCost: { units: '0', nanos: 1493000 } }],
      },
      {
        startTime: '2026-08-28T00:08:12Z',
        endTime: '2026-08-29T00:00:00Z',
        lineItems: [{ totalCost: { units: '0', nanos: 16000000 } }],
      },
    ],
  }

  test('totals a Fireworks billing summary from its flat line items', () => {
    const spend = parseFireworksBillingSummary(fireworksMonth)
    assert(
      spend.total.toFixed(6) === '0.607897',
      `month spend should sum units and nanos, got ${spend.total}`,
    )
    assert(spend.buckets.length === 4, 'every dated bucket should survive parsing')
  })

  test('carves today out of the month by bucket start, not by bucket count', () => {
    const spend = parseFireworksBillingSummary(fireworksMonth)
    const today = sumFireworksSpendSince(spend, '2026-08-28T00:00:00.000Z')
    assert(
      today.toFixed(6) === '0.017493',
      `both of today's split buckets should count, got ${today}`,
    )
  })

  test('reads an empty or malformed Fireworks summary as zero, not NaN', () => {
    for (const payload of [null, {}, { lineItems: 'nope' }, { lineItems: [{}] }]) {
      const spend = parseFireworksBillingSummary(payload)
      assert(spend.total === 0, `unusable payload should total 0, got ${spend.total}`)
      assert(spend.buckets.length === 0, 'unusable payload should yield no buckets')
    }
  })

  test('ends the Fireworks window on tomorrow so today is billed', () => {
    const range = fireworksSummaryRange(
      new Date('2026-08-28T11:26:03Z'),
      '2026-06-26T17:04:13.539509Z',
    )
    // Fireworks excludes costs dated on the end date, so a window ending today
    // would silently drop today.
    assert(range.end === '2026-08-29T00:00:00.000Z', `end should be tomorrow UTC, got ${range.end}`)
    assert(range.dayStart === '2026-08-28T00:00:00.000Z', 'today starts at UTC midnight')
    assert(range.monthStart === '2026-08-01T00:00:00.000Z', 'the month starts on the 1st UTC')
    assert(
      range.lifetimeStart === '2026-06-26T17:04:13.539Z',
      `a young account should measure from creation, got ${range.lifetimeStart}`,
    )
    assert(range.lifetimeIsComplete, 'an account inside the year is a true lifetime total')
  })

  test('clamps the Fireworks lifetime window to the 364 days the gateway serves', () => {
    // 365 days answers 503 "billing data is temporarily unavailable" every
    // time, so an older account gets a year and the row is labelled as one.
    const range = fireworksSummaryRange(new Date('2026-08-28T11:26:03Z'), '2024-01-01T00:00:00Z')
    assert(
      range.lifetimeStart === '2025-08-30T00:00:00.000Z',
      `lifetime should clamp to 364 days before the end, got ${range.lifetimeStart}`,
    )
    assert(!range.lifetimeIsComplete, 'a clamped window is not a lifetime total')

    const unknown = fireworksSummaryRange(new Date('2026-08-28T11:26:03Z'), null)
    assert(
      !unknown.lifetimeIsComplete,
      'an account id from the environment carries no create time to trust',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
