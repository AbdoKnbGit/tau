/**
 * Files are loaded in the following order:
 *
 * 1. Managed memory (eg. /etc/claude-code/CLAUDE.md) - Global instructions for all users
 * 2. User memory (~/.claude/CLAUDE.md) - Private global instructions for all projects
 * 3. Project memory (CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md, and AGENTS.md in project roots) - Instructions checked into the codebase
 * 4. Local memory (CLAUDE.local.md in project roots) - Private project-specific instructions
 *
 * Files are loaded in reverse order of priority, i.e. the latest files are highest priority
 * with the model paying more attention to them.
 *
 * File discovery:
 * - User memory is loaded from the user's home directory
 * - Project and Local files are discovered by traversing from the current directory up to root
 * - Files closer to the current directory have higher priority (loaded later)
 * - CLAUDE.md, .claude/CLAUDE.md, all .md files in .claude/rules/, and AGENTS.md are checked in each directory for Project memory
 * - AGENTS.md is the cross-vendor convention (Codex, Cursor, Zed); it is read last in each directory and skipped when its content duplicates a CLAUDE.md already loaded
 *
 * Rules written by other coding agents (project-scoped only; their user-level
 * locations are deliberately not read):
 * - .cursor/rules/*.mdc, .github/instructions/*.instructions.md and
 *   .windsurf/rules/*.md are always scanned. Each file is classified by its own
 *   tool's semantics, so a path-scoped rule joins the lazy set and costs nothing
 *   until a matching file is touched, and a rule its author left dormant
 *   (a Cursor Agent-Requested rule, a Copilot file with no applyTo) is skipped
 *   rather than promoted into the always-on prompt
 * - .github/copilot-instructions.md, .clinerules and .windsurfrules are
 *   whole-project files, read only when a directory has no native instructions
 *   and only until the first one hits — a repo that collected several across
 *   tool migrations would otherwise pay for near-identical guidance on every
 *   request
 * - See foreignRuleFormats.ts for the per-tool dialects
 *
 * Memory @include directive:
 * - Memory files can include other files using @ notation
 * - Syntax: @path, @./relative/path, @~/home/path, or @/absolute/path
 * - @path (without prefix) is treated as a relative path (same as @./path)
 * - Works in leaf text nodes only (not inside code blocks or code strings)
 * - Included files are added as separate entries before the including file
 * - Circular references are prevented by tracking processed files
 * - Non-existent files are silently ignored
 */

import { feature } from 'bun:bundle'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { Lexer } from 'marked'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  sep,
} from 'path'
import picomatch from 'picomatch'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  getOriginalCwd,
} from '../bootstrap/state.js'
import { truncateEntrypointContent } from '../memdir/memdir.js'
import { getAutoMemEntrypoint, isAutoMemoryEnabled } from '../memdir/paths.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getCurrentProjectConfig,
  getManagedClaudeRulesDir,
  getMemoryPath,
  getUserClaudeRulesDir,
} from './config.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { normalizePathForComparison } from './file.js'
import { cacheKeys, type FileStateCache } from './fileStateCache.js'
import { parseFrontmatter } from './frontmatterParser.js'
import {
  classifyForeignRule,
  dialectForPath,
  FOREIGN_GENERIC_SOURCES,
  FOREIGN_RULE_DIR_SOURCES,
  NATIVE_DIALECT,
} from './foreignRuleFormats.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import {
  executeInstructionsLoadedHooks,
  hasInstructionsLoadedHook,
  type InstructionsLoadReason,
  type InstructionsMemoryType,
} from './hooks.js'
import type { MemoryType } from './memory/types.js'
import { expandPath } from './path.js'
import { pathInWorkingPath } from './permissions/filesystem.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import { getInitialSettings } from './settings/settings.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

let hasLoggedInitialLoad = false

const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'
// Recommended max character count for a memory file
export const MAX_MEMORY_CHARACTER_COUNT = 40000

// File extensions that are allowed for @include directives
// This prevents binary files (images, PDFs, etc.) from being loaded into memory
const TEXT_FILE_EXTENSIONS = new Set([
  // Markdown and text
  '.md',
  // Cursor rule files: markdown with YAML frontmatter
  '.mdc',
  '.txt',
  '.text',
  // Data formats
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  // Web
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  // JavaScript/TypeScript
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  // Python
  '.py',
  '.pyi',
  '.pyw',
  // Ruby
  '.rb',
  '.erb',
  '.rake',
  // Go
  '.go',
  // Rust
  '.rs',
  // Java/Kotlin/Scala
  '.java',
  '.kt',
  '.kts',
  '.scala',
  // C/C++
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.hxx',
  // C#
  '.cs',
  // Swift
  '.swift',
  // Shell
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  // Config
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.config',
  '.properties',
  // Database
  '.sql',
  '.graphql',
  '.gql',
  // Protocol
  '.proto',
  // Frontend frameworks
  '.vue',
  '.svelte',
  '.astro',
  // Templating
  '.ejs',
  '.hbs',
  '.pug',
  '.jade',
  // Other languages
  '.php',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.R',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.cljs',
  '.cljc',
  '.edn',
  '.hs',
  '.lhs',
  '.elm',
  '.ml',
  '.mli',
  '.f',
  '.f90',
  '.f95',
  '.for',
  // Build files
  '.cmake',
  '.make',
  '.makefile',
  '.gradle',
  '.sbt',
  // Documentation
  '.rst',
  '.adoc',
  '.asciidoc',
  '.org',
  '.tex',
  '.latex',
  // Lock files (often text-based)
  '.lock',
  // Misc
  '.log',
  '.diff',
  '.patch',
])

export type MemoryFileInfo = {
  path: string
  type: MemoryType
  content: string
  parent?: string // Path of the file that included this one
  globs?: string[] // Glob patterns for file paths this rule applies to
  // True when auto-injection transformed `content` (stripped HTML comments,
  // stripped frontmatter, truncated MEMORY.md) such that it no longer matches
  // the bytes on disk. When set, `rawContent` holds the unmodified disk bytes
  // so callers can cache a `isPartialView` readFileState entry — presence in
  // cache provides dedup + change detection, but Edit/Write still require an
  // explicit Read before proceeding.
  contentDiffersFromDisk?: boolean
  rawContent?: string
}

function pathInOriginalCwd(path: string): boolean {
  return pathInWorkingPath(path, getOriginalCwd())
}

/**
 * Parses raw content to extract both content and glob patterns from frontmatter
 *
 * `filePath` selects the rule dialect. Files outside a foreign tool's rule
 * directory read as native, where only `paths:` scopes a rule and an unscoped
 * rule is unconditional — byte-identical to the behavior before other dialects
 * were understood. A file inside one (Cursor `globs:`, Copilot `applyTo:`,
 * Windsurf `trigger:`) is classified by that tool's own semantics, which
 * includes tools whose unscoped rules are dormant rather than always-on.
 *
 * @param rawContent Raw file content with frontmatter
 * @param filePath Absolute path, used to pick the dialect
 * @returns Content plus globs, or `inert` when the rule should not load at all
 */
