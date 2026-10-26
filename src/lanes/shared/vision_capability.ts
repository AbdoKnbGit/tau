/**
 * What we KNOW about a model's image support, per (provider, model).
 *
 * Deliberately not a hardcoded list. "openai-compat" is a transport, not a
 * capability: Kimi, Qwen-VL, GPT-4o, Gemini and Llama-4 all speak it, and some
 * of them see images perfectly well. Treating the whole lane as blind is as
 * wrong as assuming every model can see.
 *
 * Three states, and the third one matters:
 *
 *   true      the provider told us the model takes image input
 *   false     the provider told us it does not
 *   undefined we have not been told
 *
 * Only `true` unlocks sending pixels. `false` and `undefined` fall back to
 * text (OCR extract, else a marker), which every provider on earth accepts.
 * So a wrong guess can never break a request — the worst case is a slightly
 * weaker answer, never a 400.
 *
 * Evidence comes from the same catalogs the /models picker already fetches:
 * OpenRouter's `architecture.input_modalities`, the generic compat
 * `supports_vision` / `capabilities.vision` fields, LM Studio's
 * `capabilities.vision`, and so on. Findings persist to disk so a model you
 * picked yesterday is still known today.
 */

import { getMistralModelMeta } from '../../utils/model/mistralCatalog.js'

