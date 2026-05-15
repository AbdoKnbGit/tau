import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'

export const FIRECRAWL_PROVIDER_KEY = 'firecrawl'
export const FIRECRAWL_DISPLAY_NAME = 'Firecrawl Search'
export const FIRECRAWL_API_KEY_ENV = 'FIRECRAWL_API_KEY'
export const FIRECRAWL_API_URL_ENV = 'FIRECRAWL_API_URL'

const DEFAULT_FIRECRAWL_API_URL = 'https://api.firecrawl.dev'
const FIRECRAWL_SEARCH_LIMIT = 8
const FIRECRAWL_TIMEOUT_MS = 30_000
const FIRECRAWL_SCRAPE_TIMEOUT_MS = 15_000
const FIRECRAWL_MAX_FALLBACK_SCRAPES = 3
const FIRECRAWL_MAX_DESCRIPTION_CHARS = 800
const FIRECRAWL_MAX_CONTENT_CHARS = 4_000

export type FirecrawlSearchInput = {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export type FirecrawlSearchHit = {
  title: string
  url: string
  description?: string
  content?: string
}

type FirecrawlSearchPayload = {
  query: string
  sources?: ['web']
  limit: number
  includeDomains?: string[]
  excludeDomains?: string[]
  timeout?: number
  scrapeOptions?: {
    formats: ['markdown']
    onlyMainContent: boolean
    removeBase64Images: boolean
    timeout: number
  }
}

type FirecrawlScrapePayload = {
  url: string
  formats: ['markdown']
  onlyMainContent: boolean
  removeBase64Images: boolean
  timeout: number
}

type FirecrawlSearchResponse = {
  success?: boolean
  data?: unknown
  error?: unknown
  message?: unknown
  details?: unknown
}

type FirecrawlDocumentLike = {
  url?: unknown
  title?: unknown
  description?: unknown
  markdown?: unknown
  summary?: unknown
  answer?: unknown
  snippet?: unknown
  metadata?: {
    sourceURL?: unknown
    url?: unknown
    title?: unknown
    description?: unknown
    ogTitle?: unknown
    ogDescription?: unknown
    ogUrl?: unknown
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function getFirecrawlApiUrl(): string {
  const configured = process.env[FIRECRAWL_API_URL_ENV]?.trim()
  return trimTrailingSlash(configured || DEFAULT_FIRECRAWL_API_URL)
}

export function getFirecrawlApiKey(): string | null {
  const envKey = process.env[FIRECRAWL_API_KEY_ENV]?.trim()
  if (envKey) return envKey

  const storedKey = loadProviderKey(FIRECRAWL_PROVIDER_KEY)?.trim()
  return storedKey || null
}

export function hasFirecrawlSearchConfig(): boolean {
  return getFirecrawlApiKey() !== null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const truncated = value.slice(0, maxChars).replace(/\s+\S*$/, '').trimEnd()
  return `${truncated}\n[content truncated]`
}

function normalizePlainText(value: string, maxChars: number): string {
  return truncateText(value.replace(/\s+/g, ' ').trim(), maxChars)
}

function normalizePageContent(value: string): string {
  return truncateText(
    value
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    FIRECRAWL_MAX_CONTENT_CHARS,
  )
}

function normalizeDomain(value: string): string | null {
  let candidate = value.trim()
  if (!candidate) return null

  try {
    const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
    const parsed = new URL(hasProtocol ? candidate : `https://${candidate}`)
    candidate = parsed.hostname
  } catch {
    candidate = candidate.split(/[/?#]/, 1)[0] ?? ''
  }

  candidate = candidate
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^\.+|\.+$/g, '')

  if (!candidate || !/^[a-z0-9.-]+$/.test(candidate)) return null
  return candidate
}

function normalizeDomainFilter(domains: string[] | undefined): string[] {
  if (!domains?.length) return []
  return Array.from(
    new Set(
      domains
        .map(normalizeDomain)
        .filter((domain): domain is string => domain !== null),
    ),
  )
}

function getUrlHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^\.+|\.+$/g, '')
  } catch {
    return null
  }
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function keepHitForFilters(
  hit: FirecrawlSearchHit,
  includeDomains: string[],
  excludeDomains: string[],
): boolean {
  const hostname = getUrlHostname(hit.url)
  if (!hostname) return true

  if (
    includeDomains.length > 0 &&
    !includeDomains.some(domain => matchesDomain(hostname, domain))
  ) {
    return false
  }

  return !excludeDomains.some(domain => matchesDomain(hostname, domain))
}

function getWebResults(data: unknown): unknown[] {
  if (Array.isArray(data)) return data

  const record = asRecord(data)
  if (!record) return []

  const web = record.web
  return Array.isArray(web) ? web : []
}

function toSearchHit(value: unknown): FirecrawlSearchHit | null {
  const urlOnly = asString(value)
  if (urlOnly) return { title: urlOnly, url: urlOnly }

  const result = asRecord(value) as FirecrawlDocumentLike | null
  if (!result) return null

  const url =
    asString(result.url) ||
    asString(result.metadata?.sourceURL) ||
    asString(result.metadata?.url) ||
    asString(result.metadata?.ogUrl)
  if (!url) return null

  const title =
    asString(result.title) ||
    asString(result.metadata?.title) ||
    asString(result.metadata?.ogTitle) ||
    url
  const description =
    asString(result.description) ||
    asString(result.metadata?.description) ||
    asString(result.metadata?.ogDescription)
  const content =
    asString(result.markdown) ||
    asString(result.summary) ||
    asString(result.answer) ||
    asString(result.snippet)

  const hit: FirecrawlSearchHit = { title, url }
  if (description) {
    hit.description = normalizePlainText(
      description,
      FIRECRAWL_MAX_DESCRIPTION_CHARS,
    )
  }
  if (content) {
    hit.content = normalizePageContent(content)
  }
  return hit
}

function buildPayload(input: FirecrawlSearchInput): FirecrawlSearchPayload {
  const payload: FirecrawlSearchPayload = {
    query: input.query,
    sources: ['web'],
    limit: FIRECRAWL_SEARCH_LIMIT,
    timeout: FIRECRAWL_TIMEOUT_MS,
    scrapeOptions: {
      formats: ['markdown'],
      onlyMainContent: true,
      removeBase64Images: true,
      timeout: FIRECRAWL_SCRAPE_TIMEOUT_MS,
    },
  }

  const includeDomains = normalizeDomainFilter(input.allowed_domains)
  const excludeDomains = normalizeDomainFilter(input.blocked_domains)

  if (includeDomains.length) {
    payload.includeDomains = includeDomains
  }
  if (!includeDomains.length && excludeDomains.length) {
    payload.excludeDomains = excludeDomains
  }

  return payload
}

function buildMinimalPayload(input: FirecrawlSearchInput): FirecrawlSearchPayload {
  return {
    query: input.query,
    limit: FIRECRAWL_SEARCH_LIMIT,
  }
}

function buildScrapePayload(url: string): FirecrawlScrapePayload {
  return {
    url,
    formats: ['markdown'],
    onlyMainContent: true,
    removeBase64Images: true,
    timeout: FIRECRAWL_SCRAPE_TIMEOUT_MS,
  }
}

function mergeHitWithScrapedContent(
  hit: FirecrawlSearchHit,
  scraped: FirecrawlSearchHit | null,
): FirecrawlSearchHit {
  if (!scraped) return hit
  return {
    title: hit.title || scraped.title,
    url: hit.url || scraped.url,
    description: hit.description || scraped.description,
    content: hit.content || scraped.content,
  }
}

function getFirecrawlError(
  response: Response,
  body: FirecrawlSearchResponse | null,
  operation = 'search',
): string {
  const detail =
    asString(body?.error) ||
    asString(body?.message) ||
    (body?.details ? JSON.stringify(body.details) : null) ||
    `${response.status} ${response.statusText}`.trim()
  return `Firecrawl ${operation} failed: ${detail}`
}

function isInvalidRequestBody(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /invalid request body|bad_request|zod|unrecognized/i.test(message)
}

async function postFirecrawlSearch(
  payload: FirecrawlSearchPayload,
  apiKey: string,
  signal?: AbortSignal,
): Promise<FirecrawlSearchResponse> {
  const response = await fetch(`${getFirecrawlApiUrl()}/v2/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  })

  let parsed: FirecrawlSearchResponse | null = null
  try {
    parsed = (await response.json()) as FirecrawlSearchResponse
  } catch {
    parsed = null
  }

  if (!response.ok || parsed?.success === false) {
    throw new Error(getFirecrawlError(response, parsed))
  }

  return parsed ?? {}
}

async function postFirecrawlScrape(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<FirecrawlSearchResponse> {
  const response = await fetch(`${getFirecrawlApiUrl()}/v2/scrape`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildScrapePayload(url)),
    signal,
  })

  let parsed: FirecrawlSearchResponse | null = null
  try {
    parsed = (await response.json()) as FirecrawlSearchResponse
  } catch {
    parsed = null
  }

  if (!response.ok || parsed?.success === false) {
    throw new Error(getFirecrawlError(response, parsed, 'scrape'))
  }

  return parsed ?? {}
}

async function enrichHitsWithScrapedContent(
  hits: FirecrawlSearchHit[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<FirecrawlSearchHit[]> {
  let scrapeCount = 0
  return Promise.all(
    hits.map(async hit => {
      if (hit.content || scrapeCount >= FIRECRAWL_MAX_FALLBACK_SCRAPES) {
        return hit
      }

      scrapeCount++
      try {
        const response = await postFirecrawlScrape(hit.url, apiKey, signal)
        const scraped = toSearchHit({
          ...(asRecord(response.data) ?? {}),
          url: hit.url,
          title: hit.title,
        })
        return mergeHitWithScrapedContent(hit, scraped)
      } catch {
        return hit
      }
    }),
  )
}

export async function runFirecrawlWebSearch(
  input: FirecrawlSearchInput,
  signal?: AbortSignal,
): Promise<{ hits: FirecrawlSearchHit[]; durationSeconds: number }> {
  const apiKey = getFirecrawlApiKey()
  if (!apiKey) {
    throw new Error(
      'Firecrawl web search is not configured. Run /login and select Firecrawl Search, or set FIRECRAWL_API_KEY.',
    )
  }

  const startTime = performance.now()
  const combined = createCombinedAbortSignal(signal, {
    timeoutMs: FIRECRAWL_TIMEOUT_MS + 5_000,
  })
  try {
    let response: FirecrawlSearchResponse
    try {
      response = await postFirecrawlSearch(
        buildPayload(input),
        apiKey,
        combined.signal,
      )
    } catch (error) {
      if (!isInvalidRequestBody(error)) throw error
      response = await postFirecrawlSearch(
        buildMinimalPayload(input),
        apiKey,
        combined.signal,
      )
    }
    const includeDomains = normalizeDomainFilter(input.allowed_domains)
    const excludeDomains = normalizeDomainFilter(input.blocked_domains)
    const hits = getWebResults(response.data ?? response)
      .map(toSearchHit)
      .filter((hit): hit is FirecrawlSearchHit => hit !== null)
      .filter(hit => keepHitForFilters(hit, includeDomains, excludeDomains))

    return {
      hits: await enrichHitsWithScrapedContent(hits, apiKey, combined.signal),
      durationSeconds: (performance.now() - startTime) / 1000,
    }
  } finally {
    combined.cleanup()
  }
}

export async function testFirecrawlApiKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    return { ok: false, error: 'Firecrawl API key cannot be empty.' }
  }

  const combined = createCombinedAbortSignal(undefined, { timeoutMs: 10_000 })
  try {
    await postFirecrawlSearch(
      {
        query: 'firecrawl',
        limit: 1,
      },
      trimmed,
      combined.signal,
    )
    return { ok: true }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Could not validate Firecrawl key'
    if (/401|403|unauthorized|forbidden|invalid/i.test(message)) {
      return { ok: false, error: message }
    }
    return { ok: true }
  } finally {
    combined.cleanup()
  }
}
