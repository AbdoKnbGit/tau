import type { KiroPayload } from './request.js'

export interface KiroPayloadTrimStats {
  originalBytes: number
  finalBytes: number
  originalEntries: number
  finalEntries: number
  trimmed: boolean
}

type KiroHistoryEntry = KiroPayload['conversationState']['history'][number]

export function checkKiroPayloadSize(payload: KiroPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

export function trimKiroPayloadToLimit(
  payload: KiroPayload,
  maxBytes: number,
  options: {
    preserveLeadingEntries?: number
    /** Round the bytes to drop up to a multiple of this. See below. */
    cutGridBytes?: number
  } = {},
): KiroPayloadTrimStats {
  const history = payload.conversationState.history
  const originalBytes = checkKiroPayloadSize(payload)
  const originalEntries = history.length

  if (history.length === 0 || maxBytes <= 0) {
    return {
      originalBytes,
      finalBytes: originalBytes,
      originalEntries,
      finalEntries: originalEntries,
      trimmed: false,
    }
  }

  _stripEmptyToolUses(history)

  const preserveLeadingEntries = Math.max(
    0,
    Math.min(options.preserveLeadingEntries ?? 0, history.length),
  )

  // History only grows at the tail, so the minimal cut would move forward by
  // about one pair every turn and change the prompt right after the preserved
  // entries on every request: a full prompt-cache miss each turn once a long
  // conversation passes the budget. Rounding the bytes to drop up to a grid
  // keeps the cut on the same entry until the conversation has grown by a
  // grid step, and the turns in between keep their cache.
  const grid = Math.floor(options.cutGridBytes ?? 0)
  const excess = checkKiroPayloadSize(payload) - maxBytes
  if (grid > 0 && excess > 0) {
    const goal = Math.ceil(excess / grid) * grid
    let freed = 0
    let end = preserveLeadingEntries
    while (end + 2 <= history.length && freed < goal) {
      freed += _entryBytes(history[end]!) + _entryBytes(history[end + 1]!)
      end += 2
    }
    history.splice(preserveLeadingEntries, end - preserveLeadingEntries)
  }

  while (history.length >= preserveLeadingEntries + 2 && checkKiroPayloadSize(payload) > maxBytes) {
    history.splice(preserveLeadingEntries, 2)
  }

  if (preserveLeadingEntries === 0) {
    _alignToUserMessage(history)
  }

  _repairOrphanedToolResults(history)

  const finalBytes = checkKiroPayloadSize(payload)
  return {
    originalBytes,
    finalBytes,
    originalEntries,
    finalEntries: history.length,
    trimmed: originalEntries !== history.length,
  }
}

/** Bytes one history entry adds to the serialized payload (plus its comma). */
function _entryBytes(entry: KiroHistoryEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
}

function _stripEmptyToolUses(history: KiroHistoryEntry[]): void {
  for (const entry of history) {
    if (!('assistantResponseMessage' in entry)) continue
    const assistant = entry.assistantResponseMessage
    if (Array.isArray(assistant.toolUses) && assistant.toolUses.length === 0) {
      delete assistant.toolUses
    }
  }
}

function _alignToUserMessage(history: KiroHistoryEntry[]): void {
  while (history.length > 0 && !('userInputMessage' in history[0]!)) {
    history.shift()
  }
}

function _repairOrphanedToolResults(history: KiroHistoryEntry[]): void {
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]!
    if (!('userInputMessage' in entry)) continue

    const userMessage = entry.userInputMessage
    const context = userMessage.userInputMessageContext
    if (!context?.toolResults || context.toolResults.length === 0) continue

    const validToolUseIds = new Set<string>()
    const previous = i > 0 ? history[i - 1] : null
    if (previous && 'assistantResponseMessage' in previous) {
      for (const toolUse of previous.assistantResponseMessage.toolUses ?? []) {
        if (toolUse.toolUseId) validToolUseIds.add(toolUse.toolUseId)
      }
    }

    const kept = context.toolResults.filter(toolResult => validToolUseIds.has(toolResult.toolUseId))
    if (kept.length === context.toolResults.length) continue

    if (kept.length > 0) {
      context.toolResults = kept
    } else {
      delete context.toolResults
      if (Object.keys(context).length === 0) {
        delete userMessage.userInputMessageContext
      }
    }
  }
}
