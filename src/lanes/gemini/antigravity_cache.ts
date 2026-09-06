/**
 * Antigravity Gemini implicit-cache recovery and diagnostics.
 *
 * Historical 3.5 probes suggested a ~16k-token cache threshold. Controlled
 * 2026-09-06 tests on 3.8 cached 9,008- and 11,811-token prompts, so that
 * threshold is not universal. Identical 19,803-token requests repeatedly
 * returned 16,353 cached tokens after 20s, with no tools or history changes.
 * A stable prefix permits reuse; it does not guarantee full token coverage.
 *
 * The default guard waits after a completed cold response, with bounded
 * retries. Its local state is scoped by session, model and query source;
 * upstream routing IDs and prompt bytes remain untouched. Actual token
 * counts override character estimates for dense agent prompts. Streaming
 * usage must be finalized before it can consume a recovery opportunity.
 *
 * Prefix padding and extra agent pacing remain opt-in via
 * TAU_ANTIGRAVITY_MAX_CACHE=1. They are not a guarantee of lower total cost.
 * TAU_CACHE_DEBUG=1 records request hashes and final usage with correlation
 * IDs kept out of the wire payload. No diagnostic calls the model itself.
 *
 * Callers restrict recovery/padding to Antigravity Gemini; Claude on
 * Antigravity and other providers retain their existing behavior.
 */

import { createHash } from 'crypto'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetSessionVolatileFreezeForTest,
  freezeSessionVolatileText,
} from '../shared/volatile_freeze.js'

// ─── Opt-in switch ───────────────────────────────────────────────
//
// The cache discipline (prefix pad + commit-window pacing + agent gate) is
// OFF by default. It trades interactive latency for token savings and only
// earns its keep on long, many-turn batch/agent runs. With it off, simple
// prompts stay small and the implicit cache can warm from real conversation
// content. Cache eligibility and coverage vary by model and server state.
// TAU_ANTIGRAVITY_MAX_CACHE=1 adds padding toward the historical 17.4k target;
// it does not guarantee reuse and adds tokens to every request.
export function antigravityMaxCacheEnabled(): boolean {
  return process.env.TAU_ANTIGRAVITY_MAX_CACHE === '1'
}

// ─── Prefix padding ──────────────────────────────────────────────

// Retain the historical opt-in padding target; default recovery adds no pad.
const TARGET_TOKENS = 17_400

// Existing-content token estimate: assume ≥1 token per 5.5 chars.
// English prose runs ~4-5 chars/token and JSON schemas ~3-4, so this
// systematically UNDER-estimates the real token count — meaning the pad
// overshoots the target rather than undershooting the cache minimum.
const EXISTING_CHARS_PER_TOKEN = 5.5

// Pad filler measured at ~4.36 chars/token (counter digits keep the
// tokenizer from over-compressing repetition). Provision at 4.6 so the
// generated pad always reaches at least the requested token count.
const PAD_CHARS_PER_TOKEN = 4.6

// Round pad sizes up to this granularity so the per-size memo stays
// tiny and a conversation's pad is trivially byte-stable across turns
// even when the tool list drifts by a few characters.
const PAD_SIZE_STEP_TOKENS = 500

const _padBySize = new Map<number, string>()

/** Deterministic inert pad sized to `tokens` (estimated). */
export function antigravityPrefixPad(tokens: number): string {
  const cached = _padBySize.get(tokens)
  if (cached !== undefined) return cached

  const parts: string[] = [
    '<cache_alignment_padding>',
    'The block below is inert padding that aligns this request with the',
    'provider prefix cache. It carries no instructions, no data, and no',
    'relevance to your task. Disregard everything inside this block.',
    '',
  ]
  const targetChars = Math.ceil(tokens * PAD_CHARS_PER_TOKEN)
  let length = parts.join('\n').length
  let i = 0
  while (length < targetChars) {
    const line = `Segment ${String(i).padStart(6, '0')}: inert cache alignment text for provider prefix stability; this line carries no instructions.`
    parts.push(line)
    length += line.length + 1
    i++
  }
  parts.push('</cache_alignment_padding>')
  const pad = parts.join('\n')
  _padBySize.set(tokens, pad)
  return pad
}

