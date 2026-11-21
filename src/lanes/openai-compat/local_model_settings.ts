/**
 * Request settings for local model servers: Ollama, LM Studio, and any other
 * OpenAI-compatible server on a loopback address (the `generic` provider).
 *
 * Only a request that isLocalModelRequest() accepts reads anything here, so
 * every hosted provider sends exactly what it sent before. Ollama's `:cloud`
 * models run on ollama.com behind the local daemon; they are not local and
 * keep their old request too.
 *
 * Every setting is an environment variable, so it can also live in the `env`
 * block of settings.json:
 *
 *   OLLAMA_NUM_CTX              context per request: a number, or `auto` (default)
 *   OLLAMA_NUM_CTX_MAX          largest context `auto` may pick (default 32768)
 *   OLLAMA_KEEP_ALIVE           how long Ollama keeps the model loaded (default 30m)
 *   OLLAMA_TRUNCATE             `1` lets Ollama drop the oldest messages of a
 *                               request that does not fit, without saying so
 *   TAU_LOCAL_MAX_OUTPUT_TOKENS most tokens an answer may use
 *   TAU_LOCAL_TEMPERATURE       sampling. Unset keeps the model's own settings
 *   TAU_LOCAL_TOP_P               (its Ollama Modelfile, its LM Studio preset)
 *   TAU_LOCAL_TOP_K
 */

import { isEnvTruthy } from '../../utils/envUtils.js'

/** The context Tau has always asked Ollama for; `auto` never goes below it. */
export const OLLAMA_DEFAULT_NUM_CTX = 16_384
/** The largest context `auto` picks unless OLLAMA_NUM_CTX_MAX says otherwise. */
export const OLLAMA_DEFAULT_NUM_CTX_MAX = 32_768
export const OLLAMA_DEFAULT_KEEP_ALIVE = '30m'

/** `auto` moves in whole steps, so a growing conversation rarely changes it. */
const CONTEXT_STEP = 8_192
/** Room kept for the answer when no output limit is set. */
const ANSWER_ROOM = 8_192
/** The smallest answer limit Tau sends, so a full context still gets a reply. */
const MIN_OUTPUT_TOKENS = 1_024
/**
 * Tau estimates a request's size from its characters before sending it, and
 * the estimate can run low on dense text. Sizing against it adds this share.
 */
const ESTIMATE_MARGIN = 1.15

export function isOllamaCloudModel(model: string): boolean {
  return /[:-]cloud$/i.test(model.trim())
}

/**
 * Whether a request goes to a local model server. Ollama and LM Studio count
 * wherever they run; any other OpenAI-compatible server counts only on a
 * loopback address. A hosted provider pointed at a local proxy is still that
 * provider, so it never matches here.
 */
export function isLocalModelRequest(provider: string, model: string, loopbackUrl: boolean): boolean {
  if (provider === 'ollama') return !isOllamaCloudModel(model)
  if (provider === 'lmstudio') return true
  return provider === 'generic' && loopbackUrl
}

