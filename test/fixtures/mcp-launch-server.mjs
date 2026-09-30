// Dependency-free protocol fixture: observes the argv/env actually delivered
// by Tau's production transport, rather than testing a copy of its launcher.
import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin })
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params.protocolVersion,
        serverInfo: { name: 'launch-fixture', version: '1.0.0' },
        capabilities: { tools: {} },
      }
      break
    case 'tools/list':
      result = { tools: [{ name: 'inspect', description: 'Read launch arguments', inputSchema: { type: 'object' } }] }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(), value: process.env.MCP_LAUNCH_FIXTURE,
      }) }] }
      break
    case 'ping': result = {}; break
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n')
      return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})
