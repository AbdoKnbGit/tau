import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { onLocalModelNotice, resetLocalModelNoticesForTests } from '../../utils/model/localModelNotices.js'
import {
  beginLocalPreload,
  capLocalOutputTokens,
  checkOllamaGpuFit,
  chooseOllamaNumCtx,
  chooseOllamaThink,
  isLocalThinkingFieldRefusal,
  isThinkRefusal,
  lmStudioReasoningEffort,
  localServerRefusesThinkingFields,
  localThinkingSetting,
  localThinkingWanted,
  otherLocalThinkingFields,
  rememberLocalServerRefusesThinkingFields,
  fitLocalOutputTokens,
  growOllamaNumCtx,
  isLocalModelRequest,
  isOllamaCloudModel,
  isStreamOptionsRefusal,
  localAnswerRoom,
  localConversationReached,
  localPreloadKey,
  noteLocalConversationRequest,
  waitForLocalPreload,
  ollamaContextSetting,
  ollamaKeepAlive,
  ollamaCpuShareNotice,
  ollamaOverflowAdvice,
  ollamaOwnContext,
  ollamaTruncateFields,
  parseOllamaContextOverflow,
  resetLocalModelSettingsForTests,
  resolveLocalSampling,
} from './local_model_settings.js'

const ENV_KEYS = [
  'OLLAMA_NUM_CTX',
  'OLLAMA_NUM_CTX_MAX',
  'OLLAMA_KEEP_ALIVE',
  'OLLAMA_TRUNCATE',
  'TAU_LOCAL_MAX_OUTPUT_TOKENS',
  'TAU_LOCAL_TEMPERATURE',
  'TAU_LOCAL_TOP_P',
  'TAU_LOCAL_TOP_K',
  'TAU_LOCAL_THINKING',
]
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  resetLocalModelSettingsForTests()
  resetLocalModelNoticesForTests()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('which requests are local', () => {
  test('Ollama and LM Studio count wherever they run; other servers only on loopback', () => {
    expect(isLocalModelRequest('ollama', 'qwen3:4b', true)).toBe(true)
    expect(isLocalModelRequest('ollama', 'qwen3:4b', false)).toBe(true)
    expect(isLocalModelRequest('lmstudio', 'local-model', false)).toBe(true)
    expect(isLocalModelRequest('generic', 'llama', true)).toBe(true)
    expect(isLocalModelRequest('generic', 'llama', false)).toBe(false)
  })

  test('hosted providers never count, even behind a local proxy', () => {
    for (const provider of ['deepseek', 'openrouter', 'mistral', 'glm', 'groq', 'nim', 'opencode']) {
      expect(isLocalModelRequest(provider, 'some-model', true)).toBe(false)
    }
  })

  test("Ollama's cloud models are not local", () => {
    expect(isOllamaCloudModel('glm-5.1:cloud')).toBe(true)
    expect(isOllamaCloudModel('gpt-oss:120b-cloud')).toBe(true)
    expect(isOllamaCloudModel('qwen3:4b')).toBe(false)
    expect(isLocalModelRequest('ollama', 'minimax-m2.7:cloud', true)).toBe(false)
  })
})

describe('sampling', () => {
  test("no setting and Tau's default temperatures leave the model's own sampling", () => {
    expect(resolveLocalSampling(undefined)).toEqual({})
    expect(resolveLocalSampling(1)).toEqual({})
  })

  test('a deliberate caller temperature is kept', () => {
    expect(resolveLocalSampling(0)).toEqual({ temperature: 0 })
    expect(resolveLocalSampling(0.3)).toEqual({ temperature: 0.3 })
  })

  test('user settings win, and invalid ones are ignored', () => {
    process.env.TAU_LOCAL_TEMPERATURE = '0.6'
    process.env.TAU_LOCAL_TOP_P = '0.95'
    process.env.TAU_LOCAL_TOP_K = '20'
    expect(resolveLocalSampling(0)).toEqual({ temperature: 0.6, top_p: 0.95, top_k: 20 })
    process.env.TAU_LOCAL_TEMPERATURE = 'hot'
    process.env.TAU_LOCAL_TOP_P = '1.5'
    process.env.TAU_LOCAL_TOP_K = '-3'
    expect(resolveLocalSampling(undefined)).toEqual({})
  })
})

