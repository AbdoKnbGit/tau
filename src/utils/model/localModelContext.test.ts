import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  isLocalContextProvider,
  localAutoContextRange,
  localCompactionProfile,
  localModelContext,
  localModelContextWindow,
  localTokenEstimate,
  localWorkableContext,
  noteLocalFixedPrompt,
  noteLocalModelLimit,
  noteLocalOwnContext,
  noteLocalSentContext,
  noteLocalTokenCount,
  resetLocalModelContextForTests,
} from './localModelContext.js'

const ENV_KEYS = ['OLLAMA_NUM_CTX', 'OLLAMA_NUM_CTX_MAX']
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  resetLocalModelContextForTests()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// Measured on Ollama 0.40.16 with qwen3:0.6b: Tau's print-mode request was
// estimated at 18,584 tokens from its characters and counted 16,014.
const TAU_REQUEST_ESTIMATE = 18_584
const TAU_REQUEST_EXACT = 16_014

function recordTauRequest(model: string): void {
  noteLocalFixedPrompt(model, TAU_REQUEST_ESTIMATE)
  noteLocalTokenCount(model, TAU_REQUEST_ESTIMATE, TAU_REQUEST_EXACT)
}

describe('which models are planned for', () => {
  test('Ollama models on this machine only', () => {
    expect(isLocalContextProvider('ollama', 'qwen3:4b')).toBe(true)
    expect(isLocalContextProvider('ollama', 'glm-5.1:cloud')).toBe(false)
    expect(isLocalContextProvider('lmstudio', 'local-model')).toBe(false)
    expect(isLocalContextProvider('deepseek', 'deepseek-chat')).toBe(false)
  })

  test('every other provider gets no window and no profile, whatever was recorded', () => {
    recordTauRequest('deepseek-chat')
    noteLocalOwnContext('deepseek-chat', 262_144)
    for (const provider of ['deepseek', 'openrouter', 'firstParty', 'lmstudio', 'mistral']) {
      expect(localModelContext(provider, 'deepseek-chat')).toBeUndefined()
      expect(localCompactionProfile(provider, 'deepseek-chat')).toBeUndefined()
      expect(localModelContextWindow(provider, 'deepseek-chat', 200_000)).toBeUndefined()
    }
    expect(localModelContextWindow('ollama', 'minimax-m2.7:cloud', 200_000)).toBeUndefined()
  })
})

