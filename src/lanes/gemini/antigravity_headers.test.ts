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
    assert(
      ANTIGRAVITY_GENERATION_BASE === 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal',
      `wrong Antigravity generation base: ${ANTIGRAVITY_GENERATION_BASE}`,
    )
    assert(
      codeAssistGenerationBase('cli') === CODE_ASSIST_BASE,
      'Gemini CLI generation base should stay on production Code Assist endpoint',
    )
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
