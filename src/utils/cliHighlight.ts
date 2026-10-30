// highlight.js's type defs carry `/// <reference lib="dom" />`. SSETransport,
// mcp/client, ssh, dumpPrompts use DOM types (TextDecodeOptions, RequestInfo)
// that only typecheck because this file's `typeof import('highlight.js')` pulls
// lib.dom in. tsconfig has lib: ["ESNext"] only — fixing the actual DOM-type
// deps is a separate sweep; this ref preserves the status quo.
/// <reference lib="dom" />

import { extname } from 'path'
import { highlightCode } from '../components/StructuredDiff/colorDiff.js'
import { getGlobalConfig } from './config.js'
import { resolveThemeSetting } from './systemTheme.js'

export type CliHighlight = {
  highlight: (code: string, options: { language: string }) => string
  supportsLanguage: (language: string) => boolean
}

// One promise shared by Fallback.tsx, markdown.ts, events.ts, getLanguageName.
let cliHighlightPromise: Promise<CliHighlight | null> | undefined

let loadedGetLanguage: typeof import('highlight.js').default.getLanguage | undefined

// Same in-process colorizer as markdown code blocks. The cli-highlight package
// would add a second, older highlight.js next to the one Tau already ships.
async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    // The ESM entry only has a default export, which is the instance.
    const { default: hljs } = await import('highlight.js')
    loadedGetLanguage = hljs.getLanguage
    return {
      highlight: (code, { language }) =>
        highlightCode(
          code,
          language,
          resolveThemeSetting(getGlobalConfig().theme),
        ),
      supportsLanguage: language => hljs.getLanguage(language) !== undefined,
    }
  } catch {
    return null
  }
}

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight()
  return cliHighlightPromise
}

/**
 * eg. "foo/bar.ts" → "TypeScript". Awaits the shared highlighter load,
 * then reads highlight.js's language registry. All callers are telemetry
 * (OTel counter attributes, permission-dialog unary events) — none block
 * on this, they fire-and-forget or the consumer already handles Promise<string>.
 */
export async function getLanguageName(file_path: string): Promise<string> {
  await getCliHighlightPromise()
  const ext = extname(file_path).slice(1)
  if (!ext) return 'unknown'
  return loadedGetLanguage?.(ext)?.name ?? 'unknown'
}
