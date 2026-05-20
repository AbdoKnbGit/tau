/**
 * Gemini context cache manager.
 *
 * Gemini 2.5+ exposes a `cachedContents` API that lets you pre-cache a
 * system prompt + tool schemas once and then reference them by name in
 * subsequent `generateContent` calls. The cached portion is billed at a
 * steep discount (~75% off input token cost), which is a real win for
 * agent-loop workloads where the same ~5 KB system prompt is sent on
 * every turn.
 *
 * This module:
 *   - computes a stable key from (model + systemInstruction + tools)
 *   - keeps an in-memory Map of {key → cacheName} with a 5-minute TTL
 *     that matches Gemini's server-side TTL default
 *   - creates a new cache lazily when a request exceeds the size threshold
 *   - proactively refreshes the cache in background before TTL expiry
 *   - tracks failures with a short cooldown so we don't hammer the API
 *     with "too small" requests
 *   - provides `invalidateCache(cacheName)` so the provider can drop a
 *     stale entry when a request returns 404/expired
 *   - exposes `getCacheStats()` for diagnostics
 *
 * IMPORTANT: this is currently API-key-path-only. Google's Code Assist
 * proxy (used for OAuth-scope-cloud-platform tokens) does not expose a
 * verified cachedContents endpoint, so OAuth users still send the system
 * prompt inline every turn. That's a known limitation, not a regression.
 */

import { createHash } from 'crypto'

interface CacheEntry {
  cacheName: string // "cachedContents/xxxxx"
  expiresAt: number // epoch ms
  model: string
}

interface CacheMiss {
  reason: 'too_small' | 'unsupported' | 'error'
  retryAfter: number // epoch ms - don't retry until after this
}

export interface CacheLookupResult {
  cacheName: string
  createdTokens: number
}

// Server-side TTL is set to 600s (10 min) for breathing room. We expire
// locally at 5 min (300s) so we never reference a server cache that just
// died — the extra 5 min server-side gives the refresh cycle time to
// create a replacement before the old one expires.
const CACHE_TTL_MS = 5 * 60 * 1000

// Proactively refresh the cache when less than this much TTL remains.
// This prevents the gap where the old cache expires before the new one
// is ready, which would force one request to pay full input cost.
const REFRESH_THRESHOLD_MS = 60_000

// Cooldown after a "too small" miss — the payload size won't change
// between turns, so a longer cooldown is fine.
const MISS_COOLDOWN_TOO_SMALL_MS = 120_000

// Cooldown after a transient error — shorter so we recover quickly.
const MISS_COOLDOWN_ERROR_MS = 15_000

// Minimum payload size before we even attempt to cache. Gemini rejects
// small caches with a hard error; skipping the round trip saves latency.
// 8 KB chars ≈ ~2 K tokens. Raised from 4096 to avoid micro-caches that
// cost more in round-trips than they save. With the stable/volatile split,
// the stable portion is always large enough for meaningful caching.
const MIN_CACHE_SIZE_CHARS = 8192

/**
 * Models that support context caching. Covers the full Gemini 2.5+ and
 * 3.x families. Image/audio/TTS models are intentionally excluded —
 * they don't ingest a long system prompt in the first place.
 *
 * Uses a prefix-match strategy so new model variants (e.g.
 * gemini-2.5-pro-001, gemini-3.1-pro-preview-v2) are picked up
 * automatically without needing a code change.
 */
const CACHE_CAPABLE_MODEL_PREFIXES = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3-pro',
  'gemini-3-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash',
  'gemini-3.5-flash',
]

// In-process stores. Per-process is correct here — caches are tied to
// the API key, not to the user identity beyond that.
const _caches = new Map<string, CacheEntry>()
const _misses = new Map<string, CacheMiss>()

// Diagnostic counters
const _stats = { hits: 0, misses: 0, creates: 0, refreshes: 0, errors: 0 }

// Track in-flight background refreshes to avoid duplicate work.
const _pendingRefreshes = new Set<string>()

function supportsCaching(model: string): boolean {
  const lower = model.toLowerCase()
  return CACHE_CAPABLE_MODEL_PREFIXES.some(p => lower.startsWith(p))
}

function computeKey(
  model: string,
  systemInstruction: unknown,
  tools: unknown,
): string {
  const hash = createHash('sha256')
  hash.update(model)
  hash.update('|')
  hash.update(JSON.stringify(systemInstruction ?? null))
  hash.update('|')
  hash.update(JSON.stringify(tools ?? null))
  return hash.digest('hex')
}

function approxSize(systemInstruction: unknown, tools: unknown): number {
  return (
    JSON.stringify(systemInstruction ?? '').length +
    JSON.stringify(tools ?? '').length
  )
}

/**
 * Build the headers for cache API calls. Uses x-goog-api-key header
 * instead of URL query param — more secure (avoids logging the key in
 * server access logs and proxy caches).
 */
function _cacheHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
    'Connection': 'keep-alive',
  }
}

/**
 * Create a cache entry on the server. Returns the cache name on success,
 * null on failure. Updates _misses on failure for cooldown tracking.
 */
