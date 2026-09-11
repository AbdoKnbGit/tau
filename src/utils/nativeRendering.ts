import { extname } from 'path'
import { isNativeTauToolsAvailable, runNativeTauTool } from './nativeTauTools.js'
import type { ThemeName } from './theme.js'

const MAX_CACHE_ENTRIES = 300
const MAX_NATIVE_HIGHLIGHT_CHARS = 200_000
// Cap concurrent background highlight subprocesses. During streaming, the last
// (growing) code block cache-misses on every delta with a different key, so an
// uncapped scheme would launch a storm of 29 MB `tau-tools.exe` spawns. Over
// the cap we skip; a later render (once the stream slows and a slot frees)
// fills the cache for the now-stable content.
const MAX_INFLIGHT_HIGHLIGHTS = 3

// The native helper currently ships one Chroma style. Keep it opt-in so a
// later cache fill cannot replace a custom Tau palette with github-dark ANSI.
const NATIVE_SYNTAX_STYLES: Partial<Record<ThemeName, string>> = {
  dark: 'github-dark',
}

const TRAILING_ANSI_SPACE_RE =
  /(?:(?:\x1B\[[0-?]*[ -/]*[@-~])*[ \t]+(?:\x1B\[[0-?]*[ -/]*[@-~])*)+$/u

const highlightCache = new Map<string, string | null>()
// Keys with an async highlight currently in flight. Dedupes identical requests
// and, with MAX_INFLIGHT_HIGHLIGHTS, bounds how many subprocesses run at once.
const inFlightHighlights = new Set<string>()

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

function trimRenderedLine(line: string): string {
  let trimmed = line.replace(/[ \t]+$/u, '')
  while (trimmed !== '') {
    const next = trimmed.replace(TRAILING_ANSI_SPACE_RE, '')
    if (next === trimmed) break
    trimmed = next
  }
  return trimmed
}

function normalizeRendered(rendered: string | null): string | null {
  return (
    rendered
      ?.replace(/\uFEFF/g, '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(trimRenderedLine)
      .join('\n')
      .trimEnd() || null
  )
}

export function getNativeHighlightStyle(themeName: ThemeName): string | null {
  return NATIVE_SYNTAX_STYLES[themeName] ?? null
}

// Fill the highlight cache off the render path. Never awaited by callers: the
// current render uses the JS fallback (null return below) and a later render
// picks up the cached result. Deduped + concurrency-capped so streaming's
// per-delta cache misses can't flood the machine with subprocess spawns.
function scheduleNativeHighlight(
  key: string,
  code: string,
  language: string,
  style: string,
): void {
  if (
    inFlightHighlights.has(key) ||
    inFlightHighlights.size >= MAX_INFLIGHT_HIGHLIGHTS
  ) {
    return
  }
  inFlightHighlights.add(key)
  const args = ['--style', style]
  if (language) args.push('--lang', language)
  runNativeTauTool('highlight-code', args, {
    input: code,
    timeoutMs: 5_000,
    maxBuffer: 2_000_000,
  })
    .then(out => remember(highlightCache, key, normalizeRendered(out)))
    // A failed / timed-out / oversized highlight caches null so we don't retry
    // it, and the caller keeps using the JS fallback for this content.
    .catch(() => remember(highlightCache, key, null))
    .finally(() => inFlightHighlights.delete(key))
}

/**
 * Returns cached native-highlighted code, or null if it is not (yet) available.
 *
 * MUST NOT block the event loop. This previously ran the highlighter via
 * spawnSync — a 29 MB subprocess spawned synchronously on the React/Ink render
 * path. Streaming a fenced code block cache-misses on every delta, so that
 * spawned a fresh subprocess per delta and froze the whole UI (dead spinner,
 * dead Esc/Ctrl+C) for seconds-to-minutes; cold spawns measured ~4.4s each.
 *
 * Now a cache miss only *schedules* an async fill and returns null immediately.
 * `HighlightedCode` falls back to the fast in-process JS highlighter when this
 * returns null. Themes without a matching native style stay on that themed
 * renderer permanently, while supported themes can swap in the native result
 * once it lands.
 */
export function highlightCodeWithNative(
  code: string,
  filePathOrLanguage?: string,
  themeName: ThemeName = 'dark',
): string | null {
  if (!code || code.length > MAX_NATIVE_HIGHLIGHT_CHARS) return null
  const style = getNativeHighlightStyle(themeName)
  if (!style) return null
  if (!isNativeTauToolsAvailable()) return null
  const language = languageFromPathOrHint(filePathOrLanguage)
  const key = `code:${themeName}:${style}:${language}:${filePathOrLanguage ?? ''}:${code}`
  const cached = highlightCache.get(key)
  if (cached !== undefined) return cached
  scheduleNativeHighlight(key, code, language, style)
  return null
}
