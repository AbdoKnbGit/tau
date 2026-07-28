/**
 * Utility for persisting large tool results to disk instead of truncating them.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createReadStream } from 'fs'
import { mkdir, open, readdir, stat, writeFile } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { createInterface } from 'readline'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import {
  BYTES_PER_TOKEN,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
} from '../constants/toolLimits.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { searchToolResultFile } from './toolResultSearch.js'
import { logEvent } from '../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../services/analytics/metadata.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import { getCwd } from './cwd.js'
import { getErrnoCode, toError } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { getProjectDir } from './sessionStorage.js'
import { jsonStringify } from './slowOperations.js'
import {
  getProjectTempDirForTauOutputPaths,
  isAllowedTauManagedTaskOutputPath,
} from './tauManagedOutputPaths.js'
import { selectToolResultPreview } from './toolResultCompression.js'
import { posixPathToWindowsPath } from './windowsPaths.js'

// Subdirectory name for tool results within a session
export const TOOL_RESULTS_SUBDIR = 'tool-results'

// XML tag used to wrap persisted output messages
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'

// Message used when tool result content was cleared without persisting to file
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

/**
 * GrowthBook override map: tool name -> persistence threshold (chars).
 * When a tool name is present in this map, that value is used directly as the
 * effective threshold, bypassing the Math.min() clamp against the 50k default.
 * Tools absent from the map use the hardcoded fallback.
 * Flag default is {} (no overrides == behavior unchanged).
 */
const PERSIST_THRESHOLD_OVERRIDE_FLAG = 'tengu_satin_quoll'

/**
 * Read a positive finite integer from the first set env var in `keys`.
 * Returns undefined when unset or invalid so callers fall through to the
 * next precedence tier (mirrors getEnvMaxTokens in FileReadTool/limits.ts).
 */
function getPositiveIntEnv(keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const raw = process.env[key]
    if (!raw) continue
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

const PERSIST_THRESHOLD_ENV_KEYS = [
  'TAU_TOOL_PERSIST_THRESHOLD_CHARS',
  'CLAUDE_CODE_TOOL_PERSIST_THRESHOLD_CHARS',
] as const

const PER_MESSAGE_BUDGET_ENV_KEYS = [
  'TAU_TOOL_RESULTS_BUDGET_CHARS',
  'CLAUDE_CODE_TOOL_RESULTS_BUDGET_CHARS',
] as const

/**
 * Resolve the effective persistence threshold for a tool.
 * GrowthBook override wins when present; otherwise falls back to the declared
 * per-tool cap clamped by the global default. The global default itself is
 * env-overridable (TAU_TOOL_PERSIST_THRESHOLD_CHARS) — a user-set tuning
 * knob and instant rollback lever for the lowered inline budget; the
 * per-tool GB override stays ahead of it because specific beats general.
 *
 * Defensive: GrowthBook's cache returns `cached !== undefined ? cached : default`,
 * so a flag served as `null` leaks through. We guard with optional chaining and a
 * typeof check so any non-object flag value (null, string, number) falls through
 * to the hardcoded default instead of throwing on index or returning 0.
 */
export function getPersistenceThreshold(
  toolName: string,
  declaredMaxResultSizeChars: number,
): number {
  // Infinity = hard opt-out. Read self-bounds via maxTokens; persisting its
  // output to a file the model reads back with Read is circular. Checked
  // before the GB override so tengu_satin_quoll can't force it back on.
  if (!Number.isFinite(declaredMaxResultSizeChars)) {
    return declaredMaxResultSizeChars
  }
  const overrides = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    number
  > | null>(PERSIST_THRESHOLD_OVERRIDE_FLAG, {})
  const override = overrides?.[toolName]
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return override
  }
  const globalDefault =
    getPositiveIntEnv(PERSIST_THRESHOLD_ENV_KEYS) ??
    DEFAULT_MAX_RESULT_SIZE_CHARS
  return Math.min(declaredMaxResultSizeChars, globalDefault)
}

// Result of persisting a tool result to disk
export type PersistedToolResult = {
  filepath: string
  originalSize: number
  isJson: boolean
  preview: string
  hasMore: boolean
}

// Error result when persistence fails
export type PersistToolResultError = {
  error: string
}

/**
 * Get the session directory (projectDir/sessionId)
 */
function getSessionDir(): string {
  return join(getProjectDir(getOriginalCwd()), getSessionId())
}

/**
 * Get the tool results directory for this session (projectDir/sessionId/tool-results)
 */
export function getToolResultsDir(): string {
  return join(getSessionDir(), TOOL_RESULTS_SUBDIR)
}

// Preview size in bytes for the reference message
export const PREVIEW_SIZE_BYTES = 2000

/**
 * Get the filepath where a tool result would be persisted.
 */
export function getToolResultPath(id: string, isJson: boolean): string {
  const ext = isJson ? 'json' : 'txt'
  return join(getToolResultsDir(), `${id}.${ext}`)
}

export type RetrievePersistedToolResultOptions = {
  path?: string
  toolUseId?: string
  startByte?: number
  maxBytes?: number
  startLine?: number
  lineCount?: number
  query?: string
}

export type RetrievedPersistedToolResult =
  | {
      ok: true
      path: string
      totalBytes: number
      range: string
      content: string
      truncated: boolean
    }
  | {
      ok: false
      error: string
    }

type RetrievedPersistedToolResultRange = {
  range: string
  content: string
  truncated: boolean
}

const DEFAULT_RETRIEVE_BYTES = 20_000
const MAX_RETRIEVE_BYTES = 100_000
const DEFAULT_RETRIEVE_LINES = 200
const MAX_RETRIEVE_LINES = 2_000
function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function pathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

function hasPathSeparator(path: string): boolean {
  return /[\\/]/.test(path)
}

function isAllowedToolResultPath(path: string): boolean {
  const resolvedPath = resolve(path)
  const currentToolResultsDir = resolve(getToolResultsDir())
  if (isInsidePath(resolvedPath, currentToolResultsDir)) return true

  const projectDir = resolve(getProjectDir(getOriginalCwd()))
  return (
    isInsidePath(resolvedPath, projectDir) &&
    pathParts(resolvedPath).includes(TOOL_RESULTS_SUBDIR)
  )
}

