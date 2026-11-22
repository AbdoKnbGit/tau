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
 *   OLLAMA_NUM_CTX              context per request: a number, or `auto` (default).
 *                               `auto` uses the context Ollama gives the model on
 *                               this machine, raised to the least Tau needs
 *   OLLAMA_NUM_CTX_MAX          lets `auto` grow up to this many tokens instead
 *   OLLAMA_KEEP_ALIVE           how long Ollama keeps the model loaded (default 30m)
 *   OLLAMA_TRUNCATE             `1` lets Ollama drop the oldest messages of a
 *                               request that does not fit, without saying so
 *   TAU_LOCAL_MAX_OUTPUT_TOKENS most tokens an answer may use
 *   TAU_LOCAL_TEMPERATURE       sampling. Unset keeps the model's own settings
 *   TAU_LOCAL_TOP_P               (its Ollama Modelfile, its LM Studio preset)
 *   TAU_LOCAL_TOP_K
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  envPositiveInt,
  isOllamaCloudModel,
  OLLAMA_DEFAULT_NUM_CTX,
  ollamaContextSetting,
  resetLocalModelContextForTests,
  roundUpToStep,
  type LocalAutoContextRange,
  type OllamaContextSetting,
} from '../../utils/model/localModelContext.js'

// Shared with auto compaction, which plans for the same context.
export {
  isOllamaCloudModel,
  OLLAMA_DEFAULT_NUM_CTX,
  ollamaContextSetting,
  type OllamaContextSetting,
}
export const OLLAMA_DEFAULT_KEEP_ALIVE = '30m'

/** How long Tau waits for Ollama to load a model it asked about. */
const MODEL_LOAD_TIMEOUT_MS = 5 * 60_000
/** Room kept for the answer when no output limit is set. */
const ANSWER_ROOM = 8_192
/** The smallest answer limit Tau sends, so a full context still gets a reply. */
const MIN_OUTPUT_TOKENS = 1_024

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

/** What `auto` knows about the model when it picks a context. */
type AutoContextFacts = {
  /** The model's own limit (Ollama's /api/show). */
  modelMax?: number
  /**
   * Without OLLAMA_NUM_CTX_MAX: where `auto` starts and the most it uses,
   * from the context Ollama gives the model on this machine and the least
   * Tau needs (localAutoContextRange).
   */
  range?: LocalAutoContextRange
}

/**
 * The most `auto` asks for: OLLAMA_NUM_CTX_MAX when it is set, and otherwise
 * the top of its range. The model's own limit caps both.
 */
function autoCeiling(setting: { max?: number }, facts: AutoContextFacts): number {
  const wanted = setting.max ?? facts.range?.ceiling ?? OLLAMA_DEFAULT_NUM_CTX
  return Math.max(1, Math.min(wanted, facts.modelMax ?? Number.POSITIVE_INFINITY))
}

/**
 * The context to ask Ollama for. A fixed OLLAMA_NUM_CTX is used as given.
 * `auto` asks for at least what the request needs (the request plus room for
 * the answer, in whole steps, at least 16K) and at least the bottom of its
 * range, and never goes below a context already used for this model. Every
 * change reloads the model, so it grows by doubling, up to its ceiling.
 */
export function chooseOllamaNumCtx(input: AutoContextFacts & {
  key: string
  promptTokens: number
  answerRoom: number
  setting: OllamaContextSetting
}): number {
  const { setting } = input
  if (setting.kind === 'fixed') return setting.numCtx
  const previous = chosenContexts.get(input.key)
  let wanted = Math.max(OLLAMA_DEFAULT_NUM_CTX, roundUpToStep(input.promptTokens + input.answerRoom), input.range?.floor ?? 0)
  if (previous !== undefined && wanted > previous) wanted = Math.max(wanted, previous * 2)
  const chosen = Math.min(autoCeiling(setting, input), Math.max(wanted, previous ?? 0))
  chosenContexts.set(input.key, chosen)
  return chosen
}

/**
 * After Ollama refused a request as too long, the larger context that holds
 * its exact size plus room for the answer. Undefined when a fixed
 * OLLAMA_NUM_CTX or the ceiling leaves nothing larger to try.
 */
