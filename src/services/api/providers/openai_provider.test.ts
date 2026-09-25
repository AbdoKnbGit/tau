/**
 * OpenAI provider model catalog invariants.
 *
 * Run: bun run src/services/api/providers/openai_provider.test.ts
 */

import { OpenAIProvider } from './openai_provider.js'
import { OpenRouterProvider } from './openrouter_provider.js'
import { resetOpenRouterContext } from '../../../lanes/openai-compat/openrouter_context.js'
import { MiniMaxProvider } from './minimax_provider.js'
import { MoonshotProvider } from './moonshot_provider.js'
import { PROVIDER_CONFIGS } from '../../../utils/model/configs.js'
import { setOpenAIReasoningLevel } from '../../../utils/model/openaiReasoning.js'

class InspectableOpenAIProvider extends OpenAIProvider {
  reasoningFor(model: string) {
    return this.resolveReasoningEffort(model, undefined)
  }
}

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    resetOpenRouterContext()
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
      const gpt56 = [
        ['gpt-5.6-sol', 'GPT-5.6 Sol'],
        ['gpt-5.6-terra', 'GPT-5.6 Terra'],
        ['gpt-5.6-luna', 'GPT-5.6 Luna'],
      ] as const
      for (const [id, name] of gpt56) {
        const model = models.find(candidate => candidate.id === id)
        assert(model, `expected ${id} in OpenAI /models catalog`)
        assert(model?.name === name, `expected official ${id} display name`)
        assert(model?.contextWindow === 1050000, `expected 1.05M context for ${id}`)
        assert(model?.tags?.includes('reasoning'), `expected reasoning tag for ${id}`)
      }
      const gpt55 = models.find(model => model.id === 'gpt-5.5')
      const sol = models.find(model => model.id === 'gpt-5.6-sol')

      assert(gpt55, 'expected gpt-5.5 in OpenAI /models catalog')
      assert(gpt55?.name === 'GPT-5.5', 'expected curated display name')
      assert(gpt55?.contextWindow === 272000, 'expected codex-main context window')
      assert(sol?.tags?.includes('recommended'), 'expected Sol recommended tag')
      assert(!gpt55?.tags?.includes('recommended'), 'GPT-5.5 should no longer be recommended')
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

    await test('uses conversation-scoped OpenRouter session id in legacy provider', async () => {
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

      const sessionKey = 'tau-session-stable'
      assert(capturedBody?.session_id === sessionKey, `session_id=${capturedBody?.session_id}`)
      assert(capturedBody?.prompt_cache_key === sessionKey,
        `prompt_cache_key=${capturedBody?.prompt_cache_key}`)
      assert(capturedHeaders['x-session-id'] === sessionKey,
        `x-session-id=${capturedHeaders['x-session-id']}`)
    })

    await test('legacy OpenRouter normalizes GPT tool schemas only', async () => {
      const capturedBodies: any[] = []
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        capturedBodies.push(body)
        return new Response(JSON.stringify({
          id: 'chatcmpl-test',
          model: body.model,
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

      const tools = [{
        name: 'Agent',
        description: 'Spawn an agent.',
        input_schema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            subagent_type: { type: 'string' },
            metadata: {
              type: 'object',
              properties: {
                source: { type: 'string', minLength: 1 },
              },
              propertyNames: { pattern: '^[a-z_]+$' },
            },
          },
          required: ['prompt'],
        },
      }, {
        name: 'TaskCreate',
        description: 'Create a task.',
        input_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            description: { type: 'string' },
            metadata: undefined,
          },
          required: ['subject', 'description', 'metadata'],
        },
      }]

      const provider = new OpenRouterProvider({ apiKey: 'sk-or-v1-test-key-1234567890' })
      await provider.create({
        model: 'openai/gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        tools,
        max_tokens: 100,
        sessionId: 'tau-session-stable',
      })
      await provider.create({
        model: 'deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
        tools,
        max_tokens: 100,
        sessionId: 'tau-session-stable',
      })

      const gptParams = capturedBodies[0]?.tools?.[0]?.function?.parameters
      assert(JSON.stringify(gptParams?.required) === JSON.stringify(['prompt', 'subagent_type', 'metadata']),
        `gpt required=${JSON.stringify(gptParams?.required)}`)
      assert(gptParams?.additionalProperties === false,
        `gpt additionalProperties=${JSON.stringify(gptParams?.additionalProperties)}`)
      const gptMetadata = gptParams?.properties?.metadata?.anyOf?.find((schema: any) => schema.type === 'object')
      assert(gptMetadata?.propertyNames === undefined,
        `gpt metadata propertyNames=${JSON.stringify(gptMetadata?.propertyNames)}`)
      assert(gptMetadata?.properties?.source?.minLength === undefined,
        `gpt metadata source=${JSON.stringify(gptMetadata?.properties?.source)}`)
      assert(JSON.stringify(gptMetadata?.required) === JSON.stringify(['source']),
        `gpt metadata required=${JSON.stringify(gptMetadata?.required)}`)

      const gptTaskParams = capturedBodies[0]?.tools?.[1]?.function?.parameters
      assert(gptTaskParams?.properties?.metadata === undefined,
        `gpt task metadata property=${JSON.stringify(gptTaskParams?.properties?.metadata)}`)
      assert(JSON.stringify(gptTaskParams?.required) === JSON.stringify(['subject', 'description']),
        `gpt task required=${JSON.stringify(gptTaskParams?.required)}`)

      const deepseekParams = capturedBodies[1]?.tools?.[0]?.function?.parameters
      assert(JSON.stringify(deepseekParams?.required) === JSON.stringify(['prompt']),
        `deepseek required=${JSON.stringify(deepseekParams?.required)}`)
      assert(deepseekParams?.additionalProperties === undefined,
        `deepseek additionalProperties=${JSON.stringify(deepseekParams?.additionalProperties)}`)
      assert(deepseekParams?.properties?.metadata?.propertyNames !== undefined,
        'deepseek metadata propertyNames should be preserved')
    })

    await test('legacy OpenRouter request keeps cache stable on tool turns', async () => {
      const oldCompression = process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION
      delete process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION

      let capturedBody: any = null
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response(JSON.stringify({
          id: 'chatcmpl-test',
          model: capturedBody.model,
          choices: [{
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        }), { status: 200 })
      }) as unknown as typeof fetch

      try {
        const provider = new OpenRouterProvider({ apiKey: 'sk-or-v1-test-key-1234567890' })
        await provider.create({
          model: 'deepseek/deepseek-v4-flash',
          system: [
            'Stable Tau instructions that should remain cacheable.',
            '# Environment',
            'Working directory: C:\\Users\\ok\\Desktop\\claudex',
            "Today's date is 2026-06-29.",
          ].join('\n'),
          messages: [
            { role: 'user', content: 'start' },
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'src/a.ts' } },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'toolu_read', content: 'file output' },
              ],
            },
            { role: 'user', content: 'continue' },
          ],
          tools: [
            {
              name: 'Read',
              description: 'Read a file from disk.',
              input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
            },
            {
              name: 'Bash',
              description: 'Run a shell command.',
              input_schema: { type: 'object', properties: { command: { type: 'string' } } },
            },
          ],
          max_tokens: 100,
          sessionId: 'tau-session-stable',
        })

        assert(capturedBody?.usage?.include === true,
          `usage.include=${JSON.stringify(capturedBody?.usage)}`)
        assert(capturedBody?.plugins === undefined,
          `context compression should be off by default: ${JSON.stringify(capturedBody?.plugins)}`)

        const systemMessage = capturedBody.messages.find((message: any) => message.role === 'system')
        const systemText = JSON.stringify(systemMessage?.content)
        assert(systemText.includes('Stable Tau instructions'), `system=${systemText}`)
        assert(!systemText.includes('Working directory:'), `volatile tail leaked into system: ${systemText}`)
        const systemPart = systemMessage?.content?.[systemMessage.content.length - 1]
        assert(systemPart?.cache_control?.type === 'ephemeral',
          `system cache_control=${JSON.stringify(systemMessage)}`)

        const dynamicMessage = capturedBody.messages.find((message: any) =>
          Array.isArray(message.content) &&
          message.content.some((part: any) =>
            typeof part?.text === 'string' && part.text.includes('<dynamic_context>')),
        )
        assert(dynamicMessage, `dynamic message missing: ${JSON.stringify(capturedBody.messages)}`)
        assert(!JSON.stringify(dynamicMessage).includes('cache_control'),
          `dynamic context must not be cache-stamped: ${JSON.stringify(dynamicMessage)}`)

        const toolMessage = capturedBody.messages.find((message: any) => message.role === 'tool')
        const toolPart = toolMessage?.content?.[toolMessage.content.length - 1]
        assert(toolPart?.cache_control?.type === 'ephemeral',
          `tool result missing cache_control: ${JSON.stringify(toolMessage)}`)
        const userMessages = capturedBody.messages.filter((message: any) => message.role === 'user')
        const lastUser = userMessages[userMessages.length - 1]
        const lastUserPart = lastUser?.content?.[lastUser.content.length - 1]
        assert(lastUserPart?.cache_control?.type === 'ephemeral',
          `last user missing cache_control: ${JSON.stringify(lastUser)}`)
        assert(capturedBody.tools?.[1]?.cache_control?.type === 'ephemeral',
          `final tool schema missing cache_control: ${JSON.stringify(capturedBody.tools)}`)
      } finally {
        if (oldCompression === undefined) delete process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION
        else process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION = oldCompression
      }
    })

    await test('legacy OpenRouter advances Gemini cache_control to previous completed turn', async () => {
      let capturedBody: any = null
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response(JSON.stringify({
          id: 'chatcmpl-test',
          model: capturedBody.model,
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
        model: 'google/gemini-3-flash-preview',
        system: 'Stable OpenRouter Gemini system prompt.',
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'second question' },
        ],
        tools: [
          {
            name: 'Read',
            description: 'Read a file from disk.',
            input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
          },
        ],
        max_tokens: 100,
        sessionId: 'tau-session-stable',
      })

      const assistantMessage = capturedBody.messages.find((message: any) =>
        message.role === 'assistant' && JSON.stringify(message).includes('first answer'))
      const currentUser = capturedBody.messages.find((message: any) =>
        message.role === 'user' && JSON.stringify(message).includes('second question'))
      assert(assistantMessage?.content?.[0]?.cache_control?.type === 'ephemeral',
        `assistant cache_control=${JSON.stringify(assistantMessage)}`)
      assert(!JSON.stringify(currentUser).includes('"cache_control"'),
        `current user should not be cache-stamped: ${JSON.stringify(currentUser)}`)
      assert(capturedBody.tools?.[0]?.cache_control?.type === 'ephemeral',
        `Gemini tools should carry stable cache_control: ${JSON.stringify(capturedBody.tools)}`)
    })

    await test('resolves OpenRouter free alias in legacy provider', async () => {
      let capturedBody: any = null
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response(JSON.stringify({
          id: 'chatcmpl-test',
          model: capturedBody.model,
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
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        sessionId: 'tau-session-stable',
      })

      const expected = PROVIDER_CONFIGS.openrouter.tiers.free.sonnet
      assert(capturedBody?.model === expected, `model=${capturedBody?.model}`)
    })

    await test('MiniMax legacy /models returns only live provider rows', async () => {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        assert(String(input) === 'https://api.minimax.io/v1/models',
          `unexpected URL ${String(input)}`)
        return new Response(JSON.stringify({
          object: 'list',
          data: [
            { id: 'MiniMax-M3', object: 'model', context_length: 1000000 },
            { id: 'gpt-5.5', object: 'model' },
            { id: 'MiniMax-Speech-2.8', object: 'model' },
          ],
        }), { status: 200 })
      }) as unknown as typeof fetch

      const provider = new MiniMaxProvider({ apiKey: 'test-key' })
      const models = await provider.listModels()
      assert(models.length === 1, `models=${JSON.stringify(models)}`)
      assert(models[0]?.id === 'MiniMax-M3', `model=${models[0]?.id}`)
      assert(models[0]?.contextWindow === 1000000, 'expected live context_length')
      assert(!models.some(model => model.id.startsWith('gpt-')),
        'MiniMax must not fall back to OpenAI model rows')
    })

    await test('Moonshot legacy /models returns only live provider rows', async () => {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        assert(String(input) === 'https://api.moonshot.ai/v1/models',
          `unexpected URL ${String(input)}`)
        return new Response(JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'kimi-k2.7-code',
              object: 'model',
              context_length: 262144,
              supports_reasoning: true,
            },
            { id: 'whisper-large-v3', object: 'model' },
          ],
        }), { status: 200 })
      }) as unknown as typeof fetch

      const provider = new MoonshotProvider({ apiKey: 'test-key' })
      const models = await provider.listModels()
      assert(models.length === 1, `models=${JSON.stringify(models)}`)
      assert(models[0]?.id === 'kimi-k2.7-code', `model=${models[0]?.id}`)
      assert(models[0]?.contextWindow === 262144, 'expected live context_length')
      assert(models[0]?.tags?.includes('reasoning'), 'expected live reasoning flag')
    })

    await test('legacy OpenAI transport sends max only to GPT-5.6', () => {
      const provider = new InspectableOpenAIProvider({ apiKey: 'test-key' })
      setOpenAIReasoningLevel('max')
      assert(provider.reasoningFor('gpt-5.6-sol') === 'max', 'GPT-5.6 should send max')
      assert(provider.reasoningFor('gpt-5.5') === 'xhigh', 'GPT-5.5 should clamp max to xhigh')
      assert(provider.reasoningFor('gpt-5.4') === 'xhigh', 'GPT-5.4 should clamp max to xhigh')
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