async function _createCacheOnServer(
  key: string,
  args: GetOrCreateCacheArgs,
): Promise<CacheLookupResult | null> {
  const { model, baseUrl, apiKey, systemInstruction, tools } = args
  try {
    const body: Record<string, unknown> = {
      model: `models/${model}`,
      ttl: '600s',
    }
    if (systemInstruction) body.systemInstruction = systemInstruction
    if (tools) body.tools = tools

    const response = await fetch(
      `${baseUrl}/cachedContents`,
      {
        method: 'POST',
        headers: _cacheHeaders(apiKey),
        body: JSON.stringify(body),
      },
    )

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      const isTooSmall =
        errText.toLowerCase().includes('minimum') ||
        errText.toLowerCase().includes('too small')
      _misses.set(key, {
        reason: isTooSmall ? 'too_small' : 'error',
        retryAfter: Date.now() + (isTooSmall ? MISS_COOLDOWN_TOO_SMALL_MS : MISS_COOLDOWN_ERROR_MS),
      })
      _stats.errors++
      return null
    }

    const data = (await response.json()) as {
      name?: string
      usageMetadata?: {
        totalTokenCount?: number
        promptTokenCount?: number
      }
    }
    if (!data.name) {
      _misses.set(key, {
        reason: 'error',
        retryAfter: Date.now() + MISS_COOLDOWN_ERROR_MS,
      })
      _stats.errors++
      return null
    }

    _caches.set(key, {
      cacheName: data.name,
      expiresAt: Date.now() + CACHE_TTL_MS,
      model,
    })
    return {
      cacheName: data.name,
      createdTokens:
        data.usageMetadata?.totalTokenCount
        ?? data.usageMetadata?.promptTokenCount
        ?? 0,
    }
  } catch {
    _misses.set(key, {
      reason: 'error',
      retryAfter: Date.now() + MISS_COOLDOWN_ERROR_MS,
    })
    _stats.errors++
    return null
  }
}

/**
 * Proactively refresh a cache entry in the background before it expires.
 * Fire-and-forget — the current request uses the still-valid old cache
 * while this creates a replacement that will be ready for the next turn.
 */
function _refreshInBackground(args: GetOrCreateCacheArgs, key: string): void {
  if (_pendingRefreshes.has(key)) return
  _pendingRefreshes.add(key)
  _stats.refreshes++

  _createCacheOnServer(key, args)
    .catch(() => {})
    .finally(() => _pendingRefreshes.delete(key))
}

export interface GetOrCreateCacheArgs {
  model: string
  /** Base URL for the Gemini v1beta endpoint (API-key path only). */
  baseUrl: string
  apiKey: string
  systemInstruction: unknown
  tools: unknown
}

/**
 * Returns an existing cache name if valid, otherwise creates a new one.
 * Returns null if the request isn't cache-eligible (unsupported model,
 * too small, in cooldown, or creation failed). On null, the caller must
 * fall back to sending the system prompt + tools inline.
 *
 * When an existing cache is close to expiry (< REFRESH_THRESHOLD_MS),
 * a background refresh is triggered so the next request has a warm cache.
 */
export async function getOrCreateCacheWithUsage(
  args: GetOrCreateCacheArgs,
): Promise<CacheLookupResult | null> {
  const { model, apiKey, systemInstruction, tools } = args

  if (!supportsCaching(model)) return null
  if (!apiKey) return null
  if (approxSize(systemInstruction, tools) < MIN_CACHE_SIZE_CHARS) return null

  const key = computeKey(model, systemInstruction, tools)

  // Honor active miss cooldown.
  const miss = _misses.get(key)
  if (miss && Date.now() < miss.retryAfter) {
    _stats.misses++
    return null
  }
  if (miss) _misses.delete(key)

  // Return existing cache if still valid.
  const existing = _caches.get(key)
  if (existing && Date.now() < existing.expiresAt) {
    _stats.hits++
    // Proactively refresh when close to expiry so the next request
    // doesn't pay full input cost while waiting for a new cache.
    const remaining = existing.expiresAt - Date.now()
    if (remaining < REFRESH_THRESHOLD_MS) {
      _refreshInBackground(args, key)
    }
    return { cacheName: existing.cacheName, createdTokens: 0 }
  }
  if (existing) _caches.delete(key)

  // Create a new cache.
  _stats.creates++
  return _createCacheOnServer(key, args)
}

export async function getOrCreateCache(
  args: GetOrCreateCacheArgs,
): Promise<string | null> {
  return (await getOrCreateCacheWithUsage(args))?.cacheName ?? null
}

/**
 * Drop a cache entry from the map — call this when a request using this
 * cache name returned 404/expired so the next call creates a fresh one.
 */
export function invalidateCache(cacheName: string): void {
  for (const [key, entry] of _caches.entries()) {
    if (entry.cacheName === cacheName) {
      _caches.delete(key)
      return
    }
  }
}

/**
 * Pre-warm the cache for a given model + system prompt + tools combo.
 * Called during provider initialization to ensure the first real request
 * gets a cache hit. Non-blocking — returns immediately.
 */
export function warmCache(args: GetOrCreateCacheArgs): void {
  if (!supportsCaching(args.model)) return
  if (!args.apiKey) return
  if (approxSize(args.systemInstruction, args.tools) < MIN_CACHE_SIZE_CHARS) return
  // Fire and forget — don't block the caller.
  getOrCreateCache(args).catch(() => {})
}

/** Diagnostic counters for cache performance. */
export function getCacheStats(): { hits: number; misses: number; creates: number; refreshes: number; errors: number } {
  return { ..._stats }
}

/** Test hook — clear all cache state. Not used in prod. */
export function _resetGeminiCacheStateForTests(): void {
  _caches.clear()
  _misses.clear()
  _pendingRefreshes.clear()
  _stats.hits = 0
  _stats.misses = 0
  _stats.creates = 0
  _stats.refreshes = 0
  _stats.errors = 0
}