/**
 * The whole project-local `.tau` directory is Tau-managed output space
 * (artifacts, diff-artifacts, mermaid, specs, and files the session itself
 * wrote there). Restricting retrieval to a hardcoded subdirectory list made
 * models loop on "Path must point inside …" for files they had just created
 * under `.tau`, so any path inside `.tau` of the current or original cwd is
 * readable here.
 */
function isAllowedTauManagedOutputPath(path: string): boolean {
  const resolvedPath = resolve(path)
  const roots = new Set([resolve(getCwd()), resolve(getOriginalCwd())])
  for (const root of roots) {
    const tauDir = resolve(root, '.tau')
    if (isInsidePath(resolvedPath, tauDir)) return true
  }
  return false
}

function isAllowedSavedTauOutputPath(path: string): boolean {
  return (
    isAllowedToolResultPath(path) ||
    isAllowedTauManagedOutputPath(path) ||
    isAllowedTauManagedTaskOutputPath(path, getOriginalCwd())
  )
}

/**
 * Git Bash / MSYS-style absolute paths (`/c/Users/…`, `/cygdrive/c/…`) come
 * back from models verbatim for paths Tau printed in Windows form. `resolve()`
 * would misroot them at `<cwd drive>:\c\…`, so convert them first. Non-drive
 * POSIX paths (e.g. `/tmp/x`) are left alone.
 */
function normalizeRetrievePathInput(path: string): string {
  if (
    process.platform === 'win32' &&
    /^\/(?:[A-Za-z](?:\/|$)|cygdrive\/)/.test(path)
  ) {
    return posixPathToWindowsPath(path)
  }
  return path
}

function resolveSavedTauOutputPath(path: string): string {
  const normalized = normalizeRetrievePathInput(path)
  if (isAbsolute(normalized)) return resolve(normalized)
  const parts = pathParts(normalized)
  if (parts[0] === '.tau' || hasPathSeparator(normalized)) {
    return resolve(getCwd(), normalized)
  }
  return resolve(getToolResultsDir(), normalized)
}

async function existingToolResultPath(
  toolUseId: string,
): Promise<string | null> {
  const candidates = [
    getToolResultPath(toolUseId, false),
    getToolResultPath(toolUseId, true),
  ]
  for (const candidate of candidates) {
    try {
      const candidateStat = await stat(candidate)
      if (candidateStat.isFile()) return candidate
    } catch {
      // Try the next extension.
    }
  }
  return null
}

/**
 * Models regularly hand a background TASK id to `toolUseId` — the two id
 * formats look alike and both end up in "output saved to" messages. When no
 * persisted tool result matches, look for `<session>/tasks/<id>.output` under
 * this project's temp space (any session — cross-session reads within the
 * project are already allowed by isAllowedTauManagedTaskOutputPath). Most
 * recently modified wins if several sessions have the same task id.
 */
async function existingTaskOutputPathForId(id: string): Promise<string | null> {
  if (hasPathSeparator(id) || id.includes('..')) return null
  const projectTempDir = getProjectTempDirForTauOutputPaths(getOriginalCwd())
  let sessionDirs: string[]
  try {
    sessionDirs = await readdir(projectTempDir)
  } catch {
    return null
  }
  let best: { path: string; mtimeMs: number } | null = null
  for (const sessionDir of sessionDirs) {
    const candidate = join(projectTempDir, sessionDir, 'tasks', `${id}.output`)
    try {
      const candidateStat = await stat(candidate)
      if (
        candidateStat.isFile() &&
        (!best || candidateStat.mtimeMs > best.mtimeMs)
      ) {
        best = { path: candidate, mtimeMs: candidateStat.mtimeMs }
      }
    } catch {
      // Not in this session — try the next.
    }
  }
  return best?.path ?? null
}

type ResolvedSavedOutputPath =
  | { ok: true; path: string }
  | { ok: false; error: string }

const PATH_NOT_ALLOWED_ERROR =
  'Path must point inside a Tau tool-results directory, a project-local .tau directory, or a Tau-managed task output file. ' +
  'For ordinary project files, use the Read tool instead.'

async function resolveByPath(rawPath: string): Promise<ResolvedSavedOutputPath> {
  const resolvedPath = resolveSavedTauOutputPath(rawPath.trim())
  if (!isAllowedSavedTauOutputPath(resolvedPath)) {
    return { ok: false, error: PATH_NOT_ALLOWED_ERROR }
  }
  return { ok: true, path: resolvedPath }
}

async function resolveByToolUseId(
  rawToolUseId: string,
): Promise<ResolvedSavedOutputPath> {
  const toolUseId = rawToolUseId.trim()
  if (hasPathSeparator(toolUseId)) {
    return { ok: false, error: 'toolUseId must not contain path separators.' }
  }
  const path =
    (await existingToolResultPath(toolUseId)) ??
    (await existingTaskOutputPathForId(toolUseId))
  if (!path) {
    return {
      ok: false,
      error: `No persisted tool result or task output found for toolUseId: ${toolUseId}`,
    }
  }
  return { ok: true, path }
}

async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function resolvePersistedToolResultPath(
  options: RetrievePersistedToolResultOptions,
): Promise<RetrievedPersistedToolResult | { ok: true; path: string }> {
  const rawPath = options.path?.trim()
  const rawToolUseId = options.toolUseId?.trim()

  // Both provided: auto-pick instead of erroring (models often send a printed
  // path plus a guessed id together). The explicit path wins when it resolves
  // to a real file; otherwise the id is tried before giving up.
  if (rawPath && rawToolUseId) {
    const viaPath = await resolveByPath(rawPath)
    if (viaPath.ok && (await isExistingFile(viaPath.path))) return viaPath
    const viaId = await resolveByToolUseId(rawToolUseId)
    if (viaId.ok) return viaId
    // Path's verdict leads (it's the more specific input); mention the id
    // fallback so the model knows both were tried.
    if (viaPath.ok) return viaPath
    return {
      ok: false,
      error: `${viaPath.error} (toolUseId fallback also failed: ${viaId.error})`,
    }
  }

  if (rawPath) return resolveByPath(rawPath)
  if (rawToolUseId) return resolveByToolUseId(rawToolUseId)

  return { ok: false, error: 'Provide either path or toolUseId.' }
}

