/**
 * What Tau knows about the context of a model on this machine, and how auto
 * compaction treats it.
 *
 * Planning covers Ollama models on this machine (not Ollama's `:cloud`
 * models). Ollama reports the exact size of every prompt, which is what
 * compaction needs. LM Studio sends Tau no token counts yet, so it keeps the
 * generic rules for now. Every function answers `undefined` for any other
 * provider, so they keep exactly the behavior they had.
 *
 * Nothing here assumes a machine or a model. The local lane records facts as
 * requests go out: the context Ollama itself gives the model on this machine
 * (Ollama picks it from the GPU's memory, or takes the server's
 * OLLAMA_CONTEXT_LENGTH or the model's Modelfile), the model's own limit, the
 * size of Tau's fixed prompt (system prompt and tools), and how Ollama's exact
 * token counts compare to Tau's character estimate. Tau uses Ollama's own
 * context when it holds Tau's prompt, raises it to the smallest context Tau
 * can work in when it does not, and auto compaction plans for the context the
 * model really has.
 */

/** The least context Tau asks Ollama for, as it always has. */
export const OLLAMA_DEFAULT_NUM_CTX = 16_384
/** Contexts move in whole steps, so a growing conversation rarely changes them. */
export const LOCAL_CONTEXT_STEP = 8_192

/** Compaction fires at this share of a small local window. */
const COMPACT_TRIGGER_FRACTION = 0.8
/** Compaction only helps when this much room is left above Tau's own prompt. */
const MIN_CONVERSATION_ROOM = 8_192
/**
 * Room the compaction request needs above the trigger: Tau's summary
 * instructions (about 1.5K), the turn that crossed the trigger, and a summary
 * of a few thousand tokens. A context `auto` picks always leaves this much.
 */
const SUMMARY_ROOM = 6_144
/** Room kept for an answer when deciding a request is too long to send. */
const LOCAL_OUTPUT_RESERVE = 1_024
/**
 * Tau refuses a request this close to its effective window
 * (MANUAL_COMPACT_BUFFER_TOKENS in services/compact/autoCompact.ts).
 */
const BLOCKING_BUFFER = 3_000
/**
 * The smallest window compaction is planned for: in a smaller one Tau would
 * refuse a request before the conversation reached the compaction trigger.
 */
const MIN_PLANNED_WINDOW = roundUpToStep((LOCAL_OUTPUT_RESERVE + BLOCKING_BUFFER) / (1 - COMPACT_TRIGGER_FRACTION))
/** The least context `auto` picks: one that leaves the compaction its room. */
const MIN_AUTO_CONTEXT = Math.max(MIN_PLANNED_WINDOW, roundUpToStep(SUMMARY_ROOM / (1 - COMPACT_TRIGGER_FRACTION)))
/**
 * Shares of the window that files and skills may refill after compaction.
 * compact.ts never lets them pass the budgets every other model gets.
 */
const FILE_RESTORE_FRACTION = 0.1
const SKILL_RESTORE_FRACTION = 0.05

/** Margins on Tau's character estimate: calibrated by Ollama's counts, and not. */
const CALIBRATED_MARGIN = 1.05
const UNCALIBRATED_MARGIN = 1.15
/**
 * Exact count over Tau's four-characters-per-token estimate. English and code
 * measured 0.86-0.98 on Ollama; text that is mostly CJK runs toward 4.
 */
const MIN_PLAUSIBLE_RATIO = 0.25
const MAX_PLAUSIBLE_RATIO = 4

export function isOllamaCloudModel(model: string): boolean {
  return /[:-]cloud$/i.test(model.trim())
}

/** Ollama models on this machine: the ones this module plans for. */
export function isLocalContextProvider(provider: string, model: string): boolean {
  return provider === 'ollama' && !isOllamaCloudModel(model)
}

/** A token count rounded up to whole context steps. */
export function roundUpToStep(tokens: number): number {
  return Math.ceil(tokens / LOCAL_CONTEXT_STEP) * LOCAL_CONTEXT_STEP
}

