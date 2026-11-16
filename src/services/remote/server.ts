/**
 * HTTP + WebSocket server behind /remote.
 *
 * Binds 0.0.0.0 so a phone on the same Wi-Fi can reach it directly in local
 * mode; in global mode the same listener sits behind a Cloudflare quick
 * tunnel. Either way this machine is the server — there is no relay holding
 * session data, which is why it costs nothing.
 *
 * The served HTML is inert on its own; the WebSocket is the authenticated
 * surface, with two ways in:
 *
 *   link    `?t=<token>` — the 32-byte session token from the QR code's URL
 *           fragment. Fragments are never sent to a server, so the token
 *           stays out of the request for the page itself. It dies with this
 *           listener.
 *   device  `?d=<id>` — a phone the user chose to remember (devices.ts). The
 *           server sends a fresh challenge and the page answers with an HMAC
 *           of it, so the device key never crosses the network after pairing
 *           and a captured answer cannot be replayed. Accepted only from a
 *           plain-http page this listener served, at the origin the phone
 *           paired on: never through the tunnel, never from another site.
 *
 * A refused socket is upgraded and then closed with a code from protocol.ts,
 * so the page can tell "scan the QR again" from "the computer is unreachable"
 * instead of retrying forever.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { logForDebugging } from '../../utils/debug.js'
import { cleanDeviceName, proofMatches, type DeviceLookup, type TrustedDevice } from './devices.js'
import { getImage } from './images.js'
import type { Snapshot } from './lifecycle.js'
import {
  CLOSE_AUTH_TIMEOUT,
  CLOSE_FORGOTTEN,
  CLOSE_NOT_REMEMBERED,
  CLOSE_STALE_LINK,
  CLOSE_TRY_AGAIN,
  CLOSE_WRONG_ORIGIN,
} from './protocol.js'
import { setClientCount } from './state.js'
import { REMOTE_HTML } from './webui.js'

const PREFERRED_PORT = 7777
/** Sockets still owing an answer to their challenge. Caps a flood of them. */
const MAX_WAITING = 32

export type DeviceStore = {
  lookup: (id: string) => DeviceLookup
  add: (input: { name: string; origin: string }) => Promise<TrustedDevice>
  remove: (id: string) => Promise<boolean>
  seen: (id: string) => void
}

export type RemoteConnection = {
  /** Random per socket; what trust() takes. */
  id: string
  /** In by the QR link, or by a remembered phone's key. */
  kind: 'link' | 'device'
  /** Set once the phone is remembered. */
  deviceId?: string
  name: string
  /** Remote IP, without the IPv4-mapped prefix. */
  address: string
  /** The page's origin when it is this listener over plain http; else null. */
  origin: string | null
  /** Arrived by scanning a code just now, rather than reconnecting. */
  scanned: boolean
  connectedAt: number
}

export type ConnectionEvent =
  | { type: 'joined'; connection: RemoteConnection }
  | { type: 'left'; connection: RemoteConnection }
  | { type: 'remembered'; connection: RemoteConnection }

export type TrustOutcome =
  | { ok: true; device: TrustedDevice }
  | { ok: false; reason: string }

export type ServerHooks = {
  /** Snapshot sent to a client the moment it connects. */
  snapshot: () => Snapshot
  onPrompt: (text: string) => void
  onInterrupt: () => void
  onReply: (id: string, payload: unknown) => void
  devices: DeviceStore
  onConnection?: (event: ConnectionEvent) => void
}

export type ServerOptions = {
  /** Listen here and nowhere else: refuse rather than fall back when taken. */
  port?: number
  authTimeoutMs?: number
  heartbeatMs?: number
  trustTimeoutMs?: number
}

export type RemoteServer = {
  port: number
  /** 7777 was taken or reserved, so this listener took a free port instead. */
  preferredPortBusy: boolean
  broadcast: (payload: unknown) => void
  close: () => void
  connections: () => RemoteConnection[]
  /** Remember the phone on this link connection; resolves once it saved the key. */
  trust: (connectionId: string) => Promise<TrustOutcome>
  /** Sign out every socket of a device the user just forgot. */
  disconnectDevice: (deviceId: string) => void
}

/** A link connection from a page this listener served over plain http. */
export function isRememberable(connection: RemoteConnection): boolean {
  return connection.kind === 'link' && connection.origin !== null
}

