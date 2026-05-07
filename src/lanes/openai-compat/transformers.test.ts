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
 *   - OpenRouter emits HTTP-Referer + X-Title headers.
 *
 * Run:  bun run src/lanes/openai-compat/transformers.test.ts
 */

import { TRANSFORMERS, getTransformer } from './transformers/index.js'
import type { Transformer, TransformContext } from './transformers/base.js'
import type { OpenAIChatMessage, OpenAIChatRequest } from './transformers/shared_types.js'
import { selectEditToolSet, OPENAI_COMPAT_TOOL_REGISTRY } from './tools.js'
import { resolveEditFormat, resolveCapabilities } from './capabilities.js'
import { setDeepSeekV4Thinking } from '../../utils/model/deepseekThinking.js'
import { setGlmThinking } from '../../utils/model/glmThinking.js'

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

function main(): void {
  console.log('openai-compat transformers:')

  // ── Registry invariants ─────────────────────────────────────────
  const ids: Array<Transformer['id']> = [
    'deepseek', 'glm', 'groq', 'mistral', 'nim', 'ollama', 'openrouter', 'agentrouter', 'generic',
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

  test('deepseek clamps max_tokens at 8192', () => {
    assert(TRANSFORMERS.deepseek.clampMaxTokens(16000) === 8192, 'no clamp')
    assert(TRANSFORMERS.deepseek.clampMaxTokens(4096) === 4096, 'unnecessary clamp')
  })
  test('deepseek sets thinking: enabled when reasoning requested', () => {
    const body = mkBody('deepseek-reasoner')
    TRANSFORMERS.deepseek.transformRequest(body, mkCtx('deepseek-reasoner', true))
    assert(body.thinking?.type === 'enabled', `thinking not set; body.thinking=${JSON.stringify(body.thinking)}`)
  })
  test('deepseek disables V4 thinking when picker toggle is OFF', () => {
    setDeepSeekV4Thinking(false)
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
        assert(!('reasoning_content' in body.messages[1]!), `${model} leaked reasoning_content`)
      }
    } finally {
      setDeepSeekV4Thinking(false)
    }
  })
  test('deepseek trims tool_calls to immediately answered tool messages', () => {
    const body = mkBody('deepseek-chat', {
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

    TRANSFORMERS.deepseek.transformRequest(body, mkCtx('deepseek-chat'))

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
    const body = mkBody('deepseek-chat', {
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

    TRANSFORMERS.deepseek.transformRequest(body, mkCtx('deepseek-chat'))

    const assistant = body.messages[1]
    assert(body.messages.length === 3, `messages=${JSON.stringify(body.messages)}`)
    assert(assistant?.role === 'assistant', `assistant role=${assistant?.role}`)
    assert(assistant.tool_calls === undefined, `tool_calls=${JSON.stringify(assistant.tool_calls)}`)
    assert(assistant.content === '', `assistant content=${JSON.stringify(assistant.content)}`)
    assert(!body.messages.some(message => message.role === 'tool'), 'orphan tool message was kept')
  })
  test('deepseek repairs tool-call adjacency without stripping enabled reasoning_content', () => {
    setDeepSeekV4Thinking(true)
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
      setDeepSeekV4Thinking(false)
    }
  })
  test('deepseek enables V4 thinking when picker toggle is ON', () => {
    setDeepSeekV4Thinking(true)
    try {
      for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
        const body = mkBody(model)
        // Toggle ON wins regardless of ctx.isReasoning.
        TRANSFORMERS.deepseek.transformRequest(body, mkCtx(model, false))
        assert(body.thinking?.type === 'enabled', `${model} thinking=${JSON.stringify(body.thinking)}`)
      }
    } finally {
      setDeepSeekV4Thinking(false)
    }
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
      { name: 'TaskCreate' }, { name: 'CronCreate' }, { name: 'NotebookEdit' },
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
  test('mistral does NOT support strict mode', () => {
    assert(!TRANSFORMERS.mistral.supportsStrictMode(),
      'mistral wrongly advertises strict mode')
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
    const raw = [
      { name: 'Bash' }, { name: 'PowerShell' }, { name: 'Read' }, { name: 'Edit' },
      { name: 'Write' }, { name: 'Grep' }, { name: 'Glob' }, { name: 'TodoWrite' },
      { name: 'Agent' }, { name: 'Skill' }, { name: 'WebSearch' }, { name: 'WebFetch' },
      { name: 'NotebookEdit' }, { name: 'TaskCreate' }, { name: 'CronCreate' },
      { name: 'RemoteTrigger' }, { name: 'mcp__github__list_issues' },
    ]
    const kept = TRANSFORMERS.nim.filterTools?.('moonshotai/kimi-k2-instruct', raw) ?? raw
    const names = kept.map(t => t.name)
    assert(names.includes('Read') && names.includes('Bash') && names.includes('PowerShell'),
      'expected core shell/read tools kept')
    assert(names.includes('Grep') && names.includes('Glob') && names.includes('TodoWrite'),
      'expected core search/planning tools kept')
    assert(names.includes('Agent') && names.includes('Skill'), 'expected delegation helpers kept')
    assert(!names.includes('NotebookEdit'), 'NotebookEdit should be dropped in NIM fast mode')
    assert(!names.includes('CronCreate'), 'CronCreate should be dropped in NIM fast mode')
    assert(!names.includes('mcp__github__list_issues'), 'MCP should be opt-in for NIM fast mode')
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
  test('openrouter builds HTTP-Referer + X-Title headers', () => {
    const h = TRANSFORMERS.openrouter.buildHeaders?.('sk-or-v1-xxx') ?? {}
    assert('HTTP-Referer' in h, 'HTTP-Referer header missing')
    assert('X-Title' in h, 'X-Title header missing')
  })
  test('openrouter cache-control mode is last-only for Claude models', () => {
    assert(
      TRANSFORMERS.openrouter.cacheControlMode('anthropic/claude-sonnet-4-6') === 'last-only',
      'wanted last-only for Claude routing',
    )
  })
  test('openrouter cache-control mode is none for non-Anthropic models', () => {
    assert(
      TRANSFORMERS.openrouter.cacheControlMode('meta-llama/llama-3.3-70b-instruct') === 'none',
      'wanted none for Llama routing',
    )
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
