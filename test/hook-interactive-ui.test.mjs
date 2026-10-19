import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { KEYS, loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'tau-hook-ui-'))
const previousCwd = process.cwd()
mkdirSync(join(scratch, 'project'))
Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(scratch, 'config'),
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' })
process.chdir(join(scratch, 'project'))
after(() => {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 })
})

const r = await loadBuiltRuntime({
  paths: ['src/components/hooks/PromptDialog.tsx', 'src/utils/hooks/messageDisplay.ts',
    'src/components/messages/AssistantTextMessage.tsx', 'src/utils/collapseReadSearch.ts',
    'src/utils/groupToolUses.ts', 'src/utils/messages.ts'],
  exports: ['PromptDialog', 'AssistantTextMessage', 'withMessageDisplay',
    'collapseReadSearchGroups', 'applyGrouping', 'createAssistantMessage', 'createUserMessage', 'normalizeMessages'],
})

const request = { prompt: 'fixture', message: 'Switching model costs tokens. Continue?',
  options: [{ key: 'cancel', label: 'Keep current model' }, { key: 'allow', label: 'Switch model' }] }

test('hook confirmation renders both choices and accepts keyboard selection', async () => {
  const answers = []
  const panel = await mount(r, React.createElement(r.PromptDialog, {
    title: 'PreModelSwitch', request, onRespond: answer => answers.push(answer), onAbort() {},
  }))
  try {
    assert.match(panel.frame(), /Continue\?/)
    assert.match(panel.frame(), /Keep current model/)
    assert.match(panel.frame(), /Switch model/)
    await panel.press(KEYS.down)
    await panel.press(KEYS.enter)
    assert.deepEqual(answers, ['allow'])
  } finally { panel.close() }
})

test('hook confirmation defaults to keeping the current model', async () => {
  const answers = []
  const panel = await mount(r, React.createElement(r.PromptDialog, {
    title: 'PreModelSwitch', request, onRespond: answer => answers.push(answer), onAbort() {},
  }))
  try {
    await panel.press(KEYS.enter)
    assert.deepEqual(answers, ['cancel'])
  } finally { panel.close() }
})

test('MessageDisplay renders changed text on screen and original text in verbose view', async () => {
  const message = r.createAssistantMessage({ content: 'Mixed case fixture reply.' })
  async function* query() { yield message }
  for await (const _ of r.withMessageDisplay(query(), { options: {} }, async batch => batch.delta.toUpperCase(), false)) {}
  for (const verbose of [false, true]) {
    const panel = await mount(r, React.createElement(r.AssistantTextMessage, {
      param: message.message.content[0], addMargin: false, shouldShowDot: true, verbose,
    }))
    try {
      assert.ok(panel.frame().includes(verbose ? 'Mixed case fixture reply.' : 'MIXED CASE FIXTURE REPLY.'), panel.frame())
    } finally { panel.close() }
  }
  assert.equal(message.message.content[0].text, 'Mixed case fixture reply.')
})

const readTool = { name: 'Read', isSearchOrReadCommand: () => ({ isRead: true, isSearch: false }), renderGroupedToolUse() {} }
function toolMessages(ids, failed = []) {
  const assistant = r.createAssistantMessage({ content: ids.map(id => ({
    type: 'tool_use', id, name: 'Read', input: { file_path: join(scratch, `${id}.txt`) },
  })) })
  return r.normalizeMessages([assistant, ...ids.map(id => r.createUserMessage({ content: [{
    type: 'tool_result', tool_use_id: id, is_error: failed.includes(id),
    content: failed.includes(id) ? 'Read blocked by policy' : 'file contents',
  }] }))])
}

test('a denied read stays visible rather than becoming a successful read count', () => {
  const messages = toolMessages(['denied'], ['denied'])
  assert.deepEqual(r.collapseReadSearchGroups(messages, [readTool]), messages)
})

test('mixed grouped reads keep the failed operation and reason visible', () => {
  const messages = toolMessages(['okay', 'denied'], ['denied'])
  const grouped = r.applyGrouping(messages, [readTool]).messages
  assert.equal(grouped[0].type, 'grouped_tool_use')
  const collapsed = r.collapseReadSearchGroups(grouped, [readTool])
  assert.ok(collapsed.some(message => message.type === 'assistant' && message.message.content[0].id === 'denied'))
  assert.ok(collapsed.some(message => message.type === 'user' && message.message.content.some(block => block.is_error && block.content === 'Read blocked by policy')))
  assert.ok(!collapsed.some(message => message.type === 'collapsed_read_search' && message.messages.some(item => item.type === 'assistant' && item.message.content[0].id === 'denied')))
})

test('successful reads retain compact grouping', () => {
  const collapsed = r.collapseReadSearchGroups(toolMessages(['okay']), [readTool])
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0].type, 'collapsed_read_search')
  assert.equal(collapsed[0].readCount, 1)
})
