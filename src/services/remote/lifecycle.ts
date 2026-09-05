/**
 * Top-level on/off lifecycle for /remote, in two modes.
 *
 *   local  — bind the LAN address; the phone must share your Wi-Fi. Free,
 *            instant, nothing leaves the network.
 *   global — same server behind a free Cloudflare quick tunnel, reachable
 *            from cellular and on a real HTTPS origin.
 *
 * Deliberately not persisted across restarts: a listener that revives itself
 * without being asked is a surprise, and the token would be stale anyway.
 *
 * Starting or stopping never touches the agent loop, the message array, or the
 * prompt cache — the server is a side channel onto state the REPL already
 * holds, so /remote can be turned on mid-turn without disturbing the run.
 */

import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { isRemoteActive, setBroadcastSink } from './bus.js'
import type { RemoteCommand } from './commands.js'
import { clearImages } from './images.js'
import type { RemoteAsk } from './interactive.js'
import { pickLanAddress } from './lan.js'
import { startRemoteServer, type RemoteServer, type ServerHooks } from './server.js'
import { getRemoteState, newToken, setRemoteState, type RemoteState } from './state.js'
import { startTunnel, type Tunnel } from './tunnel.js'
import type { RemoteItem } from './transcript.js'

export type RemoteMode = 'local' | 'global'

export type Snapshot = {
  cwd: string
  model: string
  busy: boolean
  messages: RemoteItem[]
  /** Requests awaiting an answer, replayed so a late joiner can unblock the turn. */
  asks: RemoteAsk[]
  /** Slash-command catalogue for the phone's palette. */
  commands: RemoteCommand[]
}

const EMPTY: Snapshot = { cwd: '', model: '', busy: false, messages: [], asks: [], commands: [] }

let server: RemoteServer | null = null
let tunnel: Tunnel | null = null
let unregisterCleanup: (() => void) | null = null
let snapshotFn: () => Snapshot = () => EMPTY

/**
 * Inbound handlers are injected by useRemoteMirror rather than imported.
 * Reaching for router.ts here would pull the message queue — and the whole
 * REPL graph behind it — into the module that owns the listener and the
 * tunnel subprocess, which is the wrong direction for a leaf orchestrator.
 */
export type InboundHandlers = {
  onPrompt: (text: string) => void
  onInterrupt: () => void
  onReply: (id: string, payload: unknown) => boolean
}

const NO_INBOUND: InboundHandlers = {
  onPrompt: () => {},
  onInterrupt: () => {},
  onReply: () => false,
}

let inbound: InboundHandlers = NO_INBOUND

export function setInboundHandlers(handlers: InboundHandlers | null): void {
  inbound = handlers ?? NO_INBOUND
}

/** Installed by useRemoteMirror so the server can read live REPL state. */
export function setSnapshotProvider(fn: (() => Snapshot) | null): void {
  snapshotFn = fn ?? (() => EMPTY)
}

export function isOn(): boolean {
  return isRemoteActive()
}

/** Thrown when /remote off (or a mode switch) lands while a start is in flight. */
export class RemoteCancelledError extends Error {
  constructor() {
    super('remote: start cancelled')
    this.name = 'RemoteCancelledError'
  }
}

export class NoLanError extends Error {
  constructor() {
    super('No LAN address found — connect to Wi-Fi or Ethernet, or use /remote global.')
    this.name = 'NoLanError'
  }
}

/**
 * Serializes starts. Two `/remote` invocations racing — a second one typed
 * while a tunnel is still opening, say — would each bind a listener, and the
 * second would overwrite `server` and orphan the first one forever.
 */
let inFlight: Promise<unknown> = Promise.resolve()

