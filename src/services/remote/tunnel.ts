/**
 * "Global" mode: a free Cloudflare quick tunnel in front of the local server.
 *
 * `cloudflared tunnel --url http://127.0.0.1:<port>` needs no account, no
 * domain and no payment, and hands back an https://<random>.trycloudflare.com
 * origin. HTTPS matters for more than eavesdropping here: several browser
 * affordances only exist in a secure context, so the tunnelled origin is
 * strictly more capable than the LAN one.
 *
 * The tunnel is torn down with the server. Quick tunnels are ephemeral by
 * design — every /remote global gets a fresh hostname, so an old link found in
 * someone's history is already dead.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { logForDebugging } from '../../utils/debug.js'
import { installHint, resolveCloudflared } from './cloudflared.js'

/** Cloudflare prints the hostname on stderr, not stdout. */
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const STARTUP_TIMEOUT_MS = 30_000
/** The edge needs a moment to route a fresh hostname after it is printed. */
const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 700

export class TunnelUnavailableError extends Error {
  constructor() {
    super(`cloudflared was not found.\n${installHint()}\n` +
      'If it is installed somewhere unusual, set TAU_CLOUDFLARED to its full path.\n' +
      'Or use /remote local to stay on your Wi-Fi.')
    this.name = 'TunnelUnavailableError'
  }
}

export class TunnelStartError extends Error {
  constructor(detail: string) {
    super(`Could not open the tunnel: ${detail}`)
    this.name = 'TunnelStartError'
  }
}

export type Tunnel = {
  url: string
  close: () => void
  /** Resolves if the process dies on its own; used to surface a dead tunnel. */
  onExit: (fn: () => void) => void
}

/**
 * Waits until the edge actually serves the hostname. cloudflared prints the
 * URL as soon as it registers, which is a beat before the route is live —
 * scanning in that window lands on a Cloudflare error page, which reads like
 * the feature is broken.
 */
async function waitUntilRoutable(
  url: string,
  token: string,
  onProgress: (stage: string) => void,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  const started = Date.now()
  while (Date.now() < deadline) {
    onProgress(`Waiting for Cloudflare to route it… ${Math.round((Date.now() - started) / 1000)}s`)
    try {
      const res = await fetch(`${url}/img/ready?t=${encodeURIComponent(token)}`, {
        method: 'GET',
        redirect: 'manual',
      })
      // 404 means our own server answered (no such image) — the tunnel is
      // routing. A 5xx is Cloudflare's own error page, so keep waiting.
      if (res.status < 500) return
    } catch {
      /* not routable yet */
    }
    await new Promise(r => setTimeout(r, READY_POLL_MS))
  }
  logForDebugging('[remote] tunnel readiness probe timed out; continuing anyway')
}

export type TunnelProgress = (stage: string) => void

export function startTunnel(
  port: number,
  token: string,
  onProgress: TunnelProgress = () => {},
): Promise<Tunnel> {
  const found = resolveCloudflared()
  if (!found) return Promise.reject(new TunnelUnavailableError())
  if (!found.onPath) {
    logForDebugging(`[remote] using cloudflared from ${found.path} (not on PATH)`)
  }

  onProgress('Starting cloudflared…')
  return new Promise<Tunnel>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(
        found.path,
        ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      )
    } catch (err) {
      reject(new TunnelStartError((err as Error).message))
      return
    }

    let settled = false
    let log = ''
    const exitHandlers: Array<() => void> = []

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        child.kill()
        reject(new TunnelStartError('timed out waiting for a hostname'))
      })
    }, STARTUP_TIMEOUT_MS)

    const scan = (chunk: Buffer | string): void => {
      const text = String(chunk)
      // Keep the tail only; cloudflared is chatty and this buffer would grow
      // for the life of the session otherwise.
      log = (log + text).slice(-4000)
      const match = URL_RE.exec(text)
      if (!match) return
      const url = match[0]
      finish(() => {
        void waitUntilRoutable(url, token, onProgress).then(() => {
          logForDebugging(`[remote] tunnel up at ${url}`)
          resolve({
            url,
            close: () => {
              try {
                child.kill()
              } catch {
                /* already gone */
              }
            },
            onExit: fn => exitHandlers.push(fn),
          })
        })
      })
    }

    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        reject(
          err.code === 'ENOENT'
            ? new TunnelUnavailableError()
            : new TunnelStartError(err.message),
        )
      })
    })

    child.on('exit', code => {
      // After startup this is a tunnel that died under us, not a start failure.
      if (settled) {
        logForDebugging(`[remote] cloudflared exited with code ${code}`)
        for (const fn of exitHandlers) fn()
        return
      }
      finish(() => {
        const tail = log.trim().split('\n').slice(-3).join(' ').slice(0, 300)
        reject(new TunnelStartError(tail || `cloudflared exited with code ${code}`))
      })
    })
  })
}
