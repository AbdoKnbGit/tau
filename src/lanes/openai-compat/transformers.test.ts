/**
 * Per-provider transformer regression tests.
 *
 * Every transformer in the registry must:
 *   - Declare an id that matches its registry key.
 *   - Expose a defaultBaseUrl that looks like an HTTPS(S)/http URL.
 *   - Implement all 8 required methods (compile-time via the interface,
 *     behavioral here).
 *   - Produce a sensible schemaDropList (contains the universal '$schema').
 *   - Produce a non-empty contextExceededMarkers list.
 *   - Return a valid edit-format + cache-control mode.
 *
 * Plus a few targeted checks that guard against the specific quirks
 * each transformer is supposed to fix:
 *   - DeepSeek clamps max_tokens at 8192, toggles thinking, and repairs
 *     strict tool-call adjacency before sending replayed history.
 *   - Groq normalizes reasoning → reasoning_content on the delta.
 *   - Mistral rewrites tool_choice: "required" → "any".
 *   - NIM deletes stream_options.
 *   - Ollama deletes stream_options.
 *   - OpenRouter emits app-attribution headers.
 *
 * Run:  bun run src/lanes/openai-compat/transformers.test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRANSFORMERS, getTransformer } from './transformers/index.js'
import {
  _resetOpenRouterAutoPinForTest,
  recordOpenRouterServedProvider,
} from './transformers/openrouter.js'
import type { Transformer, TransformContext } from './transformers/base.js'
import type { OpenAIChatMessage, OpenAIChatRequest } from './transformers/shared_types.js'
import { selectEditToolSet, OPENAI_COMPAT_TOOL_REGISTRY } from './tools.js'
import { resolveEditFormat, resolveCapabilities } from './capabilities.js'
import {
  _resetDeepSeekThinkingForTests,
  cycleDeepSeekEffort,
  DEEPSEEK_EFFORT_LEVELS,
  getDeepSeekEffort,
  getDeepSeekEffortLabel,
  isDeepSeekV4ThinkingModel,
  resolveDeepSeekRequestEffort,
  supportsDeepSeekEffortSelection,
} from '../../utils/model/deepseekThinking.js'
import { setGlmThinking } from '../../utils/model/glmThinking.js'
import {
  _resetOpencodeThinkingForTests,
  opencodeEffortLevelsFor,
  setOpencodeEffort,
  supportsOpencodeThinkingSelection,
} from '../../utils/model/opencodeThinking.js'
import {
  _resetClineThinkingForTests,
  setClineEffort,
  supportsClineThinkingSelection,
} from '../../utils/model/clineThinking.js'
import {
  _resetCloudflareThinkingForTests,
  cloudflareEffortLevelsForModel,
  setCloudflareEffort,
  supportsCloudflareThinkingSelection,
} from '../../utils/model/cloudflareThinking.js'

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

function mkCtx(model: string, isReasoning = false): TransformContext {
  return { model, isReasoning, reasoningEffort: isReasoning ? 'medium' : null }
}

function mkBody(model: string, overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 4096,
    ...overrides,
  }
}

function mkToolCall(id: string, name = 'Read'): NonNullable<OpenAIChatMessage['tool_calls']>[number] {
  return {
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  }
}

function withTempClineThinkingStore(fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tau-cline-thinking-'))
  const oldStore = process.env.TAU_CLINE_THINKING_STORE
  process.env.TAU_CLINE_THINKING_STORE = join(dir, 'store.json')
  _resetClineThinkingForTests()
  try {
    fn()
  } finally {
    if (oldStore === undefined) delete process.env.TAU_CLINE_THINKING_STORE
    else process.env.TAU_CLINE_THINKING_STORE = oldStore
    _resetClineThinkingForTests()
    rmSync(dir, { recursive: true, force: true })
  }
}

function withTempCloudflareThinkingStore(fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tau-cloudflare-thinking-'))
  const oldStore = process.env.TAU_CLOUDFLARE_THINKING_STORE
  process.env.TAU_CLOUDFLARE_THINKING_STORE = join(dir, 'store.json')
  _resetCloudflareThinkingForTests()
  try {
    fn()
  } finally {
    if (oldStore === undefined) delete process.env.TAU_CLOUDFLARE_THINKING_STORE
    else process.env.TAU_CLOUDFLARE_THINKING_STORE = oldStore
    _resetCloudflareThinkingForTests()
    rmSync(dir, { recursive: true, force: true })
  }
}

function withTempOpencodeThinkingStore(fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tau-opencode-thinking-'))
  const oldStore = process.env.TAU_OPENCODE_THINKING_STORE
  process.env.TAU_OPENCODE_THINKING_STORE = join(dir, 'store.json')
  _resetOpencodeThinkingForTests()
  try {
    fn()
  } finally {
    if (oldStore === undefined) delete process.env.TAU_OPENCODE_THINKING_STORE
    else process.env.TAU_OPENCODE_THINKING_STORE = oldStore
    _resetOpencodeThinkingForTests()
    rmSync(dir, { recursive: true, force: true })
  }
}

function main(): void {
  console.log('openai-compat transformers:')

  // ── Registry invariants ─────────────────────────────────────────
  const ids: Array<Transformer['id']> = [
    'deepseek', 'glm', 'groq', 'mistral', 'nim', 'ollama', 'openrouter',
    'agentrouter', 'opencode', 'opencodego', 'cloudflare', 'generic',
  ]
  for (const id of ids) {
    test(`registry has ${id}`, () => {
      const t = TRANSFORMERS[id]
      assert(t != null, `missing ${id}`)
      assert(t.id === id, `id mismatch: got ${t.id}`)
      assert(/^https?:\/\//.test(t.defaultBaseUrl),
        `invalid defaultBaseUrl: ${t.defaultBaseUrl}`)
    })
  }

  test('execute_command exposes tracked background execution', () => {
    const command = OPENAI_COMPAT_TOOL_REGISTRY.find(r => r.nativeName === 'execute_command')
    assert(command != null, 'execute_command missing from compat registry')
    const props = (command!.nativeSchema.properties ?? {}) as Record<string, unknown>
    assert('run_in_background' in props, 'execute_command schema must expose run_in_background')
    assert(command!.nativeDescription.includes('run_in_background=true'), 'description must steer to run_in_background')
    assert(command!.nativeDescription.includes('echo $!'), 'description must warn against pid capture')
    assert(command!.nativeDescription.includes('docker compose up -d'), 'description must warn against Docker detach')
    const input = command!.adaptInput({
      command: 'npm run dev > "$TMPDIR/app.log" 2>&1',
      run_in_background: true,
    } as any) as any
    assert(input.run_in_background === true, 'adaptInput must forward run_in_background')
  })

  test('OpenCode Go exposes GLM-5.2 thinking (Default/High/Max) but not Qwen3.7 Max', () => {
    assert(
      supportsOpencodeThinkingSelection('opencodego', 'glm-5.2'),
      'GLM-5.2 now exposes a reasoning_effort selector',
    )
    assert(
      opencodeEffortLevelsFor('glm-5.2').join(',') === 'default,high,max',
      `unexpected GLM-5.2 levels: ${opencodeEffortLevelsFor('glm-5.2').join(',')}`,
    )
    assert(
      !supportsOpencodeThinkingSelection('opencodego', 'qwen3.7-max'),
      'Qwen3.7 Max must not expose unsupported effort controls',
    )
    assert(
      supportsOpencodeThinkingSelection('opencode', 'qwen3.7-max'),
      'normal Zen selection behavior must remain unchanged',
    )
  })

  test('OpenCode Go translates GLM-5.2 effort into reasoning_effort (high|max), dropping the zai thinking object', () => {
    withTempOpencodeThinkingStore(() => {
      // High → reasoning_effort:'high', zai-style thinking controls dropped.
      setOpencodeEffort('glm-5.2', 'high')
      const high = mkBody('glm-5.2') as OpenAIChatRequest & Record<string, any>
      high.thinking = { type: 'enabled', clear_thinking: false }
      high.enable_thinking = true
      high.chat_template_args = { enable_thinking: true }
      TRANSFORMERS.opencodego.transformRequest(high, mkCtx('glm-5.2', false))
      assert(high.reasoning_effort === 'high', `high reasoning_effort=${high.reasoning_effort}`)
      assert(high.thinking === undefined, `high thinking=${JSON.stringify(high.thinking)}`)
      assert(high.enable_thinking === undefined, `high enable_thinking=${high.enable_thinking}`)
      assert(high.chat_template_args === undefined,
        `high chat_template_args=${JSON.stringify(high.chat_template_args)}`)

      // Max → reasoning_effort:'max' (top-level is valid on Go, unlike Cloudflare).
      setOpencodeEffort('glm-5.2', 'max')
      const max = mkBody('glm-5.2') as OpenAIChatRequest & Record<string, any>
      TRANSFORMERS.opencodego.transformRequest(max, mkCtx('glm-5.2', false))
      assert(max.reasoning_effort === 'max', `max reasoning_effort=${max.reasoning_effort}`)

      // Default → no reasoning_effort and no thinking object (upstream default).
      setOpencodeEffort('glm-5.2', 'default')
      const def = mkBody('glm-5.2') as OpenAIChatRequest & Record<string, any>
      def.thinking = { type: 'enabled', clear_thinking: false }
      TRANSFORMERS.opencodego.transformRequest(def, mkCtx('glm-5.2', false))
      assert(def.reasoning_effort === undefined, `default reasoning_effort=${def.reasoning_effort}`)
      assert(def.thinking === undefined, `default thinking=${JSON.stringify(def.thinking)}`)
    })
  })

  test('normal OpenCode Zen GLM request behavior is unchanged', () => {
    const body = mkBody('glm-5.2')
    TRANSFORMERS.opencode.transformRequest(body, mkCtx('glm-5.2', false))
    assert(body.thinking !== undefined, 'Zen GLM thinking behavior was unexpectedly changed')
  })

  test('OpenCode Go hides only the requested MiMo model IDs', () => {
    const raw = [
      { id: 'mimo-v2-omni' },
      { id: 'mimo-v2-pro' },
      { id: 'mimo-v2.5' },
      { id: 'mimo-v2.5-pro' },
      { id: 'glm-5.2' },
      { id: 'qwen3.7-max' },
    ]
    const filtered = TRANSFORMERS.opencodego.filterModelCatalog?.(raw) ?? raw
    const modelIds = filtered.map(model => model.id)
    assert(!modelIds.includes('mimo-v2-omni'), 'mimo-v2-omni was not removed')
    assert(!modelIds.includes('mimo-v2-pro'), 'mimo-v2-pro was not removed')
    assert(!modelIds.includes('mimo-v2.5'), 'mimo-v2.5 was not removed')
    assert(modelIds.includes('mimo-v2.5-pro'), 'mimo-v2.5-pro should remain available')
    assert(modelIds.includes('glm-5.2'), 'GLM-5.2 should remain available')
    assert(modelIds.includes('qwen3.7-max'), 'Qwen3.7 Max should remain available')
  })

  test('OpenCode Go strips the detailed-usage flag on Kimi and GLM rows', () => {
    const kimi = mkBody('kimi-k2.6') as OpenAIChatRequest & Record<string, any>
    kimi.usage = { include: true }
    TRANSFORMERS.opencodego.transformRequest(kimi, mkCtx('kimi-k2.6'))
    assert(kimi.usage === undefined, `kimi usage=${JSON.stringify(kimi.usage)}`)

    const kimiCode = mkBody('kimi-k2.7-code') as OpenAIChatRequest & Record<string, any>
    kimiCode.usage = { include: true }
    TRANSFORMERS.opencodego.transformRequest(kimiCode, mkCtx('kimi-k2.7-code'))
    assert(kimiCode.usage === undefined, 'whole kimi family must drop the flag')

    // GLM's strict upstream 400s on the non-standard `usage` field
    // ("Extra inputs are not permitted, field: 'usage'"), so it is dropped too.
    const glm = mkBody('glm-5.2') as OpenAIChatRequest & Record<string, any>
    glm.usage = { include: true }
    TRANSFORMERS.opencodego.transformRequest(glm, mkCtx('glm-5.2'))
    assert(glm.usage === undefined, `glm usage must be dropped=${JSON.stringify(glm.usage)}`)

    // A row with no such restriction keeps the flag (e.g. deepseek).
    const deepseek = mkBody('deepseek-v4-flash') as OpenAIChatRequest & Record<string, any>
    deepseek.usage = { include: true }
    TRANSFORMERS.opencodego.transformRequest(deepseek, mkCtx('deepseek-v4-flash'))
    assert(deepseek.usage !== undefined, 'rows without the restriction keep the flag')
  })

  test('OpenCode Go small-fast routes qwen/deepseek to deepseek-v4-flash', () => {
    assert(TRANSFORMERS.opencodego.smallFastModel!('qwen3.7-max') === 'deepseek-v4-flash',
      'qwen main model must not fall back to the no-cache qwen3.5-plus row')
    assert(TRANSFORMERS.opencodego.smallFastModel!('deepseek-v4-pro') === 'deepseek-v4-flash',
      'deepseek family must use the flash row instead of reusing the main model')
    assert(TRANSFORMERS.opencodego.smallFastModel!('glm-5.1') === 'glm-5',
      'non-overridden families must keep Zen mapping')
    assert(TRANSFORMERS.opencode.smallFastModel!('qwen3.7-max') === 'qwen3.5-plus',
      'Zen small-fast mapping must remain unchanged')
  })

  for (const id of ids) {
    test(`${id} schemaDropList contains $schema`, () => {
      const drop = TRANSFORMERS[id].schemaDropList()
      assert(drop.has('$schema'), `${id} drop list missing $schema`)
    })
    test(`${id} contextExceededMarkers non-empty`, () => {
      const m = TRANSFORMERS[id].contextExceededMarkers()
      assert(Array.isArray(m) && m.length > 0, `${id} missing PTL markers`)
    })
  }

  // ── DeepSeek max_tokens clamp ───────────────────────────────────
  test('cloudflare stamps session ID for cache affinity', () => {
    const body = mkBody('@cf/openai/gpt-oss-20b')
    TRANSFORMERS.cloudflare.transformRequest(body, {
      ...mkCtx('@cf/openai/gpt-oss-20b'),
      sessionId: 'session-fixed',
    })
    assert(body.prompt_cache_key === 'session-fixed',
      `prompt_cache_key=${body.prompt_cache_key}`)
    assert(body.user === 'session-fixed', `user=${body.user}`)
    const headers = TRANSFORMERS.cloudflare.buildHeaders?.('test', {
      model: '@cf/openai/gpt-oss-20b',
      sessionId: 'session-fixed',
    }) ?? {}
    assert(headers['x-session-affinity'] === 'session-fixed',
      `x-session-affinity=${headers['x-session-affinity']}`)
  })

  test('cloudflare prefers live model catalog with a fallback list', () => {
    assert(TRANSFORMERS.cloudflare.preferLiveModelCatalog?.() === true,
      'expected Cloudflare to prefer live /models')
    const fallback = TRANSFORMERS.cloudflare.staticCatalog?.() ?? []
    const ids = fallback.map(model => model.id)
    assert(ids.includes('@cf/zai-org/glm-5.2'),
      'expected glm-5.2 fallback')
    assert(ids.includes('@cf/moonshotai/kimi-k2.7-code'),
      'expected kimi-k2.7-code fallback')
    assert(ids.includes('@cf/openai/gpt-oss-120b'),
      'expected gpt-oss-120b fallback')
    assert(ids.includes('@cf/openai/gpt-oss-20b'),
      'expected gpt-oss-20b fallback')
  })

  test('cloudflare exposes thinking effort only for models with supported variants', () => {
    assert(
      supportsCloudflareThinkingSelection('@cf/zai-org/glm-5.2', ['reasoning']),
      'GLM-5.2 should expose Cloudflare effort selection',
    )
    assert(
      supportsCloudflareThinkingSelection('@cf/openai/gpt-oss-120b', ['reasoning']),
      'GPT-OSS should expose Cloudflare effort selection',
    )
    assert(
      !supportsCloudflareThinkingSelection('@cf/moonshotai/kimi-k2.7-code', ['reasoning']),
      'Kimi K2.7 should not expose an unsupported effort selector',
    )
    assert(
      !supportsCloudflareThinkingSelection('@cf/google/gemma-4-26b-a4b-it', ['reasoning']),
      'Gemma 4 should not expose an unsupported effort selector',
    )
  })

  test('cloudflare GLM-5.2 uses high/max effort levels only', () => {
    const levels = cloudflareEffortLevelsForModel('@cf/zai-org/glm-5.2')
    assert(levels.join(',') === 'default,high,max',
      `unexpected GLM-5.2 levels: ${levels.join(',')}`)
  })

  test('cloudflare GLM-5.2 sends provider-specific high/max thinking payloads', () => {
    withTempCloudflareThinkingStore(() => {
      const model = '@cf/zai-org/glm-5.2'
      setCloudflareEffort(model, 'high')
      const high = mkBody(model)
      TRANSFORMERS.cloudflare.transformRequest(high, mkCtx(model, true))
      assert(high.reasoning_effort === 'high',
        `high reasoning_effort=${high.reasoning_effort}`)
      assert((high as any).chat_template_kwargs?.enable_thinking === true,
        `high chat_template_kwargs=${JSON.stringify((high as any).chat_template_kwargs)}`)
      assert((high as any).chat_template_kwargs?.reasoning_effort === 'high',
        `high chat_template_kwargs=${JSON.stringify((high as any).chat_template_kwargs)}`)

      setCloudflareEffort(model, 'max')
      const max = mkBody(model)
      TRANSFORMERS.cloudflare.transformRequest(max, mkCtx(model, true))
      assert(max.reasoning_effort === undefined,
        `max must not send invalid top-level reasoning_effort=${max.reasoning_effort}`)
      assert((max as any).chat_template_kwargs?.reasoning_effort === 'max',
        `max chat_template_kwargs=${JSON.stringify((max as any).chat_template_kwargs)}`)
    })
  })

  test('cloudflare default effort does not inherit the global reasoning cycle', () => {
    withTempCloudflareThinkingStore(() => {
      const model = '@cf/zai-org/glm-5.2'
      setCloudflareEffort(model, 'default')
      const body = mkBody(model)
      TRANSFORMERS.cloudflare.transformRequest(body, mkCtx(model, true))
      assert(body.reasoning_effort === undefined,
        `default reasoning_effort=${body.reasoning_effort}`)
      assert((body as any).chat_template_kwargs === undefined,
        `default chat_template_kwargs=${JSON.stringify((body as any).chat_template_kwargs)}`)
    })
  })

  test('cloudflare GPT-OSS sends OpenAI-style effort payloads', () => {
    withTempCloudflareThinkingStore(() => {
      const model = '@cf/openai/gpt-oss-120b'
      setCloudflareEffort(model, 'medium')
      const body = mkBody(model)
      TRANSFORMERS.cloudflare.transformRequest(body, mkCtx(model, false))
      assert(body.reasoning_effort === 'medium',
        `reasoning_effort=${body.reasoning_effort}`)
      assert(body.reasoning?.effort === 'medium',
        `reasoning=${JSON.stringify(body.reasoning)}`)
    })
  })

  test('glm disables thinking when picker toggle is OFF', () => {
    setGlmThinking(false)
    try {
      for (const model of ['glm-5.1', 'glm-5-turbo', 'glm-5', 'glm-4.7']) {
        const body = mkBody(model)
        // The picker toggle is authoritative for GLM; /thinking does not drive it.
        TRANSFORMERS.glm.transformRequest(body, mkCtx(model, true))
        assert(body.thinking?.type === 'disabled', `${model} thinking=${JSON.stringify(body.thinking)}`)
      }
    } finally {
      setGlmThinking(false)
    }
  })
  test('glm enables thinking when picker toggle is ON', () => {
    setGlmThinking(true)
    try {
      for (const model of ['glm-5.1', 'glm-5-turbo', 'glm-5', 'glm-4.7']) {
        const body = mkBody(model)
        TRANSFORMERS.glm.transformRequest(body, mkCtx(model, false))
        assert(body.thinking?.type === 'enabled', `${model} thinking=${JSON.stringify(body.thinking)}`)
      }
    } finally {
      setGlmThinking(false)
    }
  })

  test('cline exposes picker thinking control for DeepSeek V4 free rows', () => {
    assert(
      supportsClineThinkingSelection('deepseek/deepseek-v4-flash-free'),
      'expected DeepSeek V4 free to expose Cline thinking effort',
    )
  })
  test('cline disables reasoning when picker effort is Off', () => {
    withTempClineThinkingStore(() => {
      const model = 'deepseek/deepseek-v4-flash-free'
      setClineEffort(model, 'none')
      const body = mkBody(model)
      TRANSFORMERS.cline.transformRequest(body, mkCtx(model, true))
      assert((body.reasoning as any)?.enabled === false, `reasoning=${JSON.stringify(body.reasoning)}`)
      assert(body.reasoning_effort === undefined, `reasoning_effort=${body.reasoning_effort}`)
    })
  })
  test('cline sends selected per-model thinking effort', () => {
    withTempClineThinkingStore(() => {
      const model = 'deepseek/deepseek-v4-flash-free'
      setClineEffort(model, 'high')
      const body = mkBody(model)
      TRANSFORMERS.cline.transformRequest(body, mkCtx(model, false))
      assert((body.reasoning as any)?.enabled === true, `reasoning=${JSON.stringify(body.reasoning)}`)
      assert((body.reasoning as any)?.effort === 'high', `reasoning=${JSON.stringify(body.reasoning)}`)
      assert(body.reasoning_effort === 'high', `reasoning_effort=${body.reasoning_effort}`)
    })
  })

  test('deepseek clamps max_tokens at the published V4 384K ceiling', () => {
    assert(TRANSFORMERS.deepseek.clampMaxTokens(500_000) === 384_000, 'no clamp')
    assert(TRANSFORMERS.deepseek.clampMaxTokens(16_000) === 16_000, 'unnecessary clamp')
  })
  test('deepseek sets thinking: enabled for a non-V4 id when reasoning requested', () => {
    const body = mkBody('deepseek-proxy-custom')
    TRANSFORMERS.deepseek.transformRequest(body, mkCtx('deepseek-proxy-custom', true))
    assert(body.thinking?.type === 'enabled', `thinking not set; body.thinking=${JSON.stringify(body.thinking)}`)
  })
  test('deepseek disables V4 thinking on the None stop', () => {
    _resetDeepSeekThinkingForTests()
    try {
      for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
        const body = mkBody(model, {
          messages: [
            { role: 'user', content: 'hi' },
            {
              role: 'assistant',
              content: 'done',
              reasoning_content: 'old thinking that must not leak into non-thinking mode',
            },
          ],
        })
        // Even when the global thinking config asks for reasoning, the V4
        // picker toggle is authoritative — /thinking does not drive V4.
        TRANSFORMERS.deepseek.transformRequest(body, mkCtx(model, true))
        assert(body.thinking?.type === 'disabled', `${model} thinking=${JSON.stringify(body.thinking)}`)
        assert(body.reasoning_effort === undefined, `${model} sent an effort while off`)
        assert(!('reasoning_content' in body.messages[1]!), `${model} leaked reasoning_content`)
      }
    } finally {
      _resetDeepSeekThinkingForTests()
    }
  })
  test('deepseek trims tool_calls to immediately answered tool messages', () => {
    const body = mkBody('deepseek-v4-flash', {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            mkToolCall('toolu_compat_call_answered', 'Read'),
            mkToolCall('toolu_compat_call_missing', 'Grep'),
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_compat_call_answered', content: 'ok' },
        { role: 'user', content: 'continue' },
      ],
    })

    TRANSFORMERS.deepseek.transformRequest(body, mkCtx('deepseek-v4-flash'))

    const assistant = body.messages[1]
    assert(assistant?.role === 'assistant', `assistant role=${assistant?.role}`)
    assert(assistant.tool_calls?.length === 1,
      `tool_calls=${JSON.stringify(assistant.tool_calls)}`)
    assert(assistant.tool_calls?.[0]?.id === 'toolu_compat_call_answered',
      `tool_call_id=${assistant.tool_calls?.[0]?.id}`)
    assert(body.messages[2]?.role === 'tool', `expected kept tool message, got ${body.messages[2]?.role}`)
    assert(body.messages[3]?.role === 'user', `expected next user message, got ${body.messages[3]?.role}`)
  })
  test('deepseek removes unanswered tool_calls and orphan tool messages', () => {
    const body = mkBody('deepseek-v4-flash', {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            mkToolCall('toolu_compat_call_missing_a', 'Read'),
            mkToolCall('toolu_compat_call_missing_b', 'Grep'),
          ],
        },
        { role: 'user', content: 'continue' },
        { role: 'tool', tool_call_id: 'toolu_compat_call_missing_a', content: 'late orphan' },
      ],
    })

    TRANSFORMERS.deepseek.transformRequest(body, mkCtx('deepseek-v4-flash'))

    const assistant = body.messages[1]
    assert(body.messages.length === 3, `messages=${JSON.stringify(body.messages)}`)
    assert(assistant?.role === 'assistant', `assistant role=${assistant?.role}`)
    assert(assistant.tool_calls === undefined, `tool_calls=${JSON.stringify(assistant.tool_calls)}`)
    assert(assistant.content === '', `assistant content=${JSON.stringify(assistant.content)}`)
    assert(!body.messages.some(message => message.role === 'tool'), 'orphan tool message was kept')
  })
  test('deepseek repairs tool-call adjacency without stripping enabled reasoning_content', () => {
    _resetDeepSeekThinkingForTests({ 'deepseek-v4-pro': 'high' })
    try {
      const body = mkBody('deepseek-v4-pro', {
        messages: [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'I should inspect the file.',
            tool_calls: [
              mkToolCall('toolu_compat_call_answered', 'Read'),
              mkToolCall('toolu_compat_call_missing', 'Grep'),
            ],
          },
          { role: 'tool', tool_call_id: 'toolu_compat_call_answered', content: 'ok' },
        ],
      })

      TRANSFORMERS.deepseek.transformRequest(body, mkCtx('deepseek-v4-pro'))

      const assistant = body.messages[1]
      assert(body.thinking?.type === 'enabled', `thinking=${JSON.stringify(body.thinking)}`)
      assert(assistant?.reasoning_content === 'I should inspect the file.',
        `reasoning_content=${JSON.stringify(assistant?.reasoning_content)}`)
      assert(assistant?.tool_calls?.length === 1,
        `tool_calls=${JSON.stringify(assistant?.tool_calls)}`)
    } finally {
      _resetDeepSeekThinkingForTests()
    }
  })

  // ── V4 thinking-effort ladder (picker chip) ─────────────────────
  test('deepseek enables V4 thinking and sends the picked effort', () => {
    for (const effort of ['low', 'high', 'max'] as const) {
      for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']) {
        _resetDeepSeekThinkingForTests({ [model]: effort })
        const body = mkBody(model)
        // The chip wins regardless of ctx.isReasoning.
        TRANSFORMERS.deepseek.transformRequest(body, mkCtx(model, false))
        assert(body.thinking?.type === 'enabled', `${model} thinking=${JSON.stringify(body.thinking)}`)
        assert(body.reasoning_effort === effort,
          `${model} effort=${JSON.stringify(body.reasoning_effort)} want ${effort}`)
      }
    }
    _resetDeepSeekThinkingForTests()
  })
  test('deepseek ladder is None/Low/High/Max and defaults to None', () => {
    _resetDeepSeekThinkingForTests()
    assert(DEEPSEEK_EFFORT_LEVELS.join(',') === 'none,low,high,max',
      `ladder=${DEEPSEEK_EFFORT_LEVELS.join(',')}`)
    assert(getDeepSeekEffort('deepseek-v4-pro') === 'none', 'default stop must be None')
    assert(resolveDeepSeekRequestEffort('deepseek-v4-pro') === null, 'None must resolve to no effort')
    assert(getDeepSeekEffortLabel('max') === 'Max', 'label should be title-cased')
  })
  test('deepseek effort chip shows only on V4 rows', () => {
    for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']) {
      assert(isDeepSeekV4ThinkingModel(model), `${model} should be a V4 row`)
      assert(supportsDeepSeekEffortSelection(model), `${model} should expose the chip`)
    }
    for (const model of ['deepseek-proxy-custom', 'deepseek-v3.2', 'gpt-oss-120b']) {
      assert(!supportsDeepSeekEffortSelection(model), `${model} must not expose the chip`)
    }
  })
  test('deepseek effort cycles both ways and wraps', () => {
    _resetDeepSeekThinkingForTests()
    const m = 'deepseek-v4-flash'
    assert(cycleDeepSeekEffort(m, 'right') === 'low', 'none -> low')
    assert(cycleDeepSeekEffort(m, 'right') === 'high', 'low -> high')
    assert(cycleDeepSeekEffort(m, 'right') === 'max', 'high -> max')
    assert(cycleDeepSeekEffort(m, 'right') === 'none', 'max wraps to none')
    assert(cycleDeepSeekEffort(m, 'left') === 'max', 'none wraps back to max')
    _resetDeepSeekThinkingForTests()
  })
  test('deepseek effort is per model, not global', () => {
    _resetDeepSeekThinkingForTests({ 'deepseek-v4-pro': 'max' })
    assert(getDeepSeekEffort('deepseek-v4-pro') === 'max', 'pro keeps its own pick')
    assert(getDeepSeekEffort('deepseek-v4-flash') === 'none', 'flash must not inherit it')
    _resetDeepSeekThinkingForTests()
  })
  test('a custom id behind DEEPSEEK_BASE_URL never gets an effort field', () => {
    _resetDeepSeekThinkingForTests({ 'deepseek-proxy-custom': 'max' })
    const body = mkBody('deepseek-proxy-custom')
    TRANSFORMERS.deepseek.transformRequest(body, mkCtx('deepseek-proxy-custom', true))
    assert(body.thinking?.type === 'enabled', 'caller budget still drives a custom id')
    assert(body.reasoning_effort === undefined, 'custom id must not get reasoning_effort')
    _resetDeepSeekThinkingForTests()
  })

  // ── Groq quirks ─────────────────────────────────────────────────
  test('groq normalizes reasoning → reasoning_content', () => {
    const delta: Record<string, unknown> = { reasoning: 'thinking hard' }
    TRANSFORMERS.groq.normalizeStreamDelta?.(delta as any, null)
    assert(delta['reasoning_content'] === 'thinking hard',
      `expected reasoning_content to be filled, got ${JSON.stringify(delta)}`)
  })
  test('groq adds reasoning_effort for gpt-oss (reasoning-capable)', () => {
    const body = mkBody('openai/gpt-oss-20b')
    TRANSFORMERS.groq.transformRequest(body, mkCtx('openai/gpt-oss-20b', true))
    assert(body.reasoning_effort === 'medium', `reasoning_effort=${body.reasoning_effort}`)
  })
  test('groq omits reasoning_effort for plain Llama (400s otherwise)', () => {
    const body = mkBody('llama-3.3-70b-versatile')
    TRANSFORMERS.groq.transformRequest(body, mkCtx('llama-3.3-70b-versatile', true))
    assert(body.reasoning_effort === undefined,
      `reasoning_effort should be undefined on llama-3.x; got ${body.reasoning_effort}`)
  })
  test('groq /models catalog keeps the 4 production chat models only', () => {
    const raw = [
      { id: 'llama-3.1-8b-instant' },
      { id: 'llama-3.3-70b-versatile' },
      { id: 'openai/gpt-oss-20b' },
      { id: 'openai/gpt-oss-120b' },
      { id: 'openai/gpt-oss-safeguard-20b' },
      { id: 'whisper-large-v3' },
      { id: 'groq/compound' },
      { id: 'groq/compound-mini' },
      { id: 'allam-2-7b' },
    ]
    const filtered = TRANSFORMERS.groq.filterModelCatalog?.(raw) ?? raw
    const ids = filtered.map(m => m.id)
    assert(ids.includes('openai/gpt-oss-20b'), 'expected openai/gpt-oss-20b kept')
    assert(ids.includes('openai/gpt-oss-120b'), 'expected openai/gpt-oss-120b kept')
    assert(ids.includes('llama-3.1-8b-instant'), 'expected llama-3.1-8b-instant kept (tool filter fits the 6k TPM budget)')
    assert(ids.includes('llama-3.3-70b-versatile'), 'expected llama-3.3-70b-versatile kept (tool filter fits the 12k TPM budget)')
    assert(!ids.includes('groq/compound'), 'groq/compound must be dropped')
    assert(!ids.includes('openai/gpt-oss-safeguard-20b'), 'safeguard variant must be dropped')
    assert(!ids.includes('whisper-large-v3'), 'whisper is not chat — must be dropped')
  })
  test('groq filters tools for llama small-tier (TPM-fit)', () => {
    const raw = [
      { name: 'Bash' }, { name: 'Read' }, { name: 'Edit' }, { name: 'Write' },
      { name: 'Grep' }, { name: 'Glob' }, { name: 'WebSearch' }, { name: 'WebFetch' },
      { name: 'Agent' }, { name: 'Skill' },
      { name: 'ToolSearch' },
      { name: 'TaskCreate' }, { name: 'CronCreate' }, { name: 'NotebookEdit' }, { name: 'Snapshot' },
      { name: 'PushNotification' }, { name: 'RemoteTrigger' }, { name: 'ScheduleWakeup' },
      { name: 'ExitPlanMode' }, { name: 'EnterWorktree' }, { name: 'AskUserQuestion' },
      { name: 'mcp__github__list_issues' }, { name: 'mcp__slack__send' },
    ]
    const kept = TRANSFORMERS.groq.filterTools?.('llama-3.1-8b-instant', raw) ?? raw
    const names = kept.map(t => t.name)
    assert(names.includes('Bash'), 'expected Bash kept')
    assert(names.includes('Read') && names.includes('Edit') && names.includes('Write'),
      'expected FS tools kept')
    assert(names.includes('WebSearch') && names.includes('WebFetch'), 'expected web tools kept')
    assert(names.includes('Agent'), 'expected Agent kept for sub-agent spawning')
    assert(names.includes('mcp__github__list_issues') && names.includes('mcp__slack__send'),
      'expected MCP tools to pass through')
    assert(!names.includes('TaskCreate'), 'TaskCreate should be dropped')
    assert(!names.includes('CronCreate'), 'CronCreate should be dropped')
    assert(!names.includes('NotebookEdit'), 'NotebookEdit should be dropped')
    assert(!names.includes('Snapshot'), 'Snapshot should be dropped')
    assert(!names.includes('ToolSearch'), 'small-tier result is eager because ToolSearch is absent')
  })
  test('groq filters tools for gpt-oss too (8k TPM on-demand cap)', () => {
    const raw = [
      { name: 'Bash' }, { name: 'Read' }, { name: 'Edit' },
      { name: 'TaskCreate' }, { name: 'NotebookEdit' }, { name: 'PushNotification' },
      { name: 'mcp__github__list_issues' },
    ]
    const kept = TRANSFORMERS.groq.filterTools?.('openai/gpt-oss-120b', raw) ?? raw
    const names = kept.map(t => t.name)
    assert(names.includes('Bash') && names.includes('Read') && names.includes('Edit'),
      'expected core FS/shell kept for gpt-oss')
    assert(names.includes('mcp__github__list_issues'),
      'expected MCP tools to pass through for gpt-oss')
    assert(!names.includes('TaskCreate'), 'TaskCreate should be dropped for gpt-oss (TPM budget)')
    assert(!names.includes('NotebookEdit'), 'NotebookEdit should be dropped for gpt-oss')
    assert(!names.includes('PushNotification'), 'PushNotification should be dropped for gpt-oss')
  })
  test('groq skips tool-usage preamble for every supported model (TPM budget)', () => {
    assert(TRANSFORMERS.groq.skipToolUsagePreamble?.('llama-3.1-8b-instant') === true,
      'expected preamble skipped for llama-3.1-8b')
    assert(TRANSFORMERS.groq.skipToolUsagePreamble?.('llama-3.3-70b-versatile') === true,
      'expected preamble skipped for llama-3.3-70b')
    assert(TRANSFORMERS.groq.skipToolUsagePreamble?.('openai/gpt-oss-20b') === true,
      'expected preamble skipped for gpt-oss-20b (8k TPM)')
    assert(TRANSFORMERS.groq.skipToolUsagePreamble?.('openai/gpt-oss-120b') === true,
      'expected preamble skipped for gpt-oss-120b (8k TPM)')
  })
  test('groq contextExceededMarkers cover TPM rate-limit phrases', () => {
    const markers = TRANSFORMERS.groq.contextExceededMarkers()
    const lower = markers.map(m => m.toLowerCase())
    assert(lower.some(m => 'request too large'.includes(m) || m === 'request too large'),
      'expected "request too large" marker for Groq TPM 413')
    assert(lower.some(m => m === 'tokens per minute' || 'tokens per minute'.includes(m)),
      'expected "tokens per minute" marker')
    assert(lower.some(m => m === 'reduce the length of the messages'),
      'expected "reduce the length of the messages" marker (per litellm + opencode-dev)')
  })
  test('groq does NOT support strict mode (Llama validator is too strict)', () => {
    assert(!TRANSFORMERS.groq.supportsStrictMode(),
      'groq strict mode would require every property in `required`; tools have optional fields')
  })
  test('groq keeps additionalProperties in schemas (not dropped)', () => {
    const drop = TRANSFORMERS.groq.schemaDropList()
    assert(!drop.has('additionalProperties'),
      'groq should NOT drop additionalProperties — keeps it as-is since strict is off')
  })

  // ── Mistral quirks ──────────────────────────────────────────────
  test('mistral rewrites tool_choice required → any', () => {
    const body = mkBody('mistral-large', { tool_choice: 'required' })
    TRANSFORMERS.mistral.transformRequest(body, mkCtx('mistral-large'))
    assert(body.tool_choice === 'any', `tool_choice=${body.tool_choice}`)
  })
  test('mistral strips `name` from non-tool messages', () => {
    const body = mkBody('mistral-large')
    body.messages = [{ role: 'user', content: 'hi', name: 'alice' } as any]
    TRANSFORMERS.mistral.transformRequest(body, mkCtx('mistral-large'))
    assert(!('name' in body.messages[0]!), `name field not stripped: ${JSON.stringify(body.messages[0])}`)
  })
  test('mistral repairs tool-call adjacency and names tool results', () => {
    const body = mkBody('devstral-latest', {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            mkToolCall('toolu_compat_call_answered', 'Skill'),
            mkToolCall('toolu_compat_call_missing', 'Grep'),
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_compat_call_answered', content: 'loaded' },
        { role: 'user', content: 'next' },
        { role: 'tool', tool_call_id: 'toolu_compat_call_missing', content: 'late orphan' },
      ],
    })

    TRANSFORMERS.mistral.transformRequest(body, mkCtx('devstral-latest'))

    const assistant = body.messages[1]
    assert(body.messages.length === 4, `messages=${JSON.stringify(body.messages)}`)
    assert(assistant?.role === 'assistant', `assistant role=${assistant?.role}`)
    assert(assistant.tool_calls?.length === 1,
      `tool_calls=${JSON.stringify(assistant.tool_calls)}`)
    assert(assistant.tool_calls?.[0]?.id === 'toolu_compat_call_answered',
      `tool_call_id=${assistant.tool_calls?.[0]?.id}`)
    assert(body.messages[2]?.role === 'tool', `expected kept tool message, got ${body.messages[2]?.role}`)
    assert(body.messages[2]?.name === 'Skill', `tool name=${body.messages[2]?.name}`)
    assert(body.messages[3]?.role === 'user', `expected next user message, got ${body.messages[3]?.role}`)
  })
  test('mistral drops orphan tool results after user messages', () => {
    const body = mkBody('devstral-latest', {
      messages: [
        { role: 'user', content: 'run a skill' },
        { role: 'tool', tool_call_id: 'toolu_orphan', content: 'loaded' },
      ],
    })

    TRANSFORMERS.mistral.transformRequest(body, mkCtx('devstral-latest'))

    assert(body.messages.length === 1, `messages=${JSON.stringify(body.messages)}`)
    assert(!body.messages.some(message => message.role === 'tool'), 'orphan tool message was kept')
  })
  test('mistral drops empty assistant placeholders after unresolved tool calls', () => {
    const body = mkBody('devstral-latest', {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [mkToolCall('toolu_missing', 'Read')],
        },
        { role: 'user', content: 'next' },
      ],
    })

    TRANSFORMERS.mistral.transformRequest(body, mkCtx('devstral-latest'))

    assert(body.messages.length === 2, `messages=${JSON.stringify(body.messages)}`)
    assert(!body.messages.some(message => message.role === 'assistant'),
      `empty assistant placeholder was kept: ${JSON.stringify(body.messages)}`)
  })
  test('mistral drops invalid assistant tool-call shells before shared cleanup', () => {
    const body = mkBody('devstral-latest', {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'toolu_bad',
              type: 'function',
              function: { name: '', arguments: '{}' },
            },
          ],
        } as any,
        { role: 'tool', tool_call_id: 'toolu_bad', content: 'loaded' },
      ],
    })

    TRANSFORMERS.mistral.transformRequest(body, mkCtx('devstral-latest'))

    assert(body.messages.length === 1, `messages=${JSON.stringify(body.messages)}`)
    assert(body.messages[0]?.role === 'user', `first role=${body.messages[0]?.role}`)
  })
  test('mistral does NOT support strict mode', () => {
    assert(!TRANSFORMERS.mistral.supportsStrictMode(),
      'mistral wrongly advertises strict mode')
  })
  test('mistral stamps prompt_cache_key from session id without cache_control markers', () => {
    const body = mkBody('mistral-large-latest')
    TRANSFORMERS.mistral.transformRequest(body, {
      ...mkCtx('mistral-large-latest'),
      sessionId: 'session-fixed',
    })
    assert(body.prompt_cache_key === 'session-fixed', `prompt_cache_key=${body.prompt_cache_key}`)
    assert(TRANSFORMERS.mistral.cacheControlMode('mistral-large-latest') === 'none',
      'mistral should not use Anthropic-style cache_control markers')
  })
  test('mistral sets reasoning_effort for reasoning-capable models', () => {
    const body = mkBody('mistral-medium-3-5')
    TRANSFORMERS.mistral.transformRequest(body, mkCtx('mistral-medium-3-5', true))
    assert(body.reasoning_effort === 'high', `reasoning_effort=${body.reasoning_effort}`)
  })
  test('mistral keeps Magistral thinking-template injection', () => {
    const body = mkBody('magistral-medium-latest')
    TRANSFORMERS.mistral.transformRequest(body, mkCtx('magistral-medium-latest', true))
    assert(body.messages[0]?.role === 'system', `first role=${body.messages[0]?.role}`)
    assert(
      typeof body.messages[0]?.content === 'string'
        && body.messages[0].content.includes('draft your thinking process'),
      'missing Magistral thinking template',
    )
  })
  test('mistral advertises live-first catalog with documented fallback rows', () => {
    assert(TRANSFORMERS.mistral.preferLiveModelCatalog?.() === true,
      'expected live /models to be preferred')
    const ids = (TRANSFORMERS.mistral.staticCatalog?.() ?? []).map(m => m.id)
    for (const id of ['mistral-medium-3-5', 'devstral-latest', 'devstral-medium-latest', 'mistral-small-latest', 'codestral-latest']) {
      assert(ids.includes(id), `mistral catalog missing ${id}`)
    }
    assert(!ids.includes('ministral-3b-latest'), 'mistral coding catalog should not include small non-coding fallback models')
  })
  test('mistral filters live catalog to current coding models when available', () => {
    const filtered = TRANSFORMERS.mistral.filterModelCatalog?.([
      { id: 'voxtral-mini-2507' },
      { id: 'ministral-3b-latest' },
      { id: 'devstral-latest' },
      { id: 'devstral-medium-latest' },
      { id: 'mistral-medium-3-5' },
      { id: 'codestral-latest' },
    ]) ?? []
    const ids = filtered.map(model => model.id)
    assert(ids.includes('devstral-latest'), 'expected devstral-latest kept')
    assert(ids.includes('devstral-medium-latest'), 'expected devstral-medium-latest kept')
    assert(ids.includes('mistral-medium-3-5'), 'expected mistral-medium-3-5 kept')
    assert(ids.includes('codestral-latest'), 'expected codestral-latest kept')
    assert(!ids.includes('voxtral-mini-2507'), 'non-chat/coding model leaked')
    assert(!ids.includes('ministral-3b-latest'), 'small non-coding fallback model leaked')
  })
  test('mistral prefers edit_block for coding-oriented models', () => {
    for (const model of ['codestral-latest', 'devstral-latest', 'magistral-medium-latest', 'mistral-medium-3-5']) {
      assert(TRANSFORMERS.mistral.preferredEditFormat(model) === 'edit_block',
        `${model} did not resolve to edit_block`)
    }
  })

  // ── NIM / Ollama: stream_options ────────────────────────────────
  test('nim deletes stream_options', () => {
    const body = mkBody('nvidia/llama-3.1-nemotron')
    TRANSFORMERS.nim.transformRequest(body, mkCtx('nvidia/llama-3.1-nemotron'))
    assert(body.stream_options === undefined, 'stream_options not deleted')
  })
  test('nim clamps large max_tokens reservations by default', () => {
    const old = process.env.NIM_MAX_TOKENS
    delete process.env.NIM_MAX_TOKENS
    try {
      assert(TRANSFORMERS.nim.clampMaxTokens(32000) === 8192, 'expected default 8192 cap')
      assert(TRANSFORMERS.nim.clampMaxTokens(4096) === 4096, 'small request should pass through')
      process.env.NIM_MAX_TOKENS = '2048'
      assert(TRANSFORMERS.nim.clampMaxTokens(4096) === 2048, 'expected env cap to win')
    } finally {
      if (old === undefined) delete process.env.NIM_MAX_TOKENS
      else process.env.NIM_MAX_TOKENS = old
    }
  })
  test('nim filters to fast core tools unless full tools are requested', () => {
    const envNames = [
      'NIM_NO_OPTIMIZE', 'CLAUDEX_NIM_NO_OPTIMIZE',
      'NIM_FULL_TOOLS', 'CLAUDEX_NIM_FULL_TOOLS',
      'NIM_KEEP_MCP_TOOLS', 'CLAUDEX_NIM_KEEP_MCP_TOOLS',
    ] as const
    const saved = new Map(envNames.map(name => [name, process.env[name]]))
    for (const name of envNames) delete process.env[name]
    try {
      const raw = [
        { name: 'Bash' }, { name: 'PowerShell' }, { name: 'Read' }, { name: 'Edit' },
        { name: 'Write' }, { name: 'Grep' }, { name: 'Glob' }, { name: 'TodoWrite' },
        { name: 'Agent' }, { name: 'Skill' }, { name: 'WebSearch' }, { name: 'WebFetch' },
        { name: 'ToolSearch' }, { name: 'NotebookEdit' }, { name: 'Snapshot' },
        { name: 'TaskCreate' }, { name: 'CronCreate' }, { name: 'RemoteTrigger' },
        { name: 'mcp__github__list_issues' },
      ]
      const kept = TRANSFORMERS.nim.filterTools?.('moonshotai/kimi-k2-instruct', raw) ?? raw
      const names = kept.map(t => t.name)
      assert(names.includes('Read') && names.includes('Bash') && names.includes('PowerShell'),
        'expected core shell/read tools kept')
      assert(names.includes('Grep') && names.includes('Glob') && names.includes('TodoWrite'),
        'expected core search/planning tools kept')
      assert(names.includes('Agent') && names.includes('Skill'), 'expected delegation helpers kept')
      assert(names.includes('ToolSearch'),
        'expected discovery helpers kept by the raw transformer policy')
      assert(!names.includes('NotebookEdit'), 'NotebookEdit should be dropped in NIM fast mode')
      assert(!names.includes('Snapshot'), 'Snapshot should be dropped in NIM fast mode')
      assert(!names.includes('CronCreate'), 'CronCreate should be dropped in NIM fast mode')
      assert(!names.includes('mcp__github__list_issues'), 'MCP should be opt-in for NIM fast mode')

      process.env.NIM_KEEP_MCP_TOOLS = '1'
      const withMcp = TRANSFORMERS.nim.filterTools?.('moonshotai/kimi-k2-instruct', raw) ?? raw
      assert(withMcp.some(t => t.name === 'mcp__github__list_issues'), 'MCP keep flag was ignored')
      assert(!withMcp.some(t => t.name === 'NotebookEdit'), 'MCP keep leaked outside allowlist')
    } finally {
      for (const name of envNames) {
        const value = saved.get(name)
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
  test('nim skips compat tool preamble by default', () => {
    assert(TRANSFORMERS.nim.skipToolUsagePreamble?.('moonshotai/kimi-k2-instruct') === true,
      'expected NIM to skip preamble in fast mode')
  })
  test('ollama deletes stream_options', () => {
    const body = mkBody('llama3')
    TRANSFORMERS.ollama.transformRequest(body, mkCtx('llama3'))
    assert(body.stream_options === undefined, 'stream_options not deleted')
  })

  // ── OpenRouter headers ──────────────────────────────────────────
  test('openrouter builds OpenRouter app-attribution headers', () => {
    const oldReferer = process.env.OPENROUTER_REFERER
    const oldTitle = process.env.OPENROUTER_TITLE
    const oldCategories = process.env.OPENROUTER_CATEGORIES
    delete process.env.OPENROUTER_REFERER
    delete process.env.OPENROUTER_TITLE
    delete process.env.OPENROUTER_CATEGORIES
    try {
      const h = TRANSFORMERS.openrouter.buildHeaders?.('sk-or-v1-xxx') ?? {}
      assert(h['HTTP-Referer'] === 'https://github.com/AbdoKnbGit/tau', 'HTTP-Referer header wrong')
      assert(h['X-OpenRouter-Title'] === 'Tau', 'X-OpenRouter-Title header wrong')
      assert(h['X-OpenRouter-Categories'] === 'cli-agent', 'X-OpenRouter-Categories header wrong')
      assert(h['X-Title'] === 'Tau', 'legacy X-Title header wrong')
    } finally {
      if (oldReferer === undefined) delete process.env.OPENROUTER_REFERER
      else process.env.OPENROUTER_REFERER = oldReferer
      if (oldTitle === undefined) delete process.env.OPENROUTER_TITLE
      else process.env.OPENROUTER_TITLE = oldTitle
      if (oldCategories === undefined) delete process.env.OPENROUTER_CATEGORIES
      else process.env.OPENROUTER_CATEGORIES = oldCategories
    }
  })
  test('openrouter cache-control mode is last-only for all OpenRouter families', () => {
    for (const model of [
      'anthropic/claude-sonnet-4-6',
      'meta-llama/llama-3.3-70b-instruct',
      'qwen/qwen-3-coder-plus',
      'moonshotai/kimi-k2.6',
      'z-ai/glm-5.1',
      'deepseek/deepseek-v4-flash',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ]) {
      assert(
        TRANSFORMERS.openrouter.cacheControlMode(model) === 'last-only',
        `wanted last-only for ${model}`,
      )
    }
  })
  test('openrouter stamps session id without enabling gateway compression by default', () => {
    const body = mkBody('anthropic/claude-sonnet-4-6')
    TRANSFORMERS.openrouter.transformRequest(body, {
      model: 'anthropic/claude-sonnet-4-6',
      isReasoning: false,
      reasoningEffort: null,
      sessionId: 'session-fixed',
    })
    const sessionKey = 'session-fixed'
    assert(body.session_id === sessionKey, `session_id=${body.session_id}`)
    assert(body.prompt_cache_key === sessionKey, `prompt_cache_key=${body.prompt_cache_key}`)
    const headers = TRANSFORMERS.openrouter.buildHeaders?.('sk-or-v1-xxx', {
      model: 'anthropic/claude-sonnet-4-6',
      sessionId: 'session-fixed',
    }) ?? {}
    assert(headers['x-session-id'] === sessionKey, `x-session-id=${headers['x-session-id']}`)
    assert(
      !body.plugins?.some(plugin => plugin.id === 'context-compression'),
      `plugins=${JSON.stringify(body.plugins)}`,
    )
  })
  test('openrouter pins provider order only when the env is set', () => {
    const oldOrder = process.env.OPENROUTER_PROVIDER_ORDER
    const oldFallbacks = process.env.OPENROUTER_ALLOW_FALLBACKS
    delete process.env.OPENROUTER_PROVIDER_ORDER
    delete process.env.OPENROUTER_ALLOW_FALLBACKS
    try {
      const ctx = {
        model: 'deepseek/deepseek-v4-flash',
        isReasoning: false,
        reasoningEffort: null,
        sessionId: 'session-fixed',
      }
      // Default: no provider preference emitted.
      const plain = mkBody('deepseek/deepseek-v4-flash')
      TRANSFORMERS.openrouter.transformRequest(plain, ctx)
      assert((plain as any).provider === undefined,
        `provider should be absent by default: ${JSON.stringify((plain as any).provider)}`)

      // Env set: order + allow_fallbacks pass through.
      process.env.OPENROUTER_PROVIDER_ORDER = 'deepseek, fireworks'
      process.env.OPENROUTER_ALLOW_FALLBACKS = 'false'
      const pinned = mkBody('deepseek/deepseek-v4-flash')
      TRANSFORMERS.openrouter.transformRequest(pinned, ctx)
      const provider = (pinned as any).provider
      assert(JSON.stringify(provider?.order) === JSON.stringify(['deepseek', 'fireworks']),
        `provider.order=${JSON.stringify(provider?.order)}`)
      assert(provider?.allow_fallbacks === false,
        `allow_fallbacks=${JSON.stringify(provider?.allow_fallbacks)}`)
    } finally {
      if (oldOrder === undefined) delete process.env.OPENROUTER_PROVIDER_ORDER
      else process.env.OPENROUTER_PROVIDER_ORDER = oldOrder
      if (oldFallbacks === undefined) delete process.env.OPENROUTER_ALLOW_FALLBACKS
      else process.env.OPENROUTER_ALLOW_FALLBACKS = oldFallbacks
    }
  })
  test('openrouter auto-pins the provider that served the session', () => {
    const oldOrder = process.env.OPENROUTER_PROVIDER_ORDER
    const oldAutoPin = process.env.TAU_OPENROUTER_AUTO_PIN
    delete process.env.OPENROUTER_PROVIDER_ORDER
    delete process.env.TAU_OPENROUTER_AUTO_PIN
    try {
      _resetOpenRouterAutoPinForTest()
      const ctx = {
        model: 'deepseek/deepseek-v4-flash',
        isReasoning: false,
        reasoningEffort: null,
        sessionId: 'sess-pin',
      }

      // No provider observed yet → no pin.
      const first = mkBody('deepseek/deepseek-v4-flash')
      TRANSFORMERS.openrouter.transformRequest(first, ctx)
      assert((first as any).provider === undefined,
        `no pin expected before a served provider is recorded: ${JSON.stringify((first as any).provider)}`)

      // Stream chunk reported the serving provider (display name) → next
      // request pins its slug, fallbacks left available.
      recordOpenRouterServedProvider('sess-pin', 'deepseek/deepseek-v4-flash', 'DeepSeek')
      const second = mkBody('deepseek/deepseek-v4-flash')
      TRANSFORMERS.openrouter.transformRequest(second, ctx)
      const pin = (second as any).provider
      assert(JSON.stringify(pin?.order) === JSON.stringify(['deepseek']),
        `provider.order=${JSON.stringify(pin?.order)}`)
      assert(pin?.allow_fallbacks === undefined,
        `auto-pin must keep fallbacks available: ${JSON.stringify(pin)}`)

      // Display names with spaces normalize to slugs.
      recordOpenRouterServedProvider('sess-pin', 'deepseek/deepseek-v4-flash', 'Amazon Bedrock')
      const third = mkBody('deepseek/deepseek-v4-flash')
      TRANSFORMERS.openrouter.transformRequest(third, ctx)
      assert(JSON.stringify((third as any).provider?.order) === JSON.stringify(['amazon-bedrock']),
        `normalized order=${JSON.stringify((third as any).provider?.order)}`)

      // Pin is per session+model — other sessions/models unaffected.
      const otherSession = mkBody('deepseek/deepseek-v4-flash')
      TRANSFORMERS.openrouter.transformRequest(otherSession, { ...ctx, sessionId: 'sess-other' })
      assert((otherSession as any).provider === undefined,
        `other session must not inherit the pin: ${JSON.stringify((otherSession as any).provider)}`)

      // Kill switch.
      process.env.TAU_OPENROUTER_AUTO_PIN = '0'
      const disabled = mkBody('deepseek/deepseek-v4-flash')
      TRANSFORMERS.openrouter.transformRequest(disabled, ctx)
      assert((disabled as any).provider === undefined,
        `TAU_OPENROUTER_AUTO_PIN=0 must disable the pin: ${JSON.stringify((disabled as any).provider)}`)
      delete process.env.TAU_OPENROUTER_AUTO_PIN

      // Explicit env order beats the auto-pin.
      process.env.OPENROUTER_PROVIDER_ORDER = 'fireworks'
      const explicit = mkBody('deepseek/deepseek-v4-flash')
      TRANSFORMERS.openrouter.transformRequest(explicit, ctx)
      assert(JSON.stringify((explicit as any).provider?.order) === JSON.stringify(['fireworks']),
        `explicit env must win: ${JSON.stringify((explicit as any).provider?.order)}`)
    } finally {
      _resetOpenRouterAutoPinForTest()
      if (oldOrder === undefined) delete process.env.OPENROUTER_PROVIDER_ORDER
      else process.env.OPENROUTER_PROVIDER_ORDER = oldOrder
      if (oldAutoPin === undefined) delete process.env.TAU_OPENROUTER_AUTO_PIN
      else process.env.TAU_OPENROUTER_AUTO_PIN = oldAutoPin
    }
  })
  test('openrouter keeps small-fast calls on the selected model', () => {
    for (const model of [
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'anthropic/claude-opus-4.7',
      'openai/gpt-5.5',
      'google/gemini-3.1-flash-lite-preview',
    ]) {
      assert(
        TRANSFORMERS.openrouter.smallFastModel(model) === null,
        `${model} should not redirect side calls to another OpenRouter model`,
      )
    }
  })
  test('openrouter can enable context compression by env', () => {
    const oldValue = process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION
    process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION = 'true'
    try {
      const body = mkBody('anthropic/claude-sonnet-4-6')
      TRANSFORMERS.openrouter.transformRequest(body, mkCtx('anthropic/claude-sonnet-4-6'))
      assert(
        body.plugins?.some(plugin => plugin.id === 'context-compression' && plugin.enabled !== false),
        `plugins=${JSON.stringify(body.plugins)}`,
      )
    } finally {
      if (oldValue === undefined) delete process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION
      else process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION = oldValue
    }
  })

  // ── AgentRouter ─────────────────────────────────────────────────
  test('agentrouter advertises its 8 catalog models', () => {
    const ids = (TRANSFORMERS.agentrouter.staticCatalog?.() ?? []).map(m => m.id)
    const expected = [
      'claude-haiku-4-5-20251001',
      'claude-opus-4-6',
      'glm-4.5',
      'glm-4.6',
      'glm-5.1',
      'deepseek-r1-0528',
      'deepseek-v3.1',
      'deepseek-v3.2',
    ]
    for (const id of expected) {
      assert(ids.includes(id), `agentrouter catalog missing ${id}`)
    }
  })
  test('agentrouter cache-control mode is last-only for Claude models', () => {
    assert(
      TRANSFORMERS.agentrouter.cacheControlMode('claude-haiku-4-5-20251001') === 'last-only',
      'wanted last-only for AgentRouter Claude routing',
    )
    assert(
      TRANSFORMERS.agentrouter.cacheControlMode('claude-opus-4-6') === 'last-only',
      'wanted last-only for AgentRouter Claude routing',
    )
  })
  test('agentrouter cache-control mode is none for GLM and DeepSeek', () => {
    assert(
      TRANSFORMERS.agentrouter.cacheControlMode('glm-5.1') === 'none',
      'wanted none for GLM routing',
    )
    assert(
      TRANSFORMERS.agentrouter.cacheControlMode('deepseek-v3.2') === 'none',
      'wanted none for DeepSeek routing',
    )
  })
  test('agentrouter does not stamp OpenRouter-style client headers', () => {
    const h = TRANSFORMERS.agentrouter.buildHeaders?.('sk-agentrouter-xxx') ?? {}
    assert(!('HTTP-Referer' in h), 'HTTP-Referer header should be omitted')
    assert(!('X-Title' in h), 'X-Title header should be omitted')
  })
  test('agentrouter clamps max_tokens at 8192', () => {
    assert(TRANSFORMERS.agentrouter.clampMaxTokens(16000) === 8192, 'no clamp')
    assert(TRANSFORMERS.agentrouter.clampMaxTokens(4000) === 4000, 'over-clamped')
  })
  test('agentrouter stamps prompt_cache_key from sessionId on Claude rows', () => {
    const body = mkBody('claude-haiku-4-5-20251001')
    TRANSFORMERS.agentrouter.transformRequest(body, {
      model: 'claude-haiku-4-5-20251001',
      isReasoning: false,
      reasoningEffort: null,
      sessionId: 'session-fixed',
    })
    assert(body.prompt_cache_key === 'session-fixed', `prompt_cache_key=${body.prompt_cache_key}`)
  })
  test('agentrouter omits prompt_cache_key when sessionId is absent', () => {
    const body = mkBody('claude-opus-4-6')
    TRANSFORMERS.agentrouter.transformRequest(body, mkCtx('claude-opus-4-6'))
    assert(body.prompt_cache_key === undefined, `prompt_cache_key=${body.prompt_cache_key}`)
  })
  test('agentrouter does not stamp prompt_cache_key for GLM/DeepSeek rows', () => {
    for (const model of ['glm-4.6', 'deepseek-v3.2']) {
      const body = mkBody(model)
      TRANSFORMERS.agentrouter.transformRequest(body, {
        model,
        isReasoning: false,
        reasoningEffort: null,
        sessionId: 'session-fixed',
      })
      assert(body.prompt_cache_key === undefined,
        `${model} prompt_cache_key=${body.prompt_cache_key}`)
    }
  })

  // ── Model Router ─────────────────────────────────────────────────
  test('modelrouter pins legacy Haiku alias to exact Model Router model id', () => {
    const body = mkBody('claude-3-5-haiku')
    TRANSFORMERS.modelrouter.transformRequest(body, mkCtx('claude-3-5-haiku'))
    assert(body.model === 'claude-haiku-4-5', `model=${body.model}`)
  })
  test('modelrouter pins GPT OSS alias to exact Bedrock model id', () => {
    const body = mkBody('gpt-oss-120b')
    TRANSFORMERS.modelrouter.transformRequest(body, mkCtx('gpt-oss-120b'))
    assert(body.model === 'openai.gpt-oss-120b-1:0', `model=${body.model}`)
  })
  test('modelrouter strips routing hints from pinned model requests', () => {
    const body = mkBody('gpt-oss-120b', {
      route: 'fallback',
      models: ['economy'],
      transforms: ['auto'],
      extra_body: {
        prefer: 'cheap',
        route: 'fallback',
      },
    }) as OpenAIChatRequest & { prefer?: string }
    body.prefer = 'cheap'
    TRANSFORMERS.modelrouter.transformRequest(body, mkCtx('gpt-oss-120b'))
    assert(body.model === 'openai.gpt-oss-120b-1:0', `model=${body.model}`)
    assert(body.prefer === undefined, `prefer=${body.prefer}`)
    assert(body.route === undefined, `route=${body.route}`)
    assert(body.models === undefined, `models=${JSON.stringify(body.models)}`)
    assert(body.transforms === undefined, `transforms=${JSON.stringify(body.transforms)}`)
    assert(body.extra_body?.prefer === undefined, `extra.prefer=${body.extra_body?.prefer}`)
    assert(body.extra_body?.route === undefined, `extra.route=${body.extra_body?.route}`)
  })
  test('modelrouter keeps routing hints for explicit tier requests', () => {
    const body = mkBody('standard') as OpenAIChatRequest & { prefer?: string }
    body.prefer = 'quality'
    TRANSFORMERS.modelrouter.transformRequest(body, mkCtx('standard'))
    assert(body.model === 'standard', `model=${body.model}`)
    assert(body.prefer === 'quality', `prefer=${body.prefer}`)
  })
  test('modelrouter cache-control mode is last-only for Anthropic pins', () => {
    assert(
      TRANSFORMERS.modelrouter.cacheControlMode('claude-3-5-haiku') === 'last-only',
      'wanted last-only for legacy Haiku alias',
    )
    assert(
      TRANSFORMERS.modelrouter.cacheControlMode('claude-haiku-4-5') === 'last-only',
      'wanted last-only for Model Router Haiku pin',
    )
  })
  test('modelrouter catalog includes current routing-grid model ids', () => {
    const ids = (TRANSFORMERS.modelrouter.staticCatalog?.() ?? []).map(model => model.id)
    for (const id of [
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'openai.gpt-oss-120b-1:0',
      'qwen-3-235b-a22b-instruct-2507',
      'nvidia.nemotron-nano-3-30b',
      'nvidia.nemotron-super-3-120b',
      'zai.glm-5',
    ]) {
      assert(ids.includes(id), `modelrouter catalog missing ${id}`)
    }
  })
  test('moonshot stamps prompt_cache_key from session id without cache_control markers', () => {
    const body = mkBody('kimi-k2.6')
    TRANSFORMERS.moonshot.transformRequest(body, {
      model: 'kimi-k2.6',
      isReasoning: false,
      reasoningEffort: null,
      sessionId: 'session-fixed',
    })
    assert(body.prompt_cache_key === 'session-fixed', `prompt_cache_key=${body.prompt_cache_key}`)
    assert(body.prompt_cache_retention === undefined,
      `prompt_cache_retention=${body.prompt_cache_retention}`)
    assert(TRANSFORMERS.moonshot.cacheControlMode('kimi-k2.6') === 'none',
      'moonshot should not use cache_control markers')
  })
  test('moonshot catalog is live-only and keeps live /models metadata', () => {
    assert(TRANSFORMERS.moonshot.preferLiveModelCatalog?.() === true,
      'expected live /models to be preferred')
    assert(TRANSFORMERS.moonshot.staticCatalog?.() === undefined,
      'moonshot must not expose a hardcoded static catalog')
    const filtered = TRANSFORMERS.moonshot.filterModelCatalog?.([
      {
        id: 'kimi-k2.7-code',
        contextWindow: 262144,
        tags: ['reasoning'],
      } as any,
      { id: 'whisper-large-v3' } as any,
    ]) ?? []
    assert(filtered.length === 1, `filtered=${JSON.stringify(filtered)}`)
    assert(filtered[0]?.id === 'kimi-k2.7-code', 'expected live Kimi id kept')
    assert(filtered[0]?.contextWindow === 262144, 'expected live context_length mapped')
    assert(filtered[0]?.tags?.includes('reasoning'), 'expected live reasoning flag mapped')
  })
  test('minimax catalog is live-only and keeps live /models rows', () => {
    assert(TRANSFORMERS.minimax.preferLiveModelCatalog?.() === true,
      'expected live /models to be preferred')
    assert(TRANSFORMERS.minimax.staticCatalog?.() === undefined,
      'minimax must not expose a hardcoded static catalog')
    const filtered = TRANSFORMERS.minimax.filterModelCatalog?.([
      { id: 'MiniMax-M3', contextWindow: 1000000 } as any,
      { id: 'MiniMax-Speech-2.8' } as any,
    ]) ?? []
    assert(filtered.length === 1, `filtered=${JSON.stringify(filtered)}`)
    assert(filtered[0]?.id === 'MiniMax-M3', 'expected live MiniMax id kept')
    assert(filtered[0]?.contextWindow === 1000000, 'expected live context_length mapped')
  })
  test('copilot sends stable session affinity headers', () => {
    const h = TRANSFORMERS.copilot.buildHeaders?.('copilot-token', {
      model: 'gpt-5.2',
      sessionId: 'session-fixed',
    }) ?? {}
    assert(h.session_id === 'session-fixed', `session_id=${h.session_id}`)
    assert(h['x-client-request-id'] === 'session-fixed', `x-client-request-id=${h['x-client-request-id']}`)
    assert(h['x-session-affinity'] === 'session-fixed', `x-session-affinity=${h['x-session-affinity']}`)
    assert(typeof h['x-request-id'] === 'string' && h['x-request-id'].length > 0, 'x-request-id missing')
  })
  test('copilot injects prompt_cache_key from session id', () => {
    const body = mkBody('gpt-5.2')
    TRANSFORMERS.copilot.transformRequest(body, {
      model: 'gpt-5.2',
      isReasoning: false,
      reasoningEffort: null,
      sessionId: 'session-fixed',
    })
    assert(body.prompt_cache_key === 'session-fixed', `prompt_cache_key=${body.prompt_cache_key}`)
  })
  test('copilot omits prompt_cache_key when session id is absent', () => {
    const body = mkBody('gpt-4.1')
    TRANSFORMERS.copilot.transformRequest(body, mkCtx('gpt-4.1'))
    assert(body.prompt_cache_key === undefined, `prompt_cache_key=${body.prompt_cache_key}`)
  })
  test('copilot trims tool_calls to immediately answered tool messages', () => {
    const body = mkBody('claude-sonnet-4.5', {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            mkToolCall('toolu_compat_call_answered', 'Read'),
            mkToolCall('toolu_compat_call_missing', 'Grep'),
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_compat_call_answered', content: 'ok' },
        { role: 'user', content: 'continue' },
      ],
    })

    TRANSFORMERS.copilot.transformRequest(body, mkCtx('claude-sonnet-4.5'))

    const assistant = body.messages[1]
    assert(assistant?.role === 'assistant', `assistant role=${assistant?.role}`)
    assert(assistant.tool_calls?.length === 1,
      `tool_calls=${JSON.stringify(assistant.tool_calls)}`)
    assert(assistant.tool_calls?.[0]?.id === 'toolu_compat_call_answered',
      `tool_call_id=${assistant.tool_calls?.[0]?.id}`)
    assert(body.messages[2]?.role === 'tool', `expected kept tool message, got ${body.messages[2]?.role}`)
    assert(body.messages[3]?.role === 'user', `expected next user message, got ${body.messages[3]?.role}`)
  })
  test('copilot removes unanswered tool_calls and orphan tool messages', () => {
    const body = mkBody('claude-sonnet-4.5', {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            mkToolCall('toolu_compat_call_missing_a', 'Read'),
            mkToolCall('toolu_compat_call_missing_b', 'Grep'),
          ],
        },
        { role: 'user', content: 'continue' },
        { role: 'tool', tool_call_id: 'toolu_compat_call_missing_a', content: 'late orphan' },
      ],
    })

    TRANSFORMERS.copilot.transformRequest(body, mkCtx('claude-sonnet-4.5'))

    const assistant = body.messages[1]
    assert(body.messages.length === 3, `messages=${JSON.stringify(body.messages)}`)
    assert(assistant?.role === 'assistant', `assistant role=${assistant?.role}`)
    assert(assistant.tool_calls === undefined, `tool_calls=${JSON.stringify(assistant.tool_calls)}`)
    assert(assistant.content === '', `assistant content=${JSON.stringify(assistant.content)}`)
    assert(!body.messages.some(message => message.role === 'tool'), `orphan tool message was kept`)
  })
  test('openrouter does not run copilot tool-call repair', () => {
    const body = mkBody('anthropic/claude-sonnet-4-5', {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [mkToolCall('toolu_compat_call_missing', 'Read')],
        },
        { role: 'user', content: 'continue' },
      ],
    })

    TRANSFORMERS.openrouter.transformRequest(body, mkCtx('anthropic/claude-sonnet-4-5'))

    assert(body.messages[1]?.tool_calls?.length === 1,
      `openrouter tool_calls=${JSON.stringify(body.messages[1]?.tool_calls)}`)
  })

  // ── Edit-format resolver + tool-set selection ───────────────────
  test('DeepSeek-Coder resolves to edit_block', () => {
    const caps = resolveCapabilities('deepseek', 'deepseek-coder-v3')
    assert(caps.editFormat === 'edit_block', `got ${caps.editFormat}`)
  })
  test('Llama-3.3 resolves to edit_block', () => {
    const caps = resolveCapabilities('groq', 'llama-3.3-70b-versatile')
    assert(caps.editFormat === 'edit_block', `got ${caps.editFormat}`)
  })
  test('Gemma resolves to str_replace', () => {
    const caps = resolveCapabilities('ollama', 'gemma-7b')
    assert(caps.editFormat === 'str_replace', `got ${caps.editFormat}`)
  })
  test('resolveEditFormat falls back to provider default', () => {
    // A random model with no per-model override → whatever provider says.
    const f = resolveEditFormat('mistral', 'unknown-model-xyz', 'str_replace')
    assert(f === 'str_replace', `got ${f}`)
  })
  test('selectEditToolSet exposes str_replace when preferred', () => {
    const tools = selectEditToolSet('str_replace')
    const names = tools.map(t => t.nativeName)
    assert(names.includes('str_replace'), 'str_replace missing')
    assert(!names.includes('edit_block'), 'edit_block should be filtered out')
    assert(!names.includes('edit_file'), 'edit_file should be filtered out')
  })
  test('selectEditToolSet exposes edit_block when preferred', () => {
    const tools = selectEditToolSet('edit_block')
    const names = tools.map(t => t.nativeName)
    assert(names.includes('edit_block'), 'edit_block missing')
    assert(!names.includes('str_replace'), 'str_replace should be filtered out')
  })
  test('selectEditToolSet apply_patch falls back to str_replace', () => {
    // The compat lane can't expose apply_patch (Freeform tool type is
    // Codex-only); apply_patch requests fall back to str_replace.
    const tools = selectEditToolSet('apply_patch')
    const names = tools.map(t => t.nativeName)
    assert(names.includes('str_replace'), 'str_replace should be the fallback')
  })

  // ── Reasoning detection ─────────────────────────────────────────
  test('deepseek-r1 is reasoning-capable', () => {
    const caps = resolveCapabilities('deepseek', 'deepseek-r1')
    assert(caps.supportsReasoning, 'should support reasoning')
  })
  test('glm-5 is reasoning-capable', () => {
    const caps = resolveCapabilities('glm', 'glm-5')
    assert(caps.supportsReasoning, 'should support reasoning')
  })
  test('mistral-small is reasoning-capable', () => {
    const caps = resolveCapabilities('mistral', 'mistral-small-latest')
    assert(caps.supportsReasoning, 'should support reasoning')
  })
  test('plain llama-3.1 is NOT reasoning-capable', () => {
    const caps = resolveCapabilities('groq', 'llama-3.1-8b-instant')
    assert(!caps.supportsReasoning, 'should NOT support reasoning')
  })

  // ── getTransformer fallback ─────────────────────────────────────
  test('getTransformer falls back to generic for unknown provider', () => {
    const t = getTransformer('unknown-provider-xyz' as any)
    assert(t.id === 'generic', `fallback returned ${t.id}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