export function growOllamaNumCtx(input: AutoContextFacts & {
  key: string
  requestTokens: number
  answerRoom: number
  setting: OllamaContextSetting
  current: number
}): number | undefined {
  const { setting } = input
  if (setting.kind === 'fixed') return undefined
  const grown = Math.min(autoCeiling(setting, input), roundUpToStep(input.requestTokens + input.answerRoom))
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
  if (modelMax !== undefined && overflow.contextTokens >= modelMax) {
    return sizes + `This model takes at most ${modelMax} tokens: run /compact, or pick a model with a larger context.`
  }
  const raise = setting.kind === 'fixed'
    ? `raise OLLAMA_NUM_CTX (now ${setting.numCtx})`
    : setting.max !== undefined
      ? `raise OLLAMA_NUM_CTX_MAX (now ${setting.max})`
      : 'set OLLAMA_NUM_CTX_MAX to let Tau ask for more than Ollama gives this model here (a context that no longer fits on the GPU runs slower)'
  return sizes
    + `Run /compact, or ${raise}. `
    + 'With OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0 set for Ollama (then restart it), a larger context fits on the GPU.'
}

// The context Ollama gives a model on its own, per server and model.
const ownContexts = new Map<string, Promise<number | undefined>>()

/**
 * The context Ollama gives the model on this machine when Tau does not set
 * one: the context it is loaded with now, or else the one Ollama picks when
 * Tau loads it the way any other app would. Ollama picks that from the GPU's
 * memory (4K, 32K or 256K in Ollama 0.40), or takes the server's
 * OLLAMA_CONTEXT_LENGTH or the model's Modelfile num_ctx, capped by the
 * model's own limit. Asked once per model per process. Undefined when the
 * server does not say (no /api/ps, or an Ollama without context_length); a
 * server that cannot be reached is asked again on the next request, and is
 * never sent a load request.
 */
export function ollamaOwnContext(
  serverRoot: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const key = ollamaContextKey(serverRoot, model)
  const known = ownContexts.get(key)
  if (known) return known
  const pending = readOllamaOwnContext(serverRoot, model, apiKey, signal).catch(() => {
    ownContexts.delete(key)
    return undefined
  })
  ownContexts.set(key, pending)
  return pending
}

async function readOllamaOwnContext(
  serverRoot: string,
  model: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const headers = ollamaHeaders(apiKey)
  const loaded = await readLoadedContext(serverRoot, model, headers)
  if (loaded !== 'not loaded') return loaded
  // A load request with no prompt and no options: Ollama loads the model as it
  // would for any app, and Tau's request then reuses it when it fits.
  const timeout = AbortSignal.timeout(MODEL_LOAD_TIMEOUT_MS)
  const response = await fetch(`${serverRoot}/api/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, keep_alive: ollamaKeepAlive(), stream: false }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  await response.text()
  if (!response.ok) return undefined
  const after = await readLoadedContext(serverRoot, model, headers)
  return after === 'not loaded' ? undefined : after
}

/**
 * The context the model is loaded with, from /api/ps. Undefined when the
 * server does not say; throws when it cannot be reached.
 */
async function readLoadedContext(
  serverRoot: string,
  model: string,
  headers: Record<string, string>,
): Promise<number | undefined | 'not loaded'> {
  const response = await fetch(`${serverRoot}/api/ps`, { headers, signal: AbortSignal.timeout(3_000) })
  if (!response.ok) return undefined
  const data = await response.json().catch(() => undefined) as
    | { models?: Array<{ name?: unknown; model?: unknown; context_length?: unknown }> }
    | undefined
  if (!Array.isArray(data?.models)) return undefined
  // `llama3` is listed as `llama3:latest`.
  const names = new Set([model, model.includes(':') ? model : `${model}:latest`])
  const entry = data.models.find(item => names.has(String(item.name)) || names.has(String(item.model)))
  if (!entry) return 'not loaded'
  const context = entry.context_length
  return typeof context === 'number' && Number.isFinite(context) && context > 0 ? context : undefined
}

// LM Studio servers that refused `stream_options`, by base URL. Without it a
// server sends no token counts, so Tau asks for them until one refuses.
const refusesStreamOptions = new Set<string>()

/**
 * Whether an error from LM Studio's server is a refusal of `stream_options`
 * (an older LM Studio, or another OpenAI-compatible server behind the LM
 * Studio provider).
 */
export function isStreamOptionsRefusal(status: number, text: string): boolean {
  return (status === 400 || status === 422) && /stream_options|include_usage/i.test(text)
}

export function lmStudioRefusesStreamOptions(baseUrl: string): boolean {
  return refusesStreamOptions.has(baseUrl)
}

export function rememberLmStudioRefusesStreamOptions(baseUrl: string): void {
  refusesStreamOptions.add(baseUrl)
}

function ollamaHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
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
    const response = await fetch(`${serverRoot}/api/show`, {
      method: 'POST',
      headers: ollamaHeaders(apiKey),
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

/** Test seam: forget every context chosen, asked about and recorded in this process. */
export function resetLocalModelSettingsForTests(): void {
  chosenContexts.clear()
  modelLimits.clear()
  ownContexts.clear()
  refusesStreamOptions.clear()
  resetLocalModelContextForTests()
}
