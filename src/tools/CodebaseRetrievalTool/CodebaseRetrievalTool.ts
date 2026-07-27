import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { createElement } from 'react'
import { extname, isAbsolute, join, relative, resolve } from 'path'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { CODEBASE_RETRIEVAL_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Retrieve likely relevant repository files and snippets for a natural-language codebase question. Read-only.'

const PROMPT = `Search the local repository by intent using lightweight lexical scoring and return ranked files with snippets. This is read-only.

Use when the user asks where behavior lives, how a feature works, what to change for an intent, or when broad semantic-style repo orientation is useful before Grep/LSP/Read. Prefer CodeGraph first when a .codegraph directory exists.`

/**
 * Directories whose contents are installed or generated rather than written.
 * These matter more than they look: the walk stops at 15k files, so anything
 * that fills the budget with machine-generated content pushes the project's
 * own source out of the search. A virtualenv alone can hold tens of
 * thousands of `.py` files — which the old extension allowlist happily read.
 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.cache',
  '.parcel-cache',
  '.turbo',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'site-packages',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.ipynb_checkpoints',
  '.gradle',
  '.terraform',
])

/**
 * Binary and generated formats, skipped without being opened.
 *
 * This is a denylist on purpose. It used to be an allowlist of ~28 source
 * extensions, which silently made whole projects invisible: a folder holding
 * `.ipynb`, `.txt` and `.csv` reported "searched 1 file" and "no matches",
 * and a model handed that answer twice has nothing left to work with. Any
 * allowlist is a promise to have thought of every language and every layout,
 * which is not a promise this tool can keep — so it now reads what is not
 * known to be binary, and {@link looksBinary} catches whatever slips through.
 */
const SKIP_EXTS = new Set([
  // images / media
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff',
  '.svgz', '.psd', '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.avi', '.mov',
  '.mkv', '.webm',
  // archives / documents
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar', '.war',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
  // executables / objects / fonts
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.a', '.lib', '.pdb',
  '.class', '.pyc', '.pyo', '.wasm', '.node', '.ttf', '.otf', '.woff',
  '.woff2', '.eot',
  // datastores and model weights — an ML checkout is mostly these
  '.db', '.sqlite', '.sqlite3', '.mdb', '.parquet', '.feather', '.arrow',
  '.pkl', '.pickle', '.joblib', '.npy', '.npz', '.h5', '.hdf5', '.pt', '.pth',
  '.ckpt', '.safetensors', '.onnx', '.pb', '.tflite', '.gguf', '.msgpack',
  // generated text that is real, searchable, and never what anyone means
  '.map', '.min.js', '.min.css',
])

/**
 * `extname` sees only the last dot, so the compound suffixes in
 * {@link SKIP_EXTS} are matched against the whole name.
 */
function isSkippedFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (SKIP_EXTS.has(extname(lower))) return true
  return lower.endsWith('.min.js') || lower.endsWith('.min.css')
}

/**
 * Binary content that carries no telltale extension (or none at all). Same
 * test git uses: a NUL byte near the start means the bytes are not text.
 */
function looksBinary(content: string): boolean {
  return content.lastIndexOf('\0', 4096) !== -1
}

/**
 * Notebook JSON is mostly bookkeeping — cell metadata, execution counts,
 * base64 image outputs. Scoring and quoting that rather than the code would
 * let a notebook match on noise and then return a snippet of nothing, so the
 * cell sources stand in for the file.
 */
function extractNotebookSource(content: string): string {
  try {
    const cells = (JSON.parse(content) as { cells?: unknown }).cells
    if (!Array.isArray(cells)) return content
    const parts: string[] = []
    for (const cell of cells) {
      const source = (cell as { source?: unknown } | null)?.source
      if (typeof source === 'string') parts.push(source)
      else if (Array.isArray(source)) parts.push(source.join(''))
    }
    return parts.length > 0 ? parts.join('\n') : content
  } catch {
    return content
  }
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().min(1).describe('Natural-language repo search query.'),
    root: z
      .string()
      .optional()
      .describe('Directory to search. Defaults to the current working directory.'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Maximum matches to return. Defaults to 10.'),
    includeSnippets: z
      .boolean()
      .optional()
      .describe('Include short matching snippets. Defaults to true.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const matchSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  score: z.number(),
  reason: z.string(),
  snippet: z.string().optional(),
})

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string(),
    root: z.string(),
    matches: z.array(matchSchema),
    searchedFiles: z.number(),
    truncated: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
type Match = z.infer<typeof matchSchema>
export type RetrieveCodebaseInput = {
  query: string
  root?: string
  maxResults?: number
  includeSnippets?: boolean
}

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/i)
        .map(t => t.trim())
        .filter(t => t.length >= 2),
    ),
  ]
}