function clampPositiveInt(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), 1), max)
}

async function readByteRange(
  path: string,
  totalBytes: number,
  startByteInput: number | undefined,
  maxBytesInput: number | undefined,
): Promise<RetrievedPersistedToolResultRange> {
  const startByte =
    startByteInput === undefined || !Number.isFinite(startByteInput)
      ? 0
      : Math.min(Math.max(Math.floor(startByteInput), 0), totalBytes)
  const maxBytes = clampPositiveInt(
    maxBytesInput,
    DEFAULT_RETRIEVE_BYTES,
    MAX_RETRIEVE_BYTES,
  )
  const bytesToRead = Math.min(maxBytes, Math.max(totalBytes - startByte, 0))
  const buffer = Buffer.alloc(bytesToRead)
  const handle = await open(path, 'r')
  try {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      bytesToRead,
      startByte,
    )
    const endByte = startByte + bytesRead
    return {
      range: `bytes ${startByte}-${Math.max(endByte - 1, startByte)} of ${totalBytes}`,
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: endByte < totalBytes,
    }
  } finally {
    await handle.close()
  }
}

async function readLineRange(
  path: string,
  startLineInput: number | undefined,
  lineCountInput: number | undefined,
): Promise<RetrievedPersistedToolResultRange> {
  const startLine = clampPositiveInt(startLineInput, 1, Number.MAX_SAFE_INTEGER)
  const lineCount = clampPositiveInt(
    lineCountInput,
    DEFAULT_RETRIEVE_LINES,
    MAX_RETRIEVE_LINES,
  )
  const lines: string[] = []
  let currentLine = 0
  let currentSize = 0
  let truncated = false
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    currentLine++
    if (currentLine < startLine) continue
    if (lines.length >= lineCount) {
      truncated = true
      rl.close()
      break
    }
    if (currentSize + line.length > MAX_RETRIEVE_BYTES) {
      const remaining = Math.max(MAX_RETRIEVE_BYTES - currentSize, 0)
      if (remaining > 0) lines.push(line.slice(0, remaining))
      truncated = true
      rl.close()
      break
    }
    lines.push(line)
    currentSize += line.length + 1
  }

  const endLine = lines.length > 0 ? startLine + lines.length - 1 : startLine
  return {
    range: `lines ${startLine}-${endLine}`,
    content: lines.join('\n'),
    truncated,
  }
}

/**
 * Find `query` inside a saved output and render the hits as a range.
 *
 * The zero-match reply carries the exact line count on purpose. A search that
 * finds nothing always ran to EOF, so the count is free and it turns a dead end
 * into the one fact needed to pick a line range without another probe.
 */
async function searchRange(
  path: string,
  query: string,
  totalBytes: number,
): Promise<RetrievedPersistedToolResultRange> {
  const found = await searchToolResultFile(path, query, {
    maxBytes: MAX_RETRIEVE_BYTES,
    maxMatches: MAX_RETRIEVE_LINES,
  })

  if (found.binary) {
    return {
      range: 'binary output, not searched',
      content: `This saved output looks binary, so "${query}" was not searched for. Read a byte range instead.`,
      truncated: false,
    }
  }

  if (found.matches === 0) {
    return {
      range: `0 matches for "${query}"`,
      content:
        `No line contains "${query}". This output has ${found.scannedLines} lines ` +
        `across ${totalBytes} bytes; read a range with startLine/lineCount instead of searching again.`,
      truncated: false,
    }
  }

  return {
    range:
      `${found.matches} matching line${found.matches === 1 ? '' : 's'} for "${query}"` +
      (found.truncated ? ' (capped)' : ''),
    content: found.content,
    truncated: found.truncated,
  }
}

export async function retrievePersistedToolResult(
  options: RetrievePersistedToolResultOptions,
): Promise<RetrievedPersistedToolResult> {
  const resolved = await resolvePersistedToolResultPath(options)
  if (!resolved.ok) return resolved

  let fileStat
  try {
    fileStat = await stat(resolved.path)
  } catch {
    return { ok: false, error: `Persisted tool result not found: ${resolved.path}` }
  }
  if (!fileStat.isFile()) {
    return { ok: false, error: `Not a file: ${resolved.path}` }
  }

  // Search wins over the range inputs: a model that knows what it is looking
  // for should never also have to guess where it lives.
  const query = options.query?.trim()
  const range = query
    ? await searchRange(resolved.path, query, fileStat.size)
    : options.startLine !== undefined || options.lineCount !== undefined
      ? await readLineRange(resolved.path, options.startLine, options.lineCount)
      : await readByteRange(
          resolved.path,
          fileStat.size,
          options.startByte,
          options.maxBytes,
        )

  return {
    ok: true,
    path: resolved.path,
    totalBytes: fileStat.size,
    ...range,
  }
}

/**
 * Ensure the session-specific tool results directory exists
 */
