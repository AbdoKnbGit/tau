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

type MediaKind = 'image' | 'document'

type Outcome =
  /** OCR succeeded and found text. */
  | { status: 'text'; text: string }
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

async function diskPath(hash: string): Promise<string | null> {
  try {
    const [{ CACHE_PATHS }, { join }] = await Promise.all([
      import('../../utils/cachePaths.js'),
      import('path'),
    ])
    return join(CACHE_PATHS.ocr(), `${hash}.json`)
  } catch {
    return null
  }
}

async function readDisk(hash: string): Promise<Outcome | null> {
  const path = await diskPath(hash)
  if (!path) return null
  try {
    const { readFile } = await import('fs/promises')
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { text?: string }
    if (typeof parsed.text !== 'string') return null
    return parsed.text.length > 0
      ? { status: 'text', text: parsed.text }
      : { status: 'empty' }
  } catch {
    return null
  }
}

async function writeDisk(hash: string, text: string): Promise<void> {
  const path = await diskPath(hash)
  if (!path) return
  try {
    const { mkdir, writeFile } = await import('fs/promises')
    const { dirname } = await import('path')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ v: 1, text }), 'utf8')
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

  for (const target of targets) {
    const cached = await readDisk(target.hash)
    if (cached) {
      resolved.set(target.hash, cached)
      continue
    }

    if (available === null) available = await isMistralOcrAvailable()
    if (!available) {
      resolved.set(target.hash, {
        status: 'unavailable',
        reason: `this model cannot receive ${target.kind} attachments; set MISTRAL_API_KEY to extract their text automatically`,
      })
      continue
    }

    const remaining = pageBudget() - pagesUsed
    if (remaining <= 0) {
      resolved.set(target.hash, {
        status: 'unavailable',
        reason: `this model cannot receive ${target.kind} attachments and the OCR page budget for this session is used up (raise TAU_OCR_PAGE_BUDGET)`,
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
      resolved.set(target.hash, {
        status: 'unavailable',
        reason: `this model cannot receive ${target.kind} attachments and text extraction failed`,
      })
      continue
    }

    pagesUsed += Math.max(1, result.pagesProcessed)
    if (result.markdown.length > 0) {
      resolved.set(target.hash, { status: 'text', text: result.markdown })
    } else {
      resolved.set(target.hash, { status: 'empty' })
    }
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
    case 'empty':
      return describeUnsendableMedia(
        block,
        `this model cannot receive ${target.kind} attachments, and OCR found no text in it`,
      )
    case 'unavailable':
      return describeUnsendableMedia(block, outcome.reason)
  }
}

/** Test hook: wipe memoized outcomes and the page counter. */
export function _resetMediaExtractionForTest(): void {
  resolved.clear()
  pagesUsed = 0
}

/** Test hook: seed an outcome without touching the network. */
export function _seedMediaExtractionForTest(block: unknown, text: string): void {
  const target = toTarget(block)
  if (!target) return
  resolved.set(
    target.hash,
    text.length > 0 ? { status: 'text', text } : { status: 'empty' },
  )
}
