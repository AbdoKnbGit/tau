/**
 * Remembered phones for /remote local (devices.ts): the file, the lock, and
 * the rules sign-in depends on.
 *
 * Two of these guard security, not convenience:
 *  - an unreadable file must read as "unavailable", never "absent": absent
 *    tells the phone to throw its key away;
 *  - a write racing a forget must never bring the forgotten phone back.
 *
 * Run: bun run src/services/remote/devices.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  addDevice,
  cleanDeviceName,
  deviceProof,
  devicesFile,
  listDevices,
  lookupDevice,
  markDeviceSeen,
  proofMatches,
  removeDevice,
} from './devices.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'tau-remote-devices-'))
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}: ${String(e)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: ${a} !== ${b}`)
}

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(label)
}

const ORIGIN = 'http://192.168.1.5:7777'
const ch = (...codes: number[]): string => String.fromCodePoint(...codes)

async function main(): Promise<void> {
  console.log('remembered phones')

  await test('no file means no phones, and nothing is created by reading', () => {
    eq(listDevices(), [], 'list')
    eq(lookupDevice('0'.repeat(32)), { status: 'absent' }, 'lookup')
    assert(!existsSync(dirname(devicesFile())), 'no directory created')
  })

  await test('a remembered phone round-trips with a fresh id and key', async () => {
    const device = await addDevice({ name: 'Android phone · Chrome', origin: ORIGIN })
    assert(/^[0-9a-f]{32}$/.test(device.id), 'id format')
    assert(/^[0-9a-f]{64}$/.test(device.key), 'key format')
    eq(device.origin, ORIGIN, 'origin')
    eq(listDevices(), [device], 'list')
    eq(lookupDevice(device.id), { status: 'found', device }, 'lookup')
    const other = await addDevice({ name: 'iPhone · Safari', origin: ORIGIN })
    assert(other.id !== device.id && other.key !== device.key, 'ids and keys differ')
    if (process.platform !== 'win32') {
      eq(statSync(devicesFile()).mode & 0o777, 0o600, 'file mode')
      eq(statSync(dirname(devicesFile())).mode & 0o777, 0o700, 'dir mode')
    }
  })

  await test('only plain-http page origins can be remembered', async () => {
    for (const origin of ['https://x.trycloudflare.com', 'http://a/b', 'file://x', '']) {
      let threw = false
      try {
        await addDevice({ name: 'x', origin })
      } catch {
        threw = true
      }
      assert(threw, `accepted ${JSON.stringify(origin)}`)
    }
    eq(listDevices(), [], 'nothing saved')
  })

  await test('forgetting one phone keeps the others', async () => {
    const a = await addDevice({ name: 'A', origin: ORIGIN })
    const b = await addDevice({ name: 'B', origin: ORIGIN })
    eq(await removeDevice(a.id), true, 'removed')
    eq(await removeDevice(a.id), false, 'already gone')
    eq(lookupDevice(a.id), { status: 'absent' }, 'a absent')
    eq(listDevices().map(d => d.id), [b.id], 'b kept')
  })

  await test('names lose control, bidi and zero-width characters and stay short', async () => {
    const dirty = `  Evil${ch(0x1b)}[2J${ch(0x202e)}phone${ch(0x200b)}${ch(0x2066)}\n\tname  `
    eq(cleanDeviceName(dirty), 'Evil[2Jphone name', 'cleaned')
    eq(cleanDeviceName('x'.repeat(200)).length, 48, 'capped')
    eq(cleanDeviceName(42), '', 'non-string')
    const saved = await addDevice({ name: `${ch(0x1b)}${ch(0x7)}`, origin: ORIGIN })
    eq(saved.name, 'Phone', 'empty name falls back')
  })

  await test('a damaged file is moved aside, not trusted and not deleted', () => {
    mkdirSync(dirname(devicesFile()), { recursive: true })
    writeFileSync(devicesFile(), '{"version":1,"devices":[{')
    eq(listDevices(), [], 'list')
    const aside = readdirSync(dirname(devicesFile())).filter(f => f.startsWith('devices.json.corrupt-'))
    eq(aside.length, 1, 'quarantined copy')
    assert(!existsSync(devicesFile()), 'original moved')
  })

  await test('malformed entries are skipped, good ones kept', async () => {
    const good = await addDevice({ name: 'Good', origin: ORIGIN })
    const file = JSON.parse(readFileSync(devicesFile(), 'utf8'))
    file.devices.push({ ...good, id: 'not-hex' }, { ...good, id: 'a'.repeat(32), key: 'short' }, null)
    writeFileSync(devicesFile(), JSON.stringify(file))
    eq(listDevices().map(d => d.id), [good.id], 'only the good one')
  })

  await test('an unreadable file is "unavailable", never "absent"', () => {
    // A directory where the file should be: readFileSync fails with EISDIR.
    mkdirSync(devicesFile(), { recursive: true })
    eq(lookupDevice('a'.repeat(32)), { status: 'unavailable' }, 'lookup')
    eq(listDevices(), [], 'list shows empty')
  })

  await test('ten windows remembering at once lose nothing', async () => {
    const added = await Promise.all(
      Array.from({ length: 10 }, (_, i) => addDevice({ name: `Phone ${i}`, origin: ORIGIN })),
    )
    eq(listDevices().length, 10, 'all saved')
    for (const d of added) eq(lookupDevice(d.id).status, 'found', d.name)
  })

  await test('last seen is throttled and never re-adds a forgotten phone', async () => {
    const d = await addDevice({ name: 'P', origin: ORIGIN })
    const t0 = Date.parse('2026-11-15T10:00:00Z')
    await markDeviceSeen(d.id, t0)
    eq(listDevices()[0]?.lastSeenAt, new Date(t0).toISOString(), 'first seen')
    await markDeviceSeen(d.id, t0 + 60_000)
    eq(listDevices()[0]?.lastSeenAt, new Date(t0).toISOString(), 'throttled')
    await markDeviceSeen(d.id, t0 + 11 * 60_000)
    eq(listDevices()[0]?.lastSeenAt, new Date(t0 + 11 * 60_000).toISOString(), 'updated')
    // Forget and a late "seen" racing each other: forgotten wins.
    await Promise.all([removeDevice(d.id), markDeviceSeen(d.id, t0 + 60 * 60_000)])
    eq(lookupDevice(d.id), { status: 'absent' }, 'still forgotten')
  })

  await test('proofs: right key and nonce only, timing-safe on bad input', () => {
    const key = 'ab'.repeat(32)
    const nonce = 'cd'.repeat(32)
    const proof = deviceProof(key, nonce)
    eq(proofMatches(key, nonce, proof), true, 'right')
    eq(proofMatches(key, 'ef'.repeat(32), proof), false, 'other nonce')
    eq(proofMatches('12'.repeat(32), nonce, proof), false, 'other key')
    eq(proofMatches(key, nonce, proof.slice(1)), false, 'short')
    eq(proofMatches(key, nonce, undefined), false, 'missing')
    eq(proofMatches(key, nonce, { proof }), false, 'object')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
