// Stdio MCP server for the MCP-instructions E2E (test/mcp-instructions/run.mjs).
// Real JSON-RPC over stdin/stdout, so tau's production client, handshake and
// tool listing are what the test exercises.
//
//   FX_NAME        server name reported in `initialize`
//   FX_DELAY_MS    wait this long before answering `initialize` (connects late)
//   FX_INSTR_FILE  InitializeResult.instructions, read from this file when the
//                  process starts, so a reconnect (new process) reads it again
//   FX_CALL_LOG    every tools/call is appended here (server, tool, arguments),
//                  so a run can see whether the model followed the instructions
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const NAME = process.env.FX_NAME ?? 'fixture'
if (process.env.FX_START_LOG) {
  appendFileSync(process.env.FX_START_LOG, JSON.stringify({ server: NAME, pid: process.pid }) + '\n')
}
const DELAY = Number(process.env.FX_DELAY_MS ?? 0)
let instructions = ''
try {
  if (process.env.FX_INSTR_FILE) instructions = readFileSync(process.env.FX_INSTR_FILE, 'utf8').trim()
} catch {}

const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const rl = createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
rl.on('line', async line => {
  let req
  try { req = JSON.parse(line) } catch { return }
  const { id, method, params } = req
  if (id === undefined) return
  switch (method) {
    case 'initialize':
      if (process.env.FX_RELEASE_FILE || process.env.FX_WAIT_REQUEST_LOG) {
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          if (process.env.FX_RELEASE_FILE && existsSync(process.env.FX_RELEASE_FILE)) break
          if (process.env.FX_WAIT_REQUEST_LOG) {
            try {
              if (readFileSync(process.env.FX_WAIT_REQUEST_LOG, 'utf8').split('\n').some(line => {
                try { const event = JSON.parse(line); return event.kind === 'req' && event.main } catch { return false }
              })) break
            } catch {}
          }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      if (DELAY > 0) await new Promise(r => setTimeout(r, DELAY))
      return send({ id, result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: '1.0.0' },
        ...(instructions && { instructions }),
      } })
    case 'tools/list':
      if (process.env.FX_RELEASE_FILE) writeFileSync(`${process.env.FX_RELEASE_FILE}.ready`, '')
      return send({ id, result: { tools: [{
        name: 'probe',
        description: `Check that the ${NAME} server is reachable. Returns a short status line.`,
        inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'Any short text' } } },
      }] } })
    case 'tools/call':
      if (process.env.FX_CALL_LOG) {
        appendFileSync(process.env.FX_CALL_LOG, JSON.stringify({ t: Date.now(), server: NAME, tool: params?.name, args: params?.arguments ?? {} }) + '\n')
      }
      return send({ id, result: { content: [{ type: 'text', text: `${NAME}: reachable` }] } })
    case 'ping':
      return send({ id, result: {} })
    default:
      return send({ id, error: { code: -32601, message: `no method ${method}` } })
  }
})
