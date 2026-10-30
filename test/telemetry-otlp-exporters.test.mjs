// OpenTelemetry export through the shipped bundle: real exporters send to local
// collectors. Telemetry providers are process-wide, so each case gets a process.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttp2Server } from 'node:http2'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { getNodeRuntimeIssue } from '../scripts/node-runtime.mjs'

// On these Node versions a process can die in shutdown after its work is done.
const exitMayCrash = getNodeRuntimeIssue(process.versions.node) === 'windows-shutdown'
const repositoryRoot = process.cwd()
const bundle = process.env.TAU_MCP_TEST_BUNDLE ?? resolve('dist/tau.mjs')
const helperUrl = new URL('./helpers/mcp-built-runtime.mjs', import.meta.url).href
const root = mkdtempSync(join(tmpdir(), 'tau telemetry é-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

let caseNumber = 0

function runInProcess(source, env) {
  const childEnv = { ...process.env }
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('OTEL_') || key === 'DISABLE_TELEMETRY') delete childEnv[key]
  }
  Object.assign(childEnv, {
    TAU_MCP_TEST_BUNDLE: bundle,
    CLAUDE_CONFIG_DIR: join(root, `config-${caseNumber++}`),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...env,
  })
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repositoryRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => {
      stdout += data
    })
    child.stderr.on('data', data => {
      stderr += data
    })
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error(`timed out\nstdout: ${stdout.slice(-400)}\nstderr: ${stderr.slice(-400)}`))
    }, 90_000)
    child.on('exit', code => {
      clearTimeout(timer)
      if ((code === 0 || exitMayCrash) && stdout.includes('TAU_TEST_DONE')) done({ stdout, stderr })
      else fail(new Error(`exit ${code}\nstdout: ${stdout.slice(-400)}\nstderr: ${stderr.slice(-800)}`))
    })
  })
}

// One metric and one log (and a span when tracing), then flush everything.
const emitTelemetry = `
  import { trace } from '@opentelemetry/api'
  import { logs } from '@opentelemetry/api-logs'
  import { loadMcpRuntime } from ${JSON.stringify(helperUrl)}
  const runtime = await loadMcpRuntime({
    paths: ['src/utils/telemetry/instrumentation.ts'],
    exports: ['initializeTelemetry', 'getMeterProvider', 'getLoggerProvider', 'getTracerProvider'],
  })
  const meter = await runtime.initializeTelemetry()
  meter.createCounter('tau_test_counter').add(1)
  if (process.env.TAU_TEST_BETA_TRACING) {
    for (let i = 0; i < 100 && !runtime.getTracerProvider(); i++) {
      await new Promise(done => setTimeout(done, 50))
    }
    trace.getTracer('tau-test').startSpan('tau-test-span').end()
  }
  logs.getLogger('tau-test').emit({ body: 'tau-test-log', attributes: { a: 1 } })
  await runtime.getMeterProvider()?.forceFlush()
  await runtime.getLoggerProvider()?.forceFlush()
  await runtime.getTracerProvider()?.forceFlush()
  if (process.env.TAU_TEST_SCRAPE_URL) {
    console.log(await (await fetch(process.env.TAU_TEST_SCRAPE_URL)).text())
  }
  console.log('TAU_TEST_DONE')
  process.exit(0)
`

async function withHttpCollector(fn) {
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('latin1')
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => {
      seen.push({ path: request.url, contentType: request.headers['content-type'], body })
      response.writeHead(200, { 'content-type': request.headers['content-type'] ?? 'application/json' })
      response.end()
    })
  }).listen(0, '127.0.0.1')
  await new Promise(done => server.once('listening', done))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen)
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

const otlpEnv = endpoint => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
})

for (const [protocol, contentType] of [
  ['http/json', /json/],
  ['http/protobuf', /protobuf/],
]) {
  test(`OTLP ${protocol} delivers metrics and logs`, () =>
    withHttpCollector(async (endpoint, seen) => {
      await runInProcess(emitTelemetry, { ...otlpEnv(endpoint), OTEL_EXPORTER_OTLP_PROTOCOL: protocol })
      const paths = seen.map(request => request.path)
      assert.ok(paths.includes('/v1/metrics'), `requests: ${paths}`)
      assert.ok(paths.includes('/v1/logs'), `requests: ${paths}`)
      for (const request of seen) assert.match(request.contentType, contentType)
      const metrics = seen.find(request => request.path === '/v1/metrics')
      const logs = seen.find(request => request.path === '/v1/logs')
      assert.ok(metrics.body.includes('tau_test_counter'))
      assert.ok(logs.body.includes('tau-test-log'))
    }))
}

