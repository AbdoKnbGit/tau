/**
 * Content-addressed store for images shown on the phone.
 *
 * Images travel as an id, not as base64 in the transcript frame. That matters
 * because the snapshot is re-sent in full on every reconnect: a couple of
 * screenshots inlined would turn a reconnect into a multi-megabyte replay over
 * a phone's connection, every time the socket blips. As ids they are fetched
 * once over HTTP and then live in the browser cache — the id is a hash of the
 * bytes, so the URL is immutable and cacheable forever.
 *
 * The store is bounded. A long session with a screenshot-heavy tool would
 * otherwise grow without limit for the whole run.
 */

import { createHash } from 'node:crypto'

export type StoredImage = {
  mediaType: string
  bytes: Buffer
}

/** Roughly a dozen full-resolution screenshots. */
const MAX_BYTES = 48 * 1024 * 1024
const MAX_ENTRIES = 80

const store = new Map<string, StoredImage>()
let totalBytes = 0

function evictOldest(): void {
  // Map preserves insertion order, so the first key is the oldest. Re-storing
  // an existing image doesn't refresh its position, which is fine: the id is
  // content-addressed, so an evicted image simply 404s and the phone shows
  // its placeholder rather than serving the wrong bytes.
  const oldest = store.keys().next()
  if (oldest.done) return
  const entry = store.get(oldest.value)
  if (entry) totalBytes -= entry.bytes.byteLength
  store.delete(oldest.value)
}

/** Interns base64 image data and returns its stable id. */
export function internImage(mediaType: string, base64: string): string | null {
  if (!base64) return null
  let bytes: Buffer
  try {
    bytes = Buffer.from(base64, 'base64')
  } catch {
    return null
  }
  if (bytes.byteLength === 0) return null

  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  if (store.has(id)) return id

  store.set(id, { mediaType: mediaType || 'image/png', bytes })
  totalBytes += bytes.byteLength
  while (store.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    if (store.size <= 1) break
    evictOldest()
  }
  return id
}

export function getImage(id: string): StoredImage | undefined {
  return store.get(id)
}

/** Dropped on /remote off so a stopped session isn't still holding screenshots. */
export function clearImages(): void {
  store.clear()
  totalBytes = 0
}

export function imageStoreStats(): { count: number; bytes: number } {
  return { count: store.size, bytes: totalBytes }
}
