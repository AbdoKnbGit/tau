import { parseReferences } from '../history.js'

/**
 * What the transcript shows for a prompt whose pasted text the prompt bar folded
 * into `[Pasted text #N +M lines]`. It is stored beside the message content, which
 * keeps the full text: only `message.content` reaches a request, so folding the
 * display cannot change what the model reads or what the prompt cache sees.
 *
 * Undefined when nothing was folded, including when a hook rewrote the prompt.
 */
export function getPastedPromptDisplay(
  preExpansion: string | undefined,
  expanded: unknown,
): string | undefined {
  if (!preExpansion || typeof expanded !== 'string') return undefined
  const folded = preExpansion.trim()
  if (folded === expanded.trim()) return undefined
  return parseReferences(folded).length > 0 ? folded : undefined
}

/** `/name [Pasted text #1 +3 lines]` gives the part after the command name. */
export function getFoldedCommandArgs(
  folded: string | undefined,
): string | undefined {
  if (!folded) return undefined
  const space = folded.search(/\s/)
  return space < 0 ? undefined : folded.slice(space + 1).trim() || undefined
}

/** Marks the message that echoes a slash command, so its arguments fold too. */
export function foldPastedCommandArgs<
  Result extends { messages: readonly unknown[] },
>(result: Result, folded: string | undefined): Result {
  if (!folded) return result
  let marked = false
  const messages = result.messages.map(message => {
    const candidate = message as {
      type?: string
      message?: { content?: unknown }
    }
    if (
      marked ||
      candidate.type !== 'user' ||
      !hasCommandArgs(candidate.message?.content)
    ) {
      return message
    }
    marked = true
    return { ...candidate, pastedDisplayText: folded }
  })
  return { ...result, messages }
}

function hasCommandArgs(content: unknown): boolean {
  if (typeof content === 'string') return content.includes('<command-args>')
  return (
    Array.isArray(content) &&
    content.some(
      block =>
        block?.type === 'text' && String(block.text).includes('<command-args>'),
    )
  )
}
