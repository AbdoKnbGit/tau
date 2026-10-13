import { codexApi, CodexApiError, type CodexResponsesRequest, type CodexStreamEvent } from './api.js'
import { isAbortError, isRetryableNetworkError, isRetryableProviderError } from '../../services/api/transport_error.js'
import { logForDebugging } from '../../utils/debug.js'

function isDisconnectedStream(error: unknown): boolean {
  if (isRetryableNetworkError(error)) return true
  // Node's fetch wraps interrupted response bodies in TypeError('terminated'),
  // with the transport code on its cause. Keep this policy local to OpenAI.
  let cause = error
  for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
    const value = cause as { code?: unknown; cause?: unknown }
    if (value.code === 'UND_ERR_SOCKET' || value.code === 'UND_ERR_BODY_TIMEOUT') return true
    cause = value.cause
  }
  return false
}

function transientStreamFailure(event: CodexStreamEvent): Error | undefined {
  if (event.type !== 'response.failed' && event.type !== 'error') return undefined
  const value = event as any
  const error = value.response?.error ?? value.error ?? value
  const status = Number(value.status ?? value.status_code)
  if (status >= 500 && status < 600) return new CodexApiError(status, JSON.stringify(error))
  if (['server_error', 'internal_server_error', 'temporarily_unavailable'].includes(error.code)) {
    return new CodexApiError(500, JSON.stringify(error))
  }
  return undefined
}

function hasOutput(event: CodexStreamEvent): boolean {
  const value = event as any
  if (event.type === 'response.output_text.delta') return typeof value.delta === 'string' && value.delta.length > 0
  if (event.type !== 'response.output_item.added' && event.type !== 'response.output_item.done') return false
  // The lane emits tool_use only at output_item.done. A started call and its
  // argument deltas are still provisional: no tool can have executed yet.
  // Buffer them until done so retry can discard the entire failed attempt.
  if (value.item?.type === 'function_call' || value.item?.type === 'custom_tool_call') {
    return event.type === 'response.output_item.done'
  }
  return value.item?.type === 'message' && value.item.content?.some((part: any) => part.text?.length > 0)
}

/** Retry a disconnected reasoning-only reply once, reusing the exact request.
 * Provisional reasoning and tool arguments are held until text/a complete call/a successful terminal event,
 * so a failed attempt cannot leave partial thinking or opaque state in history.
 * Heartbeats keep the outer idle watchdog alive while that state is provisional.
 */
export async function* streamCodexWithNoOutputRetry(
  request: CodexResponsesRequest,
  signal: AbortSignal,
  turnId?: string,
): AsyncGenerator<CodexStreamEvent> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending: CodexStreamEvent[] = []
    let producedOutput = false
    let started = false
    let completed = false
    try {
      for await (const event of codexApi.streamResponses(request, signal, turnId)) {
        if (signal.aborted) return
        started = true
        const failure = transientStreamFailure(event)
        if (failure && !producedOutput) throw failure
        if (event.type === 'response.failed' || event.type === 'error') {
          // Deterministic failures (auth, schema, quota) keep the normal handler.
          yield event
          return
        }
        const terminal = event.type === 'response.completed' || event.type === 'response.incomplete'
        producedOutput ||= hasOutput(event)
        if (producedOutput || terminal) {
          yield* pending
          pending.length = 0
          yield event
          if (terminal) {
            completed = true
            return
          }
        } else if (event.type === 'response.created' || event.type === 'response.in_progress') {
          yield event
        } else {
          pending.push(event)
          yield { type: 'codex.retry_pending' }
        }
      }
      if (!completed && !signal.aborted) {
        throw Object.assign(new Error('Responses stream closed before the response completed'), { code: 'ECONNRESET' })
      }
      return
    } catch (error) {
      if (
        attempt === 0 && started && !producedOutput && !isAbortError(error, signal) &&
        (isDisconnectedStream(error) || isRetryableProviderError(error) ||
          (error instanceof CodexApiError && error.isRetryable))
      ) {
        logForDebugging(`Codex reply interrupted before text or a complete tool call; retrying once: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      throw error
    }
  }
}