function parseFrontmatterPaths(
  rawContent: string,
  filePath?: string,
): {
  content: string
  paths?: string[]
  inert?: string
} {
  const { frontmatter, content } = parseFrontmatter(rawContent)
  const dialect =
    filePath !== undefined ? dialectForPath(filePath) : NATIVE_DIALECT

  const activation = classifyForeignRule(
    frontmatter as Record<string, unknown>,
    dialect,
  )
  if (activation.kind === 'inert') {
    return { content, inert: activation.reason }
  }
  if (activation.kind === 'conditional') {
    return { content, paths: activation.paths }
  }
  return { content }
}

/**
 * Strip block-level HTML comments (<!-- ... -->) from markdown content.
 *
 * Uses the marked lexer to identify comments at the block level only, so
 * comments inside inline code spans and fenced code blocks are preserved.
 * Inline HTML comments inside a paragraph are also left intact; the intended
 * use case is authorial notes that occupy their own lines.
 *
 * Unclosed comments (`<!--` with no matching `-->`) are left in place so a
 * typo doesn't silently swallow the rest of the file.
 */
export function stripHtmlComments(content: string): {
  content: string
  stripped: boolean
} {
  if (!content.includes('<!--')) {
    return { content, stripped: false }
  }
  // gfm:false is fine here — html-block detection is a CommonMark rule.
  return stripHtmlCommentsFromTokens(new Lexer({ gfm: false }).lex(content))
}

function stripHtmlCommentsFromTokens(tokens: ReturnType<Lexer['lex']>): {
  content: string
  stripped: boolean
} {
  let result = ''
  let stripped = false

  // A well-formed HTML comment span. Non-greedy so multiple comments on the
  // same line are matched independently; [\s\S] to span newlines.
  const commentSpan = /<!--[\s\S]*?-->/g

  for (const token of tokens) {
    if (token.type === 'html') {
      const trimmed = token.raw.trimStart()
      if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
        // Per CommonMark, a type-2 HTML block ends at the *line* containing
        // `-->`, so text after `-->` on that line is part of this token.
        // Strip only the comment spans and keep any residual content.
        const residue = token.raw.replace(commentSpan, '')
        stripped = true
        if (residue.trim().length > 0) {
          // Residual content exists (e.g. `<!-- note --> Use bun`): keep it.
          result += residue
        }
        continue
      }
    }
    result += token.raw
  }

  return { content: result, stripped }
}

/**
 * Parses raw memory file content into a MemoryFileInfo. Pure function — no I/O.
 *
 * When includeBasePath is given, @include paths are resolved in the same lex
 * pass and returned alongside the parsed file (so processMemoryFile doesn't
 * need to lex the same content a second time).
 */
function parseMemoryFileContent(
  rawContent: string,
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
  reachedViaInclude: boolean = false,
): { info: MemoryFileInfo | null; includePaths: string[] } {
  // Skip non-text files to prevent loading binary data (images, PDFs, etc.) into memory
  const ext = extname(filePath).toLowerCase()
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
    logForDebugging(`Skipping non-text file in @include: ${filePath}`)
    return { info: null, includePaths: [] }
  }

  // A file pulled in by an explicit `@include` is a direct request, so it keeps
  // native semantics wherever it happens to live. Passing no path selects the
  // native dialect; without that, an include pointing into a foreign rules
  // directory would inherit that tool's dialect and could be classified
  // dormant, silently dropping content the author asked for by name.
  const {
    content: withoutFrontmatter,
    paths,
    inert,
  } = parseFrontmatterPaths(
    rawContent,
    reachedViaInclude ? undefined : filePath,
  )

  // The rule's own tool leaves it dormant until asked for (a Cursor
  // Agent-Requested/Manual rule, a Copilot instruction file with no applyTo).
  // Loading it would promote it into the always-on set, which is the opposite
  // of what its author selected.
  if (inert !== undefined) {
    logForDebugging(`Skipping dormant rule (${inert}): ${filePath}`)
    return { info: null, includePaths: [] }
  }

  // Lex once so strip and @include-extract share the same tokens. gfm:false
  // is required by extract (so ~/path doesn't tokenize as strikethrough) and
  // doesn't affect strip (html blocks are a CommonMark rule).
  const hasComment = withoutFrontmatter.includes('<!--')
  const tokens =
    hasComment || includeBasePath !== undefined
      ? new Lexer({ gfm: false }).lex(withoutFrontmatter)
      : undefined

  // Only rebuild via tokens when a comment actually needs stripping —
  // marked normalises \r\n during lex, so round-tripping a CRLF file
  // through token.raw would spuriously flip contentDiffersFromDisk.
  const strippedContent =
    hasComment && tokens
      ? stripHtmlCommentsFromTokens(tokens).content
      : withoutFrontmatter

  const includePaths =
    tokens && includeBasePath !== undefined
      ? extractIncludePathsFromTokens(tokens, includeBasePath)
      : []

  // Truncate MEMORY.md entrypoints to the line AND byte caps
  let finalContent = strippedContent
  if (type === 'AutoMem' || type === 'TeamMem') {
    finalContent = truncateEntrypointContent(strippedContent).content
  }

  // Covers frontmatter strip, HTML comment strip, and MEMORY.md truncation
  const contentDiffersFromDisk = finalContent !== rawContent
  return {
    info: {
      path: filePath,
      type,
      content: finalContent,
      globs: paths,
      contentDiffersFromDisk,
      rawContent: contentDiffersFromDisk ? rawContent : undefined,
    },
    includePaths,
  }
}

function handleMemoryFileReadError(error: unknown, filePath: string): void {
  const code = getErrnoCode(error)
  // ENOENT = file doesn't exist, EISDIR = is a directory — both expected
  if (code === 'ENOENT' || code === 'EISDIR') {
    return
  }
  // Log permission errors (EACCES) as they're actionable
  if (code === 'EACCES') {
    // Don't log the full file path to avoid PII/security issues
    logEvent('tengu_claude_md_permission_error', {
      is_access_error: 1,
      has_home_dir: filePath.includes(getClaudeConfigHomeDir()) ? 1 : 0,
    })
  }
}

/**
 * Used by processMemoryFile → getMemoryFiles so the event loop stays
 * responsive during the directory walk (many readFile attempts, most
 * ENOENT). When includeBasePath is given, @include paths are resolved in
 * the same lex pass and returned alongside the parsed file.
 */
async function safelyReadMemoryFileAsync(
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
  reachedViaInclude: boolean = false,
): Promise<{ info: MemoryFileInfo | null; includePaths: string[] }> {
  try {
    const fs = getFsImplementation()
    const rawContent = await fs.readFile(filePath, { encoding: 'utf-8' })
    return parseMemoryFileContent(
      rawContent,
      filePath,
      type,
      includeBasePath,
      reachedViaInclude,
    )
  } catch (error) {
    handleMemoryFileReadError(error, filePath)
    return { info: null, includePaths: [] }
  }
}

