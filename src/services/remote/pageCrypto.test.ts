/**
 * The phone page's SHA-256 / HMAC (pageCrypto.ts) against node:crypto.
 *
 * The page runs on plain http, where browsers leave crypto.subtle undefined,
 * so it ships its own hash. One wrong constant or shift would make every
 * remembered phone fail to sign in, so this runs the exact page source.
 *
 * Run: bun run src/services/remote/pageCrypto.test.ts
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { deviceProof } from './devices.js'
import { PAGE_CRYPTO_JS } from './pageCrypto.js'
import { REMOTE_HTML } from './webui.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}: ${String(e)}`)
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`)
}

type Page = {
  sha256: (bytes: Uint8Array) => Uint8Array
  hmac: (key: Uint8Array, msg: Uint8Array) => Uint8Array
  hex: (bytes: Uint8Array) => string
  proof: (keyHex: string, nonce: string) => string
}

const page = {} as Page
runInNewContext(
  `${PAGE_CRYPTO_JS}; page.sha256=sha256; page.hmac=hmacSha256; page.hex=toHex; page.proof=deviceProof;`,
  { page, Uint8Array, Math, parseInt },
)

const bytes = (data: Buffer): Uint8Array => new Uint8Array(data)
const text = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'latin1'))

console.log('page crypto')

test('known answers: SHA-256 "abc" and RFC 4231 HMAC case 2', () => {
  eq(
    page.hex(page.sha256(text('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'sha256(abc)',
  )
  eq(
    page.hex(page.hmac(text('Jefe'), text('what do ya want for nothing?'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    'hmac(Jefe)',
  )
})

test('SHA-256 matches node:crypto for every length 0..300 and the padding edges', () => {
  const lengths = [...Array.from({ length: 301 }, (_, i) => i), 447, 448, 511, 512, 4096, 100_003]
  for (const n of lengths) {
    const data = randomBytes(n)
    eq(page.hex(page.sha256(bytes(data))), createHash('sha256').update(data).digest('hex'), `len ${n}`)
  }
})

test('HMAC matches node:crypto for short, block-sized and over-long keys', () => {
  for (const keyLength of [0, 1, 32, 63, 64, 65, 200]) {
    for (const n of [0, 1, 55, 56, 64, 81, 300]) {
      const key = randomBytes(keyLength)
      const data = randomBytes(n)
      eq(
        page.hex(page.hmac(bytes(key), bytes(data))),
        createHmac('sha256', key).update(data).digest('hex'),
        `key ${keyLength} data ${n}`,
      )
    }
  }
})

test('the page and the server compute the same sign-in proof', () => {
  for (let i = 0; i < 50; i++) {
    const key = randomBytes(32).toString('hex')
    const nonce = randomBytes(32).toString('hex')
    eq(page.proof(key, nonce), deviceProof(key, nonce), `round ${i}`)
  }
})

test('the source embeds safely in the page script', () => {
  for (const bad of ['`', '${', '\\']) {
    if (PAGE_CRYPTO_JS.includes(bad)) throw new Error(`contains ${JSON.stringify(bad)}`)
  }
  if (!REMOTE_HTML.includes('function deviceProof(keyHex,nonce)')) throw new Error('not in the page')
})

test('the served page script parses', () => {
  const script = REMOTE_HTML.slice(
    REMOTE_HTML.indexOf('<script>') + '<script>'.length,
    REMOTE_HTML.lastIndexOf('</script>'),
  )
  // Compiles without running: catches a syntax slip in the inlined code.
  new Function(script)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
