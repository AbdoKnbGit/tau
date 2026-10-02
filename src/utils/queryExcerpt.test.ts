/**
 * Run: bun run src/utils/queryExcerpt.test.ts
 */

import {
  excerptForQuery,
  excerptMarkdownForQuery,
  extractPromptTerms,
  extractQueryTerms,
} from './queryExcerpt.js'
import { isWellFormedText } from './wellFormedText.js'

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

function eq<T>(actual: T, expected: T, hint?: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    throw new Error(`${hint ?? 'assertion failed'}\nexpected: ${b}\nactual:   ${a}`)
  }
}

/** Deterministic PRNG for the property checks (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const EMOJI = cp(0x1f680)
const WORDS = [
  'install', 'plugin', 'marketplace', 'cache', 'network', 'error', 'config',
  'session', 'remote', 'window', 'linux', 'mac', 'token', 'budget', 'search',
  'excerpt', 'section', 'value', 'other', 'table', 'value', EMOJI, cp(0x00e9, 0x0074, 0x00e9),
]

function filler(random: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) {
    out.push(WORDS[Math.floor(random() * WORDS.length)]!)
    if (random() < 0.08) out.push('\n')
  }
  return out.join(' ')
}

console.log('query terms:')

test('drops function words and stems the rest', () => {
  eq(extractQueryTerms('How do I install the plugins?'), ['install', 'plugin'])
  eq(extractQueryTerms('cached caching caches cache'), ['cach'])
})

test('keeps multi-digit numbers and drops single digits', () => {
  eq(extractQueryTerms('GTA 6 PC system requirements 2026'), [
    'gta',
    'pc',
    'system',
    'requirement',
    '2026',
  ])
})

test('folds accents and drops non-English function words', () => {
  const query = `syst${cp(0x00e8)}me de fichiers`
  eq(extractQueryTerms(query), ['system', 'fichier'])
})

test('matches unspaced scripts by bigram', () => {
  // "Tokyo weather" written without spaces: 4 overlapping bigrams.
  const terms = extractQueryTerms(cp(0x6771, 0x4eac, 0x306e, 0x5929, 0x6c17))
  eq(terms.length, 4)
  eq(terms[0], cp(0x6771, 0x4eac))
})

test('returns nothing for a query of only function words', () => {
  eq(extractQueryTerms('what is it and how'), [])
})

test('prompt terms also drop task words', () => {
  eq(
    extractPromptTerms('Extract the full details about installing plugins from this page'),
    ['install', 'plugin'],
  )
  eq(extractPromptTerms('Summarize this page'), [])
  // Search queries keep them: "content" can be the topic there.
  eq(extractQueryTerms('content security policy'), ['content', 'security', 'policy'])
})

console.log('\nplain excerpts:')

test('returns text unchanged when it fits', () => {
  eq(excerptForQuery('short text', ['short'], 100), 'short text')
})

test('returns null when nothing can be ranked', () => {
  const text = 'x'.repeat(5000)
  eq(excerptForQuery(text, [], 500), null)
  eq(excerptForQuery(text, ['absent'], 500), null)
  eq(excerptForQuery(`${text} needle`, ['needl'], 80), null)
})

test('finds a deep match and keeps the lead', () => {
  const random = rng(7)
  const text = `Lead sentence about the page. ${filler(random, 700)} The argan oil export volume grew in 2025. ${filler(random, 700)}`
  const terms = extractQueryTerms('argan oil export')
  const out = excerptForQuery(text, terms, 800)!
  assert(out !== null, 'expected an excerpt')
  assert(out.length <= 800, `too long: ${out.length}`)
  assert(out.includes('argan oil export'), out)
  assert(out.startsWith('Lead sentence'), 'lead must be kept')
  assert(out.includes('…'), 'gaps must be marked')
})

test('prefers the window covering more distinct terms', () => {
  const pad = 'lorem ipsum dolor sit amet '.repeat(60)
  const text = `${pad}alpha ${pad}alpha beta gamma together ${pad}`
  const out = excerptForQuery(text, ['alpha', 'beta', 'gamma'], 300, { leadChars: 0 })!
  assert(out.includes('alpha beta gamma together'), out)
})

test('uses an inline separator for single-line text', () => {
  const text = `${'word '.repeat(400)}needle ${'word '.repeat(400)}needle ${'word '.repeat(400)}`
  const out = excerptForQuery(text, ['needl'], 400)!
  assert(!out.includes('\n'), 'single-line input must stay single-line')
})

test('is deterministic', () => {
  const random = rng(11)
  const text = filler(random, 3000)
  const terms = extractQueryTerms('marketplace cache budget')
  eq(excerptForQuery(text, terms, 1200), excerptForQuery(text, terms, 1200))
})

test('never exceeds the budget and never splits a pair', () => {
  const random = rng(42)
  for (let round = 0; round < 300; round++) {
    const text = filler(random, 50 + Math.floor(random() * 1500))
    const query = filler(random, 1 + Math.floor(random() * 4))
    const budget = 120 + Math.floor(random() * 2000)
    const out = excerptForQuery(text, extractQueryTerms(query), budget)
    if (out === null) continue
    assert(out.length <= budget, `round ${round}: ${out.length} > ${budget}`)
    assert(isWellFormedText(out), `round ${round}: lone surrogate`)
  }
})

console.log('\nmarkdown excerpts:')

function doc(): string {
  const body = (topic: string, n: number): string =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i} about ${topic} details and more words here.`).join('\n\n')
  return [
    '# Plugin guide',
    'This page explains plugins.',
    '',
    '## Install',
    body('installation', 25),
    '',
    '```bash',
    '# install dependencies first',
    'npm install',
    '```',
    '',
    '## Configure settings',
    body('configuration settings', 25),
    '',
    'Uninstall steps',
    '---------------',
    body('removal', 25),
    '',
    '## Troubleshooting',
    body('errors', 25),
  ].join('\n')
}

test('returns null when the document fits', () => {
  eq(excerptMarkdownForQuery('# Small\n\ntext', ['small'], 1000), null)
})

test('keeps the head and the best-matching section', () => {
  const markdown = doc()
  const out = excerptMarkdownForQuery(markdown, extractQueryTerms('configure settings'), 2500)!
  assert(out !== null, 'expected an excerpt')
  assert(out.text.length <= 2500, `too long: ${out.text.length}`)
  assert(out.text.startsWith('# Plugin guide'), 'head must come first')
  assert(out.text.includes('## Configure settings'), 'matching section missing')
  assert(out.text.includes('omitted'), 'omissions must be marked')
  assert(out.shownSections < out.totalSections, 'not everything fits')
})

test('detects setext headings', () => {
  const out = excerptMarkdownForQuery(doc(), extractQueryTerms('uninstall'), 2500)!
  assert(out.text.includes('Uninstall steps\n---'), out.text.slice(0, 400))
})

test('does not split headings inside code fences', () => {
  const out = excerptMarkdownForQuery(doc(), extractQueryTerms('npm dependencies'), 3000)!
  assert(out.text.includes('# install dependencies first\nnpm install'), 'fence content must stay together')
})

test('returns null for a request about the whole page', () => {
  const out = excerptMarkdownForQuery(doc(), extractQueryTerms('paragraph details words'), 2500, {
    maxRelevantFraction: 0.4,
  })
  eq(out, null)
})

test('a rare term keeps a request targeted even next to common words', () => {
  // "removal" is in one section; "paragraph" is in nearly all of them.
  const out = excerptMarkdownForQuery(doc(), ['removal', 'paragraph'], 2500, {
    maxRelevantFraction: 0.4,
  })!
  assert(out !== null, 'a rare term must make the request targeted')
  assert(out.text.includes('Uninstall steps'), out.text.slice(0, 300))
})

test('fill gives a head-first excerpt when nothing matches', () => {
  const out = excerptMarkdownForQuery(doc(), extractQueryTerms('kubernetes'), 2500, { fill: true })!
  assert(out !== null, 'fill must always produce an excerpt')
  assert(out.text.startsWith('# Plugin guide'), 'head first')
  assert(out.text.length <= 2500, `too long: ${out.text.length}`)
})

test('labels a later part of a long section', () => {
  const long = [
    '# Title',
    'intro',
    '## Big section',
    ...Array.from({ length: 120 }, (_, i) => `Line ${i} plain filler text for the section.`),
    '',
    'The unique quasar term appears late in the section.',
    ...Array.from({ length: 20 }, (_, i) => `Tail ${i} filler.`),
    '## Other',
    'other text',
  ].join('\n')
  const out = excerptMarkdownForQuery(long, ['quasar'], 2000)!
  assert(out.text.includes('quasar'), 'match missing')
  assert(out.text.includes('## Big section (continued)'), out.text)
})

test('never exceeds the budget and stays well-formed', () => {
  const random = rng(99)
  for (let round = 0; round < 150; round++) {
    const parts: string[] = []
    const sections = 2 + Math.floor(random() * 12)
    for (let s = 0; s < sections; s++) {
      const level = 1 + Math.floor(random() * 3)
      parts.push(`${'#'.repeat(level)} ${filler(random, 3)}`)
      parts.push(filler(random, 20 + Math.floor(random() * 600)))
      if (random() < 0.3) parts.push('```\n# not a heading\ncode line\n```')
    }
    const markdown = parts.join('\n\n')
    const budget = 500 + Math.floor(random() * 6000)
    const options = random() < 0.5 ? { fill: true } : {}
    const out = excerptMarkdownForQuery(markdown, extractQueryTerms(filler(random, 3)), budget, options)
    if (out === null) continue
    assert(out.text.length <= budget, `round ${round}: ${out.text.length} > ${budget}`)
    assert(isWellFormedText(out.text), `round ${round}: lone surrogate`)
  }
})

test('handles a large document quickly', () => {
  const random = rng(5)
  const parts: string[] = []
  for (let s = 0; s < 400; s++) {
    parts.push(`## Section ${s} ${filler(random, 2)}`)
    parts.push(filler(random, 400))
  }
  const markdown = parts.join('\n\n')
  const started = performance.now()
  const out = excerptMarkdownForQuery(markdown, extractQueryTerms('marketplace excerpt'), 20_000)
  const elapsed = performance.now() - started
  assert(out !== null && out.text.length <= 20_000, 'expected an excerpt')
  assert(elapsed < 3000, `too slow: ${Math.round(elapsed)}ms for ${markdown.length} chars`)
  console.log(`      (${markdown.length} chars in ${Math.round(elapsed)}ms)`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