export async function ensureToolResultsDir(): Promise<void> {
  try {
    await mkdir(getToolResultsDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }
}

/**
 * Persist a tool result to disk and return information about the persisted file
 *
 * @param content - The tool result content to persist (string or array of content blocks)
 * @param toolUseId - The ID of the tool use that produced the result
 * @returns Information about the persisted file including filepath and preview
 */
export async function persistToolResult(
  content: NonNullable<ToolResultBlockParam['content']>,
  toolUseId: string,
): Promise<PersistedToolResult | PersistToolResultError> {
  const isJson = Array.isArray(content)

  // Check for non-text content - we can only persist text blocks
  if (isJson) {
    const hasNonTextContent = content.some(block => block.type !== 'text')
    if (hasNonTextContent) {
      return {
        error: 'Cannot persist tool results containing non-text content',
      }
    }
  }

  await ensureToolResultsDir()
  const filepath = getToolResultPath(toolUseId, isJson)
  const contentStr = isJson ? jsonStringify(content, null, 2) : content

  // tool_use_id is unique per invocation and content is deterministic for a
  // given id, so skip if the file already exists. This prevents re-writing
  // the same content on every API turn when microcompact replays the
  // original messages. Use 'wx' instead of a stat-then-write race.
  try {
    await writeFile(filepath, contentStr, { encoding: 'utf-8', flag: 'wx' })
    logForDebugging(
      `Persisted tool result to ${filepath} (${formatFileSize(contentStr.length)})`,
    )
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      logError(toError(error))
      return { error: getFileSystemErrorMessage(toError(error)) }
    }
    // EEXIST: already persisted on a prior turn, fall through to preview
  }

  // Generate a preview
  const { preview, hasMore } = generatePreview(contentStr, PREVIEW_SIZE_BYTES)

  return {
    filepath,
    originalSize: contentStr.length,
    isJson,
    preview,
    hasMore,
  }
}

/**
 * Build a message for large tool results with preview
 */
export function buildLargeToolResultMessage(
  result: PersistedToolResult,
  originalContent?: NonNullable<ToolResultBlockParam['content']>,
): string {
  const preview = selectToolResultPreview(
    result.preview,
    originalContent,
    PREVIEW_SIZE_BYTES,
  )
  let message = `${PERSISTED_OUTPUT_TAG}\n`
  message += `Output too large (${formatFileSize(result.originalSize)}). Full output saved to: ${result.filepath}\n\n`
  message +=
    preview === result.preview
      ? `Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):\n`
      : `Preview (compressed to ${formatFileSize(PREVIEW_SIZE_BYTES)}):\n`
  message += preview
  message += result.hasMore ? '\n...\n' : '\n'
  message += PERSISTED_OUTPUT_CLOSING_TAG
  return message
}

/**
 * Process a tool result for inclusion in a message.
 * Maps the result to the API format and persists large results to disk.
 */
export async function processToolResultBlock<T>(
  tool: {
    name: string
    maxResultSizeChars: number
    mapToolResultToToolResultBlockParam: (
      result: T,
      toolUseID: string,
    ) => ToolResultBlockParam
  },
  toolUseResult: T,
  toolUseID: string,
): Promise<ToolResultBlockParam> {
  const toolResultBlock = tool.mapToolResultToToolResultBlockParam(
    toolUseResult,
    toolUseID,
  )
  return maybePersistLargeToolResult(
    toolResultBlock,
    tool.name,
    getPersistenceThreshold(tool.name, tool.maxResultSizeChars),
  )
}

/**
 * Process a pre-mapped tool result block. Applies persistence for large results
 * without re-calling mapToolResultToToolResultBlockParam.
 */
export async function processPreMappedToolResultBlock(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  maxResultSizeChars: number,
): Promise<ToolResultBlockParam> {
  return maybePersistLargeToolResult(
    toolResultBlock,
    toolName,
    getPersistenceThreshold(toolName, maxResultSizeChars),
  )
}

/**
 * True when a tool_result's content is empty or effectively empty. Covers:
 * undefined/null/'', whitespace-only strings, empty arrays, and arrays whose
 * only blocks are text blocks with empty/whitespace text. Non-text blocks
 * (images, tool_reference) are treated as non-empty.
 */
export function isToolResultContentEmpty(
  content: ToolResultBlockParam['content'],
): boolean {
  if (!content) return true
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  if (content.length === 0) return true
  return content.every(
    block =>
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      (typeof block.text !== 'string' || block.text.trim() === ''),
  )
}

/**
 * Handle large tool results by persisting to disk instead of truncating.
 * Returns the original block if no persistence needed, or a modified block
 * with the content replaced by a reference to the persisted file.
 */
async function maybePersistLargeToolResult(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  persistenceThreshold?: number,
): Promise<ToolResultBlockParam> {
  // Check size first before doing any async work - most tool results are small
  const content = toolResultBlock.content

  // inc-4586: Empty tool_result content at the prompt tail causes some models
  // (notably capybara) to emit the \n\nHuman: stop sequence and end their turn
  // with zero output. The server renderer inserts no \n\nAssistant: marker after
  // tool results, so a bare </function_results>\n\n pattern-matches to a turn
  // boundary. Several tools can legitimately produce empty output (silent-success
  // shell commands, MCP servers returning content:[], REPL statements, etc.).
  // Inject a short marker so the model always has something to react to.
  if (isToolResultContentEmpty(content)) {
    logEvent('tengu_tool_empty_result', {
      toolName: sanitizeToolNameForAnalytics(toolName),
    })
    return {
      ...toolResultBlock,
      content: `(${toolName} completed with no output)`,
    }
  }
  // Narrow after the emptiness guard — content is non-nullish past this point.
  if (!content) {
    return toolResultBlock
  }

  // Skip persistence for image content blocks - they need to be sent as-is to Claude
  if (hasImageBlock(content)) {
    return toolResultBlock
  }

  const size = contentSize(content)

  // Use tool-specific threshold if provided, otherwise fall back to global limit
  const threshold = persistenceThreshold ?? MAX_TOOL_RESULT_BYTES
  if (size <= threshold) {
    return toolResultBlock
  }

  // Persist the entire content as a unit
  const result = await persistToolResult(content, toolResultBlock.tool_use_id)
  if (isPersistError(result)) {
    // If persistence failed, return the original block unchanged
    return toolResultBlock
  }

  const message = buildLargeToolResultMessage(result, content)

  // Log analytics
  logEvent('tengu_tool_result_persisted', {
    toolName: sanitizeToolNameForAnalytics(toolName),
    originalSizeBytes: result.originalSize,
    persistedSizeBytes: message.length,
    estimatedOriginalTokens: Math.ceil(result.originalSize / BYTES_PER_TOKEN),
    estimatedPersistedTokens: Math.ceil(message.length / BYTES_PER_TOKEN),
    thresholdUsed: threshold,
  })

  return { ...toolResultBlock, content: message }
}

