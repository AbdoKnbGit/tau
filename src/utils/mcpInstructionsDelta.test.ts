/**
 * Run: bun run src/utils/mcpInstructionsDelta.test.ts
 *
 * MCP server instructions reach the model as announcements appended to the
 * conversation. The diff decides what to announce from what the history
 * already says, so it must notice every change a reconnect can make (new
 * text, no text, still reconnecting), and it must only announce servers the
 * request can actually use.
 */

import type { MCPServerConnection } from '../services/mcp/types.js'
import type { Message } from '../types/message.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
  mcpServersForTools,
  type McpInstructionsDelta,
} from './mcpInstructionsDelta.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function same(actual: unknown, expected: unknown, hint: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${hint}: expected ${e}, got ${a}`)
}

const connected = (
  name: string,
  instructions?: string,
  capabilities: Record<string, unknown> = { tools: {} },
): MCPServerConnection =>
  ({
    type: 'connected',
    name,
    instructions,
    capabilities,
    client: {},
    config: {},
    cleanup: async () => {},
  }) as unknown as MCPServerConnection
const withState = (
  type: 'pending' | 'failed' | 'needs-auth' | 'disabled',
  name: string,
): MCPServerConnection => ({ type, name, config: {} }) as unknown as MCPServerConnection

/** The history a conversation carries after announcing `delta`. */
const told = (delta: McpInstructionsDelta | null): Message[] =>
  delta
    ? [
        {
          type: 'attachment',
          attachment: { type: 'mcp_instructions_delta', ...delta },
        } as unknown as Message,
      ]
    : []

const block = (name: string, text: string) => `## ${name}\n${text}`

console.log('mcp instructions delta:')

test('announces each connected server with instructions once, by name', () => {
  const d = getMcpInstructionsDelta(
    [connected('vault', 'Read conventions first.'), connected('b', 'Use b.'), connected('plain')],
    [],
    [],
  )
  same(d?.addedNames, ['b', 'vault'], 'names')
  same(d?.addedBlocks, [block('b', 'Use b.'), block('vault', 'Read conventions first.')], 'blocks')
  assert(d?.updatedNames === undefined, 'nothing is an update on first sight')
  same(d?.removedNames, [], 'nothing removed')
})

test('says nothing when the history already matches', () => {
  const clients = [connected('vault', 'v1')]
  const first = getMcpInstructionsDelta(clients, [], [])
  same(getMcpInstructionsDelta(clients, told(first), []), null, 'no delta')
})

test('a server that connects later is announced alone', () => {
  const first = getMcpInstructionsDelta([connected('a', 'A')], [], [])
  const d = getMcpInstructionsDelta([connected('a', 'A'), connected('late', 'L')], told(first), [])
  same(d?.addedNames, ['late'], 'only the late server')
  same(d?.removedNames, [], 'nothing removed')
})

test('a reconnect that changed the instructions between scans is an update', () => {
  const first = getMcpInstructionsDelta([connected('vault', 'old rules')], [], [])
  const d = getMcpInstructionsDelta([connected('vault', 'new rules')], told(first), [])
  same(d?.addedNames, ['vault'], 'announced again')
  same(d?.addedBlocks, [block('vault', 'new rules')], 'with the new text')
  same(d?.updatedNames, ['vault'], 'marked as replacing the earlier block')
})

test('a reconnect that dropped the instructions retracts them', () => {
  const first = getMcpInstructionsDelta([connected('vault', 'rules')], [], [])
  const d = getMcpInstructionsDelta([connected('vault')], told(first), [])
  same(d?.addedNames, [], 'nothing added')
  same(d?.removedNames, ['vault'], 'earlier instructions retracted')
})

test('a server that is reconnecting keeps its announcement', () => {
  const first = getMcpInstructionsDelta([connected('vault', 'rules')], [], [])
  same(getMcpInstructionsDelta([withState('pending', 'vault')], told(first), []), null, 'no churn')
})

test('a failed, unauthenticated, disabled or missing server is retracted', () => {
  for (const state of ['failed', 'needs-auth', 'disabled'] as const) {
    const first = getMcpInstructionsDelta([connected('s', 'rules')], [], [])
    const d = getMcpInstructionsDelta([withState(state, 's')], told(first), [])
    same(d?.removedNames, ['s'], state)
  }
  const first = getMcpInstructionsDelta([connected('s', 'rules')], [], [])
  same(getMcpInstructionsDelta([], told(first), [])?.removedNames, ['s'], 'missing')
})