describe('answer limits', () => {
  test('TAU_LOCAL_MAX_OUTPUT_TOKENS caps the request', () => {
    expect(capLocalOutputTokens(32_000)).toBe(32_000)
    process.env.TAU_LOCAL_MAX_OUTPUT_TOKENS = '4096'
    expect(capLocalOutputTokens(32_000)).toBe(4096)
    expect(capLocalOutputTokens(512)).toBe(512)
  })

  test('the limit fits the room the context leaves, with a floor, never above the request', () => {
    expect(fitLocalOutputTokens(32_000, 32_768, 18_000)).toBe(14_768)
    expect(fitLocalOutputTokens(32_000, 16_384, 16_200)).toBe(1024)
    expect(fitLocalOutputTokens(512, 16_384, 16_200)).toBe(512)
    expect(fitLocalOutputTokens(32_000, undefined, 18_000)).toBe(32_000)
    expect(fitLocalOutputTokens(undefined, 32_768, 18_000)).toBeUndefined()
  })

  test('answer room is 8K, a smaller request, or the user cap', () => {
    expect(localAnswerRoom(32_000)).toBe(8192)
    expect(localAnswerRoom(2000)).toBe(2000)
    process.env.TAU_LOCAL_MAX_OUTPUT_TOKENS = '16000'
    expect(localAnswerRoom(32_000)).toBe(16_000)
  })
})

