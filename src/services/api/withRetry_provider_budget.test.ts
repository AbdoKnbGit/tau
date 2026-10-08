/** Run: bun run src/services/api/withRetry_provider_budget.test.ts */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { fileURLToPath } from 'node:url'
import type { ProviderRetryBudget } from './providerRetryBudget.js'
import { APIConnectionError, APIUserAbortError } from '@anthropic-ai/sdk'

// Exercise the real retry controller, async-local scope, and error
// classification without loading unrelated UI, analytics, or credentials.
const stubs: Array<[string, string[]]> = [
  ['../../utils/aws.js', ['isAwsCredentialsProviderError']],
  ['../../utils/debug.js', ['logForDebugging']],
  ['../../utils/log.js', ['logError']],
  ['../../utils/messages.js', ['createSystemAPIErrorMessage']],
  ['../../utils/model/providers.js', ['getAPIProvider', 'getAPIProviderForStatsig']],
  ['../../utils/model/contextWindows.js', ['recordProviderModelContextWindows']],
  ['../../utils/auth.js', ['clearApiKeyHelperCache', 'clearAwsCredentialsCache', 'clearGcpCredentialsCache', 'getClaudeAIOAuthTokens', 'handleOAuth401Error', 'isClaudeAISubscriber', 'isEnterpriseSubscriber']],
  ['../../utils/model/model.js', ['isNonCustomOpusModel']],
  ['../../utils/proxy.js', ['disableKeepAlive']],
  ['../analytics/growthbook.js', ['getFeatureValue_CACHED_MAY_BE_STALE']],
  ['../analytics/index.js', ['logEvent']],
  ['../rateLimitMocking.js', ['checkMockRateLimitError', 'isMockRateLimitError']],
  ['./errorUtils.js', ['extractConnectionErrorDetails']],
]
for (const [path, names] of stubs) {
  mock.module(fileURLToPath(new URL(path, import.meta.url)), () =>
    Object.fromEntries(names.map(name => [name, () => false])))
}
let unattendedRetry = false
mock.module('bun:bundle', () => ({ feature: (name: string) => name === 'UNATTENDED_RETRY' && unattendedRetry }))
mock.module('./errors.js', () => ({ REPEATED_529_ERROR_MESSAGE: 'overloaded' }))
mock.module('../../utils/errors.js', () => ({ errorMessage: (error: Error) => error.message }))
const sleeps: number[] = []
let cooldowns = 0
mock.module('../../utils/sleep.js', () => ({ sleep: async (ms: number) => { sleeps.push(ms) } }))
mock.module('../../utils/fastMode.js', () => ({
  isFastModeEnabled: () => true,
  isFastModeCooldown: () => false,
  triggerFastModeCooldown: () => { cooldowns++ },
  handleFastModeOverageRejection: () => {},
  handleFastModeRejectedByAPI: () => {},
}))

const { withRetry, CannotRetryError } = await import('./withRetry.js')
const { getProviderRetryBudget, getProviderSetupWindow, ProviderSetupTimeoutError } = await import('./providerRetryBudget.js')
const { markAntigravityRetryHandled } = await import('../../lanes/gemini/antigravity_retry.js')
const previousUnattended = process.env.CLAUDE_CODE_UNATTENDED_RETRY

const MODEL = 'gemini-3.8-flash-high'
const BUDGET_KEY = `antigravity-quota:${MODEL}`
const options = {
  model: MODEL,
  thinkingConfig: { type: 'disabled' } as const,
  maxRetries: 2,
}
const getClient = async () => ({} as any)
let passed = 0

function quota(retryAfterMs?: number): Error {
  return Object.assign(new Error('Gemini API error 429: RESOURCE_EXHAUSTED'), {
    status: 429,
    isRetryable: true,
    retryAfterMs,
  })
}

async function complete<T>(generator: AsyncGenerator<unknown, T>): Promise<T> {
  const result = await generator.next()
  assert.equal(result.done, true, 'internal third-party recovery exposed a retry notice')
  return result.value as T
}

async function test(name: string, run: () => Promise<void>): Promise<void> {
  sleeps.length = 0
  cooldowns = 0
  await run()
  passed++
  console.log(`  ok ${name}`)
}

