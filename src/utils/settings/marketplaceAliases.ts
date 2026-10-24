/** Normalize each settings source before merging, so its own canonical keys win. */
export function normalizeMarketplaceAliases(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const result = { ...data } as Record<string, unknown>
  for (const [alias, canonical] of [
    ['allowedMarketplaces', 'strictKnownMarketplaces'],
    ['additionalMarketplaces', 'extraKnownMarketplaces'],
  ] as const) {
    if (!(canonical in result) && alias in result)
      result[canonical] = result[alias]
    delete result[alias]
  }
  return result
}
