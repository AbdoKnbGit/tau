/**
 * Session-frozen volatile context, shared by the native lanes.
 *
 * The dynamic system sections (git status, env info, memory, MCP
 * instructions) are recomputed by the app and are only MOSTLY byte-stable
 * across turns — memoized in places, but not guaranteed. The native lanes
 * relocate that block INTO the conversation (a leading user message) so the
 * system message / systemInstruction stays byte-stable; that relocation only
 * pays off if the block itself never changes bytes OR position, because every
 * cache these lanes target is prefix-exact:
 *
 *   - Antigravity Gemini: implicit cache hashes the full prompt stream
 *   - DeepSeek (direct or via OpenRouter): automatic prefix caching
 *   - Gemini API-key / Code Assist: implicit caching hashes contents[] too
 *   - Anthropic via OpenRouter: breakpoint cache anchored on the prefix
 *
 * Freezing the FIRST non-empty value per (lane, model, session) turns the
 * block into a session snapshot — the same semantics Claude Code uses for its
 * own context block ("this status is a snapshot in time, and will not update
 * during the conversation"). Fresh information still reaches the model every
 * turn through the conversation tail (tool results, attachments, the user's
 * message) — never by rewriting an already-sent block.
 */

import type { ProviderMessage } from '../../services/api/providers/base_provider.js'

const _volatileBySession = new Map<string, string>()

/**
 * Return the session's frozen volatile text, pinning `volatileText` as the
 * frozen value the first time a non-empty one is seen. Later (different)
 * values are ignored so the already-cached prefix keeps replaying byte-for-
 * byte. An empty first value pins nothing — a late-arriving volatile block
 * (e.g. MCP instructions that connect after turn 1) is frozen on its first
 * appearance instead, costing exactly one prefix break.
 */
export function freezeSessionVolatileText(
  cacheKey: string,
  volatileText: string,
): string {
  const existing = _volatileBySession.get(cacheKey)
  if (existing !== undefined) return existing
  if (!volatileText) return ''

  _volatileBySession.set(cacheKey, volatileText)
  if (_volatileBySession.size > 256) {
    const oldest = _volatileBySession.keys().next().value
    if (oldest !== undefined) _volatileBySession.delete(oldest)
  }
  return volatileText
}

/**
 * Freeze key: prefer the caller's stable session id; fall back to a hash of
 * the first user message so sessionless callers still freeze per-conversation
 * (the first user message is the one part of history that never changes).
 * The model is part of the key because a mid-session model switch builds a
 * different prompt — its snapshot must not leak across models.
 */
export function volatileFreezeKey(
  lane: string,
  model: string,
  sessionId: string | undefined,
  messages: ProviderMessage[],
): string {
  const session = sessionId?.trim() || hashText(firstUserText(messages))
  return `${lane}:${model.toLowerCase()}:${session}`
}

function firstUserText(messages: ProviderMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    const text = msg.content
      .map(block => (block.type === 'text' ? (block.text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  return ''
}

function hashText(text: string): string {
  let hash = 0
  for (const ch of text) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0
  }
  return String(hash >>> 0)
}

/**
 * Drop every frozen snapshot so the next request re-freezes from the freshly
 * built prompt.
 *
 * Called from `clearSystemPromptSections()` — the one place that says "the
 * system prompt was deliberately rebuilt" (/mode, /team-mode, post-compact
 * cleanup, setup). Without this the freeze outlives the rebuild: `/team-mode`
 * clears the section cache so its orchestrator addendum recomputes, then the
 * lane replays the pre-toggle bytes and the change never reaches the model.
 * The invariant this restores: a frozen block is never staler than the section
 * cache it was derived from.
 *
 * Costs one prefix re-warm, which a genuine prompt change costs anyway.
 */
export function resetSessionVolatileFreeze(): void {
  _volatileBySession.clear()
}

export function _resetSessionVolatileFreezeForTest(): void {
  resetSessionVolatileFreeze()
}
