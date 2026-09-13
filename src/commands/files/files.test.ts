/**
 * Run: bun run src/commands/files/files.test.ts
 * /files prints the read-file cache sorted, one Markdown code span per path,
 * so the transcript shows every path exactly as it is on disk.
 */

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { marked, type Token } from 'marked'
import { homedir } from 'os'
import { join, parse, relative } from 'path'
import {
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
} from '../../utils/fileStateCache.js'

const home = homedir()
const cwd = join(home, 'tau-files-test', 'project')
mock.module('../../utils/cwd.js', () => ({
  getCwd: () => cwd,
  pwd: () => cwd,
  runWithCwdOverride: (_cwd: string, fn: () => unknown) => fn(),
}))
// The real getDisplayPath's import graph reaches these generated SDK type
// files, which don't exist in this tree (build.mjs shims them).
for (const generated of [
  '../../entrypoints/sdk/coreTypes.generated.js',
  '../../entrypoints/sdk/runtimeTypes.js',
  '../../entrypoints/sdk/toolTypes.js',
]) {
  mock.module(generated, () => ({}))
}

const { call, codeSpan } = await import('./files.js')

let passed = 0
let failed = 0

async function test(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}: ${(error as Error).message}`)
  }
}

function cacheWith(paths: string[]): FileStateCache {
  const cache = createFileStateCacheWithSizeLimit(100)
  for (const path of paths) {
    cache.set(path, {
      content: 'x',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
  }
  return cache
}

async function run(cache: FileStateCache): Promise<string> {
  const result = await call('', { readFileState: cache } as never)
  assert.equal(result.type, 'text')
  return (result as { value: string }).value
}

// Every token marked produces for the text, nested ones included.
function allTokens(markdown: string): Token[] {
  const out: Token[] = []
  const walk = (tokens: Token[] | undefined) => {
    for (const token of tokens ?? []) {
      out.push(token)
      walk((token as { tokens?: Token[] }).tokens)
    }
  }
  walk(marked.lexer(markdown))
  return out
}

const codeSpanTexts = (markdown: string): string[] =>
  allTokens(markdown)
    .filter(token => token.type === 'codespan')
    .map(token => (token as { text: string }).text)

// Names that Markdown used to mangle: \. \[ \( \@ \+ \_ lost their backslash
// on Windows, and __init__ turned bold everywhere.
const inProject = [
  join(cwd, 'src', 'b.ts'),
  join(cwd, 'CLAUDE.md'),
  join(cwd, '.claude', 'settings.json'),
  join(cwd, 'app', '[id]', 'page.tsx'),
  join(cwd, 'app', '(marketing)', 'page.tsx'),
  join(cwd, 'app', '@modal', 'page.tsx'),
  join(cwd, 'src', 'routes', '+page.svelte'),
  join(cwd, 'src', '_internal', 'x.ts'),
  join(cwd, 'pkg', '__init__.py'),
  join(cwd, 'docs', 'a`b.md'),
]
const underHome = join(
  home,
  '.claude',
  'projects',
  'C--Users-x-project',
  'memory',
  'MEMORY.md',
)
const outsideHome = join(parse(home).root, 'tau-files-test-outside', 'z.ts')
const all = [...inProject, underHome, outsideHome]

const expectedDisplay = [
  ...inProject.map(path => relative(cwd, path)),
  '~' + underHome.slice(home.length),
  outsideHome,
].sort()

await test('empty cache', async () => {
  assert.equal(await run(cacheWith([])), 'No files counted as read yet')
})

await test('header counts every tracked file', async () => {
  const value = await run(cacheWith(all))
  assert.equal(value.split('\n')[0], `Files Tau counts as read (${all.length}):`)
})

await test('sorted: project-relative, ~ under home, absolute elsewhere', async () => {
  const lines = (await run(cacheWith(all))).split('\n').slice(1)
  assert.deepEqual(lines, expectedDisplay.map(codeSpan))
})

await test('Markdown shows every path verbatim', async () => {
  const value = await run(cacheWith(all))
  assert.deepEqual(codeSpanTexts(value), expectedDisplay)
  const styled = allTokens(value).filter(token =>
    ['escape', 'strong', 'em', 'del', 'link'].includes(token.type),
  )
  assert.deepEqual(
    styled.map(token => token.raw),
    [],
  )
})

await test('order does not follow cache recency', async () => {
  const cache = cacheWith(all)
  const first = await run(cache)
  // What getChangedFiles does on every attachment pass.
  for (const key of [...cache.keys()]) cache.get(key)
  assert.equal(await run(cache), first)
})

await test('listing leaves cache recency alone', async () => {
  const cache = cacheWith(all)
  const before = [...cache.keys()]
  await run(cache)
  assert.deepEqual([...cache.keys()], before)
})

await test('code spans survive backticks and edge spaces', async () => {
  for (const text of ['a`b', '`lead', 'trail`', 'a``b', ' space', 'x ']) {
    assert.deepEqual(codeSpanTexts(codeSpan(text)), [text], JSON.stringify(text))
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
