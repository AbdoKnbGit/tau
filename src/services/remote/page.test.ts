/**
 * The phone page in a real browser: headless Chrome or Edge, driven over the
 * DevTools protocol, against the real /remote server (lifecycle.ts, file-backed
 * device list). Covers what only the page decides:
 *
 *  - scanning the link connects; Y in the terminal stores the key in
 *    localStorage and drops the token from the address bar;
 *  - when Tau restarts, the open page reconnects by itself with its key;
 *  - a reload with no link at all still connects;
 *  - images load with the image token a key sign-in receives;
 *  - forgotten while open: signed out, that key dropped, no retry loop;
 *  - forgotten while away: told so on return; the key stays, because
 *    another Tau at this address may know it;
 *  - an old link, or no link and no key: told what to do, no retry loop;
 *  - two Tau installs taking turns on one address (Tau on Windows and Tau
 *    in WSL with mirrored networking): the phone keeps a key for each and
 *    never has to scan again;
 *  - a key saved by the older one-key page still signs in.
 *
 * Skips when no Chrome/Edge/Chromium is installed (set CHROME_PATH to choose).
 * Run: bun run src/services/remote/page.test.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(label)
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function findBrowser(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]
  return candidates.find(path => path && existsSync(path)) ?? null
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

/** Just enough DevTools protocol: commands with replies, nothing else. */
class Page {
  private next = 0
  private pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>()
  /** Network events for image requests, for failure reports. */
  readonly imageLog: string[] = []

  private constructor(private ws: WebSocket) {
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw)) as {
        id?: number
        method?: string
        result?: unknown
        error?: { message: string }
        params?: { request?: { url: string }; response?: { url: string; status: number }; errorText?: string; requestId?: string }
      }
      if (msg.id !== undefined) {
        this.pending.get(msg.id)?.(msg)
        this.pending.delete(msg.id)
        return
      }
      const url = msg.params?.request?.url ?? msg.params?.response?.url ?? ''
      if (msg.method === 'Network.requestWillBeSent' && url.includes('/img/')) {
        this.imageLog.push(`request ${msg.params?.requestId} ${url}`)
      } else if (msg.method === 'Network.responseReceived' && url.includes('/img/')) {
        this.imageLog.push(`response ${msg.params?.requestId} ${msg.params?.response?.status}`)
      } else if (msg.method === 'Network.loadingFailed') {
        this.imageLog.push(`failed ${msg.params?.requestId} ${msg.params?.errorText}`)
      }
    })
  }

  static async open(url: string): Promise<Page> {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return new Page(ws)
  }

  send(method: string, params: object = {}): Promise<unknown> {
    const id = ++this.next
    return new Promise((resolve, reject) => {
      this.pending.set(id, msg => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval<T>(expression: string): Promise<T> {
    const reply = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: T }; exceptionDetails?: { text: string } }
    if (reply.exceptionDetails) throw new Error(`page threw: ${reply.exceptionDetails.text}`)
    return reply.result.value
  }

  /**
   * about:blank first, so a new #fragment on the same page really reloads.
   * The check ignores the #fragment: the page drops an expired link's token
   * from the address bar, which can happen before the load is seen.
   */
  async go(url: string): Promise<void> {
    await this.send('Page.navigate', { url: 'about:blank' })
    await sleep(100)
    await this.send('Page.navigate', { url })
    const page = url.split('#')[0]
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      try {
        if (await this.eval<boolean>(`location.href.split('#')[0] === ${JSON.stringify(page)} && document.readyState === 'complete'`)) return
      } catch {
        /* navigating */
      }
      await sleep(50)
    }
    throw new Error(`page did not load: ${url}`)
  }

  close(): void {
    this.ws.close()
  }
}

/** `keys`: the ids in the page's key list, in order. `old`: the pre-list single key. */
type View = { dot: string; banner: string; hash: string; keys: string[]; old: string | null; cwd: string }

