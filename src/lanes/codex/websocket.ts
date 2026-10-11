/**
 * Responses over WebSocket, the transport native Codex uses for every
 * request to the ChatGPT backend (codex-rs codex-api/src/endpoint/
 * responses_websocket.rs; the OpenAI provider sets supports_websockets).
 *
 * Why: one HTTP POST per request lets the backend place each follow-up on a
 * different server. Measured live on GPT-6 Luna (2026-10-11, interleaved
 * runs): over HTTP 13 of 33 follow-ups read an older cache entry or none,
 * re-sending thousands of tokens each; over one kept connection 0 of 33
 * did. Same request body, same prefix: only the transport differs.
 *
 * Protocol, as codex-rs speaks it: connect to `wss://<base>/responses` with
 * the usual headers plus `OpenAI-Beta: responses_websockets=2026-02-06`, send
 * `{"type":"response.create", ...request}` as one text frame, read one JSON
 * event per frame (the same events the SSE stream carries) until a terminal
 * one. A connection serves one request at a time and is reused while the
 * conversation lasts; the server ends it after 60 minutes.
 */

import WebSocket from 'ws'

const OPENAI_BETA = 'responses_websockets=2026-02-06'
const CONNECT_TIMEOUT_MS = 15_000
/** codex-rs's default stream idle timeout. */
const EVENT_TIMEOUT_MS = 300_000
/** The server closes a connection at 60 minutes; retire it before that. */
const MAX_CONNECTION_AGE_MS = 55 * 60_000
/** Idle connections stay open on the server (9 minutes measured); ours close after 30. */
const IDLE_CLOSE_MS = 30 * 60_000
/**
 * The backend pings an open connection about every 20 seconds (measured
 * 2026-10-11), so we send no pings of our own. One that has been silent for
 * three of those has most likely died without a close (sleep, network
 * change): open a fresh one instead.
 */
const SILENCE_LIMIT_MS = 60_000
const MAX_CONNECTIONS = 8
const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error'])

export type CodexSocketEvent = Record<string, unknown> & { type: string }

/** The events after the first; `return()` releases the connection even before the first read. */
export type CodexSocketEvents = AsyncIterableIterator<CodexSocketEvent> & {
  return(): Promise<IteratorResult<CodexSocketEvent>>
}

/** `connection` numbers the connections this process opened, for the cache log. */
export type CodexSocketResponse = { first: CodexSocketEvent; rest: CodexSocketEvents; connection: number }

let connectionsOpened = 0

function isCleanEnd(event: CodexSocketEvent): boolean {
  return event.type === 'response.completed' || event.type === 'response.incomplete'
}

/**
 * A generator's `return()` before its first `next()` skips its `finally`, so
 * a reader that stops before reading `rest` would leave the socket busy.
 */
function eventsOf(events: AsyncGenerator<CodexSocketEvent>, abandon: () => void): CodexSocketEvents {
  let begun = false
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      begun = true
      return events.next()
    },
    return() {
      if (!begun) abandon()
      return events.return(undefined)
    },
  }
}

