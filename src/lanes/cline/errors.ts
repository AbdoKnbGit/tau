/**
 * Error text for failures from Cline's gateway.
 *
 * The raw gateway body always stays in the text. For the refusals Cline's SDK
 * recognizes (sdk/packages/llms/src/providers/errors.ts) and the free-model
 * surface check, a short explanation goes first, so the reason reads without
 * decoding JSON.
 */

const CONTEXT_EXCEEDED_MARKERS = [
  'context length',
  'context_length_exceeded',
  'prompt is too long',
  'maximum context',
]
const PRODUCT_SURFACE_MARKER = 'only available via cline product surfaces'
const NOT_SUBSCRIBED_MARKERS = [
  'the user is not subscribed to required model plan',
  'no access to clinepass subscription models yet',
]
const ORG_SUBSCRIPTION_MARKER =
  'organization accounts cannot use individual model inference subscriptions'
const PASS_LIMIT_PREFIX = 'you have reached your'
const PASS_LIMIT_MARKER = 'clinepass limit'
const PASS_LIMIT_SUFFIX = 'please try again later.'
const FREE_LIMIT_MARKER = 'free limit reached on model'
const MODEL_NOT_FOUND_MARKER = 'model not found'
const BODY_LIMIT = 500

export interface ClineErrorInput {
  /** HTTP status; absent for an error reported inside the stream. */
  status?: number
  body: string
  model: string
}

export function describeClineError({ status, body, model }: ClineErrorInput): string {
  const text = body.slice(0, BODY_LIMIT)
  const lowered = body.toLowerCase()
  if (CONTEXT_EXCEEDED_MARKERS.some(marker => lowered.includes(marker))) {
    // query.ts starts reactive compaction on this exact prefix.
    return `Prompt is too long (${status === undefined ? 'cline' : `cline ${status}`}): ${text}`
  }
  const raw = status === undefined
    ? `cline API stream error: ${text}`
    : `cline API error ${status}: ${text}`
  const hint = clineErrorHint(body, lowered, model)
  return hint ? `${hint}\n\n${raw}` : raw
}

export function describeEmptyClineResponse(model: string, body: string): string {
  const text = body.slice(0, BODY_LIMIT)
  return `cline returned no reply for ${model}: the response ended without text, a tool call or an error.`
    + (text ? ` Response body: ${text}` : '')
}

function clineErrorHint(body: string, lowered: string, model: string): string | null {
  if (lowered.includes(PRODUCT_SURFACE_MARKER)) {
    return `${model} is one of Cline's free models. Cline serves its free models only inside the Cline IDE extension and CLI, not through the Cline API that Tau uses, so it refused this request. Pick a paid Cline model or a Cline Pass model with /models.`
  }
  if (NOT_SUBSCRIBED_MARKERS.some(marker => lowered.includes(marker))) {
    return 'This Cline account has no Cline Pass subscription, so Cline Pass models are not available to it. Subscribe to Cline Pass in your Cline account, or use the Cline provider with usage billing.'
  }
  if (lowered.includes(ORG_SUBSCRIPTION_MARKER)) {
    return 'Organization accounts cannot use Cline Pass subscriptions. Sign in to Cline with your personal account to use Cline Pass.'
  }
  const passLimit = extractClinePassLimit(body, lowered)
  if (passLimit) return passLimit
  if (lowered.includes(FREE_LIMIT_MARKER)) {
    return `The free quota for ${model} is used up.`
  }
  if (lowered.includes(MODEL_NOT_FOUND_MARKER)) {
    return `Cline does not serve ${model}. Pick another model with /models.`
  }
  return null
}

// Cline's own sentence: "You have reached your ClinePass limit ... Please try again later."
function extractClinePassLimit(body: string, lowered: string): string | null {
  const start = lowered.indexOf(PASS_LIMIT_PREFIX)
  if (start < 0) return null
  const suffixStart = lowered.indexOf(PASS_LIMIT_SUFFIX, start)
  if (suffixStart < 0) return null
  const end = suffixStart + PASS_LIMIT_SUFFIX.length
  return lowered.slice(start, end).includes(PASS_LIMIT_MARKER)
    ? body.slice(start, end)
    : null
}
