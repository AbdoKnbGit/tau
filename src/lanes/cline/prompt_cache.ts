/**
 * Prompt-cache markers for Cline's gateway.
 *
 * Cline's gateway (Vercel AI Gateway underneath) fronts two kinds of cache.
 * Implicit prefix caches (OpenAI, Google, DeepSeek, Z.ai GLM, Moonshot Kimi,
 * Xiaomi MiMo) need nothing but a byte-stable prefix. Explicit caches
 * (Anthropic, Alibaba Qwen, MiniMax) cache only what carries `cache_control`,
 * so without a marker every turn is a full-price miss.
 *
 * Tau's shared layer marks the Anthropic-format request, but those markers do
 * not survive the conversion to chat-completions, so the lane places its own.
 * The shapes are the ones Cline's SDK sends to this same endpoint
 * (sdk/packages/llms: routing/anthropic-compatible.ts, providers/ai-sdk.ts):
 *   - `cache_control` at the top level of the request, and
 *   - a marker on the last user message: on the message itself for
 *     Anthropic, on a text part (kept multipart with a " " filler) for the
 *     other families.
 * Anthropic also keeps the system-prompt marker this lane has always sent,
 * so tools and system stay cached across user turns. That is three
 * breakpoints at most, under Anthropic's limit of four. Assistant and tool
 * messages are never marked, and the output is a pure function of the
 * input, so the request bytes stay identical from one turn to the next.
 */

import type {
  OpenAIContentPart,
  OpenAIMessage,
} from '../../services/api/adapters/anthropic_to_openai.js'

export type ClinePromptCacheShape = 'anthropic' | 'content-part'

type CacheControl = { type: 'ephemeral' }

export type ClineWireMessage = OpenAIMessage & { cache_control?: CacheControl }

function ephemeral(): CacheControl {
  return { type: 'ephemeral' }
}

export function isAnthropicLineageModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  return id.includes('anthropic') || id.includes('claude')
}

// Families whose explicit cache is keyed on a marked content part. The Qwen
// pattern is the one in Cline's SDK (providers/model-facts.ts); MiniMax is the
// other explicit-cache provider the gateway documents for chat-completions.
const CONTENT_PART_CACHE_FAMILIES = [
  /(^|[/:._-])qwen(?:$|[/:._-]|\d)/,
  /(^|[/:._-])minimax(?:$|[/:._-]|\d)/,
]

export function isContentPartCacheFamily(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  return CONTENT_PART_CACHE_FAMILIES.some(pattern => pattern.test(id))
}

/**
 * Anthropic lineage caches on every Cline route. Qwen and MiniMax caching is
 * per model, so those also need the catalog to price cache reads for the
 * model: the capability gate Cline's SDK applies to Qwen.
 */
export function resolveClinePromptCacheShape(
  modelId: string,
  catalogSupportsPromptCache: boolean | undefined,
): ClinePromptCacheShape | null {
  if (isAnthropicLineageModel(modelId)) return 'anthropic'
  if (isContentPartCacheFamily(modelId) && catalogSupportsPromptCache === true) {
    return 'content-part'
  }
  return null
}

/** Marked copy of `messages`; the input is never mutated. */
export function applyClinePromptCache(
  messages: readonly OpenAIMessage[],
  shape: ClinePromptCacheShape | null,
): ClineWireMessage[] {
  const out: ClineWireMessage[] = messages.map(message => ({ ...message }))
  if (!shape) return out
  if (shape === 'anthropic') markSystemMessage(out)
  markLastUserMessage(out, shape)
  return out
}

/** A client-error refusal that names the cache markers themselves. */
export function isClinePromptCacheRejected(status: number, errorText: string): boolean {
  if (status !== 400 && status !== 422) return false
  const lowered = errorText.toLowerCase()
  return lowered.includes('cache_control')
    || lowered.includes('cache control')
    || lowered.includes('cache breakpoint')
}

function markSystemMessage(messages: ClineWireMessage[]): void {
  const index = messages.findIndex(message => message.role === 'system')
  if (index < 0) return
  const message = messages[index]!
  if (typeof message.content === 'string') {
    if (!message.content) return
    messages[index] = {
      ...message,
      content: [{ type: 'text', text: message.content, cache_control: ephemeral() }],
    }
    return
  }
  const parts = markLastTextPart(message.content, false)
  if (parts) messages[index] = { ...message, content: parts }
}

function markLastUserMessage(
  messages: ClineWireMessage[],
  shape: ClinePromptCacheShape,
): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') {
      if (!message.content) return
      messages[index] = shape === 'anthropic'
        ? { ...message, cache_control: ephemeral() }
        : {
            ...message,
            // Multipart keeps the marker on the part instead of letting a
            // single-part message collapse it into message metadata.
            content: [
              { type: 'text', text: message.content, cache_control: ephemeral() },
              { type: 'text', text: ' ' },
            ],
          }
      return
    }
    const parts = markLastTextPart(message.content, shape === 'content-part')
    if (parts) messages[index] = { ...message, content: parts }
    return
  }
}

function markLastTextPart(
  content: OpenAIContentPart[] | null | undefined,
  keepMultipart: boolean,
): OpenAIContentPart[] | null {
  if (!Array.isArray(content)) return null
  let lastText = -1
  let textParts = 0
  content.forEach((part, index) => {
    if (part.type === 'text') {
      lastText = index
      textParts++
    }
  })
  if (lastText < 0) return null
  const parts = content.map(part => ({ ...part }))
  parts[lastText] = { ...parts[lastText]!, cache_control: ephemeral() }
  // Anthropic rejects whitespace-only text blocks, so only the other
  // families get the filler that keeps a lone text part multipart.
  if (keepMultipart && textParts === 1) parts.push({ type: 'text', text: ' ' })
  return parts
}
