import { existsSync, readdirSync, statSync } from 'fs'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'path'
import { createElement } from 'react'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { TEST_SEARCH_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Find likely source/test counterparts for a file using repository naming conventions. Read-only.'

const PROMPT = `Find likely related test files for a source file, or likely source files for a test file. This tool is read-only and uses local filename/path heuristics.

Use when editing code, triaging a failing test, or deciding what focused tests to run. Pair with ProjectWorkflow to choose the actual test command.`

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
])

const TEST_SEGMENTS = new Set([
  '__tests__',
  '__test__',
  'tests',
  'test',
  'spec',
  'specs',
])

const inputSchema = lazySchema(() =>
  z.strictObject({
    filePath: z
      .string()
      .min(1)
      .describe('Source or test file path, absolute or relative to the current working directory.'),
    root: z
      .string()
      .optional()
      .describe('Repository root to search. Defaults to the current working directory.'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum matches to return. Defaults to 10.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const matchSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  score: z.number(),
  reason: z.string(),
})

const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string(),
    root: z.string(),
    targetKind: z.string(),
    matches: z.array(matchSchema),
    searchedFiles: z.number(),
    truncated: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
type Match = z.infer<typeof matchSchema>

function safeStat(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function resolvePath(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path)
}

function stripKnownExtensions(file: string): string {
  let name = file
  for (let i = 0; i < 3; i++) {
    const ext = extname(name)
    if (!ext) break
    name = name.slice(0, -ext.length)
  }
  return name
}

function normalizeStem(file: string): string {
  return stripKnownExtensions(basename(file))
    .replace(/\.(test|spec|unit|e2e|integration)$/i, '')
    .replace(/[-_](test|spec|unit|e2e|integration)$/i, '')
    .replace(/^(test|spec)[-_]/i, '')
    .toLowerCase()
}

function pathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean).map(part => part.toLowerCase())
}

function isTestPath(path: string): boolean {
  const lower = path.toLowerCase()
  if (/\.(test|spec|unit|e2e|integration)\.[^.]+$/.test(lower)) return true
  if (/[-_](test|spec|unit|e2e|integration)\.[^.]+$/.test(lower)) return true
  return pathParts(path).some(part => TEST_SEGMENTS.has(part))
}

function walkFiles(root: string, maxFiles: number): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false

  function walk(dir: string): void {
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
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
        continue
      }
      if (entry.isFile()) files.push(join(dir, entry.name))
    }
  }

  walk(root)
  return { files, truncated }
}

function scoreCandidate(target: string, candidate: string): Match | null {
  if (resolve(target) === resolve(candidate)) return null

  const targetStem = normalizeStem(target)
  const candidateStem = normalizeStem(candidate)
  const targetIsTest = isTestPath(target)
  const candidateIsTest = isTestPath(candidate)
  const reasons: string[] = []
  let score = 0

  if (targetStem === candidateStem) {
    score += 70
    reasons.push('same normalized filename')
  } else if (
    candidateStem.includes(targetStem) ||
    targetStem.includes(candidateStem)
  ) {
    score += 35
    reasons.push('similar filename')
  }

  if (targetIsTest !== candidateIsTest) {
    score += 35
    reasons.push(targetIsTest ? 'candidate looks like source' : 'candidate looks like test')
  } else if (targetIsTest && candidateIsTest) {
    score += 10
    reasons.push('related test file')
  }

  if (dirname(target) === dirname(candidate)) {
    score += 20
    reasons.push('same directory')
  } else {
    const targetParent = basename(dirname(target)).toLowerCase()
    const candidateParts = pathParts(dirname(candidate))
    if (candidateParts.includes(targetParent)) {
      score += 10
      reasons.push('near matching directory')
    }
  }

  if (candidateIsTest) {
    score += 10
    reasons.push('test naming convention')
  }

  if (score < 50) return null

  return {
    path: candidate,
    relativePath: relative(getCwd(), candidate),
    score,
    reason: reasons.join(', '),
  }
}

export const TestSearchTool = buildTool({
  name: TEST_SEARCH_TOOL_NAME,
  searchHint: 'find related source tests',
  maxResultSizeChars: 100_000,
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
    return 'Finding tests'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  getPath(input) {
    return input.filePath
  },
  toAutoClassifierInput(input) {
    return `${input.filePath} ${input.root ?? ''}`.trim()
  },
  async validateInput(input) {
    if (!input.filePath?.trim()) {
      return {
        result: false,
        message: 'TestSearch requires a non-empty filePath.',
        errorCode: 1,
      }
    }
    if (input.root !== undefined && !input.root.trim()) {
      return {
        result: false,
        message: 'TestSearch root must be non-empty when provided.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    return renderText(
      input.filePath
        ? `Finding related tests for ${input.filePath}`
        : 'Finding related tests',
    )
  },
  renderToolResultMessage(output) {
    return renderText(
      `${output.matches.length} match(es) from ${output.searchedFiles} file(s)`,
    )
  },
  async call(input) {
    const cwd = getCwd()
    const root = resolvePath(input.root ?? cwd, cwd)
    const target = resolvePath(input.filePath, cwd)
    const maxResults = input.maxResults ?? 10
    const stat = safeStat(root)
    const { files, truncated } =
      existsSync(root) && stat?.isDirectory()
        ? walkFiles(root, 20_000)
        : { files: [], truncated: false }

    const matches = files
      .map(file => scoreCandidate(target, file))
      .filter((match): match is Match => match !== null)
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, maxResults)

    return {
      data: {
        filePath: target,
        root,
        targetKind: isTestPath(target) ? 'test' : 'source',
        matches,
        searchedFiles: files.length,
        truncated,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `File: ${output.filePath}`,
      `Root: ${output.root}`,
      `Target kind: ${output.targetKind}`,
      `Searched files: ${output.searchedFiles}${output.truncated ? ' (truncated)' : ''}`,
      '',
      'Matches:',
      ...(output.matches.length > 0
        ? output.matches.map(
            match =>
              `- ${match.relativePath} (score ${match.score}): ${match.reason}`,
          )
        : [
            '- none found. Use ProjectWorkflow to identify test commands, then run focused tests by package or directory if available.',
          ]),
    ]
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
