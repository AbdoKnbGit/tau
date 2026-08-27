/**
 * The per-response header — the dim, right-aligned "27 Aug 2026 10:00 AM ·
 * claude-opus-5" line that sits above an assistant reply.
 *
 * Upstream only renders it inside the ctrl+O detailed transcript, so the only
 * way to keep the model or the date on screen during a normal session was a
 * UserPromptSubmit or Stop hook that injected the text into the conversation.
 * The `always:*` modes render the same header in the normal scrollback — no
 * hook, and nothing added to the model's context.
 *
 * One global-config key (`/config`, or ~/.claude.json) says both WHERE the
 * header shows and WHAT it contains, so it can't be half-configured:
 *
 *   off                       never
 *   transcript                ctrl+O only, time + model (upstream, default)
 *   always:time               10:00 AM
 *   always:time+model         10:00 AM   claude-opus-5
 *   always:date+time          27 Aug 2026 10:00 AM
 *   always:date+time+model    27 Aug 2026 10:00 AM   claude-opus-5
 *
 * Everything here is pure so it can be unit-tested without touching config;
 * the accessor that reads the saved value lives in utils/config.ts.
 */

/** Where the per-response header renders, and what it contains. */
export type MessageHeaderMode =
  | 'off'
  | 'transcript'
  | 'always:time'
  | 'always:time+model'
  | 'always:date+time'
  | 'always:date+time+model'

export const MESSAGE_HEADER_MODES: readonly MessageHeaderMode[] = [
  'off',
  'transcript',
  'always:time',
  'always:time+model',
  'always:date+time',
  'always:date+time+model',
]

/** Upstream behaviour: header only inside the ctrl+O transcript. */
export const DEFAULT_MESSAGE_HEADER_MODE: MessageHeaderMode = 'transcript'

/**
 * Anything unrecognized (older config, hand-edited file) falls back to the
 * default. A bare `always` — the shape this setting shipped with for one
 * build — keeps meaning what it did: always visible, time and model.
 */
export function normalizeMessageHeaderMode(value: unknown): MessageHeaderMode {
  if (value === 'always') return 'always:time+model'
  return MESSAGE_HEADER_MODES.includes(value as MessageHeaderMode)
    ? (value as MessageHeaderMode)
    : DEFAULT_MESSAGE_HEADER_MODE
}

/**
 * Whether the header renders on the current screen. `isTranscriptMode` is the
 * ctrl+O expanded view.
 */
export function shouldShowMessageHeader(
  mode: MessageHeaderMode,
  isTranscriptMode: boolean,
): boolean {
  if (mode === 'off') return false
  if (mode === 'transcript') return isTranscriptMode
  return true
}

/** Whether the time is prefixed with the date, e.g. "27 Aug 2026 10:00 AM". */
export function messageHeaderShowsDate(mode: MessageHeaderMode): boolean {
  return mode.includes('date')
}

/** Whether the model id is shown next to the time. */
export function messageHeaderShowsModel(mode: MessageHeaderMode): boolean {
  // 'transcript' is upstream's header, which has always carried the model.
  return mode === 'transcript' || mode.includes('model')
}

/**
 * "10:00 AM", or "27 Aug 2026 10:00 AM" with the date included.
 *
 * Returns '' for anything that isn't a real date, so a malformed timestamp
 * renders as an empty column instead of "Invalid Date".
 */
export function formatMessageHeaderTimestamp(
  timestamp: string | number | Date,
  includeDate: boolean,
): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''

  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
  if (!includeDate) return time

  // en-GB gives "27 Aug 2026" — day first, no comma, and the same width all
  // year, which keeps the right-aligned column from jittering.
  const day = date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  return `${day} ${time}`
}
