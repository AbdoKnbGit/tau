/**
 * Mistral Document AI (OCR) client.
 *
 * One endpoint, one job: turn an image or a PDF into markdown text so a
 * model that cannot receive attachments still gets their content.
 *
 *   POST {base}/ocr
 *   { model, document: { type: "image_url" | "document_url", ... },
 *     include_image_base64: false, pages? }
 *   → { pages: [{ index, markdown, ... }], usage_info: { pages_processed } }
 *
 * Billing is per page, not per token (~$0.004/page on the hosted API), which
 * is why the caller keeps a page budget rather than a token budget.
 *
 * Everything here is best-effort: any failure returns null and the caller
 * falls back to a plain marker. An attachment must never break a request.
 *
 * Self-hosting: point MISTRAL_OCR_BASE_URL at a local OCR container to keep
 * documents off the network entirely.
 */

const DEFAULT_MODEL = 'mistral-ocr-latest'
const IMAGE_TIMEOUT_MS = 45_000
const DOCUMENT_TIMEOUT_MS = 180_000

export interface MistralOcrResult {
  /** Concatenated page markdown. May be empty when the input has no text. */
  markdown: string
  pagesProcessed: number
}

export interface MistralOcrRequest {
  kind: 'image' | 'document'
  mime: string
  base64: string
  /** Hard cap on pages to process, used to honour the caller's budget. */
  maxPages?: number
  signal?: AbortSignal
}

function debug(message: string): void {
  if (process.env.DEBUG || process.env.TAU_OCR_DEBUG) {
    // eslint-disable-next-line no-console
    console.error(`[mistral-ocr] ${message}`)
  }
}

/** Resolved lazily so the sync converter path never pulls in auth/config. */
async function resolveCredentials(): Promise<{ apiKey: string; baseUrl: string } | null> {
  try {
    const auth = await import('../../utils/auth.js')
    const apiKey = auth.getProviderRuntimeApiKey('mistral' as never)
    if (!apiKey) return null
    const baseUrl = (
      process.env.MISTRAL_OCR_BASE_URL
      || auth.getProviderBaseUrl('mistral' as never)
      || 'https://api.mistral.ai/v1'
    ).replace(/\/+$/, '')
    return { apiKey, baseUrl }
  } catch (e) {
    debug(`credential lookup failed: ${String(e)}`)
    return null
  }
}

export async function isMistralOcrAvailable(): Promise<boolean> {
  if (process.env.TAU_OCR_DISABLED === '1') return false
  return (await resolveCredentials()) !== null
}

export async function runMistralOcr(
  req: MistralOcrRequest,
): Promise<MistralOcrResult | null> {
  if (process.env.TAU_OCR_DISABLED === '1') return null
  const creds = await resolveCredentials()
  if (!creds) return null

  const dataUrl = `data:${req.mime};base64,${req.base64}`
  const document = req.kind === 'image'
    ? { type: 'image_url', image_url: dataUrl }
    : { type: 'document_url', document_url: dataUrl }

  const body: Record<string, unknown> = {
    model: process.env.TAU_MISTRAL_OCR_MODEL || DEFAULT_MODEL,
    document,
    // Returning cropped images would balloon the cache for no benefit here:
    // the point is the text, and a text-only model cannot use the crops.
    include_image_base64: false,
  }
  // Page indices are 0-based. Only meaningful for multi-page documents.
  if (req.kind === 'document' && req.maxPages && req.maxPages > 0) {
    body.pages = req.maxPages === 1 ? '0' : `0-${req.maxPages - 1}`
  }

  const timeoutMs = req.kind === 'image' ? IMAGE_TIMEOUT_MS : DOCUMENT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onCallerAbort = () => controller.abort()
  req.signal?.addEventListener('abort', onCallerAbort, { once: true })

  try {
    const response = await fetch(`${creds.baseUrl}/ocr`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      debug(`HTTP ${response.status} ${await response.text().catch(() => '')}`)
      return null
    }

    const json = (await response.json()) as {
      pages?: Array<{ markdown?: string }>
      usage_info?: { pages_processed?: number }
    }
    const markdown = (json.pages ?? [])
      .map(p => (typeof p.markdown === 'string' ? p.markdown : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim()
    const pagesProcessed = json.usage_info?.pages_processed
      ?? json.pages?.length
      ?? 1
    return { markdown, pagesProcessed }
  } catch (e) {
    debug(`request failed: ${String(e)}`)
    return null
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onCallerAbort)
  }
}