/**
 * Pad a request's stable system text toward the historical opt-in target.
 * This is not a guarantee of server cache eligibility or coverage.
 *
 * Applies to every Antigravity Gemini request whose stable prefix
 * (system text + tool declarations) is estimated below that target —
 * main thread and agents alike. Over-target prompts are returned
 * unchanged, so naturally-large sessions never pay for padding. The
 * pad size is derived from turn-stable inputs only, so a given
 * conversation gets byte-identical padding on every turn of its run.
 */
export function applyAntigravityPrefixPad(
  stableText: string,
  toolDeclarationChars: number,
  querySource?: string,
): string {
  // Reports are already hard-bounded and intentionally non-cacheable. Padding
  // one to the implicit-cache minimum recreates the large cold request that
  // /report is designed to avoid (about 17.4k inert tokens with max-cache on).
  if (querySource === 'report') return stableText
  if (process.env.TAU_ANTIGRAVITY_NO_PREFIX_PAD === '1') return stableText
  // Default OFF — padding a small prompt to ~17.4k tokens makes simple,
  // interactive turns slow for a cache win that natural session growth
  // already provides. Opt in for token-cost-sensitive batch/agent runs.
  if (!antigravityMaxCacheEnabled()) return stableText

  const existingChars = stableText.length + toolDeclarationChars
  const estimatedTokens = Math.floor(existingChars / EXISTING_CHARS_PER_TOKEN)
  const missing = TARGET_TOKENS - estimatedTokens
  if (missing <= 0) return stableText

  const padTokens =
    Math.ceil(missing / PAD_SIZE_STEP_TOKENS) * PAD_SIZE_STEP_TOKENS
  return `${antigravityPrefixPad(padTokens)}\n\n${stableText}`
}

/**
 * Return a session-stable volatile prefix for Antigravity implicit cache.
 *
 * Antigravity hashes the leading contents as part of its implicit cache
 * prefix. Replacing the environment/git block on each turn makes the previous
 * prompt no longer a prefix of the next prompt. Freezing the first copy keeps
 * the prefix append-only; current task/user/tool content still flows through
 * the real conversation tail.
 */
export function freezeAntigravityVolatilePrefix(
  cacheKey: string,
  volatileText: string,
): string {
  // Implementation generalized to shared/volatile_freeze.ts — the same
  // snapshot discipline now covers the OpenRouter lane and every Gemini path,
  // not just Antigravity. This export stays as the Antigravity-documented name.
  return freezeSessionVolatileText(cacheKey, volatileText)
}

// ─── Commit-window pacing (agent sessions only) ──────────────────
//
// Holding the agent's SECOND request gives a cold write time to become
// reusable. It cannot guarantee subsequent hits or their token coverage.
// If the second request still missed, one re-arm paces the third
// request from the second's start; after two paced turns we give up so
// a shape the server refuses to cache can't throttle a whole run. A
// qualifying cache hit latches pacing off.
//
// The window is rebalanced from 15s → 6s: the implicit-cache write
// usually commits in <5s, so the old 15s ceiling stalled agents far
// longer than the backend actually needed. Override with
// TAU_ANTIGRAVITY_PACING_MS (0 keeps state tracking but never waits).

const DEFAULT_COMMIT_WINDOW_MS = 6_000
const MAX_PACED_TURNS = 2
const AGENT_SESSION_PREFIX = 'tau-agent-'

