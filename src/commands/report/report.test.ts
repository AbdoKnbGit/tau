/**
 * /report prompt and renderer regressions.
 *
 * Run: bun run src/commands/report/report.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertValidGeneratedReport,
  buildBoundedReportContext,
  buildReportPrompt,
  REPORT_CONTEXT_MAX_CHARS,
  renderHtml,
} from './presentation.js'

const skill = {
  extension: '.html',
  instruction: 'Write source Markdown with a clear hierarchy.',
}

const prompt = buildReportPrompt({
  format: 'html',
  skill,
  context: 'User:\nFix the provider retry boundary.\n\nAssistant:\nThe fix is verified.',
})

assert.match(prompt, /specific, informative title/)
assert.match(prompt, /do not force a template or include empty sections/)
assert.match(prompt, /session context supplied below/)
assert.match(prompt, /Fix the provider retry boundary/)
assert.doesNotMatch(prompt, /<session_transcript>/)
assert.doesNotMatch(prompt, /Use these exact sections/)
assert.doesNotMatch(prompt, /# Session Report/)

const html = renderHtml(`# Retry handling that preserves report output

The report command now retries provider throttling without writing the error as content.

## Result

- Cached request bytes stay stable.
- Provider failures remain failures.

<script>alert('unsafe')</script>`)

assert.match(html, /<title>Retry handling that preserves report output<\/title>/)
assert.match(html, /<article>/)
assert.doesNotMatch(html, /<script>/)

assert.throws(
  () => assertValidGeneratedReport(
    'Gemini API error 429: Resource has been exhausted',
  ),
  /did not return report content/,
)
assert.throws(
  () => assertValidGeneratedReport(
    `API Error: Gemini API error 429: {
  "error": {
    "code": 429,
    "message": "Resource has been exhausted (e.g. check quota).",
    "status": "RESOURCE_EXHAUSTED"
  }
}`,
  ),
  /did not return report content/,
)
assert.throws(
  () => assertValidGeneratedReport(
    '# This looks superficially like a report',
    { isApiErrorMessage: true },
  ),
  /did not return report content/,
)
assert.doesNotThrow(() => assertValidGeneratedReport(
  '# Provider retry repair\n\nThe failure now reaches the retry controller.',
))

// A quota refusal must not read like a Tau defect: /report already sends a
// bounded, tool-free request, so there is no payload left to blame.
assert.throws(
  () => assertValidGeneratedReport(
    'API Error: Gemini API error 429: {"error":{"status":"RESOURCE_EXHAUSTED"}}',
  ),
  /upstream limit/,
)
// ...and the raw JSON body is no longer the whole explanation.
assert.throws(
  () => assertValidGeneratedReport('API Error: Gemini API error 429: {'),
  /rate-limit\/quota error/,
)
// A supplied hint replaces the quoted provider line entirely.
assert.throws(
  () => assertValidGeneratedReport(
    'API Error: Gemini API error 429: {"error":{"status":"RESOURCE_EXHAUSTED"}}',
    { failureHint: 'This Antigravity account is not entitled to gemini-3.8-flash-high.' },
  ),
  /not entitled to gemini-3\.8-flash-high/,
)
// Non-quota failures keep quoting the provider so the cause stays visible.
assert.throws(
  () => assertValidGeneratedReport('API Error: failed to authenticate'),
  /Provider said: API Error: failed to authenticate/,
)

const shortContext = 'User:\nsmall session\n\n---\n\nAssistant:\ndone'
assert.equal(buildBoundedReportContext([shortContext]), shortContext)

const veryLongContext = [
  `BEGIN-GOAL ${'a'.repeat(30_000)}`,
  `${'b'.repeat(15_000)} MIDDLE-DECISION ${'b'.repeat(15_000)}`,
  `LATEST-OUTCOME ${'c'.repeat(30_000)} END-OUTCOME`,
]
const boundedContext = buildBoundedReportContext(veryLongContext)
assert.ok(boundedContext.length <= REPORT_CONTEXT_MAX_CHARS)
assert.match(boundedContext, /BEGIN-GOAL/)
assert.match(boundedContext, /MIDDLE-DECISION/)
assert.match(boundedContext, /END-OUTCOME/)
assert.match(boundedContext, /context omitted/i)

// /report uses a hard-bounded, text-only side request. It deliberately avoids
// replaying the live system prompt, tools, media, thinking blocks, and full
// history whose cold ingestion caused the remaining Antigravity 429s.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'report.ts'), 'utf8')
assert.match(source, /queryWithModel\(\{/)
assert.match(source, /model:\s*context\.options\.mainLoopModel/)
assert.match(source, /querySource:\s*'report'/)
assert.match(source, /skipCacheWrite:\s*true/)
assert.match(source, /enablePromptCaching:\s*false/)
assert.match(source, /maxOutputTokensOverride: reportMaxOutputTokens\(/)
assert.match(source, /Math\.min\(REPORT_MAX_OUTPUT_TOKENS, getMaxOutputTokensForModel\(model\)\)/)
assert.doesNotMatch(source, /temperatureOverride/)
assert.doesNotMatch(source, /runForkedAgent/)
assert.doesNotMatch(source, /getLastCacheSafeParams/)
assert.doesNotMatch(source, /getSmallFastModel/)

// Generation and validation happen before the common output path is resolved,
// so a failed model call cannot create Markdown, HTML, or PDF output.
assert.ok(
  source.indexOf('await generateReportMarkdown') < source.indexOf('resolveOutputPath'),
)

console.log('Report prompt and renderer tests passed')
