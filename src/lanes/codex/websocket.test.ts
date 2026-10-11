/**
 * Responses WebSocket transport, against a local server.
 *
 * Run: bun run src/lanes/codex/websocket.test.ts
 */

import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'

import { CodexApiClient } from './api.js'
import { CodexResponsesSockets, CodexWebSocketHttpError, CodexWebSocketUnavailable } from './websocket.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

type Reply = (socket: ServerSocket, request: Record<string, unknown>, index: number) => void

/** A Responses WebSocket server; `reply` answers each response.create. */
async function withServer(
  reply: Reply,
  body: (url: string, seen: { connections: number; requests: Record<string, unknown>[]; headers: IncomingMessage['headers'][]; sockets: ServerSocket[] }) => Promise<void>,
  options: { refuseUpgrade?: number; sse?: boolean } = {},
): Promise<void> {
  const seen = { connections: 0, requests: [] as Record<string, unknown>[], headers: [] as IncomingMessage['headers'][], sockets: [] as ServerSocket[] }
  const http: Server = createServer((req, res) => {
    // The HTTP fallback: a plain Responses SSE answer.
    if (req.method === 'POST' && options.sse) {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        seen.requests.push(JSON.parse(raw))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end([
          'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":10}}}\n\n',
        ].join(''))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    if (options.refuseUpgrade) {
      // The client drops the connection as soon as it reads the refusal.
      socket.on('error', () => {})
      socket.end(`HTTP/1.1 ${options.refuseUpgrade} Refused\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      seen.connections++
      seen.headers.push(req.headers)
      seen.sockets.push(ws)
      ws.on('message', data => {
        const request = JSON.parse(data.toString()) as Record<string, unknown>
        seen.requests.push(request)
        reply(ws, request, seen.requests.length)
      })
    })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  try {
    await body(`http://127.0.0.1:${port}`, seen)
  } finally {
    for (const client of wss.clients) client.terminate()
    wss.close()
    await new Promise<void>(resolve => http.close(() => resolve()))
  }
}

const send = (ws: ServerSocket, event: Record<string, unknown>): void => ws.send(JSON.stringify(event))
const complete: Reply = (ws, _request, index) => {
  send(ws, { type: 'response.created', response: { id: `r${index}` } })
  send(ws, { type: 'response.output_text.delta', delta: 'hi' })
  send(ws, { type: 'response.completed', response: { id: `r${index}`, usage: { input_tokens: 100 } } })
}

async function drain(started: { first: { type: string }; rest: AsyncGenerator<{ type: string }> }): Promise<string[]> {
  const types = [started.first.type]
  for await (const event of started.rest) types.push(event.type)
  return types
}

async function main(): Promise<void> {
  console.log('\ncodex responses websocket')

  await test('requests stream their events and reuse one connection', async () => {
    await withServer(complete, async (url, seen) => {
      const sockets = new CodexResponsesSockets()
      const headers = { Authorization: 'Bearer t', session_id: 's1', 'Content-Type': 'application/json', Accept: 'text/event-stream' }
      const one = await drain(await sockets.start(`${url}/responses`, headers, { model: 'gpt-x', input: [] }, 's1'))
      const two = await drain(await sockets.start(`${url}/responses`, headers, { model: 'gpt-x', input: [] }, 's1'))
      sockets.closeAll()
      assert(JSON.stringify(one) === JSON.stringify(['response.created', 'response.output_text.delta', 'response.completed']), `events: ${one}`)
      assert(two.at(-1) === 'response.completed', `second: ${two}`)
      assert(seen.connections === 1, `connections: ${seen.connections}`)
      assert(seen.requests.every(r => r.type === 'response.create' && Array.isArray(r.include)), JSON.stringify(seen.requests))
      const h = seen.headers[0]!
      assert(h['openai-beta'] === 'responses_websockets=2026-02-06', `beta: ${h['openai-beta']}`)
      assert(h.authorization === 'Bearer t' && h.session_id === 's1', 'auth/session headers not carried')
    })
  })

  await test('each conversation gets its own connection', async () => {
    await withServer(complete, async (url, seen) => {
      const sockets = new CodexResponsesSockets()
      await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'main'))
      await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'agent'))
      await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'main'))
      sockets.closeAll()
      assert(seen.connections === 2, `connections: ${seen.connections}`)
    })
  })

  await test('a response cut short retires its connection', async () => {
    const pending: Reply = (ws, _request, index) => {
      send(ws, { type: 'response.created', response: { id: `r${index}` } })
      if (index > 1) send(ws, { type: 'response.completed', response: { id: `r${index}` } })
    }
    await withServer(pending, async (url, seen) => {
      const sockets = new CodexResponsesSockets()
      const started = await sockets.start(`${url}/responses`, {}, { input: [] }, 'k')
      await started.rest.return(undefined)
      const next = await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'k'))
      sockets.closeAll()
      assert(seen.connections === 2, `a cut-short connection was reused: ${seen.connections}`)
      assert(next.at(-1) === 'response.completed', `next: ${next}`)
    })
  })

  await test('a kept connection that drops before answering is replaced at once', async () => {
    const dropSecond: Reply = (ws, request, index) => {
      if (index === 2) {
        ws.terminate()
        return
      }
      complete(ws, request, index)
    }
    await withServer(dropSecond, async (url, seen) => {
      const sockets = new CodexResponsesSockets()
      await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'k'))
      const started = Date.now()
      const next = await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'k'))
      sockets.closeAll()
      assert(next.at(-1) === 'response.completed', `next: ${next}`)
      assert(seen.connections === 2 && seen.requests.length === 3, `connections ${seen.connections}, requests ${seen.requests.length}`)
      assert(Date.now() - started < 1500, `reconnect waited ${Date.now() - started} ms`)
    })
  })

  await test('a new login gets a new connection', async () => {
    await withServer(complete, async (url, seen) => {
      const sockets = new CodexResponsesSockets()
      await drain(await sockets.start(`${url}/responses`, { Authorization: 'Bearer old', 'ChatGPT-Account-ID': 'a1' }, { input: [] }, 'k'))
      await drain(await sockets.start(`${url}/responses`, { Authorization: 'Bearer new', 'ChatGPT-Account-ID': 'a2' }, { input: [] }, 'k'))
      sockets.closeAll()
      assert(seen.connections === 2, `connections: ${seen.connections}`)
      assert(seen.headers[1]?.authorization === 'Bearer new' && seen.headers[1]?.['chatgpt-account-id'] === 'a2', 'second handshake kept the old login')
    })
  })

  await test('a kept connection that went silent is not reused', async () => {
    await withServer(complete, async (url, seen) => {
      const sockets = new CodexResponsesSockets(150)
      await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'k'))
      await new Promise(resolve => setTimeout(resolve, 300))
      await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'k'))
      sockets.closeAll()
      assert(seen.connections === 2, `connections: ${seen.connections}`)
    })
  })

  await test('server pings keep an idle connection in use', async () => {
    await withServer(complete, async (url, seen) => {
      const sockets = new CodexResponsesSockets(150)
      await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'k'))
      const pinger = setInterval(() => { for (const client of seen.sockets) client.ping() }, 50)
      await new Promise(resolve => setTimeout(resolve, 300))
      clearInterval(pinger)
      await drain(await sockets.start(`${url}/responses`, {}, { input: [] }, 'k'))
      sockets.closeAll()
      assert(seen.connections === 1, `connections: ${seen.connections}`)
    })
  })

  await test('a reader that stops at the completed event keeps the connection', async () => {
    await withServer(complete, async (url, seen) => {
      const sockets = new CodexResponsesSockets()
      for (let i = 0; i < 2; i++) {
        const started = await sockets.start(`${url}/responses`, {}, { input: [] }, 'k')
        for await (const event of started.rest) if (event.type === 'response.completed') break
      }
      sockets.closeAll()
      assert(seen.connections === 1, `connections: ${seen.connections}`)
    })
  })

  await test('an error event with a status throws it like HTTP would', async () => {
    const limited: Reply = ws => send(ws, { type: 'error', status: 429, headers: { 'retry-after': '7' }, error: { type: 'usage_limit_reached', message: 'limit' } })
    await withServer(limited, async url => {
      const sockets = new CodexResponsesSockets()
      let caught: unknown
      try {
        await sockets.start(`${url}/responses`, {}, { input: [] }, 'k')
      } catch (error) {
        caught = error
      }
      sockets.closeAll()
      assert(caught instanceof CodexWebSocketHttpError && caught.status === 429, `got ${String(caught)}`)
      assert(caught.retryAfter === '7', `retry-after: ${caught.retryAfter}`)
      assert(caught.body === JSON.stringify({ error: { type: 'usage_limit_reached', message: 'limit' } }), `body: ${caught.body}`)
    })
  })

  await test('the 60-minute connection limit is a retryable reset', async () => {
    const expired: Reply = ws => send(ws, { type: 'error', error: { code: 'websocket_connection_limit_reached', message: 'limit' } })
    await withServer(expired, async url => {
      const sockets = new CodexResponsesSockets()
      let caught: unknown
      try {
        await sockets.start(`${url}/responses`, {}, { input: [] }, 'k')
      } catch (error) {
        caught = error
      }
      sockets.closeAll()
      assert((caught as { code?: string })?.code === 'ECONNRESET', `got ${String(caught)}`)
    })
  })

  await test('a connection closed mid-response is a retryable reset', async () => {
    const dropped: Reply = ws => {
      send(ws, { type: 'response.created', response: { id: 'r' } })
      setTimeout(() => ws.terminate(), 20)
    }
    await withServer(dropped, async url => {
      const sockets = new CodexResponsesSockets()
      const started = await sockets.start(`${url}/responses`, {}, { input: [] }, 'k')
      let caught: unknown
      try {
        await drain(started)
      } catch (error) {
        caught = error
      }
      sockets.closeAll()
      assert((caught as { code?: string })?.code === 'ECONNRESET', `got ${String(caught)}`)
    })
  })

  await test('a busy connection sends the next request elsewhere', async () => {
    const slow: Reply = (ws, _request, index) => {
      send(ws, { type: 'response.created', response: { id: `r${index}` } })
      setTimeout(() => send(ws, { type: 'response.completed', response: { id: `r${index}` } }), 100)
    }
    await withServer(slow, async url => {
      const sockets = new CodexResponsesSockets()
      const first = await sockets.start(`${url}/responses`, {}, { input: [] }, 'k')
      let caught: unknown
      try {
        await sockets.start(`${url}/responses`, {}, { input: [] }, 'k')
      } catch (error) {
        caught = error
      }
      await drain(first)
      sockets.closeAll()
      assert(caught instanceof CodexWebSocketUnavailable, `got ${String(caught)}`)
    })
  })

  await test('an abort mid-response stops it and retires the connection', async () => {
    const slow: Reply = (ws, _request, index) => send(ws, { type: 'response.created', response: { id: `r${index}` } })
    await withServer(slow, async (url, seen) => {
      const sockets = new CodexResponsesSockets()
      const controller = new AbortController()
      const started = await sockets.start(`${url}/responses`, {}, { input: [] }, 'k', controller.signal)
      setTimeout(() => controller.abort(), 20)
      let caught: unknown
      try {
        await drain(started)
      } catch (error) {
        caught = error
      }
      sockets.closeAll()
      assert((caught as Error)?.name === 'AbortError', `got ${String(caught)}`)
      assert(seen.connections === 1, 'unexpected reconnect')
    })
  })

  await test('an abort during the handshake sends nothing', async () => {
    await withServer(complete, async (url, seen) => {
      const sockets = new CodexResponsesSockets()
      const controller = new AbortController()
      const pending = sockets.start(`${url}/responses`, {}, { input: [] }, 'k', controller.signal)
      controller.abort()
      let caught: unknown
      try {
        await pending
      } catch (error) {
        caught = error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
      sockets.closeAll()
      assert((caught as Error)?.name === 'AbortError', `got ${String(caught)}`)
      assert(seen.requests.length === 0, `sent ${seen.requests.length} request(s)`)
    })
  })

  await test('a refused upgrade reports unavailable and switches the transport off', async () => {
    await withServer(complete, async url => {
      const sockets = new CodexResponsesSockets()
      let caught: unknown
      try {
        await sockets.start(`${url}/responses`, {}, { input: [] }, 'k')
      } catch (error) {
        caught = error
      }
      assert(caught instanceof CodexWebSocketUnavailable && caught.status === 426, `got ${String(caught)}`)
      assert(!sockets.available, 'still available after a refused upgrade')
    }, { refuseUpgrade: 426 })
  })

  await test('the Codex client streams over the socket with a ChatGPT login', async () => {
    await withServer(complete, async (url, seen) => {
      const client = new CodexApiClient()
      client.configure({ chatgptAccessToken: 'chatgpt-token', baseUrl: url })
      const types: string[] = []
      for await (const event of client.streamResponses({ model: 'gpt-x', input: [], prompt_cache_key: 'conv' } as never)) types.push(event.type)
      client.clearChain()
      assert(types.at(-1) === 'response.completed', `events: ${types}`)
      assert(seen.connections === 1 && seen.requests[0]?.type === 'response.create', 'did not go over the socket')
    })
  })

  await test('the Codex client falls back to HTTP when the upgrade is refused', async () => {
    await withServer(complete, async (url, seen) => {
      const client = new CodexApiClient()
      client.configure({ chatgptAccessToken: 'chatgpt-token', baseUrl: url })
      const types: string[] = []
      for await (const event of client.streamResponses({ model: 'gpt-x', input: [], prompt_cache_key: 'conv' } as never)) types.push(event.type)
      client.clearChain()
      assert(types.at(-1) === 'response.completed', `events: ${types}`)
      assert(seen.connections === 0 && seen.requests.length === 1 && seen.requests[0]?.type === undefined, 'did not fall back to HTTP')
    }, { refuseUpgrade: 426, sse: true })
  })

  await test('a context overflow over the socket still reads as prompt too long', async () => {
    const overflow: Reply = ws => send(ws, { type: 'error', status: 400, error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } })
    await withServer(overflow, async url => {
      const client = new CodexApiClient()
      client.configure({ chatgptAccessToken: 'chatgpt-token', baseUrl: url })
      let caught: unknown
      try {
        for await (const _event of client.streamResponses({ model: 'gpt-x', input: [], prompt_cache_key: 'conv' } as never)) { /* drain */ }
      } catch (error) {
        caught = error
      }
      client.clearChain()
      const error = caught as { status?: number; isPromptTooLong?: boolean }
      assert(error?.status === 400 && error.isPromptTooLong === true, `got ${String(caught)}`)
    })
  })

  await test('an API key keeps HTTP', async () => {
    await withServer(complete, async (url, seen) => {
      const client = new CodexApiClient()
      client.configure({ apiKey: 'sk-test', baseUrl: url })
      const types: string[] = []
      for await (const event of client.streamResponses({ model: 'gpt-x', input: [], prompt_cache_key: 'conv' } as never)) types.push(event.type)
      assert(seen.connections === 0 && types.at(-1) === 'response.completed', `connections ${seen.connections}, events ${types}`)
    }, { sse: true })
  })

  await test('TAU_CODEX_WEBSOCKET=0 keeps HTTP', async () => {
    process.env.TAU_CODEX_WEBSOCKET = '0'
    try {
      await withServer(complete, async (url, seen) => {
        const client = new CodexApiClient()
        client.configure({ chatgptAccessToken: 'chatgpt-token', baseUrl: url })
        for await (const _event of client.streamResponses({ model: 'gpt-x', input: [], prompt_cache_key: 'conv' } as never)) { /* drain */ }
        assert(seen.connections === 0 && seen.requests.length === 1, `connections ${seen.connections}`)
      }, { sse: true })
    } finally {
      delete process.env.TAU_CODEX_WEBSOCKET
    }
  })
}

await main()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
