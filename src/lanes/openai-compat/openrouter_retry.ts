import { setTimeout } from 'node:timers/promises'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import { OpenRouterToolCallError, OpenRouterUpstreamError } from './openrouter_tools.js'

// Waits before re-sending to a rate-limited or saturated provider: about 30s
// in all. A limit that resets later than MAX_CAPACITY_WAIT_MS, or waits that
// would add up past MAX_TOTAL_WAIT_MS, end the turn instead.
let capacityDelaysMs = [2_000, 4_000, 8_000, 16_000]
const MAX_CAPACITY_WAIT_MS = 60_000
const MAX_TOTAL_WAIT_MS = 90_000

export function _setOpenRouterCapacityDelaysForTest(delays: number[]): void {
  capacityDelaysMs = delays
}

export type OpenRouterAttempt = { attempt: number; recovery: boolean; note?: string }

/** Complete single-line string fields at the start of cut-off arguments, such
 * as the file_path of a Write whose content never arrived. */
function leadingFields(partial: string): string {
  const fields: string[] = []
  const field = /\s*[{,]\s*"([A-Za-z_][\w-]{0,40})"\s*:\s*("(?:[^"\\]|\\.)*")/y
  for (let match; fields.length < 2 && (match = field.exec(partial));) {
    let value: unknown
    try { value = JSON.parse(match[2]!) } catch { break }
    if (typeof value === 'string' && value.length <= 300 && !/[\r\n]/.test(value)) fields.push(`${match[1]}: ${value}`)
  }
  return fields.join(', ')
}

/** When generation dies while a tool call is still being written, resending
 * the same request asks for the same long call again. Say what happened, as
 * a last message after the unchanged conversation, so the model can redo it
 * in smaller calls instead of guessing at a cause. */
function cutOffNote(error: OpenRouterUpstreamError): string | undefined {
  const call = error.unfinishedCalls[0]
  if (!call) return undefined
  const fields = leadingFields(call.arguments)
  return '<system-reminder>\n' +
    `Your previous reply was cut off by the provider${error.provider ? ` (${error.provider})` : ''} while you were ` +
    `still generating the arguments of a ${call.name} call${fields ? ` (${fields})` : ''}. That call was discarded ` +
    'and did not run.\nThis happens when a single tool call carries a very long argument. Make the call again with ' +
    'shorter arguments, about 100 lines or fewer per call: write a large file in parts, adding the rest with ' +
    'further calls, or split the code into several smaller files.\n</system-reminder>'
}

function describe(failure?: OpenRouterUpstreamError): string {
  return [failure?.generation && `generation ${failure.generation}`,
    failure?.provider && `provider ${failure.provider}`,
    failure?.code && `code ${failure.code}`].filter(Boolean).join(', ') || 'upstream error without a generation ID'
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return minutes >= 1 ? `${minutes}m` : `${Math.ceil(ms / 1000)}s`
}

/** Retry an upstream generation only while nothing has been published.
 * Buffer preliminary reasoning and, for tool requests, the assistant preamble.
 * A sentence announcing a tool is not proof that the tool batch will complete.
 * Once any buffered content is published, never replay it.
 *
 * A rate-limited or saturated provider gets the identical streaming request
 * again after a backoff. Any other retryable failure gets one non-streaming
 * recovery. The prompt, schemas and cache identity never change.
 */