/**
 * Counts explicit stops only.
 *
 * A start awaits two slow things — the listener, then up to ~30s of tunnel —
 * and `/remote off` typed inside that window used to be silently undone when
 * the awaited start resumed and installed its server anyway. The epoch is
 * captured synchronously in turnOn (not in start, which runs a microtask
 * later, by which point the stop has already been counted) and re-checked
 * after every await.
 *
 * It counts stops rather than all transitions: concurrent starts are already
 * serialized by `inFlight` and converge via the same-mode early return, so
 * they must not read as cancelling each other.
 */
let stopEpoch = 0

export function turnOn(
  mode: RemoteMode,
  onProgress: (stage: string) => void = () => {},
): Promise<RemoteState> {
  const epoch = stopEpoch
  const next = inFlight.then(() => start(mode, onProgress, epoch))
  // Swallow here only to keep the chain alive; the caller still sees the
  // rejection through `next`.
  inFlight = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function start(
  mode: RemoteMode,
  onProgress: (stage: string) => void,
  requestedAt: number,
): Promise<RemoteState> {
  let epoch = requestedAt
  const superseded = (): boolean => stopEpoch !== epoch

  // Stopped between asking and getting here.
  if (superseded()) throw new RemoteCancelledError()

  const existing = getRemoteState()
  // Already serving in the requested mode — hand back the same link rather
  // than minting a second token and orphaning whatever is already paired.
  if (server && existing && existing.mode === mode) return existing
  if (server) {
    // Our own stop for a mode switch — re-baseline so it doesn't read as
    // someone else cancelling us.
    turnOff()
    epoch = stopEpoch
  }

  // Fail before binding anything when local mode has no address to offer.
  // Global mode still reports the LAN address when there is one: the listener
  // binds 0.0.0.0 either way, so a tunnelled session is reachable on Wi-Fi too.
  const lan = pickLanAddress()
  const host = mode === 'local' ? lan : (lan ?? '127.0.0.1')
  if (!host) throw new NoLanError()

  const token = newToken()
  const hooks: ServerHooks = {
    snapshot: () => snapshotFn(),
    onPrompt: text => inbound.onPrompt(text),
    onInterrupt: () => inbound.onInterrupt(),
    onReply: (id, payload) => inbound.onReply(id, payload),
  }

  const started = await startRemoteServer(token, hooks)
  if (superseded()) {
    started.close()
    throw new RemoteCancelledError()
  }
  server = started
  setBroadcastSink(payload => started.broadcast(payload))
  // A `cloudflared` child outliving tau would leave a public hostname pointed
  // at a dead port, and a stray process behind it.
  if (!unregisterCleanup) {
    unregisterCleanup = registerCleanup(async () => {
      turnOff()
    })
  }

  const lanUrl = lan ? `http://${lan}:${started.port}/#${token}` : null

  let origin: string
  if (mode === 'global') {
    try {
      const opened = await startTunnel(started.port, token, onProgress)
      if (superseded()) {
        opened.close()
        started.close()
        throw new RemoteCancelledError()
      }
      tunnel = opened
      origin = opened.url
      opened.onExit(() => {
        // A tunnel that dies after being replaced must not mark its
        // successor's state as down.
        if (tunnel !== opened) return
        const current = getRemoteState()
        if (current) current.tunnelDown = true
      })
    } catch (err) {
      // Don't leave a half-open listener behind on a failed tunnel. A
      // cancellation already tore things down, so don't double-stop.
      if (!(err instanceof RemoteCancelledError)) turnOff()
      throw err
    }
  } else {
    origin = `http://${host}:${started.port}`
  }

  const state: RemoteState = {
    mode,
    token,
    port: started.port,
    host,
    url: `${origin}/#${token}`,
    lanUrl: mode === 'global' ? lanUrl : null,
    clients: 0,
  }
  setRemoteState(state)
  return state
}

export function turnOff(): void {
  stopEpoch++
  unregisterCleanup?.()
  unregisterCleanup = null
  setBroadcastSink(null)
  tunnel?.close()
  tunnel = null
  server?.close()
  server = null
  clearImages()
  setRemoteState(null)
}
