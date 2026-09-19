import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

// Node's fetch (undici) is what publishes the diagnostics channels the
// connection observer reads; Bun's fetch does not, so these run under node.
const connectionBundle = await build({
  entryPoints: ['src/lanes/gemini/antigravity_connection.ts'],
  bundle: true,
  packages: 'external',
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
})

const keepAliveBundle = await build({
  entryPoints: ['src/lanes/gemini/antigravity_keepalive.ts'],
  bundle: true,
  packages: 'external',
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
})

// Each load is a fresh module instance with its own bookkeeping.
function load(result) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  return module.exports
}

async function withServer(fn, handler = (req, res) => res.end('ok')) {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => handler(req, res))
  })
  // No Keep-Alive hint and no server-side idle close: the client decides.
  server.keepAliveTimeout = 0
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/v1internal:streamGenerateContent`
  try {
    await fn(url, server)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

const post = (url, init = {}) => fetch(url, { method: 'POST', body: '{}', ...init }).then(response => response.text())
// undici's pool frees a finished client on a later tick; a request sent in the
// same tick opens a second socket instead. Real traffic sees both.
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

test('a probed fetch reports its own connection: new, then reused', async () => {
  const connection = load(connectionBundle)
  connection.observeAntigravityConnections()
  await withServer(async url => {
    const first = { claimed: false }
    await connection.withAntigravityConnectionProbe(first, () => post(url))
    assert.equal(first.claimed, true)
    assert.equal(first.connection.reuse, 'new')
    assert.equal(first.connection.priorRequests, 0)
    assert.equal(first.connection.remoteAddress, '127.0.0.1')
    assert.equal(first.connection.socketIdleMs, undefined)

    // An unprobed request on the same socket still counts toward its history.
    await settle()
    await post(url)
    await settle()

    const third = { claimed: false }
    await connection.withAntigravityConnectionProbe(third, () => post(url))
    assert.equal(third.connection.id, first.connection.id, 'keep-alive socket was not reused')
    assert.equal(third.connection.reuse, 'reused')
    assert.equal(third.connection.priorRequests, 2)
    assert.ok(third.connection.socketIdleMs >= 40 && third.connection.socketIdleMs < 2000, `idle ${third.connection.socketIdleMs}`)
    assert.ok(third.connection.socketAgeMs >= third.connection.socketIdleMs)
  })
})

test('concurrent probed fetches are told apart', async () => {
  const connection = load(connectionBundle)
  connection.observeAntigravityConnections()
  await withServer(async url => {
    const a = { claimed: false }
    const b = { claimed: false }
    await Promise.all([
      connection.withAntigravityConnectionProbe(a, () => post(url)),
      connection.withAntigravityConnectionProbe(b, () => post(url)),
    ])
    assert.ok(a.connection && b.connection)
    assert.notEqual(a.connection.id, b.connection.id, 'two in-flight requests cannot share an HTTP/1.1 socket')
  })
})

test('a socket opened before observation began reports unknown reuse', async () => {
  await withServer(async url => {
    await post(url)
    await settle()
    const late = load(connectionBundle)
    late.observeAntigravityConnections()
    const probe = { claimed: false }
    await late.withAntigravityConnectionProbe(probe, () => post(url))
    assert.equal(probe.connection.reuse, 'unknown', 'history before observation must not be guessed')
  })
})

// ── Keep-alive experiment (TAU_ANTIGRAVITY_KEEPALIVE=1) ──

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('after a 6.5 s pause the keep-alive dispatcher reuses its connection; the default one reconnects', async () => {
  const connection = load(connectionBundle)
  connection.observeAntigravityConnections()
  const keepAlive = load(keepAliveBundle)
  const choice = keepAlive.chooseAntigravityKeepAlive({ proxied: false, runtime: 'node' })
  assert.equal(choice.effective, 'keepalive')
  assert.match(choice.undici, /^7\./)
  const pauseThenPost = async (url, dispatcher) => {
    const first = { claimed: false }
    const second = { claimed: false }
    await connection.withAntigravityConnectionProbe(first, () => post(url, dispatcher ? { dispatcher } : {}))
    await sleep(6500)
    await connection.withAntigravityConnectionProbe(second, () => post(url, dispatcher ? { dispatcher } : {}))
    return [first.connection, second.connection]
  }
  try {
    // Both arms at once, each against its own server with no keep-alive hint.
    const [[baseA, baseB], [keptA, keptB]] = await Promise.all([
      new Promise((resolve, reject) => withServer(url => pauseThenPost(url).then(resolve), undefined).catch(reject)),
      new Promise((resolve, reject) => withServer(url => pauseThenPost(url, choice.dispatcher).then(resolve), undefined).catch(reject)),
    ])
    assert.notEqual(baseB.id, baseA.id, 'the default dispatcher kept an idle socket past its 4 s timeout')
    assert.equal(baseB.reuse, 'new')
    assert.equal(keptB.id, keptA.id, 'the keep-alive dispatcher did not reuse its connection')
    assert.equal(keptB.reuse, 'reused')
    assert.ok(keptB.socketIdleMs >= 6000, `idle ${keptB.socketIdleMs}`)
  } finally {
    await keepAlive.closeAntigravityKeepAlive()
  }
})

test('one long-lived dispatcher, no cap on concurrent connections', async () => {
  const connection = load(connectionBundle)
  connection.observeAntigravityConnections()
  const keepAlive = load(keepAliveBundle)
  const inputs = { proxied: false, runtime: 'node' }
  const { dispatcher } = keepAlive.chooseAntigravityKeepAlive(inputs)
  assert.equal(keepAlive.chooseAntigravityKeepAlive(inputs).dispatcher, dispatcher, 'a dispatcher was built per request')
  try {
    await withServer(async url => {
      const probes = [{ claimed: false }, { claimed: false }, { claimed: false }]
      const bodies = await Promise.all(probes.map(p => connection.withAntigravityConnectionProbe(p, () => post(url, { dispatcher }))))
      assert.deepEqual(bodies, ['ok', 'ok', 'ok'])
      assert.equal(new Set(probes.map(p => p.connection.id)).size, 3, 'concurrent requests were serialized onto one connection')
    })
  } finally {
    await keepAlive.closeAntigravityKeepAlive()
  }
})

test('cancelling a stream mid-body releases its socket and leaves the dispatcher usable', async () => {
  const keepAlive = load(keepAliveBundle)
  const { dispatcher } = keepAlive.chooseAntigravityKeepAlive({ proxied: false, runtime: 'node' })
  const closed = []
  const slow = (req, res) => {
    if (req.url.endsWith('/slow')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"response":{}}\n\n')
      req.socket.on('close', () => closed.push(Date.now()))
      return // never ends on its own
    }
    res.end('ok')
  }
  try {
    await withServer(async url => {
      const controller = new AbortController()
      const response = await fetch(`${url}/slow`, { method: 'POST', body: '{}', dispatcher, signal: controller.signal })
      const reader = response.body.getReader()
      await reader.read()
      controller.abort()
      await assert.rejects(reader.read(), error => error.name === 'AbortError')
      await sleep(200)
      assert.equal(closed.length, 1, 'the aborted request kept its socket open')
      assert.equal(await post(url, { dispatcher }), 'ok')
    }, slow)
  } finally {
    await keepAlive.closeAntigravityKeepAlive()
  }
})

test('proxy and Bun are reported as skipped; custom TLS material is passed through unchanged', () => {
  const keepAlive = load(keepAliveBundle)
  const built = []
  const fakeUndici = () => ({
    module: { Agent: class { constructor(options) { built.push(options) } close() { return Promise.resolve() } } },
    version: '7.0.0-test',
  })
  assert.deepEqual(keepAlive.chooseAntigravityKeepAlive({ proxied: true, runtime: 'node' }, fakeUndici), { effective: 'baseline', skipped: 'proxy' })
  assert.deepEqual(keepAlive.chooseAntigravityKeepAlive({ proxied: false, runtime: 'bun' }, fakeUndici), { effective: 'baseline', skipped: 'bun-runtime' })
  assert.deepEqual(keepAlive.chooseAntigravityKeepAlive({ proxied: false, runtime: 'node' }, () => { throw new Error('missing') }), { effective: 'baseline', skipped: 'undici-unavailable' })
  assert.equal(built.length, 0)

  const tls = { cert: 'CERT', key: 'KEY', passphrase: 'PASS', ca: ['CA1', 'CA2'] }
  const choice = keepAlive.chooseAntigravityKeepAlive({ proxied: false, runtime: 'node', tls }, fakeUndici)
  assert.equal(choice.undici, '7.0.0-test')
  // The options utils/mtls.ts gives the default dispatcher, plus the idle keep-alive.
  assert.deepEqual(built, [{ keepAliveTimeout: 60_000, connect: { cert: 'CERT', key: 'KEY', passphrase: 'PASS', ca: ['CA1', 'CA2'] }, pipelining: 1 }])
  keepAlive.chooseAntigravityKeepAlive({ proxied: false, runtime: 'node', tls: { ...tls, ca: ['CA1', 'CA2'] } }, fakeUndici)
  assert.equal(built.length, 1, 'equal TLS material must reuse the dispatcher')
  keepAlive.chooseAntigravityKeepAlive({ proxied: false, runtime: 'node' }, fakeUndici)
  assert.deepEqual(built[1], { keepAliveTimeout: 60_000 }, 'without custom TLS every other option is the default')
})

test('a TLS change builds a new dispatcher and closes the old one only after its stream ends', async () => {
  const keepAlive = load(keepAliveBundle)
  const old = keepAlive.chooseAntigravityKeepAlive({ proxied: false, runtime: 'node' }).dispatcher
  let finish
  const held = (req, res) => {
    res.writeHead(200)
    res.write('first,')
    finish = () => res.end('last')
  }
  try {
    await withServer(async url => {
      const response = await fetch(url, { method: 'POST', body: '{}', dispatcher: old })
      const replacement = keepAlive.chooseAntigravityKeepAlive({ proxied: false, runtime: 'node', tls: { ca: 'NEW-CA' } }).dispatcher
      assert.notEqual(replacement, old)
      await sleep(100)
      assert.equal(old.closed, true, 'the old pool was not asked to close')
      assert.equal(old.destroyed, false, 'closing the old pool destroyed an active stream')
      finish()
      assert.equal(await response.text(), 'first,last', 'the active stream was cut off')
    }, held)
  } finally {
    await keepAlive.closeAntigravityKeepAlive()
  }
})

test('keep-alive is on unless TAU_ANTIGRAVITY_KEEPALIVE is 0, false, no or off', () => {
  const keepAlive = load(keepAliveBundle)
  const saved = process.env.TAU_ANTIGRAVITY_KEEPALIVE
  try {
    delete process.env.TAU_ANTIGRAVITY_KEEPALIVE
    assert.equal(keepAlive.antigravityKeepAliveRequested(), true)
    for (const on of ['1', 'true', 'yes']) {
      process.env.TAU_ANTIGRAVITY_KEEPALIVE = on
      assert.equal(keepAlive.antigravityKeepAliveRequested(), true, on)
    }
    for (const off of ['0', 'false', 'no', 'off', ' OFF ']) {
      process.env.TAU_ANTIGRAVITY_KEEPALIVE = off
      assert.equal(keepAlive.antigravityKeepAliveRequested(), false, off)
    }
  } finally {
    if (saved === undefined) delete process.env.TAU_ANTIGRAVITY_KEEPALIVE
    else process.env.TAU_ANTIGRAVITY_KEEPALIVE = saved
  }
})
