/**
 * Which connection carried an Antigravity request, observed without changing
 * it. A leaf module (node: imports only) so Node-runtime tests can load it.
 *
 * Connection identity comes from undici's diagnostics channels, which Node's
 * built-in fetch and the npm undici package both publish. A probe stored in
 * AsyncLocalStorage around one fetch() call claims the undici request that
 * call creates; the socket that then sends its headers is its connection.
 * Where a runtime publishes nothing (Bun's native fetch) or a request is never
 * claimed, the connection is reported as not observed. It is never inferred
 * from the hostname or from the time between requests.
 *
 * Socket idle time here is the socket's own: the time since it last finished
 * a response, whichever conversation that response belonged to. Concurrent
 * agents can keep a shared connection busy while one conversation sits idle,
 * so this is kept apart from the conversation's own gap between requests.
 *
 * Subscribing adds no header, wait or payload field, and never alters which
 * dispatcher a request uses.
 */

import { AsyncLocalStorage } from 'async_hooks'
import * as diagnostics from 'diagnostics_channel'

export interface AntigravityConnection {
  /** Opaque per-process socket id ("c1", "c2", ...). */
  id: string
  /**
   * `new`: first request on a socket whose connect was observed.
   * `reused`: the socket had carried an earlier request.
   * `unknown`: the socket predates observation, so its history is not known.
   */
  reuse: 'new' | 'reused' | 'unknown'
  /** Requests this socket carried before this one, since observation began. */
  priorRequests: number
  /** Since this socket last finished a response; absent when it never did. */
  socketIdleMs?: number
  /** Since the socket connected; absent when the connect was not observed. */
  socketAgeMs?: number
  /** Negotiated ALPN protocol, when the socket reports one. */
  protocol: string
  remoteAddress?: string
}

export interface AntigravityConnectionProbe {
  /** Set once the probe claimed the undici request its fetch() created. */
  claimed: boolean
  connection?: AntigravityConnection
}

interface SocketRecord {
  id: string
  connectedAt?: number
  requests: number
  lastDoneAt?: number
}

const probeStorage = new AsyncLocalStorage<AntigravityConnectionProbe>()
const sockets = new WeakMap<object, SocketRecord>()
const probedRequests = new WeakMap<object, AntigravityConnectionProbe>()
const requestSockets = new WeakMap<object, SocketRecord>()
let socketSeq = 0
let subscribed = false

function socketRecord(socket: object): SocketRecord {
  let record = sockets.get(socket)
  if (!record) {
    record = { id: `c${++socketSeq}`, requests: 0 }
    sockets.set(socket, record)
  }
  return record
}

// diagnostics_channel rethrows a subscriber's exception asynchronously, which
// would surface as an uncaught error. Every handler swallows its own.
function onRequestCreate(message: unknown): void {
  try {
    const probe = probeStorage.getStore()
    const request = (message as { request?: object } | null)?.request
    // One fetch() creates one undici request; ignore anything after the first.
    if (!probe || probe.claimed || !request) return
    probe.claimed = true
    probedRequests.set(request, probe)
  } catch {
    // Observation only.
  }
}

function onClientConnected(message: unknown): void {
  try {
    const socket = (message as { socket?: object } | null)?.socket
    if (socket) socketRecord(socket).connectedAt = Date.now()
  } catch {
    // Observation only.
  }
}

function onSendHeaders(message: unknown): void {
  try {
    const { request, socket } = (message ?? {}) as {
      request?: object
      socket?: { alpnProtocol?: unknown; remoteAddress?: unknown }
    }
    if (!request || !socket) return
    const record = socketRecord(socket)
    const probe = probedRequests.get(request)
    if (probe) {
      const now = Date.now()
      probe.connection = {
        id: record.id,
        reuse: record.requests > 0 ? 'reused' : record.connectedAt !== undefined ? 'new' : 'unknown',
        priorRequests: record.requests,
        ...(record.lastDoneAt !== undefined && { socketIdleMs: now - record.lastDoneAt }),
        ...(record.connectedAt !== undefined && { socketAgeMs: now - record.connectedAt }),
        protocol: typeof socket.alpnProtocol === 'string' && socket.alpnProtocol ? socket.alpnProtocol : 'unknown',
        ...(typeof socket.remoteAddress === 'string' && { remoteAddress: socket.remoteAddress }),
      }
    }
    record.requests++
    requestSockets.set(request, record)
  } catch {
    // Observation only.
  }
}

function onRequestDone(message: unknown): void {
  try {
    const request = (message as { request?: object } | null)?.request
    const record = request ? requestSockets.get(request) : undefined
    if (record) record.lastDoneAt = Date.now()
  } catch {
    // Observation only.
  }
}

/**
 * Start listening to undici's diagnostics channels (idempotent). Sockets
 * opened before this call are reported with `reuse: 'unknown'`.
 */
export function observeAntigravityConnections(): void {
  if (subscribed) return
  subscribed = true
  try {
    diagnostics.subscribe('undici:request:create', onRequestCreate)
    diagnostics.subscribe('undici:client:connected', onClientConnected)
    diagnostics.subscribe('undici:client:sendHeaders', onSendHeaders)
    // Completion: trailers is published once per finished response, with or
    // without actual trailers. Errors end the request too.
    diagnostics.subscribe('undici:request:trailers', onRequestDone)
    diagnostics.subscribe('undici:request:error', onRequestDone)
  } catch {
    // A runtime without these channels leaves every connection unobserved.
  }
}

/** Run one fetch() with a probe that records the connection carrying it. */
export function withAntigravityConnectionProbe<T>(
  probe: AntigravityConnectionProbe | undefined,
  dispatch: () => Promise<T>,
): Promise<T> {
  return probe ? probeStorage.run(probe, dispatch) : dispatch()
}
