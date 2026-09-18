/**
 * Cache-prefix byte-identity diagnostic for the OpenAI-compat lane.
 *
 * Implicit-cache upstreams (DeepSeek automatic caching, Gemini/Anthropic on
 * OpenRouter) hit only on a BYTE-STABLE prefix. When the reported cache rate
 * looks unstable, the question is always "which segment of the prefix changed
 * between turns?" This instrument answers it: it fingerprints every prefix
 * segment (each tool, the system message, then each conversation message) with
 * cache_control normalized OUT (gateways strip it before the upstream, so it is
 * not real content churn), diffs against the previous request of the same
 * stream (main thread, one agent, or a side query against the main thread), and
 * reports the FIRST diverging segment — the exact point the cache goes cold.
 *
 * Enable with TAU_CACHE_DEBUG=1. Output: a one-line verdict on stderr plus a
 * JSONL row per request at <tmpdir>/tau-compat-cache-debug.jsonl. A verdict of
 * "clean prefix extension" every turn means the prefix is byte-stable and any
 * uncached tokens are genuinely-new content (expected); a "BREAK at segment N"
 * names the churning segment so the fix is surgical, not a guess.
 */

import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenAIChatMessage, OpenAIChatRequest } from './transformers/shared_types.js'

export function isCompatCacheDebugEnabled(): boolean {
  return Boolean(process.env.TAU_CACHE_DEBUG)
}

type Segment = { label: string; hash: string; bytes: number }

// Previous request's segments, per cache key. Module-scoped: persists across
// turns within the process, which is exactly the window a prefix cache spans.
const prevBySession = new Map<string, Segment[]>()

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/** Text an implicit-cache upstream actually sees for a message — content only,
 *  cache_control stripped, but role/tool linkage preserved. */
function normalizeMessage(m: OpenAIChatMessage): string {
  let content = ''
  if (typeof m.content === 'string') {
    content = m.content
  } else if (Array.isArray(m.content)) {
    content = (m.content as any[])
      .map(part => {
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text
          const { cache_control: _cc, ...rest } = part
          return JSON.stringify(rest)
        }
        return String(part)
      })
      .join('\n')
  }
  const toolCalls = Array.isArray(m.tool_calls)
    ? m.tool_calls
        .map(tc => `${tc.id}:${tc.function?.name}:${tc.function?.arguments}`)
        .join('|')
    : ''
  return [m.role ?? '', m.tool_call_id ?? '', toolCalls, content].join('\\0')
}

function normalizeTool(tool: unknown): string {
  if (!tool || typeof tool !== 'object') return JSON.stringify(tool)
  const { cache_control: _cc, ...rest } = tool as Record<string, unknown>
  return JSON.stringify(rest)
}

function buildSegments(body: OpenAIChatRequest): Segment[] {
  const segments: Segment[] = []

  // Tools sit at the front of the cached prefix — one segment each so a break
  // names the specific tool schema that churned.
  for (const tool of body.tools ?? []) {
    const name = (tool as any)?.function?.name ?? 'tool'
    const serialized = normalizeTool(tool)
    segments.push({ label: `tool:${name}`, hash: shortHash(serialized), bytes: serialized.length })
  }

  for (const m of body.messages ?? []) {
    const serialized = normalizeMessage(m)
    segments.push({ label: `msg:${m.role ?? '?'}`, hash: shortHash(serialized), bytes: serialized.length })
  }

  return segments
}

export function compatCacheDebugKey(
  provider: string,
  model: string,
  sessionId: string | undefined,
  body: Pick<OpenAIChatRequest, 'tools'>,
): string {
  const session = sessionId ?? 'no-session'
  const toolScope = (body.tools?.length ?? 0) > 0 ? 'tools' : 'no-tools'
  return `${provider}:${model.toLowerCase()}:${toolScope}:${session}`
}

