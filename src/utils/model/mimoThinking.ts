/**
 * Xiaomi MiMo per-model reasoning-effort store.
 *
 * Every MiMo chat row exposes the same ladder — low / medium / high on
 * `reasoning_effort` — and MiMo's own default is medium, so unlike relays with
 * per-model ladders there is no "Default / send nothing" stop here: the level
 * always rides the wire.
 *
 * The pick persists to ~/.claude/mimo-thinking.json keyed by model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  isMimoReasoningModel,
  MIMO_DEFAULT_EFFORT,
  MIMO_EFFORT_LEVELS,
  type MimoEffort,
} from './mimoCatalog.js'

export type { MimoEffort }

/** The effort stops a MiMo row cycles through in the picker. */
export function mimoEffortLevelsFor(_model: string): readonly MimoEffort[] {
  return MIMO_EFFORT_LEVELS
}

/** Whether the picker shows an effort chip for this model. */
export function supportsMimoEffortSelection(model: string): boolean {
  return isMimoReasoningModel(model)
}

function storePath(): string {
  return (
    process.env.TAU_MIMO_THINKING_STORE
    || join(homedir(), '.claude', 'mimo-thinking.json')
  )
}

let _loadedPath: string | null = null
let _cache: Record<string, MimoEffort> = {}

function load(): void {
  const path = storePath()
  if (_loadedPath === path) return
  _loadedPath = path
  _cache = {}
  try {
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, MimoEffort> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && (MIMO_EFFORT_LEVELS as readonly string[]).includes(v)) {
          out[k.toLowerCase()] = v as MimoEffort
        }
      }
      _cache = out
    }
  } catch {
    // Stale or corrupt file — treat as empty. The next save() rewrites it.
  }
}

function save(): void {
  const path = storePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(_cache, null, 2), 'utf8')
  } catch {
    // Best-effort; the in-memory pick still drives this session.
  }
}

export function getMimoEffort(model: string): MimoEffort {
  load()
  return _cache[model.trim().toLowerCase()] ?? MIMO_DEFAULT_EFFORT
}

/**
 * Whether the user has actually chosen a level for this model, as opposed to
 * sitting on MiMo's default. Lets the request path tell "the picker says
 * medium" apart from "nobody has expressed a preference", so an explicit pick
 * outranks the caller's implicit thinking budget instead of being silently
 * overwritten by it.
 */
export function hasExplicitMimoEffort(model: string): boolean {
  load()
  return _cache[model.trim().toLowerCase()] !== undefined
}

export function setMimoEffort(model: string, effort: MimoEffort): void {
  load()
  const key = model.trim().toLowerCase()
  if (!MIMO_EFFORT_LEVELS.includes(effort)) return
  // Store every pick, medium included: choosing medium explicitly is a real
  // preference that must outrank the caller's thinking budget, so it cannot
  // be collapsed back into "unset".
  _cache[key] = effort
  save()
}

export function cycleMimoEffort(
  model: string,
  direction: 'left' | 'right',
): MimoEffort {
  const levels = mimoEffortLevelsFor(model)
  const idx = Math.max(0, levels.indexOf(getMimoEffort(model)))
  const len = levels.length
  const next =
    direction === 'right'
      ? levels[(idx + 1) % len]!
      : levels[(idx - 1 + len) % len]!
  setMimoEffort(model, next)
  return next
}

/** The value to put on `reasoning_effort` for this model. */
export function resolveMimoRequestEffort(model: string): MimoEffort {
  return getMimoEffort(model)
}

/** Label rendered in the picker chip. */
export function getMimoEffortLabel(effort: MimoEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/**
 * True for MiMo rows that stream `reasoning_content` and require it echoed
 * back on any replayed assistant tool-call message.
 *
 * MiMo declares this contract for every reasoning row — the reference
 * integration sets both `preserveReasoningContent` and
 * `requireReasoningContentOnAssistantMessages`. Without the carry-back the
 * SECOND tool turn fails, which is exactly the class of bug that bit the LXD
 * provider, so it is wired in from the start here rather than discovered later.
 */
export function mimoReasoningContentReplayRequired(model: string): boolean {
  return isMimoReasoningModel(model)
}

/** Test-only: reset the in-memory store to a known state. */
export function _resetMimoThinkingForTests(
  cache: Record<string, MimoEffort> = {},
): void {
  _loadedPath = storePath()
  _cache = { ...cache }
}
