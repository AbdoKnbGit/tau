/**
 * Attachment text extraction for lanes that cannot carry media natively.
 *
 * The problem: Devstral, Kimi, DeepSeek, Qwen and most other code models are
 * text-only, so a screenshot or a PDF reaches them as nothing at all. Marking
 * it "not sent" (see media_blocks.ts) at least stops the model inventing a
 * description, but the content is still lost.
 *
 * The fix: run the attachment through Mistral OCR once and feed the text in.
 *
 * Two-layer design, and the split matters:
 *
 *   1. `prefetchMediaText()` is async and runs ONCE per request, before the
 *      lane builds its payload. This is the only place that touches the
 *      network.
 *   2. `renderMediaForTextLane()` is sync, pure, and used inside the message
 *      converters. It only reads what layer 1 already resolved.
 *
 * Doing the OCR call inside the converter instead would put a network call in
 * the hot path of every turn AND make the serialized history non-deterministic,
 * which shifts the prompt-cache prefix and turns every turn into a cache miss.
 * Resolution is memoized by content hash and pinned for the process, so the
 * same attachment always renders the same bytes.
 */

import { createHash } from 'crypto'
import { describeUnsendableMedia, isMediaBlock } from './media_blocks.js'

export type MediaKind = 'image' | 'document'

type Outcome =
  /** OCR succeeded and found text. */
  | { status: 'text'; text: string }
  /** A vision model described the picture, because OCR could not read it. */
  | { status: 'described'; text: string; model: string }
  /** OCR ran and the attachment genuinely has no text in it. */
  | { status: 'empty' }
  /** No key, disabled, over budget, or the call failed. */
  | { status: 'unavailable'; reason: string }

interface MediaTarget {
  hash: string
  kind: MediaKind
  mime: string
  base64: string
}

const DEFAULT_PAGE_BUDGET = 20

/**
 * hash → outcome, for the lifetime of the process.
 *
 * Pinned on purpose: once an attachment has rendered into a prompt, its text
 * must never change, or an already-cached prefix would be rewritten mid
 * conversation. Budget exhaustion and cache eviction therefore only affect
 * attachments that have not been resolved yet.
 */
const resolved = new Map<string, Outcome>()
let pagesUsed = 0

function pageBudget(): number {
  const raw = process.env.TAU_OCR_PAGE_BUDGET
  if (!raw) return DEFAULT_PAGE_BUDGET
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PAGE_BUDGET
}

function toTarget(block: unknown): MediaTarget | null {
  if (!isMediaBlock(block)) return null
  const b = block as {
    type?: string
    source?: { data?: string; media_type?: string; mediaType?: string }
  }
  const data = b.source?.data
  if (typeof data !== 'string' || data.length === 0) return null
  const kind: MediaKind = b.type === 'document' ? 'document' : 'image'
  const mime = b.source?.media_type
    ?? b.source?.mediaType
    ?? (kind === 'document' ? 'application/pdf' : 'image/png')
  return {
    hash: createHash('sha256').update(data).digest('hex'),
    kind,
    mime,
    base64: data,
  }
}

/** Walk messages + nested tool_result content for attachment blocks. */
function collectTargets(messages: readonly unknown[]): MediaTarget[] {
  const out: MediaTarget[] = []
  const seen = new Set<string>()
  const visit = (block: unknown): void => {
    const target = toTarget(block)
    if (target) {
      if (!seen.has(target.hash)) {
        seen.add(target.hash)
        out.push(target)
      }
      return
    }
    const inner = (block as { content?: unknown } | null)?.content
    if (Array.isArray(inner)) for (const child of inner) visit(child)
  }
  for (const msg of messages) {
    const content = (msg as { content?: unknown } | null)?.content
    if (Array.isArray(content)) for (const block of content) visit(block)
  }
  return out
}

// ─── Disk cache (content-addressed, so it can never go stale) ──────

/**
 * `variant` separates what produced the entry. OCR keeps the original bare
 * `<hash>.json` name so caches written before descriptions existed still load,
 * and each describer gets its own file: a description is only reusable for the
 * model that wrote it, and switching models must not keep replaying the old
 * one's words forever.
 */