type MarkdownToken = {
  type: string
  text?: string
  href?: string
  tokens?: MarkdownToken[]
  raw?: string
  items?: MarkdownToken[]
}

// Extract @path include references from pre-lexed tokens and resolve to
// absolute paths. Skips html tokens so @paths inside block comments are
// ignored — the caller may pass pre-strip tokens.
function extractIncludePathsFromTokens(
  tokens: ReturnType<Lexer['lex']>,
  basePath: string,
): string[] {
  const absolutePaths = new Set<string>()

  // Extract @paths from a text string and add resolved paths to absolutePaths.
  function extractPathsFromText(textContent: string) {
    const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
    let match
    while ((match = includeRegex.exec(textContent)) !== null) {
      let path = match[1]
      if (!path) continue

      // Strip fragment identifiers (#heading, #section-name, etc.)
      const hashIndex = path.indexOf('#')
      if (hashIndex !== -1) {
        path = path.substring(0, hashIndex)
      }
      if (!path) continue

      // Unescape the spaces in the path
      path = path.replace(/\\ /g, ' ')

      // Accept @path, @./path, @~/path, or @/path
      if (path) {
        const isValidPath =
          path.startsWith('./') ||
          path.startsWith('~/') ||
          (path.startsWith('/') && path !== '/') ||
          (!path.startsWith('@') &&
            !path.match(/^[#%^&*()]+/) &&
            path.match(/^[a-zA-Z0-9._-]/))

        if (isValidPath) {
          const resolvedPath = expandPath(path, dirname(basePath))
          absolutePaths.add(resolvedPath)
        }
      }
    }
  }

  // Recursively process elements to find text nodes
  function processElements(elements: MarkdownToken[]) {
    for (const element of elements) {
      if (element.type === 'code' || element.type === 'codespan') {
        continue
      }

      // For html tokens that contain comments, strip the comment spans and
      // check the residual for @paths (e.g. `<!-- note --> @./file.md`).
      // Other html tokens (non-comment tags) are skipped entirely.
      if (element.type === 'html') {
        const raw = element.raw || ''
        const trimmed = raw.trimStart()
        if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
          const commentSpan = /<!--[\s\S]*?-->/g
          const residue = raw.replace(commentSpan, '')
          if (residue.trim().length > 0) {
            extractPathsFromText(residue)
          }
        }
        continue
      }

      // Process text nodes
      if (element.type === 'text') {
        extractPathsFromText(element.text || '')
      }

      // Recurse into children tokens
      if (element.tokens) {
        processElements(element.tokens)
      }

      // Special handling for list structures
      if (element.items) {
        processElements(element.items)
      }
    }
  }

  processElements(tokens as MarkdownToken[])
  return [...absolutePaths]
}

const MAX_INCLUDE_DEPTH = 5

/**
 * Checks whether a CLAUDE.md file path is excluded by the claudeMdExcludes setting.
 * Only applies to User, Project, and Local memory types.
 * Managed, AutoMem, and TeamMem types are never excluded.
 *
 * Matches both the original path and the realpath-resolved path to handle symlinks
 * (e.g., /tmp -> /private/tmp on macOS).
 */
function isClaudeMdExcluded(filePath: string, type: MemoryType): boolean {
  if (type !== 'User' && type !== 'Project' && type !== 'Local') {
    return false
  }

  const patterns = getInitialSettings().claudeMdExcludes
  if (!patterns || patterns.length === 0) {
    return false
  }

  const matchOpts = { dot: true }
  const normalizedPath = filePath.replaceAll('\\', '/')

  // Build an expanded pattern list that includes realpath-resolved versions of
  // absolute patterns. This handles symlinks like /tmp -> /private/tmp on macOS:
  // the user writes "/tmp/project/CLAUDE.md" in their exclude, but the system
  // resolves the CWD to "/private/tmp/project/...", so the file path uses the
  // real path. By resolving the patterns too, both sides match.
  const expandedPatterns = resolveExcludePatterns(patterns).filter(
    p => p.length > 0,
  )
  if (expandedPatterns.length === 0) {
    return false
  }

  return picomatch.isMatch(normalizedPath, expandedPatterns, matchOpts)
}

/**
 * Expands exclude patterns by resolving symlinks in absolute path prefixes.
 * For each absolute pattern (starting with /), tries to resolve the longest
 * existing directory prefix via realpathSync and adds the resolved version.
 * Glob patterns (containing *) have their static prefix resolved.
 */
function resolveExcludePatterns(patterns: string[]): string[] {
  const fs = getFsImplementation()
  const expanded: string[] = patterns.map(p => p.replaceAll('\\', '/'))

  for (const normalized of expanded) {
    // Only resolve absolute patterns — glob-only patterns like "**/*.md" don't have
    // a filesystem prefix to resolve
    if (!normalized.startsWith('/')) {
      continue
    }

    // Find the static prefix before any glob characters
    const globStart = normalized.search(/[*?{[]/)
    const staticPrefix =
      globStart === -1 ? normalized : normalized.slice(0, globStart)
    const dirToResolve = dirname(staticPrefix)

    try {
      // sync IO: called from sync context (isClaudeMdExcluded -> processMemoryFile -> getMemoryFiles)
      const resolvedDir = fs.realpathSync(dirToResolve).replaceAll('\\', '/')
      if (resolvedDir !== dirToResolve) {
        const resolvedPattern =
          resolvedDir + normalized.slice(dirToResolve.length)
        expanded.push(resolvedPattern)
      }
    } catch {
      // Directory doesn't exist; skip resolution for this pattern
    }
  }

  return expanded
}

/**
 * Recursively processes a memory file and all its @include references
 * Returns an array of MemoryFileInfo objects with includes first, then main file
 */
export async function processMemoryFile(
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  depth: number = 0,
  parent?: string,
): Promise<MemoryFileInfo[]> {
  // Skip if already processed or max depth exceeded.
  // Normalize paths for comparison to handle Windows drive letter casing
  // differences (e.g., C:\Users vs c:\Users).
  const normalizedPath = normalizePathForComparison(filePath)
  if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
    return []
  }

  // Skip if path is excluded by claudeMdExcludes setting
  if (isClaudeMdExcluded(filePath, type)) {
    return []
  }

  // Resolve symlink path early for @import resolution
  const { resolvedPath, isSymlink } = safeResolvePath(
    getFsImplementation(),
    filePath,
  )

  processedPaths.add(normalizedPath)
  if (isSymlink) {
    processedPaths.add(normalizePathForComparison(resolvedPath))
  }

  const { info: memoryFile, includePaths: resolvedIncludePaths } =
    await safelyReadMemoryFileAsync(filePath, type, resolvedPath, depth > 0)
  if (!memoryFile || !memoryFile.content.trim()) {
    return []
  }

  // Add parent information
  if (parent) {
    memoryFile.parent = parent
  }

  const result: MemoryFileInfo[] = []

  // Add the main file first (parent before children)
  result.push(memoryFile)

  for (const resolvedIncludePath of resolvedIncludePaths) {
    const isExternal = !pathInOriginalCwd(resolvedIncludePath)
    if (isExternal && !includeExternal) {
      continue
    }

    // Recursively process included files with this file as parent
    const includedFiles = await processMemoryFile(
      resolvedIncludePath,
      type,
      processedPaths,
      includeExternal,
      depth + 1,
      filePath, // Pass current file as parent
    )
    result.push(...includedFiles)
  }

  return result
}

/**
 * Processes all .md files in the .claude/rules/ directory and its subdirectories
 * @param rulesDir The path to the rules directory
 * @param type Type of memory file (User, Project, Local)
 * @param processedPaths Set of already processed file paths
 * @param includeExternal Whether to include external files
 * @param conditionalRule If true, only include files with frontmatter paths; if false, only include files without frontmatter paths
 * @param visitedDirs Set of already visited directory real paths (for cycle detection)
 * @returns Array of MemoryFileInfo objects
 */
export async function processMdRules({
  rulesDir,
  type,
  processedPaths,
  includeExternal,
  conditionalRule,
  visitedDirs = new Set(),
  extensions = ['.md'],
}: {
  rulesDir: string
  type: MemoryType
  processedPaths: Set<string>
  includeExternal: boolean
  conditionalRule: boolean
  visitedDirs?: Set<string>
  /**
   * Filename suffixes to accept. Other tools name their rule files
   * differently (Cursor `.mdc`, Copilot `.instructions.md`), so the caller
   * supplies the set rather than the scan assuming `.md`.
   */
  extensions?: readonly string[]
}): Promise<MemoryFileInfo[]> {
  if (visitedDirs.has(rulesDir)) {
    return []
  }

  try {
    const fs = getFsImplementation()

    const { resolvedPath: resolvedRulesDir, isSymlink } = safeResolvePath(
      fs,
      rulesDir,
    )

    visitedDirs.add(rulesDir)
    if (isSymlink) {
      visitedDirs.add(resolvedRulesDir)
    }

    const result: MemoryFileInfo[] = []
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(resolvedRulesDir)
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
        return []
      }
      throw e
    }

    for (const entry of entries) {
      const entryPath = join(rulesDir, entry.name)
      const { resolvedPath: resolvedEntryPath, isSymlink } = safeResolvePath(
        fs,
        entryPath,
      )

      // Use Dirent methods for non-symlinks to avoid extra stat calls.
      // For symlinks, we need stat to determine what the target is.
      const stats = isSymlink ? await fs.stat(resolvedEntryPath) : null
      const isDirectory = stats ? stats.isDirectory() : entry.isDirectory()
      const isFile = stats ? stats.isFile() : entry.isFile()

      if (isDirectory) {
        result.push(
          ...(await processMdRules({
            rulesDir: resolvedEntryPath,
            type,
            processedPaths,
            includeExternal,
            conditionalRule,
            visitedDirs,
            extensions,
          })),
        )
      } else if (
        isFile &&
        extensions.some(extension => entry.name.endsWith(extension))
      ) {
        const files = await processMemoryFile(
          resolvedEntryPath,
          type,
          processedPaths,
          includeExternal,
        )
        result.push(
          ...files.filter(f => (conditionalRule ? f.globs : !f.globs)),
        )
      }
    }

    return result
  } catch (error) {
    if (error instanceof Error && error.message.includes('EACCES')) {
      logEvent('tengu_claude_rules_md_permission_error', {
        is_access_error: 1,
        has_home_dir: rulesDir.includes(getClaudeConfigHomeDir()) ? 1 : 0,
      })
    }
    return []
  }
}