function safeStat(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function resolveRoot(root: string | undefined): string {
  const cwd = getCwd()
  const value = root?.trim() ? root.trim() : cwd
  return isAbsolute(value) ? value : resolve(cwd, value)
}

/**
 * Files git would show: tracked, plus untracked ones that are not ignored.
 *
 * Ignored trees are not just wasted budget, they are wrong answers. A repo
 * that vendors other checkouts, or a `.claude/worktrees/` copy of itself,
 * hands back a stale near-identical twin of the file the caller wanted —
 * same basename, same path shape, months out of date — and the walk can burn
 * its entire file budget inside them before reaching the project's own src.
 * .gitignore already records which of those the project disowns, so this asks
 * git rather than guessing with directory names.
 *
 * Returns null when the root is not a git repo, git is missing, or the
 * listing is unusable — every one of which falls back to {@link walkFs}.
 */
function listGitFiles(root: string): string[] | null {
  let stdout: string
  try {
    stdout = execFileSync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    )
  } catch {
    return null
  }
  const relatives = stdout.split('\0').filter(Boolean)
  return relatives.length > 0 ? relatives.map(rel => join(root, rel)) : null
}

function walk(root: string, maxFiles: number): { files: string[]; truncated: boolean } {
  const tracked = listGitFiles(root)
  if (tracked) {
    const files: string[] = []
    for (const path of tracked) {
      if (files.length >= maxFiles) return { files, truncated: true }
      if (isSkippedFile(path)) continue
      const stat = safeStat(path)
      if (stat?.isFile() && stat.size <= 250_000) files.push(path)
    }
    return { files, truncated: false }
  }
  return walkFs(root, maxFiles)
}

function walkFs(root: string, maxFiles: number): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false

  function visit(dir: string): void {
    if (files.length >= maxFiles) {
      truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(path)
      } else if (entry.isFile() && !isSkippedFile(entry.name)) {
        const stat = safeStat(path)
        if (stat && stat.size <= 250_000) files.push(path)
      }
    }
  }

  visit(root)
  return { files, truncated }
}

function snippetFor(content: string, terms: string[]): string | undefined {
  const lower = content.toLowerCase()
  const index = terms
    .map(term => lower.indexOf(term))
    .filter(i => i >= 0)
    .sort((a, b) => a - b)[0]
  if (index === undefined) return undefined
  const start = Math.max(0, index - 180)
  const end = Math.min(content.length, index + 360)
  return content.slice(start, end).replace(/\s+/g, ' ').trim()
}

function scoreFile(path: string, root: string, queryTerms: string[], includeSnippets: boolean): Match | null {
  let content = ''
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  if (looksBinary(content)) return null
  if (extname(path).toLowerCase() === '.ipynb') {
    content = extractNotebookSource(content)
  }
  const rel = relative(root, path)
  const haystack = `${rel}\n${content}`.toLowerCase()
  let score = 0
  const reasons: string[] = []
  for (const term of queryTerms) {
    const inPath = rel.toLowerCase().includes(term)
    const occurrences = haystack.split(term).length - 1
    if (inPath) {
      score += 12
      reasons.push(`path:${term}`)
    }
    if (occurrences > 0) {
      score += Math.min(occurrences, 8) * 3
      reasons.push(`text:${term}`)
    }
  }
  if (/\b(route|handler|controller|tool|command|schema|prompt|provider|lane)\b/i.test(rel)) {
    score += 4
  }
  if (score < 6) return null
  return {
    path,
    relativePath: rel,
    score,
    reason: reasons.slice(0, 6).join(', '),
    ...(includeSnippets ? { snippet: snippetFor(content, queryTerms) } : {}),
  }
}

export function retrieveCodebase(input: RetrieveCodebaseInput): Output {
  const root = resolveRoot(input.root)
  const stat = safeStat(root)
  const { files, truncated } =
    existsSync(root) && stat?.isDirectory()
      ? walk(root, 15_000)
      : { files: [], truncated: false }
  const terms = tokenize(input.query)
  const includeSnippets = input.includeSnippets !== false
  const matches = files
    .map(path => scoreFile(path, root, terms, includeSnippets))
    .filter((m): m is Match => m !== null)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, input.maxResults ?? 10)
  return { query: input.query, root, matches, searchedFiles: files.length, truncated }
}

export const CodebaseRetrievalTool = buildTool({
  name: CODEBASE_RETRIEVAL_TOOL_NAME,
  searchHint: 'semantic repository retrieval',
  maxResultSizeChars: 200_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Retrieving code'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.query} ${input.root ?? ''}`.trim()
  },
  async validateInput(input) {
    if (!input.query?.trim()) {
      return { result: false, message: 'CodebaseRetrieval requires a non-empty query.', errorCode: 1 }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    return renderText(input.query ? `Retrieving code for ${input.query}` : 'Retrieving code')
  },
  renderToolResultMessage(output) {
    return renderText(`${output.matches.length} match(es) from ${output.searchedFiles} file(s)`)
  },
  async call(input) {
    return { data: retrieveCodebase(input) }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `Query: ${output.query}`,
      `Root: ${output.root}`,
      `Searched files: ${output.searchedFiles}${output.truncated ? ' (truncated)' : ''}`,
      '',
      'Matches:',
      ...(output.matches.length
        ? output.matches.flatMap(match => [
            `- ${match.relativePath} (score ${match.score}): ${match.reason}`,
            ...(match.snippet ? [`  snippet: ${match.snippet}`] : []),
          ])
        : ['- none found']),
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
