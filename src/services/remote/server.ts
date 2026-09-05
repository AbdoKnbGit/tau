/**
 * HTTP + WebSocket server behind /remote.
 *
 * Binds 0.0.0.0 so a phone on the same Wi-Fi can reach it directly in local
 * mode; in global mode the same listener sits behind a Cloudflare quick
 * tunnel. Either way this machine is the server — there is no relay holding
 * session data, which is why it costs nothing.
 *
 * Auth is a 32-byte token carried in the URL fragment. Fragments are never
 * sent to a server, so the token stays out of the HTTP request for the page
 * itself; the page's script reads it and presents it on the WebSocket upgrade,
 * which is the only authenticated surface. The served HTML is inert on its own.
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { logForDebugging } from '../../utils/debug.js'
import { getImage } from './images.js'
import type { Snapshot } from './lifecycle.js'
import { setClientCount } from './state.js'
import { REMOTE_HTML } from './webui.js'

const PREFERRED_PORT = 7777

export type ServerHooks = {
  /** Snapshot sent to a client the moment it connects. */
  snapshot: () => Snapshot
  onPrompt: (text: string) => void
  onInterrupt: () => void
  onReply: (id: string, payload: unknown) => void
}

export type RemoteServer = {
  port: number
  broadcast: (payload: unknown) => void
  close: () => void
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, so guard first. Length is not
  // secret here (the token is fixed-width), only the bytes are.
  return left.length === right.length && timingSafeEqual(left, right)
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

export async function startRemoteServer(
  token: string,
  hooks: ServerHooks,
): Promise<RemoteServer> {
  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // The token lives in the fragment; make sure nothing caches the shell
        // across sessions with a stale script.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(REMOTE_HTML)
      return
    }
    // Images are session content, so unlike the inert shell they need the
    // token. Ids are content hashes, which makes the URL immutable — hence
    // the aggressive cache header.
    const image = path.startsWith('/img/') ? getImage(path.slice(5)) : undefined
    if (image) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!tokensMatch(url.searchParams.get('t') ?? '', token)) {
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
  try {
    port = await listen(http, PREFERRED_PORT)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    // Something else owns 7777 (another tau, most likely) — take any free port.
    port = await listen(http, 0)
  }

  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()
  const alive = new WeakSet<WebSocket>()

  const announce = (): void => {
    setClientCount(clients.size)
  }

  /**
   * Ping every client on an interval and drop the ones that stop answering.
   *
   * Two problems, one fix. A Cloudflare quick tunnel closes a WebSocket that
   * has been idle for a couple of minutes, which a long thinking turn easily
   * exceeds — the ping keeps it open. And a phone that walks out of Wi-Fi
   * range never sends a FIN, so without this the socket sits half-open forever
   * and the footer keeps claiming a device is connected.
   */
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!alive.has(ws)) {
        clients.delete(ws)
        announce()
        try {
          ws.terminate()
        } catch {
          /* already gone */
        }
        continue
      }
      alive.delete(ws)
      try {
        ws.ping()
      } catch {
        /* the next sweep will collect it */
      }
    }
  }, 30_000)
  // Never hold the process open on this timer alone.
  heartbeat.unref?.()

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws' || !tokensMatch(url.searchParams.get('t') ?? '', token)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      clients.add(ws)
      alive.add(ws)
      ws.on('pong', () => alive.add(ws))
      announce()

      const snap = hooks.snapshot()
      ws.send(JSON.stringify({ t: 'hello', ...snap }))

      ws.on('message', raw => {
        alive.add(ws)
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
        }
      })

      const drop = (): void => {
        clients.delete(ws)
        announce()
      }
      ws.on('close', drop)
      ws.on('error', drop)
    })
  })

  logForDebugging(`[remote] listening on 0.0.0.0:${port}`)

  return {
    port,
    broadcast(payload: unknown): void {
      if (clients.size === 0) return
      const data = JSON.stringify(payload)
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(data)
          } catch {
            /* connection churning — the close handler will clean up */
          }
        }
      }
    },
    close(): void {
      const bye = JSON.stringify({ t: 'bye', reason: 'Session ended on the host' })
      for (const ws of clients) {
        try {
          if (ws.readyState === ws.OPEN) ws.send(bye)
          ws.close(1001, 'host stopped')
        } catch {
          /* already gone */
        }
      }
      clients.clear()
      setClientCount(0)
      clearInterval(heartbeat)
      wss.close()
      http.close()
    },
  }
}
