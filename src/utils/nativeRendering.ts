import { extname } from 'path'
import stripAnsi from 'strip-ansi'
import { runNativeTauToolSync } from './nativeTauTools.js'
import type { ThemeName } from './theme.js'

const MAX_CACHE_ENTRIES = 300
const MAX_NATIVE_RENDER_CHARS = 200_000
const MAX_NATIVE_HIGHLIGHT_CHARS = 200_000
const COMPACT_MARKDOWN_WIDTH = 88

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/
const BLOCK_MARKDOWN_RE =
  /(^|\n)\s{0,3}(#{1,6}\s|```|~~~|>\s|[-*+]\s|\d+\.\s|[-*_]{3,}\s*$)/
const TABLE_MARKDOWN_RE =
  /(^|\n)\s*\|.+\|\s*\n\s*\|?[\s:-]+\|[\s|:-]*($|\n)/
const SETEXT_HEADING_RE = /(^|\n).+\n\s{0,3}[=-]{3,}\s*($|\n)/
const TRAILING_ANSI_SPACE_RE =
  /(?:(?:\x1B\[[0-?]*[ -/]*[@-~])*[ \t]+(?:\x1B\[[0-?]*[ -/]*[@-~])*)+$/u

const markdownCache = new Map<string, string | null>()
const highlightCache = new Map<string, string | null>()

function remember<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, value)
  return value
}

function languageFromPathOrHint(filePathOrLanguage: string | undefined): string {
  if (!filePathOrLanguage) return ''
  if (!filePathOrLanguage.includes('/') && !filePathOrLanguage.includes('\\')) {
    return filePathOrLanguage
  }
  const ext = extname(filePathOrLanguage).slice(1)
  return ext
}

function glamourStyleForTheme(theme: ThemeName): string {
  return theme.startsWith('light') ? 'tau-compact-light' : 'tau-compact-dark'
}

function shouldUseNativeMarkdown(content: string): boolean {
  if (ANSI_RE.test(content)) return false
  const sample = content.length > 4_000 ? content.slice(0, 4_000) : content
  return (
    BLOCK_MARKDOWN_RE.test(sample) ||
    TABLE_MARKDOWN_RE.test(sample) ||
    SETEXT_HEADING_RE.test(sample)
  )
}

function trimRenderedLine(line: string): string {
  // Glamour can emit plain terminal margins. Keep the colors, remove only
  // harmless whitespace so normal answers do not appear shifted right.
  let trimmed = line.replace(/[ \t]+$/u, '')
  while (trimmed !== '') {
    const next = trimmed.replace(TRAILING_ANSI_SPACE_RE, '')
    if (next === trimmed) break
    trimmed = next
  }
  return trimmed
}

function compactRenderedMarkdown(rendered: string): string {
  let lines = rendered
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(trimRenderedLine)

  while (lines.length > 0 && stripAnsi(lines[0]!).trim() === '') lines.shift()
  while (
    lines.length > 0 &&
    stripAnsi(lines[lines.length - 1]!).trim() === ''
  ) {
    lines.pop()
  }

  const nonBlank = lines.filter(line => stripAnsi(line).trim() !== '')
  const commonIndent =
    nonBlank.length === 0
      ? 0
      : Math.min(
          2,
          ...nonBlank.map(line => line.match(/^ */u)?.[0].length ?? 0),
        )
  if (commonIndent > 0) {
    lines = lines.map(line =>
      line.startsWith(' '.repeat(commonIndent))
        ? line.slice(commonIndent)
        : line,
    )
  }

  const compact: string[] = []
  for (const line of lines) {
    const isBlank = stripAnsi(line).trim() === ''
    if (isBlank) {
      if (compact.length > 0 && compact[compact.length - 1] !== '') {
        compact.push('')
      }
      continue
    }
    compact.push(line)
  }
  while (compact[compact.length - 1] === '') compact.pop()
  return compact.join('\n')
}

export function renderMarkdownWithNative(
  content: string,
  theme: ThemeName,
  width: number = process.stdout?.columns || 100,
): string | null {
  if (!content || content.length > MAX_NATIVE_RENDER_CHARS) return null
  if (!shouldUseNativeMarkdown(content)) return null
  const renderWidth = Math.max(48, Math.min(width, COMPACT_MARKDOWN_WIDTH))
  const key = `md:${theme}:${renderWidth}:${content}`
  const cached = markdownCache.get(key)
  if (cached !== undefined) return cached

  const rendered = runNativeTauToolSync(
    'render-markdown',
    ['--style', glamourStyleForTheme(theme), '--width', String(renderWidth)],
    { input: content, timeoutMs: 5_000, maxBuffer: 2_000_000 },
  )
  return remember(
    markdownCache,
    key,
    rendered ? compactRenderedMarkdown(rendered) || null : null,
  )
}

export function highlightCodeWithNative(
  code: string,
  filePathOrLanguage?: string,
): string | null {
  if (!code || code.length > MAX_NATIVE_HIGHLIGHT_CHARS) return null
  const language = languageFromPathOrHint(filePathOrLanguage)
  const key = `code:${language}:${filePathOrLanguage ?? ''}:${code}`
  const cached = highlightCache.get(key)
  if (cached !== undefined) return cached

  const args = ['--style', 'github-dark']
  if (language) args.push('--lang', language)
  const rendered = runNativeTauToolSync('highlight-code', args, {
    input: code,
    timeoutMs: 5_000,
    maxBuffer: 2_000_000,
  })
  return remember(
    highlightCache,
    key,
    rendered
      ?.replace(/\uFEFF/g, '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(trimRenderedLine)
      .join('\n')
      .trimEnd() || null,
  )
}