async function main(): Promise<void> {
  const browserPath = findBrowser()
  if (!browserPath) {
    console.log('phone page: skipped, no Chrome/Edge/Chromium found (set CHROME_PATH)')
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'tau-remote-page-'))
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    TAU_REMOTE_HOST: '127.0.0.1',
    TAU_REMOTE_PORT: String(port),
  })
  const life = await import('./lifecycle.js')
  const { broadcast } = await import('./bus.js')
  const { internImage } = await import('./images.js')
  const { getRemoteState } = await import('./state.js')
  life.setSnapshotProvider(() => ({
    cwd: '/work/project',
    model: 'test-model',
    busy: false,
    messages: [],
    asks: [],
    commands: [],
  }))

  let browser: ChildProcess | undefined
  let page: Page | undefined
  try {
    const profile = join(root, 'browser')
    browser = spawn(
      browserPath,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    const portFile = join(profile, 'DevToolsActivePort')
    const end = Date.now() + 30_000
    while (!existsSync(portFile) && Date.now() < end) await sleep(100)
    const devtools = readFileSync(portFile, 'utf8').split('\n')[0]!.trim()
    const targets = (await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()) as Array<{
      type: string
      webSocketDebuggerUrl: string
    }>
    page = await Page.open(targets.find(t => t.type === 'page')!.webSocketDebuggerUrl)
    await page.send('Page.enable')
    await page.send('Network.enable')
    const p = page

    const view = (): Promise<View> =>
      p.eval<View>(`({
        dot: document.getElementById('dot').className,
        banner: document.getElementById('banner').className === 'on' ? document.getElementById('banner').textContent : '',
        hash: location.hash,
        keys: (function(){ try { return JSON.parse(localStorage.getItem('tau-remote-keys') || '[]').map(function(k){ return k.id; }); } catch (e) { return ['unreadable']; } })(),
        old: localStorage.getItem('tau-remote-device'),
        cwd: document.getElementById('cwd').textContent,
      })`)
    const until = async (check: (v: View) => boolean, label: string, ms = 15_000): Promise<View> => {
      const stop = Date.now() + ms
      let last: View | undefined
      while (Date.now() < stop) {
        last = await view()
        if (check(last)) return last
        await sleep(100)
      }
      throw new Error(`timed out waiting for ${label}; page: ${JSON.stringify(last)}`)
    }
    const connected = (v: View): boolean => v.dot === 'dot ok'
    const onlyConnection = () => life.listConnections()[0]

    console.log(`phone page (${browserPath.split(/[\\/]/).pop()})`)
    let deviceId = ''
    let firstToken = ''

    await test('scanning the link connects, labelled for the terminal', async () => {
      const state = await life.turnOn('local')
      firstToken = state.token
      await p.go(state.url)
      const v = await until(connected, 'connected')
      assert(v.cwd === 'project', `header ${v.cwd}`)
      const c = onlyConnection()
      assert(c?.kind === 'link' && c.origin === origin, `connection ${JSON.stringify(c)}`)
      assert(/ · Chrome$|^Browser$|· Edge$/.test(c!.name), `label ${c!.name}`)
    })

    await test('Y stores the key, drops the token from the address bar, and says so', async () => {
      const outcome = await life.trustConnection(onlyConnection()!.id)
      assert(outcome.ok, `trust ${JSON.stringify(outcome)}`)
      deviceId = outcome.ok ? outcome.device.id : ''
      const v = await until(s => s.keys.length > 0, 'stored key')
      const key = await p.eval<string>(`JSON.parse(localStorage.getItem('tau-remote-keys'))[0].key`)
      assert(v.keys[0] === deviceId && /^[0-9a-f]{64}$/.test(key), 'stored id and key')
      assert(v.hash === '', `address still has ${v.hash}`)
      assert(v.banner.startsWith('Remembered'), `banner ${v.banner}`)
    })

    await test('Tau restarts: the open page reconnects by itself with its key', async () => {
      life.turnOff()
      await until(v => v.dot !== 'dot ok', 'disconnected')
      const state = await life.turnOn('local')
      assert(state.token !== firstToken, 'new session')
      // Don't sit out the backoff: coming back online reconnects at once.
      await p.eval(`window.dispatchEvent(new Event('online'))`)
      await until(connected, 'reconnected', 8000)
      const c = onlyConnection()
      assert(c?.kind === 'device' && c.deviceId === deviceId, `connection ${JSON.stringify(c)}`)
    })

    await test('a reload with no link at all still connects', async () => {
      await p.go(`${origin}/`)
      await until(connected, 'connected')
      assert(onlyConnection()?.kind === 'device', 'by key')
    })

    await test('a tab stopped on not-paired picks up keys saved in another tab via storage event', async () => {
      // Navigate to bare origin with no keys in storage
      await p.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' })
      await p.go(`${origin}/`)
      await until(v => v.banner.includes('not paired'), 'stopped on not paired')
      // Sibling tab pairs and writes the key
      const dev = (await import('./devices.js')).listDevices().find(d => d.id === deviceId)
      assert(dev, 'device exists')
      await p.eval(`
        localStorage.setItem('tau-remote-keys', JSON.stringify([{ id: '${dev.id}', key: '${dev.key}', name: 'Safari' }]));
        window.dispatchEvent(new StorageEvent('storage', { key: 'tau-remote-keys' }));
      `)
      await until(connected, 'connected via storage event')
    })

    await test('images load with the token a key sign-in receives', async () => {
      // 1x1 transparent PNG.
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
      const id = internImage('image/png', png)
      broadcast({ t: 'messages', messages: [{ kind: 'image', id }] })
      const end = Date.now() + 10_000
      let loaded = false
      while (!loaded && Date.now() < end) {
        loaded = await p.eval<boolean>(
          `(function(){ var i=document.querySelector('.shot img'); return !!i && i.complete && i.naturalWidth===1; })()`,
        )
        if (!loaded) await sleep(100)
      }
      if (!loaded) {
        // The error handler replaces the <img>; the request is still on record.
        const requested = await p.eval<string[]>(
          `performance.getEntriesByType('resource').map(function(e){return e.name}).filter(function(n){return n.indexOf('/img/')>=0})`,
        )
        const statuses = await Promise.all(requested.map(async url => `${url} -> ${(await fetch(url)).status}`))
        const html = await p.eval<string>(`(document.querySelector('.shot')||{}).outerHTML||'no .shot'`)
        throw new Error(
          `image did not load: ${statuses.join(', ') || 'never requested'}; ${html}; browser saw: ${p.imageLog.join(' | ')}`,
        )
      }
    })

    await test('forgotten while open: signed out, that key dropped, no retry loop', async () => {
      assert(await life.forgetDevice(deviceId), 'forgotten')
      const v = await until(s => s.banner.includes('forgot this phone'), 'forgotten banner')
      assert(v.keys.length === 0, 'key dropped')
      await sleep(2500)
      assert(life.listConnections().length === 0, 'did not come back')
    })

    await test('an old link is told it expired; no link and no key is told to pair', async () => {
      await p.go(`${origin}/#${firstToken}`)
      await until(v => v.banner.includes('link has expired'), 'expired banner')
      await p.go(`${origin}/`)
      await until(v => v.banner.includes('not paired'), 'not paired banner')
      await sleep(1500)
      assert(life.listConnections().length === 0, 'nothing connected')
    })

    await test('forgotten while away: told so on return; the key stays for other Tau installs', async () => {
      const state = getRemoteState()!
      await p.go(state.url)
      await until(connected, 'connected')
      const outcome = await life.trustConnection(onlyConnection()!.id)
      assert(outcome.ok, 'remembered again')
      await until(v => v.keys.length === 1, 'stored')
      life.turnOff()
      await until(v => v.dot !== 'dot ok', 'disconnected')
      // Forgotten in another window while this session is off.
      const { removeDevice } = await import('./devices.js')
      await removeDevice(outcome.ok ? outcome.device.id : '')
      await life.turnOn('local')
      await p.eval(`window.dispatchEvent(new Event('online'))`)
      const v = await until(s => s.banner.includes('does not remember this phone'), 'not remembered banner')
      assert(v.keys.length === 1, 'key kept: it was refused, not forgotten by this phone')
    })

    let aId = ''
    let bId = ''
    await test('two Tau installs taking turns on one address both keep the phone, no re-pairing', async () => {
      // Tau on Windows and Tau in WSL with mirrored networking: one address,
      // two separate lists. Here, two config folders on the same port.
      const swap = async (dir: string) => {
        life.turnOff()
        await until(v => v.dot !== 'dot ok', 'disconnected')
        process.env.CLAUDE_CONFIG_DIR = dir
        const state = await life.turnOn('local')
        await p.eval(`window.dispatchEvent(new Event('online'))`)
        return state
      }
      // Start with no keys on the phone, so only this test's keys count.
      life.turnOff()
      await p.send('Page.navigate', { url: 'about:blank' })
      await sleep(100)
      await p.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' })
      process.env.CLAUDE_CONFIG_DIR = join(root, 'config-a')
      const a = await life.turnOn('local')
      await p.go(a.url)
      await until(connected, 'A: in by its code')
      const keptA = await life.trustConnection(onlyConnection()!.id)
      assert(keptA.ok, 'A remembered the phone')
      aId = keptA.ok ? keptA.device.id : ''
      await until(v => v.keys.length === 1, 'A key stored')

      // B takes the address. It does not know the phone, and must not cost it A's key.
      const b = await swap(join(root, 'config-b'))
      let v = await until(s => s.banner.includes('does not remember this phone'), 'B refuses')
      assert(v.keys.join() === aId, `A key kept after B refused it: ${v.keys}`)
      await p.go(b.url)
      await until(connected, 'B: in by its code')
      const keptB = await life.trustConnection(onlyConnection()!.id)
      assert(keptB.ok, 'B remembered the phone')
      bId = keptB.ok ? keptB.device.id : ''
      v = await until(s => s.keys.length === 2, 'both keys stored')

      // From here on, neither needs a code: each finds the key it knows.
      await swap(join(root, 'config-a'))
      await until(connected, 'back on A with no code', 12_000)
      assert(onlyConnection()?.deviceId === aId, `A sign-in used ${onlyConnection()?.deviceId}`)
      await swap(join(root, 'config-b'))
      await until(connected, 'back on B with no code', 12_000)
      assert(onlyConnection()?.deviceId === bId, `B sign-in used ${onlyConnection()?.deviceId}`)
    })

    await test('a key saved by the older one-key page still signs in', async () => {
      const entry = await p.eval<string>(
        `JSON.stringify(JSON.parse(localStorage.getItem('tau-remote-keys')).filter(function(k){ return k.id === ${JSON.stringify(bId)}; })[0])`,
      )
      await p.send('Page.navigate', { url: 'about:blank' })
      await sleep(100)
      await p.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' })
      await p.go(`${origin}/`)
      await until(v => v.banner.includes('not paired'), 'empty storage is not paired')
      await p.eval(`localStorage.setItem('tau-remote-device', ${JSON.stringify(entry)})`)
      await p.go(`${origin}/`)
      const v = await until(connected, 'old-format key signs in')
      assert(v.keys.join() === bId && v.old === null, `moved into the list: ${JSON.stringify(v)}`)
    })
  } finally {
    life.turnOff()
    page?.close()
    browser?.kill()
    await sleep(500)
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