test('OTLP gRPC delivers metrics and logs', async () => {
  const paths = []
  const server = createHttp2Server()
  server.on('stream', (stream, headers) => {
    paths.push(headers[':path'])
    stream.on('data', () => {})
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
      // An empty protobuf message in gRPC framing.
      stream.end(Buffer.from([0, 0, 0, 0, 0]))
    })
  })
  server.listen(0, '127.0.0.1')
  await new Promise(done => server.once('listening', done))
  try {
    await runInProcess(emitTelemetry, {
      ...otlpEnv(`http://127.0.0.1:${server.address().port}`),
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    })
  } finally {
    server.close()
  }
  assert.ok(paths.some(path => path.endsWith('MetricsService/Export')), `requests: ${paths}`)
  assert.ok(paths.some(path => path.endsWith('LogsService/Export')), `requests: ${paths}`)
})

test('beta tracing delivers spans and logs', () =>
  withHttpCollector(async (endpoint, seen) => {
    await runInProcess(emitTelemetry, {
      ENABLE_BETA_TRACING_DETAILED: '1',
      BETA_TRACING_ENDPOINT: endpoint,
      TAU_TEST_BETA_TRACING: '1',
    })
    const paths = seen.map(request => request.path)
    assert.ok(paths.includes('/v1/traces'), `requests: ${paths}`)
    assert.ok(paths.includes('/v1/logs'), `requests: ${paths}`)
    assert.ok(seen.find(request => request.path === '/v1/traces').body.includes('tau-test-span'))
  }))

test('Prometheus serves the metrics', async () => {
  const port = await new Promise(done => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address()
      probe.close(() => done(free))
    })
  })
  const { stdout } = await runInProcess(emitTelemetry, {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'prometheus',
    OTEL_EXPORTER_PROMETHEUS_HOST: '127.0.0.1',
    OTEL_EXPORTER_PROMETHEUS_PORT: String(port),
    TAU_TEST_SCRAPE_URL: `http://127.0.0.1:${port}/metrics`,
  })
  assert.match(stdout, /tau_test_counter/)
})

test('console exporters print metrics and logs', async () => {
  const { stdout } = await runInProcess(emitTelemetry, {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'console',
    OTEL_LOGS_EXPORTER: 'console',
  })
  assert.match(stdout, /tau_test_counter/)
  assert.match(stdout, /tau-test-log/)
})

test('first-party event logging still reads log records', () =>
  withHttpCollector(async (endpoint, seen) => {
    await runInProcess(
      `
      import { loadMcpRuntime } from ${JSON.stringify(helperUrl)}
      const runtime = await loadMcpRuntime({
        paths: ['src/services/analytics/firstPartyEventLogger.ts'],
        exports: ['initialize1PEventLogging', 'logEventTo1P', 'shutdown1PEventLogging', 'is1PEventLoggingEnabled'],
        // The endpoint normally comes from remote config.
        transform: source => {
          const target = 'const batchConfig = getBatchConfig();'
          if (!source.includes(target)) throw new Error('batch config call not found')
          return source.replace(target, 'const batchConfig = { baseUrl: process.env.TAU_TEST_EVENT_URL, path: "/events", skipAuth: true, scheduledDelayMillis: 50 };')
        },
      })
      if (!runtime.is1PEventLoggingEnabled()) throw new Error('first-party logging is disabled in this environment')
      runtime.initialize1PEventLogging()
      runtime.logEventTo1P('tau_test_event', {})
      for (let i = 0; i < 40; i++) await new Promise(done => setTimeout(done, 50))
      await runtime.shutdown1PEventLogging()
      console.log('TAU_TEST_DONE')
      process.exit(0)
      `,
      // First-party logging is off when nonessential traffic is. The endpoint
      // above is local, so nothing leaves this machine.
      { TAU_TEST_EVENT_URL: endpoint, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' },
    )
    const events = seen.filter(request => request.path === '/events')
    assert.ok(events.length > 0, `requests: ${seen.map(request => request.path)}`)
    assert.ok(events.some(request => request.body.includes('tau_test_event')))
  }))
