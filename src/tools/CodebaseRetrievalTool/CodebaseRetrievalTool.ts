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

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.turbo',
  'vendor',
  '__pycache__',
])

const TEXT_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.cs',
  '.php',
  '.rb',
  '.swift',
  '.vue',
  '.svelte',
  '.html',
  '.css',
  '.scss',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.mdx',
  '.sql',
])

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

function walk(root: string, maxFiles: number): { files: string[]; truncated: boolean } {
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
      } else if (entry.isFile() && TEXT_EXTS.has(extname(entry.name).toLowerCase())) {
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
    return { data: { query: input.query, root, matches, searchedFiles: files.length, truncated } }
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
