/**
 * The one-way channel from session code out to paired phones.
 *
 * Exists to keep the hot paths honest about their dependencies. The permission
 * handler needs two things — "is anyone paired?" and "send this" — and nothing
 * else. Routing those through lifecycle.ts would drag the HTTP server, the
 * WebSocket layer and the tunnel subprocess into the import graph of every
 * tool permission check, and would close an import cycle
 * (lifecycle → router → interactive → lifecycle) on the way.
 *
 * The sink is installed when the server starts and cleared when it stops, so a
 * non-null sink is also the authoritative answer to "is /remote running?".
 */

let sink: ((payload: unknown) => void) | null = null

export function setBroadcastSink(fn: ((payload: unknown) => void) | null): void {
  sink = fn
}

export function broadcast(payload: unknown): void {
  sink?.(payload)
}

/** True while /remote is serving. Cheap enough for a per-tool-call check. */
export function isRemoteActive(): boolean {
  return sink !== null
}

/**
 * Live count of paired devices, with fan-out. Two places watch it — the
 * pairing dialog (to dismiss itself once you have scanned) and the prompt
 * footer (to show the pill) — so a single-slot listener would have them
 * fighting over the same callback.
 */
let clientCount = 0
const clientListeners = new Set<(n: number) => void>()

export function setClientCount(n: number): void {
  if (n === clientCount) return
  clientCount = n
  for (const fn of clientListeners) fn(n)
}

export function getClientCount(): number {
  return clientCount
}

export function subscribeClients(fn: (n: number) => void): () => void {
  clientListeners.add(fn)
  return () => {
    clientListeners.delete(fn)
  }
}
