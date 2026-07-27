/**
 * Attachment-block helpers shared by every lane whose wire format cannot
 * carry an Anthropic `image` / `document` block as-is.
 *
 * Two failure modes these exist to prevent:
 *
 *   1. `JSON.stringify(block)` on an image dumps its whole base64 payload
 *      into the prompt as plain text. A 20KB screenshot becomes ~27,000
 *      characters, roughly 10k tokens, replayed on every later turn, and
 *      carrying zero visual information — models cannot decode a compressed
 *      PNG from base64, so they answer from imagination instead.
 *   2. Skipping the block entirely leaves the `[Image #N]` marker in the
 *      user's text with nothing behind it, which produces the same
 *      confident fabrication with no clue that anything went missing.
 *
 * A short marker fixes both: the model is told an attachment exists and that
 * it did not arrive, so it says so instead of inventing.
 *
 * The marker is a pure function of the block (no clock, no network, no
 * config), so it serializes byte-identically on every replay and can never
 * shift an already-cached prompt prefix.
 */

type MediaBlockShape = {
  type?: string
  source?: { media_type?: string; mediaType?: string }
}

/** True for Anthropic `image` and `document` blocks. */
export function isMediaBlock(block: unknown): boolean {
  const type = (block as { type?: string } | null | undefined)?.type
  return type === 'image' || type === 'document'
}

/**
 * Deterministic one-line stand-in for an attachment the lane cannot forward.
 * Never contains the payload.
 *
 * @param reason why it did not go through — defaults to the plain
 *   "this lane cannot carry it" case. Lanes that CAN send some media kinds
 *   pass a narrower reason.
 */
export function describeUnsendableMedia(block: unknown, reason?: string): string {
  const b = (block ?? {}) as MediaBlockShape
  const kind = b.type === 'document' ? 'document' : 'image'
  const mime =
    b.source?.media_type
    ?? b.source?.mediaType
    ?? (kind === 'document' ? 'application/pdf' : 'image/png')
  const why = reason ?? `this provider lane cannot receive ${kind} attachments`
  return `[${kind} not sent (${mime}): ${why}]`
}