/** The connection could not be used: send this request over HTTP instead. */
export class CodexWebSocketUnavailable extends Error {
  constructor(
    message: string,
    /** Handshake HTTP status, when the server answered one. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'CodexWebSocketUnavailable'
  }
}

/** A failure the HTTP path would report as this status (wrapped error event). */
export class CodexWebSocketHttpError extends Error {
  constructor(
    readonly status: number,
    /** What the HTTP response body would have been: the error object. */
    readonly body: string,
    readonly retryAfter?: string,
  ) {
    super(`websocket error event ${status}`)
    this.name = 'CodexWebSocketHttpError'
  }
}

/** An `error` event that carries an HTTP status, as the error HTTP would have thrown. */
function wrappedHttpError(event: CodexSocketEvent): CodexWebSocketHttpError | null {
  if (event.type !== 'error') return null
  const status = Number(event.status ?? event.status_code)
  if (!Number.isFinite(status) || status < 400) return null
  const headers = event.headers as Record<string, unknown> | undefined
  const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After']
  const body = JSON.stringify(event.error !== undefined ? { error: event.error } : event)
  return new CodexWebSocketHttpError(status, body, retryAfter == null ? undefined : String(retryAfter))
}

function connectionReset(message: string): Error {
  // Classified like a dropped HTTP stream by the existing retry checks.
  return Object.assign(new Error(message), { code: 'ECONNRESET' })
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError')
}

class ResponsesSocket {
  readonly ready: Promise<void>
  readonly openedAt = Date.now()
  readonly id = ++connectionsOpened
  busy = false
  private readonly socket: WebSocket
  private closed = false
  private lastHeard = Date.now()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private onFrame: ((text: string) => void) | null = null
  private onEnd: ((error: Error) => void) | null = null

  constructor(
    url: string,
    headers: Record<string, string>,
    /** The endpoint and login the handshake authenticated. */
    readonly identity: string,
    private readonly silenceLimitMs: number,
  ) {
    this.socket = new WebSocket(url, {
      headers,
      perMessageDeflate: false,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    })
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve())
      this.socket.once('unexpected-response', (req, res) => {
        res?.resume?.()
        req?.destroy?.()
        reject(new CodexWebSocketUnavailable(`websocket handshake answered HTTP ${res?.statusCode}`, res?.statusCode))
      })
      this.socket.once('error', error => reject(new CodexWebSocketUnavailable(`websocket handshake failed: ${error.message}`)))
    })
    // A rejected handshake is reported by `start`; never as an unhandled rejection.
    this.ready.catch(() => {})
    const heard = (): void => {
      this.lastHeard = Date.now()
    }
    this.socket.on('ping', heard)
    this.socket.on('pong', heard)
    this.socket.on('message', data => {
      heard()
      this.onFrame?.(data.toString())
    })
    this.socket.on('close', () => {
      this.closed = true
      this.onEnd?.(connectionReset('websocket closed before the response completed'))
    })
    this.socket.on('error', error => this.onEnd?.(connectionReset(`websocket error: ${error.message}`)))
  }

  get usable(): boolean {
    return !this.closed
      && this.socket.readyState !== WebSocket.CLOSING
      && this.socket.readyState !== WebSocket.CLOSED
      && Date.now() - this.openedAt < MAX_CONNECTION_AGE_MS
      && Date.now() - this.lastHeard < this.silenceLimitMs
  }

  close(): void {
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.socket.terminate()
  }

  /** A connection serving a request keeps the process alive; an idle one must not. */
  private hold(active: boolean): void {
    const raw = (this.socket as unknown as { _socket?: { ref?: () => void; unref?: () => void } })._socket
    if (active) raw?.ref?.()
    else raw?.unref?.()
  }

  /**
   * Send one request and wait for its first event. A wrapped HTTP error as
   * the first event throws, so callers can retry it exactly like the HTTP
   * path's initial request. The rest of the events come from `rest`.
   */
  async start(payload: string, signal?: AbortSignal): Promise<CodexSocketResponse> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.hold(true)
    const frames: string[] = []
    let failure: Error | null = null
    let wake: (() => void) | null = null
    const notify = (): void => {
      const resume = wake
      wake = null
      resume?.()
    }
    this.onFrame = text => {
      frames.push(text)
      notify()
    }
    this.onEnd = error => {
      failure ??= error
      notify()
    }
    const onAbort = (): void => {
      failure = abortError()
      notify()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let finished = false
    const finish = (clean: boolean): void => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', onAbort)
      this.onFrame = null
      this.onEnd = null
      this.busy = false
      this.hold(false)
      // Frames of an unfinished response could still arrive and would be
      // read as the next request's: only a clean finish keeps the socket.
      if (!clean) this.close()
      else if (!this.closed) {
        this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
        this.idleTimer.unref?.()
      }
    }

    const next = async (): Promise<CodexSocketEvent | null> => {
      for (;;) {
        const text = frames.shift()
        if (text !== undefined) {
          let event: CodexSocketEvent
          try {
            event = JSON.parse(text) as CodexSocketEvent
          } catch {
            continue
          }
          if (typeof event?.type !== 'string') continue
          return event
        }
        if (failure) throw failure
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            failure ??= connectionReset('websocket idle timeout waiting for the next event')
            resolve()
          }, EVENT_TIMEOUT_MS)
          timer.unref?.()
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    }

    try {
      // Aborted while the connection was opening: send nothing.
      if (signal?.aborted) throw abortError()
      if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw connectionReset('websocket closed before the request was sent')
      try {
        this.socket.send(payload, error => {
          if (error) this.onEnd?.(connectionReset(`websocket send failed: ${error.message}`))
        })
      } catch (error) {
        throw connectionReset(`websocket send failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const first = await next()
      if (!first) throw connectionReset('websocket ended before any event')
      if (first.type === 'error') {
        const code = (first as { error?: { code?: string } }).error?.code
        // The connection reached its 60-minute limit (or lost the previous
        // response): a fresh connection serves the same request.
        if (code === 'websocket_connection_limit_reached' || code === 'previous_response_not_found') {
          throw connectionReset(`websocket ${code}`)
        }
        const httpError = wrappedHttpError(first)
        if (httpError) throw httpError
      }
      if (TERMINAL_EVENTS.has(first.type)) {
        // A one-event response (an error the loop reports itself). The
        // server is done with it, but the socket saw a failure: retire it.
        finish(isCleanEnd(first))
        return { first, rest: eventsOf((async function* () {})(), () => {}), connection: this.id }
      }
      const events = (async function* (): AsyncGenerator<CodexSocketEvent> {
        let clean = false
        try {
          for (;;) {
            const event = await next()
            if (!event) return
            const httpError = wrappedHttpError(event)
            if (httpError) throw httpError
            // Decided before the yield: the reader usually stops at the
            // terminal event, and that must not retire a finished socket.
            const terminal = TERMINAL_EVENTS.has(event.type)
            clean = terminal && isCleanEnd(event)
            yield event
            if (terminal) return
          }
        } finally {
          finish(clean)
        }
      })()
      return { first, rest: eventsOf(events, () => finish(false)), connection: this.id }
    } catch (error) {
      finish(false)
      throw error
    }
  }
}

/** One kept connection per conversation (cache key), as codex-rs keeps one per session. */
export class CodexResponsesSockets {
  private readonly sockets = new Map<string, ResponsesSocket>()
  private disabledUntil = 0

  constructor(private readonly silenceLimitMs = SILENCE_LIMIT_MS) {}

  /** False while a refused handshake keeps this transport switched off. */
  get available(): boolean {
    return Date.now() >= this.disabledUntil
  }

  /**
   * Start a request on the conversation's connection, opening it when
   * needed. Throws CodexWebSocketUnavailable when the request should go over
   * HTTP instead: the handshake failed, or the connection is busy with
   * another request of the same conversation.
   */
  async start(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    key: string,
    signal?: AbortSignal,
  ): Promise<CodexSocketResponse> {
    if (signal?.aborted) throw abortError()
    let socket = this.sockets.get(key)
    if (socket?.busy) throw new CodexWebSocketUnavailable('websocket busy with another request of this conversation')
    // A connection stays authenticated as its handshake was: after a token
    // refresh or a new login, the request needs a new connection.
    const identity = JSON.stringify([url, headers.Authorization ?? '', headers['ChatGPT-Account-ID'] ?? ''])
    const reused = !!socket?.usable && socket.identity === identity
    if (!socket || !reused) {
      socket?.close()
      const handshake: Record<string, string> = { ...headers, 'OpenAI-Beta': OPENAI_BETA }
      delete handshake['Content-Type']
      delete handshake['Accept']
      socket = new ResponsesSocket(url.replace(/^http/i, 'ws'), handshake, identity, this.silenceLimitMs)
      this.sockets.delete(key)
      this.sockets.set(key, socket)
      this.evictOldest(key)
    } else {
      // Most recently used last.
      this.sockets.delete(key)
      this.sockets.set(key, socket)
    }
    socket.busy = true
    try {
      await socket.ready
    } catch (error) {
      socket.busy = false
      socket.close()
      this.sockets.delete(key)
      if (error instanceof CodexWebSocketUnavailable) {
        // A server that refuses the upgrade will keep refusing it; anything
        // else (network, auth, overload) gets another try in a minute.
        const refused = error.status === 400 || error.status === 404 || error.status === 426
        this.disabledUntil = Date.now() + (refused ? 24 * 60 * 60_000 : 60_000)
      }
      throw error
    }
    const payload = JSON.stringify({ type: 'response.create', ...body, include: Array.isArray(body.include) ? body.include : [] })
    try {
      return await socket.start(payload, signal)
    } catch (error) {
      if (!socket.usable) this.sockets.delete(key)
      // A kept connection the server dropped while idle fails before any
      // event: open a fresh one now instead of waiting out a retry backoff.
      if (reused && (error as { code?: string })?.code === 'ECONNRESET' && !signal?.aborted) {
        return this.start(url, headers, body, key, signal)
      }
      throw error
    }
  }

  closeAll(): void {
    for (const socket of this.sockets.values()) socket.close()
    this.sockets.clear()
  }

  private evictOldest(keep: string): void {
    for (const [key, socket] of this.sockets) {
      if (this.sockets.size <= MAX_CONNECTIONS) break
      if (key === keep || socket.busy) continue
      socket.close()
      this.sockets.delete(key)
    }
  }
}
