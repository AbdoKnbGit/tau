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
 * `tau --remote-local` (autostart.ts) is that ask, made once per launch.
 *
 * Phones the user chose to remember (devices.ts) sign in with their own key
 * instead of the session token, so they reconnect to a later session without
 * a QR code — but still only while that session has turned remote on.
 *
 * Starting or stopping never touches the agent loop, the message array, or the
 * prompt cache — the server is a side channel onto state the REPL already
 * holds, so /remote can be turned on mid-turn without disturbing the run.
 */

import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { isRemoteActive, setBroadcastSink } from './bus.js'
import type { RemoteCommand } from './commands.js'
import {
  addDevice,
  listDevices,
  lookupDevice,
  markDeviceSeen,
  removeDevice,
  type TrustedDevice,
} from './devices.js'
import { clearImages } from './images.js'
import type { RemoteAsk } from './interactive.js'
import { resolveLanReach } from './reach.js'
import {
  startRemoteServer,
  type ConnectionEvent,
  type DeviceStore,
  type RemoteConnection,
  type RemoteServer,
  type ServerHooks,
  type TrustOutcome,
} from './server.js'
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

/** Local mode under WSL 2 networking that nothing on the Wi-Fi can reach. */
export class WslNatError extends Error {
  constructor(readonly networkingMode: string) {
    const label = networkingMode === 'nat' ? 'NAT' : networkingMode
    super(
      `Tau is running inside WSL 2 with ${label} networking, which hides it from your Wi-Fi.`,
    )
    this.name = 'WslNatError'
  }
}

export class InvalidRemoteHostError extends Error {
  constructor(value: string) {
    super(`TAU_REMOTE_HOST must be a bare IP address or hostname, not "${value}".`)
    this.name = 'InvalidRemoteHostError'
  }
}

export class InvalidRemotePortError extends Error {
  constructor(value: string) {
    super(`TAU_REMOTE_PORT must be a port number from 1 to 65535, not "${value}".`)
    this.name = 'InvalidRemotePortError'
  }
}

/**
 * TAU_REMOTE_PORT pins the port: needed behind a port forward (WSL 2, a
 * container), and lets two sessions each keep their own address for their
 * remembered phones. Unset, the server prefers 7777 and falls back to any
 * free port. 0 means any free port.
 */
function portFromEnv(): number | undefined {
  const raw = process.env.TAU_REMOTE_PORT?.trim()
  if (!raw) return undefined
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) throw new InvalidRemotePortError(raw)
  return Number(raw)
}

const DEVICE_STORE: DeviceStore = {
  lookup: lookupDevice,
  add: addDevice,
  remove: removeDevice,
  seen: id => {
    void markDeviceSeen(id)
  },
}

const connectionListeners = new Set<(event: ConnectionEvent) => void>()

/** Phones joining, leaving and being remembered, for the dialogs. */
export function subscribeConnections(fn: (event: ConnectionEvent) => void): () => void {
  connectionListeners.add(fn)
  return () => {
    connectionListeners.delete(fn)
  }
}

export function listConnections(): RemoteConnection[] {
  return server?.connections() ?? []
}

export function listRememberedDevices(): TrustedDevice[] {
  return listDevices()
}

/** Remember a phone connected by the QR link; resolves once it saved its key. */
export function trustConnection(connectionId: string): Promise<TrustOutcome> {
  if (!server) return Promise.resolve({ ok: false, reason: 'remote is off' })
  return server.trust(connectionId)
}

/** Forget a phone: it needs the QR code again, and is signed out right away. */
export async function forgetDevice(deviceId: string): Promise<boolean> {
  const removed = await removeDevice(deviceId)
  server?.disconnectDevice(deviceId)
  return removed
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

  // Fail before binding anything — and before a mode switch tears down a
  // session that works — when local mode has no address a phone can reach.
  // Global mode still reports the LAN address when there is one: the listener
  // binds 0.0.0.0 either way, so a tunnelled session is reachable on Wi-Fi too.
  const reach = await resolveLanReach()
  if (superseded()) throw new RemoteCancelledError()
  if (mode === 'local') {
    if (reach.kind === 'wsl-nat') throw new WslNatError(reach.networkingMode)
    if (reach.kind === 'invalid-override') throw new InvalidRemoteHostError(reach.value)
    if (reach.kind === 'none') throw new NoLanError()
  }
  const lan = reach.kind === 'lan' ? reach : null
  const host = lan?.address ?? '127.0.0.1'
  // Also before anything is torn down: a typo must not end a working session.
  const port = portFromEnv()

  if (server) {
    // Our own stop for a mode switch — re-baseline so it doesn't read as
    // someone else cancelling us.
    turnOff()
    epoch = stopEpoch
  }

  const token = newToken()
  const hooks: ServerHooks = {
    snapshot: () => snapshotFn(),
    onPrompt: text => inbound.onPrompt(text),
    onInterrupt: () => inbound.onInterrupt(),
    onReply: (id, payload) => inbound.onReply(id, payload),
    devices: DEVICE_STORE,
    onConnection: event => {
      for (const fn of connectionListeners) {
        try {
          fn(event)
        } catch {
          /* one broken listener must not starve the others */
        }
      }
    },
  }

  const started = await startRemoteServer(token, hooks, { port })
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

  const lanUrl = lan ? `http://${lan.address}:${started.port}/#${token}` : null

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
    preferredPortBusy: started.preferredPortBusy,
    host,
    url: `${origin}/#${token}`,
    lanUrl: mode === 'global' ? lanUrl : null,
    otherHosts: mode === 'local' && lan ? lan.others : [],
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