/**
 * The request stream within a session: its query source plus its first user
 * message (an agent's task prompt, unchanged by a resume). Most providers give
 * agents the root session id, and some send none, so the session alone mixes
 * the main thread, every agent and side queries, and each verdict diffs
 * against whichever of them sent last.
 */
export function compatCacheDebugStream(
  querySource: string | undefined,
  body: Pick<OpenAIChatRequest, 'messages'>,
): string {
  const source =
    !querySource || querySource.startsWith('repl_main_thread') || querySource === 'sdk'
      ? 'main'
      : querySource
  const firstUser = body.messages?.find(m => m.role === 'user')
  return `${source}#${firstUser ? shortHash(normalizeMessage(firstUser)) : '-'}`
}

/** Side queries (prompt suggestions, compaction, ...) reuse the main thread's
 *  prefix: diff them against it, without replacing its baseline. */
function parentStream(stream: string, querySource: string | undefined): string | undefined {
  if (stream.startsWith('main#') || querySource?.startsWith('agent:')) return undefined
  return `main#${stream.slice(stream.indexOf('#') + 1)}`
}

const MAX_TRACKED_STREAMS = 256

/**
 * Compare `segments` against the previous request for `key`. Returns the index
 * of the first diverging segment, or -1 when the new request is a clean prefix
 * extension of the previous one (every shared segment identical).
 */
export function firstDivergingSegment(prev: Segment[], next: Segment[]): number {
  const shared = Math.min(prev.length, next.length)
  for (let i = 0; i < shared; i++) {
    if (prev[i]!.hash !== next[i]!.hash) return i
  }
  // Prefix matched as far as they overlap. A SHORTER new request means the tail
  // was dropped (history rewrite/compaction) — that also breaks the cache.
  if (next.length < prev.length) return next.length
  return -1
}

export function recordCompatCacheDebug(
  provider: string,
  model: string,
  sessionId: string | undefined,
  body: OpenAIChatRequest,
  querySource?: string,
): void {
  if (!isCompatCacheDebugEnabled()) return
  try {
    const base = compatCacheDebugKey(provider, model, sessionId, body)
    const stream = compatCacheDebugStream(querySource, body)
    const key = `${base}:${stream}`
    const parent = parentStream(stream, querySource)
    const segments = buildSegments(body)
    const parentPrev = parent ? prevBySession.get(`${base}:${parent}`) : undefined
    const prev = parentPrev ?? prevBySession.get(key)
    prevBySession.delete(key)
    prevBySession.set(key, segments)
    if (prevBySession.size > MAX_TRACKED_STREAMS) {
      const oldest = prevBySession.keys().next().value
      if (oldest !== undefined) prevBySession.delete(oldest)
    }

    let diverge = -1
    let verdict: string
    if (!prev) {
      verdict = 'cold (first turn this session)'
    } else {
      diverge = firstDivergingSegment(prev, segments)
      verdict =
        diverge === -1
          ? `ok: clean prefix extension (+${segments.length - prev.length} segments)`
          : `BREAK at segment ${diverge}/${segments.length} (${segments[diverge]?.label ?? '?'})`
    }

    const entry = {
      ts: new Date().toISOString(),
      provider,
      model,
      querySource,
      session: sessionId ?? 'no-session',
      cacheKey: key,
      baseline: parentPrev ? 'main' : 'self',
      nSegments: segments.length,
      prevSegments: prev?.length ?? 0,
      firstDiverging: diverge,
      verdict,
      segments: segments.map((s, i) => ({
        i,
        label: s.label,
        bytes: s.bytes,
        changed: prev ? i >= prev.length || prev[i]?.hash !== s.hash : true,
      })),
    }
    appendFileSync(
      join(tmpdir(), 'tau-compat-cache-debug.jsonl'),
      `${JSON.stringify(entry)}\n`,
    )
    // eslint-disable-next-line no-console
    console.error(`[tau-compat-cache] ${provider}/${model} — ${verdict}`)
  } catch {
    // A diagnostic must never break the request.
  }
}