describe('Ollama context', () => {
  test('auto by default with no ceiling of its own; a number is fixed; auto and junk mean auto', () => {
    expect(ollamaContextSetting()).toEqual({ kind: 'auto' })
    process.env.OLLAMA_NUM_CTX = '20000'
    expect(ollamaContextSetting()).toEqual({ kind: 'fixed', numCtx: 20_000 })
    process.env.OLLAMA_NUM_CTX = 'auto'
    process.env.OLLAMA_NUM_CTX_MAX = '65536'
    expect(ollamaContextSetting()).toEqual({ kind: 'auto', max: 65_536 })
    process.env.OLLAMA_NUM_CTX = 'lots'
    expect(ollamaContextSetting()).toEqual({ kind: 'auto', max: 65_536 })
  })

  const auto = { kind: 'auto' } as const

  test('with OLLAMA_NUM_CTX_MAX, a small request keeps 16K, as Tau always sent', () => {
    expect(chooseOllamaNumCtx({ key: 'a', promptTokens: 4000, answerRoom: 8192, setting: { kind: 'auto', max: 32_768 } })).toBe(16_384)
  })

  test("without it, a small request gets the bottom of auto's range, so the conversation does not reload the model", () => {
    expect(chooseOllamaNumCtx({ key: 'a2', promptTokens: 4000, answerRoom: 8192, setting: auto, range: { floor: 32_768, ceiling: 40_960 } })).toBe(32_768)
  })

  test("auto fits Tau's 16K-token prompt with room for the answer", () => {
    expect(chooseOllamaNumCtx({ key: 'b', promptTokens: 18_700, answerRoom: 8192, setting: auto, range: { floor: 32_768, ceiling: 40_960 } })).toBe(32_768)
  })

  test('auto takes the context Ollama gives the model when it holds the request, so nothing reloads', () => {
    // A 48 GB machine: Ollama loads the model at 256K on its own.
    expect(chooseOllamaNumCtx({ key: 'big', promptTokens: 18_700, answerRoom: 8192, setting: auto, range: { floor: 262_144, ceiling: 262_144 } })).toBe(262_144)
    // An 8 GB machine: Ollama's own 4K cannot hold Tau's prompt, so the range starts at what Tau needs.
    expect(chooseOllamaNumCtx({ key: 'small', promptTokens: 18_700, answerRoom: 8192, setting: auto, range: { floor: 32_768, ceiling: 32_768 } })).toBe(32_768)
  })

  test("auto without OLLAMA_NUM_CTX_MAX stops at the top of its range and at the model's limit", () => {
    expect(chooseOllamaNumCtx({ key: 'c', promptTokens: 60_000, answerRoom: 8192, setting: auto, range: { floor: 32_768, ceiling: 32_768 } })).toBe(32_768)
    expect(chooseOllamaNumCtx({ key: 'd', promptTokens: 18_000, answerRoom: 8192, modelMax: 8192, setting: auto, range: { floor: 32_768, ceiling: 32_768 } })).toBe(8192)
  })

  test("OLLAMA_NUM_CTX_MAX lets auto grow to it, and the model's limit still caps it", () => {
    const setting = { kind: 'auto', max: 1_048_576 } as const
    expect(chooseOllamaNumCtx({ key: 'm', promptTokens: 300_000, answerRoom: 8192, setting })).toBe(311_296)
    expect(chooseOllamaNumCtx({ key: 'n', promptTokens: 300_000, answerRoom: 8192, modelMax: 131_072, setting })).toBe(131_072)
  })

  test('auto grows by doubling, because every change reloads the model', () => {
    const setting = { kind: 'auto', max: 1_048_576 } as const
    expect(chooseOllamaNumCtx({ key: 'g2', promptTokens: 20_000, answerRoom: 8192, setting })).toBe(32_768)
    expect(chooseOllamaNumCtx({ key: 'g2', promptTokens: 30_000, answerRoom: 8192, setting })).toBe(65_536)
    expect(chooseOllamaNumCtx({ key: 'g2', promptTokens: 70_000, answerRoom: 8192, setting })).toBe(131_072)
    // The ceiling still wins over a doubling.
    expect(chooseOllamaNumCtx({ key: 'g3', promptTokens: 20_000, answerRoom: 8192, setting: { kind: 'auto', max: 40_960 } })).toBe(32_768)
    expect(chooseOllamaNumCtx({ key: 'g3', promptTokens: 30_000, answerRoom: 8192, setting: { kind: 'auto', max: 40_960 } })).toBe(40_960)
  })

  test('auto never shrinks for the same model, so Ollama does not reload it', () => {
    const setting = { kind: 'auto', max: 65_536 } as const
    expect(chooseOllamaNumCtx({ key: 'e', promptTokens: 30_000, answerRoom: 8192, setting })).toBe(40_960)
    expect(chooseOllamaNumCtx({ key: 'e', promptTokens: 2000, answerRoom: 1024, setting })).toBe(40_960)
    expect(chooseOllamaNumCtx({ key: 'other', promptTokens: 2000, answerRoom: 1024, setting })).toBe(16_384)
  })

  test('a fixed context is used as given', () => {
    expect(chooseOllamaNumCtx({ key: 'f', promptTokens: 60_000, answerRoom: 8192, range: { floor: 262_144, ceiling: 262_144 }, setting: { kind: 'fixed', numCtx: 12_000 } })).toBe(12_000)
  })

  test("growing after Ollama's refusal uses the exact size, up to the ceiling", () => {
    const setting = { kind: 'auto', max: 32_768 } as const
    expect(growOllamaNumCtx({ key: 'g', requestTokens: 18_000, answerRoom: 8192, setting, current: 16_384 })).toBe(32_768)
    // The answer room no longer fits, but the request does with a short answer.
    expect(growOllamaNumCtx({ key: 'h', requestTokens: 30_000, answerRoom: 8192, setting, current: 16_384 })).toBe(32_768)
    // Nothing larger to try.
    expect(growOllamaNumCtx({ key: 'i', requestTokens: 40_000, answerRoom: 8192, setting, current: 32_768 })).toBeUndefined()
    expect(growOllamaNumCtx({ key: 'j', requestTokens: 18_000, answerRoom: 8192, setting: { kind: 'fixed', numCtx: 16_384 }, current: 16_384 })).toBeUndefined()
    // Without OLLAMA_NUM_CTX_MAX the ceiling is the top of auto's range.
    const range = { floor: 32_768, ceiling: 40_960 }
    expect(growOllamaNumCtx({ key: 'l', requestTokens: 30_000, answerRoom: 8192, setting: auto, range, current: 32_768 })).toBe(40_960)
    expect(growOllamaNumCtx({ key: 'l2', requestTokens: 40_000, answerRoom: 8192, setting: auto, range, current: 40_960 })).toBeUndefined()
  })

  test('a grown context is kept for the next request', () => {
    const setting = { kind: 'auto', max: 65_536 } as const
    expect(growOllamaNumCtx({ key: 'k', requestTokens: 20_000, answerRoom: 8192, setting, current: 16_384 })).toBe(32_768)
    expect(chooseOllamaNumCtx({ key: 'k', promptTokens: 1000, answerRoom: 1024, setting })).toBe(32_768)
  })

  test("Ollama's refusal is read with its exact token counts", () => {
    const text = '{"error":"request (1520 tokens) exceeds the available context size (512 tokens), try increasing it"}'
    expect(parseOllamaContextOverflow(text)).toEqual({ requestTokens: 1520, contextTokens: 512 })
    expect(parseOllamaContextOverflow('{"error":"model not found"}')).toBeUndefined()
  })

  test('the advice names the setting that applies', () => {
    const overflow = { requestTokens: 40_000, contextTokens: 32_768 }
    expect(ollamaOverflowAdvice(overflow, { kind: 'auto', max: 32_768 })).toContain('OLLAMA_NUM_CTX_MAX (now 32768)')
    expect(ollamaOverflowAdvice(overflow, { kind: 'fixed', numCtx: 16_384 })).toContain('OLLAMA_NUM_CTX (now 16384)')
    expect(ollamaOverflowAdvice(overflow, auto)).toContain('set OLLAMA_NUM_CTX_MAX to let Tau ask for more')
    // The model's own limit is what blocks once the context reached it.
    expect(ollamaOverflowAdvice(overflow, { kind: 'auto', max: 32_768 }, 8192)).toContain('This model takes at most 8192 tokens')
    expect(ollamaOverflowAdvice(overflow, auto, 32_768)).toContain('This model takes at most 32768 tokens')
    expect(ollamaOverflowAdvice(overflow, { kind: 'auto', max: 32_768 }, 262_144)).toContain('OLLAMA_NUM_CTX_MAX (now 32768)')
  })

  test('truncate: false unless OLLAMA_TRUNCATE asks for silent truncation', () => {
    expect(ollamaTruncateFields()).toEqual({ truncate: false })
    process.env.OLLAMA_TRUNCATE = '1'
    expect(ollamaTruncateFields()).toEqual({})
  })

  test('TAU_LOCAL_THINKING: off, on and the levels; anything else is ignored', () => {
    expect(localThinkingSetting()).toBeUndefined()
    for (const [text, value] of [['off', false], ['false', false], ['on', true], ['TRUE', true], ['low', 'low'], ['high', 'high'], ['maybe', undefined]] as const) {
      process.env.TAU_LOCAL_THINKING = text
      expect(localThinkingSetting()).toBe(value)
    }
  })

  test('think is sent only when asked for, and only to a model that lists thinking', () => {
    const thinks = ['completion', 'tools', 'thinking']
    // Tau's thinking off and no setting: the model keeps its own default.
    expect(chooseOllamaThink({ setting: undefined, tauThinkingOn: false, capabilities: thinks })).toBeUndefined()
    expect(chooseOllamaThink({ setting: undefined, tauThinkingOn: true, capabilities: thinks })).toBe(true)
    expect(chooseOllamaThink({ setting: false, tauThinkingOn: true, capabilities: thinks })).toBe(false)
    expect(chooseOllamaThink({ setting: 'low', tauThinkingOn: false, capabilities: thinks })).toBe('low')
    // A model that does not list thinking, or an Ollama that says nothing.
    expect(chooseOllamaThink({ setting: true, tauThinkingOn: true, capabilities: ['completion', 'tools'] })).toBeUndefined()
    expect(chooseOllamaThink({ setting: true, tauThinkingOn: true, capabilities: undefined })).toBeUndefined()
  })

  test("a server's refusal of think is recognized; other errors are not", () => {
    expect(isThinkRefusal(400, '{"error":"\\"llama3:8b\\" does not support thinking"}')).toBe(true)
    expect(isThinkRefusal(400, '{"error":"invalid think value"}')).toBe(true)
    expect(isThinkRefusal(400, 'request (20000 tokens) exceeds the available context size (8192 tokens)')).toBe(false)
    expect(isThinkRefusal(500, 'does not support thinking')).toBe(false)
  })

  test('what was asked for: the setting first, else Tau thinking on, else nothing', () => {
    expect(localThinkingWanted(undefined, false)).toBeUndefined()
    expect(localThinkingWanted(undefined, true)).toBe(true)
    expect(localThinkingWanted(false, true)).toBe(false)
    expect(localThinkingWanted('high', false)).toBe('high')
  })

  test('LM Studio gets reasoning_effort only within the options it lists for the model', () => {
    const onByDefault = { allowed: ['off', 'on'], default: 'on' }
    const offByDefault = { allowed: ['off', 'on'], default: 'off' }
    const levels = { allowed: ['low', 'medium', 'high'], default: 'medium' }
    // Nothing asked: nothing sent, whatever the model.
    expect(lmStudioReasoningEffort(undefined, onByDefault)).toBeUndefined()
    // Off: `none`, only where off is allowed.
    expect(lmStudioReasoningEffort(false, onByDefault)).toBe('none')
    expect(lmStudioReasoningEffort(false, offByDefault)).toBe('none')
    expect(lmStudioReasoningEffort(false, levels)).toBeUndefined()
    // On or a level for an on/off model: only needed when it starts off.
    expect(lmStudioReasoningEffort(true, onByDefault)).toBeUndefined()
    expect(lmStudioReasoningEffort('low', onByDefault)).toBeUndefined()
    expect(lmStudioReasoningEffort(true, offByDefault)).toBe('medium')
    expect(lmStudioReasoningEffort('high', offByDefault)).toBe('medium')
    // A level the model lists goes as is.
    expect(lmStudioReasoningEffort('high', levels)).toBe('high')
    expect(lmStudioReasoningEffort(true, levels)).toBeUndefined()
    // A model with no thinking options.
    expect(lmStudioReasoningEffort(false, undefined)).toBeUndefined()
    expect(lmStudioReasoningEffort(true, { allowed: [] })).toBeUndefined()
  })

  test('any other local server gets the fields such servers take, for what was asked', () => {
    expect(otherLocalThinkingFields(undefined)).toBeUndefined()
    expect(otherLocalThinkingFields(false)).toEqual({ chat_template_kwargs: { enable_thinking: false } })
    expect(otherLocalThinkingFields(true)).toEqual({ chat_template_kwargs: { enable_thinking: true } })
    expect(otherLocalThinkingFields('high')).toEqual({ reasoning_effort: 'high' })
  })

  test("a server's refusal of a thinking field is recognized and remembered per server and model", () => {
    expect(isLocalThinkingFieldRefusal(400, "Invalid 'reasoning_effort' value: 'off'. Supported values: none, low")).toBe(true)
    expect(isLocalThinkingFieldRefusal(422, '{"detail":[{"loc":["body","chat_template_kwargs"],"msg":"Extra inputs are not permitted"}]}')).toBe(true)
    expect(isLocalThinkingFieldRefusal(400, 'context length exceeded')).toBe(false)
    expect(isLocalThinkingFieldRefusal(500, 'reasoning_effort')).toBe(false)

    const server = 'http://localhost:8080/v1'
    expect(localServerRefusesThinkingFields(server, 'model-a')).toBe(false)
    rememberLocalServerRefusesThinkingFields(server, 'model-a')
    expect(localServerRefusesThinkingFields(server, 'model-a')).toBe(true)
    expect(localServerRefusesThinkingFields(server, 'model-b')).toBe(false)
    expect(localServerRefusesThinkingFields('http://localhost:8081/v1', 'model-a')).toBe(false)
    resetLocalModelSettingsForTests()
    expect(localServerRefusesThinkingFields(server, 'model-a')).toBe(false)
  })

  test("a server's refusal of stream_options is recognized; other errors are not", () => {
    expect(isStreamOptionsRefusal(400, "Unrecognized key 'stream_options'")).toBe(true)
    expect(isStreamOptionsRefusal(422, '{"detail":[{"loc":["body","stream_options","include_usage"]}]}')).toBe(true)
    expect(isStreamOptionsRefusal(400, 'context length exceeded')).toBe(false)
    expect(isStreamOptionsRefusal(500, 'stream_options')).toBe(false)
  })

  test('keep-alive defaults to 30 minutes', () => {
    expect(ollamaKeepAlive()).toBe('30m')
    process.env.OLLAMA_KEEP_ALIVE = '2h'
    expect(ollamaKeepAlive()).toBe('2h')
  })
})

