/** OpenRouter display names are not routing slugs (e.g. AtlasCloud). Resolve
 * them from the public directory; an unknown name must never become a guess.
 */
let directory = new Map<string, string>()
let refreshAfter = 0
let refreshing: Promise<void> | undefined

export function recordOpenRouterProviderDirectory(payload: unknown): void {
  const rows = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(rows)) return
  const next = new Map<string, string>()
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || typeof row.slug !== 'string' ||
      !/^[a-z0-9][a-z0-9._/-]*$/i.test(row.slug)) continue
    next.set(row.name.trim().toLowerCase(), row.slug)
    next.set(row.slug.toLowerCase(), row.slug)
  }
  if (!next.size) return
  directory = next
  refreshAfter = Date.now() + 60 * 60 * 1000
}

export async function resolveOpenRouterProviderSlug(name: string): Promise<string | undefined> {
  if (Date.now() >= refreshAfter) {
    refreshing ??= (async () => {
      // A directory outage must not become an inference outage or busy loop.
      refreshAfter = Date.now() + 60_000
      try {
        const response = await fetch('https://openrouter.ai/api/v1/providers', {
          signal: AbortSignal.timeout(2500),
        })
        if (response.ok) recordOpenRouterProviderDirectory(await response.json())
      } catch { /* retain previously verified mappings */ }
    })().finally(() => { refreshing = undefined })
  }
  await refreshing
  return directory.get(name.trim().toLowerCase())
}
