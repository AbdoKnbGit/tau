/**
 * Run: bun run src/tools/WebFetchTool/excerpt.test.ts
 */

import {
  buildPageExcerptNote,
  excerptPageForPrompt,
  SIDE_QUERY_EXCERPT_CHARS,
  selectContentForSideQuery,
} from './excerpt.js'

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

/** A documentation page with `sections` similar sections and one special one. */
function docsPage(sections: number, special: number): string {
  const parts = ['# Plugins reference', 'Everything about extending the tool.', '']
  for (let i = 0; i < sections; i++) {
    parts.push(`## Topic ${i}`)
    if (i === special) {
      parts.push(
        'To add a marketplace run `/plugin marketplace add owner/repo`.',
        'List them with `/plugin marketplace list` and remove one with `/plugin marketplace remove name`.',
      )
    }
    for (let p = 0; p < 12; p++) {
      parts.push(`Paragraph ${p} of topic ${i} describes general behaviour and options in prose.`, '')
    }
  }
  return parts.join('\n')
}

console.log('web fetch excerpts:')

test('a page that fits inline is left alone', () => {
  const page = docsPage(3, 1)
  assert(page.length < 20_000, `fixture too big: ${page.length}`)
  assert(excerptPageForPrompt(page, 'marketplace commands', 20_000) === null, 'expected null')
  assert(
    excerptPageForPrompt(page, 'marketplace commands', Number.POSITIVE_INFINITY) === null,
    'infinite limit means nothing is persisted',
  )
})

test('a large page is cut to the matching sections within the limit', () => {
  const page = docsPage(60, 41)
  assert(page.length > 40_000, `fixture too small: ${page.length}`)
  const excerpt = excerptPageForPrompt(
    page,
    'Give the exact CLI syntax for plugin marketplace add/list/remove',
    20_000,
  )!
  assert(excerpt !== null, 'expected an excerpt')
  assert(excerpt.text.length <= 19_000, `too long: ${excerpt.text.length}`)
  assert(excerpt.text.startsWith('# Plugins reference'), 'page head first')
  assert(excerpt.text.includes('/plugin marketplace remove name'), 'answer missing')
  assert(excerpt.shownSections < excerpt.totalSections, 'expected omissions')
})

test('a prompt that matches nothing still gets the page head', () => {
  const page = docsPage(60, 41)
  const excerpt = excerptPageForPrompt(page, 'zebra', 20_000)!
  assert(excerpt !== null, 'expected a head-first excerpt')
  assert(excerpt.text.startsWith('# Plugins reference'), 'page head first')
  assert(excerpt.text.length <= 19_000, `too long: ${excerpt.text.length}`)
})

test('a tiny inline limit keeps the previous behavior', () => {
  assert(excerptPageForPrompt(docsPage(60, 41), 'marketplace', 2_500) === null, 'expected null')
})

test('the note says where the full page is', () => {
  const excerpt = { text: 'x'.repeat(100), shownSections: 3, totalSections: 40 }
  const saved = buildPageExcerptNote(excerpt, 50_000, '/tmp/tool-results/abc.page.txt')
  assert(saved.includes('Full page saved to: /tmp/tool-results/abc.page.txt'), saved)
  assert(saved.includes('ToolOutputRetrieve'), saved)
  assert(saved.includes('3 of 40 sections'), saved)
  const unsaved = buildPageExcerptNote(excerpt, 50_000, null)
  assert(unsaved.includes('narrower prompt'), unsaved)
  assert(saved.length < 1_000 && unsaved.length < 1_000, 'note must fit its reserve')
})

test('side query: short pages are sent whole', () => {
  const page = docsPage(10, 4)
  assert(page.length <= SIDE_QUERY_EXCERPT_CHARS, `fixture too big: ${page.length}`)
  assert(selectContentForSideQuery(page, 'marketplace add') === null, 'expected null')
})

test('side query: a targeted prompt gets the matching part of a long page', () => {
  const page = docsPage(120, 77)
  assert(page.length > 100_000, `fixture too small: ${page.length}`)
  const content = selectContentForSideQuery(page, 'marketplace add list remove commands')!
  assert(content !== null, 'expected an excerpt')
  assert(content.length <= SIDE_QUERY_EXCERPT_CHARS, `too long: ${content.length}`)
  assert(content.includes('/plugin marketplace add owner/repo'), 'answer missing')
  assert(content.includes('selected for relevance to the request'), 'note missing')
})

test('side query: a narrow prompt mixed with common words still gets an excerpt', () => {
  const page = docsPage(120, 77)
  const content = selectContentForSideQuery(
    page,
    'What does the marketplace remove option do in general prose?',
  )!
  assert(content !== null, 'expected an excerpt')
  assert(content.includes('/plugin marketplace remove name'), 'answer missing')
})

test('side query: a prompt about the whole page keeps the old path', () => {
  const page = docsPage(120, 77)
  assert(
    selectContentForSideQuery(page, 'summarize the topics and paragraphs') === null,
    'broad prompts must not be excerpted',
  )
  assert(selectContentForSideQuery(page, 'what is this') === null, 'no terms, no excerpt')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