/**
 * Generate a preview of content, truncating at a newline boundary when possible.
 */
export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false }
  }

  // Find the last newline within the limit to avoid cutting mid-line
  const truncated = content.slice(0, maxBytes)
  const lastNewline = truncated.lastIndexOf('\n')

  // If we found a newline reasonably close to the limit, use it
  // Otherwise fall back to the exact limit
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes

  return { preview: content.slice(0, cutPoint), hasMore: true }
}

/**
 * Type guard to check if persist result is an error
 */
export function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return 'error' in result
}

// --- Message-level aggregate tool result budget ---
//
// Tracks replacement state across turns so enforceToolResultBudget makes the
// same choices every time (preserves prompt cache prefix).

/**
 * Per-conversation-thread state for the aggregate tool result budget.
 * State must be stable to preserve prompt cache:
 *   - seenIds: results that have passed through the budget check (replaced
 *     or not). Once seen, a result's fate is frozen for the conversation.
 *   - replacements: subset of seenIds that were persisted to disk and
 *     replaced with previews, mapped to the exact preview string shown to
 *     the model. Re-application is a Map lookup — no file I/O, guaranteed
 *     byte-identical, cannot fail.
 *
 * Lifecycle: one instance per conversation thread, carried on ToolUseContext.
 * Main thread: REPL provisions once, never resets — stale entries after
 * /clear, rewind, resume, or compact are never looked up (tool_use_ids are
 * UUIDs) so they're harmless. Subagents: createSubagentContext clones the
 * parent's state by default (cache-sharing forks like agentSummary need
 * identical decisions), or resumeAgentBackground threads one reconstructed
 * from sidechain records.
 */
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

/**
 * Clone replacement state for a cache-sharing fork (e.g. agentSummary).
 * The fork needs state identical to the source at fork time so
 * enforceToolResultBudget makes the same choices → same wire prefix →
 * prompt cache hit. Mutating the clone does not affect the source.
 */
export function cloneContentReplacementState(
  source: ContentReplacementState,
): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements),
  }
}

/**
 * Resolve the per-message aggregate budget limit. Precedence: env override
 * (TAU_TOOL_RESULTS_BUDGET_CHARS — user-set, beats experiment infrastructure,
 * same rule as FileReadTool/limits.ts) > GrowthBook (tengu_hawthorn_window) >
 * hardcoded constant. Defensive typeof/finite check: GrowthBook's cache
 * returns `cached !== undefined ? cached : default`, so a flag served as
 * null/string/NaN leaks through.
 *
 * Mid-session changes are cache-safe by construction: enforceToolResultBudget
 * freezes each tool_use_id's fate on first sight, so a new limit only
 * affects fresh messages.
 */
export function getPerMessageBudgetLimit(): number {
  const envOverride = getPositiveIntEnv(PER_MESSAGE_BUDGET_ENV_KEYS)
  if (envOverride !== undefined) {
    return envOverride
  }
  const override = getFeatureValue_CACHED_MAY_BE_STALE<number | null>(
    'tengu_hawthorn_window',
    null,
  )
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return override
  }
  return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
}

/**
 * Provision replacement state for a new conversation thread.
 *
 * Encapsulates the feature-flag gate + reconstruct-vs-fresh choice:
 *   - Flag off → undefined (query.ts skips enforcement entirely)
 *   - No initialMessages (cold start) → fresh
 *   - initialMessages present → reconstruct (freeze all candidate IDs so the
 *     budget never replaces content the model already saw unreplaced). Empty
 *     or absent records freeze everything; non-empty records additionally
 *     populate the replacements Map for byte-identical re-apply.
 */
export function provisionContentReplacementState(
  initialMessages?: Message[],
  initialContentReplacements?: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  const enabled = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_hawthorn_steeple',
    false,
  )
  if (!enabled) return undefined
  if (initialMessages) {
    return reconstructContentReplacementState(
      initialMessages,
      initialContentReplacements ?? [],
    )
  }
  return createContentReplacementState()
}

/**
 * Serializable record of one content-replacement decision. Written to the
 * transcript as a ContentReplacementEntry so decisions survive resume.
 * Discriminated by `kind` so future replacement mechanisms (user text,
 * offloaded images) can share the same transcript entry type.
 *
 * `replacement` is the exact string the model saw — stored rather than
 * derived on resume so code changes to the preview template, size formatting,
 * or path layout can't silently break prompt cache.
 */
export type ContentReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

export type ToolResultReplacementRecord = Extract<
  ContentReplacementRecord,
  { kind: 'tool-result' }
>

type ToolResultCandidate = {
  toolUseId: string
  content: NonNullable<ToolResultBlockParam['content']>
  size: number
}

type CandidatePartition = {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>
  frozen: ToolResultCandidate[]
  fresh: ToolResultCandidate[]
}

function isContentAlreadyCompacted(
  content: ToolResultBlockParam['content'],
): boolean {
  // All budget-produced content starts with the tag (buildLargeToolResultMessage).
  // `.startsWith()` avoids false-positives when the tag appears anywhere else
  // in the content (e.g., reading this source file).
  return typeof content === 'string' && content.startsWith(PERSISTED_OUTPUT_TAG)
}

function hasImageBlock(
  content: NonNullable<ToolResultBlockParam['content']>,
): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      b => typeof b === 'object' && 'type' in b && b.type === 'image',
    )
  )
}

function contentSize(
  content: NonNullable<ToolResultBlockParam['content']>,
): number {
  if (typeof content === 'string') return content.length
  // Sum text-block lengths directly. Slightly under-counts vs serialized
  // (no JSON framing), but the budget is a rough token heuristic anyway.
  // Avoids allocating a content-sized string every enforcement pass.
  return content.reduce(
    (sum, b) => sum + (b.type === 'text' ? b.text.length : 0),
    0,
  )
}