async function diskPath(hash: string, variant?: string): Promise<string | null> {
  try {
    const [{ CACHE_PATHS }, { join }] = await Promise.all([
      import('../../utils/cachePaths.js'),
      import('path'),
    ])
    const name = variant ? `${hash}.${variant}.json` : `${hash}.json`
    return join(CACHE_PATHS.ocr(), name)
  } catch {
    return null
  }
}

async function readDisk(hash: string, variant?: string): Promise<Outcome | null> {
  const path = await diskPath(hash, variant)
  if (!path) return null
  try {
    const { readFile } = await import('fs/promises')
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { text?: string; model?: string }
    if (typeof parsed.text !== 'string') return null
    if (parsed.text.length === 0) return { status: 'empty' }
    return parsed.model
      ? { status: 'described', text: parsed.text, model: parsed.model }
      : { status: 'text', text: parsed.text }
  } catch {
    return null
  }
}

async function writeDisk(
  hash: string,
  text: string,
  opts?: { variant?: string; model?: string },
): Promise<void> {
  const path = await diskPath(hash, opts?.variant)
  if (!path) return
  try {
    const { mkdir, writeFile } = await import('fs/promises')
    const { dirname } = await import('path')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({ v: 1, text, ...(opts?.model ? { model: opts.model } : {}) }),
      'utf8',
    )
  } catch {
    /* cache writes are best-effort */
  }
}

// ─── Layer 1: async prefetch (the only place that hits the network) ─

export interface PrefetchOptions {
  /**
   * Returns false when the destination will send the image itself, so
   * extracting text would be strictly worse than letting the model look at
   * the pixels.
   *
   * A thunk rather than a boolean because answering it freezes a per-model
   * decision, and that must only happen when an image is actually present:
   * a conversation without attachments should leave the decision open for
   * later catalog data. Documents are always extracted — no lane behind the
   * provider bridge can carry a PDF.
   */
  includeImages: () => boolean
  signal?: AbortSignal
}

export async function prefetchMediaText(
  messages: readonly unknown[],
  opts: PrefetchOptions,
): Promise<void> {
  try {
    await prefetchInner(messages, opts)
  } catch {
    // An attachment must never break a request. Anything unresolved simply
    // renders as the plain marker, which is the pre-extraction behaviour.
  }
}

/**
 * What to tell the model when nothing could read an attachment.
 *
 * A dead end here wastes capability the agent already has. It holds Bash and a
 * REPL, so a PDF it cannot receive as an attachment is still a file sitting on
 * disk that it can parse itself, and it knows the path because it just called
 * Read to get here. Naming an env var the model cannot set, and stopping there,
 * turns a solvable situation into a shrug.
 *
 * Pure function of `kind` and `cause`, so it serializes byte-identically on
 * every replay like the rest of layer 2.
 */
export function unreadableReason(kind: MediaKind, cause: string): string {
  const selfHelp =
    kind === 'document'
      ? 'you can still extract it yourself from the file on disk (pdftotext, or python with pypdf/pdfplumber) via Bash'
      : 'you can pick a describer with /vision-model, or run a local OCR tool via Bash'
  return `this model cannot receive ${kind} attachments and ${cause}; ${selfHelp}`
}

export function shouldTryVisionDescription(
  kind: MediaKind,
  status: Outcome['status'],
): boolean {
  // Documents belong to OCR. No vision API takes a PDF, and a scanned page is
  // words, which is exactly what OCR is for.
  if (kind !== 'image') return false
  // Text that was actually extracted beats prose describing the picture it came
  // from, and a description already in hand needs no second opinion.
  return status === 'empty' || status === 'unavailable'
}

/**
 * Ask a vision model what a picture shows when OCR could not tell us.
 *
 * Images only, and only when there is no text to work with. A PDF belongs to
 * OCR, and text that was actually extracted beats prose describing it. The
 * screenshot of a broken layout is the case this exists for: OCR reads the
 * words in a picture, so a picture whose meaning is not words comes back empty.
 *
 * Any failure returns the original outcome untouched, so the worst case is
 * exactly the behaviour that existed before descriptions.
 */
