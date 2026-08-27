/**
 * Harvested provider rate limit tests.
 *
 * Run: bun run src/services/api/providerRateLimits.test.ts
 */

import {
  buildProviderQuotaInput,
  getProviderRateLimits,
  parseResetDuration,
  providerReportsNoQuota,
  recordProviderRateLimits,
  resetProviderRateLimits,
} from './providerRateLimits.js'
import { OpenAIProvider } from './providers/openai_provider.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  resetProviderRateLimits()
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

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

const FULL_HEADERS = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-remaining-requests': '900',
  'x-ratelimit-reset-requests': '6m0s',
  'x-ratelimit-limit-tokens': '150000',
  'x-ratelimit-remaining-tokens': '30000',
  'x-ratelimit-reset-tokens': '90s',
}

console.log('provider rate limits:')

test('parses the standard x-ratelimit family off a response', () => {
  const snapshot = recordProviderRateLimits('openrouter', headers(FULL_HEADERS))
  assert(snapshot !== null, 'a response with headers should produce a snapshot')
  assert(snapshot.provider === 'openrouter', 'provider should be stamped')
  assert(snapshot.requests?.limit === 1000, 'request limit should parse')
  assert(snapshot.requests?.remaining === 900, 'request remaining should parse')
  assert(snapshot.requests?.resetsInSeconds === 360, '6m0s should be 360s')
  assert(snapshot.tokens?.remaining === 30_000, 'token remaining should parse')
  assert(snapshot.tokens?.resetsInSeconds === 90, '90s should be 90s')
})

test('a response with no rate limit headers does not erase a good snapshot', () => {
  recordProviderRateLimits('groq', headers(FULL_HEADERS))
  const result = recordProviderRateLimits('groq', headers({ 'content-type': 'application/json' }))

  assert(result === null, 'a header-less response should report nothing parsed')
  assert(
    getProviderRateLimits()?.requests?.remaining === 900,
    'the previous snapshot must survive a header-less response',
  )
})

test('a hostile headers object cannot break the request it rode in on', () => {
  // Two call sites sit on the live streaming path in the openai-compat lane.
  // A throw there would fail the user's actual API turn, not just the bar.
  const exploding = {
    get() {
      throw new Error('header access failed')
    },
  } as unknown as Headers

  let result: unknown = 'not-called'
  try {
    result = recordProviderRateLimits('deepseek', exploding)
  } catch {
    throw new Error('recordProviderRateLimits must never throw at a call site')
  }
  assert(result === null, 'an unreadable response reports nothing parsed')
})

test('a partial response records only the fields it carried', () => {
  const snapshot = recordProviderRateLimits(
    'deepseek',
    headers({ 'x-ratelimit-remaining-tokens': '4200' }),
  )
  assert(snapshot !== null, 'one header is enough to record')
  assert(snapshot.requests === undefined, 'absent request family should stay absent')
  assert(snapshot.tokens?.remaining === 4200, 'token remaining should parse')
  assert(snapshot.tokens?.limit === undefined, 'absent limit should stay absent')
})

test('builds the statusline field for the provider that produced it', () => {
  recordProviderRateLimits('openrouter', headers(FULL_HEADERS))
  const quota = buildProviderQuotaInput('openrouter')

  assert(quota !== undefined, 'a matching provider should produce the field')
  assert(quota.provider === 'openrouter', 'provider should round-trip')
  assert(quota.requests?.used_percentage === 10, '900/1000 remaining is 10% used')
  assert(quota.tokens?.used_percentage === 80, '30000/150000 remaining is 80% used')
  assert(
    quota.requests?.resets_at === quota.captured_at + 360,
    'resets_at should be captured_at plus the parsed duration',
  )
})

test('never reports one provider\'s numbers under another', () => {
  recordProviderRateLimits('openrouter', headers(FULL_HEADERS))

  assert(
    buildProviderQuotaInput('groq') === undefined,
    'a provider switch must suppress the pre-switch snapshot',
  )
  assert(
    buildProviderQuotaInput('openrouter') !== undefined,
    'switching back must not have destroyed the snapshot',
  )
})

test('distinguishes "not called yet" from "publishes no quota"', () => {
  assert(
    !providerReportsNoQuota('mimo'),
    'a provider the session has never called is not known to lack a quota',
  )
  assert(
    buildProviderQuotaInput('mimo') === undefined,
    'nothing known yet means no field at all, not an unavailable one',
  )

  recordProviderRateLimits('mimo', headers({ 'content-type': 'application/json' }))
  assert(
    providerReportsNoQuota('mimo'),
    'a response with no rate limit headers marks the provider as publishing none',
  )
  assert(
    buildProviderQuotaInput('mimo')?.status === 'unavailable',
    'the payload should state the absence rather than omit the field',
  )
  assert(
    buildProviderQuotaInput('mimo')?.captured_at === undefined,
    'an unavailable report carries no reading',
  )
  assert(
    !providerReportsNoQuota('groq'),
    'the finding must not leak to other providers',
  )
})

test('marks a real reading as available', () => {
  recordProviderRateLimits('openrouter', headers(FULL_HEADERS))
  assert(
    buildProviderQuotaInput('openrouter')?.status === 'available',
    'a harvested reading should be reported as available',
  )
})

test('a provider that starts publishing a quota stops being marked unavailable', () => {
  recordProviderRateLimits('mimo', headers({}))
  assert(providerReportsNoQuota('mimo'), 'precondition: marked unavailable')

  recordProviderRateLimits('mimo', headers({ 'x-ratelimit-remaining-requests': '5' }))
  assert(
    !providerReportsNoQuota('mimo'),
    'a later response carrying headers should clear the mark',
  )
})

