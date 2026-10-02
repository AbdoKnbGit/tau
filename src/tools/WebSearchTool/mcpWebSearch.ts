import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { excerptForQuery, extractQueryTerms } from '../../utils/queryExcerpt.js'

export const EXA_API_KEY_ENV = 'EXA_API_KEY'
export const PARALLEL_API_KEY_ENV = 'PARALLEL_API_KEY'
export const WEBSEARCH_PROVIDER_ENV = 'TAU_WEBSEARCH_PROVIDER'
export const OPENCODE_WEBSEARCH_PROVIDER_ENV = 'OPENCODE_WEBSEARCH_PROVIDER'

const EXA_MCP_BASE_URL = 'https://mcp.exa.ai/mcp'
const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp'
const MCP_SEARCH_TIMEOUT_MS = 25_000
const MCP_SEARCH_NUM_RESULTS = 8
const MCP_CONTEXT_MAX_CHARS = 10_000
const MCP_MAX_DESCRIPTION_CHARS = 800
const MCP_MAX_CONTENT_CHARS = 4_000

export type McpWebSearchProvider = 'exa' | 'parallel'

export type McpWebSearchInput = {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

type McpSearchResult = {
  text: string
  hits: McpWebSearchHit[]
  provider: McpWebSearchProvider
  durationSeconds: number
}

export type McpWebSearchHit = {
  title: string
  url: string
  description?: string
  content?: string
}

type McpJsonRpcResponse = {
  result?: {
    content?: unknown
  }
}

function getExaMcpUrl(): string {
  const apiKey = process.env[EXA_API_KEY_ENV]?.trim()
  if (!apiKey) return EXA_MCP_BASE_URL
  return `${EXA_MCP_BASE_URL}?exaApiKey=${encodeURIComponent(apiKey)}`
}

function getParallelHeaders(): Record<string, string> {
  const apiKey = process.env[PARALLEL_API_KEY_ENV]?.trim()
  const headers: Record<string, string> = {
    'User-Agent': 'tau',
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

function getProviderOverride(): McpWebSearchProvider | null {
  const override =
    process.env[WEBSEARCH_PROVIDER_ENV] ||
    process.env[OPENCODE_WEBSEARCH_PROVIDER_ENV]
  if (override === 'exa' || override === 'parallel') return override
  return null
}

function getProviderOrder(): McpWebSearchProvider[] {
  const override = getProviderOverride()
  if (override) {
    return override === 'exa' ? ['exa', 'parallel'] : ['parallel', 'exa']
  }

  if (process.env[PARALLEL_API_KEY_ENV]?.trim()) {
    return ['parallel', 'exa']
  }

  return ['exa', 'parallel']
}

function formatDomainList(domains: string[]): string {
  return domains.map(domain => domain.trim()).filter(Boolean).join(', ')
}

function buildProviderQuery(input: McpWebSearchInput): string {
  const constraints: string[] = []
  const allowed = formatDomainList(input.allowed_domains ?? [])
  const blocked = formatDomainList(input.blocked_domains ?? [])

  if (allowed) {
    constraints.push(`Only include results from these domains: ${allowed}.`)
  }
  if (blocked) {
    constraints.push(`Do not include results from these domains: ${blocked}.`)
  }

  if (!constraints.length) return input.query
  return `${input.query}\n\n${constraints.join('\n')}`
}

function normalizeText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).replace(/\s+\S*$/, '').trimEnd()}\n[content truncated]`
}

/**
 * Fit one hit's text to the per-hit cap. Providers return far more text than
 * fits; when a query is known, keep the passages that match it instead of the
 * page head, falling back to the head when nothing matches.
 */
function normalizeHitContent(value: string, terms: readonly string[]): string {
  if (terms.length > 0) {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length > MCP_MAX_CONTENT_CHARS) {
      const excerpt = excerptForQuery(normalized, terms, MCP_MAX_CONTENT_CHARS)
      if (excerpt !== null) return excerpt
    }
  }
  return normalizeText(value, MCP_MAX_CONTENT_CHARS)
}

function normalizeUrl(value: string): string {
  return value.replace(/[),.;]+$/g, '')
}

export function parseMcpWebSearchHits(
  text: string,
  query?: string,
): McpWebSearchHit[] {
  const matches = Array.from(
    text.matchAll(/Title:\s*([\s\S]*?)\s+URL:\s*(https?:\/\/[^\s)]+)/g),
  )
  if (!matches.length) return []

  const terms = query ? extractQueryTerms(query) : []
  const hits: McpWebSearchHit[] = []
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    if (match.index === undefined || !match[1] || !match[2]) continue

    const title = normalizeText(match[1], MCP_MAX_DESCRIPTION_CHARS)
    const url = normalizeUrl(match[2])
    if (!title || !url) continue

    const contentStart = match.index + match[0].length
    const contentEnd = matches[i + 1]?.index ?? text.length
    const content = normalizeHitContent(
      text.slice(contentStart, contentEnd),
      terms,
    )

    hits.push({
      title,
      url,
      ...(content ? { content } : {}),
    })
  }

  return hits
}

function parsePayload(payload: string): string | undefined {
  const trimmed = payload.trim()
  if (!trimmed || !trimmed.startsWith('{')) return undefined

  let parsed: McpJsonRpcResponse
  try {
    parsed = JSON.parse(trimmed) as McpJsonRpcResponse
  } catch {
    return undefined
  }

  const content = parsed.result?.content
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (!Array.isArray(content)) return undefined

  for (const item of content) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'text' in item &&
      typeof item.text === 'string' &&
      item.text.trim()
    ) {
      return item.text.trim()
    }
  }

  return undefined
}

export function parseMcpWebSearchResponse(body: string): string | undefined {
  const trimmed = body.trim()
  const direct = trimmed ? parsePayload(trimmed) : undefined
  if (direct) return direct

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue
    const result = parsePayload(line.slice(6))
    if (result) return result
  }

  return undefined
}

async function callMcpTool(
  provider: McpWebSearchProvider,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(
    provider === 'exa' ? getExaMcpUrl() : PARALLEL_MCP_URL,
    {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(provider === 'parallel' ? getParallelHeaders() : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
      signal,
    },
  )

  const body = await response.text()
  if (!response.ok) {
    const detail = body.trim() || `${response.status} ${response.statusText}`
    throw new Error(`${provider} web search failed: ${detail}`)
  }

  const parsed = parseMcpWebSearchResponse(body)
  if (!parsed) {
    throw new Error(`${provider} web search returned no text results`)
  }
  return parsed
}

async function callProvider(
  provider: McpWebSearchProvider,
  input: McpWebSearchInput,
  signal: AbortSignal,
): Promise<string> {
  const query = buildProviderQuery(input)
  if (provider === 'parallel') {
    return callMcpTool(
      provider,
      'web_search',
      {
        objective: query,
        search_queries: [query],
      },
      signal,
    )
  }

  return callMcpTool(
    provider,
    'web_search_exa',
    {
      query,
      type: 'auto',
      numResults: MCP_SEARCH_NUM_RESULTS,
      livecrawl: 'fallback',
      contextMaxCharacters: MCP_CONTEXT_MAX_CHARS,
    },
    signal,
  )
}

export async function runMcpWebSearch(
  input: McpWebSearchInput,
  signal?: AbortSignal,
): Promise<McpSearchResult> {
  const startTime = performance.now()
  const combined = createCombinedAbortSignal(signal, {
    timeoutMs: MCP_SEARCH_TIMEOUT_MS + 5_000,
  })
  try {
    let lastError: unknown
    for (const provider of getProviderOrder()) {
      try {
        const text = await callProvider(provider, input, combined.signal)
        return {
          provider,
          text,
          hits: parseMcpWebSearchHits(text, input.query),
          durationSeconds: (performance.now() - startTime) / 1000,
        }
      } catch (error) {
        if (combined.signal.aborted) throw error
        lastError = error
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('MCP web search failed')
  } finally {
    combined.cleanup()
  }
}
