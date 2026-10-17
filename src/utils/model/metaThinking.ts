/**
 * Meta (Muse) per-model reasoning-effort store.
 *
 * Muse Wonder and Muse Spark 1.3 take minimal…max; Spark 1.3 Contributor,
 * Spark 1.2 and 1.1 stop at xhigh. No Muse model takes `none` (a 400), so
 * reasoning is always on and the ladder only says how hard. The ladder comes
 * from metaCatalog.ts — models.dev's `reasoning_options` first — so a level
 * the model has not declared is never sent.
 *
 * `default` means "send no effort": Meta then applies the model's own level
 * (high on Spark 1.3). Picks persist to ~/.claude/meta-thinking.json, keyed by
 * model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { selectInheritedEffort, type EffortFallback } from './effortInheritance.js'
import { metaEffortsFor, normalizeMetaModelId } from './metaCatalog.js'

/** The ladder a row cycles through in the picker, Meta's order. */
export function metaEffortLevelsFor(model: string): readonly string[] {
  return metaEffortsFor(model)
}

/** Whether the picker and /effort offer a choice for this row. */
export function supportsMetaEffortSelection(model: string): boolean {
  return metaEffortLevelsFor(model).length > 0
}

function storePath(): string {
  return process.env.TAU_META_THINKING_STORE || join(homedir(), '.claude', 'meta-thinking.json')
}

let loadedPath: string | null = null
let picks: Record<string, string> = {}

function load(): void {
  const path = storePath()
  if (loadedPath === path) return
  loadedPath = path
  picks = {}
  try {
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') picks[normalizeMetaModelId(model)] = value.toLowerCase()
      }
    }
  } catch {
    // Unreadable store: no picks. The next save rewrites it.
  }
}

function save(): void {
  const path = storePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(picks, null, 2), 'utf8')
  } catch {
    // The in-memory pick still drives this session.
  }
}

/** A stored pick, only while the model still declares that level. */
function storedPick(model: string): string | undefined {
  load()
  const pick = picks[normalizeMetaModelId(model)]
  return pick !== undefined && metaEffortLevelsFor(model).includes(pick) ? pick : undefined
}

export function hasExplicitMetaEffort(model: string): boolean {
  return storedPick(model) !== undefined
}

/**
 * The effort this row runs at: the model's own pick, else the session or
 * settings effort when the ladder has that level, else undefined (Meta's
 * default).
 */
export function getMetaEffort(model: string, fallback?: EffortFallback): string | undefined {
  return storedPick(model) ?? selectInheritedEffort(metaEffortLevelsFor(model), fallback)
}

export function setMetaEffort(model: string, effort: string): void {
  const level = effort.trim().toLowerCase()
  if (!metaEffortLevelsFor(model).includes(level)) return
  load()
  picks[normalizeMetaModelId(model)] = level
  save()
}

export function clearMetaEffort(model: string): void {
  load()
  delete picks[normalizeMetaModelId(model)]
  save()
}

/** The value for `reasoning.effort`, or undefined to send none. */
export function resolveMetaRequestEffort(model: string, fallback?: EffortFallback): string | undefined {
  return getMetaEffort(model, fallback)
}

/** Test seam: reset the in-memory store to a known state. */
export function _resetMetaThinkingForTests(seed: Record<string, string> = {}): void {
  loadedPath = storePath()
  picks = Object.fromEntries(Object.entries(seed).map(([model, value]) => [normalizeMetaModelId(model), value]))
}
