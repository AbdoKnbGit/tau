/**
 * Antigravity client identity tests.
 *
 * Run: bun run src/lanes/gemini/antigravity_headers.test.ts
 */

import {
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_HUB_USER_AGENT,
} from '../../constants/antigravity.js'
import {
  ANTIGRAVITY_GENERATION_BASE,
  CODE_ASSIST_BASE,
  _resetAntigravityGeminiAffinityForTest,
  antigravityApiHeaders,
  antigravityGeminiEndpointTimeoutMs,
  antigravityGeminiStickyBase,
  codeAssistGenerationBase,
  codeAssistGenerationBasesForModel,
  recordAntigravityGeminiServedBase,
  shouldTryNextAntigravityGeminiEndpoint,
} from '../../services/api/providers/gemini_code_assist.js'
import { buildApiHeaders } from '../shared/antigravity_auth.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
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

function main(): void {
  console.log('antigravity headers:')

  test('generateContent headers advertise the current Antigravity API version', () => {
    assert(ANTIGRAVITY_API_VERSION === '2.8.1', `unexpected Antigravity version: ${ANTIGRAVITY_API_VERSION}`)
    const headers = antigravityApiHeaders('token')
    assert(
      headers['User-Agent'] === ANTIGRAVITY_HUB_USER_AGENT,
      `bad User-Agent: ${headers['User-Agent']}`,
    )
    assert(!('X-Goog-Api-Client' in headers), 'generateContent path should not add X-Goog-Api-Client')
    assert(!('x-request-source' in headers), 'generation path should not add proxy-only request source')
    assert(
      Object.keys(headers).sort().join(',') === 'Authorization,Content-Type,User-Agent',
      `unexpected generation headers: ${Object.keys(headers).join(',')}`,
    )
  })

  test('Antigravity generation routes to the working daily backend', () => {
    assert(
      codeAssistGenerationBase('antigravity') === ANTIGRAVITY_GENERATION_BASE,
      'Antigravity generation base should use daily endpoint',
    )
    // Non-sandbox daily channel — the real client's primary, with reliable
    // implicit-cache reads (the sandbox host is a 404 fallback only now).
    assert(
      ANTIGRAVITY_GENERATION_BASE === 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      `wrong Antigravity generation base: ${ANTIGRAVITY_GENERATION_BASE}`,
    )
    assert(
      codeAssistGenerationBase('cli') === CODE_ASSIST_BASE,
      'Gemini CLI generation base should stay on production Code Assist endpoint',
    )
  })

  test('Antigravity Gemini prefers the production host (latency), Claude keeps daily', () => {
    const sandbox = 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal'

    // Gemini-Antigravity: prod first, daily second (known-good cache).
    // Sandbox is opt-in only; it is too flaky for the default fallback path.
    const gemini = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.5-flash-low')
    assert(gemini[0] === CODE_ASSIST_BASE, `gemini primary should be prod, got ${gemini[0]}`)
    assert(gemini[1] === ANTIGRAVITY_GENERATION_BASE, `gemini fallback should be daily, got ${gemini[1]}`)
    assert(!gemini.includes(sandbox), 'gemini default path should not include sandbox')

    // Claude-on-Antigravity: untouched — daily first, exactly as before.
    const claude = codeAssistGenerationBasesForModel('antigravity', 'claude-sonnet-4-6')
    assert(claude[0] === ANTIGRAVITY_GENERATION_BASE, `claude primary must stay daily, got ${claude[0]}`)
    assert(claude[1] === CODE_ASSIST_BASE, `claude fallback should be prod, got ${claude[1]}`)
  })

  test('TAU_ANTIGRAVITY_GEMINI_ENDPOINT overrides the Gemini primary', () => {
    process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT = 'daily'
    try {
      const bases = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.5-flash-low')
      assert(bases[0] === ANTIGRAVITY_GENERATION_BASE, `=daily must put daily first, got ${bases[0]}`)
    } finally {
      delete process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
    }
  })

  test('TAU_ANTIGRAVITY_GEMINI_ENDPOINT=sandbox is explicit opt-in', () => {
    const sandbox = 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal'
    process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT = 'sandbox'
    try {
      const bases = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.5-flash-low')
      assert(bases[0] === sandbox, `=sandbox must put sandbox first, got ${bases[0]}`)
      assert(bases[1] === CODE_ASSIST_BASE, `=sandbox should keep prod fallback, got ${bases[1]}`)
      assert(bases[2] === ANTIGRAVITY_GENERATION_BASE, `=sandbox should keep daily final, got ${bases[2]}`)
    } finally {
      delete process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
    }
  })

  test('Antigravity Gemini short timeout is only a fallback probe', () => {
    assert(
      antigravityGeminiEndpointTimeoutMs(0, 2) === 6_000,
      'first endpoint should keep the fast probe timeout',
    )
    assert(
      antigravityGeminiEndpointTimeoutMs(1, 2) === 0,
      'final fallback must not be killed by the short probe timeout',
    )
  })

  test('pinned host gets the long grace window instead of the 6s punt', () => {
    // A cache-missing turn on a HEALTHY host holds headers 5-23s; punting it
    // to the other host re-bills the whole prompt cold on a separate cache
    // pool. Once a session is pinned, only a genuinely hung host may punt.
    assert(
      antigravityGeminiEndpointTimeoutMs(0, 2, true) === 30_000,
      'pinned first endpoint should get the 30s grace window',
    )
    assert(
      antigravityGeminiEndpointTimeoutMs(1, 2, true) === 0,
      'final fallback stays un-timed even when pinned',
    )
    process.env.TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS = '45000'
    try {
      assert(
        antigravityGeminiEndpointTimeoutMs(0, 2, true) === 45_000,
        'TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS must override the grace window',
      )
      assert(
        antigravityGeminiEndpointTimeoutMs(0, 2) === 6_000,
        'sticky override must not leak into the unpinned probe timeout',
      )
    } finally {
      delete process.env.TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS
    }
  })

  test('endpoint affinity is process-wide: agents inherit the pinned host', () => {
    _resetAntigravityGeminiAffinityForTest()
    try {
      // The daily host served a request → the WHOLE process follows it. All
      // sessions in one process share prefix material (repo, system prompt,
      // cloned conversations), so their entries live in one host's pool; a
      // per-session pin let an agent's first request race the 6s probe and
      // get punted to the other pool (61.5k-token cold, observed live).
      recordAntigravityGeminiServedBase('main-session', ANTIGRAVITY_GENERATION_BASE)
      const main = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.5-flash-low', 'main-session')
      assert(main[0] === ANTIGRAVITY_GENERATION_BASE, `pinned process must go daily-first, got ${main[0]}`)
      assert(main.includes(CODE_ASSIST_BASE), 'prod must stay available as fallback')

      const agent = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.5-flash-low', 'tau-agent-xyz')
      assert(agent[0] === ANTIGRAVITY_GENERATION_BASE, `agent must inherit the process pin, got ${agent[0]}`)

      const keyless = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.5-flash-low')
      assert(keyless[0] === ANTIGRAVITY_GENERATION_BASE, `keyless requests share the pin, got ${keyless[0]}`)

      // Claude-on-Antigravity ignores affinity entirely — pin the process to
      // prod and Claude must still order daily-first.
      recordAntigravityGeminiServedBase('main-session', CODE_ASSIST_BASE)
      const claude = codeAssistGenerationBasesForModel('antigravity', 'claude-sonnet-4-6', 'main-session')
      assert(claude[0] === ANTIGRAVITY_GENERATION_BASE, `claude order must stay daily-first, got ${claude[0]}`)
    } finally {
      _resetAntigravityGeminiAffinityForTest()
    }
  })

  test('pin migrates only after two consecutive fallback serves', () => {
    _resetAntigravityGeminiAffinityForTest()
    try {
      recordAntigravityGeminiServedBase('sess-m', CODE_ASSIST_BASE)
      // One detour (transient network blip re-served by daily) must NOT drag
      // the whole process off the host holding its cache equity.
      recordAntigravityGeminiServedBase('sess-m', ANTIGRAVITY_GENERATION_BASE)
      assert(
        antigravityGeminiStickyBase('sess-m') === CODE_ASSIST_BASE,
        'a single fallback serve must not migrate the pin',
      )
      // A second consecutive detour = the pinned host is really failing.
      recordAntigravityGeminiServedBase('sess-m', ANTIGRAVITY_GENERATION_BASE)
      assert(
        antigravityGeminiStickyBase('sess-m') === ANTIGRAVITY_GENERATION_BASE,
        'two consecutive fallback serves must migrate the pin',
      )
      // A pinned-host serve resets the streak: alternating blips never migrate.
      recordAntigravityGeminiServedBase('sess-m', CODE_ASSIST_BASE) // streak 1
      recordAntigravityGeminiServedBase('sess-m', ANTIGRAVITY_GENERATION_BASE) // pinned serve, reset
      recordAntigravityGeminiServedBase('sess-m', CODE_ASSIST_BASE) // streak 1 again
      assert(
        antigravityGeminiStickyBase('sess-m') === ANTIGRAVITY_GENERATION_BASE,
        'interleaved pinned serves must keep resetting the streak',
      )
    } finally {
      _resetAntigravityGeminiAffinityForTest()
    }
  })

  test('foreign pins are ignored in ordering; keyless requests share the pin', () => {
    _resetAntigravityGeminiAffinityForTest()
    try {
      // A pin that is not in the current base list (env flipped mid-process)
      // must not corrupt the order — default order wins.
      const sandbox = 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal'
      recordAntigravityGeminiServedBase('sess-x', sandbox)
      recordAntigravityGeminiServedBase('sess-x', sandbox)
      const bases = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.5-flash-low', 'sess-x')
      assert(bases[0] === CODE_ASSIST_BASE, `foreign pin must be ignored, got ${bases[0]}`)

      // No session key → same process-wide slot.
      _resetAntigravityGeminiAffinityForTest()
      recordAntigravityGeminiServedBase(undefined, ANTIGRAVITY_GENERATION_BASE)
      const globalBases = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.5-flash-low')
      assert(globalBases[0] === ANTIGRAVITY_GENERATION_BASE, 'keyless requests share the global pin')
    } finally {
      _resetAntigravityGeminiAffinityForTest()
    }
  })

  test('pinned sessions do not status-hop on the first attempt', () => {
    const gemini = 'gemini-3.5-flash-low'
    // Unpinned (first-ever request): transient statuses hop for availability.
    assert(
      shouldTryNextAntigravityGeminiEndpoint('antigravity', gemini, 429, 0, 2) === true,
      'unpinned 429 should hop',
    )
    // Pinned first attempt: stay home — retryWithBackoff retries the pinned
    // host (Retry-After honored) instead of paying a cold on the sibling pool.
    assert(
      shouldTryNextAntigravityGeminiEndpoint('antigravity', gemini, 429, 0, 2, true) === false,
      'pinned first-attempt 429 must NOT hop',
    )
    assert(
      shouldTryNextAntigravityGeminiEndpoint('antigravity', gemini, 503, 0, 2, true) === false,
      'pinned first-attempt 503 must NOT hop',
    )
    // 404 = host does not serve this route — deterministic, hops even pinned.
    assert(
      shouldTryNextAntigravityGeminiEndpoint('antigravity', gemini, 404, 0, 2, true) === true,
      'pinned 404 must still hop',
    )
    // Later chain positions are not the pinned host — flag does not apply.
    assert(
      shouldTryNextAntigravityGeminiEndpoint('antigravity', gemini, 429, 1, 3, true) === true,
      'mid-chain hop must stay allowed',
    )
    // Claude-on-Antigravity never uses this policy at all.
    assert(
      shouldTryNextAntigravityGeminiEndpoint('antigravity', 'claude-sonnet-4-6', 429, 0, 2) === false,
      'claude must not use the gemini hop policy',
    )
  })

  test('legacy project-discovery headers use the same minimal Hub identity', () => {
    const headers = buildApiHeaders('token')
    assert(
      headers['User-Agent'] === ANTIGRAVITY_HUB_USER_AGENT,
      `bad User-Agent: ${headers['User-Agent']}`,
    )
    assert(!('Client-Metadata' in headers), 'project discovery should not send legacy client metadata')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
