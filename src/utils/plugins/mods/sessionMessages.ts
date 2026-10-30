import type { Message } from '../../../types/message.js'

export type ModToolResultSummary = {
  tool_use_id: string
  text: string
  isError: boolean
  result?: unknown
}

export type ModToolUseSummary = {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  result?: unknown
  text?: string
  isError?: true
  agentId?: string
  durationMs?: number
}

export type ModSessionMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: ModToolUseSummary[]
  toolResults?: ModToolResultSummary[]
}

export type ModApiMessage = {
  role: 'user' | 'assistant'
  content: Array<{ type: string; [key: string]: unknown }>
}

type Block = ModApiMessage['content'][number]
type ConversationMessage = Extract<Message, { type: 'user' | 'assistant' }>
const MAX_MESSAGES = 4096

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n')
}

function blocksOf(message: ConversationMessage): Block[] {
  const content = message.message.content
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function isConversationMessage(message: Message): message is ConversationMessage {
  return (message.type === 'user' || message.type === 'assistant') && !message.isVirtual &&
    !(message.type === 'assistant' && message.isApiErrorMessage)
}

function activeConversation(messages: readonly Message[]): ConversationMessage[] {
  const boundary = messages.findLastIndex(message => message.type === 'system' && message.subtype === 'compact_boundary')
  // A microcompact boundary records a cache optimization, not replaced history.
  return messages.slice(boundary + 1).filter(isConversationMessage)
}

function resultSummaries(message: ConversationMessage): ModToolResultSummary[] {
  if (message.type !== 'user') return []
  const blocks = blocksOf(message).filter(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
  return blocks.map(block => {
    const text = textOf(block.content)
    const isError = block.is_error === true
    return {
      tool_use_id: block.tool_use_id as string,
      text,
      isError,
      // Tau stores one typed result per native tool-result message. Do not
      // attribute that record to several unrelated results in a merged row.
      ...(blocks.length === 1 && message.toolUseResult !== undefined
        ? { result: message.toolUseResult } : {}),
    }
  })
}

/** Count user submissions, not tool replies, generated context or loop steps. */
export function countModSessionTurns(messages: readonly Message[]): number {
  return messages.filter(message => {
    if (message.type !== 'user' || message.isVirtual || message.isMeta || message.isCompactSummary || message.isVisibleInTranscriptOnly) return false
    if (message.origin && message.origin.kind !== 'human') return false
    const blocks = blocksOf(message)
    return blocks.length > 0 && !blocks.some(block => block.type === 'tool_result')
  }).length
}

export function projectModSessionMessages(messages: readonly Message[]): ModSessionMessage[]
export function projectModSessionMessages(messages: readonly Message[], options: { as: 'api' }): ModApiMessage[]
export function projectModSessionMessages(messages: readonly Message[], options?: { as?: 'api' }): ModSessionMessage[] | ModApiMessage[]
/**
 * Read-only projection of the retained conversation. Callers requesting API
 * form may supply the engine's normalized messages to include converted
 * attachments/reminders; this function never runs or mutates model caches.
 */
export function projectModSessionMessages(messages: readonly Message[], options?: { as?: 'api' }): ModSessionMessage[] | ModApiMessage[] {
  const retained = activeConversation(messages)
  if (options?.as === 'api') {
    const window = retained.slice(-MAX_MESSAGES)
    const firstUser = window.findIndex(message => message.type === 'user')
    if (firstUser < 0) return []
    return structuredClone(window.slice(firstUser).map(message => ({
      role: message.type,
      content: blocksOf(message).map(block => {
        // Per-request cache markers are transport metadata, not transcript data.
        const { cache_control: _cacheControl, ...content } = block
        return content as Block
      }),
    })))
  }

  const outcomes = new Map<string, ModToolResultSummary>()
  for (const message of retained) {
    for (const result of resultSummaries(message)) outcomes.set(result.tool_use_id, result)
  }
  const rows = retained.slice(-MAX_MESSAGES).map(message => {
    const toolResults = resultSummaries(message)
    const toolUses: ModToolUseSummary[] = message.type !== 'assistant' ? [] : blocksOf(message)
      .filter(block => block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string')
      .map(block => {
        const result = outcomes.get(block.id as string)
        const record = isRecord(result?.result) ? result.result : undefined
        const isAgent = block.name === 'Agent' || block.name === 'Task'
        return {
          tool_use_id: block.id as string,
          tool: block.name as string,
          input: isRecord(block.input) ? block.input : {},
          ...(result ? { text: result.text, ...(result.isError ? { isError: true as const } : {}),
            ...(result.result !== undefined ? { result: result.result } : {}) } : {}),
          ...(isAgent && !result?.isError && typeof record?.agentId === 'string' ? { agentId: record.agentId } : {}),
          ...(isAgent && !result?.isError && record?.status === 'completed' &&
            typeof record.totalDurationMs === 'number' && Number.isFinite(record.totalDurationMs)
            ? { durationMs: record.totalDurationMs } : {}),
        }
      })
    return {
      role: message.type,
      text: textOf(message.message.content),
      toolUses,
      ...(toolResults.length ? { toolResults } : {}),
    }
  })
  return structuredClone(rows)
}
