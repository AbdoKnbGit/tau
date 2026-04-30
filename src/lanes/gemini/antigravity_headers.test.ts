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
  wrapForCodeAssist,
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

  test('Claude Antigravity model messages move function calls after text parts', () => {
    const wrapped = wrapForCodeAssist('claude-sonnet-4-6', 'project-id', {
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'Let me check.' },
            {
              functionCall: {
                id: 'call_abc',
                name: 'Read',
                args: { file: 'src/index.ts' },
              },
              thoughtSignature: 'skip_thought_signature_validator',
            },
            { text: 'Reading the file now.' },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_abc',
                name: 'Read',
                response: { content: 'file contents' },
              },
            },
          ],
        },
      ],
    })
    const contents = wrapped.request.contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> }>
    const parts = contents[0]?.parts ?? []
    assert((parts[0] as { text?: string }).text === 'Let me check.', 'first text part should stay first')
    assert((parts[1] as { text?: string }).text === 'Reading the file now.', 'text after tool call should move before it')
    assert(!!parts[2] && 'functionCall' in parts[2], 'functionCall should move to the end')
    assert(contents[1]?.role === 'user', 'functionResponse message should use user role')
  })

  test('Gemini Antigravity model messages keep function-call ordering unchanged', () => {
    const wrapped = wrapForCodeAssist('gemini-3-flash', 'project-id', {
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call_abc', name: 'Read', args: {} } },
            { text: 'Reading the file now.' },
          ],
        },
      ],
    })
    const contents = wrapped.request.contents as Array<{ parts?: Array<Record<string, unknown>> }>
    const parts = contents[0]?.parts ?? []
    assert(!!parts[0] && 'functionCall' in parts[0], 'Gemini functionCall order should not change')
    assert((parts[1] as { text?: string }).text === 'Reading the file now.', 'Gemini text order should not change')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