export class RemotePortBusyError extends Error {
  constructor(readonly port: number) {
    super(
      `Port ${port} (TAU_REMOTE_PORT) is already in use, most likely by another Tau with /remote on.`,
    )
    this.name = 'RemotePortBusyError'
  }
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, so guard first. Length is not
  // secret here (the token is fixed-width), only the bytes are.
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * The page's origin when the socket was opened by a page this listener served
 * over plain http — the browser's Origin matches the Host it dialled. Null
 * through the tunnel (https), from another site, and from non-browser clients
 * that send no Origin. Only a check against other web pages: a script that
 * stole a device key can claim any Origin, which is why the key is the gate.
 */
function sameOriginHttp(req: IncomingMessage): string | null {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:') return null
  if (parsed.host.toLowerCase() !== host.toLowerCase()) return null
  return parsed.origin
}

function clientAddress(req: IncomingMessage): string {
  const raw = req.socket.remoteAddress ?? ''
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

async function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '0.0.0.0')
  })
}

type PendingTrust = {
  /** Unset while the record is still being written. */
  device?: TrustedDevice
  finish: (result: { ok: true } | { ok: false; reason: string }) => void
}

const EMPTY_SNAPSHOT: Snapshot = { cwd: '', model: '', busy: false, messages: [], asks: [], commands: [] }

type Client = {
  ws: WebSocket
  connection: RemoteConnection
  pendingTrust?: PendingTrust
}