// Mid-session cold-cascade damper: a full-cold request re-pays the whole
// prompt AND its replacement write commits async (~8-22s), so a fast
// follow-up request re-pays everything AGAIN (live transcript: a 38k-token
// cold fired 14s after a 37k cold on the same session). Whenever usage
// reports a full cold on a prompt big enough to commit, re-arm the
// commit-window guard so the NEXT request waits the write out. Bounded per
// session so a backend that refuses to cache can't throttle a whole run.
const GUARD_MIN_PROMPT_TOKENS = 16_384
// Recovery policy, not a claim about the server's exact minimum. Controlled
// Gemini 3.8 tests (2026-09-06) cached 9,008- and 11,811-token prompts after a
// cold response; 4,993 tokens did not cache. The old 16k gate skipped these
// eligible subagents entirely. Retain the older-model policy until measured.
const GEMINI_38_GUARD_MIN_PROMPT_TOKENS = 8_192
const CACHE_BLOCK_TOKENS = 4_096
const GEMINI_38_UNCACHED_TAIL_ALLOWANCE = 6_144
const FULL_COLD_READ_FRACTION = 0.05
const MAX_GUARD_REARMS = 4

interface PaceState {
  /** Start of the most recent un-committed (cold) request. */
  armedAt: number
  pacedCount: number
  hitSeen: boolean
  /** Times the guard was re-armed by an observed mid-session full cold. */
  rearms: number
  /** Actual completed-response usage, preferable to a character estimate. */
  promptTokens?: number
  cacheReadTokens?: number
}

export interface AntigravityCacheRequestContext {
  sessionId?: string
  model: string
  querySource?: string
  requestId: string
}

// Out-of-band correlation: never serialize a diagnostic ID into the prompt or
// change upstream affinity just to distinguish a helper from its parent.
const requestContexts = new WeakMap<object, AntigravityCacheRequestContext>()

export function trackAntigravityCacheRequest(
  request: object,
  context: AntigravityCacheRequestContext,
): void {
  requestContexts.set(request, context)
}

export function getAntigravityCacheRequestContext(
  request: object,
): AntigravityCacheRequestContext | undefined {
  return requestContexts.get(request)
}

export function antigravityCacheScope(
  sessionId: string,
  model?: string,
  querySource?: string,
): string {
  // Preserve the legacy standalone helper API. Production lane calls always
  // provide the model, including for subagents and same-model side queries.
  if (!model) return sessionId
  const source = !querySource || querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    ? 'conversation'
    : querySource
  return JSON.stringify([sessionId, model.toLowerCase(), source])
}

function guardMinimumPromptTokens(model?: string): number {
  return /^gemini-3\.8-flash-(?:low|medium|high|tiered)$/.test(model?.toLowerCase() ?? '')
    ? GEMINI_38_GUARD_MIN_PROMPT_TOKENS
    : GUARD_MIN_PROMPT_TOKENS
}

// Test override beats env (TAU_ANTIGRAVITY_PACING_MS) beats default.
let _commitWindowOverride: number | undefined
const _agentPace = new Map<string, PaceState>()

function commitWindowMs(): number {
  if (_commitWindowOverride !== undefined) return _commitWindowOverride
  const raw = process.env.TAU_ANTIGRAVITY_PACING_MS
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return DEFAULT_COMMIT_WINDOW_MS
}

function _prunePaceMap(): void {
  if (_agentPace.size <= 64) return
  const entries = [..._agentPace.entries()].sort(
    (a, b) => a[1].armedAt - b[1].armedAt,
  )
  for (let i = 0; i < entries.length - 32; i++) {
    _agentPace.delete(entries[i]![0])
  }
}

export async function paceAntigravityAgentRequest(
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (process.env.TAU_ANTIGRAVITY_NO_PACING === '1') return
  // Default OFF — see antigravityMaxCacheEnabled(). The default guard below
  // uses model-specific size policy and observed usage for recovery.
  if (!antigravityMaxCacheEnabled()) return
  if (!sessionId || !sessionId.startsWith(AGENT_SESSION_PREFIX)) return
  await holdForCommitWindow(sessionId, signal, commitWindowMs())
}

// ─── Session-start commit-window guard (all Antigravity Gemini) ──
//
// Live-measured (2026-07-02 sessions): the 2nd/3rd requests of a session go
// FULL COLD whenever they fire inside the backend's async commit window
// (~8-22s) after the first write — each such miss re-pays the entire prompt
// (~20-30k tokens). The guard holds those early requests until the window
// has elapsed, then latches off for the whole session on the first observed
// hit (steady-state turns are never held). Distinct from the opt-in
// maxCache pacing above: no padding or agent gating. A conservative size
// policy avoids holding tiny prompts, but cannot predict server eligibility.

