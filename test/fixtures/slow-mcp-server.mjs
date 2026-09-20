// A fixture MCP server over stdio, for the launch-barrier and discovery
// tests. Real JSON-RPC on stdin/stdout — not a mock of Tau's client — so the
// tests exercise the production transport, handshake and list paths.
//
// Behaviour is set by env vars:
//
//   FIXTURE_CONNECT_DELAY_MS  wait this long before answering `initialize`
//   FIXTURE_LIST_DELAY_MS     wait this long before answering `tools/list`
//   FIXTURE_TOOL_COUNT        how many tools to publish (default 2)
//   FIXTURE_PAGE_SIZE         tools per `tools/list` page (default: all)
//   FIXTURE_LIST_FAILS        `tools/list` returns a JSON-RPC error
//   FIXTURE_NAME              server name reported in `initialize`

import { createInterface } from 'node:readline'

const delay = ms => new Promise(r => setTimeout(r, ms))
const num = (name, fallback) => {
  const raw = process.env[name]
  const parsed = Number(raw)
  return raw === undefined || !Number.isFinite(parsed) ? fallback : parsed
}

const CONNECT_DELAY_MS = num('FIXTURE_CONNECT_DELAY_MS', 0)
const LIST_DELAY_MS = num('FIXTURE_LIST_DELAY_MS', 0)
const TOOL_COUNT = num('FIXTURE_TOOL_COUNT', 2)
const PAGE_SIZE = num('FIXTURE_PAGE_SIZE', TOOL_COUNT || 1)
const LIST_FAILS = process.env.FIXTURE_LIST_FAILS === '1'
const NAME = process.env.FIXTURE_NAME ?? 'slow-fixture'

const tools = Array.from({ length: TOOL_COUNT }, (_, i) => ({
  name: `tool_${i}`,
  description: `Fixture tool ${i}`,
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
}))

const send = message => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

const rl = createInterface({ input: process.stdin })
// Exit when the client closes the pipe, so a test that finishes without
// closing every client still lets the runner exit.
rl.on('close', () => process.exit(0))
rl.on('line', async line => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = request
  // A notification carries no id and expects no reply.
  if (id === undefined) return

  switch (method) {
    case 'initialize': {
      if (CONNECT_DELAY_MS > 0) await delay(CONNECT_DELAY_MS)
      send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: '1.0.0' },
        },
      })
      return
    }
    case 'tools/list': {
      if (LIST_DELAY_MS > 0) await delay(LIST_DELAY_MS)
      if (LIST_FAILS) {
        send({ id, error: { code: -32603, message: 'fixture list failure' } })
        return
      }
      const start = params?.cursor === undefined ? 0 : Number(params.cursor)
      const page = tools.slice(start, start + PAGE_SIZE)
      const next = start + PAGE_SIZE
      send({
        id,
        result: {
          tools: page,
          ...(next < tools.length ? { nextCursor: String(next) } : {}),
        },
      })
      return
    }
    case 'tools/call': {
      send({
        id,
        result: { content: [{ type: 'text', text: 'fixture result' }] },
      })
      return
    }
    default: {
      send({ id, error: { code: -32601, message: `no method ${method}` } })
    }
  }
})