/**
 * Reads `AGENTS.md` from `dir` in the same slot as CLAUDE.md.
 *
 * AGENTS.md is the instruction file Codex, Cursor, Zed and others already
 * write, so a team that has one gets their build commands and conventions
 * honored without converting anything.
 *
 * Probed after the CLAUDE.md sources so that CLAUDE.md wins the content dedup
 * below. Note this also places AGENTS.md later in the load order, and this
 * module treats later files as higher priority, so a repo carrying both gives
 * AGENTS.md slightly more weight. The two orderings cannot both be satisfied
 * without re-sorting after the walk; dedup correctness was chosen because it
 * is a hard guarantee while load order is a soft hint to the model.
 *
 * Content-deduped against what is already loaded. Repos routinely ship
 * AGENTS.md as a copy of — or a symlink to — CLAUDE.md, and the path dedup in
 * processMemoryFile does not catch that here: it tests the *link* path and
 * only then records the resolved path, so it dedupes a symlink solely when the
 * link is visited before its target. CLAUDE.md is probed first, so that
 * ordering never holds, and identical content would otherwise reach the prompt
 * twice. Dedup is scoped to this probe to leave every existing source's
 * behavior untouched.
 *
 * Opting out uses the existing `claudeMdExcludes` setting (e.g.
 * `"**\/AGENTS.md"`), which already covers every Project-type memory file.
 */
async function processAgentsMemoryFile(
  dir: string,
  alreadyLoaded: readonly MemoryFileInfo[],
  processedPaths: Set<string>,
  includeExternal: boolean,
): Promise<MemoryFileInfo[]> {
  const files = await processMemoryFile(
    join(dir, 'AGENTS.md'),
    'Project',
    processedPaths,
    includeExternal,
  )
  if (files.length === 0) {
    return files
  }
  const seenContent = new Set(alreadyLoaded.map(file => file.content))
  return files.filter(file => {
    if (seenContent.has(file.content)) {
      return false
    }
    seenContent.add(file.content)
    return true
  })
}

/**
 * Rule directories other tools keep under a project directory.
 *
 * `baseDir` is the root their globs are written against — the project
 * directory itself in every case — so a two-segment source (.cursor/rules)
 * and a one-segment one (.clinerules) resolve their patterns the same way.
 */
function foreignRuleDirSpecs(
  dir: string,
): Array<{ rulesDir: string; extensions: readonly string[] }> {
  return FOREIGN_RULE_DIR_SOURCES.map(source => ({
    rulesDir: join(dir, ...source.segments),
    extensions: source.extensions,
  }))
}

/**
 * Whether `dir` carries instructions tau reads natively.
 *
 * Used to gate the whole-project fallback files below. Deliberately a
 * filesystem predicate rather than "did anything load", so the eager and lazy
 * passes agree without threading state between them.
 */