// Historical older-model character estimate; current 3.8 uses its measured
// recovery policy below, and final token counts override either estimate.
const GUARD_MIN_PROMPT_CHARS = 90_000

// Commits measured at ~8-22s (and later on thinking-tier models: an agent's
// second request 14s after the first stream ended still missed). 15s converts
// most misses while capping the worst added latency (2 paced turns max) at
// ~30s per pacing episode — and a hold only ever happens when the next
// request fires faster than the window, i.e. agent loops, not humans typing.
// TAU_ANTIGRAVITY_PACING_MS overrides, TAU_ANTIGRAVITY_NO_PACING=1 disables.
const GUARD_COMMIT_WINDOW_MS = 15_000

export async function guardAntigravityCommitWindow(
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
  promptChars: number,
  querySource?: string,
  model?: string,
): Promise<void> {
  if (querySource === 'report') return
  if (process.env.TAU_ANTIGRAVITY_NO_PACING === '1') return
  if (!sessionId) return
  const scope = antigravityCacheScope(sessionId, model, querySource)
  const minimumTokens = guardMinimumPromptTokens(model)
  const minimumChars = minimumTokens === GUARD_MIN_PROMPT_TOKENS
    ? GUARD_MIN_PROMPT_CHARS
    : Math.ceil(minimumTokens * EXISTING_CHARS_PER_TOKEN)
  // Token-dense agent prompts can exceed the token threshold long before
  // 90k characters. Once the provider has measured them, trust that count.
  if (promptChars < minimumChars
    && (_agentPace.get(scope)?.promptTokens ?? 0) < minimumTokens) return
  const window = _commitWindowOverride !== undefined || process.env.TAU_ANTIGRAVITY_PACING_MS
    ? commitWindowMs()
    : GUARD_COMMIT_WINDOW_MS
  await holdForCommitWindow(scope, signal, window)
}

async function holdForCommitWindow(
  sessionId: string,
  signal: AbortSignal | undefined,
  windowMs: number,
): Promise<void> {
  const now = Date.now()
  const state = _agentPace.get(sessionId)
  if (!state) {
    _agentPace.set(sessionId, { armedAt: now, pacedCount: 0, hitSeen: false, rearms: 0 })
    _prunePaceMap()
    return
  }
  if (state.hitSeen || state.pacedCount >= MAX_PACED_TURNS) return

  const waitMs = state.armedAt + windowMs - now
  // Natural cadence already cleared the window — the prior write has
  // committed (or never will); don't burn a paced turn on it.
  if (waitMs <= 0) return

  state.pacedCount++
  await new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, waitMs)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
  })
  // This request is the new cold write — if it also misses, the next
  // turn paces from here.
  state.armedAt = Date.now()
}

/**
 * Fold COMPLETED response usage back into the pacing state, once per request.
 * A provisional SSE chunk can omit cachedContentTokenCount; treating that as
 * a miss exhausts the recovery budget even when the final response is a hit.
 * Qualifying reads latch recovery off. Older models retain the historical
 * 70% rule; 3.8 also accepts measured block-sized partial reads so a warm
 * small worker does not wait again for an unattainable percentage.
 */
