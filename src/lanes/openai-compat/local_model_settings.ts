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
 *   TAU_LOCAL_THINKING          thinking on any local server: off, on, low,
 *                               medium, high. Unset follows Tau's /thinking
 *   TAU_LOCAL_PRELOAD           0 stops loading the session's prompt into the
 *                               model ahead of the first message
 *                               (utils/model/localModelPreload.ts)
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { publishLocalModelNotice } from '../../utils/model/localModelNotices.js'
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

/** A loaded model as /api/ps describes it. */
type LoadedOllamaModel = {
  /** The context it is loaded with. */
  context?: number
  /** Its whole size in memory, and the part of it in GPU memory. */
  size?: number
  sizeVram?: number
}

/**
 * The model as /api/ps describes it. Undefined when the server does not say;
 * throws when it cannot be reached.
 */
async function readLoadedModel(
  serverRoot: string,
  model: string,
  headers: Record<string, string>,
): Promise<LoadedOllamaModel | undefined | 'not loaded'> {
  const response = await fetch(`${serverRoot}/api/ps`, { headers, signal: AbortSignal.timeout(3_000) })
  if (!response.ok) return undefined
  const data = await response.json().catch(() => undefined) as
    | { models?: Array<{ name?: unknown; model?: unknown; context_length?: unknown; size?: unknown; size_vram?: unknown }> }
    | undefined
  if (!Array.isArray(data?.models)) return undefined
  // `llama3` is listed as `llama3:latest`.
  const names = new Set([model, model.includes(':') ? model : `${model}:latest`])
  const entry = data.models.find(item => names.has(String(item.name)) || names.has(String(item.model)))
  if (!entry) return 'not loaded'
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const context = count(entry.context_length)
  return {
    context: context && context > 0 ? context : undefined,
    size: count(entry.size),
    sizeVram: count(entry.size_vram),
  }
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
  const loaded = await readLoadedModel(serverRoot, model, headers)
  return loaded === undefined || loaded === 'not loaded' ? loaded : loaded.context
}

// The context each model was last checked at, per server and model.
const gpuFitChecks = new Map<string, number>()

/**
 * After Ollama loaded a model at a new context: does part of it run on the
 * CPU? /api/ps reports the model's size and the part of it in GPU memory. A
 * model split between GPU and CPU answers much slower, so the user hears it
 * once per model and context, with what helps. Nothing is said for a model
 * fully on the GPU, or for a machine that runs it all on the CPU (nothing in
 * GPU memory), where nothing on the GPU side would help. One short request
 * per new context; never throws.
 */
export async function checkOllamaGpuFit(
  serverRoot: string,
  model: string,
  apiKey: string,
  numCtx: number,
): Promise<void> {
  const key = ollamaContextKey(serverRoot, model)
  if (gpuFitChecks.get(key) === numCtx) return
  gpuFitChecks.set(key, numCtx)
  try {
    const loaded = await readLoadedModel(serverRoot, model, ollamaHeaders(apiKey))
    if (loaded === undefined || loaded === 'not loaded') return
    const { size, sizeVram } = loaded
    if (!size || !sizeVram || sizeVram >= size) return
    const context = loaded.context ?? numCtx
    const onCpu = Math.max(1, Math.round((100 * (size - sizeVram)) / size))
    publishLocalModelNotice({
      key: `ollama-cpu-share\n${key}\n${context}`,
      text: ollamaCpuShareNotice(model, onCpu, context),
    })
  } catch {
    // Best effort: the request already succeeded.
  }
}

/**
 * The one-time notice for a model that runs partly on the CPU. The REPL shows
 * notices on one truncated line, so the facts come first and one fix after.
 */