async function hasNativeProjectInstructions(dir: string): Promise<boolean> {
  const fs = getFsImplementation()
  // Emptiness counts as absence. A zero-byte CLAUDE.md or a `.claude/rules`
  // holding nothing but a .gitkeep contributes no guidance, so letting either
  // suppress the fallback would leave the directory with no instructions at
  // all — worse than the duplication the gate exists to prevent.
  for (const name of ['CLAUDE.md', 'AGENTS.md', join('.claude', 'CLAUDE.md')]) {
    try {
      if ((await fs.stat(join(dir, name))).size > 0) return true
    } catch {
      // missing candidate; keep looking
    }
  }
  try {
    const entries = await fs.readdir(join(dir, '.claude', 'rules'))
    if (entries.some(entry => entry.name.endsWith('.md'))) return true
  } catch {
    // no rules directory
  }
  return false
}

/**
 * Reads rule files other coding agents maintain in `dir`.
 *
 * Two kinds of source, handled differently on purpose:
 *
 * Rule *directories* (.cursor/rules, .github/instructions, .windsurf/rules)
 * are always scanned. Each file is classified by its own tool's semantics, so
 * a scoped rule lands in the lazy set and costs nothing until a matching file
 * is touched, and a rule its author left dormant is skipped rather than
 * promoted into the always-on prompt.
 *
 * Whole-project *fallback* files (.github/copilot-instructions.md,
 * .clinerules, .windsurfrules) are read only when the directory has no native
 * instructions, and only the first one found wins. They all mean "apply to the
 * entire project", so a repo that collected several across tool migrations
 * would otherwise pay for near-identical guidance in its cached prefix on
 * every request; the file the current tool reads is the maintained one and the
 * rest are usually stale.
 */
async function processForeignProjectRules({
  dir,
  processedPaths,
  includeExternal,
  conditionalRule,
}: {
  dir: string
  processedPaths: Set<string>
  includeExternal: boolean
  conditionalRule: boolean
}): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  for (const { rulesDir, extensions } of foreignRuleDirSpecs(dir)) {
    result.push(
      ...(await processMdRules({
        rulesDir,
        type: 'Project',
        processedPaths,
        includeExternal,
        conditionalRule,
        extensions,
      })),
    )
  }

  if (await hasNativeProjectInstructions(dir)) {
    return result
  }

  const fs = getFsImplementation()
  for (const source of FOREIGN_GENERIC_SOURCES) {
    const candidate = join(dir, ...source.segments)
    // Only a `file-or-dir` source needs the stat; a plain file source skips it
    // and lets processMemoryFile report a missing path as "nothing loaded", so
    // the common case costs one syscall rather than two.
    let isDirectory = false
    try {
      isDirectory =
        source.shape === 'file-or-dir' &&
        (await fs.stat(candidate)).isDirectory()
    } catch {
      continue
    }

    const loaded = isDirectory
      ? await processMdRules({
          rulesDir: candidate,
          type: 'Project',
          processedPaths,
          includeExternal,
          conditionalRule,
          extensions: source.extensions,
        })
      : conditionalRule
        ? []
        : await processMemoryFile(
            candidate,
            'Project',
            processedPaths,
            includeExternal,
          )

    if (loaded.length > 0) {
      logForDebugging(
        `Using ${candidate} for project instructions; later fallbacks skipped`,
      )
      result.push(...loaded)
      break
    }
  }

  return result
}

/**
 * Foreign rules in `dir` whose globs match `targetPath`.
 *
 * The lazy half of `processForeignProjectRules`: a Cursor `globs:` rule or a
 * Copilot `applyTo:` instruction file attaches only once the model touches a
 * file it covers, so a repo full of path-scoped rules adds nothing to the
 * cached prompt prefix.
 */
async function processForeignConditionedRules(
  targetPath: string,
  dir: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  for (const { rulesDir, extensions } of foreignRuleDirSpecs(dir)) {
    result.push(
      ...(await processConditionedMdRules(
        targetPath,
        rulesDir,
        'Project',
        processedPaths,
        false,
        { extensions, baseDir: dir },
      )),
    )
  }

  // Only a directory-shaped fallback can hold path-scoped rules, so find one
  // before paying for the native-instructions probe. This path runs for every
  // cwd-level directory on every file the model touches, and the overwhelming
  // majority of repos have no such directory at all.
  const fs = getFsImplementation()
  const dirFallbacks: Array<{
    candidate: string
    extensions: readonly string[]
  }> = []
  for (const source of FOREIGN_GENERIC_SOURCES) {
    if (source.shape !== 'file-or-dir') continue
    const candidate = join(dir, ...source.segments)
    try {
      if (!(await fs.stat(candidate)).isDirectory()) continue
    } catch {
      continue
    }
    dirFallbacks.push({ candidate, extensions: source.extensions })
  }
  if (dirFallbacks.length === 0) {
    return result
  }
  if (await hasNativeProjectInstructions(dir)) {
    return result
  }

  for (const { candidate, extensions } of dirFallbacks) {
    result.push(
      ...(await processConditionedMdRules(
        targetPath,
        candidate,
        'Project',
        processedPaths,
        false,
        { extensions, baseDir: dir },
      )),
    )
    break
  }

  return result
}

