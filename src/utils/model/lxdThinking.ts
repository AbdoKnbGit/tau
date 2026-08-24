/**
 * LXD API per-model thinking-effort store.
 *
 * Unlike most providers, LXD publishes the effort ladder per model in its
 * own `/v1/models` document (`capabilities.reasoning_efforts`), so there is
 * no ladder hardcoded here -- `lxdEffortLevelsFor` reads it out of
 * `lxdCatalog` and simply prepends the Tau-side "Default" stop (send no
 * `reasoning_effort` field at all and let LXD's own default stand).
 *
 * That means the chip is genuinely different per row, which is what the API
 * describes:
 *
 *   gpt-oss-120b            Default / Low / Medium / High
 *   deepseek-v4-flash-0731  Default / None / High / Max
 *   nemotron-3-ultra        Default / High
 *   llama-4-scout           (no chip -- reasoning_efforts is empty)
 *
 * The pick persists to ~/.claude/lxd-thinking.json keyed by model id, so it
 * survives across sessions. A stored value that is not on the model's current
 * ladder is ignored (the ladder can change under us when LXD re-publishes),
 * which keeps a stale 'medium' from silently riding along on a high-only row.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getLxdModelMeta,
  LXD_ALL_EFFORTS,
  type LxdEffort,
} from './lxdCatalog.js'
// Re-exported so the lane can resolve the replay contract from one place.

export type { LxdEffort }

/**
 * The effort stops a given model cycles through in the picker: "default"
 * followed by whatever LXD published for that row. Returns just ['default']
 * for non-reasoning rows, which callers read as "hide the chip".
 */
export function lxdEffortLevelsFor(model: string): readonly LxdEffort[] {
  const efforts = getLxdModelMeta(model)?.reasoningEfforts ?? []
  return ['default', ...efforts]
}

/** Whether Tau should expose a selectable thinking effort for this model. */
export function supportsLxdEffortSelection(model: string): boolean {
  return lxdEffortLevelsFor(model).length > 1
}

function storePath(): string {
  return (
    process.env.TAU_LXD_THINKING_STORE
    || join(homedir(), '.claude', 'lxd-thinking.json')
  )
}

let _loadedPath: string | null = null
let _cache: Record<string, LxdEffort> = {}

function load(): void {
  const path = storePath()
  if (_loadedPath === path) return
  _loadedPath = path
  _cache = {}
  try {
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, LxdEffort> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && (LXD_ALL_EFFORTS as readonly string[]).includes(v)) {
          out[k.toLowerCase()] = v as LxdEffort
        }
      }
      _cache = out
    }
  } catch {
    // Stale or corrupt file -- treat as empty. The next save() rewrites it.
  }
}

function save(): void {
  const path = storePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(_cache, null, 2), 'utf8')
  } catch {
    // Persistence is best-effort; the in-memory pick still drives this session.
  }
}

export function getLxdEffort(model: string): LxdEffort {
  load()
  const stored = _cache[model.trim().toLowerCase()]
  // Ignore a stored value that is not on this model's current ladder.
  if (stored && lxdEffortLevelsFor(model).includes(stored)) return stored
  return 'default'
}

export function setLxdEffort(model: string, effort: LxdEffort): void {
  load()
  const key = model.trim().toLowerCase()
  // Only persist a level this model actually supports; anything else
  // (including 'default') clears the override.
  const next = lxdEffortLevelsFor(model).includes(effort) ? effort : 'default'
  if (next === 'default') delete _cache[key]
  else _cache[key] = next
  save()
}

export function cycleLxdEffort(
  model: string,
  direction: 'left' | 'right',
): LxdEffort {
  const levels = lxdEffortLevelsFor(model)
  const current = getLxdEffort(model)
  const idx = Math.max(0, levels.indexOf(current))
  const len = levels.length
  const next =
    direction === 'right'
      ? levels[(idx + 1) % len]!
      : levels[(idx - 1 + len) % len]!
  setLxdEffort(model, next)
  return next
}

/**
 * The value to put on the wire, or null when the row should carry no
 * `reasoning_effort` field at all ("Default" -- let LXD decide). 'default' is
 * a Tau-side stop, never a wire value, so it is excluded from the return type.
 */
export function resolveLxdRequestEffort(
  model: string,
): Exclude<LxdEffort, 'default'> | null {
  const effort = getLxdEffort(model)
  return effort === 'default' ? null : effort
}

/** Label rendered in the picker chip. */
export function getLxdEffortLabel(effort: LxdEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/**
 * True for LXD rows whose upstream streams `reasoning_content` and demands it
 * echoed back on any replayed assistant tool-call message. Without the
 * carry-back the next tool turn 400s with "reasoning_content in thinking mode
 * must be passed back to the API" -- the same contract DeepSeek, OpenCode, and
 * Cloudflare rows already have their own branches for.
 *
 * Gated on the model publishing a ladder rather than on the picker's current
 * pick, because LXD turns thinking ON by default for these rows: a bare
 * request to deepseek-v4-pro-0813 bills 113 prompt tokens against 34 with
 * `reasoning_effort: "none"`, i.e. the relay injects a thinking template
 * unless told otherwise. So "Default" still produces reasoning_content and
 * still needs the replay; only an explicit `none` turns it off.
 */
export function lxdReasoningContentReplayRequired(model: string): boolean {
  const efforts = getLxdModelMeta(model)?.reasoningEfforts ?? []
  if (efforts.length === 0) return false
  return getLxdEffort(model) !== 'none'
}

/** Test-only: reset the in-memory store to a known state for the active path. */
export function _resetLxdThinkingForTests(
  cache: Record<string, LxdEffort> = {},
): void {
  _loadedPath = storePath()
  _cache = { ...cache }
}