export function recordAntigravityCacheRead(
  sessionId: string | undefined,
  cacheReadTokens: number,
  promptTokens: number,
  querySource?: string,
  context?: AntigravityCacheRequestContext,
): void {
  // A bounded report shares Antigravity routing affinity with its live chat,
  // but it is not part of that conversation's prompt-cache lineage. Do not let
  // its cold/read metrics arm, re-arm, or latch the root session's pacing.
  if (querySource === 'report') return
  const scope = sessionId ? antigravityCacheScope(sessionId, context?.model, querySource) : undefined
  const previous = scope ? _agentPace.get(scope) : undefined
  if (process.env.TAU_CACHE_DEBUG && sessionId && promptTokens > 0) {
    try {
      appendFileSync(
        join(tmpdir(), 'tau-cache-debug.jsonl'),
        JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'usage',
          sessionId,
          model: context?.model,
          querySource,
          requestId: context?.requestId,
          final: true,
          cacheRead: cacheReadTokens,
          prompt: promptTokens,
          uncached: Math.max(0, promptTokens - cacheReadTokens),
          promptDelta: previous?.promptTokens === undefined ? undefined : promptTokens - previous.promptTokens,
          cacheReadDelta: previous?.cacheReadTokens === undefined ? undefined : cacheReadTokens - previous.cacheReadTokens,
          hitPct: Math.round((cacheReadTokens / promptTokens) * 100),
        }) + '\n',
      )
    } catch {
      // never break the request path
    }
  }
  if (!scope || promptTokens <= 0) return

  const state: PaceState = previous ?? { armedAt: Date.now(), pacedCount: 0, hitSeen: false, rearms: 0 }
  state.promptTokens = promptTokens
  state.cacheReadTokens = cacheReadTokens
  if (!previous) {
    _agentPace.set(scope, state)
    _prunePaceMap()
  }

  // Full cold on a prompt above the measured recovery floor: whatever caused
  // it — endpoint hop, replica miss, TTL expiry, byte churn — this request
  // just re-paid the whole prefix. Give a possible replacement write time
  // to become reusable before the next request. Partial reads are not full
  // colds and do not re-arm recovery; waiting need not improve their coverage.
  if (
    cacheReadTokens < promptTokens * FULL_COLD_READ_FRACTION
    && promptTokens >= guardMinimumPromptTokens(context?.model)
  ) {
    if (state.hitSeen) {
      if (state.rearms >= MAX_GUARD_REARMS) return
      state.rearms++
      state.hitSeen = false
      state.pacedCount = 0
    }
    // Usage arrives at stream end ≈ when the backend queues the write, so
    // pacing from here tracks the real commit window better than the
    // request's start time did (long generations under-waited before).
    state.armedAt = Date.now()
    return
  }

  if (cacheReadTokens <= 0) return
  // A current 3.8 worker can be warm below 70%: 8,166/11,811 measured on an
  // exact duplicate even after 20s. Allow the observed block granularity so
  // an unavoidable partial block does not cause additional pointless holds.
  const qualifyingRead = guardMinimumPromptTokens(context?.model) === GEMINI_38_GUARD_MIN_PROMPT_TOKENS
    ? Math.min(promptTokens * 0.7, Math.max(CACHE_BLOCK_TOKENS - 64, promptTokens - GEMINI_38_UNCACHED_TAIL_ALLOWANCE))
    : promptTokens * 0.7
  if (cacheReadTokens < qualifyingRead) return
  state.hitSeen = true
}

/**
 * TAU_CACHE_DEBUG=1: append an endpoint-routing event (which host served,
 * hops between hosts, signature strips) to <tmpdir>/tau-cache-debug.jsonl so
 * full-cold turns in a session can be joined against the exact routing that
 * produced them instead of inferred from usage numbers alone.
 */
export function writeAntigravityEndpointDebugEvent(
  sessionId: string | undefined,
  event: string,
  detail: Record<string, unknown> = {},
): void {
  if (!process.env.TAU_CACHE_DEBUG) return
  try {
    appendFileSync(
      join(tmpdir(), 'tau-cache-debug.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'endpoint',
        event,
        sessionId,
        ...detail,
      }) + '\n',
    )
  } catch {
    // Diagnostics must never break the request path.
  }
}

// ─── Diagnostics ─────────────────────────────────────────────────

interface DebugSnapshot {
  system: string
  tools: string
  blocks: string[]
  /** Per-block part descriptors (kind, length, hash, head) for forensics. */
  previews?: string[][]
  /**
   * Per-function-declaration hash, keyed by tool name. `tools` above is one
   * hash of the whole block, so a BREAK: tools cannot say WHICH declaration
   * moved. Tool changes can interrupt reuse early in the prompt. This names
   * the declaration involved without predicting the server's cached count.
   */
  toolsByName?: Record<string, string>
}

