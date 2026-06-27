import { execFile } from 'child_process'
import { createElement } from 'react'
import { isAbsolute, resolve } from 'path'
import { promisify } from 'util'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { GIT_HISTORY_SEARCH_TOOL_NAME } from './constants.js'

const execFileAsync = promisify(execFile)

const DESCRIPTION =
  'Search git history for prior solutions, related commits, and file evolution. Read-only.'

const PROMPT = `Search local git history and return relevant commits or a bounded git show. This tool is read-only and never changes branches, refs, or files.

Use when asking "how was this solved before?", tracing regressions, understanding why code changed, or finding prior implementation patterns before editing.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .optional()
      .describe('Search query for commit messages and changed paths. Required unless commit is provided.'),
    commit: z
      .string()
      .optional()
      .describe('Commit SHA/ref to inspect with git show.'),
    root: z
      .string()
      .optional()
      .describe('Repository directory. Defaults to current working directory.'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Maximum search results. Defaults to 10.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const commitSchema = z.object({
  hash: z.string(),
  date: z.string(),
  author: z.string(),
  subject: z.string(),
  files: z.array(z.string()),
  score: z.number(),
})

const outputSchema = lazySchema(() =>
  z.object({
    root: z.string(),
    query: z.string().optional(),
    commit: z.string().optional(),
    matches: z.array(commitSchema),
    show: z.string().optional(),
    warning: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
type CommitMatch = z.infer<typeof commitSchema>

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

function resolveRoot(root: string | undefined): string {
  const cwd = getCwd()
  const value = root?.trim() ? root.trim() : cwd
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/i)
        .filter(t => t.length >= 2),
    ),
  ]
}

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 20_000,
  })
  return stdout
}

function parseLog(output: string, terms: string[]): CommitMatch[] {
  const commits: CommitMatch[] = []
  let current: CommitMatch | null = null
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('__TAU_COMMIT__')) {
      if (current) commits.push(current)
      const [, hash, date, author, subject] = line.split('\t')
      current = {
        hash: hash ?? '',
        date: date ?? '',
        author: author ?? '',
        subject: subject ?? '',
        files: [],
        score: 0,
      }
      continue
    }
    if (current && line.trim()) current.files.push(line.trim())
  }
  if (current) commits.push(current)

  for (const commit of commits) {
    const haystack = `${commit.subject}\n${commit.files.join('\n')}`.toLowerCase()
    for (const term of terms) {
      if (commit.subject.toLowerCase().includes(term)) commit.score += 12
      if (commit.files.some(file => file.toLowerCase().includes(term))) commit.score += 8
      const occurrences = haystack.split(term).length - 1
      commit.score += Math.min(occurrences, 4)
    }
  }
  return commits.filter(c => c.score > 0)
}

export const GitHistorySearchTool = buildTool({
  name: GIT_HISTORY_SEARCH_TOOL_NAME,
  searchHint: 'search git commit history',
  maxResultSizeChars: 250_000,
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
    return 'Searching git history'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.query ?? ''} ${input.commit ?? ''} ${input.root ?? ''}`.trim()
  },
  async validateInput(input) {
    if (!input.query?.trim() && !input.commit?.trim()) {
      return { result: false, message: 'GitHistorySearch requires query or commit.', errorCode: 1 }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    return renderText(input.commit ? `Showing ${input.commit}` : `Searching git history for ${input.query ?? ''}`)
  },
  renderToolResultMessage(output) {
    return renderText(output.show ? `Showed ${output.commit}` : `${output.matches.length} commit match(es)`)
  },
  async call(input) {
    const root = resolveRoot(input.root)
    if (input.commit?.trim()) {
      try {
        const show = await runGit(root, [
          'show',
          '--stat',
          '--patch',
          '--find-renames',
          '--find-copies',
          '--max-count=1',
          input.commit.trim(),
        ])
        return {
          data: {
            root,
            commit: input.commit.trim(),
            matches: [],
            show: show.length > 120_000 ? `${show.slice(0, 120_000)}\n...[truncated]` : show,
          },
        }
      } catch (e) {
        return { data: { root, commit: input.commit.trim(), matches: [], warning: e instanceof Error ? e.message : String(e) } }
      }
    }

    const query = input.query?.trim() ?? ''
    const terms = tokenize(query)
    try {
      const log = await runGit(root, [
        'log',
        '--all',
        '--date=short',
        '--pretty=format:__TAU_COMMIT__%x09%H%x09%ad%x09%an%x09%s',
        '--name-only',
        '-n',
        '500',
      ])
      const matches = parseLog(log, terms)
        .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
        .slice(0, input.maxResults ?? 10)
      return { data: { root, query, matches } }
    } catch (e) {
      return { data: { root, query, matches: [], warning: e instanceof Error ? e.message : String(e) } }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = output.show
      ? [`Root: ${output.root}`, `Commit: ${output.commit}`, '', output.show]
      : [
          `Root: ${output.root}`,
          `Query: ${output.query ?? ''}`,
          ...(output.warning ? [`Warning: ${output.warning}`] : []),
          '',
          'Matches:',
          ...(output.matches.length
            ? output.matches.flatMap(c => [
                `- ${c.hash.slice(0, 12)} ${c.date} ${c.author}: ${c.subject} (score ${c.score})`,
                ...(c.files.length ? [`  files: ${c.files.slice(0, 8).join(', ')}${c.files.length > 8 ? ', ...' : ''}`] : []),
              ])
            : ['- none found']),
        ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