/**
 * Walk messages and build tool_use_id → tool_name from assistant tool_use
 * blocks. tool_use always precedes its tool_result (model calls, then result
 * arrives), so by the time budget enforcement sees a result, its name is known.
 */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') {
        map.set(block.id, block.name)
      }
    }
  }
  return map
}

/**
 * Extract candidate tool_result blocks from a single user message: blocks
 * that are non-empty, non-image, and not already compacted by tag (i.e. by
 * the per-tool limit, or an earlier iteration of this same query call).
 * Returns [] for messages with no eligible blocks.
 */
function collectCandidatesFromMessage(message: Message): ToolResultCandidate[] {
  if (message.type !== 'user' || !Array.isArray(message.message.content)) {
    return []
  }
  return message.message.content.flatMap(block => {
    if (block.type !== 'tool_result' || !block.content) return []
    if (isContentAlreadyCompacted(block.content)) return []
    if (hasImageBlock(block.content)) return []
    return [
      {
        toolUseId: block.tool_use_id,
        content: block.content,
        size: contentSize(block.content),
      },
    ]
  })
}

/**
 * Extract candidate tool_result blocks grouped by API-level user message.
 *
 * normalizeMessagesForAPI merges consecutive user messages into one
 * (Bedrock compat; 1P does the same server-side), so parallel tool
 * results that arrive as N separate user messages in our state become
 * ONE user message on the wire. The budget must group the same way or
 * it would see N under-budget messages instead of one over-budget
 * message and fail to enforce exactly when it matters most.
 *
 * A "group" is a maximal run of user messages NOT separated by an
 * assistant message. Only assistant messages create wire-level
 * boundaries — normalizeMessagesForAPI filters out progress entirely
 * and merges attachment / system(local_command) INTO adjacent user
 * blocks, so those types do NOT break groups here either.
 *
 * This matters for abort-during-parallel-tools paths: agent_progress
 * messages (non-ephemeral, persisted in REPL state) can interleave
 * between fresh tool_result messages. If we flushed on progress, those
 * tool_results would split into under-budget groups, slip through
 * unreplaced, get frozen, then be merged by normalizeMessagesForAPI
 * into one over-budget wire message — defeating the feature.
 *
 * Only groups with at least one eligible candidate are returned.
 */
function collectCandidatesByMessage(
  messages: Message[],
): ToolResultCandidate[][] {
  const groups: ToolResultCandidate[][] = []
  let current: ToolResultCandidate[] = []

  const flush = () => {
    if (current.length > 0) groups.push(current)
    current = []
  }

  // Track all assistant message.ids seen so far — same-ID fragments are
  // merged by normalizeMessagesForAPI (messages.ts ~2126 walks back PAST
  // different-ID assistants via `continue`), so any re-appearance of a
  // previously-seen ID must NOT create a group boundary. Two scenarios:
  //   • Consecutive: streamingToolExecution yields one AssistantMessage per
  //     content_block_stop (same id); a fast tool drains between blocks;
  //     abort/hook-stop leaves [asst(X), user(trA), asst(X), user(trB)].
  //   • Interleaved: coordinator/teammate streams mix different responses
  //     so [asst(X), user(trA), asst(Y), user(trB), asst(X), user(trC)].
  // In both, normalizeMessagesForAPI merges the X fragments into one wire
  // assistant, and their following tool_results merge into one wire user
  // message — so the budget must see them as one group too.
  const seenAsstIds = new Set<string>()
  for (const message of messages) {
    if (message.type === 'user') {
      current.push(...collectCandidatesFromMessage(message))
    } else if (message.type === 'assistant') {
      if (!seenAsstIds.has(message.message.id)) {
        flush()
        seenAsstIds.add(message.message.id)
      }
    }
    // progress / attachment / system are filtered or merged by
    // normalizeMessagesForAPI — they don't create wire boundaries.
  }
  flush()

  return groups
}

/**
 * Partition candidates by their prior decision state:
 *  - mustReapply: previously replaced → re-apply the cached replacement for
 *    prefix stability
 *  - frozen: previously seen and left unreplaced → off-limits (replacing
 *    now would change a prefix that was already cached)
 *  - fresh: never seen → eligible for new replacement decisions
 */
function partitionByPriorDecision(
  candidates: ToolResultCandidate[],
  state: ContentReplacementState,
): CandidatePartition {
  return candidates.reduce<CandidatePartition>(
    (acc, c) => {
      const replacement = state.replacements.get(c.toolUseId)
      if (replacement !== undefined) {
        acc.mustReapply.push({ ...c, replacement })
      } else if (state.seenIds.has(c.toolUseId)) {
        acc.frozen.push(c)
      } else {
        acc.fresh.push(c)
      }
      return acc
    },
    { mustReapply: [], frozen: [], fresh: [] },
  )
}

/**
 * Pick the largest fresh results to replace until the model-visible total
 * (frozen + remaining fresh) is at or under budget, or fresh is exhausted.
 * If frozen results alone exceed budget we accept the overage — microcompact
 * will eventually clear them.
 */
function selectFreshToReplace(
  fresh: ToolResultCandidate[],
  frozenSize: number,
  limit: number,
): ToolResultCandidate[] {
  const sorted = [...fresh].sort((a, b) => b.size - a.size)
  const selected: ToolResultCandidate[] = []
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0)
  for (const c of sorted) {
    if (remaining <= limit) break
    selected.push(c)
    // We don't know the replacement size until after persist, but previews
    // are ~2K and results hitting this path are much larger, so subtracting
    // the full size is a close approximation for selection purposes.
    remaining -= c.size
  }
  return selected
}

/**
 * Return a new Message[] where each tool_result block whose id appears in
 * replacementMap has its content replaced. Messages and blocks with no
 * replacements are passed through by reference.
 */
function replaceToolResultContents(
  messages: Message[],
  replacementMap: Map<string, string>,
): Message[] {
  return messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    const content = message.message.content
    const needsReplace = content.some(
      b => b.type === 'tool_result' && replacementMap.has(b.tool_use_id),
    )
    if (!needsReplace) return message
    return {
      ...message,
      message: {
        ...message.message,
        content: content.map(block => {
          if (block.type !== 'tool_result') return block
          const replacement = replacementMap.get(block.tool_use_id)
          return replacement === undefined
            ? block
            : { ...block, content: replacement }
        }),
      },
    }
  })
}

