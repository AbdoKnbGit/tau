/**
 * Prompt-scoped excerpts of fetched pages.
 *
 * Two places used to send a page whole, or cut only by head:
 *
 *   - Preapproved documentation in Markdown is returned verbatim. A page
 *     larger than the inline limit was then parked on disk behind a 2 KB
 *     preview, so the model saw almost none of it. excerptPageForPrompt keeps
 *     the sections that match the prompt (plus the page head) within the
 *     limit, and the caller saves the full page for ToolOutputRetrieve.
 *   - Every other page goes to a side model call with up to 100K characters.
 *     When the prompt targets a small part of a long page,
 *     selectContentForSideQuery sends that part (plus the head) instead:
 *     less input, a faster answer, and nothing past the 100K head is lost.
 *     A prompt about the whole page keeps today's behavior.
 *
 * Pure and deterministic (see queryExcerpt.ts); leaf module for bun tests.
 */

import {
  excerptMarkdownForQuery,
  extractPromptTerms,
  type MarkdownExcerpt,
} from '../../utils/queryExcerpt.js'

/** Room kept below the inline limit for the note that follows an excerpt. */
const NOTE_RESERVE_CHARS = 1_000
/** Below this, an excerpt cannot hold a useful section; keep today's path. */
const MIN_EXCERPT_CHARS = 2_000

/**
 * Side-call input for a page whose prompt targets a small part of it. Pages
 * up to this size are always sent whole.
 */
export const SIDE_QUERY_EXCERPT_CHARS = 30_000
/**
 * The prompt must name something rare in the page, and the sections that
 * mention it must hold at most this share of it; otherwise the request is
 * about the whole page and is sent as before.
 */
const SIDE_QUERY_MAX_RELEVANT_FRACTION = 0.4
/**
 * The page head (title, intro, table of contents) always goes along, so a
 * request that reads as narrow but asks for an overview still sees it.
 */
const SIDE_QUERY_HEAD_CHARS = 12_000

/**
 * Excerpt of a preapproved Markdown page that would not fit inline, or null
 * when it fits (or the limit leaves no room for a useful excerpt).
 */
export function excerptPageForPrompt(
  markdown: string,
  prompt: string,
  inlineLimit: number,
): MarkdownExcerpt | null {
  if (!Number.isFinite(inlineLimit) || markdown.length <= inlineLimit) {
    return null
  }
  const budget = inlineLimit - NOTE_RESERVE_CHARS
  if (budget < MIN_EXCERPT_CHARS) return null
  return excerptMarkdownForQuery(markdown, extractPromptTerms(prompt), budget, {
    fill: true,
  })
}

/** The line that follows a page excerpt, telling the model where the rest is. */
export function buildPageExcerptNote(
  excerpt: MarkdownExcerpt,
  totalChars: number,
  savedPath: string | null,
): string {
  const summary = `[Excerpt: ${excerpt.shownSections} of ${excerpt.totalSections} sections, chosen for relevance to the prompt (${excerpt.text.length} of ${totalChars} characters).`
  return savedPath
    ? `\n\n${summary} Full page saved to: ${savedPath} - read more of it with ToolOutputRetrieve (query or line range).]`
    : `\n\n${summary} Call WebFetch again with a narrower prompt to see other sections.]`
}

/**
 * Content to send to the side model instead of the whole page, or null to
 * keep sending the page as before.
 */
export function selectContentForSideQuery(
  markdown: string,
  prompt: string,
): string | null {
  if (markdown.length <= SIDE_QUERY_EXCERPT_CHARS) return null
  const excerpt = excerptMarkdownForQuery(
    markdown,
    extractPromptTerms(prompt),
    SIDE_QUERY_EXCERPT_CHARS - NOTE_RESERVE_CHARS,
    {
      headChars: SIDE_QUERY_HEAD_CHARS,
      maxRelevantFraction: SIDE_QUERY_MAX_RELEVANT_FRACTION,
    },
  )
  if (!excerpt) return null
  return `${excerpt.text}\n\n[Excerpt: ${excerpt.shownSections} of ${excerpt.totalSections} sections of a ${markdown.length}-character page, selected for relevance to the request.]`
}