export async function* retryOpenRouterStream<T>(
  start: (next: OpenRouterAttempt) => AsyncGenerator<AnthropicStreamEvent, T> | Promise<AsyncGenerator<AnthropicStreamEvent, T>>,
  signal?: AbortSignal,
  options: { bufferText?: boolean } = {},
): AsyncGenerator<AnthropicStreamEvent, T> {
  let lastProgress = 0
  const began = Date.now()
  const modes: string[] = []
  let initialFailure: OpenRouterUpstreamError | undefined
  let capacityWaits = 0
  let waitedMs = 0
  let recovery = false
  let note: string | undefined
  let explained = false
  // Preserve every attempt in the surfaced error: the API error message is
  // saved in the transcript, whereas an abandoned stream is not. A recovery
  // failure must never look like recovery was not attempted.
  const exhausted = (terminal: OpenRouterToolCallError) => {
    const runs = modes.reduce<[string, number][]>((all, mode) => {
      const last = all.at(-1)
      if (last?.[0] === mode) last[1]++
      else all.push([mode, 1])
      return all
    }, []).map(([mode, count]) => count > 1 ? `${mode} ${count} times` : mode).join(', then ')
    terminal.message += ` Recovery failed after ${modes.length} attempts (${runs})` +
      (capacityWaits ? ` over ${Math.round((Date.now() - began) / 1000)}s while the provider reported rate limiting or no free capacity` : '') +
      `.${explained ? ' The recovery told the model its tool call had been cut off and asked for shorter arguments.' : ''}` +
      ` Initial failure: ${describe(initialFailure)}. No further recovery was attempted.`
    return terminal
  }
  for (let attempt = 0; ; attempt++) {
    modes.push(recovery ? 'non-streaming' : 'streaming')
    let published = false
    let bufferLimitReached = false
    const pending: AnthropicStreamEvent[] = []
    const bufferedBlocks = new Set<number>()
    let pendingSize = 0
    let stream: AsyncGenerator<AnthropicStreamEvent, T> | undefined
    let delayMs = 0
    try {
      signal?.throwIfAborted()
      stream = await start({ attempt, recovery, note })
      for (;;) {
        const next = await stream.next()
        if (next.done) {
          yield* pending
          return next.value
        }
        const event = next.value
        if (event.type === 'openrouter_progress') {
          // Actual network progress keeps the idle watchdog informed while
          // content is buffered. It is neither transcript content nor a tool.
          if (Date.now() - lastProgress >= 5000) {
            lastProgress = Date.now()
            yield event
          }
          continue
        }
        if (!published) {
          if (event.type === 'content_block_start' && (event.content_block?.type === 'thinking' ||
            (options.bufferText && event.content_block?.type === 'text'))) {
            bufferedBlocks.add(event.index!)
          }
          if (event.type === 'message_start' ||
            (event.index !== undefined && bufferedBlocks.has(event.index))) {
            pending.push(event)
            pendingSize += JSON.stringify(event).length
            if (event.type === 'content_block_stop') bufferedBlocks.delete(event.index!)
            // Keep memory bounded even for very long reasoning-only streams.
            if (pendingSize < 256 * 1024 && pending.length < 4096) continue
            bufferLimitReached = true
            published = true
            yield* pending.splice(0)
            continue
          }
        }
        published = true
        yield* pending.splice(0)
        yield next.value
      }
    } catch (error) {
      if (signal?.aborted) throw error
      if (!(error instanceof OpenRouterUpstreamError)) {
        if (attempt === 0) throw error
        throw exhausted(error instanceof OpenRouterToolCallError ? error
          : new OpenRouterToolCallError(`The recovery request failed: ${error instanceof Error ? error.message : String(error)}.`))
      }
      initialFailure ??= error
      const resetMs = error.retryAfterMs ?? 0
      const scheduled = capacityDelaysMs[capacityWaits]
      delayMs = error.capacity ? Math.max(resetMs, (scheduled ?? 0) * (0.8 + Math.random() * 0.4)) : 500
      const canRetry = error.capacity
        ? scheduled !== undefined && resetMs <= MAX_CAPACITY_WAIT_MS && waitedMs + delayMs <= MAX_TOTAL_WAIT_MS
        : !modes.includes('non-streaming')
      if (published || !error.canRetryBeforeOutput || !canRetry) {
        if (attempt > 0) throw exhausted(error)
        const reason = published
          ? bufferLimitReached ? 'the buffer limit was reached and output was published' : 'output was already published'
          : resetMs > MAX_CAPACITY_WAIT_MS ? `the provider's limit resets in ${duration(resetMs)}`
          // A request OpenRouter refused outright (404, 403...) says so itself.
          : error.status === undefined ? 'the upstream error is not retryable' : undefined
        if (reason) error.message += ` Recovery was not attempted: ${reason}.`
        throw error
      }
      if (error.capacity) capacityWaits++
      recovery = !error.capacity
      // A capacity wait resends the previous request unchanged; only the
      // recovery after a cut-off tool call adds the explanation.
      if (recovery) note = cutOffNote(error)
      explained ||= note !== undefined
      waitedMs += delayMs
    } finally {
      await stream?.return(undefined as T)
    }
    await setTimeout(delayMs, undefined, { signal })
  }
}