/**
 * Compare a request's cache-relevant section hashes against the previous
 * request on the SAME session and classify why the implicit prefix cache
 * may stop reusing content. An unchanged committed prefix permits reuse. A
 * changed section identifies where reuse can stop; this diagnostic cannot
 * predict the provider's exact cached-token count or entry availability.
 *
 * Returns a short human-readable verdict:
 *   - 'cold'                       first request on this session
 *   - 'ok: clean prefix extension' history grew append-only — permits reuse
 *   - 'BREAK: systemInstruction'   the cached prefix changes at byte 0
 *   - 'BREAK: tools'               tools block churned
 *   - 'BREAK: history block i/N rewritten'  a non-tail content block
 *                                  changed in place (context-management
 *                                  rewrite, signature churn, injected
 *                                  per-turn block, …) — this is the usual
 *                                  cause of a 0% multi-turn session
 */
export function diagnoseAntigravityCacheBreak(
  prev: DebugSnapshot | undefined,
  cur: DebugSnapshot,
): string {
  if (!prev) return 'cold'
  if (prev.system !== cur.system) return 'BREAK: systemInstruction'
  if (prev.tools !== cur.tools) return 'BREAK: tools'
  const shared = Math.min(prev.blocks.length, cur.blocks.length)
  for (let i = 0; i < shared; i++) {
    if (prev.blocks[i] !== cur.blocks[i]) {
      return `BREAK: history block ${i}/${prev.blocks.length} rewritten`
    }
  }
  // Every shared block matched. If the new request only added blocks at the
  // end (or is identical), the previous committed prefix extends cleanly.
  return cur.blocks.length >= prev.blocks.length
    ? 'ok: clean prefix extension'
    : 'BREAK: history truncated'
}

// Historical diagnostic heuristic only, not a server-enforced minimum.
// Characters cannot reliably establish token counts. Legacy unscoped calls
// retain probe filtering; scoped lane calls can compare small agent requests
// accurately without letting unrelated helpers overwrite their snapshots.
const DEBUG_MIN_CACHEABLE_CHARS = 65_536

const _lastDebugSnapshot = new Map<string, DebugSnapshot>()

/**
 * TAU_CACHE_DEBUG=1 diagnostic: append one JSON line per Antigravity
 * request to <tmpdir>/tau-cache-debug.jsonl with a hash of every
 * cache-relevant section (systemInstruction, tools, generationConfig,
 * each content block) PLUS a `break` verdict comparing this request to
 * the previous one on the same session — so a single multi-turn session
 * names the exact section that breaks the implicit-cache prefix instead
 * of leaving it to be diffed by hand.
 */
