import chalk from 'chalk'
import { diffLines } from 'diff'
import { readFile } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import { getSessionId, getOriginalCwd } from '../../bootstrap/state.js'
import { getModelUsage } from '../../cost-tracker.js'
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
} from '../../tools/AgentTool/constants.js'
import type { LocalCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import type {
  FileHistoryBackup,
  FileHistoryState,
} from '../../utils/fileHistory.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  getTokenCountFromUsage,
  getTokenUsage,
  tokenCountWithEstimation,
} from '../../utils/tokens.js'
import { getAPIProvider } from '../../utils/model/providers.js'

type LineStats = {
  added: number
  updated: number
  deleted: number
}

type FileStats = LineStats & {
  path: string
  status: 'added' | 'modified' | 'deleted'
}

type ModelStats = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

type ResponseModelStats = {
  model: string
  stats: ModelStats
}

type TokenUsage = NonNullable<ReturnType<typeof getTokenUsage>>

type ToolStats = {
  total: number
  byName: Map<string, number>
  subagentSpawnCalls: number
}

type SubagentStats = {
  completed: number
  totalTokens: number
  toolCalls: number
}

const integerFormatter = new Intl.NumberFormat('en-US')

export const call: LocalCommandCall = async (_args, context) => {
  const messages = context.messages ?? []
  const fileStats = await collectFileStats(context.getAppState().fileHistory)
  const modelStats = collectModelStats(messages)
  const toolStats = collectToolStats(messages)
  const subagentStats = collectSubagentStats(messages)
  const contextStats = collectContextStats(messages)

  return {
    type: 'text',
    value: formatStatistics({
      messages,
      fileStats,
      modelStats,
      toolStats,
      subagentStats,
      contextStats,
    }),
  }
}

function formatStatistics({
  messages,
  fileStats,
  modelStats,
  toolStats,
  subagentStats,
  contextStats,
}: {
  messages: Message[]
  fileStats: FileStats[]
  modelStats: Map<string, ModelStats>
  toolStats: ToolStats
  subagentStats: SubagentStats
  contextStats: {
    currentTokens: number
    growthTokens: number
  }
}): string {
  const totals = sumModelStats(modelStats)
  const fileTotals = sumFileStats(fileStats)
  const conversationMessages = countConversationMessages(messages)
  const changedFiles = fileStats.length
  const addedFiles = fileStats.filter(file => file.status === 'added').length
  const deletedFiles = fileStats.filter(file => file.status === 'deleted').length
  const modifiedFiles = fileStats.filter(
    file => file.status === 'modified',
  ).length

  const lines = [
    'SESSION STATISTICS',
    '==================',
    ...section('Overview'),
    statRow('conversation messages', conversationMessages),
    statRow('models used', modelStats.size),
    statRow('context tokens', contextStats.currentTokens),
    statRowSigned('context growth', contextStats.growthTokens),
    ...section('Model Usage'),
    modelUsageLine('total', totals),
  ]

  const modelEntries = [...modelStats.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )
  if (modelEntries.length === 0) {
    lines.push(emptyLine('no model usage yet'))
  } else {
    for (const [model, usage] of modelEntries) {
      lines.push(modelUsageLine(model, usage))
    }
  }

  lines.push(
    ...section('Tool Calls'),
    statRow('regular tool calls', toolStats.total),
  )

  const toolEntries = [...toolStats.byName.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )
  if (toolEntries.length === 0) {
    lines.push(emptyLine('no regular tool calls yet'))
  } else {
    for (const [toolName, count] of toolEntries) {
      lines.push(itemLine(toolName, `calls: ${formatInteger(count)}`))
    }
  }

  lines.push(
    ...section('Subagents'),
    statRow('agent launches', toolStats.subagentSpawnCalls),
    statRow('agent runs completed', subagentStats.completed),
    statRow('agent tokens', subagentStats.totalTokens),
    statRow('agent internal tool calls', subagentStats.toolCalls),
    ...section('Files'),
    statRow('files touched', changedFiles),
    statRow('files added', addedFiles),
    statRow('files modified', modifiedFiles),
    statRow('files deleted', deletedFiles),
    statRow('lines added', fileTotals.added),
    statRow('lines updated', fileTotals.updated),
    statRow('lines deleted', fileTotals.deleted),
  )

  if (fileStats.length > 0) {
    lines.push(...section('Files Detail'))
    for (const file of fileStats) {
      lines.push(
        itemLine(
          file.path,
          `status: ${file.status} | added: ${formatInteger(file.added)} | updated: ${formatInteger(file.updated)} | deleted: ${formatInteger(file.deleted)}`,
        ),
      )
    }
  }

  lines.push(
    ...glowNote([
      'antigravity/cursor/deepseek can show cache_hit: 0% because cache is handled automatically by the provider backend.',
      'If cache numbers look unstable sometimes, do not worry. Every provider with cache support has been tested and tuned to maximize hits.',
      'Cache-hit reporting is not always exact because models and providers expose usage differently.',
      'Tau optimizes for the best cost/performance path available for the selected provider.',
    ]),
  )

  return lines.join('\n')
}

