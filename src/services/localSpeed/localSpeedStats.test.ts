import { beforeEach, describe, expect, test } from 'bun:test'
import {
  CHARS_PER_TOKEN,
  MAX_SAMPLES_PER_MODEL,
  MIN_GENERATION_MS,
  formatLocalSpeedLines,
  getLocalSpeedRows,
  isLocalSpeedProvider,
  isTimedQuerySource,
  noteLocalServerTimings,
  ollamaServerTimings,
  recordLocalSpeedSample,
  resetLocalSpeedStats,
  summarizeLocalSpeed,
  takeLocalServerTimings,
  toLocalSpeedSample,
  type LocalSpeedSampleInput,
} from './localSpeedStats.js'

// A reply that waited 2 s for its first token, then streamed 61 tokens over
// 1.5 s: 60 tokens after the first one, so 40 tokens per second.
function input(overrides: Partial<LocalSpeedSampleInput> = {}): LocalSpeedSampleInput {
  return {
    provider: 'ollama',
    model: 'qwen3:8b',
    querySource: 'repl_main_thread',
    attemptStartMs: 1000,
    firstContentMs: 3000,
    endMs: 4500,
    reportedOutputTokens: 61,
    generatedChars: 0,
    nonStreaming: false,
    ...overrides,
  }
}

beforeEach(() => resetLocalSpeedStats())

describe('which requests count', () => {
  test('only Ollama and LM Studio', () => {
    expect(isLocalSpeedProvider('ollama')).toBe(true)
    expect(isLocalSpeedProvider('lmstudio')).toBe(true)
    for (const provider of ['firstParty', 'openai', 'deepseek', 'openrouter', 'antigravity', 'gemini', 'kilo', '', undefined, null]) {
      expect(isLocalSpeedProvider(provider)).toBe(false)
      expect(toLocalSpeedSample(input({ provider }))).toBeNull()
    }
  })

  test('the chat, print mode and sub-agents, but no background work', () => {
    for (const source of ['repl_main_thread', 'repl_main_thread:outputStyle:Explanatory', 'sdk', 'agent:builtin:general-purpose', 'agent:builtin:fork', 'agent:default', 'agent:custom']) {
      expect(isTimedQuerySource(source)).toBe(true)
    }
    for (const source of ['compact', 'prompt_suggestion', 'speculation', 'session_memory', 'extract_memories', 'generate_session_title', 'goal_judge', 'agent_summary', 'agent_creation', 'away_summary', 'web_fetch_apply', '', undefined]) {
      expect(isTimedQuerySource(source)).toBe(false)
      expect(toLocalSpeedSample(input({ querySource: source }))).toBeNull()
    }
  })

  test('a reply from the non-streaming retry is left out', () => {
    expect(toLocalSpeedSample(input({ nonStreaming: true }))).toBeNull()
  })

  test('a reply without streamed content or without an end is left out', () => {
    expect(toLocalSpeedSample(input({ firstContentMs: null }))).toBeNull()
    expect(toLocalSpeedSample(input({ endMs: null }))).toBeNull()
  })

  test('output that arrives in one piece is left out', () => {
    expect(toLocalSpeedSample(input({ endMs: 3000 + MIN_GENERATION_MS - 1 }))).toBeNull()
    expect(toLocalSpeedSample(input({ endMs: 3000 + MIN_GENERATION_MS }))).not.toBeNull()
  })

  test('impossible or empty timings are left out', () => {
    expect(toLocalSpeedSample(input({ firstContentMs: 900 }))).toBeNull()
    expect(toLocalSpeedSample(input({ attemptStartMs: Number.NaN }))).toBeNull()
    expect(toLocalSpeedSample(input({ endMs: Number.POSITIVE_INFINITY }))).toBeNull()
    expect(toLocalSpeedSample(input({ model: '' }))).toBeNull()
  })

  test('fewer than two tokens is left out', () => {
    expect(toLocalSpeedSample(input({ reportedOutputTokens: 1 }))).toBeNull()
    expect(toLocalSpeedSample(input({ reportedOutputTokens: 0, generatedChars: CHARS_PER_TOKEN }))).toBeNull()
  })
})

describe('token counts', () => {
  test('the count the server reported is used as is', () => {
    const sample = toLocalSpeedSample(input())
    expect(sample).toEqual({
      provider: 'ollama',
      model: 'qwen3:8b',
      waitMs: 2000,
      generationMs: 1500,
      tokens: 61,
      countedTokens: 60,
      estimated: false,
    })
  })

  test('without a reported count, tokens are estimated from the text length', () => {
    for (const reportedOutputTokens of [0, undefined, null, Number.NaN]) {
      const sample = toLocalSpeedSample(input({ reportedOutputTokens, generatedChars: 61 * CHARS_PER_TOKEN }))
      expect(sample?.tokens).toBe(61)
      expect(sample?.estimated).toBe(true)
    }
  })
})

