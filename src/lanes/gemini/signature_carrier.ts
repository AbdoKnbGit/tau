/**
 * Thought signatures that Antigravity sends on a part of their own.
 *
 * Claude 4.6 with thinking on ends its thinking with an empty thought part
 * that holds the signature. Gemini 3.x ends a plain-text reply with an empty
 * text part that holds one. Neither belongs to a block the lane has already
 * opened, so the lane stores each as an empty thinking block carrying this
 * private field. Nothing is shown for an empty thinking block, other routes
 * have nothing to send for it, and a switch to Anthropic strips it with the
 * rest of the thinking.
 *
 * Placement: Claude's carrier is written where it arrives, between the
 * thinking and the answer. Gemini's arrives after the answer, but a reply's
 * last stored block is what `-p`, agents and other readers take as its
 * answer, so the lane writes it just before the final block closes and the
 * replay puts it back at the end of the turn, where Google sent it.
 *
 * Why the signatures go back (measured live, 2026-11-14):
 * - Claude: a tool-loop step whose history lacks the signed thinking makes
 *   the bridge run that step without thinking, which is a different cached
 *   prompt: 0 cached tokens instead of about 3,000. Sent back, the cache holds
 *   through the loop and the next turn.
 * - Gemini: the signature makes Google restore the reply's full reasoning
 *   (the next prompt grew by exactly that reply's thoughtsTokenCount). Tau
 *   already sends tool-call signatures; plain-text replies now keep theirs
 *   too, so later turns see the reasoning behind every answer. The cost is
 *   those restored tokens in each later prompt. TAU_GEMINI_TEXT_SIGNATURES=0
 *   turns it off.
 *
 * A carrier is replayed only to the model that wrote it, so no request ever
 * holds another model's signature.
 */
import {
  isAntigravityGeminiModel,
  resolveAntigravityWireModel,
} from '../../services/api/providers/gemini_code_assist.js'
import { SIGNATURE_CARRIER_KEY } from '../../utils/thoughtSignatureCarrier.js'

export { SIGNATURE_CARRIER_KEY }

export type SignatureCarrier = {
  /** The kind of part the signature came on. */
  kind: 'thought' | 'text'
  signature: string
  /** The request model that produced it. */
  model: string
}

/** The signature on a response part, in either spelling the servers use. */
export function partThoughtSignature(part: Record<string, unknown>): string | undefined {
  const value = part.thoughtSignature ?? part.thought_signature
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Gemini's plain-text reply signatures are kept unless TAU_GEMINI_TEXT_SIGNATURES=0. */
export function geminiTextSignaturesEnabled(): boolean {
  const value = process.env.TAU_GEMINI_TEXT_SIGNATURES?.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}

/** The carrier on a history block, if it is one. */
export function signatureCarrierOf(block: unknown): SignatureCarrier | undefined {
  if (!block || typeof block !== 'object') return undefined
  const value = (block as Record<string, unknown>)[SIGNATURE_CARRIER_KEY]
  if (!value || typeof value !== 'object') return undefined
  const { kind, signature, model } = value as Record<string, unknown>
  if ((kind !== 'thought' && kind !== 'text') || typeof signature !== 'string' || !signature
    || typeof model !== 'string' || !model) return undefined
  return { kind, signature, model }
}

/**
 * Whether a signature written by `producer` may go to `target`. Antigravity
 * Gemini levels that share one wire model share it; anything else needs the
 * same model id.
 */
export function signatureFitsModel(producer: string, target: string): boolean {
  const a = producer.trim().toLowerCase()
  const b = target.trim().toLowerCase()
  if (a === b) return true
  if (isAntigravityGeminiModel(a) && isAntigravityGeminiModel(b)) {
    return resolveAntigravityWireModel(a) === resolveAntigravityWireModel(b)
  }
  return false
}
