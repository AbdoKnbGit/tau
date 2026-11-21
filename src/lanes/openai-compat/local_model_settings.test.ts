import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  capLocalOutputTokens,
  chooseOllamaNumCtx,
  fitLocalOutputTokens,
  growOllamaNumCtx,
  isLocalModelRequest,
  isOllamaCloudModel,
  localAnswerRoom,
  ollamaContextSetting,
  ollamaKeepAlive,
  ollamaOverflowAdvice,
  ollamaTruncateFields,
  parseOllamaContextOverflow,
  resetLocalModelSettingsForTests,
  resolveLocalSampling,
} from './local_model_settings.js'
import { shouldPrimeOllamaCloudModels } from '../../utils/model/ollamaCatalog.js'

const ENV_KEYS = [
  'OLLAMA_NUM_CTX',
  'OLLAMA_NUM_CTX_MAX',
  'OLLAMA_KEEP_ALIVE',
  'OLLAMA_TRUNCATE',
  'TAU_LOCAL_MAX_OUTPUT_TOKENS',
  'TAU_LOCAL_TEMPERATURE',
  'TAU_LOCAL_TOP_P',
  'TAU_LOCAL_TOP_K',
]
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  resetLocalModelSettingsForTests()
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

describe('Ollama cloud pre-pull', () => {
  test('only an interactive session on Ollama pulls the cloud list', () => {
    expect(shouldPrimeOllamaCloudModels('ollama', false)).toBe(true)
    expect(shouldPrimeOllamaCloudModels('ollama', true)).toBe(false)
    expect(shouldPrimeOllamaCloudModels('deepseek', false)).toBe(false)
    expect(shouldPrimeOllamaCloudModels('lmstudio', false)).toBe(false)
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
  test('auto by default; a number is fixed; auto and junk mean auto', () => {
    expect(ollamaContextSetting()).toEqual({ kind: 'auto', max: 32_768 })
    process.env.OLLAMA_NUM_CTX = '20000'
    expect(ollamaContextSetting()).toEqual({ kind: 'fixed', numCtx: 20_000 })
    process.env.OLLAMA_NUM_CTX = 'auto'
    process.env.OLLAMA_NUM_CTX_MAX = '65536'
    expect(ollamaContextSetting()).toEqual({ kind: 'auto', max: 65_536 })
    process.env.OLLAMA_NUM_CTX = 'lots'
    expect(ollamaContextSetting()).toEqual({ kind: 'auto', max: 65_536 })
  })

  test('auto keeps 16K for a request that fits it, as Tau always sent', () => {
    const numCtx = chooseOllamaNumCtx({ key: 'a', promptTokens: 4000, answerRoom: 8192, setting: { kind: 'auto', max: 32_768 } })
    expect(numCtx).toBe(16_384)
  })

  test("auto fits Tau's 16K-token prompt with room for the answer", () => {
    const numCtx = chooseOllamaNumCtx({ key: 'b', promptTokens: 18_700, answerRoom: 8192, setting: { kind: 'auto', max: 32_768 } })
    expect(numCtx).toBe(32_768)
  })

  test("auto stops at the ceiling and at the model's own limit", () => {
    expect(chooseOllamaNumCtx({ key: 'c', promptTokens: 60_000, answerRoom: 8192, setting: { kind: 'auto', max: 32_768 } })).toBe(32_768)
    expect(chooseOllamaNumCtx({ key: 'd', promptTokens: 18_000, answerRoom: 8192, modelMax: 8192, setting: { kind: 'auto', max: 32_768 } })).toBe(8192)
  })

  test('auto never shrinks for the same model, so Ollama does not reload it', () => {
    const setting = { kind: 'auto', max: 65_536 } as const
    expect(chooseOllamaNumCtx({ key: 'e', promptTokens: 30_000, answerRoom: 8192, setting })).toBe(40_960)
    expect(chooseOllamaNumCtx({ key: 'e', promptTokens: 2000, answerRoom: 1024, setting })).toBe(40_960)
    expect(chooseOllamaNumCtx({ key: 'other', promptTokens: 2000, answerRoom: 1024, setting })).toBe(16_384)
  })

  test('a fixed context is used as given', () => {
    expect(chooseOllamaNumCtx({ key: 'f', promptTokens: 60_000, answerRoom: 8192, setting: { kind: 'fixed', numCtx: 12_000 } })).toBe(12_000)
  })

  test("growing after Ollama's refusal uses the exact size, up to the ceiling", () => {
    const setting = { kind: 'auto', max: 32_768 } as const
    expect(growOllamaNumCtx({ key: 'g', requestTokens: 18_000, answerRoom: 8192, setting, current: 16_384 })).toBe(32_768)
    // The answer room no longer fits, but the request does with a short answer.
    expect(growOllamaNumCtx({ key: 'h', requestTokens: 30_000, answerRoom: 8192, setting, current: 16_384 })).toBe(32_768)
    // Nothing larger to try.
    expect(growOllamaNumCtx({ key: 'i', requestTokens: 40_000, answerRoom: 8192, setting, current: 32_768 })).toBeUndefined()
    expect(growOllamaNumCtx({ key: 'j', requestTokens: 18_000, answerRoom: 8192, setting: { kind: 'fixed', numCtx: 16_384 }, current: 16_384 })).toBeUndefined()
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
    expect(ollamaOverflowAdvice(overflow, { kind: 'auto', max: 32_768 }, 8192)).toContain('This model takes at most 8192 tokens')
    expect(ollamaOverflowAdvice(overflow, { kind: 'auto', max: 32_768 }, 262_144)).toContain('OLLAMA_NUM_CTX_MAX (now 32768)')
  })

  test('truncate: false unless OLLAMA_TRUNCATE asks for silent truncation', () => {
    expect(ollamaTruncateFields()).toEqual({ truncate: false })
    process.env.OLLAMA_TRUNCATE = '1'
    expect(ollamaTruncateFields()).toEqual({})
  })

  test('keep-alive defaults to 30 minutes', () => {
    expect(ollamaKeepAlive()).toBe('30m')
    process.env.OLLAMA_KEEP_ALIVE = '2h'
    expect(ollamaKeepAlive()).toBe('2h')
  })
})