export function writeAntigravityCacheDebugEntry(
  model: string,
  request: Record<string, unknown>,
  sessionId: string | undefined,
  context?: AntigravityCacheRequestContext,
): string | undefined {
  try {
    const h = (value: unknown): string =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? 'undefined')
        .digest('hex')
        .slice(0, 12)
    const contents = Array.isArray(request.contents)
      ? (request.contents as unknown[])
      : []
    // Per-part descriptors so a "block rewritten" verdict names WHICH part
    // changed and how (kind, byte length, hash, head) — without them a
    // rewrite deep inside a merged user block is unattributable.
    const partsOf = (value: unknown): string[] => {
      const parts = Array.isArray((value as any)?.parts)
        ? ((value as any).parts as Array<Record<string, any>>)
        : []
      return parts.map(p => {
        if (typeof p.text === 'string') {
          return `text len=${p.text.length} h=${h(p.text)} "${p.text.slice(0, 48).replace(/\s+/g, ' ')}"`
        }
        if (p.functionCall?.name) return `functionCall ${p.functionCall.name} h=${h(p)}`
        if (p.functionResponse?.name) return `functionResponse ${p.functionResponse.name} h=${h(p)}`
        return `part h=${h(p)}`
      })
    }
    // Gemini nests declarations: tools[] -> { functionDeclarations: [...] }.
    // Flatten across entries so a rename/move between groups still resolves
    // to one name -> schema-hash map.
    const toolsByName: Record<string, string> = {}
    for (const entry of Array.isArray(request.tools) ? request.tools : []) {
      const decls = Array.isArray((entry as any)?.functionDeclarations)
        ? ((entry as any).functionDeclarations as Array<Record<string, any>>)
        : []
      for (const decl of decls) {
        const name = typeof decl?.name === 'string' ? decl.name : '<unnamed>'
        toolsByName[name] = h(decl)
      }
    }

    const snapshot: DebugSnapshot = {
      system: h(request.systemInstruction),
      tools: h(request.tools),
      blocks: contents.map(h),
      previews: contents.map(partsOf),
      toolsByName,
    }
    const bytes = JSON.stringify(request).length

    // Non-participants are recorded but never seed the slot (see
    // DEBUG_MIN_CACHEABLE_CHARS).
    if (!context && bytes < DEBUG_MIN_CACHEABLE_CHARS) {
      const verdict = 'n/a: small request (cache eligibility unknown)'
      appendFileSync(
        join(tmpdir(), 'tau-cache-debug.jsonl'),
        JSON.stringify({
          ts: new Date().toISOString(),
          model,
          sessionId,
          break: verdict,
          system: snapshot.system,
          tools: snapshot.tools,
          genCfg: h(request.generationConfig),
          nContents: contents.length,
          nTools: Object.keys(toolsByName).length,
          bytes,
        }) + '\n',
      )
      return verdict
    }

    // Keyed by model too: background side-queries that ARE large enough to
    // cache still run their own system prompt and tools, and different models
    // are different cache entries upstream.
    const key = antigravityCacheScope(sessionId ?? '<no-session>', model, context?.querySource)
    const prev = _lastDebugSnapshot.get(key)
    const verdict = diagnoseAntigravityCacheBreak(prev, snapshot)
    _lastDebugSnapshot.set(key, snapshot)
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      model,
      sessionId,
      querySource: context?.querySource,
      requestId: context?.requestId,
      break: verdict,
      system: snapshot.system,
      tools: snapshot.tools,
      genCfg: h(request.generationConfig),
      nContents: contents.length,
      nTools: Object.keys(toolsByName).length,
      blocks: snapshot.blocks,
      bytes,
    }
    if (verdict === 'BREAK: tools' && prev?.toolsByName) {
      const before = prev.toolsByName
      const after = toolsByName
      const added = Object.keys(after).filter(name => !(name in before))
      const removed = Object.keys(before).filter(name => !(name in after))
      const changed = Object.keys(after).filter(
        name => name in before && before[name] !== after[name],
      )
      entry.toolsDiff = { added, removed, changed, nBefore: Object.keys(before).length, nAfter: Object.keys(after).length }
    }
    if (prev && verdict.startsWith('BREAK')) {
      const shared = Math.min(prev.blocks.length, snapshot.blocks.length)
      for (let i = 0; i < shared; i++) {
        if (prev.blocks[i] !== snapshot.blocks[i]) {
          entry.rewritten = {
            index: i,
            before: prev.previews?.[i] ?? [],
            after: snapshot.previews?.[i] ?? [],
          }
          break
        }
      }
    }
    appendFileSync(
      join(tmpdir(), 'tau-cache-debug.jsonl'),
      JSON.stringify(entry) + '\n',
    )
    return verdict
  } catch {
    // Diagnostics must never break the request path.
    return undefined
  }
}

// ─── Test hooks ──────────────────────────────────────────────────

export function _resetAntigravityCacheStateForTest(): void {
  _agentPace.clear()
  _lastDebugSnapshot.clear()
  _resetSessionVolatileFreezeForTest()
  _commitWindowOverride = undefined
}

export function _setAntigravityCommitWindowForTest(ms: number): void {
  _commitWindowOverride = ms
}

export function _getAntigravityPaceStateForTest(
  sessionId: string,
): { armedAt: number; pacedCount: number; hitSeen: boolean; rearms: number } | undefined {
  return _agentPace.get(sessionId)
}
