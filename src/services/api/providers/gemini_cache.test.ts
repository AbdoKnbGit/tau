/**
 * Gemini API-key explicit cache accounting tests.
 *
 * Run: bun run src/services/api/providers/gemini_cache.test.ts
 */

import {
  _resetGeminiCacheStateForTests,
  getOrCreateCacheWithUsage,
} from './gemini_cache.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
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

async function main(): Promise<void> {
  console.log('gemini explicit cache accounting:')

  await test('returns cache creation token count only on cold create', async () => {
    _resetGeminiCacheStateForTests()
    const oldFetch = globalThis.fetch
    let calls = 0

    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({
        name: 'cachedContents/test-cache',
        usageMetadata: { totalTokenCount: 12345 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const args = {
        model: 'gemini-2.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'test-key',
        systemInstruction: { parts: [{ text: 'x'.repeat(9000) }] },
        tools: undefined,
      }

      const cold = await getOrCreateCacheWithUsage(args)
      assert(cold?.cacheName === 'cachedContents/test-cache', `cacheName=${cold?.cacheName}`)
      assert(cold?.createdTokens === 12345, `createdTokens=${cold?.createdTokens}`)

      const warm = await getOrCreateCacheWithUsage(args)
      assert(warm?.cacheName === 'cachedContents/test-cache', `cacheName=${warm?.cacheName}`)
      assert(warm?.createdTokens === 0, `createdTokens=${warm?.createdTokens}`)
      assert(calls === 1, `fetch calls=${calls}`)
    } finally {
      globalThis.fetch = oldFetch
      _resetGeminiCacheStateForTests()
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