export const getMemoryFiles = memoize(
  async (forceIncludeExternal: boolean = false): Promise<MemoryFileInfo[]> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'memory_files_started')

    const result: MemoryFileInfo[] = []
    const processedPaths = new Set<string>()
    const config = getCurrentProjectConfig()
    const includeExternal =
      forceIncludeExternal ||
      config.hasClaudeMdExternalIncludesApproved ||
      false

    // Process Managed file first (always loaded - policy settings)
    const managedClaudeMd = getMemoryPath('Managed')
    result.push(
      ...(await processMemoryFile(
        managedClaudeMd,
        'Managed',
        processedPaths,
        includeExternal,
      )),
    )
    // Process Managed .claude/rules/*.md files
    const managedClaudeRulesDir = getManagedClaudeRulesDir()
    result.push(
      ...(await processMdRules({
        rulesDir: managedClaudeRulesDir,
        type: 'Managed',
        processedPaths,
        includeExternal,
        conditionalRule: false,
      })),
    )

    // Process User file (only if userSettings is enabled)
    if (isSettingSourceEnabled('userSettings')) {
      const userClaudeMd = getMemoryPath('User')
      result.push(
        ...(await processMemoryFile(
          userClaudeMd,
          'User',
          processedPaths,
          true, // User memory can always include external files
        )),
      )
      // Process User ~/.claude/rules/*.md files
      const userClaudeRulesDir = getUserClaudeRulesDir()
      result.push(
        ...(await processMdRules({
          rulesDir: userClaudeRulesDir,
          type: 'User',
          processedPaths,
          includeExternal: true,
          conditionalRule: false,
        })),
      )
    }

    // Then process Project and Local files
    const dirs: string[] = []
    const originalCwd = getOriginalCwd()
    let currentDir = originalCwd

    while (currentDir !== parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = dirname(currentDir)
    }

    // When running from a git worktree nested inside its main repo (e.g.,
    // .claude/worktrees/<name>/ from `claude -w`), the upward walk passes
    // through both the worktree root and the main repo root. Both contain
    // checked-in files like CLAUDE.md and .claude/rules/*.md, so the same
    // content gets loaded twice. Skip Project-type (checked-in) files from
    // directories above the worktree but within the main repo — the worktree
    // already has its own checkout. CLAUDE.local.md is gitignored so it only
    // exists in the main repo and is still loaded.
    // See: https://github.com/anthropics/claude-code/issues/29599
    const gitRoot = findGitRoot(originalCwd)
    const canonicalRoot = findCanonicalGitRoot(originalCwd)
    const isNestedWorktree =
      gitRoot !== null &&
      canonicalRoot !== null &&
      normalizePathForComparison(gitRoot) !==
        normalizePathForComparison(canonicalRoot) &&
      pathInWorkingPath(gitRoot, canonicalRoot)

    // Process from root downward to CWD
    for (const dir of dirs.reverse()) {
      // In a nested worktree, skip checked-in files from the main repo's
      // working tree (dirs inside canonicalRoot but outside the worktree).
      const skipProject =
        isNestedWorktree &&
        pathInWorkingPath(dir, canonicalRoot) &&
        !pathInWorkingPath(dir, gitRoot)

      // Try reading CLAUDE.md (Project) - only if projectSettings is enabled
      if (isSettingSourceEnabled('projectSettings') && !skipProject) {
        // Read the native sources first so AGENTS.md can be deduped against
        // them, but push them last: this module treats later files as higher
        // priority, and a repo's own tau instructions should outrank rules it
        // inherited from another tool. Reading order and push order are
        // separated here precisely because those two needs disagree.
        const nativeFiles: MemoryFileInfo[] = [
          // CLAUDE.md (Project)
          ...(await processMemoryFile(
            join(dir, 'CLAUDE.md'),
            'Project',
            processedPaths,
            includeExternal,
          )),
          // .claude/CLAUDE.md (Project)
          ...(await processMemoryFile(
            join(dir, '.claude', 'CLAUDE.md'),
            'Project',
            processedPaths,
            includeExternal,
          )),
          // .claude/rules/*.md files (Project)
          ...(await processMdRules({
            rulesDir: join(dir, '.claude', 'rules'),
            type: 'Project',
            processedPaths,
            includeExternal,
            conditionalRule: false,
          })),
        ]

        // AGENTS.md (Project) - the cross-vendor convention. Deduped against
        // everything already loaded plus the native files just read, so a
        // repo whose AGENTS.md copies its CLAUDE.md keeps only CLAUDE.md.
        const agentsFiles = await processAgentsMemoryFile(
          dir,
          [...result, ...nativeFiles],
          processedPaths,
          includeExternal,
        )

        // Rule files other coding agents maintain in this directory
        const foreignFiles = await processForeignProjectRules({
          dir,
          processedPaths,
          includeExternal,
          conditionalRule: false,
        })

        result.push(...foreignFiles, ...agentsFiles, ...nativeFiles)
      }

      // Try reading CLAUDE.local.md (Local) - only if localSettings is enabled
      if (isSettingSourceEnabled('localSettings')) {
        const localPath = join(dir, 'CLAUDE.local.md')
        result.push(
          ...(await processMemoryFile(
            localPath,
            'Local',
            processedPaths,
            includeExternal,
          )),
        )
      }
    }

    // Process CLAUDE.md from additional directories (--add-dir) if env var is enabled
    // This is controlled by CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD and defaults to off
    // Note: we don't check isSettingSourceEnabled('projectSettings') here because --add-dir
    // is an explicit user action and the SDK defaults settingSources to [] when not specified
    if (isEnvTruthy(process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD)) {
      const additionalDirs = getAdditionalDirectoriesForClaudeMd()
      for (const dir of additionalDirs) {
        // Native sources read first (so AGENTS.md dedupes against them) and
        // pushed last (so they outrank foreign rules) — see the main walk.
        const nativeFiles: MemoryFileInfo[] = [
          ...(await processMemoryFile(
            join(dir, 'CLAUDE.md'),
            'Project',
            processedPaths,
            includeExternal,
          )),
          ...(await processMemoryFile(
            join(dir, '.claude', 'CLAUDE.md'),
            'Project',
            processedPaths,
            includeExternal,
          )),
          ...(await processMdRules({
            rulesDir: join(dir, '.claude', 'rules'),
            type: 'Project',
            processedPaths,
            includeExternal,
            conditionalRule: false,
          })),
        ]

        const agentsFiles = await processAgentsMemoryFile(
          dir,
          [...result, ...nativeFiles],
          processedPaths,
          includeExternal,
        )

        // Kept in step with the main walk so an --add-dir directory resolves
        // the same sources a project directory would.
        const foreignFiles = await processForeignProjectRules({
          dir,
          processedPaths,
          includeExternal,
          conditionalRule: false,
        })

        result.push(...foreignFiles, ...agentsFiles, ...nativeFiles)
      }
    }

    // Memdir entrypoint (memory.md) - only if feature is on and file exists
    if (isAutoMemoryEnabled()) {
      const { info: memdirEntry } = await safelyReadMemoryFileAsync(
        getAutoMemEntrypoint(),
        'AutoMem',
      )
      if (memdirEntry) {
        const normalizedPath = normalizePathForComparison(memdirEntry.path)
        if (!processedPaths.has(normalizedPath)) {
          processedPaths.add(normalizedPath)
          result.push(memdirEntry)
        }
      }
    }

    // Team memory entrypoint - only if feature is on and file exists
    if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) {
      const { info: teamMemEntry } = await safelyReadMemoryFileAsync(
        teamMemPaths!.getTeamMemEntrypoint(),
        'TeamMem',
      )
      if (teamMemEntry) {
        const normalizedPath = normalizePathForComparison(teamMemEntry.path)
        if (!processedPaths.has(normalizedPath)) {
          processedPaths.add(normalizedPath)
          result.push(teamMemEntry)
        }
      }
    }

    const totalContentLength = result.reduce(
      (sum, f) => sum + f.content.length,
      0,
    )

    logForDiagnosticsNoPII('info', 'memory_files_completed', {
      duration_ms: Date.now() - startTime,
      file_count: result.length,
      total_content_length: totalContentLength,
    })

    const typeCounts: Record<string, number> = {}
    for (const f of result) {
      typeCounts[f.type] = (typeCounts[f.type] ?? 0) + 1
    }

    if (!hasLoggedInitialLoad) {
      hasLoggedInitialLoad = true
      logEvent('tengu_claudemd__initial_load', {
        file_count: result.length,
        total_content_length: totalContentLength,
        user_count: typeCounts['User'] ?? 0,
        project_count: typeCounts['Project'] ?? 0,
        local_count: typeCounts['Local'] ?? 0,
        managed_count: typeCounts['Managed'] ?? 0,
        automem_count: typeCounts['AutoMem'] ?? 0,
        ...(feature('TEAMMEM')
          ? { teammem_count: typeCounts['TeamMem'] ?? 0 }
          : {}),
        duration_ms: Date.now() - startTime,
      })
    }

    // Fire InstructionsLoaded hook for each instruction file loaded
    // (fire-and-forget, audit/observability only).
    // AutoMem/TeamMem are intentionally excluded — they're a separate
    // memory system, not "instructions" in the CLAUDE.md/rules sense.
    // Gated on !forceIncludeExternal: the forceIncludeExternal=true variant
    // is only used by getExternalClaudeMdIncludes() for approval checks, not
    // for building context — firing the hook there would double-fire on startup.
    // The one-shot flag is consumed on every !forceIncludeExternal cache miss
    // (NOT gated on hasInstructionsLoadedHook) so the flag is released even
    // when no hook is configured — otherwise a mid-session hook registration
    // followed by a direct .cache.clear() would spuriously fire with a stale
    // 'session_start' reason.
    if (!forceIncludeExternal) {
      const eagerLoadReason = consumeNextEagerLoadReason()
      if (eagerLoadReason !== undefined && hasInstructionsLoadedHook()) {
        for (const file of result) {
          if (!isInstructionsMemoryType(file.type)) continue
          const loadReason = file.parent ? 'include' : eagerLoadReason
          void executeInstructionsLoadedHooks(
            file.path,
            file.type,
            loadReason,
            {
              globs: file.globs,
              parentFilePath: file.parent,
            },
          )
        }
      }
    }

    return result
  },
)