describe("Ollama's own figures", () => {
  // The last /api/chat chunk: durations are in nanoseconds.
  const lastChunk = {
    done: true,
    done_reason: 'stop',
    eval_count: 120,
    eval_duration: 2_400_000_000,
    prompt_eval_count: 9000,
    prompt_eval_duration: 900_000_000,
    load_duration: 300_000_000,
  }

  test('are read from the last chunk', () => {
    expect(ollamaServerTimings(lastChunk)).toEqual({ outputTokens: 120, generationMs: 2400, waitMs: 1200 })
  })

  test('need a token count and a generation time', () => {
    expect(ollamaServerTimings({ ...lastChunk, eval_count: undefined })).toBeUndefined()
    expect(ollamaServerTimings({ ...lastChunk, eval_duration: undefined })).toBeUndefined()
    expect(ollamaServerTimings({ ...lastChunk, eval_duration: 0 })).toBeUndefined()
    expect(ollamaServerTimings({ ...lastChunk, eval_count: 0 })).toBeUndefined()
    expect(ollamaServerTimings({ ...lastChunk, eval_count: '120' })).toBeUndefined()
    expect(ollamaServerTimings(null)).toBeUndefined()
    expect(ollamaServerTimings('done')).toBeUndefined()
  })

  test('treat a missing load or prompt time as zero', () => {
    const { load_duration: _load, prompt_eval_duration: _prompt, ...bare } = lastChunk
    expect(ollamaServerTimings(bare)).toEqual({ outputTokens: 120, generationMs: 2400, waitMs: 0 })
  })

  test('take precedence over Tau clock, so hidden output and one-piece tool calls still count', () => {
    // Tau saw only a sliver of streamed text, which alone would be left out.
    const sample = toLocalSpeedSample(input({
      firstContentMs: 3000,
      endMs: 3010,
      reportedOutputTokens: 120,
      serverTimings: ollamaServerTimings(lastChunk),
    }))
    expect(sample).toEqual({ provider: 'ollama', model: 'qwen3:8b', waitMs: 1200, generationMs: 2400, tokens: 120, countedTokens: 120, estimated: false })
    const [row] = summarizeLocalSpeed([sample!])
    expect(row!.tokensPerSecond).toBeCloseTo(50, 6)
  })

  test('that are unusable fall back to Tau clock', () => {
    const sample = toLocalSpeedSample(input({ serverTimings: { outputTokens: 1, generationMs: 10, waitMs: 5 } }))
    expect(sample?.generationMs).toBe(1500)
    expect(toLocalSpeedSample(input({ serverTimings: { outputTokens: 50, generationMs: Number.NaN, waitMs: 5 } }))?.generationMs).toBe(1500)
  })

  test('still respect the provider, source and streaming rules', () => {
    const serverTimings = ollamaServerTimings(lastChunk)
    expect(toLocalSpeedSample(input({ provider: 'deepseek', serverTimings }))).toBeNull()
    expect(toLocalSpeedSample(input({ querySource: 'compact', serverTimings }))).toBeNull()
    expect(toLocalSpeedSample(input({ nonStreaming: true, serverTimings }))).toBeNull()
  })

  test('are handed over under the message object, once', () => {
    const message = { id: 'ollama-1' }
    const timings = ollamaServerTimings(lastChunk)
    noteLocalServerTimings(message, timings)
    expect(takeLocalServerTimings({ id: 'ollama-1' })).toBeUndefined()
    expect(takeLocalServerTimings(message)).toEqual(timings)
    expect(takeLocalServerTimings(message)).toBeUndefined()
    noteLocalServerTimings(undefined, timings)
    noteLocalServerTimings(message, undefined)
    expect(takeLocalServerTimings(message)).toBeUndefined()
    expect(takeLocalServerTimings(undefined)).toBeUndefined()
  })
})

