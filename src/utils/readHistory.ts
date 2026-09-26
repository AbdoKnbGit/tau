/**
 * Which agents have read each file this session.
 *
 * The read-state caches that gate Edit, Write and NotebookEdit forget reads:
 * compaction and /clear empty them, the LRU drops the oldest entries once it
 * is full, and a fresh subagent starts with an empty one. A model that
 * remembers reading a file is then told it "has not been read yet", which
 * contradicts what it saw and invites arguing or workarounds instead of a new
 * Read. This record only lets the refusal say which case applies. It never
 * satisfies the gate: an edit still needs a read the current cache holds.
 */
import { normalize } from 'path'
import { hasBinaryExtension, isBinaryContent } from '../constants/files.js'
import { addLineNumbers } from './file.js'
import type { FileStateCache } from './fileStateCache.js'

const MAIN_THREAD = 'main'
const MAX_TRACKED_PATHS = 2000

const readers = new Map<string, Set<string>>()

/** Record a Read of `filePath` by the main thread or a subagent. */
export function recordFileRead(
  filePath: string,
  agentId: string | undefined,
): void {
  const key = normalize(filePath)
  const agents = readers.get(key) ?? new Set<string>()
  agents.add(agentId ?? MAIN_THREAD)
  // Re-insert so the size bound drops the least recently read path first.
  readers.delete(key)
  readers.set(key, agents)
  if (readers.size > MAX_TRACKED_PATHS) {
    const oldest = readers.keys().next().value
    if (oldest !== undefined) readers.delete(oldest)
  }
}

/** A new conversation (/clear) has read nothing yet. */
export function resetReadHistory(): void {
  readers.clear()
}

const NEVER_READ = 'File has not been read yet.'
const READ_EARLIER =
  'You read this file earlier, but that read is no longer on record (the conversation was compacted, or older reads were dropped to save memory).'
const READ_BY_OTHER_AGENT =
  'This file was read by another agent, not in this conversation.'
const PARTIAL_VIEW_BASE =
  'Only part of this file has been read (a skeleton, or content injected with parts removed)'
const PARTIAL_VIEW = `${PARTIAL_VIEW_BASE}.`

/**
 * The refusal for changing a file that has no current read.
 *
 * `neverRead` finishes the message when nobody read the file this session,
 * and stays each tool's long-standing wording. `action` ("before editing
 * it") and the optional `after` step finish the other cases.
 */
export function unreadFileRefusal(
  filePath: string,
  agentId: string | undefined,
  advice: { neverRead: string; action: string; after?: string },
): string {
  const then = advice.after ? `, then ${advice.after}` : ''
  const agents = readers.get(normalize(filePath))
  if (!agents) return `${NEVER_READ} ${advice.neverRead}`
  if (agents.has(agentId ?? MAIN_THREAD)) {
    return `${READ_EARLIER} Read it again with the Read tool ${advice.action}${then}. It may have changed since.`
  }
  return `${READ_BY_OTHER_AGENT} Read it yourself with the Read tool ${advice.action}${then}.`
}

/** The refusal for replacing a file the model has only seen part of. */
export function partialViewRefusal(action: string): string {
  return `${PARTIAL_VIEW} Read it in full with the Read tool ${action}.`
}

// A refused change to an unread file shows the file instead of only asking
// for a Read. The model sees the real content, that is recorded as a real
// read, and its next grounded call can succeed, so the refusal cannot repeat
// into a loop. The refused change itself is never applied.
const SHOW_MAX_LINES = 2000
const SHOW_MAX_CHARS = 60_000

const SHOWN_LEADS = {
  never: 'File has not been read yet, so nothing was changed.',
  self: 'Your earlier read of this file is no longer on record (the conversation was compacted, or older reads were dropped to save memory), so nothing was changed.',
  other:
    'This file was read by another agent, not in this conversation, so nothing was changed.',
  partial: `${PARTIAL_VIEW_BASE}, so nothing was changed.`,
}

/**
 * The refusal for changing a file with no current read, showing its current
 * content and recording that as the model's read. A file too large to show
 * whole shows only `window()` (when given), recorded as a partial view, which
 * Edit accepts only with an exact match. Returns undefined when nothing can be
 * shown (binary, or too large with no window); the caller then asks for a
 * Read instead.
 *
 * `redo` tells the model what to do with the content that follows it.
 * `display` replaces the numbered file with another rendering (notebook
 * cells). `partialView` says the model has only seen part of the file.
 */
export function refuseWithCurrentContent(
  filePath: string,
  context: { readFileState: FileStateCache; agentId?: string },
  file: { content: string; timestamp: number },
  redo: string,
  options: {
    window?: () => { lines: string[]; startLine: number } | null | undefined
    display?: string
    partialView?: boolean
  } = {},
): string | undefined {
  const { window, display, partialView } = options
  const visible = display ?? file.content
  if (
    hasBinaryExtension(filePath) ||
    isBinaryContent(Buffer.from(visible.slice(0, 8192)))
  ) {
    return undefined
  }
  const whole =
    visible.length <= SHOW_MAX_CHARS &&
    visible.split('\n').length <= SHOW_MAX_LINES
  const part = whole ? undefined : window?.()
  if (!whole && !part) return undefined

  // Decide the wording before this read is recorded.
  const agents = readers.get(normalize(filePath))
  const lead = partialView
    ? SHOWN_LEADS.partial
    : !agents
    ? SHOWN_LEADS.never
    : agents.has(context.agentId ?? MAIN_THREAD)
      ? SHOWN_LEADS.self
      : SHOWN_LEADS.other

  context.readFileState.set(filePath, {
    content: file.content,
    timestamp: file.timestamp,
    offset: undefined,
    limit: undefined,
    ...(part && { isPartialView: true }),
  })
  recordFileRead(filePath, context.agentId)

  const shown =
    display !== undefined
      ? display
      : part
        ? addLineNumbers({ content: part.lines.join('\n'), startLine: part.startLine })
        : addLineNumbers({ content: file.content, startLine: 1 })
  const scope = part
    ? ` (only lines ${part.startLine}-${part.startLine + part.lines.length - 1}, the part closest to your change: the file is too large to show whole)`
    : ''
  const note =
    display !== undefined
      ? ''
      : ' (the line-number prefixes are not part of the file)'
  return `${lead} Tau read it for you now${scope}, which counts as your Read. ${redo}${note}:\n${shown}`
}

/**
 * True for every refusal above, so the UI can show them as routine. Matches
 * only the start: a refusal may show file content that repeats these words.
 */
export function isUnreadFileRefusal(message: string): boolean {
  const text = message.trimStart()
  return [
    'File has not been read yet',
    'You read this file earlier',
    'Your earlier read of this file is no longer on record',
    'This file was read by another agent',
    PARTIAL_VIEW_BASE,
  ].some(prefix => text.startsWith(prefix))
}
