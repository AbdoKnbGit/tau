import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { lazySchema } from '../lazySchema.js'
import { jsonStringify } from '../slowOperations.js'

/**
 * Durable half of the provider context-window catalogue.
 *
 * `providerContextWindows` in ./contextWindows.ts is filled only when a
 * catalogue is actually fetched — in practice the /models picker — and it dies
 * with the process. So a fresh session that resumes onto a saved model falls
 * through every static table to MODEL_CONTEXT_WINDOW_DEFAULT, even for models
 * tau already knows the size of, and auto-compact then fires against a window
 * that can be several times too small.
 *
 * This module is the other half: every window tau observes is written here and
 * read back synchronously on the next launch, so a model only has to be seen
 * once — by any provider path, in any session — to stay known.
 *
 * Shape mirrors utils/model/modelCapabilities.ts: a memoized `readFileSync` so
 * the synchronous `getContextWindowForModel` can consult it, plus a coalesced
 * async write that busts the memo. Every path is fail-safe — a missing,
 * corrupt, or unwritable cache degrades to the in-memory behaviour that
 * existed before, never to a thrown error.
 */

const STORE_VERSION = 1

/**
 * Point at which a provider's accumulated keys are replaced by the incoming
 * snapshot rather than merged into it.
 *
 * This bounds growth across refreshes — renamed and retired ids stop piling up
 * — without truncating a provider that genuinely serves a large catalogue.
 * It is deliberately not a hard ceiling: silently dropping real models would
 * put them back on the 200K default, which is the failure this store exists to
 * prevent. Aggregators sit well under it (OpenRouter ~870 keys).
 */
const PROVIDER_KEY_MERGE_LIMIT = 4_000

/** Window in which repeated records collapse into a single disk write. */
const WRITE_DEBOUNCE_MS = 2_000

/**
 * Providers whose context window is a property of the running instance rather
 * than of the model: LM Studio and llama.cpp serve whatever `n_ctx` the loaded
 * instance was started with, and Ollama's `num_ctx` is per-invocation.
 * Persisting one session's value would pin a number the next session
 * contradicts, so these stay session-only — the in-memory map still records
 * them, exactly as before.
 */
const RUNTIME_VARIABLE_PROVIDERS: ReadonlySet<string> = new Set([
  'lmstudio',
  'ollama',
])

const ProviderEntrySchema = lazySchema(() =>
  z.object({
    updatedAt: z.number(),
    models: z.record(z.string(), z.number()),
  }),
)

const StoreSchema = lazySchema(() =>
  z.object({
    version: z.number(),
    providers: z.record(z.string(), ProviderEntrySchema()),
  }),
)

type StoreData = z.infer<ReturnType<typeof StoreSchema>>

function getStorePath(): string {
  return join(
    getClaudeConfigHomeDir(),
    'cache',
    'model-context-windows.json',
  )
}

// Keyed on the store path so tests that set CLAUDE_CONFIG_DIR get a fresh read.
const loadStore = memoize(
  (path: string): StoreData | null => {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- memoized; called from sync getProviderCatalogContextWindow
      const raw = readFileSync(path, 'utf-8')
      const parsed = StoreSchema().safeParse(safeParseJSON(raw, false))
      if (!parsed.success || parsed.data.version !== STORE_VERSION) {
        return null
      }
      return parsed.data
    } catch {
      return null
    }
  },
  path => path,
)

/**
 * First stored window matching any of `candidates` for `provider`.
 *
 * Deliberately provider-scoped with no cross-provider fallback: the same model
 * id is served with different windows by different hosts (the reason
 * PROVIDER_SCOPED_CONTEXT_WINDOWS exists at all), so borrowing another
 * provider's observation would trade one wrong number for another.
 */
export function getStoredContextWindow(
  provider: string,
  candidates: readonly string[],
): number | undefined {
  const store = loadStore(getStorePath())
  const models = store?.providers[provider]?.models
  if (!models) {
    return undefined
  }

  for (const candidate of candidates) {
    const value = models[candidate]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value
    }
  }

  return undefined
}

/**
 * Age of the stored catalogue for `provider`, or undefined when nothing has
 * been recorded for it yet. Drives the startup refresh decision so a warm
 * store costs no network.
 */
export function getStoredCatalogAgeMs(provider: string): number | undefined {
  const entry = loadStore(getStorePath())?.providers[provider]
  if (!entry) {
    return undefined
  }
  const age = Date.now() - entry.updatedAt
  return Number.isFinite(age) && age >= 0 ? age : undefined
}

let pendingSnapshots = new Map<string, Map<string, number>>()
let flushTimer: NodeJS.Timeout | null = null

/**
 * Queue a provider's full window snapshot for persistence.
 *
 * Takes the whole map rather than a delta so the file always mirrors what the
 * in-memory map resolved, and so a burst of records during catalogue load
 * collapses into one write.
 */
export function persistProviderContextWindows(
  provider: string,
  windows: ReadonlyMap<string, number>,
): void {
  if (RUNTIME_VARIABLE_PROVIDERS.has(provider) || windows.size === 0) {
    return
  }

  pendingSnapshots.set(provider, new Map(windows))
  if (flushTimer) {
    return
  }

  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPendingSnapshots()
  }, WRITE_DEBOUNCE_MS)
  // Never hold the process open for a metadata write.
  flushTimer.unref?.()
}

async function flushPendingSnapshots(): Promise<void> {
  const snapshots = pendingSnapshots
  pendingSnapshots = new Map()
  if (snapshots.size === 0) {
    return
  }

  const path = getStorePath()
  try {
    // Re-read past the memo: another session may have written since we loaded,
    // so merge onto what is actually on disk. Two sessions flushing at the same
    // instant can still lose one delta; the next refresh re-adds it, and a
    // missing entry only costs one lookup falling back a tier.
    loadStore.cache.delete(path)
    const current = loadStore(path)
    const providers: StoreData['providers'] = { ...(current?.providers ?? {}) }

    for (const [provider, windows] of snapshots) {
      const merged: Record<string, number> = {
        ...(providers[provider]?.models ?? {}),
      }
      for (const [candidate, contextWindow] of windows) {
        merged[candidate] = contextWindow
      }
      providers[provider] = {
        updatedAt: Date.now(),
        // Over budget, the incoming snapshot is a complete current catalogue,
        // so adopt it wholesale rather than evicting arbitrary older keys.
        models:
          Object.keys(merged).length > PROVIDER_KEY_MERGE_LIMIT
            ? Object.fromEntries(windows)
            : merged,
      }
    }

    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      jsonStringify({ version: STORE_VERSION, providers }),
      { encoding: 'utf-8', mode: 0o600 },
    )
    loadStore.cache.delete(path)
    logForDebugging(
      `[contextWindowStore] persisted ${snapshots.size} provider catalog(s)`,
    )
  } catch (error) {
    logForDebugging(
      `[contextWindowStore] write failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}

/** Test seam: drop the memoized read so the next lookup hits disk. */
export function invalidateContextWindowStoreCache(): void {
  loadStore.cache.delete(getStorePath())
}