async function buildReplacement(
  candidate: ToolResultCandidate,
): Promise<{ content: string; originalSize: number } | null> {
  const result = await persistToolResult(candidate.content, candidate.toolUseId)
  if (isPersistError(result)) return null
  return {
    content: buildLargeToolResultMessage(result, candidate.content),
    originalSize: result.originalSize,
  }
}

/**
 * Enforce the per-message budget on aggregate tool result size.
 *
 * For each user message whose tool_result blocks together exceed the
 * per-message limit (see getPerMessageBudgetLimit), the largest FRESH
 * (never-before-seen) results in THAT message are persisted to disk and
 * replaced with previews.
 * Messages are evaluated independently — a 150K result in one message and
 * a 150K result in another are both under budget and untouched.
 *
 * State is tracked by tool_use_id in `state`. Once a result is seen its
 * fate is frozen: previously-replaced results get the same replacement
 * re-applied every turn from the cached preview string (zero I/O,
 * byte-identical), and previously-unreplaced results are never replaced
 * later (would break prompt cache).
 *
 * Each turn adds at most one new user message with tool_result blocks,
 * so the per-message loop typically does the budget check at most once;
 * all prior messages just re-apply cached replacements.
 *
 * @param state — MUTATED: seenIds and replacements are updated in place
 *   to record choices made this call. The caller holds a stable reference
 *   across turns; returning a new object would require error-prone ref
 *   updates after every query.
 *
 * Returns `{ messages, newlyReplaced }`:
 *   - messages: same array instance when no replacement is needed
 *   - newlyReplaced: replacements made THIS call (not re-applies).
 *     Caller persists these to the transcript for resume reconstruction.
 */
export async function enforceToolResultBudget(
  messages: Message[],
  state: ContentReplacementState,
  skipToolNames: ReadonlySet<string> = new Set(),
): Promise<{
  messages: Message[]
  newlyReplaced: ToolResultReplacementRecord[]
}> {
  const candidatesByMessage = collectCandidatesByMessage(messages)
  const nameByToolUseId =
    skipToolNames.size > 0 ? buildToolNameMap(messages) : undefined
  const shouldSkip = (id: string): boolean =>
    nameByToolUseId !== undefined &&
    skipToolNames.has(nameByToolUseId.get(id) ?? '')
  // Resolve once per call. A mid-session flag change only affects FRESH
  // messages (prior decisions are frozen via seenIds/replacements), so
  // prompt cache for already-seen content is preserved regardless.
  const limit = getPerMessageBudgetLimit()

  // Walk each API-level message group independently. For previously-processed messages
  // (all IDs in seenIds) this just re-applies cached replacements. For the
  // single new message this turn added, it runs the budget check.
  const replacementMap = new Map<string, string>()
  const toPersist: ToolResultCandidate[] = []
  let reappliedCount = 0
  let messagesOverBudget = 0

  for (const candidates of candidatesByMessage) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(
      candidates,
      state,
    )

    // Re-apply: pure Map lookups. No file I/O, byte-identical, cannot fail.
    mustReapply.forEach(c => replacementMap.set(c.toolUseId, c.replacement))
    reappliedCount += mustReapply.length

    // Fresh means this is a new message. Check its per-message budget.
    // (A previously-processed message has fresh.length === 0 because all
    // its IDs were added to seenIds when first seen.)
    if (fresh.length === 0) {
      // mustReapply/frozen are already in seenIds from their first pass —
      // re-adding is a no-op but keeps the invariant explicit.
      candidates.forEach(c => state.seenIds.add(c.toolUseId))
      continue
    }

    // Tools with maxResultSizeChars: Infinity (Read) — never persist.
    // Mark as seen (frozen) so the decision sticks across turns. They don't
    // count toward freshSize; if that lets the group slip under budget and
    // the wire message is still large, that's the contract — Read's own
    // maxTokens is the bound, not this wrapper.
    const skipped = fresh.filter(c => shouldSkip(c.toolUseId))
    skipped.forEach(c => state.seenIds.add(c.toolUseId))
    const eligible = fresh.filter(c => !shouldSkip(c.toolUseId))

    const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0)
    const freshSize = eligible.reduce((sum, c) => sum + c.size, 0)

    const selected =
      frozenSize + freshSize > limit
        ? selectFreshToReplace(eligible, frozenSize, limit)
        : []

    // Mark non-persisting candidates as seen NOW (synchronously). IDs
    // selected for persist are marked seen AFTER the await, alongside
    // replacements.set — keeps the pair atomic under observation so no
    // concurrent reader (once subagents share state) ever sees X∈seenIds
    // but X∉replacements, which would misclassify X as frozen and send
    // full content while the main thread sends the preview → cache miss.
    const selectedIds = new Set(selected.map(c => c.toolUseId))
    candidates
      .filter(c => !selectedIds.has(c.toolUseId))
      .forEach(c => state.seenIds.add(c.toolUseId))

    if (selected.length === 0) continue
    messagesOverBudget++
    toPersist.push(...selected)
  }

  if (replacementMap.size === 0 && toPersist.length === 0) {
    return { messages, newlyReplaced: [] }
  }

  // Fresh: concurrent persist for all selected candidates across all
  // messages. In practice toPersist comes from a single message per turn.
  const freshReplacements = await Promise.all(
    toPersist.map(async c => [c, await buildReplacement(c)] as const),
  )
  const newlyReplaced: ToolResultReplacementRecord[] = []
  let replacedSize = 0
  for (const [candidate, replacement] of freshReplacements) {
    // Mark seen HERE, post-await, atomically with replacements.set for
    // success cases. For persist failures (replacement === null) the ID
    // is seen-but-unreplaced — the original content was sent to the
    // model, so treating it as frozen going forward is correct.
    state.seenIds.add(candidate.toolUseId)
    if (replacement === null) continue
    replacedSize += candidate.size
    replacementMap.set(candidate.toolUseId, replacement.content)
    state.replacements.set(candidate.toolUseId, replacement.content)
    newlyReplaced.push({
      kind: 'tool-result',
      toolUseId: candidate.toolUseId,
      replacement: replacement.content,
    })
    logEvent('tengu_tool_result_persisted_message_budget', {
      originalSizeBytes: replacement.originalSize,
      persistedSizeBytes: replacement.content.length,
      estimatedOriginalTokens: Math.ceil(
        replacement.originalSize / BYTES_PER_TOKEN,
      ),
      estimatedPersistedTokens: Math.ceil(
        replacement.content.length / BYTES_PER_TOKEN,
      ),
    })
  }

  if (replacementMap.size === 0) {
    return { messages, newlyReplaced: [] }
  }

  if (newlyReplaced.length > 0) {
    logForDebugging(
      `Per-message budget: persisted ${newlyReplaced.length} tool results ` +
        `across ${messagesOverBudget} over-budget message(s), ` +
        `shed ~${formatFileSize(replacedSize)}, ${reappliedCount} re-applied`,
    )
    logEvent('tengu_message_level_tool_result_budget_enforced', {
      resultsPersisted: newlyReplaced.length,
      messagesOverBudget,
      replacedSizeBytes: replacedSize,
      reapplied: reappliedCount,
    })
  }

  return {
    messages: replaceToolResultContents(messages, replacementMap),
    newlyReplaced,
  }
}

