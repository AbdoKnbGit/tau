/**
 * Phones remembered for /remote local, kept in <config>/remote/devices.json.
 *
 * Pairing still starts with the QR code. When the user then answers Y in the
 * terminal, the phone gets a device id and a 32-byte key, which its browser
 * keeps in localStorage for that page's origin (http://<lan-ip>:<port>). In a
 * later session the page signs in with the id, the server sends a fresh
 * challenge, and the page answers with an HMAC of it. After pairing the key
 * itself never crosses the network again, and a captured answer is useless
 * because the next challenge is different. The key is stored in the clear
 * here because the server has to compute the same HMAC; the file is private
 * to this user (0600 on POSIX, the profile's ACL on Windows).
 *
 * Every read goes to disk: another Tau window may have paired or forgotten a
 * phone since, and forgetting must take effect in every window. Writes hold a
 * lock and re-read inside it, so two windows cannot undo each other's change;
 * a stale write could otherwise bring back a phone the user just forgot.
 *
 * Kept free of config.ts and the REPL graph so it runs under `bun run`.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { lock } from '../../utils/lockfile.js'
import { PROOF_CONTEXT } from './pageCrypto.js'

export type TrustedDevice = {
  /** 16 random bytes, hex. Sent in the clear at sign-in; not a secret. */
  id: string
  /** What the phone called itself when it paired, e.g. "Android phone · Chrome". */
  name: string
  /** 32-byte HMAC key, hex. Shared with that phone's browser and nobody else. */
  key: string
  /** The page origin it paired on. The phone is only accepted there. */
  origin: string
  pairedAt: string
  lastSeenAt?: string
}

export type DeviceLookup =
  | { status: 'found'; device: TrustedDevice }
  | { status: 'absent' }
  /** The file exists but could not be read. Never treat this as "forgotten". */
  | { status: 'unavailable' }

const ID_RE = /^[0-9a-f]{32}$/
const KEY_RE = /^[0-9a-f]{64}$/
const ORIGIN_RE = /^http:\/\/[^/?#\s]+$/
const NAME_MAX = 48
/** Don't rewrite the file on every reconnect blip just to move a timestamp. */
const SEEN_GRANULARITY_MS = 10 * 60_000

export function devicesFile(): string {
  return join(getClaudeConfigHomeDir(), 'remote', 'devices.json')
}

/**
 * Printable text only. Names arrive from a browser and are shown in the
 * terminal, so control characters (an escape sequence could restyle or move
 * the cursor), zero-width and bidi characters are removed.
 */
export function cleanDeviceName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    // Tab, line breaks: a space, so "phone\nname" doesn't become "phonename".
    if (code >= 0x09 && code <= 0x0d) {
      out += ' '
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue
    if (code >= 0x200b && code <= 0x200f) continue
    if (code >= 0x202a && code <= 0x202e) continue
    if ((code >= 0x2060 && code <= 0x2069) || code === 0xfeff) continue
    out += ch
  }
  return Array.from(out.replace(/\s+/g, ' ').trim()).slice(0, NAME_MAX).join('').trim()
}

function isDevice(value: unknown): value is TrustedDevice {
  if (!value || typeof value !== 'object') return false
  const d = value as Record<string, unknown>
  return (
    typeof d.id === 'string' &&
    ID_RE.test(d.id) &&
    typeof d.key === 'string' &&
    KEY_RE.test(d.key) &&
    typeof d.name === 'string' &&
    typeof d.origin === 'string' &&
    ORIGIN_RE.test(d.origin) &&
    typeof d.pairedAt === 'string' &&
    (d.lastSeenAt === undefined || typeof d.lastSeenAt === 'string')
  )
}

/**
 * Moves an unparseable file aside rather than deleting it. Writes are atomic
 * (temp file + rename), so a reader never sees half a file from another
 * window; unparseable means damaged or hand-edited.
 */
function quarantine(file: string): void {
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`)
  } catch {
    /* another window got there first */
  }
}

/** Throws when the file exists but cannot be read; a missing file is empty. */
function readDevices(file: string): TrustedDevice[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    quarantine(file)
    return []
  }
  const list = (parsed as { devices?: unknown } | null)?.devices
  if (!Array.isArray(list)) {
    quarantine(file)
    return []
  }
  return list.filter(isDevice).map(d => ({
    id: d.id,
    name: cleanDeviceName(d.name) || 'Phone',
    key: d.key,
    origin: d.origin,
    pairedAt: d.pairedAt,
    ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}),
  }))
}

/** For display. An unreadable file shows as empty. */
export function listDevices(): TrustedDevice[] {
  try {
    return readDevices(devicesFile())
  } catch {
    return []
  }
}

/** For sign-in, where "can't read" and "not there" must not be confused. */
export function lookupDevice(id: string): DeviceLookup {
  if (!ID_RE.test(id)) return { status: 'absent' }
  let devices: TrustedDevice[]
  try {
    devices = readDevices(devicesFile())
  } catch {
    return { status: 'unavailable' }
  }
  const device = devices.find(d => d.id === id)
  return device ? { status: 'found', device } : { status: 'absent' }
}

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Windows briefly refuses to replace a file another process has open.
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

async function writeDevices(file: string, devices: TrustedDevice[]): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`, { mode: 0o600 })
  try {
    await renameOver(temp, file)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      /* already gone */
    }
    throw err
  }
}

/** Read-modify-write under the cross-window lock. */
async function update<T>(
  change: (devices: TrustedDevice[]) => { next?: TrustedDevice[]; result: T },
): Promise<T> {
  const file = devicesFile()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const release = await lock(file, {
    realpath: false,
    stale: 10_000,
    retries: { retries: 40, minTimeout: 25, maxTimeout: 250 },
  })
  try {
    const { next, result } = change(readDevices(file))
    if (next) await writeDevices(file, next)
    return result
  } finally {
    await release().catch(() => {})
  }
}

export async function addDevice(input: { name: string; origin: string }): Promise<TrustedDevice> {
  if (!ORIGIN_RE.test(input.origin)) {
    throw new Error(`not a plain-http page origin: ${input.origin}`)
  }
  const device: TrustedDevice = {
    id: randomBytes(16).toString('hex'),
    name: cleanDeviceName(input.name) || 'Phone',
    key: randomBytes(32).toString('hex'),
    origin: input.origin,
    pairedAt: new Date().toISOString(),
  }
  return update(devices => ({ next: [...devices, device], result: device }))
}

export async function removeDevice(id: string): Promise<boolean> {
  return update(devices => {
    const next = devices.filter(d => d.id !== id)
    return next.length === devices.length ? { result: false } : { next, result: true }
  })
}

/** Best effort, and never re-adds a phone forgotten in the meantime. */
export async function markDeviceSeen(id: string, now = Date.now()): Promise<void> {
  const found = lookupDevice(id)
  if (found.status !== 'found') return
  const last = Date.parse(found.device.lastSeenAt ?? '')
  if (Number.isFinite(last) && now - last < SEEN_GRANULARITY_MS) return
  await update(devices => {
    const index = devices.findIndex(d => d.id === id)
    if (index < 0) return { result: undefined }
    const next = devices.slice()
    next[index] = { ...devices[index]!, lastSeenAt: new Date(now).toISOString() }
    return { next, result: undefined }
  }).catch(() => {})
}

export function deviceProof(keyHex: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(PROOF_CONTEXT + nonce, 'latin1')
    .digest('hex')
}

export function proofMatches(keyHex: string, nonce: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false
  const expected = Buffer.from(deviceProof(keyHex, nonce))
  const given = Buffer.from(proof)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
