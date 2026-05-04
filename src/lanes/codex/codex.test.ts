/**
 * Codex lane invariants.
 *
 * Run:  bun run src/lanes/codex/codex.test.ts
 */

import { CodexApiError } from './api.js'
import { codexLane, resolveReasoning, splitCodexSystemForCache } from './loop.js'
import { assembleCodexSystemPrompt } from './prompt.js'
import { getCodexRegistrationByNativeName } from './tools.js'
import { setOpenAIReasoningLevel } from '../../utils/model/openaiReasoning.js'

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
  console.log('codex lane:')

  await test('lists GPT-5.5 with reasoning support', async () => {
    const models = await codexLane.listModels()
    const model = models.find(m => m.id === 'gpt-5.5')
    assert(model, 'expected gpt-5.5 in codex model list')
    assert(model?.contextWindow === 272000, 'expected codex-main context window')
    assert(model?.tags?.includes('reasoning'), 'expected reasoning tag')
  })
  await test('supports gpt-5-codex', () => {
    assert(codexLane.supportsModel('gpt-5-codex'), 'expected support')
  })
  await test('supports gpt-5.5', () => {
    assert(codexLane.supportsModel('gpt-5.5'), 'expected support')
  })
  await test('supports o3-mini', () => {
    assert(codexLane.supportsModel('o3-mini'), 'expected support')
  })
  await test('supports codex-turbo', () => {
    assert(codexLane.supportsModel('codex-turbo'), 'expected support')
  })
  await test('does NOT support claude-*', () => {
    assert(!codexLane.supportsModel('claude-sonnet-4-6'), 'Claude must stay in Claude lane')
  })
  await test('does NOT support gemini-*', () => {
    assert(!codexLane.supportsModel('gemini-2.5-pro'), 'Gemini must stay in Gemini lane')
  })
  await test('does NOT support qwen-*', () => {
    assert(!codexLane.supportsModel('qwen3-coder-plus'), 'Qwen must go to Qwen lane')
  })

  await test('smallFastModel returns gpt-5.4-mini', () => {
    assert(codexLane.smallFastModel?.() === 'gpt-5.4-mini', 'expected gpt-5.4-mini')
  })
  await test('explicit xhigh reasoning reaches Responses request config', () => {
    setOpenAIReasoningLevel('xhigh')
    const reasoning = resolveReasoning({ type: 'disabled' }, 'gpt-5.5')
    assert(reasoning?.effort === 'xhigh', `expected xhigh; got ${reasoning?.effort}`)
  })

  await test('tool registry has apply_patch', () => {
    const r = getCodexRegistrationByNativeName('apply_patch')
    assert(r != null, 'apply_patch missing from Codex tool registry')
  })

  await test('stable slot byte-identical across turns when volatile changes', () => {
    const base = { toolsAddendum: '', mcpIntro: '', skillsContext: '', customInstructions: 'c' }
    const t1 = assembleCodexSystemPrompt('gpt-5-codex', {
      ...base, memory: 'a', environment: 'e1', gitStatus: 'g1',
    })
    const t2 = assembleCodexSystemPrompt('gpt-5-codex', {
      ...base, memory: 'b', environment: 'e2', gitStatus: 'g2',
    })
    assert(String(t1.stable) === String(t2.stable), 'stable drifted between turns')
    assert(String(t1.volatile) !== String(t2.volatile), 'volatile should differ')
  })
  await test('apply_patch mentioned in stable preamble', () => {
    const p = assembleCodexSystemPrompt('gpt-5-codex', {
      memory: '', environment: '', gitStatus: '',
      toolsAddendum: '', mcpIntro: '', skillsContext: '', customInstructions: '',
    })
    assert(String(p.stable).includes('apply_patch'),
      'codex system prompt should call out apply_patch as the edit primitive')
  })

  await test('CodexApiError detects context_length_exceeded as prompt-too-long', () => {
    const err = new CodexApiError(400, JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'maximum context length 128000' },
    }))
    assert(err.isPromptTooLong, 'context_length_exceeded should be classified as PTL')
    assert(err.message.startsWith('Prompt is too long'),
      `message should lead with PTL prefix; got: ${err.message.slice(0, 60)}`)
  })
  await test('CodexApiError non-PTL error has normal prefix', () => {
    const err = new CodexApiError(500, 'internal server error')
    assert(!err.isPromptTooLong, 'should not classify 500 as PTL')
    assert(err.message.startsWith('OpenAI Responses API error'),
      `got: ${err.message.slice(0, 60)}`)
  })
  await test('CodexApiError 429 is retryable, 400 is not', () => {
    assert(new CodexApiError(429, '').isRetryable, '429 should be retryable')
    assert(!new CodexApiError(400, '').isRetryable, '400 should NOT be retryable')
  })

  // ── splitCodexSystemForCache: cache-stability invariants ─────────
  // These guard the surgical fix for "cache hits but is unstable" on
  // tool-heavy / model-swap sessions. The Responses API hashes the
  // `instructions` field as part of the prompt-cache prefix; if env /
  // git / memory bytes leak in, every turn's hash drifts and the cache
  // misses past the first divergence.

  await test('splitCodexSystemForCache splits at SYSTEM_PROMPT_DYNAMIC_BOUNDARY', () => {
    const text = 'STATIC PREAMBLE\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\nDYNAMIC TAIL'
    const { stable, volatile } = splitCodexSystemForCache(text)
    assert(stable === 'STATIC PREAMBLE', `stable=${JSON.stringify(stable)}`)
    assert(volatile === 'DYNAMIC TAIL', `volatile=${JSON.stringify(volatile)}`)
  })

  await test('splitCodexSystemForCache: stable bytes identical across env-only churn', () => {
    // Simulate a long static preamble (so the 70%-tail cutoff is well
    // past the static section) followed by an env block whose
    // timestamp / git status changes turn-to-turn.
    const preamble = 'You are Codex.\n'.repeat(200)
    const env1 = '<env>\nWorking directory: /a\nDate: 2026-05-04T12:00:00Z\n</env>'
    const env2 = '<env>\nWorking directory: /a\nDate: 2026-05-04T12:05:33Z\n</env>'
    const a = splitCodexSystemForCache(preamble + env1)
    const b = splitCodexSystemForCache(preamble + env2)
    assert(a.stable === b.stable, 'stable drifted across env-only change')
    assert(a.volatile !== b.volatile, 'volatile should differ')
    assert(!a.stable.includes('<env>'), 'env leaked into stable slot')
  })

  await test('splitCodexSystemForCache: stable byte-stable across git status churn', () => {
    const preamble = '# Codex preamble\n'.repeat(200)
    const tail1 = '# gitStatus\nbranch: main · clean'
    const tail2 = '# gitStatus\nbranch: main · 1 modified'
    const a = splitCodexSystemForCache(`${preamble}\n${tail1}`)
    const b = splitCodexSystemForCache(`${preamble}\n${tail2}`)
    assert(a.stable === b.stable, 'stable drifted on git status flip')
    assert(a.volatile !== b.volatile, 'volatile should reflect git delta')
  })

  await test('splitCodexSystemForCache: no-volatile input passes through', () => {
    const text = 'Just a static prompt with no env or git markers anywhere.'
    const { stable, volatile } = splitCodexSystemForCache(text)
    assert(stable === text, 'stable should equal full text')
    assert(volatile === '', `volatile should be empty; got ${JSON.stringify(volatile)}`)
  })

  await test('splitCodexSystemForCache: empty input returns empty pair', () => {
    const { stable, volatile } = splitCodexSystemForCache('')
    assert(stable === '', `stable=${JSON.stringify(stable)}`)
    assert(volatile === '', `volatile=${JSON.stringify(volatile)}`)
  })

  await test('splitCodexSystemForCache: env mention in prompt body (head 70%) is NOT volatile', () => {
    // A tool description in the middle of the prompt mentions <env>;
    // we must not strip it just because the substring matches.
    const head = '<env>\nfake context\n</env>\n' + 'X'.repeat(5000)
    const { stable, volatile } = splitCodexSystemForCache(head)
    assert(stable === head, 'should leave head-occurring matches alone')
    assert(volatile === '', 'no volatile expected from head-region match')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