export function ollamaCpuShareNotice(model: string, onCpuPercent: number, context: number): string {
  return `${model} runs ${onCpuPercent}% on the CPU at ${context.toLocaleString('en-US')} context, so slower`
    + ' · OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0 for Ollama fit more on the GPU'
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

/** What Ollama's /api/show says about a model. */
type OllamaModelFacts = {
  /** The context length it was trained for. */
  contextLength?: number
  /** What it can do (`completion`, `tools`, `thinking`...); undefined on an older Ollama. */
  capabilities?: readonly string[]
}

// /api/show answers, per server and model.
const modelFacts = new Map<string, Promise<OllamaModelFacts>>()

/**
 * One /api/show request per model per process; a server that cannot answer
 * leaves nothing known and is asked again on the next request.
 */
function ollamaModelFacts(serverRoot: string, model: string, apiKey: string): Promise<OllamaModelFacts> {
  const key = ollamaContextKey(serverRoot, model)
  let pending = modelFacts.get(key)
  if (!pending) {
    pending = fetchOllamaModelFacts(serverRoot, model, apiKey)
    modelFacts.set(key, pending)
  }
  return pending
}

async function fetchOllamaModelFacts(serverRoot: string, model: string, apiKey: string): Promise<OllamaModelFacts> {
  try {
    const response = await fetch(`${serverRoot}/api/show`, {
      method: 'POST',
      headers: ollamaHeaders(apiKey),
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return {}
    const info = await response.json() as { model_info?: Record<string, unknown>; capabilities?: unknown }
    let contextLength: number | undefined
    for (const [name, value] of Object.entries(info.model_info ?? {})) {
      if (name.endsWith('.context_length') && typeof value === 'number' && value > 0) {
        contextLength = value
        break
      }
    }
    const capabilities = Array.isArray(info.capabilities)
      ? info.capabilities.filter((item): item is string => typeof item === 'string')
      : undefined
    return { contextLength, capabilities }
  } catch {
    // Unreachable or slow: try again on the next request.
    modelFacts.delete(ollamaContextKey(serverRoot, model))
    return {}
  }
}

/** The model's trained context length, which `auto` never goes past. */
export async function ollamaModelContextLength(
  serverRoot: string,
  model: string,
  apiKey: string,
): Promise<number | undefined> {
  return (await ollamaModelFacts(serverRoot, model, apiKey)).contextLength
}

/** What the model can do, as Ollama lists it; undefined on an older Ollama. */
export async function ollamaModelCapabilities(
  serverRoot: string,
  model: string,
  apiKey: string,
): Promise<readonly string[] | undefined> {
  return (await ollamaModelFacts(serverRoot, model, apiKey)).capabilities
}

// ─── Thinking ──────────────────────────────────────────────────────

/** Thinking asked for on a local model: off, on, or a level. */
export type LocalThinking = boolean | 'low' | 'medium' | 'high'

/**
 * TAU_LOCAL_THINKING: `off` asks a thinking model not to think, `on` to
 * think, `low` / `medium` / `high` for a model that takes a level. Unset
 * leaves it to Tau's /thinking switch. It applies to every local server.
 */
export function localThinkingSetting(): LocalThinking | undefined {
  const text = envText('TAU_LOCAL_THINKING')?.toLowerCase()
  if (text === undefined) return undefined
  if (text === 'off' || text === 'false' || text === '0') return false
  if (text === 'on' || text === 'true' || text === '1') return true
  return text === 'low' || text === 'medium' || text === 'high' ? text : undefined
}

/**
 * What was asked for: TAU_LOCAL_THINKING, else thinking when Tau's /thinking
 * is on. Undefined sends nothing, so each model keeps its own default: some
 * models think whatever they are told, and told not to they put their
 * reasoning into the answer instead.
 */
export function localThinkingWanted(setting: LocalThinking | undefined, tauThinkingOn: boolean): LocalThinking | undefined {
  return setting ?? (tauThinkingOn ? true : undefined)
}

/**
 * The `think` field for an Ollama request, or undefined to send none. Only a
 * model whose capabilities list `thinking` gets it; Ollama refuses it for any
 * other.
 */
export function chooseOllamaThink(input: {
  setting: LocalThinking | undefined
  tauThinkingOn: boolean
  capabilities: readonly string[] | undefined
}): LocalThinking | undefined {
  const wanted = localThinkingWanted(input.setting, input.tauThinkingOn)
  if (wanted === undefined || !input.capabilities?.includes('thinking')) return undefined
  return wanted
}

/** A model's thinking options as LM Studio lists them (`capabilities.reasoning`). */
export type LmStudioReasoning = { allowed: readonly string[]; default?: string }

/**
 * LM Studio's `reasoning_effort` for what was asked, within the options LM
 * Studio lists for the model. `none` turns thinking off, only where `off` is
 * allowed; a level goes where that level is allowed; an on/off model asked
 * to think gets `medium`, and only when its default is off. Undefined sends
 * nothing: nothing asked, a model with no thinking options, or nothing it
 * allows.
 */
export function lmStudioReasoningEffort(
  wanted: LocalThinking | undefined,
  reasoning: LmStudioReasoning | undefined,
): 'none' | 'low' | 'medium' | 'high' | undefined {
  if (wanted === undefined || !reasoning) return undefined
  const allowed = new Set(reasoning.allowed)
  if (wanted === false) return allowed.has('off') ? 'none' : undefined
  if (typeof wanted === 'string' && allowed.has(wanted)) return wanted
  if (allowed.has('on')) return reasoning.default === 'off' ? 'medium' : undefined
  return undefined
}

/**
 * Thinking fields for any other local server (llama.cpp, vLLM and the rest,
 * which list no thinking options), for what was asked. These servers switch a
 * model's thinking with `chat_template_kwargs.enable_thinking`, which a model
 * whose template has no such switch ignores; a level goes as
 * `reasoning_effort`. Nothing asked sends nothing.
 */
export function otherLocalThinkingFields(
  wanted: LocalThinking | undefined,
): { chat_template_kwargs: { enable_thinking: boolean } } | { reasoning_effort: 'low' | 'medium' | 'high' } | undefined {
  if (wanted === undefined) return undefined
  return typeof wanted === 'boolean'
    ? { chat_template_kwargs: { enable_thinking: wanted } }
    : { reasoning_effort: wanted }
}

// Local OpenAI-compatible servers that refused a thinking field, per server
// and model; Tau leaves the fields out for them from then on.
const refusesThinkingFields = new Set<string>()

/** An error about a thinking field Tau added for a local server. */
export function isLocalThinkingFieldRefusal(status: number, text: string): boolean {
  return (status === 400 || status === 422) && /reasoning_effort|chat_template_kwargs|enable_thinking/i.test(text)
}

export function localServerRefusesThinkingFields(baseUrl: string, model: string): boolean {
  return refusesThinkingFields.has(`${baseUrl}\n${model}`)
}

export function rememberLocalServerRefusesThinkingFields(baseUrl: string, model: string): void {
  refusesThinkingFields.add(`${baseUrl}\n${model}`)
}

// Models whose server refused the `think` field, per server and model.
const refusesThink = new Set<string>()

/** An Ollama error about the `think` field ("does not support thinking"...). */
export function isThinkRefusal(status: number, text: string): boolean {
  return status === 400 && /\bthink(ing)?\b/i.test(text)
}

export function ollamaRefusesThink(serverRoot: string, model: string): boolean {
  return refusesThink.has(ollamaContextKey(serverRoot, model))
}

export function rememberOllamaRefusesThink(serverRoot: string, model: string): void {
  refusesThink.add(ollamaContextKey(serverRoot, model))
}

// ─── Preload ───────────────────────────────────────────────────────
// A preload (utils/model/localModelPreload.ts) and the requests after it share
// one model on one server. A request that starts while the preload is still
// being read waits for it, and then finds the prompt in the server's cache
// instead of reading it a second time beside the preload. Once the main
// conversation has reached a model, its prompt is cached and a preload has
// nothing left to do. Per server and model.

const preloadsInFlight = new Map<string, Promise<void>>()
const conversationReached = new Set<string>()

export function localPreloadKey(provider: string, baseUrl: string, model: string): string {
  return `${provider}\n${baseUrl}\n${model}`
}

/** Marks a preload in flight; the function returned ends it. */
export function beginLocalPreload(key: string): () => void {
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  preloadsInFlight.set(key, done)
  return () => {
    if (preloadsInFlight.get(key) === done) preloadsInFlight.delete(key)
    finish()
  }
}

/** Waits for a preload of the same model to end. An abort ends the wait. */
export async function waitForLocalPreload(key: string, signal?: AbortSignal): Promise<void> {
  const pending = preloadsInFlight.get(key)
  if (!pending || signal?.aborted) return
  await new Promise<void>(resolve => {
    const stop = () => resolve()
    signal?.addEventListener('abort', stop, { once: true })
    void pending.then(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    })
  })
}

export function noteLocalConversationRequest(key: string): void {
  conversationReached.add(key)
}

export function localConversationReached(key: string): boolean {
  return conversationReached.has(key)
}

/** Test seam: forget every context chosen, asked about and recorded in this process. */
export function resetLocalModelSettingsForTests(): void {
  chosenContexts.clear()
  modelFacts.clear()
  ownContexts.clear()
  refusesStreamOptions.clear()
  refusesThink.clear()
  refusesThinkingFields.clear()
  gpuFitChecks.clear()
  preloadsInFlight.clear()
  conversationReached.clear()
  resetLocalModelContextForTests()
}
