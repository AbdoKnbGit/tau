/**
 * xAI per-model reasoning-effort store.
 *
 * Each Grok row publishes its own ladder (grok-4.7 and 4.6: low…xhigh,
 * grok-4.5: low…high, grok-4.3: none…high); grok-build-0.1 and
 * grok-4.20-0309-reasoning take none, and the non-reasoning row does not
 * reason. The ladder comes from xaiCatalog.ts — xAI's own /v1/models first —
 * so a level the model has not declared is never sent.
 *
 * `default` means "send no effort": xAI then applies the model's own default
 * (high on 4.5 and later). Picks persist to ~/.claude/xai-thinking.json, keyed
 * by model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { selectInheritedEffort, type EffortFallback } from './effortInheritance.js'
import { normalizeXaiModelId, xaiEffortsFor } from './xaiCatalog.js'

/** The ladder a row cycles through in the picker, xAI's order. */
export function xaiEffortLevelsFor(model: string): readonly string[] {
  return xaiEffortsFor(model)
}

/** Whether the picker and /effort offer a choice for this row. */
export function supportsXaiEffortSelection(model: string): boolean {
  return xaiEffortLevelsFor(model).length > 0
}

function storePath(): string {
  return process.env.TAU_XAI_THINKING_STORE || join(homedir(), '.claude', 'xai-thinking.json')
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
        if (typeof value === 'string') picks[normalizeXaiModelId(model)] = value.toLowerCase()
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
  const pick = picks[normalizeXaiModelId(model)]
  return pick !== undefined && xaiEffortLevelsFor(model).includes(pick) ? pick : undefined
}

export function hasExplicitXaiEffort(model: string): boolean {
  return storedPick(model) !== undefined
}

/**
 * The effort this row runs at: the model's own pick, else the session or
 * settings effort when the ladder has that level, else undefined (xAI's
 * default).
 */
export function getXaiEffort(model: string, fallback?: EffortFallback): string | undefined {
  return storedPick(model) ?? selectInheritedEffort(xaiEffortLevelsFor(model), fallback)
}

export function setXaiEffort(model: string, effort: string): void {
  const level = effort.trim().toLowerCase()
  if (!xaiEffortLevelsFor(model).includes(level)) return
  load()
  picks[normalizeXaiModelId(model)] = level
  save()
}

export function clearXaiEffort(model: string): void {
  load()
  delete picks[normalizeXaiModelId(model)]
  save()
}

/** The value for `reasoning.effort`, or undefined to send none. */
export function resolveXaiRequestEffort(model: string, fallback?: EffortFallback): string | undefined {
  return getXaiEffort(model, fallback)
}

/** Test seam: reset the in-memory store to a known state. */
export function _resetXaiThinkingForTests(seed: Record<string, string> = {}): void {
  loadedPath = storePath()
  picks = Object.fromEntries(Object.entries(seed).map(([model, value]) => [normalizeXaiModelId(model), value]))
}
