/**
 * Module-level state for the /remote server.
 *
 * Deliberately not persisted: unlike /whatsapp, remote control of this session
 * should never survive a restart without the user asking for it again. A stale
 * token on a shared network is a footgun.
 */

import { randomBytes } from 'node:crypto'
import { setClientCount as publishClientCount } from './bus.js'
import type { RemoteMode } from './lifecycle.js'

export type RemoteState = {
  mode: RemoteMode
  /** base64url secret; travels only in the URL fragment. */
  token: string
  /** Port the HTTP+WS server is bound to. */
  port: number
  /** LAN address in local mode; loopback when a tunnel fronts it. */
  host: string
  /** Full scan URL, fragment included. */
  url: string
  /** In global mode the LAN URL still works too; null in local mode. */
  lanUrl: string | null
  /** Set when cloudflared died after startup — the public URL is dead. */
  tunnelDown?: boolean
  /** Live phone/browser connections. */
  clients: number
}

let state: RemoteState | null = null

export function getRemoteState(): RemoteState | null {
  return state
}

export function setRemoteState(next: RemoteState | null): void {
  state = next
}

export function setClientCount(n: number): void {
  if (state) state.clients = n
  publishClientCount(n)
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}
