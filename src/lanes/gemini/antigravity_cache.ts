/**
 * Antigravity implicit-cache discipline (Gemini-family wire models).
 *
 * Measured behavior of the Antigravity prompt cache (probed 2026-06-12
 * against gemini-3.5-flash-low with controlled requests and verified
 * end-to-end with live subagent sessions; cross-checked against the
 * session-independence and content-addressing results in external
 * proxy test suites):
 *
 *   1. The cache is content-addressed on the tokenized prompt prefix
 *      (systemInstruction → tools → contents). Session ids do not key
 *      it — byte-identical prefixes hit regardless of sessionId.
 *   2. Minimum cacheable prompt ≈ 16,384 tokens. Prompts of 7.2k and
 *      12.5k tokens NEVER produce a cache entry; 17.3k+ prompts do.
 *   3. Writes commit asynchronously ~8-22s after the request. A request
 *      arriving before the commit pays full price and is itself written.
 *   4. Within a session, later requests prefix-match earlier committed
 *      entries (reads of 32.6k measured on live agent streams). Across
 *      sessions, only exact-duplicate prompts matched — because sibling
 *      agents' shared prefix (persona + tools) sat below the 16,384
 *      minimum, there was never a committable shared entry.
 *
 * Consequences this module fixes:
 *
 *   - Subagent prompts (persona + tools + task ≈ 10-15k tokens) sit
 *     below the minimum, so agent streams historically cached 0% —
 *     every turn re-paid the full growing prompt. Fresh main-thread
 *     sessions with small system+tools bled the same way for their
 *     first turns.
 *   - Fast agent tool loops (~2s/turn) land inside the commit window,
 *     so even an over-minimum prompt missed on the second call.
 *
 * Fixes, all scoped by the caller to Antigravity Gemini wire models
 * (Claude models resold through Antigravity use a multi-entry
 * content-addressed cache with a much lower minimum — padding or
 * pacing them would only waste tokens and wall-clock):
 *
 *   - applyAntigravityPrefixPad(): prepend deterministic inert text to
 *     the stable system slot whenever (stable system + tool
 *     declarations) is estimated below the minimum, so every request —
 *     main thread and agents alike — clears it from turn 1 and the
 *     second call is a cache hit. Sized from turn-stable inputs only
 *     and memoized per size step, so a given conversation gets
 *     byte-identical padding on every turn, and same-type sibling
 *     agents share an over-minimum prefix.
 *   - paceAntigravityAgentRequest(): hold an agent's second request
 *     until the first write has had time to commit (one re-arm if it
 *     still missed, then give up). Main-thread requests are never
 *     paced — human cadence already clears the window, and stalling
 *     the user is worse than one cold turn.
 *   - writeAntigravityCacheDebugEntry(): TAU_CACHE_DEBUG=1 appends a
 *     JSONL line per request with a hash of every cache-relevant
 *     section, so prefix stability is verifiable instead of guessed.
 *   - freezeAntigravityVolatilePrefix(): preserves the first volatile
 *     environment/git block for a session. The normal Gemini cachedContents
 *     path can place fresh volatile context before the conversation because
 *     it is not part of that cache key. Antigravity's implicit cache hashes
 *     contents too, so changing that leading block rewrites byte 0 of the
 *     content prefix and drops the hit rate.
 *
 * Escape hatches: TAU_ANTIGRAVITY_NO_PREFIX_PAD=1, TAU_ANTIGRAVITY_NO_PACING=1.
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
// prompts stay fast AND the implicit prefix cache still warms NATURALLY: the
// backend content-addresses the whole prompt prefix (systemInstruction →
// tools → contents), so once a session's growing conversation crosses the
// 16,384-token minimum, every later turn hits its own committed prefix with
// no padding at all. Flip TAU_ANTIGRAVITY_MAX_CACHE=1 to force-warm small
// prompts too (at the cost of ~17.4k padding tokens on every turn).
export function antigravityMaxCacheEnabled(): boolean {
  return process.env.TAU_ANTIGRAVITY_MAX_CACHE === '1'
}

// ─── Prefix padding ──────────────────────────────────────────────

// Target prompt size in estimated tokens. Comfortably above the
// measured 16,384 minimum so estimation error can't drop us below it.
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
 * Pad a request's stable system text so the total prompt clears the
 * backend's implicit-cache minimum.
 *
 * Applies to every Antigravity Gemini request whose stable prefix
 * (system text + tool declarations) is estimated below the minimum —
 * main thread and agents alike. Over-minimum prompts are returned
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
// Holding the agent's SECOND request until the first write has had
// time to commit converts the rest of the run into prefix-cache hits.
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
const FULL_COLD_READ_FRACTION = 0.05
const MAX_GUARD_REARMS = 4

interface PaceState {
  /** Start of the most recent un-committed (cold) request. */
  armedAt: number
  pacedCount: number
  hitSeen: boolean
  /** Times the guard was re-armed by an observed mid-session full cold. */
  rearms: number
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
  // Default OFF — see antigravityMaxCacheEnabled(). Without padding, small
  // agent prompts never reach the cache minimum anyway, so stalling them
  // would buy nothing but latency.
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
// maxCache pacing above: no padding, no agent gating, and it never holds a
// prompt too small to cache in the first place.