/**
 * Query-loop integration point for the aggregate budget.
 *
 * Gates on `state` (undefined means feature disabled → no-op return),
 * applies enforcement, and fires an optional transcript-write callback
 * for new replacements. The caller (query.ts) owns the persistence gate
 * — it passes a callback only for querySources that read records back on
 * resume (repl_main_thread*, agent:*); ephemeral runForkedAgent callers
 * (agentSummary, sessionMemory, /btw, compact) pass undefined.
 *
 * @returns messages with replacements applied, or the input array unchanged
 *   when the feature is off or no replacement occurred.
 */
export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void,
  skipToolNames?: ReadonlySet<string>,
): Promise<Message[]> {
  if (!state) return messages
  const result = await enforceToolResultBudget(messages, state, skipToolNames)
  if (result.newlyReplaced.length > 0) {
    writeToTranscript?.(result.newlyReplaced)
  }
  return result.messages
}

/**
 * Reconstruct replacement state from content-replacement records loaded from
 * the transcript. Used on resume so the budget makes the same choices it
 * made in the original session (prompt cache stability).
 *
 * Accepts the full ContentReplacementRecord[] from LogOption (may include
 * future non-tool-result kinds); only tool-result records are applied here.
 *
 *   - replacements: populated directly from the stored replacement strings.
 *     Records for IDs not in messages (e.g. after compact) are skipped —
 *     they're inert anyway.
 *   - seenIds: every candidate tool_use_id in the loaded messages. A result
 *     being in the transcript means it was sent to the model, so it was seen.
 *     This freezes unreplaced results against future replacement.
 *   - inheritedReplacements: gap-fill for fork-subagent resume. A fork's
 *     original run applies parent-inherited replacements via mustReapply
 *     (never persisted — not newlyReplaced). On resume the sidechain has
 *     the original content but no record, so records alone would classify
 *     it as frozen. The parent's live state still has the mapping; copy
 *     it for IDs in messages that records don't cover. No-op for non-fork
 *     resumes (parent IDs aren't in the subagent's messages).
 */
export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: ReadonlyMap<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState()
  const candidateIds = new Set(
    collectCandidatesByMessage(messages)
      .flat()
      .map(c => c.toolUseId),
  )

  for (const id of candidateIds) {
    state.seenIds.add(id)
  }
  for (const r of records) {
    if (r.kind === 'tool-result' && candidateIds.has(r.toolUseId)) {
      state.replacements.set(r.toolUseId, r.replacement)
    }
  }
  if (inheritedReplacements) {
    for (const [id, replacement] of inheritedReplacements) {
      if (candidateIds.has(id) && !state.replacements.has(id)) {
        state.replacements.set(id, replacement)
      }
    }
  }
  return state
}

/**
 * AgentTool-resume variant: encapsulates the feature-flag gate + parent
 * gap-fill so both AgentTool.call and resumeAgentBackground share one
 * implementation. Returns undefined when parentState is undefined (feature
 * off); otherwise reconstructs from sidechain records with parent's live
 * replacements filling gaps for fork-inherited mustReapply entries.
 *
 * Kept out of AgentTool.tsx — that file is at the feature() DCE complexity
 * cliff and cannot tolerate even +1 net source line without silently
 * breaking feature('TRANSCRIPT_CLASSIFIER') eval in tests.
 */
export function reconstructForSubagentResume(
  parentState: ContentReplacementState | undefined,
  resumedMessages: Message[],
  sidechainRecords: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  if (!parentState) return undefined
  return reconstructContentReplacementState(
    resumedMessages,
    sidechainRecords,
    parentState.replacements,
  )
}

/**
 * Get a human-readable error message from a filesystem error
 */
function getFileSystemErrorMessage(error: Error): string {
  // Node.js filesystem errors have a 'code' property
  // eslint-disable-next-line no-restricted-syntax -- uses .path, not just .code
  const nodeError = error as NodeJS.ErrnoException
  if (nodeError.code) {
    switch (nodeError.code) {
      case 'ENOENT':
        return `Directory not found: ${nodeError.path ?? 'unknown path'}`
      case 'EACCES':
        return `Permission denied: ${nodeError.path ?? 'unknown path'}`
      case 'ENOSPC':
        return 'No space left on device'
      case 'EROFS':
        return 'Read-only file system'
      case 'EMFILE':
        return 'Too many open files'
      case 'EEXIST':
        return `File already exists: ${nodeError.path ?? 'unknown path'}`
      default:
        return `${nodeError.code}: ${nodeError.message}`
    }
  }
  return error.message
}