/**
 * Reentrancy guard, keyed by the image being described.
 *
 * Describing routes the image through the ordinary lane stack so it inherits
 * real auth, base URLs and request shapes. That stack calls prefetchMediaText
 * on its own way out. If the describer's own catalog has no modality data, its
 * `decideImageSupport` comes back false, the describe request looks like an
 * unsendable attachment, and it tries to describe itself forever.
 *
 * Keyed by hash rather than a single boolean on purpose. The recursion is
 * always the same image re-entering, so the hash catches it exactly. A plain
 * flag would also block a *different* image being resolved concurrently, in
 * another request or a subagent sharing this process, and that image would be
 * pinned to a marker for the rest of the session despite a working describer.
 */
const describing = new Set<string>()

async function withVisionFallback(
  target: MediaTarget,
  outcome: Outcome,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  if (!shouldTryVisionDescription(target.kind, outcome.status)) return outcome
  if (describing.has(target.hash)) return outcome

  try {
    const [{ describeImage, resolveVisionModel }, { visionVariantKey }] =
      await Promise.all([
        import('../../services/vision/describeImage.js'),
        import('../../services/vision/visionModels.js'),
      ])

    const choice = resolveVisionModel()
    if (!choice) return outcome

    const variant = visionVariantKey(choice)
    const cached = await readDisk(target.hash, variant)
    if (cached) return cached

    describing.add(target.hash)
    let described
    try {
      described = await describeImage({
        mime: target.mime,
        base64: target.base64,
        signal,
      })
    } finally {
      describing.delete(target.hash)
    }

    if (!described) {
      // A describer was configured and still produced nothing. Say that,
      // instead of leaving the generic "OCR found no text" marker: it is the
      // difference between "nothing could read this" and "the thing you set up
      // to read this is broken", and only the second one is actionable.
      return {
        status: 'unavailable',
        reason: unreadableReason(
          target.kind,
          `${choice.provider}/${choice.model} could not describe it ` +
            '(run with TAU_VISION_DEBUG=1 to see why)',
        ),
      }
    }

    await writeDisk(target.hash, described.text, {
      variant,
      model: described.model,
    })
    return { status: 'described', text: described.text, model: described.model }
  } catch {
    // Describing is an enhancement. It must never turn into a failed request.
    return outcome
  }
}

async function prefetchInner(
  messages: readonly unknown[],
  opts: PrefetchOptions,
): Promise<void> {
  const unresolved = collectTargets(messages).filter(t => !resolved.has(t.hash))
  if (unresolved.length === 0) return
  // Ask about image support only when there is an unresolved image to decide
  // about; see PrefetchOptions.includeImages.
  const includeImages = unresolved.some(t => t.kind === 'image')
    ? opts.includeImages()
    : false
  const targets = unresolved.filter(t => t.kind === 'document' || includeImages)
  if (targets.length === 0) return

  const { isMistralOcrAvailable, runMistralOcr } = await import(
    '../../services/mistral/ocr.js'
  )

  let available: boolean | null = null

  /**
   * Pin an outcome for `target`, giving a vision model the last word when OCR
   * came up with nothing.
   *
   * Every path below pins something, including the failures. Leaving a hash
   * unresolved is the one genuinely dangerous option: layer 2 would render a
   * marker this turn, a later turn could resolve it for real, and a block that
   * was already sent would come back with different bytes, rewriting a prefix
   * the provider has already cached.
   */
  const pin = async (target: MediaTarget, outcome: Outcome): Promise<void> => {
    resolved.set(
      target.hash,
      await withVisionFallback(target, outcome, opts.signal),
    )
  }

  for (const target of targets) {
    const cached = await readDisk(target.hash)
    if (cached) {
      // Still offered to vision: a cached `empty` means OCR found no words in
      // this picture, which is exactly when a description is worth having.
      await pin(target, cached)
      continue
    }

    if (available === null) available = await isMistralOcrAvailable()
    if (!available) {
      await pin(target, {
        status: 'unavailable',
        reason: unreadableReason(
          target.kind,
          'no text extractor is configured (set MISTRAL_API_KEY for automatic extraction)',
        ),
      })
      continue
    }

    const remaining = pageBudget() - pagesUsed
    if (remaining <= 0) {
      await pin(target, {
        status: 'unavailable',
        reason: unreadableReason(
          target.kind,
          'the OCR page budget for this session is used up (raise TAU_OCR_PAGE_BUDGET)',
        ),
      })
      continue
    }

    const result = await runMistralOcr({
      kind: target.kind,
      mime: target.mime,
      base64: target.base64,
      maxPages: remaining,
      signal: opts.signal,
    })

    if (!result) {
      await pin(target, {
        status: 'unavailable',
        reason: unreadableReason(target.kind, 'text extraction failed'),
      })
      continue
    }

    pagesUsed += Math.max(1, result.pagesProcessed)
    await pin(
      target,
      result.markdown.length > 0
        ? { status: 'text', text: result.markdown }
        : { status: 'empty' },
    )
    await writeDisk(target.hash, result.markdown)
  }
}

