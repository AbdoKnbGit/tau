/**
 * Which model describes an image for a main model that cannot see one.
 *
 * OCR answers "what text is in this picture". It cannot answer "what does this
 * picture show", so a screenshot of a broken layout, a chart, or a mockup comes
 * back empty and the model receives a marker. A vision model answers the second
 * question, and Tau is unusually well placed to ask it: it already holds
 * credentials for several providers at once, so it can borrow sight from one
 * while coding on another.
 *
 * This module is only the choosing. It maps a provider to the request shape its
 * API wants, holds a cheap known-good default per provider, and resolves the
 * user's preference against what is actually configured. The HTTP call lives in
 * describeImage.ts and the caching discipline lives in media_extract.ts.
 *
 * Leaf module (no I/O, no config reads), so the checks in visionModels.test.ts
 * run standalone.
 */

/** The three request shapes that cover every vision-capable provider Tau speaks. */
export type VisionFamily = 'anthropic' | 'openai' | 'gemini'

export type VisionModelChoice = {
  provider: string
  model: string
}

/**
 * Provider id to request shape. Absent means "cannot serve as a describer",
 * which is the safe default: a provider we cannot format a request for must
 * never be auto-picked.
 */
const FAMILY_BY_PROVIDER: Record<string, VisionFamily> = {
  firstParty: 'anthropic',
  bedrock: 'anthropic',
  vertex: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
  antigravity: 'gemini',
}

/** Display order for the picker. */
const PROVIDER_ORDER: readonly string[] = [
  'firstParty',
  'openai',
  'antigravity',
  'gemini',
  'bedrock',
  'vertex',
]

export function visionFamilyFor(provider: string | undefined): VisionFamily | null {
  if (!provider) return null
  return FAMILY_BY_PROVIDER[provider] ?? null
}

/** Providers Tau can shape a describe request for, in display order. */
export function describerCapableProviders(
  configured: readonly string[],
): string[] {
  const available = new Set(configured)
  return PROVIDER_ORDER.filter(p => available.has(p))
}

/**
 * Resolve the describer to use.
 *
 * There is no built-in default model, on purpose. A hardcoded list goes stale
 * the moment a provider ships a new generation, and pinning someone to last
 * year's model because it was current when this shipped is worse than asking
 * once. The model comes from the provider's live catalog via /vision-model, so
 * it is whatever the provider actually offers today.
 *
 * A stored choice is dropped rather than honoured blindly when its provider is
 * no longer authenticated or is one we cannot shape a request for. Otherwise it
 * would fail on every attachment forever with nothing to explain why.
 */
export function pickVisionModel(
  configured: readonly string[],
  preferred?: VisionModelChoice | null,
): VisionModelChoice | null {
  if (!preferred?.provider || !preferred.model) return null
  const usable =
    configured.includes(preferred.provider) &&
    visionFamilyFor(preferred.provider) !== null
  return usable ? { provider: preferred.provider, model: preferred.model } : null
}

/**
 * Disk-cache variant for a describer.
 *
 * The resolver identity belongs in the cache key: without it, switching your
 * vision model would silently keep replaying the old model's description for
 * every image already on disk, and the setting would look broken.
 *
 * This becomes part of a filename, and a model id is free-form text that
 * reaches us from a provider catalog or straight from the user's `/vision-model`
 * argument. Dots are collapsed along with everything else so no `..` can form:
 * separators alone would be enough to stop traversal, but a cache filename has
 * nothing to gain from being able to express a relative path.
 */
export function visionVariantKey(choice: VisionModelChoice): string {
  const raw = `${choice.provider}-${choice.model}`
  return `vision-${raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}`
}