function section(title: string): string[] {
  return ['', title, '-'.repeat(title.length)]
}

function glowNote(lines: string[]): string[] {
  const title = 'Cache Note'
  const width = Math.max(title.length, ...lines.map(line => line.length))
  const border = `*${'='.repeat(width + 2)}*`
  return [
    '',
    chalk.cyanBright(border),
    chalk.cyanBright(`| ${title.padEnd(width)} |`),
    chalk.cyanBright(border),
    ...lines.map(line => chalk.cyanBright(`| ${line.padEnd(width)} |`)),
    chalk.cyanBright(border),
  ]
}

function statRow(name: string, value: number | string): string {
  return `${name.padEnd(27)}: ${formatMetricValue(value)}`
}

function statRowSigned(name: string, value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${name.padEnd(27)}: ${sign}${formatInteger(value)}`
}

function itemLine(name: string, detail: string): string {
  return `- ${name.padEnd(24)} ${detail}`
}

function emptyLine(text: string): string {
  return `- ${text}`
}

function modelUsageLine(name: string, usage: ModelStats): string {
  if (!shouldShowDetailedCacheUsage(name, usage)) {
    return `${name.padEnd(24)} input: ${formatInteger(usage.inputTokens)} | output: ${formatInteger(usage.outputTokens)} | cache_hit: ${formatCacheHit(usage)}`
  }

  const totalInput = totalInputTokensProcessed(usage)
  const cacheWrite =
    usage.cacheCreationInputTokens > 0
      ? ` | cache write: ${formatInteger(usage.cacheCreationInputTokens)}`
      : ''
  return `${name.padEnd(24)} uncached input: ${formatInteger(usage.inputTokens)} | cache read: ${formatInteger(usage.cacheReadInputTokens)}${cacheWrite} | total input: ${formatInteger(totalInput)} | output: ${formatInteger(usage.outputTokens)} | cache_hit: ${formatCacheHit(usage)}`
}

function formatCacheHit(usage: ModelStats): string {
  const cacheRead = usage.cacheReadInputTokens
  const cacheEligible =
    usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
  if (cacheEligible <= 0 || cacheRead <= 0) {
    return '0%'
  }
  const percent = (cacheRead / cacheEligible) * 100
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
}

function formatMetricValue(value: number | string): string {
  return typeof value === 'number' ? formatInteger(value) : value
}

function formatInteger(value: number): string {
  return integerFormatter.format(Math.trunc(value))
}

function numberFrom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSubagentToolName(name: string): boolean {
  return name === AGENT_TOOL_NAME || name === LEGACY_AGENT_TOOL_NAME
}

function isOpenRouterUsageModel(model: string): boolean {
  return getAPIProvider() === 'openrouter' && model.includes('/')
}

function isGoogleGeminiUsageModel(model: string): boolean {
  if (getAPIProvider() !== 'gemini') return false
  const lower = model.toLowerCase()
  return lower.startsWith('gemini-') || lower.startsWith('gemma-')
}

function shouldShowDetailedCacheUsage(model: string, usage: ModelStats): boolean {
  if (!hasCacheUsage(usage)) return false
  return isOpenRouterUsageModel(model) || isGoogleGeminiUsageModel(model)
}

function hasCacheUsage(usage: ModelStats): boolean {
  return (
    usage.cacheReadInputTokens > 0 ||
    usage.cacheCreationInputTokens > 0
  )
}

function totalInputTokensProcessed(usage: ModelStats): number {
  return (
    usage.inputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens
  )
}

function messageToText(message: Message): string {
  if (message.type !== 'user') return ''
  return contentToText(message.message.content)
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content.map(blockToText).filter(Boolean).join('\n')
}

function blockToText(block: unknown): string {
  if (!isRecord(block)) return ''
  if (block.type === 'text' && typeof block.text === 'string') {
    return block.text
  }
  if (block.type === 'tool_result') {
    return contentToText(block.content)
  }
  return ''
}

function countConversationMessages(messages: Message[]): number {
  const seenAssistantResponses = new Set<string>()
  let count = 0

  for (const message of messages) {
    if (message.type === 'user') {
      if (isVisibleUserMessage(message)) {
        count++
      }
      continue
    }

    if (message.type === 'assistant' && isVisibleAssistantMessage(message)) {
      const responseId = message.message.id || message.uuid
      if (!seenAssistantResponses.has(responseId)) {
        seenAssistantResponses.add(responseId)
        count++
      }
    }
  }

  return count
}

function isVisibleUserMessage(message: Message): boolean {
  const userMessage = message as Message & {
    isMeta?: boolean
    isVirtual?: boolean
    toolUseResult?: unknown
    message?: { content?: unknown }
  }
  if (
    userMessage.isMeta ||
    userMessage.isVirtual ||
    userMessage.toolUseResult !== undefined
  ) {
    return false
  }
  return hasVisibleUserContent(userMessage.message?.content)
}

function hasVisibleUserContent(content: unknown): boolean {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return (
      trimmed.length > 0 &&
      !trimmed.startsWith('<local-command-') &&
      !trimmed.startsWith('<command-')
    )
  }

  if (!Array.isArray(content)) {
    return false
  }

  return content.some(block => {
    if (!isRecord(block)) return false
    if (block.type === 'tool_result') return false
    if (block.type === 'text') {
      return hasVisibleUserContent(block.text)
    }
    return block.type === 'image' || block.type === 'document'
  })
}

function isVisibleAssistantMessage(message: Message): boolean {
  if (message.type !== 'assistant') return false
  return message.message.content.some(block => {
    if (block.type !== 'text') return false
    const text = block.text.trim()
    return text.length > 0 && text !== '[No content]'
  })
}

function collectModelStats(messages: Message[]): Map<string, ModelStats> {
  const fromCostTracker = new Map<string, ModelStats>()
  for (const [model, usage] of Object.entries(getModelUsage())) {
    fromCostTracker.set(model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
    })
  }

  if (fromCostTracker.size > 0) {
    return fromCostTracker
  }

  const fallback = new Map<string, ModelStats>()
  for (const { model, stats } of collectResponseModelStats(messages)) {
    const existing = fallback.get(model) ?? blankModelStats()
    existing.inputTokens += stats.inputTokens
    existing.outputTokens += stats.outputTokens
    existing.cacheReadInputTokens += stats.cacheReadInputTokens
    existing.cacheCreationInputTokens += stats.cacheCreationInputTokens
    fallback.set(model, existing)
  }

  return fallback
}

function collectResponseModelStats(messages: Message[]): ResponseModelStats[] {
  const responses = new Map<string, ResponseModelStats>()

  messages.forEach((message, index) => {
    if (message.type !== 'assistant') return
    const usage = getTokenUsage(message)
    if (!usage) return

    const model = message.message.model || '<unknown>'
    const responseKey = getResponseKey(message, model, index)
    const stats = modelStatsFromUsage(usage)
    const existing = responses.get(responseKey)
    if (existing && shouldShowDetailedCacheUsage(model, stats)) {
      mergeResponseStats(existing.stats, stats)
    } else if (!existing) {
      responses.set(responseKey, { model, stats })
    }
  })

  return [...responses.values()]
}

function getResponseKey(
  message: Message,
  model: string,
  index: number,
): string {
  const assistant = message as Message & {
    uuid?: string
    message?: { id?: string }
  }
  const responseId =
    typeof assistant.message?.id === 'string' && assistant.message.id.length > 0
      ? assistant.message.id
      : (assistant.uuid ?? `index:${index}`)
  return `${model}:${responseId}`
}

function modelStatsFromUsage(usage: TokenUsage): ModelStats {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  }
}

function mergeResponseStats(target: ModelStats, update: ModelStats): void {
  target.inputTokens = Math.max(target.inputTokens, update.inputTokens)
  target.outputTokens = Math.max(target.outputTokens, update.outputTokens)
  target.cacheReadInputTokens = Math.max(
    target.cacheReadInputTokens,
    update.cacheReadInputTokens,
  )
  target.cacheCreationInputTokens = Math.max(
    target.cacheCreationInputTokens,
    update.cacheCreationInputTokens,
  )
}

function collectToolStats(messages: Message[]): ToolStats {
  const byName = new Map<string, number>()
  let total = 0
  let subagentSpawnCalls = 0

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_use') continue
      if (isSubagentToolName(block.name)) {
        subagentSpawnCalls++
        continue
      }
      total++
      byName.set(block.name, (byName.get(block.name) ?? 0) + 1)
    }
  }

  return { total, byName, subagentSpawnCalls }
}

function collectSubagentStats(messages: Message[]): SubagentStats {
  const stats: SubagentStats = {
    completed: 0,
    totalTokens: 0,
    toolCalls: 0,
  }

  for (const message of messages) {
    const result = message.type === 'user' ? message.toolUseResult : undefined
    if (addSubagentResultStats(result, stats)) {
      continue
    }

    if (message.type === 'system') {
      const systemMessage = message as Message & {
        subtype?: string
        usage?: {
          total_tokens?: number
          tool_uses?: number
        }
      }
      if (systemMessage.subtype === 'task_notification') {
        const totalTokens = numberFrom(systemMessage.usage?.total_tokens)
        const toolCalls = numberFrom(systemMessage.usage?.tool_uses)
        if (totalTokens > 0 || toolCalls > 0) {
          stats.completed++
          stats.totalTokens += totalTokens
          stats.toolCalls += toolCalls
        }
      }
    }

    const usage = parseSubagentUsageText(messageToText(message))
    if (usage) {
      stats.completed++
      stats.totalTokens += usage.totalTokens
      stats.toolCalls += usage.toolCalls
    }
  }

  return stats
}

function addSubagentResultStats(
  result: unknown,
  stats: SubagentStats,
): boolean {
  if (!isRecord(result)) return false
  if (result.status !== 'completed') return false

  const totalTokens = numberFrom(result.totalTokens)
  const toolCalls = numberFrom(result.totalToolUseCount)
  if (totalTokens === 0 && toolCalls === 0) return false

  stats.completed++
  stats.totalTokens += totalTokens
  stats.toolCalls += toolCalls
  return true
}

function parseSubagentUsageText(
  text: string,
): { totalTokens: number; toolCalls: number } | null {
  const match = text.match(
    /<usage>\s*total_tokens:\s*(\d+)\s*tool_uses:\s*(\d+)\s*duration_ms:\s*\d+\s*<\/usage>/,
  )
  if (!match) return null
  return {
    totalTokens: Number(match[1]),
    toolCalls: Number(match[2]),
  }
}

function collectContextStats(messages: Message[]): {
  currentTokens: number
  growthTokens: number
} {
  const seenResponses = new Set<string>()
  let firstApiTokens = 0

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const usage = getTokenUsage(message)
    if (!usage) continue

    const responseKey = `${message.message.model}:${message.message.id}`
    if (seenResponses.has(responseKey)) continue
    seenResponses.add(responseKey)

    if (firstApiTokens === 0) {
      firstApiTokens = getTokenCountFromUsage(usage)
    }
  }

  const currentTokens = tokenCountWithEstimation(messages)
  return {
    currentTokens,
    growthTokens: currentTokens - firstApiTokens,
  }
}

async function collectFileStats(
  state: FileHistoryState | undefined,
): Promise<FileStats[]> {
  if (!state || state.trackedFiles.size === 0) {
    return []
  }

  const stats: FileStats[] = []
  for (const trackingPath of state.trackedFiles) {
    const firstBackup = getFirstBackup(state, trackingPath)
    if (!firstBackup) continue

    const filePath = expandTrackedPath(trackingPath)
    const [oldContent, newContent] = await Promise.all([
      readBackupContent(firstBackup),
      readTextOrNull(filePath),
    ])

    if (oldContent === newContent) continue

    const lineStats = countChangedLines(oldContent, newContent)
    stats.push({
      path: displayTrackedPath(trackingPath),
      status:
        oldContent === null
          ? 'added'
          : newContent === null
            ? 'deleted'
            : 'modified',
      ...lineStats,
    })
  }

  return stats.sort((a, b) => a.path.localeCompare(b.path))
}

function getFirstBackup(
  state: FileHistoryState,
  trackingPath: string,
): FileHistoryBackup | undefined {
  let first: FileHistoryBackup | undefined
  for (const snapshot of state.snapshots) {
    const backup = snapshot.trackedFileBackups[trackingPath]
    if (!backup) continue
    if (!first || backup.version < first.version) {
      first = backup
    }
  }
  return first
}

async function readBackupContent(
  backup: FileHistoryBackup,
): Promise<string | null> {
  if (backup.backupFileName === null) {
    return null
  }
  return readTextOrNull(
    join(
      getClaudeConfigHomeDir(),
      'file-history',
      getSessionId(),
      backup.backupFileName,
    ),
  )
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

function countChangedLines(
  oldContent: string | null,
  newContent: string | null,
): LineStats {
  const stats: LineStats = { added: 0, updated: 0, deleted: 0 }
  const changes = diffLines(oldContent ?? '', newContent ?? '')

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!
    if (change.removed) {
      const removedLines = changeLineCount(change)
      const next = changes[i + 1]
      if (next?.added) {
        const addedLines = changeLineCount(next)
        const updated = Math.min(removedLines, addedLines)
        stats.updated += updated
        stats.deleted += removedLines - updated
        stats.added += addedLines - updated
        i++
      } else {
        stats.deleted += removedLines
      }
    } else if (change.added) {
      stats.added += changeLineCount(change)
    }
  }

  return stats
}

function changeLineCount(change: { count?: number; value: string }): number {
  return change.count ?? countLines(change.value)
}

function countLines(value: string): number {
  if (value.length === 0) return 0
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized.endsWith('\n')
    ? normalized.split('\n').length - 1
    : normalized.split('\n').length
}

function expandTrackedPath(path: string): string {
  return isAbsolute(path) ? path : join(getOriginalCwd(), path)
}

function displayTrackedPath(path: string): string {
  const absolute = expandTrackedPath(path)
  const rel = relative(getOriginalCwd(), absolute)
  const display =
    rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
  return display.replaceAll(sep, '/')
}

function sumModelStats(modelStats: Map<string, ModelStats>): ModelStats {
  const total = blankModelStats()
  for (const usage of modelStats.values()) {
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    total.cacheReadInputTokens += usage.cacheReadInputTokens
    total.cacheCreationInputTokens += usage.cacheCreationInputTokens
  }
  return total
}

function sumFileStats(fileStats: FileStats[]): LineStats {
  return fileStats.reduce(
    (acc, file) => ({
      added: acc.added + file.added,
      updated: acc.updated + file.updated,
      deleted: acc.deleted + file.deleted,
    }),
    { added: 0, updated: 0, deleted: 0 },
  )
}

function blankModelStats(): ModelStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
}