function isInstructionsMemoryType(
  type: MemoryType,
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

// Load reason to report for top-level (non-included) files on the next eager
// getMemoryFiles() pass. Set to 'compact' by resetGetMemoryFilesCache when
// compaction clears the cache, so the InstructionsLoaded hook reports the
// reload correctly instead of misreporting it as 'session_start'. One-shot:
// reset to 'session_start' after being read.
let nextEagerLoadReason: InstructionsLoadReason = 'session_start'

// Whether the InstructionsLoaded hook should fire on the next cache miss.
// true initially (for session_start), consumed after firing, re-enabled only
// by resetGetMemoryFilesCache(). Callers that only need cache invalidation
// for correctness (e.g. worktree enter/exit, settings sync, /memory dialog)
// should use clearMemoryFileCaches() instead to avoid spurious hook fires.
let shouldFireHook = true

function consumeNextEagerLoadReason(): InstructionsLoadReason | undefined {
  if (!shouldFireHook) return undefined
  shouldFireHook = false
  const reason = nextEagerLoadReason
  nextEagerLoadReason = 'session_start'
  return reason
}

/**
 * Clears the getMemoryFiles memoize cache
 * without firing the InstructionsLoaded hook.
 *
 * Use this for cache invalidation that is purely for correctness (e.g.
 * worktree enter/exit, settings sync, /memory dialog). For events that
 * represent instructions actually being reloaded into context (e.g.
 * compaction), use resetGetMemoryFilesCache() instead.
 */
export function clearMemoryFileCaches(): void {
  // ?.cache because tests spyOn this, which replaces the memoize wrapper.
  getMemoryFiles.cache?.clear?.()
}

export function resetGetMemoryFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}

export function getLargeMemoryFiles(files: MemoryFileInfo[]): MemoryFileInfo[] {
  return files.filter(f => f.content.length > MAX_MEMORY_CHARACTER_COUNT)
}

/**
 * When tengu_moth_copse is on, the findRelevantMemories prefetch surfaces
 * memory files via attachments, so the MEMORY.md index is no longer injected
 * into the system prompt. Callsites that care about "what's actually in
 * context" (context builder, /context viz) should filter through this.
 */
export function filterInjectedMemoryFiles(
  files: MemoryFileInfo[],
): MemoryFileInfo[] {
  const skipMemoryIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )
  if (!skipMemoryIndex) return files
  return files.filter(f => f.type !== 'AutoMem' && f.type !== 'TeamMem')
}

export const getClaudeMds = (
  memoryFiles: MemoryFileInfo[],
  filter?: (type: MemoryType) => boolean,
): string => {
  const memories: string[] = []
  const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_paper_halyard',
    false,
  )

  for (const file of memoryFiles) {
    if (filter && !filter(file.type)) continue
    if (skipProjectLevel && (file.type === 'Project' || file.type === 'Local'))
      continue
    if (file.content) {
      const description =
        file.type === 'Project'
          ? ' (project instructions, checked into the codebase)'
          : file.type === 'Local'
            ? " (user's private project instructions, not checked in)"
            : feature('TEAMMEM') && file.type === 'TeamMem'
              ? ' (shared team memory, synced across the organization)'
              : file.type === 'AutoMem'
                ? " (user's auto-memory, persists across conversations)"
                : " (user's private global instructions for all projects)"

      const content = file.content.trim()
      if (feature('TEAMMEM') && file.type === 'TeamMem') {
        memories.push(
          `Contents of ${file.path}${description}:\n\n<team-memory-content source="shared">\n${content}\n</team-memory-content>`,
        )
      } else {
        memories.push(`Contents of ${file.path}${description}:\n\n${content}`)
      }
    }
  }

  if (memories.length === 0) {
    return ''
  }

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}

/**
 * Gets managed and user conditional rules that match the target path.
 * This is the first phase of nested memory loading.
 *
 * @param targetPath The target file path to match against glob patterns
 * @param processedPaths Set of already processed file paths (will be mutated)
 * @returns Array of MemoryFileInfo objects for matching conditional rules
 */
export async function getManagedAndUserConditionalRules(
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  // Process Managed conditional .claude/rules/*.md files
  const managedClaudeRulesDir = getManagedClaudeRulesDir()
  result.push(
    ...(await processConditionedMdRules(
      targetPath,
      managedClaudeRulesDir,
      'Managed',
      processedPaths,
      false,
    )),
  )

  if (isSettingSourceEnabled('userSettings')) {
    // Process User conditional .claude/rules/*.md files
    const userClaudeRulesDir = getUserClaudeRulesDir()
    result.push(
      ...(await processConditionedMdRules(
        targetPath,
        userClaudeRulesDir,
        'User',
        processedPaths,
        true,
      )),
    )
  }

  return result
}

/**
 * Gets memory files for a single nested directory (between CWD and target).
 * Loads CLAUDE.md, unconditional rules, and conditional rules for that directory.
 *
 * @param dir The directory to process
 * @param targetPath The target file path (for conditional rule matching)
 * @param processedPaths Set of already processed file paths (will be mutated)
 * @returns Array of MemoryFileInfo objects
 */
export async function getMemoryFilesForNestedDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  // Conditional rules other coding agents maintain here. First, so everything
  // native to tau lands later and therefore ranks higher.
  result.push(
    ...(await processForeignConditionedRules(targetPath, dir, processedPaths)),
  )

  // Process project memory files (CLAUDE.md and .claude/CLAUDE.md)
  if (isSettingSourceEnabled('projectSettings')) {
    const projectPath = join(dir, 'CLAUDE.md')
    result.push(
      ...(await processMemoryFile(
        projectPath,
        'Project',
        processedPaths,
        false,
      )),
    )
    const dotClaudePath = join(dir, '.claude', 'CLAUDE.md')
    result.push(
      ...(await processMemoryFile(
        dotClaudePath,
        'Project',
        processedPaths,
        false,
      )),
    )
  }

  // Process local memory file (CLAUDE.local.md)
  if (isSettingSourceEnabled('localSettings')) {
    const localPath = join(dir, 'CLAUDE.local.md')
    result.push(
      ...(await processMemoryFile(localPath, 'Local', processedPaths, false)),
    )
  }

  const rulesDir = join(dir, '.claude', 'rules')

  // Process project unconditional .claude/rules/*.md files, which were not eagerly loaded
  // Use a separate processedPaths set to avoid marking conditional rule files as processed
  const unconditionalProcessedPaths = new Set(processedPaths)
  result.push(
    ...(await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: unconditionalProcessedPaths,
      includeExternal: false,
      conditionalRule: false,
    })),
  )

  // Process project conditional .claude/rules/*.md files
  result.push(
    ...(await processConditionedMdRules(
      targetPath,
      rulesDir,
      'Project',
      processedPaths,
      false,
    )),
  )

  // processedPaths must be seeded with unconditional paths for subsequent directories
  for (const path of unconditionalProcessedPaths) {
    processedPaths.add(path)
  }

  return result
}

/**
 * Gets conditional rules for a CWD-level directory (from root up to CWD).
 * Only processes conditional rules since unconditional rules are already loaded eagerly.
 *
 * @param dir The directory to process
 * @param targetPath The target file path (for conditional rule matching)
 * @param processedPaths Set of already processed file paths (will be mutated)
 * @returns Array of MemoryFileInfo objects
 */
export async function getConditionalRulesForCwdLevelDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const rulesDir = join(dir, '.claude', 'rules')
  // Foreign rule dirs live at the project root, which is a cwd-level directory
  // rather than a nested one, so a Cursor `globs:` rule would never attach
  // without this pass. Listed before the native rules because later files rank
  // higher and tau's own rules should win.
  const foreignRules = await processForeignConditionedRules(
    targetPath,
    dir,
    processedPaths,
  )
  return [
    ...foreignRules,
    ...(await processConditionedMdRules(
      targetPath,
      rulesDir,
      'Project',
      processedPaths,
      false,
    )),
  ]
}

/**
 * Processes all .md files in the .claude/rules/ directory and its subdirectories,
 * filtering to only include files with frontmatter paths that match the target path
 * @param targetPath The file path to match against frontmatter glob patterns
 * @param rulesDir The path to the rules directory
 * @param type Type of memory file (User, Project, Local)
 * @param processedPaths Set of already processed file paths
 * @param includeExternal Whether to include external files
 * @returns Array of MemoryFileInfo objects that match the target path
 */
export async function processConditionedMdRules(
  targetPath: string,
  rulesDir: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  options: {
    /** Filename suffixes to accept; other tools do not use `.md`. */
    extensions?: readonly string[]
    /**
     * Root the rule's globs are written against. Defaults to the parent of the
     * `.claude` directory, which is also correct for every two-segment foreign
     * source (.cursor/rules, .github/instructions, .windsurf/rules). A
     * one-segment source such as `.clinerules` must pass its own.
     */
    baseDir?: string
  } = {},
): Promise<MemoryFileInfo[]> {
  const conditionedRuleMdFiles = await processMdRules({
    rulesDir,
    type,
    processedPaths,
    includeExternal,
    conditionalRule: true,
    ...(options.extensions !== undefined && { extensions: options.extensions }),
  })

  // Filter to only include files whose globs patterns match the targetPath
  return conditionedRuleMdFiles.filter(file => {
    if (!file.globs || file.globs.length === 0) {
      return false
    }

    // For Project rules: glob patterns are relative to the directory containing .claude
    // For Managed/User rules: glob patterns are relative to the original CWD
    const baseDir =
      options.baseDir ??
      (type === 'Project'
        ? dirname(dirname(rulesDir)) // Parent of .claude
        : getOriginalCwd()) // Project root for managed/user rules

    const relativePath = isAbsolute(targetPath)
      ? relative(baseDir, targetPath)
      : targetPath
    // ignore() throws on empty strings, paths escaping the base (../),
    // and absolute paths (Windows cross-drive relative() returns absolute).
    // Files outside baseDir can't match baseDir-relative globs anyway.
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      isAbsolute(relativePath)
    ) {
      return false
    }
    return ignore().add(file.globs).ignores(relativePath)
  })
}

export type ExternalClaudeMdInclude = {
  path: string
  parent: string
}

export function getExternalClaudeMdIncludes(
  files: MemoryFileInfo[],
): ExternalClaudeMdInclude[] {
  const externals: ExternalClaudeMdInclude[] = []
  for (const file of files) {
    if (file.type !== 'User' && file.parent && !pathInOriginalCwd(file.path)) {
      externals.push({ path: file.path, parent: file.parent })
    }
  }
  return externals
}

export function hasExternalClaudeMdIncludes(files: MemoryFileInfo[]): boolean {
  return getExternalClaudeMdIncludes(files).length > 0
}

export async function shouldShowClaudeMdExternalIncludesWarning(): Promise<boolean> {
  const config = getCurrentProjectConfig()
  if (
    config.hasClaudeMdExternalIncludesApproved ||
    config.hasClaudeMdExternalIncludesWarningShown
  ) {
    return false
  }

  return hasExternalClaudeMdIncludes(await getMemoryFiles(true))
}

/**
 * Check if a file path is a memory file (CLAUDE.md, CLAUDE.local.md, or .claude/rules/*.md)
 */
export function isMemoryFilePath(filePath: string): boolean {
  const name = basename(filePath)

  // CLAUDE.md or CLAUDE.local.md anywhere
  if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') {
    return true
  }

  // .md files in .claude/rules/ directories
  if (
    name.endsWith('.md') &&
    filePath.includes(`${sep}.claude${sep}rules${sep}`)
  ) {
    return true
  }

  return false
}

/**
 * Get all memory file paths from both standard discovery and readFileState.
 * Combines:
 * - getMemoryFiles() paths (CWD upward to root)
 * - readFileState paths matching memory patterns (includes child directories)
 */
export function getAllMemoryFilePaths(
  files: MemoryFileInfo[],
  readFileState: FileStateCache,
): string[] {
  const paths = new Set<string>()
  for (const file of files) {
    if (file.content.trim().length > 0) {
      paths.add(file.path)
    }
  }

  // Add memory files from readFileState (includes child directories)
  for (const filePath of cacheKeys(readFileState)) {
    if (isMemoryFilePath(filePath)) {
      paths.add(filePath)
    }
  }

  return Array.from(paths)
}
