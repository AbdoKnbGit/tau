/**
 * The private field that marks a stored thought signature: an empty thinking
 * block the Gemini lane writes when Antigravity sends a signature on a part
 * of its own (see src/lanes/gemini/signature_carrier.ts). It is history for
 * the next request, not output: the live display skips it.
 *
 * A leaf module, so shared message code can recognize carriers without
 * importing the lane.
 */
export const SIGNATURE_CARRIER_KEY = '_gemini_signature_carrier'

export function isSignatureCarrierBlock(block: unknown): boolean {
  return !!block && typeof block === 'object' && SIGNATURE_CARRIER_KEY in block
}