test('a server back after a retraction is new again, not an update', () => {
  const first = getMcpInstructionsDelta([connected('s', 'rules')], [], [])
  const gone = getMcpInstructionsDelta([withState('failed', 's')], told(first), [])
  const d = getMcpInstructionsDelta([connected('s', 'rules')], [...told(first), ...told(gone)], [])
  same(d?.addedNames, ['s'], 'announced')
  assert(d?.updatedNames === undefined, 'not an update')
})

test('the latest announcement is what the next scan compares against', () => {
  const first = getMcpInstructionsDelta([connected('s', 'v1')], [], [])
  const second = getMcpInstructionsDelta([connected('s', 'v2')], told(first), [])
  const history = [...told(first), ...told(second)]
  same(getMcpInstructionsDelta([connected('s', 'v2')], history, []), null, 'v2 already told')
  same(getMcpInstructionsDelta([connected('s', 'v1')], history, [])?.updatedNames, ['s'], 'v1 is a change')
})

test('a client-side block that changes is an update to that server', () => {
  const first = getMcpInstructionsDelta([connected('chrome')], [], [{ serverName: 'chrome', block: 'hint' }])
  same(first?.addedBlocks, [block('chrome', 'hint')], 'client-side only')
  const d = getMcpInstructionsDelta([connected('chrome')], told(first), [])
  same(d?.removedNames, ['chrome'], 'hint withdrawn')
})

console.log('servers for a request:')

const tool = (name: string, serverName?: string) =>
  serverName ? { name, mcpInfo: { serverName } } : { name }

test('only servers with a tool in the request count', () => {
  const clients = [connected('a', 'A'), connected('b', 'B')]
  same(
    mcpServersForTools(clients, [tool('Read'), tool('mcp__a__probe', 'a')]).map(c => c.name),
    ['a'],
    'b has no tool here',
  )
  same(mcpServersForTools(clients, [tool('Read')]), [], 'no MCP tool, no server')
})

test('a resource-only server counts when the request can read resources', () => {
  const docs = connected('docs', 'D', { resources: {} })
  same(mcpServersForTools([docs], [tool('ListMcpResourcesTool')]).map(c => c.name), ['docs'], 'readable')
  same(mcpServersForTools([docs], [tool('ReadMcpResourceTool')]).map(c => c.name), ['docs'], 'readable without listing')
  same(mcpServersForTools([docs], [tool('Read')]), [], 'not readable')
  same(
    mcpServersForTools([connected('toolsOnly', 'T')], [tool('ListMcpResourcesTool')]),
    [],
    'resource tools do not make a tools-only server usable',
  )
})

test('reconnecting servers pass through, failed ones do not', () => {
  const names = mcpServersForTools(
    [withState('pending', 'p'), withState('failed', 'f'), withState('needs-auth', 'n')],
    [tool('mcp__p__x', 'p')],
  ).map(c => c.name)
  same(names, ['p'], 'pending only')
})

test('a server whose tools left the request is retracted', () => {
  const clients = [connected('a', 'A')]
  const first = getMcpInstructionsDelta(mcpServersForTools(clients, [tool('mcp__a__x', 'a')]), [], [])
  const d = getMcpInstructionsDelta(mcpServersForTools(clients, [tool('Read')]), told(first), [])
  same(d?.removedNames, ['a'], 'retracted with its tools')
})

console.log('switch:')

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('on by default, off with CLAUDE_CODE_MCP_INSTR_DELTA=0', () => {
  withEnv({ CLAUDE_CODE_MCP_INSTR_DELTA: undefined, CLAUDE_CODE_DISABLE_ATTACHMENTS: undefined }, () =>
    assert(isMcpInstructionsDeltaEnabled(), 'default on'),
  )
  withEnv({ CLAUDE_CODE_MCP_INSTR_DELTA: '0', CLAUDE_CODE_DISABLE_ATTACHMENTS: undefined }, () =>
    assert(!isMcpInstructionsDeltaEnabled(), 'explicit off'),
  )
})

test('reminders switched off keep the system-prompt section, unless forced', () => {
  withEnv({ CLAUDE_CODE_MCP_INSTR_DELTA: undefined, CLAUDE_CODE_DISABLE_ATTACHMENTS: '1' }, () =>
    assert(!isMcpInstructionsDeltaEnabled(), 'falls back'),
  )
  withEnv({ CLAUDE_CODE_MCP_INSTR_DELTA: '1', CLAUDE_CODE_DISABLE_ATTACHMENTS: '1' }, () =>
    assert(isMcpInstructionsDeltaEnabled(), 'explicit on wins'),
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
