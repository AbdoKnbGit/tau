/**
 * OpenAI provider model catalog invariants.
 *
 * Run: bun run src/services/api/providers/openai_provider.test.ts
 */

import { OpenAIProvider } from './openai_provider.js'
import { OpenRouterProvider } from './openrouter_provider.js'

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
  console.log('openai provider:')

  const originalFetch = globalThis.fetch
  try {
    await test('shows only current curated OpenAI GPT-5 models', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({
          data: [
            { id: 'gpt-4.1' },
            { id: 'o3' },
            { id: 'gpt-5.3-codex' },
            { id: 'gpt-5.2' },
          ],
        }), { status: 200 })) as unknown as typeof fetch

      const provider = new OpenAIProvider({ apiKey: 'test-key' })
      const models = await provider.listModels()
      const gpt55 = models.find(model => model.id === 'gpt-5.5')

      assert(gpt55, 'expected gpt-5.5 in OpenAI /models catalog')
      assert(gpt55?.name === 'GPT-5.5', 'expected curated display name')
      assert(gpt55?.contextWindow === 272000, 'expected codex-main context window')
      assert(gpt55?.tags?.includes('recommended'), 'expected recommended tag')
      assert(models.some(model => model.id === 'gpt-5.4'), 'expected gpt-5.4 in OpenAI catalog')
      assert(models.some(model => model.id === 'gpt-5.4-mini'), 'expected gpt-5.4-mini in OpenAI catalog')
      assert(!models.some(model => model.id === 'gpt-5.3-codex'), 'gpt-5.3 must not be shown')
      assert(!models.some(model => model.id === 'gpt-5.2'), 'gpt-5.2 must not be shown')
      assert(!models.some(model => model.id === 'gpt-4.1'), 'unscoped live API model must not be shown')
    })

    await test('uses Tau session id as OpenAI prompt cache key', async () => {
      let capturedUrl = ''
      let capturedBody: any = null
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input)
        capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response(JSON.stringify({
          id: 'chatcmpl-test',
          model: 'gpt-5.4-mini',
          choices: [{
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        }), { status: 200 })
      }) as unknown as typeof fetch

      const provider = new OpenAIProvider({ apiKey: 'test-key' })
      await provider.create({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        sessionId: 'tau-session-stable',
      })

      assert(capturedUrl.endsWith('/chat/completions'), `unexpected URL ${capturedUrl}`)
      assert(capturedBody?.prompt_cache_key === 'tau-session-stable',
        `prompt_cache_key=${capturedBody?.prompt_cache_key}`)
    })

    await test('uses model-scoped OpenRouter session id in legacy provider', async () => {
      let capturedHeaders: Record<string, string> = {}
      let capturedBody: any = null
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>
        capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response(JSON.stringify({
          id: 'chatcmpl-test',
          model: 'tencent/hy3-preview',
          choices: [{
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        }), { status: 200 })
      }) as unknown as typeof fetch

      const provider = new OpenRouterProvider({ apiKey: 'sk-or-v1-test-key-1234567890' })
      await provider.create({
        model: 'tencent/hy3-preview',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        sessionId: 'tau-session-stable',
      })

      const sessionKey = 'tau-session-stable:tencent/hy3-preview'
      assert(capturedBody?.session_id === sessionKey, `session_id=${capturedBody?.session_id}`)
      assert(capturedBody?.prompt_cache_key === sessionKey,
        `prompt_cache_key=${capturedBody?.prompt_cache_key}`)
      assert(capturedHeaders['x-session-id'] === sessionKey,
        `x-session-id=${capturedHeaders['x-session-id']}`)
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
