/**
 * /remote sign-in: the session link, remembered phones, and what is refused.
 *
 * Runs the real server on a free port with an in-memory device list, and a
 * real `ws` client playing the phone page — it sends the Origin header a
 * browser would. The last group drives lifecycle.ts with the file-backed
 * list, the way `tau --remote-local` does: pair with the QR link, remember
 * the phone, restart, reconnect without any link, forget it.
 *
 * Run: bun run src/services/remote/server.test.ts
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer as createNetServer, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { deviceProof, type DeviceLookup, type TrustedDevice } from './devices.js'
import { internImage } from './images.js'
import {
  CLOSE_AUTH_TIMEOUT,
  CLOSE_FORGOTTEN,
  CLOSE_NOT_REMEMBERED,
  CLOSE_STALE_LINK,
  CLOSE_TRY_AGAIN,
  CLOSE_WRONG_ORIGIN,
} from './protocol.js'
import {
  RemotePortBusyError,
  startRemoteServer,
  type ConnectionEvent,
  type DeviceStore,
  type RemoteServer,
} from './server.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor<T>(check: () => T | undefined | false, label: string, ms = 3000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = check()
    if (value !== undefined && value !== false) return value as T
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const hex = (n: number): string => randomBytes(n).toString('hex')
const TOKEN = randomBytes(32).toString('base64url')

// ─── fakes ────────────────────────────────────────────────────────────

function memoryStore() {
  const devices = new Map<string, TrustedDevice>()
  const seen: string[] = []
  let unavailable = false
  const store: DeviceStore = {
    lookup: (id): DeviceLookup => {
      if (unavailable) return { status: 'unavailable' }
      const device = devices.get(id)
      return device ? { status: 'found', device } : { status: 'absent' }
    },
    add: async ({ name, origin }) => {
      const device = { id: hex(16), key: hex(32), name, origin, pairedAt: new Date().toISOString() }
      devices.set(device.id, device)
      return device
    },
    remove: async id => devices.delete(id),
    seen: id => {
      seen.push(id)
    },
  }
  return { store, devices, seen, setUnavailable: (value: boolean) => (unavailable = value) }
}

type Message = { t: string; [key: string]: unknown }

function phone(port: number, query: string, origin: string | null) {
  // A header, not ws's `origin` option: Bun's ws shim drops that option.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, origin ? { headers: { Origin: origin } } : {})
  const messages: Message[] = []
  let closedWith: { code: number; reason: string } | undefined
  ws.on('message', raw => messages.push(JSON.parse(String(raw)) as Message))
  ws.on('close', (code, reason) => (closedWith = { code, reason: String(reason) }))
  ws.on('error', () => {})
  return {
    ws,
    messages,
    next: (t: string, nth = 0, ms = 3000) =>
      waitFor(() => messages.filter(m => m.t === t)[nth], `"${t}" (have ${messages.map(m => m.t)})`, ms),
    closed: (ms = 3000) => waitFor(() => closedWith, 'close', ms),
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
  }
}

async function serve(store: DeviceStore) {
  const events: ConnectionEvent[] = []
  const prompts: string[] = []
  const server = await startRemoteServer(
    TOKEN,
    {
      snapshot: () => ({ cwd: '/work', model: 'm', busy: false, messages: [], asks: [], commands: [] }),
      onPrompt: text => prompts.push(text),
      onInterrupt: () => {},
      onReply: () => {},
      devices: store,
      onConnection: event => events.push(event),
    },
    { port: 0, authTimeoutMs: 300, heartbeatMs: 100, trustTimeoutMs: 400 },
  )
  return { server, events, prompts, origin: `http://127.0.0.1:${server.port}` }
}

async function withServer(
  fn: (ctx: Awaited<ReturnType<typeof serve>> & { mem: ReturnType<typeof memoryStore> }) => Promise<void>,
): Promise<void> {
  const mem = memoryStore()
  const ctx = await serve(mem.store)
  try {
    await fn({ ...ctx, mem })
  } finally {
    ctx.server.close()
  }
}

/** Remembered phone signs in: challenge, HMAC answer, hello. */
async function signIn(server: RemoteServer, device: TrustedDevice, origin: string, extra = '') {
  const p = phone(server.port, `d=${device.id}${extra}`, origin)
  const challenge = await p.next('challenge')
  p.send({ t: 'auth', proof: deviceProof(device.key, String(challenge.nonce)) })
  return p
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.once('error', reject)
    s.listen(0, '0.0.0.0', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

function hold(port: number): Promise<NetServer> {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.once('error', reject)
    s.listen(port, '0.0.0.0', () => resolve(s))
  })
}

