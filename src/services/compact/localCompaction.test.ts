/**
 * Auto compaction for an Ollama model on this machine, through the real
 * window, threshold and blocking functions: it plans for the context Tau
 * sends, and every other provider keeps the generic rules.
 *
 * Config comes from an empty folder, so the user's own settings never leak in.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'tau-local-compaction-'))
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir

const { runWithForcedProvider } = await import('../../utils/forcedProvider.js')
const { getContextWindowForModel } = await import('../../utils/context.js')
const { computeCompactionThreshold } = await import('../../utils/compactionSettings.js')
const { getMaxOutputTokensForModel } = await import('../api/claude.js')
const {
  AUTOCOMPACT_BUFFER_TOKENS,
  calculateTokenWarningState,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} = await import('./autoCompact.js')
const local = await import('../../utils/model/localModelContext.js')

const asProvider = <T>(provider: string, fn: () => T): T =>
  runWithForcedProvider({ provider: provider as never }, fn)

// Tau's request as measured on Ollama 0.40.16: estimated 18,584 tokens from its
// characters, counted 16,014 by Ollama.
function recordTauRequest(model: string): void {
  local.noteLocalFixedPrompt(model, 18_584)
  local.noteLocalTokenCount(model, 18_584, 16_014)
}

const ENV_KEYS = ['OLLAMA_NUM_CTX', 'OLLAMA_NUM_CTX_MAX', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW']
const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  local.resetLocalModelContextForTests()
})

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('an Ollama model on this machine', () => {
  test('where Ollama gives 4K (an 8 GB GPU): plans for the 32K Tau needs, compacts at 80%, refuses only past the window', () => {
    local.noteLocalOwnContext('qwen3:4b', 4096)
    recordTauRequest('qwen3:4b')
    asProvider('ollama', () => {
      expect(getContextWindowForModel('qwen3:4b')).toBe(32_768)
      expect(getAutoCompactThreshold('qwen3:4b')).toBe(26_214)
      expect(getEffectiveContextWindowSize('qwen3:4b')).toBe(32_768 - 1024)
      // Tau's own prompt and a conversation below the trigger are never refused.
      expect(calculateTokenWarningState(16_014, 'qwen3:4b').isAtBlockingLimit).toBe(false)
      expect(calculateTokenWarningState(27_852, 'qwen3:4b').isAtBlockingLimit).toBe(false)
      expect(calculateTokenWarningState(29_000, 'qwen3:4b').isAtBlockingLimit).toBe(true)
    })
  })

  test('compaction fires before Tau would refuse the request itself', () => {
    recordTauRequest('qwen3:4b')
    asProvider('ollama', () => {
      const threshold = getAutoCompactThreshold('qwen3:4b')
      const blockingLimit = getEffectiveContextWindowSize('qwen3:4b') - 3000
      expect(threshold).toBeLessThan(blockingLimit)
    })
  })

  test('before its first request it keeps the generic rules', () => {
    asProvider('ollama', () => {
      expect(getContextWindowForModel('fresh:1b')).toBe(200_000)
      expect(getAutoCompactThreshold('fresh:1b')).toBe(200_000 - 20_000 - AUTOCOMPACT_BUFFER_TOKENS)
    })
  })

  test("a model too small to compact into never makes Tau refuse its own requests (llama3's 8K)", () => {
    local.noteLocalFixedPrompt('llama3:8b', 18_584)
    local.noteLocalModelLimit('llama3:8b', 8192)
    asProvider('ollama', () => {
      expect(getContextWindowForModel('llama3:8b')).toBe(200_000)
      expect(calculateTokenWarningState(16_014, 'llama3:8b').isAtBlockingLimit).toBe(false)
    })
  })

  test('where Ollama gives 256K (a 48 GB GPU): the generic reserves, exactly as for any 256K model', () => {
    local.noteLocalOwnContext('qwen3:4b', 262_144)
    recordTauRequest('qwen3:4b')
    asProvider('ollama', () => {
      expect(getContextWindowForModel('qwen3:4b')).toBe(262_144)
      const reserve = Math.min(getMaxOutputTokensForModel('qwen3:4b'), 20_000)
      const generic = computeCompactionThreshold({
        contextWindow: 262_144,
        reservedForSummary: reserve,
        bufferTokens: AUTOCOMPACT_BUFFER_TOKENS,
        thresholdPercent: undefined,
        windowCap: undefined,
      })
      expect(getAutoCompactThreshold('qwen3:4b')).toBe(generic.threshold)
      expect(getEffectiveContextWindowSize('qwen3:4b')).toBe(262_144 - reserve)
    })
  })

  test('a 64K window keeps 20% for the summary, still less than the generic reserves', () => {
    local.noteLocalOwnContext('qwen3:4b', 65_536)
    recordTauRequest('qwen3:4b')
    asProvider('ollama', () => {
      expect(getAutoCompactThreshold('qwen3:4b')).toBe(Math.floor(65_536 * 0.8))
      expect(getEffectiveContextWindowSize('qwen3:4b')).toBe(65_536 - 1024)
    })
  })

  test('a user percentage still applies, inside the local window', () => {
    recordTauRequest('qwen3:4b')
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50'
    asProvider('ollama', () => {
      expect(getAutoCompactThreshold('qwen3:4b')).toBe(Math.floor(26_214 * 0.5))
    })
  })
})

describe('an LM Studio model', () => {
  test('plans for the context LM Studio loaded it with', () => {
    local.noteLocalLoadedContext('local-model', 32_768)
    recordTauRequest('local-model')
    asProvider('lmstudio', () => {
      expect(getContextWindowForModel('local-model')).toBe(32_768)
      expect(getAutoCompactThreshold('local-model')).toBe(26_214)
      expect(getEffectiveContextWindowSize('local-model')).toBe(32_768 - 1024)
      expect(calculateTokenWarningState(29_000, 'local-model').isAtBlockingLimit).toBe(true)
    })
  })

  test('before LM Studio reports a loaded context it keeps the generic rules', () => {
    recordTauRequest('local-model')
    asProvider('lmstudio', () => {
      const window = getContextWindowForModel('local-model')
      const reserve = Math.min(getMaxOutputTokensForModel('local-model'), 20_000)
      const generic = computeCompactionThreshold({
        contextWindow: window,
        reservedForSummary: reserve,
        bufferTokens: AUTOCOMPACT_BUFFER_TOKENS,
        thresholdPercent: undefined,
        windowCap: undefined,
      })
      expect(getAutoCompactThreshold('local-model')).toBe(generic.threshold)
    })
  })
})

describe('other providers keep the generic rules', () => {
  for (const [provider, model] of [['deepseek', 'deepseek-chat'], ['ollama', 'glm-5.1:cloud'], ['openrouter', 'qwen3:4b']] as const) {
    test(`${provider} ${model}`, () => {
      // Even facts recorded under the same model name change nothing.
      recordTauRequest(model)
      local.noteLocalLoadedContext(model, 32_768)
      local.noteLocalOwnContext(model, 32_768)
      asProvider(provider, () => {
        const window = getContextWindowForModel(model)
        const reserve = Math.min(getMaxOutputTokensForModel(model), 20_000)
        const generic = computeCompactionThreshold({
          contextWindow: window,
          reservedForSummary: reserve,
          bufferTokens: AUTOCOMPACT_BUFFER_TOKENS,
          thresholdPercent: undefined,
          windowCap: undefined,
        })
        expect(getAutoCompactThreshold(model)).toBe(generic.threshold)
        expect(getEffectiveContextWindowSize(model)).toBe(window - reserve)
      })
    })
  }
})
