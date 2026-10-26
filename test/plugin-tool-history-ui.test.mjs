import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const previousCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-tool-history-ui-'))
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
    'src/utils/plugins/mods/tools.ts',
    'src/components/messages/AssistantToolUseMessage.tsx',
    'src/components/messages/UserToolResultMessage/UserToolResultMessage.tsx',
    'src/utils/messages.ts',
  ],
  exports: [
    'createModToolRegistry', 'publishModToolRegistries', 'getModTools',
    'AssistantToolUseMessage', 'UserToolResultMessage',
    'createAssistantMessage', 'createUserMessage', 'normalizeMessages', 'buildMessageLookups',
    'CANCEL_MESSAGE', 'REJECT_MESSAGE',
  ],
})
afterEach(async () => { await r.publishModToolRegistries([]) })

function pair(name, value, content = JSON.stringify(value), isError = false) {
  const id = randomUUID()
  const call = { type: 'tool_use', id, name, input: { note: 'saved-input' } }
  const param = { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }
  const original = [
    r.createAssistantMessage({ content: [call] }),
    r.createUserMessage({ content: [param], toolUseResult: value }),
  ]
  const normalized = r.normalizeMessages(original)
  return { call, param, message: normalized[1], lookups: r.buildMessageLookups(normalized, original) }
}

function history(data, tools, verbose) {
  return React.createElement(React.Fragment, null,
    React.createElement(r.AssistantToolUseMessage, {
      param: data.call, lookups: data.lookups, tools, commands: [], addMargin: false,
      verbose, inProgressToolUseIDs: new Set(), progressMessagesForMessage: [],
      shouldAnimate: false, shouldShowDot: true, isTranscriptMode: verbose,
    }),
    React.createElement(r.UserToolResultMessage, {
      ...data, tools, verbose, progressMessagesForMessage: [], width: 80, isTranscriptMode: verbose,
    }),
  )
}

async function settle() {
  r.reconciler.flushSyncWork()
  await new Promise(setImmediate)
  r.reconciler.flushSyncWork()
}

test('a recorded registered-tool call stays visible after its live inventory is removed', async () => {
  for (const verbose of [false, true]) {
    let available = true, actions = 0
    const registry = r.createModToolRegistry({
      plugin: 'history-' + randomBytes(3).toString('hex'),
      isCurrent: () => available, reserved: new Map(), changed: async () => {},
    })
    await registry.register({ name: 'report', description: 'Return saved data' })
    await r.publishModToolRegistries([registry])
    const tool = r.getModTools()[0]
    tool.call = async () => { actions++; throw new Error('History must not execute a tool') }
    const receipt = randomBytes(8).toString('hex')
    const data = pair(tool.name, { receipt, amount: 29 })
    let setInventory
    function View() {
      const [inventory, updateInventory] = React.useState([tool])
      setInventory = updateInventory
      return history(data, inventory, verbose)
    }
    const panel = await mount(r, React.createElement(View))
    try {
      assert.ok(panel.frame().includes(tool.name), panel.frame())
      assert.ok(panel.frame().includes(receipt), panel.frame())
      available = false
      await r.publishModToolRegistries([])
      setInventory(r.getModTools())
      await settle()
      assert.ok(panel.frame().includes(tool.name), panel.frame())
      assert.ok(panel.frame().includes('saved-input'), panel.frame())
      assert.ok(panel.frame().includes(receipt), panel.frame())
      assert.equal(tool.isEnabled(), false)
      assert.deepEqual(r.getModTools(), [])
      assert.equal(actions, 0)
    } finally { panel.close() }
  }
})

test('replayed tool results need no current tool definition or raw-result metadata', async () => {
  const name = 'mcp__missing-plugin__saved-result'
  for (const verbose of [false, true]) {
    for (const value of [0, false, null, 'saved-string', { receipt: 'saved-object' }]) {
      const data = pair(name, undefined, typeof value === 'string' ? value : JSON.stringify(value))
      const panel = await mount(r, history(data, [], verbose))
      try {
        assert.ok(panel.frame().includes(name), panel.frame())
        assert.ok(panel.frame().includes(typeof value === 'string' ? value : value?.receipt ?? JSON.stringify(value)), panel.frame())
      } finally { panel.close() }
    }
  }
})

test('unavailable tools retain recorded error, cancel and reject statuses', async () => {
  for (const verbose of [false, true]) {
    for (const [content, expected] of [
      ['Saved plugin failure', 'Saved plugin failure'],
      [r.CANCEL_MESSAGE, 'Interrupted'],
      [r.REJECT_MESSAGE, 'Interrupted'],
    ]) {
      const data = pair('mcp__removed__failed', undefined, content, true)
      const panel = await mount(r, history(data, [], verbose))
      try { assert.ok(panel.frame().includes(expected), panel.frame()) }
      finally { panel.close() }
    }
  }
})

test('recorded content blocks preserve text while keeping image and document bytes out of the terminal', async () => {
  const content = [
    { type: 'text', text: 'Saved block receipt' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMAGE-BYTES-MUST-NOT-RENDER' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'DOCUMENT-BYTES-MUST-NOT-RENDER' } },
    { type: 'search_result', title: 'Saved search', source: 'local-source', content: [{ type: 'text', text: 'Nested saved text' }] },
    { type: 'tool_reference', tool_name: 'mcp__saved__reference' },
  ]
  const panel = await mount(r, history(pair('mcp__removed__blocks', undefined, content), [], true))
  try {
    for (const expected of ['Saved block receipt', '[Image]', '[Document]', 'Nested saved text', 'mcp__saved__reference'])
      assert.ok(panel.frame().includes(expected), panel.frame())
    assert.ok(!panel.frame().includes('BYTES-MUST-NOT-RENDER'), panel.frame())
    assert.deepEqual(r.getModTools(), [])
  } finally { panel.close() }
})