describe('the context the model has', () => {
  test('nothing is assumed before Tau has built a request for the model', () => {
    expect(localModelContext('ollama', 'qwen3:4b')).toBeUndefined()
    expect(localAutoContextRange('qwen3:4b')).toBeUndefined()
  })

  test("auto starts where it will stay, except for what Ollama's first count settles", () => {
    noteLocalOwnContext('qwen3:4b', 4096)
    noteLocalFixedPrompt('qwen3:4b', TAU_REQUEST_ESTIMATE)
    expect(localAutoContextRange('qwen3:4b')).toEqual({ floor: 32_768, ceiling: 40_960 })
    noteLocalTokenCount('qwen3:4b', TAU_REQUEST_ESTIMATE, TAU_REQUEST_EXACT)
    expect(localAutoContextRange('qwen3:4b')).toEqual({ floor: 32_768, ceiling: 32_768 })
    // A heavy prompt settles higher, and auto starts there from then on.
    noteLocalFixedPrompt('heavy:8b', 30_000)
    noteLocalTokenCount('heavy:8b', 32_000, 28_800)
    expect(localAutoContextRange('heavy:8b')).toEqual({ floor: 49_152, ceiling: 49_152 })
  })

  test("a big machine: Ollama's own context, capped only by the model's limit", () => {
    recordTauRequest('qwen3:4b')
    noteLocalOwnContext('qwen3:4b', 262_144)
    expect(localModelContext('ollama', 'qwen3:4b')).toBe(262_144)
    noteLocalModelLimit('qwen3:4b', 40_960)
    expect(localModelContext('ollama', 'qwen3:4b')).toBe(40_960)
  })

  test("a small machine: Ollama's own 4K is raised to the least Tau can work in", () => {
    noteLocalOwnContext('qwen3:4b', 4096)
    noteLocalFixedPrompt('qwen3:4b', TAU_REQUEST_ESTIMATE)
    // Before Ollama has counted Tau's prompt, its estimate carries a 15% margin.
    expect(localModelContext('ollama', 'qwen3:4b')).toBe(40_960)
    noteLocalTokenCount('qwen3:4b', TAU_REQUEST_ESTIMATE, TAU_REQUEST_EXACT)
    expect(localModelContext('ollama', 'qwen3:4b')).toBe(32_768)
  })

  test("the least Tau needs follows Tau's own prompt, with room for a summary however lean it is", () => {
    noteLocalFixedPrompt('lean:1b', 4000)
    noteLocalFixedPrompt('heavy:8b', 30_000)
    recordTauRequest('usual:4b')
    // A lean prompt still leaves 6K above the 80% trigger for the compaction itself.
    expect(localWorkableContext('lean:1b')).toBe(32_768)
    expect(localWorkableContext('usual:4b')).toBe(32_768)
    // More tools or MCP servers ask for more.
    expect(localWorkableContext('heavy:8b')).toBe(57_344)
  })

  test('a fixed context smaller than auto would pick still plans compaction when it can help', () => {
    process.env.OLLAMA_NUM_CTX = '24576'
    noteLocalFixedPrompt('lean:1b', 4000)
    noteLocalTokenCount('lean:1b', 4000, 3600)
    expect(localCompactionProfile('ollama', 'lean:1b')?.window).toBe(24_576)
  })

  test("a helper request's short prompt does not make the prompt look smaller", () => {
    noteLocalFixedPrompt('qwen3:4b', TAU_REQUEST_ESTIMATE)
    noteLocalFixedPrompt('qwen3:4b', 500)
    expect(localWorkableContext('qwen3:4b')).toBe(40_960)
  })

  test('a context Tau already sent is kept, so Ollama does not reload the model', () => {
    recordTauRequest('qwen3:4b')
    noteLocalOwnContext('qwen3:4b', 4096)
    noteLocalSentContext('qwen3:4b', 65_536)
    noteLocalSentContext('qwen3:4b', 32_768)
    expect(localModelContext('ollama', 'qwen3:4b')).toBe(65_536)
  })

  test("OLLAMA_NUM_CTX_MAX: up to it, capped by the model's limit; OLLAMA_NUM_CTX: as given", () => {
    recordTauRequest('qwen3:4b')
    noteLocalOwnContext('qwen3:4b', 4096)
    process.env.OLLAMA_NUM_CTX_MAX = '1048576'
    expect(localModelContext('ollama', 'qwen3:4b')).toBe(1_048_576)
    noteLocalModelLimit('qwen3:4b', 262_144)
    expect(localModelContext('ollama', 'qwen3:4b')).toBe(262_144)
    process.env.OLLAMA_NUM_CTX = '24000'
    expect(localModelContext('ollama', 'qwen3:4b')).toBe(24_000)
  })
})

describe('token estimates', () => {
  test('raised by 15% until Ollama has counted, then scaled by its count plus 5%', () => {
    expect(localTokenEstimate('qwen3:4b', 10_000)).toBe(11_500)
    noteLocalTokenCount('qwen3:4b', TAU_REQUEST_ESTIMATE, TAU_REQUEST_EXACT)
    const scaled = localTokenEstimate('qwen3:4b', TAU_REQUEST_ESTIMATE)
    expect(scaled).toBeGreaterThan(TAU_REQUEST_EXACT)
    expect(scaled).toBeLessThan(Math.ceil(TAU_REQUEST_EXACT * 1.06))
    // Another model keeps its own scale.
    expect(localTokenEstimate('qwen3:0.6b', 10_000)).toBe(11_500)
  })

  test('a count no tokenizer could give is ignored', () => {
    // A stand-in server that reports 100 tokens for a 20K-token request.
    noteLocalTokenCount('proxy:1b', 20_000, 100)
    noteLocalTokenCount('proxy:1b', 20_000, 200_000)
    expect(localTokenEstimate('proxy:1b', 10_000)).toBe(11_500)
  })
})