// ─── Layer 2: sync render, used inside message converters ──────────

/**
 * What a text-only lane should put in the prompt for an attachment block.
 * Pure: no network, no clock, no config read that can change mid-session.
 */
export function renderMediaForTextLane(block: unknown): string {
  const target = toTarget(block)
  if (!target) return describeUnsendableMedia(block)

  const outcome = resolved.get(target.hash)
  if (!outcome) return describeUnsendableMedia(block)

  switch (outcome.status) {
    case 'text':
      return `[${target.kind} content, extracted with OCR because this model cannot receive ${target.kind} attachments]\n${outcome.text}`
    case 'described':
      // Attribution is not decoration: a description is one model's reading of
      // a picture, and the model consuming it should weigh it accordingly.
      return `[${target.kind} description from ${outcome.model}, because this model cannot receive ${target.kind} attachments and OCR found no text in it]\n${outcome.text}`
    case 'empty':
      return describeUnsendableMedia(
        block,
        `this model cannot receive ${target.kind} attachments, and OCR found no text in it`,
      )
    case 'unavailable':
      return describeUnsendableMedia(block, outcome.reason)
  }
}

/**
 * Replace attachment blocks with their text rendering throughout a message list.
 *
 * For lanes that CAN carry an image over the wire but are routing it to a model
 * that cannot read one. Cline and KiloCode are routers: they accept an
 * `image_url` part at the transport layer and hand it to whichever upstream
 * model is selected, so "the lane carries pixels" says nothing about whether
 * the model can see them. Sending anyway fails two ways, and the quiet one is
 * worse:
 *
 *   - KiloCode surfaces it: `404 No endpoints found that support image input`.
 *   - Cline swallows it, the model receives a request with no image and no
 *     marker, and answers about a picture it never saw. That is a fabricated
 *     description delivered with full confidence.
 *
 * Substituting the marker turns the second case into the first: the model is
 * told an attachment exists and did not arrive, so it says so.
 *
 * Pure and non-mutating. Messages without attachments are returned by identity,
 * so a conversation that never had one is not rewritten and cannot shift a
 * cached prefix.
 */
export function substituteUnsendableMedia<T>(messages: readonly T[]): T[] {
  let changed = false

  const mapped = messages.map(msg => {
    const content = (msg as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) return msg

    let msgChanged = false
    const blocks = content.map(block => {
      if (!isMediaBlock(block)) {
        // Attachments also ride inside tool_result content.
        const inner = (block as { content?: unknown } | null)?.content
        if (!Array.isArray(inner)) return block
        let innerChanged = false
        const innerBlocks = inner.map(child => {
          if (!isMediaBlock(child)) return child
          innerChanged = true
          return { type: 'text', text: renderMediaForTextLane(child) }
        })
        if (!innerChanged) return block
        msgChanged = true
        return { ...(block as object), content: innerBlocks }
      }
      msgChanged = true
      return { type: 'text', text: renderMediaForTextLane(block) }
    })

    if (!msgChanged) return msg
    changed = true
    return { ...(msg as object), content: blocks } as T
  })

  return changed ? mapped : (messages as T[])
}

/** Test hook: wipe memoized outcomes and the page counter. */
export function _resetMediaExtractionForTest(): void {
  resolved.clear()
  pagesUsed = 0
}

/** Test hook: seed an outcome without touching the network. */
export function _seedMediaExtractionForTest(
  block: unknown,
  text: string,
  opts?: { model?: string; reason?: string },
): void {
  const target = toTarget(block)
  if (!target) return
  const outcome: Outcome = opts?.reason
    ? { status: 'unavailable', reason: opts.reason }
    : opts?.model
      ? { status: 'described', text, model: opts.model }
      : text.length > 0
        ? { status: 'text', text }
        : { status: 'empty' }
  resolved.set(target.hash, outcome)
}