describe('summary', () => {
  test('the rate counts the tokens after the first one over the streamed time', () => {
    const [row] = summarizeLocalSpeed([toLocalSpeedSample(input())!])
    expect(row!.tokensPerSecond).toBeCloseTo(40, 6)
    expect(row!.medianWaitMs).toBe(2000)
    expect(row!.replies).toBe(1)
    expect(row!.estimated).toBe(false)
  })

  test('the rate is pooled over replies, so long replies weigh more than short ones', () => {
    const long = toLocalSpeedSample(input({ reportedOutputTokens: 201, endMs: 3000 + 5000 }))!
    const short = toLocalSpeedSample(input({ reportedOutputTokens: 11, endMs: 3000 + 500 }))!
    const [row] = summarizeLocalSpeed([long, short])
    expect(row!.tokensPerSecond).toBeCloseTo((200 + 10) / 5.5, 6)
  })

  test('a slow first reply (model loading) does not move the median wait', () => {
    const waits = [10_000, 2000, 2100]
    const samples = waits.map(wait => toLocalSpeedSample(input({ attemptStartMs: 0, firstContentMs: wait, endMs: wait + 1500 }))!)
    expect(summarizeLocalSpeed(samples)[0]!.medianWaitMs).toBe(2100)
    const even = [...samples, toLocalSpeedSample(input({ attemptStartMs: 0, firstContentMs: 1900, endMs: 3400 }))!]
    expect(summarizeLocalSpeed(even)[0]!.medianWaitMs).toBe((2000 + 2100) / 2)
  })

  test('the same model name on Ollama and LM Studio stays two rows', () => {
    const rows = summarizeLocalSpeed([
      toLocalSpeedSample(input({ provider: 'lmstudio' }))!,
      toLocalSpeedSample(input({ provider: 'ollama' }))!,
    ])
    expect(rows.map(row => row.provider)).toEqual(['lmstudio', 'ollama'])
  })

  test('one estimated reply marks the whole row as estimated', () => {
    const rows = summarizeLocalSpeed([
      toLocalSpeedSample(input())!,
      toLocalSpeedSample(input({ reportedOutputTokens: 0, generatedChars: 400 }))!,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.estimated).toBe(true)
  })
})

describe('lines for /statistics', () => {
  test('nothing at all when nothing local was timed', () => {
    expect(formatLocalSpeedLines([])).toEqual([])
    expect(formatLocalSpeedLines(getLocalSpeedRows())).toEqual([])
  })

  test('an exact row', () => {
    const rows = summarizeLocalSpeed([toLocalSpeedSample(input())!])
    expect(formatLocalSpeedLines(rows)).toEqual(['qwen3:8b (Ollama): 40 tok/s | first token 2.0 s | 1 reply'])
  })

  test('an estimated row carries a tilde and a note', () => {
    const rows = summarizeLocalSpeed([
      toLocalSpeedSample(input({ provider: 'lmstudio', reportedOutputTokens: 0, generatedChars: 61 * CHARS_PER_TOKEN, firstContentMs: 1450, endMs: 2950 }))!,
      toLocalSpeedSample(input({ provider: 'lmstudio', reportedOutputTokens: 0, generatedChars: 61 * CHARS_PER_TOKEN, firstContentMs: 1450, endMs: 2950 }))!,
    ])
    expect(formatLocalSpeedLines(rows)).toEqual([
      'qwen3:8b (LM Studio): ~40 tok/s | first token 0.45 s | 2 replies',
      '~ estimated from text length: the server sent no token counts',
    ])
  })

  test('slow rates keep a decimal, and long names are shortened', () => {
    const model = 'hf.co/some-organisation/a-very-long-local-model-name-Q4_K_M'
    const rows = summarizeLocalSpeed([toLocalSpeedSample(input({ model, reportedOutputTokens: 13, endMs: 3000 + 2000 }))!])
    const [line] = formatLocalSpeedLines(rows)
    expect(line).toBe('hf.co/some-organisation/a-very-long... (Ollama): 6.0 tok/s | first token 2.0 s | 1 reply')
  })
})

describe('recording', () => {
  test('records valid replies, skips the rest, and resets', () => {
    expect(recordLocalSpeedSample(input())).toBe(true)
    expect(recordLocalSpeedSample(input({ provider: 'deepseek' }))).toBe(false)
    expect(recordLocalSpeedSample(input({ querySource: 'compact' }))).toBe(false)
    expect(getLocalSpeedRows()).toHaveLength(1)
    resetLocalSpeedStats()
    expect(getLocalSpeedRows()).toEqual([])
  })

  test('keeps a bounded number of samples per model', () => {
    for (let index = 0; index < MAX_SAMPLES_PER_MODEL + 5; index++) {
      recordLocalSpeedSample(input())
    }
    expect(getLocalSpeedRows()[0]!.replies).toBe(MAX_SAMPLES_PER_MODEL)
  })

  test('never throws, even on input that throws when read', () => {
    const hostile = new Proxy(input(), {
      get(target, property) {
        if (property === 'provider') throw new Error('boom')
        return Reflect.get(target, property)
      },
    })
    expect(() => recordLocalSpeedSample(hostile)).not.toThrow()
    expect(recordLocalSpeedSample(hostile)).toBe(false)
    expect(getLocalSpeedRows()).toEqual([])
  })
})
