/**
 * Gemini lane: tool wire names and the rejected-schema backstop.
 *
 *   - an MCP tool whose schema the backend rejects is left out and the turn
 *     retried (instead of every turn failing), keyed to the exact schema;
 *   - built-in tools are never quarantined; their rejection surfaces;
 *   - a 400 is never answered with login / switch-model advice;
 *   - names Gemini cannot take are aliased on the wire and mapped back.
 *
 * Run: bun run src/lanes/gemini/tool_schema_quarantine.test.ts
 */
import assert from 'node:assert/strict'
import { APIConnectionError } from '@anthropic-ai/sdk'
import { mock } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve, sep } from 'node:path'

const tempRoot = realpathSync(os.tmpdir())
const sandbox = realpathSync(mkdtempSync(join(tempRoot, 'tau-tool-quarantine-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))

type Decl = { name: string; parameters: Record<string, any> }
type Behavior =
  | { kind: 'reject'; tool: string; style: 'gemini' | 'claude' }
  | { kind: 'call'; name: string; args: Record<string, unknown> }
  | { kind: 'text' }
let behavior: Behavior = { kind: 'text' }
const requests: any[] = []

mock.module('./api.js', () => ({
  TAU_STABLE_SESSION_ID_FIELD: '__tauStableSessionId',
  TAU_QUERY_SOURCE_FIELD: '__tauQuerySource',
  isGeminiRetryableNetworkError: () => false,
  geminiApi: {
    supportsServerCache: () => false,
    async *streamGenerateContent(request: Record<string, any>) {
      requests.push(structuredClone(request))
      const decls: Decl[] = request.tools?.[0]?.functionDeclarations ?? []
      if (behavior.kind === 'reject') {
        const index = decls.findIndex(d => d.name === (behavior as any).tool)
        // Both wordings seen live: Gemini lists function_declarations[N];
        // Claude via Antigravity relays Anthropic's "tools.N." path.
        const message = behavior.style === 'gemini'
          ? `* GenerateContentRequest.tools[0].function_declarations[${index}].parameters.properties[batch].items: missing field.\n`
          : `{"type":"error","error":{"type":"invalid_request_error","message":"tools.${index}.custom.input_schema.properties: Property keys should match pattern"}}`
        const body = JSON.stringify({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } })
        throw Object.assign(new Error(`Gemini API error 400: ${body.slice(0, 200)}`), { status: 400, body, kind: 'non-retryable' })
      }
      const parts = behavior.kind === 'call'
        ? [{ functionCall: { name: behavior.name, args: behavior.args } }]
        : [{ text: 'OK' }]
      yield {
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1 },
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      }
    },
  },
}))

const cache = await import('./antigravity_cache.js')
const { GeminiLane, _resetGeminiToolQuarantineForTest } = await import('./loop.js')

const LONG_NAME = `mcp__claude_ai_${'Very_Long_Connector_Name_'.repeat(5)}__search_everything`
const BAD = { name: 'mcp__svc__bad', description: 'bad', input_schema: { type: 'object', properties: { batch: { type: 'array' } } } }
const GOOD = { name: 'mcp__svc__good', description: 'good', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }
const LONG = { name: LONG_NAME, description: 'long', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }
const READ = { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }

async function run(opts: { model?: string; tools?: any[]; messages?: any[] } = {}): Promise<any[]> {
  const events: any[] = []
  for await (const event of new GeminiLane().streamAsProvider({
    model: opts.model ?? 'gemini-3.8-flash-low',
    providerHint: 'antigravity',
    sessionId: 'quarantine-session',
    querySource: 'repl_main_thread',
    signal: new AbortController().signal,
    system: 'Use the tools.',
    messages: opts.messages ?? [{ role: 'user', content: 'Go.' }],
    tools: opts.tools ?? [READ, BAD, GOOD, LONG],
    max_tokens: 128,
    thinking: { type: 'disabled' },
  })) events.push(event)
  return events
}

const declNames = (request: any): string[] => (request.tools?.[0]?.functionDeclarations ?? []).map((d: Decl) => d.name)
const text = (events: any[]): string => events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join('')
const isRetryableWith = (pattern: RegExp) => (err: unknown): boolean => {
  assert.ok(err instanceof APIConnectionError, 'must reuse the shared retry controller (APIConnectionError)')
  assert.match(String((err as Error).message), pattern)
  return true
}

try {
  cache._resetAntigravityCacheStateForTest()
  cache._setAntigravityCommitWindowForTest(0)
  _resetGeminiToolQuarantineForTest()

  // 1. A rejected MCP schema quarantines that tool and asks for a retry.
  behavior = { kind: 'reject', tool: 'mcp__svc__bad', style: 'gemini' }
  await assert.rejects(run(), isRetryableWith(/mcp__svc__bad/))
  const aliased = declNames(requests.at(-1)).find(n => n !== LONG_NAME && n.startsWith('mcp__claude_ai_'))
  assert.ok(aliased && aliased.length <= 128 && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(aliased), 'long MCP name must be aliased on the wire')

  // 2. The retry omits it; the aliased tool call maps back to the real name.
  behavior = { kind: 'call', name: aliased!, args: { q: 'x' } }
  const events = await run()
  const names = declNames(requests.at(-1))
  assert.ok(!names.includes('mcp__svc__bad'), 'quarantined tool was offered again')
  assert.ok(names.includes('mcp__svc__good') && names.includes(aliased!), 'healthy tools must stay')
  const toolUse = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
  assert.equal(toolUse?.content_block?.name, LONG_NAME, 'aliased call must resolve to the original tool name')

  // 3. History uses the same wire name as the declaration.
  behavior = { kind: 'text' }
  await run({
    messages: [
      { role: 'user', content: 'Go.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: LONG_NAME, input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
    ],
  })
  const wire = JSON.stringify(requests.at(-1).contents)
  assert.ok(wire.includes(`"name":"${aliased}"`), 'history must carry the aliased wire name')
  assert.ok(!wire.includes(`"name":"${LONG_NAME}"`), 'history leaked the invalid original name')

  // 4. Built-in tools are never quarantined; the 400 gets request wording.
  const readWire = declNames(requests.at(-1))[0]!
  behavior = { kind: 'reject', tool: readWire, style: 'gemini' }
  const failed = await run()
  const message = text(failed)
  assert.match(message, /rejected before it reached the model/)
  assert.match(message, new RegExp(`rejected schema belongs to: ${readWire}`))
  assert.doesNotMatch(message, /\/login|Antigravity account is connected/i, 'a 400 must not blame the login')
  behavior = { kind: 'text' }
  await run()
  assert.ok(declNames(requests.at(-1)).includes(readWire), 'built-in tool must never be quarantined')

  // 5. A server that fixes its schema gets its tool offered again.
  const fixedBad = { ...BAD, input_schema: { type: 'object', properties: { batch: { type: 'array', items: { type: 'string' } } } } }
  await run({ tools: [READ, fixedBad, GOOD] })
  assert.ok(declNames(requests.at(-1)).includes('mcp__svc__bad'), 'quarantine must be keyed to the rejected schema')

  // 6. Gemini and Claude-on-Antigravity quarantines are independent.
  await run({ model: 'claude-sonnet-4-6' })
  assert.ok(declNames(requests.at(-1)).includes('mcp__svc__bad'), 'a Gemini rejection must not hide the tool from Claude')
  behavior = { kind: 'reject', tool: 'mcp__svc__good', style: 'claude' }
  await assert.rejects(run({ model: 'claude-sonnet-4-6' }), isRetryableWith(/mcp__svc__good/))
  behavior = { kind: 'text' }
  await run({ model: 'claude-sonnet-4-6' })
  assert.ok(!declNames(requests.at(-1)).includes('mcp__svc__good'), 'Claude-style tools.N rejection must quarantine')
  await run()
  assert.ok(declNames(requests.at(-1)).includes('mcp__svc__good'), 'a Claude rejection must not hide the tool from Gemini')

  // 7. Stable: repeated turns send byte-identical tool blocks.
  await run()
  const first = JSON.stringify(requests.at(-1).tools)
  await run()
  assert.equal(JSON.stringify(requests.at(-1).tools), first, 'tool block changed between identical turns')

  console.log('Gemini tool quarantine + wire names passed: retry, alias round-trip, history, built-ins, schema key, per-family, stability')
} finally {
  _resetGeminiToolQuarantineForTest()
  cache._resetAntigravityCacheStateForTest()
  mock.restore()
  assert.ok(resolve(sandbox).startsWith(resolve(tempRoot) + sep))
  rmSync(sandbox, { recursive: true, force: true })
}
