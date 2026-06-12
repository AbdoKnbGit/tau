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
 *
 * Escape hatches: TAU_ANTIGRAVITY_NO_PREFIX_PAD=1, TAU_ANTIGRAVITY_NO_PACING=1.
 */

import { createHash } from 'crypto'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
): string {
  if (process.env.TAU_ANTIGRAVITY_NO_PREFIX_PAD === '1') return stableText

  const existingChars = stableText.length + toolDeclarationChars
  const estimatedTokens = Math.floor(existingChars / EXISTING_CHARS_PER_TOKEN)
  const missing = TARGET_TOKENS - estimatedTokens
  if (missing <= 0) return stableText

  const padTokens =
    Math.ceil(missing / PAD_SIZE_STEP_TOKENS) * PAD_SIZE_STEP_TOKENS
  return `${antigravityPrefixPad(padTokens)}\n\n${stableText}`
}

// ─── Commit-window pacing (agent sessions only) ──────────────────
//
// Holding the agent's SECOND request until the first write has had
// time to commit converts the rest of the run into prefix-cache hits.
// If the second request still missed (commit can take up to ~22s), one
// re-arm paces the third request from the second's start; after two
// paced turns we give up so a shape the server refuses to cache can't
// throttle a whole run. A qualifying cache hit latches pacing off.

const ANTIGRAVITY_COMMIT_WINDOW_MS = 15_000
const MAX_PACED_TURNS = 2
const AGENT_SESSION_PREFIX = 'tau-agent-'

interface PaceState {
  /** Start of the most recent un-committed (cold) request. */
  armedAt: number
  pacedCount: number
  hitSeen: boolean
}

let _commitWindowMs = ANTIGRAVITY_COMMIT_WINDOW_MS
const _agentPace = new Map<string, PaceState>()

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
  if (!sessionId || !sessionId.startsWith(AGENT_SESSION_PREFIX)) return

  const now = Date.now()
  const state = _agentPace.get(sessionId)
  if (!state) {
    _agentPace.set(sessionId, { armedAt: now, pacedCount: 0, hitSeen: false })
    _prunePaceMap()
    return
  }
  if (state.hitSeen || state.pacedCount >= MAX_PACED_TURNS) return

  const waitMs = state.armedAt + _commitWindowMs - now
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
): void {
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
  if (!sessionId || cacheReadTokens <= 0 || promptTokens <= 0) return
  if (cacheReadTokens < promptTokens * 0.7) return
  const state = _agentPace.get(sessionId)
  if (state) state.hitSeen = true
}

// ─── Diagnostics ─────────────────────────────────────────────────

interface DebugSnapshot {
  system: string
  tools: string
  blocks: string[]
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
): void {
  try {
    const h = (value: unknown): string =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? 'undefined')
        .digest('hex')
        .slice(0, 12)
    const contents = Array.isArray(request.contents)
      ? (request.contents as unknown[])
      : []
    const snapshot: DebugSnapshot = {
      system: h(request.systemInstruction),
      tools: h(request.tools),
      blocks: contents.map(h),
    }
    const key = sessionId ?? '<no-session>'
    const verdict = diagnoseAntigravityCacheBreak(
      _lastDebugSnapshot.get(key),
      snapshot,
    )
    _lastDebugSnapshot.set(key, snapshot)
    const entry = {
      ts: new Date().toISOString(),
      model,
      sessionId,
      break: verdict,
      system: snapshot.system,
      tools: snapshot.tools,
      genCfg: h(request.generationConfig),
      nContents: contents.length,
      blocks: snapshot.blocks,
      bytes: JSON.stringify(request).length,
    }
    appendFileSync(
      join(tmpdir(), 'tau-cache-debug.jsonl'),
      JSON.stringify(entry) + '\n',
    )
  } catch {
    // Diagnostics must never break the request path.
  }
}

// ─── Test hooks ──────────────────────────────────────────────────

export function _resetAntigravityCacheStateForTest(): void {
  _agentPace.clear()
  _lastDebugSnapshot.clear()
  _commitWindowMs = ANTIGRAVITY_COMMIT_WINDOW_MS
}

export function _setAntigravityCommitWindowForTest(ms: number): void {
  _commitWindowMs = ms
}

export function _getAntigravityPaceStateForTest(
  sessionId: string,
): { armedAt: number; pacedCount: number; hitSeen: boolean } | undefined {
  return _agentPace.get(sessionId)
}
