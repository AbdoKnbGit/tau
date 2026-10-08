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
  codeAssistGenerationBases,
  antigravityGenerationHostCount,
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
    // Native Antigravity uses the non-sandbox daily generation endpoint.
    assert(
      ANTIGRAVITY_GENERATION_BASE === 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      `wrong Antigravity generation base: ${ANTIGRAVITY_GENERATION_BASE}`,
    )
    assert(
      codeAssistGenerationBase('cli') === CODE_ASSIST_BASE,
      'Gemini CLI generation base should stay on production Code Assist endpoint',
    )
  })

  test('all Antigravity models and request sources use daily only', () => {
    for (const model of ['gemini-3.8-flash-high', 'gemini-3.5-flash-low', 'claude-sonnet-4-6', 'claude-opus-5-5-high']) {
      for (const source of [undefined, 'repl_main_thread', 'agent:default', 'report', 'compact', 'quota_check']) {
        const bases = codeAssistGenerationBasesForModel('antigravity', model, 'session', source)
        assert(bases.length === 1 && bases[0] === ANTIGRAVITY_GENERATION_BASE,
          model + '/' + source + ': generation left daily')
      }
      assert(antigravityGenerationHostCount(model) === 1, model + ': multiple hosts counted')
    }
    assert(codeAssistGenerationBases('antigravity').join() === ANTIGRAVITY_GENERATION_BASE,
      'executor-level routing must also use daily only')
    assert(codeAssistGenerationBasesForModel('cli', 'gemini-2.5-pro').join() === CODE_ASSIST_BASE,
      'Gemini CLI routing must stay unchanged')
  })

  test('retired endpoint overrides cannot restore production or sandbox generation', () => {
    const previous = process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
    try {
      for (const value of ['prod', 'daily', 'sandbox', 'unknown']) {
        process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT = value
        const bases = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.8-flash-high')
        assert(bases.length === 1 && bases[0] === ANTIGRAVITY_GENERATION_BASE,
          'legacy override ' + value + ' changed the generation host')
      }
    } finally {
      if (previous === undefined) delete process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
      else process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT = previous
    }
  })

  test('cold and warm requests share the bridge deadline without an early restart', () => {
    const names = ['TAU_ANTIGRAVITY_GEMINI_ENDPOINT_TIMEOUT_MS', 'TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS']
    const previous = names.map(name => process.env[name])
    try {
      for (const name of names) process.env[name] = '1'
      for (const pinned of [false, true]) {
        assert(antigravityGeminiEndpointTimeoutMs(0, 1, pinned) === 0,
          'retired timeout override must not cancel a healthy daily request')
      }
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name]
        else process.env[name] = previous[index]
      })
    }
  })

  test('agents and keyless calls retain the successful daily host', () => {
    _resetAntigravityGeminiAffinityForTest()
    try {
      recordAntigravityGeminiServedBase('main-session', ANTIGRAVITY_GENERATION_BASE)
      for (const session of ['main-session', 'tau-agent-xyz', undefined]) {
        assert(antigravityGeminiStickyBase(session) === ANTIGRAVITY_GENERATION_BASE,
          'daily success was not shared with ' + session)
        assert(codeAssistGenerationBasesForModel('antigravity', 'gemini-3.8-flash-high', session).join()
          === ANTIGRAVITY_GENERATION_BASE, 'session left daily')
      }
    } finally {
      _resetAntigravityGeminiAffinityForTest()
    }
  })

  test('historical production or sandbox pins cannot replace daily', () => {
    _resetAntigravityGeminiAffinityForTest()
    try {
      const foreign = [CODE_ASSIST_BASE, 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal']
      for (const base of foreign) recordAntigravityGeminiServedBase('old-session', base)
      assert(antigravityGeminiStickyBase('old-session') === undefined, 'foreign host was retained')
      recordAntigravityGeminiServedBase('main-session', ANTIGRAVITY_GENERATION_BASE)
      for (const base of foreign) recordAntigravityGeminiServedBase('old-session', base)
      assert(antigravityGeminiStickyBase('main-session') === ANTIGRAVITY_GENERATION_BASE,
        'foreign host replaced daily')
    } finally {
      _resetAntigravityGeminiAffinityForTest()
    }
  })

  test('no HTTP status enables cross-host retry', () => {
    for (const model of ['gemini-3.8-flash-high', 'claude-sonnet-4-6']) {
      for (const status of [400, 401, 403, 404, 408, 429, 499, 500, 502, 503, 504]) {
        for (const pinned of [false, true]) {
          assert(!shouldTryNextAntigravityGeminiEndpoint('antigravity', model, status, 0, 2, pinned),
            model + ': HTTP ' + status + ' enabled a host hop')
        }
      }
    }
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