function envText(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function envPositiveInt(name: string): number | undefined {
  const text = envText(name)
  if (text === undefined) return undefined
  const value = Number(text)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function envNumber(name: string, accepts: (value: number) => boolean): number | undefined {
  const text = envText(name)
  if (text === undefined) return undefined
  const value = Number(text)
  return Number.isFinite(value) && accepts(value) ? value : undefined
}

export interface LocalSampling {
  temperature?: number
  top_p?: number
  top_k?: number
}

/**
 * Sampling for a local request. A setting the user made wins. Otherwise only a
 * temperature the caller chose on purpose is kept, such as 0 for a helper that
 * wants the same answer every time. The 1 that Tau's callers send when
 * thinking is off is the Anthropic API's default, not a choice, so it and no
 * temperature at all both leave the model's own settings in charge.
 */
export function resolveLocalSampling(callerTemperature: number | undefined): LocalSampling {
  const temperature = envNumber('TAU_LOCAL_TEMPERATURE', value => value >= 0 && value <= 2)
    ?? (callerTemperature !== undefined && callerTemperature !== 1 ? callerTemperature : undefined)
  const topP = envNumber('TAU_LOCAL_TOP_P', value => value > 0 && value <= 1)
  const topK = envPositiveInt('TAU_LOCAL_TOP_K')
  return {
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { top_p: topP }),
    ...(topK !== undefined && { top_k: topK }),
  }
}

/** The answer limit after TAU_LOCAL_MAX_OUTPUT_TOKENS. */
export function capLocalOutputTokens(requested: number): number {
  const cap = envPositiveInt('TAU_LOCAL_MAX_OUTPUT_TOKENS')
  return cap === undefined ? requested : Math.min(requested, cap)
}

/** A character-based size estimate, raised by the margin sizing works with. */
export function localPromptBudget(estimatedTokens: number): number {
  return Math.ceil(estimatedTokens * ESTIMATE_MARGIN)
}

/** Tokens to keep free for the answer when picking a context size. */
export function localAnswerRoom(requested: number | undefined): number {
  const cap = envPositiveInt('TAU_LOCAL_MAX_OUTPUT_TOKENS')
  if (cap !== undefined) return cap
  return Math.min(requested ?? ANSWER_ROOM, ANSWER_ROOM)
}

/**
 * The answer limit for a request of `promptTokens` in a context of
 * `contextTokens`. Asking for more than the room left makes the server shift
 * its context mid-answer, which throws away the oldest tokens: the system
 * prompt first. Never above what was asked for, and never below a small floor
 * so a nearly full context still answers.
 */
export function fitLocalOutputTokens(
  requested: number | undefined,
  contextTokens: number | undefined,
  promptTokens: number,
): number | undefined {
  if (requested === undefined || contextTokens === undefined || contextTokens <= 0) return requested
  return Math.min(requested, Math.max(MIN_OUTPUT_TOKENS, contextTokens - promptTokens))
}

export type OllamaContextSetting =
  | { kind: 'fixed'; numCtx: number }
  | { kind: 'auto'; max: number }

export function ollamaContextSetting(): OllamaContextSetting {
  const text = envText('OLLAMA_NUM_CTX')
  if (text !== undefined && text.toLowerCase() !== 'auto') {
    // parseInt, as Tau has always read this variable.
    const fixed = Number.parseInt(text, 10)
    if (Number.isFinite(fixed) && fixed > 0) return { kind: 'fixed', numCtx: fixed }
  }
  return { kind: 'auto', max: envPositiveInt('OLLAMA_NUM_CTX_MAX') ?? OLLAMA_DEFAULT_NUM_CTX_MAX }
}

export function ollamaKeepAlive(): string {
  return process.env.OLLAMA_KEEP_ALIVE ?? OLLAMA_DEFAULT_KEEP_ALIVE
}

/**
 * `truncate: false` asks Ollama to refuse a request that does not fit instead
 * of dropping its oldest messages without a word. OLLAMA_TRUNCATE=1 keeps
 * Ollama's own behavior.
 */
export function ollamaTruncateFields(): { truncate?: false } {
  return isEnvTruthy(process.env.OLLAMA_TRUNCATE) ? {} : { truncate: false }
}

// Contexts already asked for, per server and model. Ollama reloads a model
// whenever num_ctx changes, so `auto` only ever grows within one process.
const chosenContexts = new Map<string, number>()

export function ollamaContextKey(serverRoot: string, model: string): string {
  return `${serverRoot}\n${model}`
}

function autoCeiling(setting: { max: number }, modelMax: number | undefined): number {
  return Math.max(1, Math.min(setting.max, modelMax ?? Number.POSITIVE_INFINITY))
}

/**
 * The context to ask Ollama for. A fixed OLLAMA_NUM_CTX is used as given.
 * `auto` fits the request plus room for the answer, in 8K steps from 16K,
 * never past OLLAMA_NUM_CTX_MAX or the model's own limit, and never below the
 * context already used for this model.
 */
export function chooseOllamaNumCtx(input: {
  key: string
  promptTokens: number
  answerRoom: number
  modelMax?: number
  setting: OllamaContextSetting
}): number {
  const { setting } = input
  if (setting.kind === 'fixed') return setting.numCtx
  const ceiling = autoCeiling(setting, input.modelMax)
  const needed = Math.ceil((input.promptTokens + input.answerRoom) / CONTEXT_STEP) * CONTEXT_STEP
  const fitted = Math.min(ceiling, Math.max(OLLAMA_DEFAULT_NUM_CTX, needed))
  const chosen = Math.min(ceiling, Math.max(fitted, chosenContexts.get(input.key) ?? 0))
  chosenContexts.set(input.key, chosen)
  return chosen
}

/**
 * After Ollama refused a request as too long, the larger context that holds
 * its exact size plus room for the answer. Undefined when a fixed
 * OLLAMA_NUM_CTX or the ceiling leaves nothing larger to try.
 */
export function growOllamaNumCtx(input: {
  key: string
  requestTokens: number
  answerRoom: number
  modelMax?: number
  setting: OllamaContextSetting
  current: number
}): number | undefined {
  const { setting } = input
  if (setting.kind === 'fixed') return undefined
  const ceiling = autoCeiling(setting, input.modelMax)
  const wanted = Math.ceil((input.requestTokens + input.answerRoom) / CONTEXT_STEP) * CONTEXT_STEP
  const grown = Math.min(ceiling, wanted)
  if (grown <= input.current || grown < input.requestTokens + MIN_OUTPUT_TOKENS) return undefined
  chosenContexts.set(input.key, grown)
  return grown
}

const OVERFLOW_PATTERN = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i

/** Ollama's refusal of a request larger than its context (`truncate: false`). */
export function parseOllamaContextOverflow(
  text: string,
): { requestTokens: number; contextTokens: number } | undefined {
  const match = OVERFLOW_PATTERN.exec(text)
  if (!match) return undefined
  return { requestTokens: Number(match[1]), contextTokens: Number(match[2]) }
}

/** What to tell the user when a request still does not fit. */
export function ollamaOverflowAdvice(
  overflow: { requestTokens: number; contextTokens: number },
  setting: OllamaContextSetting,
  modelMax?: number,
): string {
  const sizes = `This request is ${overflow.requestTokens} tokens and Ollama's context is ${overflow.contextTokens}. `
  if (setting.kind === 'auto' && modelMax !== undefined && modelMax <= setting.max) {
    return sizes + `This model takes at most ${modelMax} tokens: run /compact, or pick a model with a larger context.`
  }
  const raise = setting.kind === 'auto'
    ? `raise OLLAMA_NUM_CTX_MAX (now ${setting.max})`
    : `raise OLLAMA_NUM_CTX (now ${setting.numCtx})`
  return sizes
    + `Run /compact, or ${raise}. `
    + 'With OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0 set for Ollama (then restart it), a larger context fits on the GPU.'
}

// A model's own context limit, from Ollama's /api/show, per server and model.
const modelLimits = new Map<string, Promise<number | undefined>>()

/**
 * The model's trained context length, which `auto` never goes past. One
 * /api/show request per model per process; a server that cannot answer just
 * leaves no limit.
 */
export function ollamaModelContextLength(
  serverRoot: string,
  model: string,
  apiKey: string,
): Promise<number | undefined> {
  const key = ollamaContextKey(serverRoot, model)
  let pending = modelLimits.get(key)
  if (!pending) {
    pending = fetchOllamaModelContextLength(serverRoot, model, apiKey)
    modelLimits.set(key, pending)
  }
  return pending
}

async function fetchOllamaModelContextLength(
  serverRoot: string,
  model: string,
  apiKey: string,
): Promise<number | undefined> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const response = await fetch(`${serverRoot}/api/show`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return undefined
    const info = await response.json() as { model_info?: Record<string, unknown> }
    for (const [name, value] of Object.entries(info.model_info ?? {})) {
      if (name.endsWith('.context_length') && typeof value === 'number' && value > 0) return value
    }
    return undefined
  } catch {
    // Unreachable or slow: try again on the next request.
    modelLimits.delete(ollamaContextKey(serverRoot, model))
    return undefined
  }
}

/** Test seam: forget every context chosen and limit read in this process. */
export function resetLocalModelSettingsForTests(): void {
  chosenContexts.clear()
  modelLimits.clear()
}