async function main(): Promise<void> {
  console.log('session link')

  await test('the QR link signs in, and the page learns an image token, not the session token', () =>
    withServer(async ({ server, origin, events }) => {
      const p = phone(server.port, `t=${encodeURIComponent(TOKEN)}&n=${encodeURIComponent('Pixel · Chrome')}`, origin)
      const hello = await p.next('hello')
      eq(hello.cwd, '/work', 'snapshot')
      assert(typeof hello.img === 'string' && hello.img !== TOKEN, 'separate image token')
      const [c] = server.connections()
      eq([c?.kind, c?.name, c?.origin, c?.scanned], ['link', 'Pixel · Chrome', origin, true], 'connection')
      eq(events.map(e => e.type), ['joined'], 'events')
    }),
  )

  await test('a stale or missing link is told so (4003) instead of being dropped', () =>
    withServer(async ({ server, origin }) => {
      eq((await phone(server.port, 't=old-token', origin).closed()).code, CLOSE_STALE_LINK, 'stale')
      eq((await phone(server.port, '', origin).closed()).code, CLOSE_STALE_LINK, 'missing')
      eq(server.connections().length, 0, 'nobody in')
    }),
  )

  await test('a page from another origin can use the link but is never offered to be remembered', () =>
    withServer(async ({ server, mem }) => {
      for (const origin of ['https://abc.trycloudflare.com', 'http://evil.example', null]) {
        const p = phone(server.port, `t=${encodeURIComponent(TOKEN)}`, origin)
        await p.next('hello')
        const c = server.connections().at(-1)!
        eq(c.origin, null, `origin ${origin}`)
        const outcome = await server.trust(c.id)
        eq(outcome.ok, false, `trust refused for ${origin}`)
        p.ws.close()
      }
      eq(mem.devices.size, 0, 'nothing remembered')
    }),
  )

  console.log('remembered phone')

  await test('signs in with an HMAC of a fresh challenge', () =>
    withServer(async ({ server, origin, mem }) => {
      const d = await mem.store.add({ name: 'Pixel', origin })
      const p = await signIn(server, d, origin)
      const hello = await p.next('hello')
      eq(hello.cwd, '/work', 'snapshot')
      const [c] = server.connections()
      eq([c?.kind, c?.deviceId, c?.name, c?.scanned], ['device', d.id, 'Pixel', false], 'connection')
      eq(mem.seen, [d.id], 'last seen recorded')
      const q = await signIn(server, d, origin, '&s=1')
      await q.next('hello')
      eq(server.connections().at(-1)?.scanned, true, 'scan flag')
    }),
  )

  await test('a wrong answer, an unknown id, or anything but an answer is refused (4004)', () =>
    withServer(async ({ server, origin, mem, prompts }) => {
      const d = await mem.store.add({ name: 'Pixel', origin })
      const wrong = phone(server.port, `d=${d.id}`, origin)
      await wrong.next('challenge')
      wrong.send({ t: 'auth', proof: deviceProof(hex(32), 'x') })
      eq((await wrong.closed()).code, CLOSE_NOT_REMEMBERED, 'wrong proof')

      eq((await phone(server.port, `d=${hex(16)}`, origin).closed()).code, CLOSE_NOT_REMEMBERED, 'unknown')

      const sneaky = phone(server.port, `d=${d.id}`, origin)
      await sneaky.next('challenge')
      sneaky.send({ t: 'prompt', text: 'rm -rf ~' })
      eq((await sneaky.closed()).code, CLOSE_NOT_REMEMBERED, 'prompt instead of an answer')
      eq(prompts, [], 'nothing reached the session')
      eq(server.connections().length, 0, 'nobody in')
    }),
  )

  await test('only from the plain-http origin it paired on (4005)', () =>
    withServer(async ({ server, origin, mem }) => {
      const d = await mem.store.add({ name: 'Pixel', origin })
      const elsewhere = await mem.store.add({ name: 'Old', origin: 'http://192.168.1.9:7777' })
      const cases: Array<[string, string | null, string]> = [
        ['no Origin (a script)', null, d.id],
        ['through the tunnel', 'https://abc.trycloudflare.com', d.id],
        ['another site', 'http://evil.example', d.id],
        ['paired on another address', origin, elsewhere.id],
      ]
      for (const [label, from, id] of cases) {
        eq((await phone(server.port, `d=${id}`, from).closed()).code, CLOSE_WRONG_ORIGIN, label)
      }
    }),
  )

  await test('an unreadable device list asks the phone to retry, keeping its key (4013)', () =>
    withServer(async ({ server, origin, mem }) => {
      const d = await mem.store.add({ name: 'Pixel', origin })
      mem.setUnavailable(true)
      eq((await phone(server.port, `d=${d.id}`, origin).closed()).code, CLOSE_TRY_AGAIN, 'retry')
      mem.setUnavailable(false)
      await (await signIn(server, d, origin)).next('hello')
    }),
  )

  await test('a phone that never answers the challenge is closed (4008)', () =>
    withServer(async ({ server, origin, mem }) => {
      const d = await mem.store.add({ name: 'Pixel', origin })
      const p = phone(server.port, `d=${d.id}`, origin)
      await p.next('challenge')
      eq((await p.closed()).code, CLOSE_AUTH_TIMEOUT, 'timeout')
    }),
  )

  console.log('remembering and forgetting')

  await test('Y in the terminal: the key goes to that phone and counts once it is saved', () =>
    withServer(async ({ server, origin, mem, events }) => {
      const p = phone(server.port, `t=${encodeURIComponent(TOKEN)}&n=Pixel`, origin)
      await p.next('hello')
      const c = server.connections()[0]!
      const pending = server.trust(c.id)
      eq((await server.trust(c.id)).ok, false, 'a second Y while saving is refused')
      const trusted = await p.next('trusted')
      p.send({ t: 'trust-saved', id: trusted.id })
      const outcome = await pending
      assert(outcome.ok && outcome.device.id === trusted.id, 'remembered')
      eq(mem.devices.get(String(trusted.id))?.origin, origin, 'saved with its origin')
      eq([server.connections()[0]?.kind, server.connections()[0]?.deviceId], ['device', trusted.id], 'now a device')
      eq(events.map(e => e.type), ['joined', 'remembered'], 'events')
      const again = await signIn(server, mem.devices.get(String(trusted.id))!, origin)
      await again.next('hello')
    }),
  )

  await test('a browser that cannot store the key, never answers, or leaves is not remembered', () =>
    withServer(async ({ server, origin, mem }) => {
      const refuse = phone(server.port, `t=${encodeURIComponent(TOKEN)}`, origin)
      await refuse.next('hello')
      const first = server.trust(server.connections()[0]!.id)
      const offered = await refuse.next('trusted')
      refuse.send({ t: 'trust-failed', id: offered.id })
      eq((await first).ok, false, 'storage refused')

      const silent = phone(server.port, `t=${encodeURIComponent(TOKEN)}`, origin)
      await silent.next('hello')
      eq((await server.trust(server.connections().at(-1)!.id)).ok, false, 'no answer')

      const leaver = phone(server.port, `t=${encodeURIComponent(TOKEN)}`, origin)
      await leaver.next('hello')
      const third = server.trust(server.connections().at(-1)!.id)
      await leaver.next('trusted')
      leaver.ws.close()
      eq((await third).ok, false, 'left')

      await waitFor(() => mem.devices.size === 0, 'records dropped')
    }),
  )

  await test('forgetting signs the phone out at once, for good (4006)', () =>
    withServer(async ({ server, origin, mem }) => {
      const d = await mem.store.add({ name: 'Pixel', origin })
      const p = await signIn(server, d, origin)
      await p.next('hello')
      server.disconnectDevice(d.id)
      eq((await p.closed()).code, CLOSE_FORGOTTEN, 'closed')
    }),
  )

  await test('forgotten in another Tau window: signed out by the next heartbeat', () =>
    withServer(async ({ server, origin, mem }) => {
      const d = await mem.store.add({ name: 'Pixel', origin })
      const p = await signIn(server, d, origin)
      await p.next('hello')
      mem.devices.delete(d.id)
      eq((await p.closed(1000)).code, CLOSE_FORGOTTEN, 'closed')
    }),
  )

  console.log('the rest of the surface')

  await test('images need the image token or the session token', () =>
    withServer(async ({ server, origin }) => {
      const id = internImage('image/png', Buffer.from('not really a png').toString('base64'))!
      const url = `http://127.0.0.1:${server.port}/img/${id}`
      eq((await fetch(url)).status, 403, 'none')
      eq((await fetch(`${url}?t=nope`)).status, 403, 'wrong')
      eq((await fetch(`${url}?t=${encodeURIComponent(TOKEN)}`)).status, 200, 'session token')
      const p = phone(server.port, `t=${encodeURIComponent(TOKEN)}`, origin)
      const hello = await p.next('hello')
      eq((await fetch(`${url}?t=${hello.img}`)).status, 200, 'image token')
      const page = await fetch(`http://127.0.0.1:${server.port}/`)
      eq([page.status, page.headers.get('referrer-policy')], [200, 'no-referrer'], 'page')
    }),
  )

  await test('ping gets pong, prompts reach the session, close says goodbye', () =>
    withServer(async ({ server, origin, prompts }) => {
      const p = phone(server.port, `t=${encodeURIComponent(TOKEN)}`, origin)
      await p.next('hello')
      p.send({ t: 'ping' })
      await p.next('pong')
      p.send({ t: 'prompt', text: '  hello there  ' })
      await waitFor(() => prompts.length === 1, 'prompt')
      eq(prompts, ['hello there'], 'trimmed prompt')
      server.close()
      await p.next('bye')
      eq((await p.closed()).code, 1001, 'host stopped')
    }),
  )

  await test('a stopped listener answers nothing, even on a socket opened before it stopped', async () => {
    // Browsers pre-open spare sockets. On Bun one survives close() and used to
    // reach the old listener after a restart, whose stale image token gave 403s.
    const { server } = await serve(memoryStore().store)
    const spare = connect(server.port, '127.0.0.1')
    let reply = ''
    spare.on('data', chunk => (reply += chunk))
    spare.on('error', () => {})
    await new Promise(resolve => spare.once('connect', resolve))
    await sleep(100)
    server.close()
    await sleep(200)
    if (!spare.destroyed && spare.writable) spare.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
    await sleep(400)
    spare.destroy()
    eq(reply, '', 'answer from a stopped listener')
  })

  await test('a pinned port that is taken is refused, not silently moved', async () => {
    const port = await freePort()
    const blocker = await hold(port)
    try {
      let error: unknown
      try {
        const s = await startRemoteServer(TOKEN, {
          snapshot: () => ({ cwd: '', model: '', busy: false, messages: [], asks: [], commands: [] }),
          onPrompt: () => {},
          onInterrupt: () => {},
          onReply: () => {},
          devices: memoryStore().store,
        }, { port })
        s.close()
      } catch (err) {
        error = err
      }
      assert(error instanceof RemotePortBusyError, `got ${String(error)}`)
    } finally {
      blocker.close()
    }
  })

  console.log('lifecycle, as tau --remote-local runs it')

  await test('pair, remember, restart, reconnect without a link, forget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-remote-lifecycle-'))
    const port = await freePort()
    Object.assign(process.env, {
      CLAUDE_CONFIG_DIR: root,
      TAU_REMOTE_HOST: '127.0.0.1',
      TAU_REMOTE_PORT: String(port),
    })
    const life = await import('./lifecycle.js')
    const origin = `http://127.0.0.1:${port}`
    try {
      const first = await life.turnOn('local')
      eq(first.url, `${origin}/#${first.token}`, 'scan link')
      eq(first.preferredPortBusy, false, 'pinned port')

      const joined: string[] = []
      const stop = life.subscribeConnections(e => joined.push(`${e.type}:${e.connection.kind}`))
      const p = phone(port, `t=${encodeURIComponent(first.token)}&n=Pixel`, origin)
      await p.next('hello')
      const [c] = life.listConnections()
      const pending = life.trustConnection(c!.id)
      const offered = await p.next('trusted')
      p.send({ t: 'trust-saved', id: offered.id })
      eq((await pending).ok, true, 'remembered')
      const [saved] = life.listRememberedDevices()
      eq([saved?.name, saved?.origin], ['Pixel', origin], 'on disk')

      life.turnOff()
      eq((await p.closed()).code, 1001, 'session ended')

      const second = await life.turnOn('local')
      assert(second.token !== first.token, 'new session token')
      eq((await phone(port, `t=${encodeURIComponent(first.token)}`, origin).closed()).code, CLOSE_STALE_LINK, 'old link dead')

      const back = phone(port, `d=${offered.id}`, origin)
      const challenge = await back.next('challenge')
      back.send({ t: 'auth', proof: deviceProof(String(offered.key), String(challenge.nonce)) })
      await back.next('hello')

      eq(await life.forgetDevice(String(offered.id)), true, 'forgotten')
      eq((await back.closed()).code, CLOSE_FORGOTTEN, 'signed out')
      eq(life.listRememberedDevices(), [], 'gone from disk')
      eq((await phone(port, `d=${offered.id}`, origin).closed()).code, CLOSE_NOT_REMEMBERED, 'cannot return')
      stop()
      eq(joined.slice(0, 2), ['joined:link', 'remembered:device'], 'events')
    } finally {
      life.turnOff()
      delete process.env.TAU_REMOTE_PORT
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  await test('a bad or taken TAU_REMOTE_PORT fails before anything starts', async () => {
    const life = await import('./lifecycle.js')
    process.env.TAU_REMOTE_HOST = '127.0.0.1'
    try {
      for (const value of ['abc', '70000', '-1', '80 80']) {
        process.env.TAU_REMOTE_PORT = value
        let error: unknown
        await life.turnOn('local').catch(err => (error = err))
        assert(error instanceof life.InvalidRemotePortError, `${value}: ${String(error)}`)
        eq(life.isOn(), false, `${value}: nothing running`)
      }
      const port = await freePort()
      const blocker = await hold(port)
      process.env.TAU_REMOTE_PORT = String(port)
      let error: unknown
      await life.turnOn('local').catch(err => (error = err))
      blocker.close()
      assert(error instanceof RemotePortBusyError, `busy: ${String(error)}`)
      eq(life.isOn(), false, 'busy: nothing running')
    } finally {
      delete process.env.TAU_REMOTE_PORT
    }
  })

  await test('--remote-local is taken once, and only when asked for', async () => {
    const auto = await import('./autostart.js')
    eq(auto.takeLocalAtStartup(), false, 'not asked')
    auto.requestLocalAtStartup()
    eq(auto.takeLocalAtStartup(), true, 'asked')
    eq(auto.takeLocalAtStartup(), false, 'only once')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
