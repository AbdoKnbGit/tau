/** Run: bun run src/commands/report/antigravityReport.test.ts */

import assert from 'node:assert/strict'
import {
  antigravityReportAttemptBudget,
  antigravityReportAttemptDelayMs,
  runAntigravityReportWithHostSweep,
  usesAntigravityReportPath,
} from './antigravityReport.js'
import { isProviderQuotaFailure } from './presentation.js'
import { markAntigravityRetryHandled } from '../../lanes/gemini/antigravity_retry.js'

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
    // A future model on the Antigravity row uses its native recovery too.
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

  await test('an Antigravity model auto-routed from another row uses native recovery', () => {
    // A Gemini 3.x id selected while the row is still openai/gemini is
    // executed by Antigravity, so the report must use the Antigravity path.
    assert.equal(usesAntigravityReportPath('openai', 'gemini-3.7-flash-high'), true)
    assert.equal(usesAntigravityReportPath('openai', 'gpt-5.4'), false)
  })

  await test('reports never multiply the native retry budget', () => {
    for (const model of ['gemini-3.8-flash-high', 'claude-sonnet-4-6', undefined]) {
      assert.equal(antigravityReportAttemptBudget(model), 1)
    }
    for (const index of [0, 1, 2, 3]) {
      assert.equal(antigravityReportAttemptDelayMs(index, 1), 0)
    }
  })

  await test('one provider operation returns a successful report unchanged', async () => {
    const indices: number[] = []
    const markdown = await runAntigravityReportWithHostSweep({
      attempt: async index => { indices.push(index); return '# Report\n\nContent.' },
      isRetryable: isProviderQuotaFailure,
    })
    assert.equal(markdown, '# Report\n\nContent.')
    assert.deepEqual(indices, [0])
  })

  await test('handled failures and reconstructed quota errors are never replayed', async () => {
    const errors = [
      markAntigravityRetryHandled(new Error('Gemini API error 429: RESOURCE_EXHAUSTED')),
      new Error('Report generation did not return report content. API Error: Gemini API error 429: RESOURCE_EXHAUSTED'),
      new Error('API Error: failed to authenticate'),
    ]
    for (const error of errors) {
      let calls = 0
      await assert.rejects(runAntigravityReportWithHostSweep({
        attempt: async () => { calls++; throw error },
        isRetryable: () => true,
      }), received => received === error)
      assert.equal(calls, 1, 'outer report recovery replayed an exhausted native operation')
    }
  })

  await test('a cancelled report never starts generation', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await assert.rejects(runAntigravityReportWithHostSweep({
      attempt: async () => { calls++; return '# Report' },
      isRetryable: isProviderQuotaFailure,
      signal: controller.signal,
    }), { name: 'AbortError' })
    assert.equal(calls, 0)
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
