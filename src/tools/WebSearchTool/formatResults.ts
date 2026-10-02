/**
 * Formats web search output for the model.
 *
 * A result that fits its budget is rendered exactly as before. An oversized
 * one used to cross the persistence threshold, and the model then saw a 2 KB
 * preview holding one hit's title and nothing else. Instead, each hit's
 * content excerpt is shrunk to its share of the budget, keeping the passages
 * that match the query (queryExcerpt.ts); titles, URLs and descriptions are
 * always kept whole so sources can still be cited.
 *
 * Pure and deterministic: the result is computed once when the search
 * finishes and frozen into the conversation, so it is prompt-cache safe.
 */

import { excerptForQuery, extractQueryTerms } from '../../utils/queryExcerpt.js'

export type WebSearchHitForModel = {
  title: string
  url: string
  description?: string
  content?: string
}

export type WebSearchOutputForModel = {
  query: string
  results?: ReadonlyArray<
    { content?: readonly WebSearchHitForModel[] } | string | null | undefined
  > | null
}

const TOOL_RESULT_MAX_CONTENT_CHARS = 6_000
const TOOL_RESULT_MAX_DESCRIPTION_CHARS = 1_000
const CONTENT_TRUNCATED_SUFFIX = '\n[content truncated]'
/** Every hit keeps at least this much content, even when the budget is tight. */
const MIN_HIT_CONTENT_CHARS = 300

const REMINDER =
  '\nREMINDER: Use the content excerpts above to answer directly when they contain the requested facts. You MUST include the sources above in your response to the user using markdown hyperlinks.'

export function truncateForToolResult(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const truncated = value.slice(0, maxChars).replace(/\s+\S*$/, '').trimEnd()
  return `${truncated}${CONTENT_TRUNCATED_SUFFIX}`
}

type ContentFor = (hit: WebSearchHitForModel, hitIndex: number) => string | undefined
type TextFor = (text: string) => string

function formatHit(
  hit: WebSearchHitForModel,
  index: number,
  content: string | undefined,
): string {
  const lines = [`Result ${index}:`, `Title: ${hit.title}`, `URL: ${hit.url}`]
  if (hit.description) {
    lines.push(
      `Description: ${truncateForToolResult(hit.description, TOOL_RESULT_MAX_DESCRIPTION_CHARS)}`,
    )
  }
  if (content !== undefined) {
    lines.push(`Content excerpt:\n${content}`)
  }
  return lines.join('\n')
}

function render(
  output: WebSearchOutputForModel,
  contentFor: ContentFor,
  textFor: TextFor,
): string {
  let formattedOutput = `Web search results for query: "${output.query}"\n\n`

  let resultIndex = 1
  let hitIndex = 0

  // Results can contain both text summaries and structured search hits.
  // Guard against null/undefined entries that can appear after JSON round-tripping.
  ;(output.results ?? []).forEach(result => {
    if (result == null) {
      return
    }
    if (typeof result === 'string') {
      // Text summary
      formattedOutput += textFor(result) + '\n\n'
    } else {
      const hits = result.content ?? []
      if (hits.length > 0) {
        formattedOutput +=
          hits
            .map(hit => formatHit(hit, resultIndex++, contentFor(hit, hitIndex++)))
            .join('\n\n') + '\n\n'
      } else {
        formattedOutput += 'No search results found.\n\n'
      }
    }
  })

  formattedOutput += REMINDER

  return formattedOutput.trim()
}

function legacyContent(hit: WebSearchHitForModel): string | undefined {
  return hit.content
    ? truncateForToolResult(hit.content, TOOL_RESULT_MAX_CONTENT_CHARS)
    : undefined
}

/**
 * Split `available` characters across items wanting `wants[i]` each: small
 * items get all they want, the rest share what is left evenly. Every item
 * gets at least `minEach` (or its whole want, if smaller), so the total can
 * exceed `available` when the budget is very tight.
 */
function shareBudget(
  wants: readonly number[],
  available: number,
  minEach: number,
): number[] {
  const shares = new Array<number>(wants.length).fill(0)
  const order = wants
    .map((_, i) => i)
    .sort((a, b) => wants[a]! - wants[b]! || a - b)
  let remaining = Math.max(0, available)
  order.forEach((index, k) => {
    const even = Math.floor(remaining / (order.length - k))
    const share = Math.min(wants[index]!, Math.max(even, minEach))
    shares[index] = share
    remaining = Math.max(0, remaining - share)
  })
  return shares
}

/** Shrink `text` to `maxChars`, keeping query matches; head cut otherwise. */
function fitText(text: string, terms: readonly string[], maxChars: number): string {
  if (text.length <= maxChars) return text
  return (
    excerptForQuery(text, terms, maxChars) ??
    truncateForToolResult(text, Math.max(0, maxChars - CONTENT_TRUNCATED_SUFFIX.length))
  )
}

/**
 * Render search results for the model within `budgetChars` (normally a share
 * of the tool's persistence threshold). Results that already fit are
 * byte-identical to the unbudgeted rendering.
 */
export function formatWebSearchResultsForModel(
  output: WebSearchOutputForModel,
  budgetChars: number,
): string {
  const legacy = render(output, legacyContent, text => text)
  if (!Number.isFinite(budgetChars) || legacy.length <= budgetChars) {
    return legacy
  }

  const terms = extractQueryTerms(output.query)
  // Long text summaries (a provider's raw fallback text) get at most half the
  // budget; short ones are left alone.
  const textLimit = Math.max(MIN_HIT_CONTENT_CHARS, Math.floor(budgetChars / 2))
  const textFor: TextFor = text => fitText(text, terms, textLimit)

  // Everything but the hit contents is fixed: measure it with empty contents.
  const fixedLength = render(
    output,
    hit => (hit.content ? '' : undefined),
    textFor,
  ).length
  const contents: string[] = []
  render(
    output,
    hit => {
      if (hit.content) contents.push(hit.content)
      return undefined
    },
    textFor,
  )
  const wants = contents.map(content =>
    Math.min(content.length, TOOL_RESULT_MAX_CONTENT_CHARS),
  )
  const shares = shareBudget(wants, budgetChars - fixedLength, MIN_HIT_CONTENT_CHARS)

  let contentIndex = 0
  return render(
    output,
    hit => {
      if (!hit.content) return undefined
      const share = shares[contentIndex++]!
      return fitText(hit.content, terms, share)
    },
    textFor,
  )
}