function send(ws: WebSocket, payload: unknown): boolean {
  if (ws.readyState !== ws.OPEN) return false
  try {
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

function shut(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    /* already gone */
  }
}

export async function startRemoteServer(
  token: string,
  hooks: ServerHooks,
  options: ServerOptions = {},
): Promise<RemoteServer> {
  const authTimeoutMs = options.authTimeoutMs ?? 10_000
  const heartbeatMs = options.heartbeatMs ?? 30_000
  const trustTimeoutMs = options.trustTimeoutMs ?? 15_000
  // Images are fetched with this rather than the session token, so a phone
  // that signed in with its device key never holds a token that opens the
  // socket. One per listener, so image URLs stay cacheable across reconnects.
  const imageToken = randomBytes(24).toString('base64url')
  /**
   * Set by close(). Browsers pre-open spare sockets, and on some runtimes
   * (Bun) one opened before close() survives it and still delivers a request
   * here afterwards — to a listener whose tokens are stale, so a restarted
   * session's images 403. Dropping it makes the browser retry on a fresh
   * connection, which reaches whoever listens now.
   */
  let closed = false

  const http = createServer((req, res) => {
    if (closed) {
      req.socket.destroy()
      return
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // The token lives in the fragment; make sure nothing caches the shell
        // across sessions with a stale script.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(REMOTE_HTML)
      return
    }
    // Images are session content, so unlike the inert shell they need a
    // token. Ids are content hashes, which makes the URL immutable — hence
    // the aggressive cache header.
    const image = path.startsWith('/img/') ? getImage(path.slice(5)) : undefined
    const given = new URL(req.url ?? '/', 'http://localhost').searchParams.get('t') ?? ''
    if (image) {
      if (!tokensMatch(given, imageToken) && !tokensMatch(given, token)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }
      res.writeHead(200, {
        'content-type': image.mediaType,
        'content-length': String(image.bytes.byteLength),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      })
      res.end(image.bytes)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  let port: number
  let preferredPortBusy = false
  if (options.port !== undefined) {
    try {
      port = await listen(http, options.port)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new RemotePortBusyError(options.port)
      }
      throw err
    }
  } else {
    try {
      port = await listen(http, PREFERRED_PORT)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // EADDRINUSE: another tau, most likely. EACCES: on Windows, Hyper-V and
      // WSL reserve port ranges that can cover 7777. Either way, any free
      // port works for the QR code; only remembered phones care.
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err
      preferredPortBusy = true
      port = await listen(http, 0)
    }
  }

  const wss = new WebSocketServer({ noServer: true })
  const clients = new Map<WebSocket, Client>()
  const waiting = new Set<WebSocket>()
  const alive = new WeakSet<WebSocket>()

  const announce = (): void => {
    setClientCount(clients.size)
  }

  const remove = (client: Client): void => {
    if (clients.get(client.ws) !== client) return
    clients.delete(client.ws)
    client.pendingTrust?.finish({ ok: false, reason: 'the phone disconnected' })
    announce()
    hooks.onConnection?.({ type: 'left', connection: client.connection })
  }

  /**
   * Ping every client on an interval and drop the ones that stop answering.
   *
   * Two problems, one fix. A Cloudflare quick tunnel closes a WebSocket that
   * has been idle for a couple of minutes, which a long thinking turn easily
   * exceeds — the ping keeps it open. And a phone that walks out of Wi-Fi
   * range never sends a FIN, so without this the socket sits half-open forever
   * and the footer keeps claiming a device is connected.
   *
   * It also signs out phones forgotten in another Tau window, which has no
   * way to reach this window's sockets.
   */
  const heartbeat = setInterval(() => {
    for (const client of [...clients.values()]) {
      const { ws } = client
      if (!alive.has(ws)) {
        remove(client)
        try {
          ws.terminate()
        } catch {
          /* already gone */
        }
        continue
      }
      const deviceId = client.connection.deviceId
      if (deviceId && !client.pendingTrust && hooks.devices.lookup(deviceId).status === 'absent') {
        shut(ws, CLOSE_FORGOTTEN, 'forgotten')
        continue
      }
      alive.delete(ws)
      try {
        ws.ping()
      } catch {
        /* the next sweep will collect it */
      }
    }
  }, heartbeatMs)
  // Never hold the process open on this timer alone.
  heartbeat.unref?.()

  const onMessage = (client: Client, raw: RawData): void => {
    alive.add(client.ws)
    let msg: { t?: string; text?: string; id?: string; reply?: unknown }
    try {
      msg = JSON.parse(String(raw)) as typeof msg
    } catch {
      return
    }
    if (msg.t === 'prompt' && typeof msg.text === 'string' && msg.text.trim()) {
      hooks.onPrompt(msg.text.trim())
    } else if (msg.t === 'interrupt') {
      hooks.onInterrupt()
    } else if (msg.t === 'ask-response' && typeof msg.id === 'string') {
      hooks.onReply(msg.id, msg.reply)
    } else if (msg.t === 'ping') {
      // A page coming back from the background checks its socket is real.
      send(client.ws, { t: 'pong' })
    } else if (
      (msg.t === 'trust-saved' || msg.t === 'trust-failed') &&
      client.pendingTrust?.device &&
      msg.id === client.pendingTrust.device.id
    ) {
      client.pendingTrust.finish(
        msg.t === 'trust-saved'
          ? { ok: true }
          : { ok: false, reason: 'the browser could not save it (private tab or blocked site data?)' },
      )
    }
  }

  const accept = (ws: WebSocket, info: Omit<RemoteConnection, 'id' | 'connectedAt'>): void => {
    if (ws.readyState !== ws.OPEN) return
    const client: Client = {
      ws,
      connection: { ...info, id: randomBytes(6).toString('hex'), connectedAt: Date.now() },
    }
    clients.set(ws, client)
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
    ws.on('message', raw => onMessage(client, raw))
    ws.on('close', () => remove(client))
    ws.on('error', () => remove(client))
    announce()
    let snapshot = EMPTY_SNAPSHOT
    try {
      snapshot = hooks.snapshot()
    } catch (err) {
      logForDebugging(`[remote] snapshot failed: ${(err as Error).message}`)
    }
    send(ws, { t: 'hello', ...snapshot, img: imageToken })
    hooks.onConnection?.({ type: 'joined', connection: client.connection })
  }

  const signInDevice = (
    ws: WebSocket,
    deviceId: string,
    origin: string | null,
    address: string,
    scanned: boolean,
  ): void => {
    if (origin === null) {
      shut(ws, CLOSE_WRONG_ORIGIN, 'wrong origin')
      return
    }
    const found = hooks.devices.lookup(deviceId)
    if (found.status === 'unavailable') {
      shut(ws, CLOSE_TRY_AGAIN, 'try again')
      return
    }
    if (found.status === 'absent') {
      shut(ws, CLOSE_NOT_REMEMBERED, 'not remembered')
      return
    }
    const device = found.device
    if (device.origin !== origin) {
      shut(ws, CLOSE_WRONG_ORIGIN, 'wrong origin')
      return
    }

    const nonce = randomBytes(32).toString('hex')
    waiting.add(ws)
    const timer = setTimeout(() => shut(ws, CLOSE_AUTH_TIMEOUT, 'no answer'), authTimeoutMs)
    timer.unref?.()
    const settle = (): void => {
      clearTimeout(timer)
      waiting.delete(ws)
    }
    ws.once('close', settle)
    ws.once('error', settle)
    ws.once('message', raw => {
      settle()
      let msg: { t?: unknown; proof?: unknown } = {}
      try {
        msg = JSON.parse(String(raw)) as typeof msg
      } catch {
        /* treated as a wrong answer */
      }
      if (msg.t !== 'auth' || !proofMatches(device.key, nonce, msg.proof)) {
        shut(ws, CLOSE_NOT_REMEMBERED, 'not remembered')
        return
      }
      // Forgotten while the phone was answering.
      const still = hooks.devices.lookup(device.id)
      if (still.status !== 'found') {
        shut(
          ws,
          still.status === 'absent' ? CLOSE_NOT_REMEMBERED : CLOSE_TRY_AGAIN,
          still.status === 'absent' ? 'not remembered' : 'try again',
        )
        return
      }
      hooks.devices.seen(device.id)
      accept(ws, {
        kind: 'device',
        deviceId: device.id,
        name: still.device.name,
        address,
        origin,
        scanned,
      })
    })
    if (!send(ws, { t: 'challenge', nonce })) settle()
  }

  const admit = (ws: WebSocket, req: IncomingMessage, url: URL): void => {
    // An 'error' with no listener throws, and a refused or half-signed-in
    // socket has no other one. A reset phone must never take down tau.
    ws.on('error', () => {})
    const address = clientAddress(req)
    const origin = sameOriginHttp(req)
    const deviceId = url.searchParams.get('d')
    if (deviceId !== null) {
      signInDevice(ws, deviceId, origin, address, url.searchParams.get('s') === '1')
      return
    }
    if (tokensMatch(url.searchParams.get('t') ?? '', token)) {
      accept(ws, {
        kind: 'link',
        name: cleanDeviceName(url.searchParams.get('n')) || 'Browser',
        address,
        origin,
        scanned: true,
      })
      return
    }
    shut(ws, CLOSE_STALE_LINK, 'link expired')
  }

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (closed || url.pathname !== '/ws' || waiting.size >= MAX_WAITING) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => admit(ws, req, url))
  })

  logForDebugging(`[remote] listening on 0.0.0.0:${port}`)

  return {
    port,
    preferredPortBusy,
    broadcast(payload: unknown): void {
      if (clients.size === 0) return
      const data = JSON.stringify(payload)
      for (const { ws } of clients.values()) send(ws, data)
    },
    connections(): RemoteConnection[] {
      return [...clients.values()].map(client => ({ ...client.connection }))
    },
    async trust(connectionId: string): Promise<TrustOutcome> {
      const client = [...clients.values()].find(c => c.connection.id === connectionId)
      if (!client) return { ok: false, reason: 'that phone is no longer connected' }
      if (!isRememberable(client.connection)) {
        return { ok: false, reason: 'only a phone on this Wi-Fi, opened from the local address, can be remembered' }
      }
      if (client.pendingTrust) return { ok: false, reason: 'already saving it' }
      // Claim the slot before the first await so a second Y cannot race in.
      const claim: PendingTrust = { finish: () => {} }
      client.pendingTrust = claim

      let device: TrustedDevice
      try {
        device = await hooks.devices.add({
          name: client.connection.name,
          origin: client.connection.origin!,
        })
      } catch (err) {
        if (client.pendingTrust === claim) client.pendingTrust = undefined
        return { ok: false, reason: `could not save the device list (${(err as Error).message})` }
      }

      return new Promise<TrustOutcome>(resolve => {
        let settled = false
        const finish: PendingTrust['finish'] = result => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (client.pendingTrust === pending) client.pendingTrust = undefined
          if (result.ok) {
            client.connection = { ...client.connection, kind: 'device', deviceId: device.id }
            hooks.onConnection?.({ type: 'remembered', connection: { ...client.connection } })
            resolve({ ok: true, device })
            return
          }
          // The phone never stored the key, so the record would be dead weight.
          void hooks.devices.remove(device.id).catch(() => {})
          resolve(result)
        }
        const pending: PendingTrust = { device, finish }
        const timer = setTimeout(
          () => finish({ ok: false, reason: 'the phone did not answer' }),
          trustTimeoutMs,
        )
        timer.unref?.()
        if (clients.get(client.ws) !== client) {
          finish({ ok: false, reason: 'the phone disconnected' })
          return
        }
        client.pendingTrust = pending
        const sent = send(client.ws, {
          t: 'trusted',
          id: device.id,
          key: device.key,
          name: device.name,
        })
        if (!sent) finish({ ok: false, reason: 'the phone disconnected' })
      })
    },
    disconnectDevice(deviceId: string): void {
      for (const client of clients.values()) {
        if (client.connection.deviceId === deviceId) shut(client.ws, CLOSE_FORGOTTEN, 'forgotten')
      }
    },
    close(): void {
      closed = true
      const bye = JSON.stringify({ t: 'bye', reason: 'Session ended on the host' })
      for (const client of [...clients.values()]) {
        client.pendingTrust?.finish({ ok: false, reason: 'remote stopped' })
        send(client.ws, bye)
        shut(client.ws, 1001, 'host stopped')
      }
      for (const ws of waiting) shut(ws, 1001, 'host stopped')
      clients.clear()
      waiting.clear()
      setClientCount(0)
      clearInterval(heartbeat)
      wss.close()
      http.close()
      // Drop idle keep-alive page connections too, so a restart on the same
      // fixed port is not held up by a phone's browser.
      http.closeAllConnections?.()
    },
  }
}
