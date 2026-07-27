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
  load()

  const direct = memory.get(keyFor(provider, model))
  if (direct !== undefined) return direct

  // OpenRouter-style suffixes (`:free`, `:nitro`) and provider-prefixed ids
  // describe routing, not modality — fall back to the bare id.
  const bare = model.replace(/:(free|nitro|floor|online|extended)$/i, '')
  if (bare !== model) {
    const stripped = memory.get(keyFor(provider, bare))
    if (stripped !== undefined) return stripped
  }

  // Same model id learned under a different provider (the OpenRouter catalog
  // is the richest source, and gateways resell the same weights).
  const suffix = `::${bare.trim().toLowerCase()}`
  for (const [k, v] of memory) {
    if (k.endsWith(suffix)) return v
  }
  return undefined
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
