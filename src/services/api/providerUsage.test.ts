/**
 * Provider usage parser tests.
 *
 * Run: bun run src/services/api/providerUsage.test.ts
 */

import {
  parseAntigravityQuotaBuckets,
  parseAntigravityUsage,
} from './antigravityUsageParser.js'

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
      metricSummary(metrics, 'Gemini 3 Flash') === '20% remaining',
      'Gemini 3 Flash should remain a distinct row while sharing the Antigravity Gemini quota',
    )
    assert(
      !metrics.some(metric => metric.label.includes('thinking') || metric.label.includes('via Antigravity')),
      'usage labels should not include Antigravity thinking suffixes',
    )
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

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
