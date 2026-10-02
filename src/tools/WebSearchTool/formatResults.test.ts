/**
 * Run: bun run src/tools/WebSearchTool/formatResults.test.ts
 */

import {
  formatWebSearchResultsForModel,
  type WebSearchHitForModel,
  type WebSearchOutputForModel,
} from './formatResults.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

/** The formatter as it was before budgeting, kept verbatim for comparison. */
function previousFormat(output: WebSearchOutputForModel): string {
  const truncate = (value: string, maxChars: number): string => {
    if (value.length <= maxChars) return value
    const truncated = value.slice(0, maxChars).replace(/\s+\S*$/, '').trimEnd()
    return `${truncated}\n[content truncated]`
  }
  const formatHit = (hit: WebSearchHitForModel, index: number): string => {
    const lines = [`Result ${index}:`, `Title: ${hit.title}`, `URL: ${hit.url}`]
    if (hit.description) {
      lines.push(`Description: ${truncate(hit.description, 1_000)}`)
    }
    if (hit.content) {
      lines.push(`Content excerpt:\n${truncate(hit.content, 6_000)}`)
    }
    return lines.join('\n')
  }
  let formattedOutput = `Web search results for query: "${output.query}"\n\n`
  let resultIndex = 1
  ;(output.results ?? []).forEach(result => {
    if (result == null) return
    if (typeof result === 'string') {
      formattedOutput += result + '\n\n'
    } else if ((result.content?.length ?? 0) > 0) {
      formattedOutput +=
        result.content!.map(hit => formatHit(hit, resultIndex++)).join('\n\n') + '\n\n'
    } else {
      formattedOutput += 'No search results found.\n\n'
    }
  })
  formattedOutput +=
    '\nREMINDER: Use the content excerpts above to answer directly when they contain the requested facts. You MUST include the sources above in your response to the user using markdown hyperlinks.'
  return formattedOutput.trim()
}

function filler(words: number, seed: number): string {
  const vocabulary = ['page', 'menu', 'cookie', 'banner', 'navigation', 'footer', 'subscribe', 'login']
  return Array.from({ length: words }, (_, i) => vocabulary[(i * 7 + seed) % vocabulary.length]).join(' ')
}

function bigOutput(hits: number, contentWords: number): WebSearchOutputForModel {
  return {
    query: 'GTA 6 PC system requirements',
    results: [
      {
        content: Array.from({ length: hits }, (_, i) => ({
          title: `Hit ${i} title`,
          url: `https://example.com/${i}`,
          description: `Short description ${i}`,
          content: `${filler(contentWords, i)} The GTA 6 PC system requirements are an RTX 3060 and 16GB RAM for hit ${i}. ${filler(contentWords, i + 3)}`,
        })),
      },
    ],
  }
}

console.log('web search formatting:')

test('results within budget are byte-identical to the previous format', () => {
  const outputs: WebSearchOutputForModel[] = [
    { query: 'x', results: [] },
    { query: 'x', results: [null, 'Some commentary', { content: [] }] },
    bigOutput(3, 40),
    {
      query: 'q',
      results: [
        { content: [{ title: 't', url: 'https://a.b', content: 'c'.repeat(7000) }] },
        'text summary',
      ],
    },
  ]
  for (const output of outputs) {
    const expected = previousFormat(output)
    const actual = formatWebSearchResultsForModel(output, 1_000_000)
    assert(actual === expected, `mismatch for ${JSON.stringify(output).slice(0, 80)}`)
  }
})

test('infinite budget keeps the previous format', () => {
  const output = bigOutput(8, 700)
  assert(
    formatWebSearchResultsForModel(output, Number.POSITIVE_INFINITY) === previousFormat(output),
    'infinite budget must not change output',
  )
})

test('oversized results fit the budget and keep every source', () => {
  const output = bigOutput(8, 900)
  const before = previousFormat(output)
  assert(before.length > 20_000, `fixture too small: ${before.length}`)
  const after = formatWebSearchResultsForModel(output, 12_000)
  assert(after.length <= 12_000, `too long: ${after.length}`)
  for (let i = 0; i < 8; i++) {
    assert(after.includes(`Title: Hit ${i} title`), `title ${i} missing`)
    assert(after.includes(`URL: https://example.com/${i}`), `url ${i} missing`)
    assert(after.includes(`RTX 3060 and 16GB RAM for hit ${i}`), `relevant passage ${i} missing`)
  }
  assert(after.includes('REMINDER:'), 'reminder missing')
})

test('a tight budget still shows something from every hit', () => {
  const output = bigOutput(8, 900)
  const after = formatWebSearchResultsForModel(output, 2_000)
  for (let i = 0; i < 8; i++) {
    assert(after.includes(`for hit ${i}`), `hit ${i} lost its content`)
  }
})

test('a huge text summary is shrunk to half the budget', () => {
  const summary = `${filler(3000, 1)} the system requirements answer ${filler(3000, 2)}`
  const output: WebSearchOutputForModel = { query: 'system requirements', results: [summary] }
  const after = formatWebSearchResultsForModel(output, 8_000)
  assert(after.length <= 8_000, `too long: ${after.length}`)
  assert(after.includes('system requirements answer'), 'answer missing')
})

test('is deterministic', () => {
  const output = bigOutput(8, 900)
  assert(
    formatWebSearchResultsForModel(output, 12_000) === formatWebSearchResultsForModel(output, 12_000),
    'output differs between runs',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
