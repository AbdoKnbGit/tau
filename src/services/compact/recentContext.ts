import type { Message } from '../../types/message.js'

export type RecentContext = {
  startIndex: number
  messagesToKeep: Message[]
  retainedTokens: number
}

type ContentBlock = {
  type: string
  id?: unknown
  tool_use_id?: unknown
  content?: unknown
}
type Span = { first: number; last: number }
type ToolSpan = Span & {
  calls: number
  results: number
  call: number
  result: number
}

function contentBlocks(message: Message): readonly unknown[] {
  if (message.type !== 'assistant' && message.type !== 'user') return []
  return Array.isArray(message.message?.content) ? message.message.content : []
}

function isContentBlock(block: unknown): block is ContentBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    typeof block.type === 'string' &&
    block.type.length > 0
  )
}

function hasMalformedToolResultContent(block: ContentBlock): boolean {
  if (block.type !== 'tool_result' || block.content === undefined) return false
  if (typeof block.content === 'string') return false
  if (!Array.isArray(block.content)) return true
  // A for-of scan sees sparse-array holes, unlike Array.every/some.
  for (const nested of block.content) {
    if (!isContentBlock(nested)) return true
  }
  return false
}

function canStartSuffix(message: Message): boolean {
  if (message.type === 'assistant') return !message.isApiErrorMessage
  if (
    message.type !== 'user' ||
    message.isMeta ||
    message.isVirtual ||
    message.isCompactSummary ||
    message.isVisibleInTranscriptOnly ||
    message.sourceToolAssistantUUID
  ) {
    return false
  }
  // Even a user message mixing text and tool results needs its tool calls.
  return !contentBlocks(message).some(
    block => isContentBlock(block) && block.type === 'tool_result',
  )
}

/**
 * Pick the largest affordable suffix without changing any messages. Progress
 * events are omitted; the suffix is contiguous among non-progress messages,
 * and startIndex still refers to the original input array. The
 * estimator is additive and is called at most once per examined message.
 * Cuts respect whole streamed responses and client tool exchanges, including
 * exchanges interleaved with another response. Unpaired or duplicate tool IDs
 * are left in the summarized portion, never repaired in the preserved suffix.
 *
 * A previous preserved segment is deliberately not retained again: transcript
 * storage links that segment on load, rather than rewriting its original disk
 * parent chain. Starting after its tail keeps the new segment contiguous both
 * in memory and on disk.
 */
export function prepareRecentContext(
  messages: readonly Message[],
  maxTokens: number,
  estimateTokens: (message: Message) => number,
): RecentContext | undefined {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || messages.length < 2) {
    return undefined
  }
  const responses = new Map<string, Span>()
  const tools = new Map<string, ToolSpan>()
  const uuidIndices = new Map<string, number>()
  let floor = 1 // Always leave older history to summarize.
  let lastBoundary: Message | undefined

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (!message || typeof message.type !== 'string') {
      floor = index + 1
      continue
    }
    if (message.type === 'progress') continue
    if (typeof message.uuid !== 'string' || message.uuid.length === 0) {
      floor = index + 1
    } else {
      // Duplicate UUIDs cannot safely identify a persisted segment endpoint.
      if (uuidIndices.has(message.uuid)) floor = index + 1
      uuidIndices.set(message.uuid, index)
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      lastBoundary = message
      floor = index + 1
    }
    if (message.type === 'user' && message.isCompactSummary) floor = index + 1

    if (
      (message.type === 'assistant' || message.type === 'user') &&
      typeof message.message?.content !== 'string' &&
      !Array.isArray(message.message?.content)
    ) {
      floor = index + 1
    }

    if (message.type === 'assistant') {
      const id = message.message?.id
      if (typeof id !== 'string' || id.length === 0) {
        floor = index + 1
      } else {
        const span = responses.get(id)
        if (span) span.last = index
        else responses.set(id, { first: index, last: index })
      }
    }

    for (const block of contentBlocks(message)) {
      if (!isContentBlock(block) || hasMalformedToolResultContent(block)) {
        floor = index + 1
        continue
      }
      if (block.type !== 'tool_use' && block.type !== 'tool_result') continue
      const isCall = block.type === 'tool_use'
      const id = isCall ? block.id : block.tool_use_id
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        message.type !== (isCall ? 'assistant' : 'user')
      ) {
        floor = index + 1
        continue
      }
      let span = tools.get(id)
      if (!span) {
        span = {
          first: index,
          last: index,
          calls: 0,
          results: 0,
          call: -1,
          result: -1,
        }
        tools.set(id, span)
      }
      span.last = index
      if (isCall) {
        span.calls++
        span.call = index
      } else {
        span.results++
        span.result = index
      }
    }
  }

  if (
    lastBoundary?.type === 'system' &&
    lastBoundary.subtype === 'compact_boundary'
  ) {
    const segment = lastBoundary.compactMetadata?.preservedSegment
    if (segment) {
      const tailIndex = uuidIndices.get(segment.tailUuid)
      if (tailIndex === undefined) return undefined
      floor = Math.max(floor, tailIndex + 1)
    }
  }

  // Difference ranges mark all forbidden cuts in O(messages + content blocks).
  const blockedCuts = new Int32Array(messages.length + 1)
  const blockSpan = ({ first, last }: Span): void => {
    if (first === last) return
    blockedCuts[first + 1]!++
    blockedCuts[last + 1]!--
  }
  for (const span of responses.values()) blockSpan(span)
  for (const span of tools.values()) {
    if (span.calls !== 1 || span.results !== 1 || span.call >= span.result) {
      floor = Math.max(floor, span.last + 1)
    } else {
      blockSpan(span)
    }
  }
  let blocked = 0
  for (let index = 0; index < messages.length; index++) {
    blocked += blockedCuts[index]!
    blockedCuts[index] = blocked
  }

  let retainedTokens = 0
  let selected: { startIndex: number; retainedTokens: number } | undefined
  for (let index = messages.length - 1; index >= floor; index--) {
    if (messages[index]!.type === 'progress') continue
    const cost = estimateTokens(messages[index]!)
    if (!Number.isFinite(cost) || cost < 0) break
    retainedTokens += cost
    if (retainedTokens > maxTokens) break
    if (blockedCuts[index] === 0 && canStartSuffix(messages[index]!)) {
      selected = { startIndex: index, retainedTokens }
    }
  }
  return selected
    ? {
        ...selected,
        messagesToKeep: messages
          .slice(selected.startIndex)
          .filter(message => message.type !== 'progress'),
      }
    : undefined
}