describe('the compaction profile', () => {
  test('none before Tau has sent the model a request', () => {
    expect(localCompactionProfile('ollama', 'qwen3:4b')).toBeUndefined()
    expect(localModelContextWindow('ollama', 'qwen3:4b', 200_000)).toBe(200_000)
  })

  test("a small machine: planned at the least Tau's prompt needs", () => {
    noteLocalOwnContext('qwen3:4b', 4096)
    recordTauRequest('qwen3:4b')
    expect(localCompactionProfile('ollama', 'qwen3:4b')).toEqual({
      window: 32_768,
      summaryReserve: 32_768 - 26_214,
      outputReserve: 1024,
      fileRestoreBudget: 3276,
      skillRestoreBudget: 1638,
    })
    expect(localModelContextWindow('ollama', 'qwen3:4b', 200_000)).toBe(32_768)
  })

  test('a big machine: planned at the context Ollama gives the model', () => {
    noteLocalOwnContext('qwen3:4b', 262_144)
    recordTauRequest('qwen3:4b')
    const profile = localCompactionProfile('ollama', 'qwen3:4b')
    expect(profile?.window).toBe(262_144)
    // Shares of the window; autoCompact.ts and compact.ts keep the generic
    // reserves and budgets once these are larger.
    expect(profile?.summaryReserve).toBe(262_144 - Math.floor(262_144 * 0.8))
    expect(profile?.fileRestoreBudget).toBe(26_214)
  })

  test('a 1M model with OLLAMA_NUM_CTX_MAX set to match', () => {
    process.env.OLLAMA_NUM_CTX_MAX = '1048576'
    noteLocalModelLimit('long:8b', 1_048_576)
    recordTauRequest('long:8b')
    expect(localCompactionProfile('ollama', 'long:8b')?.window).toBe(1_048_576)
  })

  test('denser conversation text later in the session does not switch compaction off', () => {
    // Live on qwen3:0.6b: Tau's first request counted 0.90 of the estimate;
    // after a few turns of dense notes the latest ratio was 0.98.
    noteLocalOwnContext('qwen3:0.6b', 4096)
    noteLocalFixedPrompt('qwen3:0.6b', 17_000)
    noteLocalTokenCount('qwen3:0.6b', 20_476, 18_420)
    expect(localCompactionProfile('ollama', 'qwen3:0.6b')?.window).toBe(32_768)
    noteLocalTokenCount('qwen3:0.6b', 26_430, 25_991)
    noteLocalFixedPrompt('qwen3:0.6b', 17_100)
    expect(localCompactionProfile('ollama', 'qwen3:0.6b')?.window).toBe(32_768)
    // Request sizing follows the latest ratio.
    expect(localTokenEstimate('qwen3:0.6b', 10_000)).toBe(Math.ceil(10_000 * (25_991 / 26_430) * 1.05))
  })

  test('the fixed prompt is scaled by the first count, which is almost all fixed prompt', () => {
    process.env.OLLAMA_NUM_CTX = '32768'
    noteLocalFixedPrompt('qwen3:4b', 17_600)
    // A first ratio of 0.98 leaves 8,103 tokens under the 26,214 trigger: under 8K.
    noteLocalTokenCount('qwen3:4b', 20_000, 19_600)
    expect(localCompactionProfile('ollama', 'qwen3:4b')).toBeUndefined()
    // A later, lower ratio does not rescue it: only the first one scales the fixed prompt.
    noteLocalTokenCount('qwen3:4b', 20_000, 16_000)
    expect(localCompactionProfile('ollama', 'qwen3:4b')).toBeUndefined()
  })

  test('a fixed context that a growing prompt outgrows stops compacting instead of compacting every turn', () => {
    process.env.OLLAMA_NUM_CTX = '32768'
    recordTauRequest('qwen3:4b')
    expect(localCompactionProfile('ollama', 'qwen3:4b')?.window).toBe(32_768)
    // MCP tools arrive later in the session.
    noteLocalFixedPrompt('qwen3:4b', 24_000)
    expect(localCompactionProfile('ollama', 'qwen3:4b')).toBeUndefined()
  })

  test('a window too small for Tau to compact into keeps the generic default', () => {
    noteLocalFixedPrompt('llama3:8b', 12_000)
    noteLocalTokenCount('llama3:8b', 12_000, 10_000)
    noteLocalModelLimit('llama3:8b', 8192)
    expect(localCompactionProfile('ollama', 'llama3:8b')).toBeUndefined()
    expect(localModelContextWindow('ollama', 'llama3:8b', 200_000)).toBe(200_000)
    process.env.OLLAMA_NUM_CTX = '16384'
    recordTauRequest('qwen3:4b')
    expect(localModelContextWindow('ollama', 'qwen3:4b', 200_000)).toBe(200_000)
  })
})