const memory = new Map<string, boolean>()
let loaded = false
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function keyFor(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}::${model.trim().toLowerCase()}`
}

function storePath(): string | null {
  try {
    // Required lazily: this module is imported by sync converter paths and
    // must not drag config/env machinery into them at load time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CACHE_PATHS } = require('../../utils/cachePaths.js') as {
      CACHE_PATHS: { visionCapability: () => string }
    }
    return CACHE_PATHS.visionCapability()
  } catch {
    return null
  }
}

function load(): void {
  if (loaded) return
  loaded = true
  const path = storePath()
  if (!path) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs') as typeof import('fs')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      models?: Record<string, boolean>
    }
    for (const [k, v] of Object.entries(parsed.models ?? {})) {
      if (typeof v === 'boolean') memory.set(k, v)
    }
  } catch {
    /* first run, or an unreadable cache — start empty */
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (!dirty) return
    dirty = false
    const path = storePath()
    if (!path) return
    void (async () => {
      try {
        const { mkdir, writeFile } = await import('fs/promises')
        const { dirname } = await import('path')
        await mkdir(dirname(path), { recursive: true })
        await writeFile(
          path,
          JSON.stringify({ v: 1, models: Object.fromEntries(memory) }),
          'utf8',
        )
      } catch {
        /* best effort */
      }
    })()
  }, 2_000)
  // Never hold the process open for a cache write.
  flushTimer.unref?.()
}

/** Record what a provider catalog told us. Later evidence wins. */
export function recordModelVision(
  provider: string | undefined,
  model: string | undefined,
  capable: boolean,
): void {
  if (!provider || !model) return
  load()
  const key = keyFor(provider, model)
  if (memory.get(key) === capable) return
  memory.set(key, capable)
  dirty = true
  scheduleFlush()
}

/**
 * `true` only when a provider positively said so. Sync and cheap: the caller
 * is a message converter on the hot path.
 */
export function modelAcceptsImages(
  provider: string | undefined,
  model: string | undefined,
): boolean | undefined {
  if (!provider || !model) return undefined
  // Available before /models is opened; don't freeze a known vision model as
  // text-only on its first attachment because the runtime catalog is cold.
  if (provider === 'mistral') {
    const meta = getMistralModelMeta(model)
    if (meta) return meta.vision
  }
  load()

  const direct = memory.get(keyFor(provider, model))
  if (direct !== undefined) return direct

  // OpenRouter-style suffixes (`:free`, `:nitro`), Tau's own `::` variant
  // markers (Cline's `::cline-effort=high`) and provider-prefixed ids describe
  // routing, not modality — fall back to the bare id.
  const bare = model.split('::')[0]!.replace(/:(free|nitro|floor|online|extended)$/i, '')
  if (bare !== model) {
    const stripped = memory.get(keyFor(provider, bare))
    if (stripped !== undefined) return stripped
  }

  // The provider's own catalog, before any other provider's word for it. It
  // is known before /models is ever opened, so a model the catalog calls
  // vision-capable is never frozen as text-only on its first attachment.
  // The full id first: on some hosts a suffix is part of the real id
  // (Command Code's `inclusionai/ling-3.1-flash:free` is text only).
  const fromCatalog = catalogImageInput(provider, model)
    ?? (bare !== model ? catalogImageInput(provider, bare) : undefined)
  if (fromCatalog !== undefined) return fromCatalog

  // Same model id learned under a different provider (the OpenRouter catalog
  // is the richest source, and gateways resell the same weights). A vendor
  // prefix is routing too, so `xiaomi/mimo-v2.6-pro` answers for
  // `mimo-v2.6-pro`, though only when no id matches exactly. Providers that
  // disagree are no answer, whatever order they were recorded in: one may
  // serve a text-only build of a vision model.
  const id = bare.trim().toLowerCase()
  const leaf = leafOf(id)
  let exact: boolean | null | undefined
  let sameLeaf: boolean | null | undefined
  for (const [k, v] of memory) {
    const known = k.slice(k.indexOf('::') + 2)
    if (known === id) exact = agree(exact, v)
    else if (leafOf(known) === leaf) sameLeaf = agree(sameLeaf, v)
  }
  return (exact !== undefined ? exact : sameLeaf) ?? undefined
}

/** Fold one more answer in: kept while they agree, null once they do not. */
function agree(seen: boolean | null | undefined, value: boolean): boolean | null {
  return seen === undefined || seen === value ? value : null
}

function leafOf(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1)
}

function catalogImageInput(provider: string, model: string): boolean | undefined {
  try {
    // Required lazily, like storePath: the catalogs read files and config
    // that this sync converter path must not load at import time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const catalogs = require('../../utils/model/catalogVision.js') as typeof import('../../utils/model/catalogVision.js')
    return catalogs.catalogImageInput(provider, model)
  } catch {
    return undefined
  }
}

/**
 * Frozen per-process answers, taken the first time a conversation actually
 * carries an attachment.
 *
 * Why freeze at all: catalogs load lazily (opening `/models` fetches them),
 * so `modelAcceptsImages` can flip from undefined to true *mid conversation*.
 * If that happened, turn N would render a screenshot as OCR text and turn N+1
 * would render the SAME message as an image part. Rewriting an already-sent
 * message invalidates the whole cached prefix and re-bills the conversation.
 *
 * Freezing costs at most a weaker rendering until the next session, and buys
 * a prefix that cannot move under a live conversation. Same discipline as
 * volatile_freeze.ts.
 */
const decided = new Map<string, boolean>()

/**
 * The answer used for wire-format decisions. Call this only when an
 * attachment is actually present, so a session with no images never freezes
 * anything and always picks up freshly loaded catalog data.
 */
export function decideImageSupport(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  const key = keyFor(provider ?? '', model ?? '')
  const existing = decided.get(key)
  if (existing !== undefined) return existing
  const answer = modelAcceptsImages(provider, model) === true
  decided.set(key, answer)
  return answer
}

/** How long a model's first image decision may wait for the models.dev table. */
const IMAGE_DECISION_WAIT_MS = 6_000

/**
 * Give the models.dev table a bounded chance to arrive before a model's first
 * image decision, which is frozen once made. On a fresh install the table is
 * not there yet, and deciding without it would leave every model nothing else
 * describes on text for the whole session.
 *
 * A no-op once the model is decided or already known, and for a request that
 * carries no image.
 */
export async function prepareImageSupport(
  provider: string | undefined,
  model: string | undefined,
  messages: readonly unknown[],
  signal?: AbortSignal,
): Promise<void> {
  if (!provider || !model || decided.has(keyFor(provider, model))) return
  if (!messages.some(carriesImage)) return
  if (modelAcceptsImages(provider, model) !== undefined) return
  try {
    const { awaitModelPricesFresh } = await import('../../utils/modelPricingCatalog.js')
    await awaitModelPricesFresh(IMAGE_DECISION_WAIT_MS, signal)
  } catch {
    // The decision goes ahead with what is known, as before.
  }
}

function carriesImage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if ((value as { type?: unknown }).type === 'image') return true
  const content = (value as { content?: unknown }).content
  return Array.isArray(content) && content.some(carriesImage)
}

/** Test hook. */
export function _resetVisionCapabilityForTest(): void {
  memory.clear()
  decided.clear()
  loaded = true
  dirty = false
}

/** Test hook: assert a capability without touching disk. */
export function _seedVisionCapabilityForTest(
  provider: string,
  model: string,
  capable: boolean,
): void {
  loaded = true
  decided.delete(keyFor(provider, model))
  memory.set(keyFor(provider, model), capable)
}
