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

// Each load is a fresh module instance with its own bookkeeping.
function load(result) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  return module.exports
}

async function withServer(fn) {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => res.end('ok'))
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
