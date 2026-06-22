/**
 * Antigravity client identity tests.
 *
 * Run: bun run src/lanes/gemini/antigravity_headers.test.ts
 */

import { ANTIGRAVITY_API_VERSION } from '../../constants/antigravity.js'
import {
  ANTIGRAVITY_GENERATION_BASE,
  CODE_ASSIST_BASE,
  antigravityApiHeaders,
  codeAssistGenerationBase,
  codeAssistGenerationBasesForModel,
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
    assert(ANTIGRAVITY_API_VERSION === '2.0.0', `unexpected Antigravity version: ${ANTIGRAVITY_API_VERSION}`)
    const headers = antigravityApiHeaders('token')
    assert(
      headers['User-Agent']?.startsWith(`antigravity/${ANTIGRAVITY_API_VERSION} `),
      `bad User-Agent: ${headers['User-Agent']}`,
    )
    assert(!('X-Goog-Api-Client' in headers), 'generateContent path should not add X-Goog-Api-Client')
    assert(headers['x-request-source'] === 'local', 'missing local request source')
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

    // Gemini-Antigravity: prod first, daily second (known-good cache), sandbox last.
    const gemini = codeAssistGenerationBasesForModel('antigravity', 'gemini-3.5-flash-low')
    assert(gemini[0] === CODE_ASSIST_BASE, `gemini primary should be prod, got ${gemini[0]}`)
    assert(gemini[1] === ANTIGRAVITY_GENERATION_BASE, `gemini fallback should be daily, got ${gemini[1]}`)
    assert(gemini[2] === sandbox, `gemini last should be sandbox, got ${gemini[2]}`)

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

  test('legacy project-discovery headers use the same Antigravity API version', () => {
    const headers = buildApiHeaders('token')
    assert(
      headers['User-Agent']?.startsWith(`antigravity/${ANTIGRAVITY_API_VERSION} `),
      `bad User-Agent: ${headers['User-Agent']}`,
    )
    assert(headers['Client-Metadata']?.includes('"ideType":"ANTIGRAVITY"'), 'metadata lost Antigravity ideType')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
