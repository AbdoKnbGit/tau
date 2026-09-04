/** Run: bun run src/commands/report/antigravityReport.test.ts */

import assert from 'node:assert/strict'
import {
  antigravityReportAttemptBudget,
  antigravityReportAttemptDelayMs,
  runAntigravityReportWithHostSweep,
  usesAntigravityReportPath,
} from './antigravityReport.js'
import { isProviderQuotaFailure } from './presentation.js'
import { antigravityGenerationHostCount } from '../../services/api/providers/gemini_code_assist.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}: ${(error as Error).message}`)
  }
}

const GEMINI_MODEL = 'gemini-3.7-flash-high'
const HOSTS = antigravityGenerationHostCount(GEMINI_MODEL)

async function main(): Promise<void> {
  console.log('antigravity report path:')

  await test('routes every Antigravity model, Gemini and Claude alike', () => {
    for (const model of [
      'gemini-3.8-flash-high',
      'gemini-3.7-flash-high',
      'gemini-3.1-pro-low',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
    ]) {
      assert.equal(
        usesAntigravityReportPath('antigravity', model),
        true,
        `${model} did not take the Antigravity report path`,
      )
    }
    // The per-host quota is a property of the proxy, so an unknown model on
    // the Antigravity row still routes there.
    assert.equal(usesAntigravityReportPath('antigravity', undefined), true)
    assert.equal(usesAntigravityReportPath('antigravity', 'some-future-model'), true)
  })

  await test('leaves every other provider on the original path', () => {
    for (const provider of [
      'openai',
      'openrouter',
      'firstParty',
      'deepseek',
      'fireworks',
      'alibaba',
    ] as const) {
      assert.equal(
        usesAntigravityReportPath(provider, 'gpt-5.4'),
        false,
        `${provider} was pulled onto the Antigravity report path`,
      )
    }
  })

  await test('an Antigravity model auto-routed from another row still sweeps', () => {
    // A Gemini 3.x id selected while the row is still openai/gemini is
    // executed by Antigravity, so the report must use the Antigravity path.
    assert.equal(usesAntigravityReportPath('openai', 'gemini-3.7-flash-high'), true)
    assert.equal(usesAntigravityReportPath('openai', 'gpt-5.4'), false)
  })

  await test('budget is one attempt per host per sweep', () => {
    assert.equal(antigravityReportAttemptBudget(GEMINI_MODEL), HOSTS * 3)
    assert.ok(HOSTS >= 2, `expected multiple Antigravity hosts, got ${HOSTS}`)
  })

  await test('attempts inside a sweep run back-to-back; sweeps pause', () => {
    for (let i = 0; i < HOSTS; i++) {
      assert.equal(
        antigravityReportAttemptDelayMs(i, HOSTS),
        0,
        `attempt ${i} waited inside the first sweep`,
      )
    }
    assert.ok(
      antigravityReportAttemptDelayMs(HOSTS, HOSTS) > 0,
      'second sweep started with no backoff',
    )
    assert.ok(
      antigravityReportAttemptDelayMs(HOSTS * 2, HOSTS)
        > antigravityReportAttemptDelayMs(HOSTS, HOSTS),
      'backoff did not grow between sweeps',
    )
  })

  await test('a quota refusal is retried until a host serves', async () => {
    let calls = 0
    const markdown = await runAntigravityReportWithHostSweep({
      attempt: async () => {
        calls++
        if (calls < HOSTS) {
          throw new Error(
            'Report generation did not return report content. '
            + 'API Error: Gemini API error 429: RESOURCE_EXHAUSTED',
          )
        }
        return '# Report\n\nContent.'
      },
      isRetryable: isProviderQuotaFailure,
    })
    assert.equal(markdown, '# Report\n\nContent.')
    assert.equal(calls, HOSTS, `expected ${HOSTS} attempts, made ${calls}`)
  })

  await test('a non-quota failure is surfaced immediately', async () => {
    let calls = 0
    await assert.rejects(
      runAntigravityReportWithHostSweep({
        attempt: async () => {
          calls++
          throw new Error('API Error: failed to authenticate')
        },
        isRetryable: isProviderQuotaFailure,
      }),
      /failed to authenticate/,
    )
    assert.equal(calls, 1, `auth failure burned ${calls} attempts`)
  })

  await test('exhausting the budget surfaces the provider failure', async () => {
    let calls = 0
    await assert.rejects(
      runAntigravityReportWithHostSweep({
        attempt: async () => {
          calls++
          throw new Error('Gemini API error 429: RESOURCE_EXHAUSTED')
        },
        isRetryable: isProviderQuotaFailure,
        // Pre-aborted after the first sweep would hide the budget; instead
        // let it run and assert it stops at the computed budget.
      }),
      /429/,
    )
    assert.equal(
      calls,
      antigravityReportAttemptBudget(),
      `budget was ${antigravityReportAttemptBudget()}, made ${calls} attempts`,
    )
  })

  await test('an aborted report stops sweeping', async () => {
    const controller = new AbortController()
    let calls = 0
    await assert.rejects(
      runAntigravityReportWithHostSweep({
        attempt: async () => {
          calls++
          controller.abort()
          throw new Error('Gemini API error 429: RESOURCE_EXHAUSTED')
        },
        isRetryable: isProviderQuotaFailure,
        signal: controller.signal,
      }),
      /429/,
    )
    assert.equal(calls, 1, `abort did not stop the sweep, made ${calls} attempts`)
  })

  await test('budget tracks each model’s own host list', () => {
    // Gemini gets [prod, daily]; Claude gets [daily, prod, sandbox]. A fixed
    // number would over- or under-sweep one of them.
    const gemini = antigravityGenerationHostCount('gemini-3.7-flash-high')
    const claude = antigravityGenerationHostCount('claude-sonnet-4-6')
    assert.equal(antigravityReportAttemptBudget('gemini-3.7-flash-high'), gemini * 3)
    assert.equal(antigravityReportAttemptBudget('claude-sonnet-4-6'), claude * 3)
    // Sweep pauses land on that model's own host boundary.
    assert.equal(antigravityReportAttemptDelayMs(gemini - 1, gemini), 0)
    assert.ok(antigravityReportAttemptDelayMs(gemini, gemini) > 0)
    assert.equal(antigravityReportAttemptDelayMs(claude - 1, claude), 0)
    assert.ok(antigravityReportAttemptDelayMs(claude, claude) > 0)
  })

  await test('quota classification separates refusals from real failures', () => {
    assert.equal(isProviderQuotaFailure(new Error('Gemini API error 429: {')), true)
    assert.equal(isProviderQuotaFailure(new Error('RESOURCE_EXHAUSTED')), true)
    assert.equal(isProviderQuotaFailure(new Error('rate limit reached')), true)
    assert.equal(isProviderQuotaFailure(new Error('failed to authenticate')), false)
    assert.equal(isProviderQuotaFailure(new Error('prompt is too long')), false)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

await main()
