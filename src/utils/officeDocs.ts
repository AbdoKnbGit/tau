/**
 * Office document reading via Firecrawl's /v2/parse endpoint.
 *
 * tau reads PDFs natively (utils/pdf.ts) and plain text directly, but Word,
 * Excel and OpenDocument files are binary containers and this codebase ships
 * no local parser for them. Before this module FileReadTool rejected them with
 * "use appropriate tools for binary file analysis" - advice that pointed at
 * nothing, since no such tool exists in the install.
 *
 * /v2/parse converts them to markdown and is reachable on Firecrawl's keyless
 * free tier, so this works with no API key configured. A key is used when one
 * is available (higher rate limit). The cloud only grants keyless access when
 * NO Authorization header is sent, so the header is omitted entirely rather
 * than sent empty - see the note in WebSearchTool/firecrawl.ts about the
 * always-authenticated search/scrape helpers, which is why none of them are
 * reused here.
 *
 * Deliberately NOT handled:
 *   .pdf         read natively with page ranges and vision, and never leaves
 *                the machine. Routing it here would be a regression.
 *   .html/.htm   already plain text.
 *   .pptx .ppt   /v2/parse does not accept them either, so the gap remains.
 *   .ods .odp
 */

import { readFile, stat } from 'fs/promises'
import { basename, extname } from 'path'
import { createCombinedAbortSignal } from './combinedAbortSignal.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getFirecrawlApiKey,
  getFirecrawlApiUrl,
} from '../tools/WebSearchTool/firecrawl.js'

/**
 * Extensions routed to /v2/parse. Every one of these is in BINARY_EXTENSIONS
 * (constants/files.ts) and was unreadable before this module existed, so
 * nothing here overlaps with an existing read path.
 */
const OFFICE_CONTENT_TYPES: Record<string, string> = {
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.odt': 'application/vnd.oasis.opendocument.text',
}

export const OFFICE_DOC_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(OFFICE_CONTENT_TYPES),
)

/** Upload ceiling. Parse is a network round-trip; huge files are a bad trade. */
const MAX_OFFICE_DOC_BYTES = 20 * 1024 * 1024

/** Conversion of a large document is slow; well above the 30s search timeout. */
const OFFICE_PARSE_TIMEOUT_MS = 90_000

export const OFFICE_PARSE_DISABLE_ENV = 'TAU_DISABLE_OFFICE_PARSE'

/** Shared wording so the tool-level and parse-level refusals stay in sync. */
export function officeParseDisabledMessage(ext: string): string {
  return (
    `Reading ${ext} files requires converting them with Firecrawl, which is disabled by ${OFFICE_PARSE_DISABLE_ENV}. ` +
    `Unset that variable to enable it, or convert the file locally first.`
  )
}

/**
 * Accepts an extension with or without the leading dot. FileReadTool.call
 * strips it (`extname(...).slice(1)`) while validateInput and attachments.ts
 * keep it, and both call sites land here.
 */
export function isOfficeDocExtension(ext: string): boolean {
  if (!ext) return false
  const normalized = ext.startsWith('.') ? ext : `.${ext}`
  return OFFICE_DOC_EXTENSIONS.has(normalized.toLowerCase())
}

export function isOfficeDocPath(filePath: string): boolean {
  return isOfficeDocExtension(extname(filePath).toLowerCase())
}

/** Kill switch for anyone who does not want documents leaving the machine. */
export function isOfficeParseEnabled(): boolean {
  return !isEnvTruthy(process.env[OFFICE_PARSE_DISABLE_ENV])
}

/**
 * Session-scoped record of the user having approved uploading documents for
 * conversion. FileReadTool.checkPermissions asks on the first office read and
 * stops asking once a parse has actually completed - which can only happen
 * after the prompt was approved. A denial never sets this, so the next read
 * asks again.
 */
let officeUploadApproved = false

export function hasApprovedOfficeUpload(): boolean {
  return officeUploadApproved
}

export function markOfficeUploadApproved(): void {
  officeUploadApproved = true
}