describe('preload coordination', () => {
  const server = 'http://127.0.0.1:11434/v1'

  test('a request waits for a preload of the same model on the same server, and only that one', async () => {
    const key = localPreloadKey('ollama', server, 'model-a')
    const finish = beginLocalPreload(key)
    let waited = false
    const waiting = waitForLocalPreload(key).then(() => { waited = true })
    // Another model, or another server: nothing to wait for.
    await waitForLocalPreload(localPreloadKey('ollama', server, 'model-b'))
    await waitForLocalPreload(localPreloadKey('ollama', 'http://127.0.0.1:11435/v1', 'model-a'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(waited).toBe(false)
    finish()
    await waiting
    expect(waited).toBe(true)
    // Ended: no wait.
    await waitForLocalPreload(key)
  })

  test('an abort ends the wait', async () => {
    const key = localPreloadKey('lmstudio', 'http://127.0.0.1:1234/v1', 'model-a')
    beginLocalPreload(key)
    const controller = new AbortController()
    const waiting = waitForLocalPreload(key, controller.signal)
    controller.abort()
    await waiting
    const aborted = new AbortController()
    aborted.abort()
    await waitForLocalPreload(key, aborted.signal)
  })

  test('the conversation reaching a model is remembered per server and model', () => {
    const key = localPreloadKey('ollama', server, 'model-a')
    expect(localConversationReached(key)).toBe(false)
    noteLocalConversationRequest(key)
    expect(localConversationReached(key)).toBe(true)
    expect(localConversationReached(localPreloadKey('ollama', server, 'model-b'))).toBe(false)
    resetLocalModelSettingsForTests()
    expect(localConversationReached(key)).toBe(false)
  })
})

describe("the context Ollama gives a model on this machine", () => {
  const ROOT = 'http://127.0.0.1:11434'
  type Call = { path: string; method: string; body: any }

  async function withServer(
    answer: (path: string, calls: Call[]) => Response,
    fn: (calls: Call[]) => Promise<void>,
  ): Promise<void> {
    const calls: Call[] = []
    const oldFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return answer(path, calls)
    }) as typeof fetch
    try {
      await fn(calls)
    } finally {
      globalThis.fetch = oldFetch
    }
  }

  const ps = (models: unknown[]) => Response.json({ models })

  test('a loaded model: its context, without loading anything', async () => {
    await withServer(() => ps([{ name: 'qwen3:4b', model: 'qwen3:4b', context_length: 65_536 }]), async calls => {
      expect(await ollamaOwnContext(ROOT, 'qwen3:4b', '')).toBe(65_536)
      expect(calls.map(call => call.path)).toEqual(['/api/ps'])
    })
  })

  test('not loaded: Ollama loads it with no options, and Tau reads the context it chose', async () => {
    let loaded = false
    await withServer(path => {
      if (path === '/api/generate') { loaded = true; return Response.json({ done: true, done_reason: 'load' }) }
      return ps(loaded ? [{ name: 'qwen3:4b', model: 'qwen3:4b', context_length: 4096 }] : [])
    }, async calls => {
      expect(await ollamaOwnContext(ROOT, 'qwen3:4b', '')).toBe(4096)
      expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/ps', 'POST /api/generate', 'GET /api/ps'])
      expect(calls[1]!.body).toEqual({ model: 'qwen3:4b', keep_alive: '30m', stream: false })
      // Asked once per model.
      expect(await ollamaOwnContext(ROOT, 'qwen3:4b', '')).toBe(4096)
      expect(calls).toHaveLength(3)
    })
  })

  test('a model named without a tag is found under :latest', async () => {
    await withServer(() => ps([{ name: 'llama3:latest', model: 'llama3:latest', context_length: 8192 }]), async () => {
      expect(await ollamaOwnContext(ROOT, 'llama3', '')).toBe(8192)
    })
  })

  test('a server without /api/ps or context_length says nothing, gets no load request, and is not asked again', async () => {
    await withServer(() => new Response('not found', { status: 404 }), async calls => {
      expect(await ollamaOwnContext(ROOT, 'a:1b', '')).toBeUndefined()
      expect(await ollamaOwnContext(ROOT, 'a:1b', '')).toBeUndefined()
      expect(calls.map(call => call.path)).toEqual(['/api/ps'])
    })
    await withServer(() => ps([{ name: 'b:1b', model: 'b:1b' }]), async calls => {
      expect(await ollamaOwnContext(ROOT, 'b:1b', '')).toBeUndefined()
      expect(calls.map(call => call.path)).toEqual(['/api/ps'])
    })
  })

  test('the GPU check: a new context is checked again, an unreachable server is quiet', async () => {
    const notices: string[] = []
    const stop = onLocalModelNotice(notice => notices.push(notice.text))
    try {
      const share = (context: number) => ps([{ name: 'gpu:4b', model: 'gpu:4b', context_length: context, size: 1000, size_vram: 750 }])
      let context = 32_768
      await withServer(() => share(context), async calls => {
        await checkOllamaGpuFit(ROOT, 'gpu:4b', '', 32_768)
        await checkOllamaGpuFit(ROOT, 'gpu:4b', '', 32_768)
        context = 65_536
        await checkOllamaGpuFit(ROOT, 'gpu:4b', '', 65_536)
        expect(calls.map(call => call.path)).toEqual(['/api/ps', '/api/ps'])
      })
      expect(notices).toEqual([ollamaCpuShareNotice('gpu:4b', 25, 32_768), ollamaCpuShareNotice('gpu:4b', 25, 65_536)])
      expect(notices[0]).toStartWith('gpu:4b runs 25% on the CPU at 32,768 context, so slower · ')
      await withServer(() => { throw new TypeError('fetch failed') }, async () => {
        await checkOllamaGpuFit(ROOT, 'away:1b', '', 32_768)
      })
      expect(notices).toHaveLength(2)
    } finally {
      stop()
    }
  })

  test('an unreachable server gets no load request and is asked again next time', async () => {
    await withServer(() => { throw new TypeError('fetch failed') }, async calls => {
      expect(await ollamaOwnContext(ROOT, 'c:1b', '')).toBeUndefined()
      expect(await ollamaOwnContext(ROOT, 'c:1b', '')).toBeUndefined()
      expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/ps', 'GET /api/ps'])
    })
  })
})