function envText(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function envPositiveInt(name: string): number | undefined {
  const text = envText(name)
  if (text === undefined) return undefined
  const value = Number(text)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * OLLAMA_NUM_CTX: a number fixes the context; `auto` (the default) sizes it.
 * `auto` grows up to OLLAMA_NUM_CTX_MAX when that is set, and otherwise uses
 * the context Ollama gives the model on this machine (localAutoContextRange).
 */
export type OllamaContextSetting =
  | { kind: 'fixed'; numCtx: number }
  | { kind: 'auto'; max?: number }

export function ollamaContextSetting(): OllamaContextSetting {
  const text = envText('OLLAMA_NUM_CTX')
  if (text !== undefined && text.toLowerCase() !== 'auto') {
    // parseInt, as Tau has always read this variable.
    const fixed = Number.parseInt(text, 10)
    if (Number.isFinite(fixed) && fixed > 0) return { kind: 'fixed', numCtx: fixed }
  }
  const max = envPositiveInt('OLLAMA_NUM_CTX_MAX')
  return max === undefined ? { kind: 'auto' } : { kind: 'auto', max }
}

// ─── Facts the local lane records ──────────────────────────────────

const modelLimits = new Map<string, number>()
const fixedPrompts = new Map<string, number>()
const tokenRatios = new Map<string, number>()
const fixedRatios = new Map<string, number>()
const ownContexts = new Map<string, number>()
const sentContexts = new Map<string, number>()

const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0

/** The context length the model was trained for (Ollama's /api/show). */
export function noteLocalModelLimit(model: string, tokens: number | undefined): void {
  if (positive(tokens)) modelLimits.set(model, tokens)
}

/**
 * Tau's estimate of the part compaction cannot shrink: system prompt and
 * tools. The largest one counts, so a helper request with a short prompt
 * never makes the conversation's prompt look smaller.
 */
export function noteLocalFixedPrompt(model: string, estimatedTokens: number): void {
  if (positive(estimatedTokens)) {
    fixedPrompts.set(model, Math.max(estimatedTokens, fixedPrompts.get(model) ?? 0))
  }
}

/**
 * An exact prompt count from Ollama (prompt_eval_count, which is the whole
 * prompt even when its cache is reused) next to Tau's character estimate of
 * the same request. Later request sizes for the model are scaled by the latest
 * ratio. The first one also scales the fixed prompt: a session's first request
 * is almost all system prompt and tools, while later ones carry conversation
 * text that tokenizes differently (dense notes or code count more tokens per
 * character).
 */
export function noteLocalTokenCount(model: string, estimatedTokens: number, exactTokens: number): void {
  if (!positive(estimatedTokens) || !positive(exactTokens)) return
  const ratio = exactTokens / estimatedTokens
  // A count no tokenizer could give (a server or proxy that reports a
  // placeholder) is ignored rather than trusted.
  if (ratio < MIN_PLAUSIBLE_RATIO || ratio > MAX_PLAUSIBLE_RATIO) return
  tokenRatios.set(model, ratio)
  if (!fixedRatios.has(model)) fixedRatios.set(model, ratio)
}

/**
 * The context Ollama gives the model on this machine when Tau does not set
 * one, or the one it is already loaded with (local_model_settings.ts).
 */
export function noteLocalOwnContext(model: string, tokens: number | undefined): void {
  if (positive(tokens)) ownContexts.set(model, tokens)
}

/** A context Tau sent for the model. Ollama keeps the model loaded at it. */
export function noteLocalSentContext(model: string, tokens: number): void {
  if (positive(tokens)) sentContexts.set(model, Math.max(tokens, sentContexts.get(model) ?? 0))
}

function scaled(estimatedTokens: number, ratio: number | undefined): number {
  return ratio === undefined
    ? Math.ceil(estimatedTokens * UNCALIBRATED_MARGIN)
    : Math.ceil(estimatedTokens * ratio * CALIBRATED_MARGIN)
}

/**
 * Tau's character estimate turned into a safe token count for this model:
 * scaled by Ollama's latest count once one is known, with a 5% margin, and
 * otherwise raised by 15%.
 */
export function localTokenEstimate(model: string, estimatedTokens: number): number {
  return scaled(estimatedTokens, tokenRatios.get(model))
}

// ─── Planning ──────────────────────────────────────────────────────

/**
 * The smallest context Tau can work in with this model: its fixed prompt plus
 * 8K of conversation under the compaction trigger, and room above the trigger
 * for the compaction itself, in whole steps. It follows the prompt Tau really
 * sends, so more tools or MCP servers ask for more. Undefined until Tau has
 * built a request for the model.
 */
export function localWorkableContext(model: string): number | undefined {
  const fixed = fixedPrompts.get(model)
  if (fixed === undefined) return undefined
  const forConversation = (scaled(fixed, fixedRatios.get(model)) + MIN_CONVERSATION_ROOM) / COMPACT_TRIGGER_FRACTION
  return Math.max(MIN_AUTO_CONTEXT, roundUpToStep(forConversation))
}

export type LocalAutoContextRange = {
  /** Where `auto` starts, so it does not reload the model later to grow into its own size. */
  floor: number
  /** The most `auto` uses, and what compaction plans for. */
  ceiling: number
}

/**
 * The context `auto` uses when OLLAMA_NUM_CTX_MAX is not set. It starts at the
 * context Ollama gives the model on this machine when that leaves Tau room to
 * work, and otherwise at the least Tau needs (only the part of that which
 * Ollama's first count settles waits for the count). It uses at most that, or
 * a context Tau already sent. The model's own limit caps both. Undefined while
 * nothing is known about the model.
 */
export function localAutoContextRange(model: string): LocalAutoContextRange | undefined {
  const own = ownContexts.get(model)
  const workable = localWorkableContext(model)
  const sent = sentContexts.get(model)
  if (own === undefined && workable === undefined && sent === undefined) return undefined
  const settled = fixedRatios.has(model) ? workable ?? 0 : 0
  const floor = Math.max(own ?? 0, MIN_AUTO_CONTEXT, settled)
  const ceiling = Math.max(floor, workable ?? 0, sent ?? 0)
  const limit = modelLimits.get(model) ?? Number.POSITIVE_INFINITY
  return { floor: Math.min(floor, limit), ceiling: Math.min(ceiling, limit) }
}

/** The context the model has: what compaction plans for. */
export function localModelContext(provider: string, model: string): number | undefined {
  if (!isLocalContextProvider(provider, model)) return undefined
  const setting = ollamaContextSetting()
  if (setting.kind === 'fixed') return setting.numCtx
  if (setting.max !== undefined) {
    const limit = modelLimits.get(model)
    return limit === undefined ? setting.max : Math.min(setting.max, limit)
  }
  return localAutoContextRange(model)?.ceiling
}

export type LocalCompactionProfile = {
  /** The context Tau plans for. */
  window: number
  /**
   * Held back for the summary: compaction fires at 80% of the window.
   * autoCompact.ts keeps the generic reserves once this is larger than them.
   */
  summaryReserve: number
  /** Room kept for an answer when deciding a request is too long to send. */
  outputReserve: number
  /** Most tokens of recently read files to restore after compaction. */
  fileRestoreBudget: number
  /** Most tokens of invoked skills to restore after compaction. */
  skillRestoreBudget: number
}

/**
 * How auto compaction treats a local model, or undefined to keep the generic
 * rules. Undefined also when compaction cannot help: before Tau has sent the
 * model a request, or when Tau's fixed prompt alone leaves less than 8K under
 * the trigger. Summarizing the conversation cannot make such a request fit,
 * and compacting would only repeat every turn, so Ollama's own refusal
 * explains it instead.
 *
 * Every input only settles or grows during a session (the first count scales
 * the fixed prompt, the largest fixed prompt counts, the context only grows),
 * so a plan does not switch off and on as the conversation changes.
 */
export function localCompactionProfile(provider: string, model: string): LocalCompactionProfile | undefined {
  const window = localModelContext(provider, model)
  const fixed = fixedPrompts.get(model)
  if (window === undefined || fixed === undefined || window < MIN_PLANNED_WINDOW) return undefined
  const trigger = Math.floor(window * COMPACT_TRIGGER_FRACTION)
  if (trigger - scaled(fixed, fixedRatios.get(model)) < MIN_CONVERSATION_ROOM) return undefined
  return {
    window,
    summaryReserve: window - trigger,
    outputReserve: LOCAL_OUTPUT_RESERVE,
    fileRestoreBudget: Math.floor(window * FILE_RESTORE_FRACTION),
    skillRestoreBudget: Math.floor(window * SKILL_RESTORE_FRACTION),
  }
}

/**
 * The window Tau plans with for a local model, or undefined for any other
 * provider. A model compaction cannot help gets the generic default: then
 * nothing blocks or compacts on Tau's side, and Ollama's refusal explains a
 * request that does not fit. That replaces the trained sizes of a few model
 * families (llama3 at 8K), whose small window made Tau refuse every request
 * itself before sending it.
 */
export function localModelContextWindow(provider: string, model: string, genericDefault: number): number | undefined {
  if (!isLocalContextProvider(provider, model)) return undefined
  return localCompactionProfile(provider, model)?.window ?? genericDefault
}

/** Test seam: forget every recorded fact. */
export function resetLocalModelContextForTests(): void {
  modelLimits.clear()
  fixedPrompts.clear()
  tokenRatios.clear()
  fixedRatios.clear()
  ownContexts.clear()
  sentContexts.clear()
}