test('reports nothing before the session has called any provider', () => {
  assert(getProviderRateLimits() === null, 'no snapshot before any response')
  assert(
    buildProviderQuotaInput('openai') === undefined,
    'no field before any response',
  )
})

test('omits used_percentage when the window is not fully described', () => {
  recordProviderRateLimits('groq', headers({ 'x-ratelimit-remaining-requests': '50' }))
  const quota = buildProviderQuotaInput('groq')

  assert(quota?.requests?.remaining === 50, 'remaining should still be reported')
  assert(
    quota?.requests?.used_percentage === undefined,
    'a percentage needs both limit and remaining',
  )
  assert(
    quota?.requests?.resets_at === undefined,
    'resets_at needs a parseable duration',
  )
})

test('a zero limit does not produce a divide-by-zero percentage', () => {
  recordProviderRateLimits(
    'groq',
    headers({
      'x-ratelimit-limit-requests': '0',
      'x-ratelimit-remaining-requests': '0',
    }),
  )
  const quota = buildProviderQuotaInput('groq')
  assert(
    quota?.requests?.used_percentage === undefined,
    'limit 0 must not yield Infinity or NaN',
  )
})

test('reports whole percentages, never a float tail', () => {
  recordProviderRateLimits(
    'groq',
    headers({
      'x-ratelimit-limit-requests': '3',
      'x-ratelimit-remaining-requests': '1',
      'x-ratelimit-limit-tokens': '1000',
      'x-ratelimit-remaining-tokens': '900',
    }),
  )
  const quota = buildProviderQuotaInput('groq')

  assert(quota?.requests?.used_percentage === 67, '2/3 used should round to 67')
  assert(quota?.tokens?.used_percentage === 10, '100/1000 used should be exactly 10')
  for (const window of [quota?.requests, quota?.tokens]) {
    assert(
      Number.isInteger(window?.used_percentage),
      `${window?.used_percentage} should be an integer`,
    )
  }
})

test('an exhausted window reads as 100% used', () => {
  recordProviderRateLimits(
    'groq',
    headers({
      'x-ratelimit-limit-requests': '60',
      'x-ratelimit-remaining-requests': '0',
    }),
  )
  assert(
    buildProviderQuotaInput('groq')?.requests?.used_percentage === 100,
    '0 remaining of 60 is 100% used',
  )
})

test('parses the duration forms providers actually send', () => {
  const cases: [string, number | undefined][] = [
    ['6m0s', 360],
    ['1s', 1],
    ['1.5s', 2],
    ['500ms', 1],
    ['1h2m3s', 3723],
    ['2d', 172_800],
    ['60', 60],
    ['0', 0],
    ['  6m0s  ', 360],
    ['6M0S', 360],
  ]
  for (const [raw, expected] of cases) {
    const actual = parseResetDuration(raw)
    assert(actual === expected, `${raw} should parse to ${expected}, got ${actual}`)
  }
})

test('drops malformed durations rather than half-reading them', () => {
  for (const raw of ['', '   ', 'soon', '6m junk', 'junk 6m', '-5s', 'NaN', '6x']) {
    assert(
      parseResetDuration(raw) === undefined,
      `${JSON.stringify(raw)} should not parse`,
    )
  }
  assert(parseResetDuration(null) === undefined, 'a missing header should not parse')
})

test('ignores non-numeric counts instead of recording NaN', () => {
  const snapshot = recordProviderRateLimits(
    'groq',
    headers({
      'x-ratelimit-limit-requests': 'unlimited',
      'x-ratelimit-remaining-requests': '17',
    }),
  )
  assert(snapshot?.requests?.limit === undefined, 'a non-numeric limit is dropped')
  assert(snapshot?.requests?.remaining === 17, 'the valid sibling is kept')
})

// The seam into the provider: _extractRateLimits both feeds the snapshot and
// keeps populating lastRateLimits with its original sticky semantics.
class ProbeProvider extends OpenAIProvider {
  readonly name = 'openrouter'
  extract(h: Headers): void {
    this._extractRateLimits(h)
  }
}

test('a provider response populates the snapshot through _extractRateLimits', () => {
  const provider = new ProbeProvider({ apiKey: 'test-key' })
  provider.extract(headers(FULL_HEADERS))

  assert(
    getProviderRateLimits()?.provider === 'openrouter',
    'the response should be stamped with the provider that served it',
  )
  assert(
    buildProviderQuotaInput('openrouter')?.requests?.remaining === 900,
    'the statusline field should be available after one response',
  )
})

test('_extractRateLimits keeps lastRateLimits sticky across responses', () => {
  const provider = new ProbeProvider({ apiKey: 'test-key' })
  provider.extract(headers(FULL_HEADERS))
  provider.extract(headers({ 'x-ratelimit-remaining-requests': '850' }))

  const rl = provider.lastRateLimits
  assert(rl.requestsRemaining === 850, 'the newer value should win')
  assert(rl.requestsLimit === 1000, 'a field absent from the newer response is retained')
  assert(rl.requestsReset === '6m0s', 'the raw reset string is retained verbatim')
  assert(rl.tokensRemaining === 30_000, 'the untouched token family is retained')
})

test('_extractRateLimits keeps a reset string this module will not parse', () => {
  const provider = new ProbeProvider({ apiKey: 'test-key' })
  provider.extract(headers({ 'x-ratelimit-reset-requests': 'soon' }))

  assert(
    provider.lastRateLimits.requestsReset === 'soon',
    'an uninterpretable reset is still passed through verbatim',
  )
  assert(
    getProviderRateLimits() === null,
    'but it must not create a snapshot with no usable numbers',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