try {
  for (const fastMode of [false, true]) {
    for (const persistent of [false, true]) {
      await test(`native Antigravity exhaustion never restarts or emits notices (fast=${fastMode}, persistent=${persistent})`, async () => {
        unattendedRetry = persistent
        process.env.CLAUDE_CODE_UNATTENDED_RETRY = persistent ? '1' : '0'
        for (const failure of [
          quota(),
          quota(60_000),
          Object.assign(new Error('Gemini API error 400: invalid request'), { status: 400 }),
          new APIConnectionError({ message: 'fetch failed', cause: new Error('ECONNRESET') }),
        ]) {
          markAntigravityRetryHandled(failure)
          let attempts = 0
          await assert.rejects(complete(withRetry(getClient, async () => {
            attempts++
            throw failure
          }, { ...options, fastMode, maxRetries: 10 })), error =>
            error instanceof CannotRetryError && error.originalError === failure)
          assert.equal(attempts, 1, 'outer layer replayed native recovery')
          assert.deepEqual(sleeps, [])
          assert.equal(cooldowns, 0, 'native recovery changed speed/model')
        }
        unattendedRetry = false
        process.env.CLAUDE_CODE_UNATTENDED_RETRY = '0'
      })
    }
  }

  await test('cancellation still takes precedence over an exhausted native retry', async () => {
    const controller = new AbortController()
    const failure = quota()
    markAntigravityRetryHandled(failure)
    await assert.rejects(complete(withRetry(getClient, async () => {
      controller.abort()
      throw failure
    }, { ...options, signal: controller.signal })), error => error instanceof APIUserAbortError)
    assert.deepEqual(sleeps, [])
  })

  for (const scenario of [
    { name: 'standard retry', fastMode: false, retryAfterMs: undefined, cooldowns: 0 },
    { name: 'fast mode with short wait', fastMode: true, retryAfterMs: 10, cooldowns: 0 },
    { name: 'fast mode falling back after long wait', fastMode: true, retryAfterMs: 60_000, cooldowns: 1 },
  ]) {
    await test(`${scenario.name}: three outer invocations share one fast-retry allowance`, async () => {
      const seen: ProviderRetryBudget[] = []
      const remaining: number[] = []
      const fastModes: Array<boolean | undefined> = []
      let fastRetries = 0
      const result = await complete(withRetry(getClient, async (_client, attempt, context) => {
        // Native stream setup discovers the budget after asynchronous auth
        // and preprocessing; the scope must survive that boundary.
        await Promise.resolve()
        const budget = getProviderRetryBudget(BUDGET_KEY, 3)
        seen.push(budget)
        remaining.push(budget.remaining)
        fastModes.push(context.fastMode)
        while (budget.remaining > 0) {
          budget.remaining--
          fastRetries++
          await Promise.resolve()
        }
        if (attempt < 3) throw quota(scenario.retryAfterMs)
        return 'recovered'
      }, { ...options, fastMode: scenario.fastMode }))

      assert.equal(result, 'recovered', 'sharing the budget removed ordinary outer recovery')
      assert.equal(seen.length, 3)
      assert.deepEqual(remaining, [3, 0, 0], 'outer retry replenished inline retries')
      assert.equal(fastRetries, 3)
      assert.ok(seen.every(budget => budget === seen[0]), 'outer attempts used different budget objects')
      assert.equal(cooldowns, scenario.cooldowns)
      if (scenario.retryAfterMs === 10) {
        assert.deepEqual(sleeps, [10, 10], 'short-wait fast-mode path was not exercised')
        assert.deepEqual(fastModes, [true, true, true])
      } else if (scenario.cooldowns === 1) {
        assert.deepEqual(fastModes, [true, false, false], 'standard-speed fallback was not exercised')
      }
    })
  }

  await test('concurrent outer controllers retain independent budgets across interleaved retries', async () => {
    let release!: () => void
    const bothStarted = new Promise<void>(resolve => { release = resolve })
    let started = 0
    const seen: ProviderRetryBudget[][] = [[], []]
    const remaining: number[][] = [[], []]

    const run = (index: number) => complete(withRetry(getClient, async (_client, attempt) => {
      const budget = getProviderRetryBudget(BUDGET_KEY, 3)
      seen[index]!.push(budget)
      remaining[index]!.push(budget.remaining)
      budget.remaining--
      if (attempt === 1) {
        started++
        if (started === 2) release()
        await bothStarted
      }
      await Promise.resolve()
      assert.equal(getProviderRetryBudget(BUDGET_KEY, 3), budget, 'async continuation inherited another operation scope')
      if (attempt < 3) throw quota()
      return `request-${index}`
    }, options))

    assert.deepEqual(await Promise.all([run(0), run(1)]), ['request-0', 'request-1'])
    assert.notEqual(seen[0]![0], seen[1]![0], 'concurrent requests shared an allowance')
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(remaining[index], [3, 2, 1])
      assert.ok(seen[index]!.every(budget => budget === seen[index]![0]))
      assert.equal(seen[index]![0]!.remaining, 0)
    }
  })

  await test('a later user operation gets a fresh budget after the earlier operation exhausts retries', async () => {
    let exhausted: ProviderRetryBudget | undefined
    let attempts = 0
    await assert.rejects(complete(withRetry(getClient, async () => {
      attempts++
      const budget = getProviderRetryBudget(BUDGET_KEY, 3)
      exhausted ??= budget
      assert.equal(budget, exhausted)
      budget.remaining = 0
      throw quota()
    }, options)), error => error instanceof CannotRetryError)
    assert.equal(attempts, 3, 'ordinary exhausted-request retry limit changed')

    const fresh = await complete(withRetry(getClient, async () => {
      await Promise.resolve()
      return getProviderRetryBudget(BUDGET_KEY, 3)
    }, options))
    assert.notEqual(fresh, exhausted)
    assert.equal(fresh.remaining, 3, 'completed operation leaked its exhausted budget')
  })

  await test('different model keys remain independent inside one operation', async () => {
    const otherKey = 'antigravity-quota:gemini-3.7-flash-high'
    let other: ProviderRetryBudget | undefined
    await complete(withRetry(getClient, async (_client, attempt) => {
      getProviderRetryBudget(BUDGET_KEY, 3).remaining = 0
      const budget = getProviderRetryBudget(otherKey, 3)
      if (attempt === 1) {
        other = budget
        budget.remaining--
        throw quota()
      }
      assert.equal(budget, other)
      assert.equal(budget.remaining, 2, 'another model consumed this model allowance')
      return 'recovered'
    }, options))
  })

  await test('direct calls outside an outer retry operation do not share global state', async () => {
    const first = getProviderRetryBudget(BUDGET_KEY, 3)
    first.remaining = 0
    await Promise.resolve()
    const next = getProviderRetryBudget(BUDGET_KEY, 3)
    assert.notEqual(first, next)
    assert.equal(next.remaining, 3)
  })

  await test('setup deadline survives outer retries and is fresh for the next operation', async () => {
    const windows: Array<{ deadlineAt: number; timeoutMs: number }> = []
    await complete(withRetry(getClient, async (_client, attempt) => {
      windows.push(getProviderSetupWindow('antigravity-gemini', 300000))
      if (attempt < 3) throw quota()
    }, options))
    assert.equal(windows.length, 3)
    assert.ok(windows.every(window => window === windows[0]))
    const fresh = await complete(withRetry(getClient, async () => getProviderSetupWindow('antigravity-gemini', 300000), options))
    assert.notEqual(fresh, windows[0], 'new operation reused the earlier setup deadline')
  })

  for (const fastMode of [false, true]) {
    await test(`setup timeout stops the real outer controller without a new window (fast=${fastMode})`, async () => {
      let attempts = 0
      await assert.rejects(complete(withRetry(getClient, async () => {
        attempts++
        throw new ProviderSetupTimeoutError('Antigravity Gemini', 300000)
      }, { ...options, fastMode, maxRetries: 10 })), error => error instanceof CannotRetryError)
      assert.equal(attempts, 1, 'shared setup timeout restarted native generation')
      assert.deepEqual(sleeps, [])
      assert.equal(cooldowns, 0, 'local timeout triggered a quota/model fallback')
    })
  }

  await test('unrelated provider retries retain their success and terminal-error behavior', async () => {
    let attempts = 0
    const result = await complete(withRetry(getClient, async () => {
      attempts++
      if (attempts === 1) {
        throw Object.assign(new Error('OpenAI API error 503: temporarily unavailable'), {
          status: 503,
          isRetryable: true,
        })
      }
      return 'openai success'
    }, { ...options, model: 'openai-test-model' }))
    assert.equal(result, 'openai success')
    assert.equal(attempts, 2)
    assert.equal(sleeps.length, 1)

    attempts = 0
    await assert.rejects(complete(withRetry(getClient, async () => {
      attempts++
      throw Object.assign(new Error('OpenAI API error 400: invalid request'), {
        status: 400,
        isRetryable: false,
      })
    }, { ...options, model: 'openai-test-model' })), error => error instanceof CannotRetryError)
    assert.equal(attempts, 1, 'provider budget caused a terminal error to retry')
    assert.equal(sleeps.length, 1)
  })

  console.log(`Provider retry budget: ${passed} cases passed`)
} finally {
  if (previousUnattended === undefined) delete process.env.CLAUDE_CODE_UNATTENDED_RETRY
  else process.env.CLAUDE_CODE_UNATTENDED_RETRY = previousUnattended
  mock.restore()
}