// Below the ~16,384-token minimum nothing commits, so holding is pure
// latency. 90k chars ÷ 5.5 chars/token ≈ 16.4k tokens.
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
): Promise<void> {
  if (querySource === 'report') return
  if (process.env.TAU_ANTIGRAVITY_NO_PACING === '1') return
  if (!sessionId) return
  if (promptChars < GUARD_MIN_PROMPT_CHARS) return
  const window = _commitWindowOverride !== undefined || process.env.TAU_ANTIGRAVITY_PACING_MS
    ? commitWindowMs()
    : GUARD_COMMIT_WINDOW_MS
  await holdForCommitWindow(sessionId, signal, window)
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
    const timer = setTimeout(resolve, waitMs)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
  // This request is the new cold write — if it also misses, the next
  // turn paces from here.
  state.armedAt = Date.now()
}

/**
 * Fold a stream's usage numbers back into the pacing state. Only a
 * read covering most of the prompt counts: a partial hit (e.g. just a
 * shared pad block matching another session) means this conversation's
 * own prefix is NOT committed yet and pacing must stay armed.
 */
export function recordAntigravityCacheRead(
  sessionId: string | undefined,
  cacheReadTokens: number,
  promptTokens: number,
  querySource?: string,
): void {
  // A bounded report shares Antigravity routing affinity with its live chat,
  // but it is not part of that conversation's prompt-cache lineage. Do not let
  // its cold/read metrics arm, re-arm, or latch the root session's pacing.
  if (querySource === 'report') return
  if (process.env.TAU_CACHE_DEBUG && sessionId && promptTokens > 0) {
    // Usage arrives on many SSE chunks per turn — only log when the
    // (cacheRead, prompt) pair changes so the file has one line per turn.
    const sig = `${sessionId}:${cacheReadTokens}:${promptTokens}`
    if (sig !== _lastUsageSig) {
      _lastUsageSig = sig
      try {
        appendFileSync(
          join(tmpdir(), 'tau-cache-debug.jsonl'),
          JSON.stringify({
            ts: new Date().toISOString(),
            kind: 'usage',
            sessionId,
            cacheRead: cacheReadTokens,
            prompt: promptTokens,
            hitPct: Math.round((cacheReadTokens / promptTokens) * 100),
          }) + '\n',
        )
      } catch {
        // never break the request path
      }
    }
  }
  if (!sessionId || promptTokens <= 0) return

  // Full cold on a committable prompt (reads ~0 while the prompt is over the
  // backend's 16,384-token cache minimum): whatever caused it — endpoint hop,
  // replica miss, TTL expiry, byte churn — this request just re-paid the
  // whole prefix and its write is now in flight. Re-arm the guard so the
  // next request waits out the commit window instead of cascading a second
  // full-price miss. Partial reads (quantum lag) are NOT colds: the entry
  // exists, the next request will read it, so no hold is warranted.
  if (
    cacheReadTokens < promptTokens * FULL_COLD_READ_FRACTION
    && promptTokens >= GUARD_MIN_PROMPT_TOKENS
  ) {
    const state = _agentPace.get(sessionId)
    if (!state) {
      _agentPace.set(sessionId, { armedAt: Date.now(), pacedCount: 0, hitSeen: false, rearms: 0 })
      _prunePaceMap()
      return
    }
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
  if (cacheReadTokens < promptTokens * 0.7) return
  const state = _agentPace.get(sessionId)
  if (state) state.hitSeen = true
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
   * moved — and the tool block sits at the FRONT of the cached prefix, so a
   * single added tool voids the entire conversation cache. This names it.
   */
  toolsByName?: Record<string, string>
}

/**
 * Compare a request's cache-relevant section hashes against the previous
 * request on the SAME session and classify why the implicit prefix cache
 * would (or wouldn't) hit. The implicit cache only serves when the prior
 * committed request is an exact prefix of the new one — any change before
 * the appended tail voids the whole entry (measured: no partial credit).
 *
 * Returns a short human-readable verdict:
 *   - 'cold'                       first request on this session
 *   - 'ok: clean prefix extension' history grew append-only — cache hits
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

// A request this small cannot participate in the implicit cache at all: the
// backend commits nothing under ~16,384 tokens, and 16,384 x 4 chars/token is
// the most optimistic conversion, so anything below this is definitively a
// non-participant. Startup quota probes (~633 bytes), session titles and other
// side-queries land here. They are still LOGGED — seeing the probe fire is
// useful — but they must never seed the snapshot slot, or the next real turn
// diffs against a 2-token ping and reports a BREAK that never happened. The
// model key alone cannot separate them once the small-fast model and the main
// loop model are the same id.
const DEBUG_MIN_CACHEABLE_CHARS = 65_536

const _lastDebugSnapshot = new Map<string, DebugSnapshot>()
let _lastUsageSig = ''

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
    if (bytes < DEBUG_MIN_CACHEABLE_CHARS) {
      const verdict = 'n/a: below cache minimum'
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
    const key = `${sessionId ?? '<no-session>'}::${model}`
    const prev = _lastDebugSnapshot.get(key)
    const verdict = diagnoseAntigravityCacheBreak(prev, snapshot)
    _lastDebugSnapshot.set(key, snapshot)
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      model,
      sessionId,
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
