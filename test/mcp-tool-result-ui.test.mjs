import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import sharp from 'sharp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const previousCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-mcp-result-ui-'))
const project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
after(() => {
  process.chdir(previousCwd)
  rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})

const r = await loadBuiltRuntime({
  paths: [
    'src/services/mcp/client.ts',
    'src/tools/MCPTool/MCPTool.ts',
    'src/components/messages/UserToolResultMessage/UserToolResultMessage.tsx',
    'src/utils/messages.ts',
    'src/utils/collapseReadSearch.ts',
    'src/components/messages/CollapsedReadSearchContent.tsx',
  ],
  exports: [
    'fetchToolsForClient', 'UserToolResultMessage', 'createAssistantMessage',
    'createUserMessage', 'normalizeMessages', 'buildMessageLookups',
    'collapseReadSearchGroups', 'CollapsedReadSearchContent',
  ],
})

async function withMcpTool(response, callback, toolName = 'inspect') {
  const name = 'result-ui-' + randomBytes(4).toString('hex')
  const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
  const client = new Client({ name: 'terminal-result-test', version: '1.0.0' })
  const calls = []
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: toolName, description: 'Inspect a receipt', inputSchema: { type: 'object' } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    calls.push(request.params)
    return response
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const connection = {
      name, type: 'connected', config: { type: 'sdk', scope: 'project' },
      capabilities: client.getServerCapabilities(), client,
    }
    const [tool] = await r.fetchToolsForClient(connection)
    assert.ok(tool, 'Production discovery must publish the real MCP tool')
    const id = randomUUID()
    const call = { type: 'tool_use', id, name: tool.name, input: {} }
    const assistant = r.createAssistantMessage({ content: [call] })
    const result = await tool.call({}, {
      abortController: new AbortController(), setAppState() {},
    }, async () => ({ behavior: 'allow' }), assistant)
    assert.equal(calls.length, 1, 'The result must come from one actual MCP request')
    assert.equal(calls[0].name, toolName)
    assert.deepEqual(tool.outputSchema.parse(result.data), result.data)
    await callback(tool, result.data, call, assistant)
  } finally {
    r.fetchToolsForClient.cache.clear()
    await client.close()
    await server.close()
  }
}

async function renderResult(tool, output, call, assistant, verbose) {
  const param = tool.mapToolResultToToolResultBlockParam(output, call.id)
  const original = [assistant, r.createUserMessage({ content: [param], toolUseResult: output })]
  const normalized = r.normalizeMessages(original)
  return mount(r, React.createElement(r.UserToolResultMessage, {
    param, message: normalized[1], lookups: r.buildMessageLookups(normalized, original),
    tools: [tool], progressMessagesForMessage: [], verbose, width: 80, isTranscriptMode: verbose,
  }), { columns: 80 })
}

test('discovered MCP content-array results remain visible in normal and transcript terminal views', async () => {
  const receipt = randomBytes(8).toString('hex')
  await withMcpTool({ content: [
    { type: 'text', text: 'Receipt: ' + receipt },
    { type: 'text', text: 'Second content block' },
  ] }, async (tool, output, call, assistant) => {
    assert.ok(Array.isArray(output))
    for (const verbose of [false, true]) {
      const panel = await renderResult(tool, output, call, assistant, verbose)
      try {
        assert.ok(panel.frame().includes(receipt), panel.frame())
        assert.ok(panel.frame().includes('Second content block'), panel.frame())
      } finally { panel.close() }
    }
  })
})

test('discovered MCP image/text blocks and string structured results share the supported output contract', async () => {
  const receipt = randomBytes(8).toString('hex')
  const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer()
  for (const response of [
    { content: [{ type: 'text', text: receipt }, { type: 'image', data: image.toString('base64'), mimeType: 'image/png' }] },
    { content: [], structuredContent: { receipt, amount: 23 } },
  ]) {
    await withMcpTool(response, async (tool, output, call, assistant) => {
      assert.equal(typeof output, response.structuredContent ? 'string' : 'object')
      for (const verbose of [false, true]) {
        const panel = await renderResult(tool, output, call, assistant, verbose)
        try {
          assert.ok(panel.frame().includes(receipt), panel.frame())
          if (!response.structuredContent) assert.ok(panel.frame().includes('[Image]'), panel.frame())
        } finally { panel.close() }
      }
    })
  }
})

test('expansion detection inspects text content in real MCP arrays and rejects malformed stored output', async () => {
  const text = Array.from({ length: 10 }, (_, index) => 'line ' + index).join('\n')
  await withMcpTool({ content: [{ type: 'text', text }] }, async (tool, output) => {
    assert.equal(tool.isResultTruncated(output), true)
    assert.equal(tool.isResultTruncated(text), true)
    assert.equal(tool.isResultTruncated([{ type: 'text', text: 'short' }]), false)
    assert.equal(tool.isResultTruncated(undefined), false)
    for (const malformed of [null, {}, {type:'text',text:17}, [null], [{type:'text',text:17}]])
      assert.equal(tool.isResultTruncated(malformed),false,'Unvalidated historical output must not crash expansion checks')
    assert.equal(tool.outputSchema.safeParse({ text: 'wrong outer shape' }).success, false)
    assert.equal(tool.outputSchema.safeParse([{ type: 'text', text: 17 }]).success, false)
  })
})

test('expanding a collapsed real MCP read keeps its content-array result visible', async () => {
  const receipt = randomBytes(8).toString('hex')
  await withMcpTool({content:[{type:'text',text:'Collapsed receipt '+receipt}]}, async(tool, output, call, assistant)=>{
    const param = tool.mapToolResultToToolResultBlockParam(output,call.id)
    const original = [assistant,r.createUserMessage({content:[param],toolUseResult:output})]
    const normalized = r.normalizeMessages(original)
    const grouped = r.collapseReadSearchGroups(normalized,[tool])
    const message = grouped.find(item=>item.type==='collapsed_read_search')
    assert.ok(message,'The actual MCP tool must enter production read grouping')
    const panel = await mount(r,React.createElement(r.CollapsedReadSearchContent,{
      message,lookups:r.buildMessageLookups(normalized,original),tools:[tool],
      inProgressToolUseIDs:new Set(),shouldAnimate:false,verbose:true,
    }))
    try { assert.ok(panel.frame().includes(receipt),panel.frame()) }
    finally { panel.close() }
  },'read_file')
})
