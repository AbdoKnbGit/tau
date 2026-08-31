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
  buildReportPrompt,
  renderHtml,
} from './presentation.js'

const skill = {
  extension: '.html',
  instruction: 'Write source Markdown with a clear hierarchy.',
}

const prompt = buildReportPrompt({
  format: 'html',
  skill,
})

assert.match(prompt, /specific, informative title/)
assert.match(prompt, /do not force a template or include empty sections/)
assert.match(prompt, /conversation context already provided/)
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

// /report must append only a small instruction to the current conversation
// prefix. Re-serializing the transcript into queryWithModel is the cold,
// quota-heavy path that caused #29.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'report.ts'), 'utf8')
assert.match(source, /getLastCacheSafeParams\(\)/)
assert.match(source, /runForkedAgent\(\{/)
assert.match(source, /querySource:\s*'report'/)
assert.match(source, /preserveParentAgentId:\s*true/)
assert.match(source, /skipCacheWrite:\s*true/)
assert.doesNotMatch(source, /queryWithModel/)
assert.doesNotMatch(source, /MAX_TRANSCRIPT_CHARS/)
assert.doesNotMatch(source, /maxOutputTokensOverride/)
assert.doesNotMatch(source, /temperatureOverride/)

// Generation and validation happen before the common output path is resolved,
// so a failed model call cannot create Markdown, HTML, or PDF output.
assert.ok(
  source.indexOf('await generateReportMarkdown') < source.indexOf('resolveOutputPath'),
)

console.log('Report prompt and renderer tests passed')
