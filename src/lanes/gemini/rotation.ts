/**
 * Antigravity multi-account rotation for the Gemini lane.
 *
 * Google's Antigravity OAuth pool multiplexes Gemini 3.x Pro / Flash
 * and Claude 4.6 through a single token. Quota is enforced per account
 * and per model family, so a single-account setup wedges on any quota
 * event until the user waits out the daily reset. This module:
 *
 *   1. Maintains a disk-backed account store at
 *      `~/.claudex/antigravity-accounts.json` (shape from
 *      `src/lanes/shared/antigravity_auth.ts:AntigravityStore`).
 *   2. Per model-family (`gemini-pro`, `gemini-flash`, `claude`), tracks
 *      which account is currently active and rotates on rate-limit or
 *      hard-failure events via the shared `HealthScoreTracker`.
 *   3. Applies server-specified cooldowns (Google's `RetryInfo.retryDelay`)
 *      so we don't hammer a just-throttled account.
 *   4. Disables accounts that burn through N consecutive hard failures
 *      (likely the token expired or the account was suspended).
 *
 * NOTE: request routing no longer consults this. `_tokenForModel` in api.ts
 * pins Antigravity to the account the user authenticated, because a
 * health-ranked pick silently changes which Google identity serves a request
 * -- and `pickForFamily` persisted that switch, so requests never came back.
 * What remains live is the bookkeeping: `add` (token refresh), `list`,
 * `recordSuccess` / `recordRateLimit` / `recordHardFailure`, and `health`.
 * The selection methods below have no callers; they are kept as the read side
 * of the health data rather than deleted, but nothing routes through them.
 *
 * Reference: reference/opencode-antigravity-auth-main/src/plugin/rotation.ts
 *            reference/opencode-antigravity-auth-main/src/plugin/accounts.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AntigravityAccount, AntigravityStore } from '../shared/antigravity_auth.js'
import { HealthScoreTracker, type HealthSnapshot } from '../shared/health_score.js'

// ─── Storage ─────────────────────────────────────────────────────

const STORAGE_DIR = join(homedir(), '.claudex')
const STORAGE_FILE = join(STORAGE_DIR, 'antigravity-accounts.json')
const STORAGE_VERSION = 1

const MAX_ACCOUNTS = 10

// ─── Model-family classification ─────────────────────────────────
//
// A model id mapped to which quota bucket it counts against. Each bucket
// has its own active-account index so Pro and Flash don't trample each
// other when Pro hits quota.

export type AntigravityFamily = 'gemini-pro' | 'gemini-flash' | 'claude'

export function familyForAntigravityModel(model: string): AntigravityFamily {
  const m = model.toLowerCase()
  if (m.includes('claude')) return 'claude'
  if (/gemini-\d+(\.\d+)?-pro/.test(m)) return 'gemini-pro'
  return 'gemini-flash'
}

// ─── Rotation manager ────────────────────────────────────────────

export class AntigravityRotation {
  private store: AntigravityStore
  private tracker = new HealthScoreTracker({
    successAlpha: 0.3,
    failureAlpha: 0.5,
    defaultRateLimitMs: 60_000,
    hardFailureDisableAfter: 5,
  })

  constructor() {
    this.store = this.load()
    for (const account of this.store.accounts) {
      this.tracker.register(accountId(account))
      if (!account.enabled) this.tracker.disable(accountId(account))
    }
  }

  // ── Account management ─────────────────────────────────────────

  list(): AntigravityAccount[] {
    return this.store.accounts.slice()
  }

  add(account: AntigravityAccount): { ok: boolean; reason?: string } {
    if (this.store.accounts.length >= MAX_ACCOUNTS) {
      return { ok: false, reason: `max ${MAX_ACCOUNTS} accounts reached` }
    }
    // Overwrite if same email already exists (refreshed token).
    const existingIdx = this.store.accounts.findIndex(a => a.email === account.email)
    if (existingIdx >= 0) {
      this.store.accounts[existingIdx] = {
        ...this.store.accounts[existingIdx]!,
        ...account,
        enabled: true,
      }
    } else {
      this.store.accounts.push(account)
    }
    this.tracker.register(accountId(account))
    this.tracker.reenable(accountId(account))
    this.persist()
    return { ok: true }
  }

  remove(email: string): boolean {
    const idx = this.store.accounts.findIndex(a => a.email === email)
    if (idx < 0) return false
    const removed = this.store.accounts.splice(idx, 1)[0]!
    this.tracker.unregister(accountId(removed))
    // Fix up active indices that referenced or came after the removed one.
    this.store.activeIndex = clampIndex(this.store.activeIndex, this.store.accounts.length)
    for (const k of Object.keys(this.store.activeIndexByFamily) as AntigravityFamily[]) {
      this.store.activeIndexByFamily[k] = clampIndex(
        this.store.activeIndexByFamily[k],
        this.store.accounts.length,
      )
    }
    this.persist()
    return true
  }

  // ── Selection ──────────────────────────────────────────────────

  /**
   * Pick the best account for a given model family.
   *
   * NOT USED FOR ROUTING -- see the module note above. Routing is pinned to
   * the authenticated account. Step 3 below also persists its choice into
   * `activeIndexByFamily`, which is why a rotated-away account never came
   * back; do not reintroduce this into the request path without fixing that.
   *
   * Rotation strategy:
   *   1. Consider only enabled accounts not in cooldown.
   *   2. Prefer the per-family active account if it's healthy.
   *   3. Otherwise fall back to highest-score available.
   *   4. Returns null if every account is disabled or cooling.
   */
  pickForFamily(family: AntigravityFamily): AntigravityAccount | null {
    const eligibleIds = this.store.accounts
      .filter(a => a.enabled)
      .map(accountId)

    // Seed the active-family preference into the tracker by nudging its
    // score up a hair — no, simpler: try active first, only fall back
    // if not eligible.
    const preferredIdx = this.store.activeIndexByFamily[family] ?? this.store.activeIndex
    const preferred = this.store.accounts[preferredIdx]
    if (preferred && preferred.enabled) {
      const snap = this.tracker.snapshot(accountId(preferred))
      if (snap && !snap.disabled && snap.cooldownRemaining <= 0) {
        return preferred
      }
    }

    const pickId = this.tracker.pickBest(eligibleIds)
    if (!pickId) return null
    const picked = this.store.accounts.find(a => accountId(a) === pickId) ?? null
    if (picked) {
      this.store.activeIndexByFamily[family] = this.store.accounts.indexOf(picked)
      this.persist()
    }
    return picked
  }

  /** True when the rotation has at least one enrolled account. */
  hasAccounts(): boolean {
    return this.store.accounts.length > 0
  }

  /** True when at least one account is enabled + not cooling down. */
  hasAvailableAccount(): boolean {
    return this.pickForFamily('gemini-pro') != null
      || this.pickForFamily('gemini-flash') != null
      || this.pickForFamily('claude') != null
  }

  /** Convenience: pick the best account for a model id. */
  pickForModel(model: string): AntigravityAccount | null {
    return this.pickForFamily(familyForAntigravityModel(model))
  }

  /** Look up the next time any eligible account comes out of cooldown. */
  nextRecoveryAt(): number | null {
    const ids = this.store.accounts.filter(a => a.enabled).map(accountId)
    const rec = this.tracker.earliestRecovery(ids)
    return rec ? rec.at : null
  }

  // ── Feedback ──────────────────────────────────────────────────

  recordSuccess(account: AntigravityAccount): void {
    this.tracker.recordSuccess(accountId(account))
    account.lastUsed = Date.now()
    this.persist()
  }

  /**
   * Record a rate-limit hit for a specific family. The cooldown applies
   * at the account level (the account is ineligible for any family until
   * it expires); we also stamp the family-specific reset time on the
   * account for UI / diagnostics.
   */
  recordRateLimit(
    account: AntigravityAccount,
    family: AntigravityFamily,
    cooldownMs?: number,
  ): void {
    this.tracker.recordRateLimit(accountId(account), cooldownMs)
    account.rateLimitResetTimes[family] = cooldownMs ? Date.now() + cooldownMs : null
    this.persist()
  }

  recordHardFailure(account: AntigravityAccount): void {
    this.tracker.recordFailure(accountId(account))
    const snap = this.tracker.snapshot(accountId(account))
    if (snap?.disabled) {
      account.enabled = false
    }
    this.persist()
  }

  /** Re-enable an account after user re-auth or manual enable. */
  reenable(email: string): boolean {
    const a = this.store.accounts.find(x => x.email === email)
    if (!a) return false
    a.enabled = true
    this.tracker.reenable(accountId(a))
    this.persist()
    return true
  }

  // ── Diagnostics ───────────────────────────────────────────────

  health(): HealthSnapshot[] {
    return this.tracker.snapshotAll()
  }

  // ── Persistence ───────────────────────────────────────────────

  private load(): AntigravityStore {
    if (!existsSync(STORAGE_FILE)) {
      return {
        version: STORAGE_VERSION,
        accounts: [],
        activeIndex: 0,
        activeIndexByFamily: {},
      }
    }
    try {
      const raw = readFileSync(STORAGE_FILE, 'utf-8')
      const parsed = JSON.parse(raw) as AntigravityStore
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) {
        throw new Error('malformed')
      }
      return {
        version: parsed.version ?? STORAGE_VERSION,
        accounts: parsed.accounts,
        activeIndex: parsed.activeIndex ?? 0,
        activeIndexByFamily: parsed.activeIndexByFamily ?? {},
      }
    } catch {
      // Corrupt file → start fresh; back up the damaged copy for triage.
      try {
        const bak = STORAGE_FILE + `.bak-${Date.now()}`
        renameSync(STORAGE_FILE, bak)
      } catch {
        // best effort
      }
      return {
        version: STORAGE_VERSION,
        accounts: [],
        activeIndex: 0,
        activeIndexByFamily: {},
      }
    }
  }

  private persist(): void {
    try {
      if (!existsSync(STORAGE_DIR)) {
        mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 })
      }
      const tmp = STORAGE_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 })
      renameSync(tmp, STORAGE_FILE)
      try {
        chmodSync(STORAGE_FILE, 0o600)
      } catch {
        // Windows: chmod is a no-op; ignore.
      }
    } catch {
      // Persistence is best-effort — failing to save is not fatal, the
      // in-memory store still tracks this session. Log-once could go here.
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function accountId(a: AntigravityAccount): string {
  return a.email
}

function clampIndex(i: number | undefined, len: number): number {
  if (len === 0) return 0
  if (i == null) return 0
  if (i < 0) return 0
  if (i >= len) return len - 1
  return i
}

// ─── Singleton ───────────────────────────────────────────────────

let _singleton: AntigravityRotation | null = null

/** Process-wide singleton — lazy so tests can avoid touching disk. */
export function getAntigravityRotation(): AntigravityRotation {
  if (!_singleton) _singleton = new AntigravityRotation()
  return _singleton
}

/** Test helper: reset the singleton so a fresh instance loads from disk. */
export function _resetAntigravityRotationForTest(): void {
  _singleton = null
}