/** Test seam: reset the session approval and the parse cache. */
export function resetOfficeDocStateForTesting(): void {
  officeUploadApproved = false
  parseCache.clear()
}

export type ParsedOfficeDocument = {
  markdown: string
  /** Set when Firecrawl reports a partial conversion. */
  warning?: string
  /** True when served from cache, so the caller can skip re-announcing egress. */
  cached: boolean
}

/**
 * Parsed results keyed by identity-on-disk. Office reads intentionally do not
 * populate readFileState (see FileReadTool), so the normal Read dedup never
 * fires for them - without this cache, re-reading the same document would
 * re-upload it and spend another credit.
 */
const parseCache = new Map<string, { markdown: string; warning?: string }>()

function cacheKey(filePath: string, mtimeMs: number, size: number): string {
  return `${filePath}:${Math.floor(mtimeMs)}:${size}`
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const detail = record.error ?? record.message
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
  }
  return fallback
}

/**
 * Convert an office document to markdown. Throws with an actionable message on
 * any failure - the caller surfaces it to the model as a normal tool error.
 */
export async function parseOfficeDocument(
  filePath: string,
  signal?: AbortSignal,
): Promise<ParsedOfficeDocument> {
  const ext = extname(filePath).toLowerCase()
  const contentType = OFFICE_CONTENT_TYPES[ext]
  if (!contentType) {
    throw new Error(`Unsupported office document type: ${ext || '(none)'}`)
  }

  if (!isOfficeParseEnabled()) {
    throw new Error(officeParseDisabledMessage(ext))
  }

  const stats = await stat(filePath)
  if (stats.size > MAX_OFFICE_DOC_BYTES) {
    throw new Error(
      `Document is ${Math.round(stats.size / 1024 / 1024)}MB, over the ${MAX_OFFICE_DOC_BYTES / 1024 / 1024}MB conversion limit. ` +
        `Export the portion you need to a smaller file.`,
    )
  }

  const key = cacheKey(filePath, stats.mtimeMs, stats.size)
  const cached = parseCache.get(key)
  if (cached) {
    return { ...cached, cached: true }
  }

  const bytes = await readFile(filePath)
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: contentType }),
    basename(filePath),
  )
  // Minimal options payload: /v2/parse rejects unrecognized top-level keys,
  // and markdown is the only format the model needs.
  form.append('options', JSON.stringify({ formats: ['markdown'] }))

  // Keyless free tier requires the header to be ABSENT, not empty.
  const apiKey = getFirecrawlApiKey()
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const combined = createCombinedAbortSignal(signal, {
    timeoutMs: OFFICE_PARSE_TIMEOUT_MS,
  })

  try {
    const response = await fetch(`${getFirecrawlApiUrl()}/v2/parse`, {
      method: 'POST',
      headers,
      body: form,
      signal: combined.signal,
    })

    const payload = (await response.json().catch(() => null)) as {
      success?: boolean
      data?: { markdown?: unknown; warning?: unknown }
    } | null

    if (!response.ok || payload?.success === false) {
      throw new Error(
        extractErrorMessage(
          payload,
          `${response.status} ${response.statusText}`.trim(),
        ),
      )
    }

    const markdown = payload?.data?.markdown
    if (typeof markdown !== 'string' || !markdown.trim()) {
      throw new Error(
        'Conversion returned no text. The document may be empty, password protected, or image-only.',
      )
    }

    const warning =
      typeof payload?.data?.warning === 'string'
        ? payload.data.warning
        : undefined

    const entry = { markdown: markdown.trim(), ...(warning && { warning }) }
    parseCache.set(key, entry)
    markOfficeUploadApproved()
    return { ...entry, cached: false }
  } catch (error) {
    if (combined.signal.aborted && !signal?.aborted) {
      throw new Error(
        `Timed out converting ${basename(filePath)} after ${OFFICE_PARSE_TIMEOUT_MS / 1000}s.`,
      )
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not convert ${basename(filePath)}: ${detail}`)
  } finally {
    combined.cleanup()
  }
}
