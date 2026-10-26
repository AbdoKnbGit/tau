import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { z } from 'zod/v4'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const previousCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-mod-tool-ui-'))
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
    'src/components/ToolRendererContent.tsx',
    'src/components/messages/GroupedToolUseContent.tsx',
  ],
  exports: [
    'createModToolRegistry', 'AssistantToolUseMessage', 'UserToolResultMessage',
    'createAssistantMessage', 'createUserMessage', 'normalizeMessages', 'buildMessageLookups',
    'ToolRendererContent', 'GroupedToolUseContent', 'REJECT_MESSAGE',
  ],
})

async function registeredTool() {
  const registry = r.createModToolRegistry({
    plugin: 'ui-' + randomBytes(4).toString('hex'),
    isCurrent: () => true,
    reserved: new Map(),
    changed: async () => {},
  })
  await registry.register({ name: 'inspect', description: 'Return a JSON value' })
  return [...registry.tools.values()][0]
}

function messages(tool, value, error = false) {
  const id = randomUUID()
  const call = { type: 'tool_use', id, name: tool.name, input: { label: 'request' } }
  const param = { ...tool.mapToolResultToToolResultBlockParam(value, id), ...(error ? { is_error: true } : {}) }
  const original = [
    r.createAssistantMessage({ content: [call] }),
    r.createUserMessage({ content: [param], toolUseResult: value }),
  ]
  const normalized = r.normalizeMessages(original)
  return { call, param, message: normalized[1], lookups: r.buildMessageLookups(normalized, original) }
}

async function resultPanel(tool, value, verbose, error = false) {
  const data = messages(tool, value, error)
  return mount(r, React.createElement(r.UserToolResultMessage, {
    ...data, tools: [tool], progressMessagesForMessage: [], verbose,
    width: 80, isTranscriptMode: verbose,
  }), { columns: 80 })
}

test('registered JSON results render through the actual terminal success path in normal and transcript views', async () => {
  const tool = await registeredTool()
  const receipt = randomBytes(8).toString('hex')
  const cases = [
    { value: { receipt, amount: 37, nested: { confirmation: 'first line\nsecond line' } }, expected: receipt },
    { value: ['array-' + receipt, { completed: true }], expected: receipt },
    { value: 'first line\nsecond line ' + receipt, expected: 'first line' },
  ]
  for (const { value, expected } of cases) {
    const mapped = tool.mapToolResultToToolResultBlockParam(value, 'mapping-check')
    assert.equal(mapped.content, typeof value === 'string' ? value : JSON.stringify(value))
    for (const verbose of [false, true]) {
      const panel = await resultPanel(tool, value, verbose)
      try {
        assert.ok(panel.frame().includes(expected), panel.frame())
        if (verbose) assert.ok(panel.frame().includes(receipt), panel.frame())
      } finally { panel.close() }
    }
  }
})

test('registered tools render their input header and fallback failures without raw text under a Box', async () => {
  const tool = await registeredTool()
  const data = messages(tool, { complete: true })
  const panel = await mount(r, React.createElement(r.AssistantToolUseMessage, {
    param: data.call, lookups: data.lookups, tools: [tool], commands: [],
    addMargin: false, verbose: false, inProgressToolUseIDs: new Set(),
    progressMessagesForMessage: [], shouldAnimate: false, shouldShowDot: true,
  }))
  try { assert.ok(panel.frame().includes('request'), panel.frame()) }
  finally { panel.close() }
  for (const verbose of [false, true]) {
    const failure = await resultPanel(tool, 'Denied by the plugin check', verbose, true)
    try { assert.ok(failure.frame().includes('Denied by the plugin check'), failure.frame()) }
    finally { failure.close() }
  }
})

test('valid falsey JSON results remain visible rather than being treated as missing metadata', async () => {
  const tool = await registeredTool()
  for (const value of [0, false, null]) {
    const panel = await resultPanel(tool, value, true)
    try { assert.ok(panel.frame().includes(JSON.stringify(value)), panel.frame()) }
    finally { panel.close() }
  }
  const missing = await resultPanel(tool, undefined, true)
  try { assert.equal(missing.frame().trim(), '') }
  finally { missing.close() }
})

test('tool callback text, numbers, arrays and fragments are safe under the actual result container', async () => {
  const tool = await registeredTool()
  const cases = [
    { render: 'plain callback result', expected: ['plain callback result'] },
    { render: 0, expected: ['0'] },
    { render: 7n, expected: ['7'] },
    { render: ['array callback', React.createElement(React.Fragment, {key: 'nested'}, 'fragment callback', 23)], expected: ['array callback', 'fragment callback', '23'] },
    { render: React.createElement(React.Fragment, null, 'root fragment', ['nested text', 41]), expected: ['root fragment', 'nested text', '41'] },
  ]
  for (const {render, expected} of cases) {
    tool.renderToolResultMessage = () => render
    const panel = await resultPanel(tool, {complete:true}, true)
    try { for (const text of expected) assert.ok(panel.frame().includes(text), panel.frame()) }
    finally { panel.close() }
  }
})

test('custom error and rejection callbacks can return plain text safely', async () => {
  const tool = await registeredTool()
  tool.renderToolUseErrorMessage = () => React.createElement(React.Fragment, null, 'custom error callback')
  tool.renderToolUseRejectedMessage = () => ['custom rejection callback', 17]
  for (const [value, expected] of [['actual failure','custom error callback'], [r.REJECT_MESSAGE,'custom rejection callback']]) {
    const panel = await resultPanel(tool, value, true, true)
    try { assert.ok(panel.frame().includes(expected), panel.frame()) }
    finally { panel.close() }
  }
})

test('queued and running callback text and tags render safely before any result exists', async () => {
  const tool = await registeredTool()
  tool.renderToolUseQueuedMessage = () => ['waiting callback', 31]
  tool.renderToolUseProgressMessage = () => React.createElement(React.Fragment, null, 'running callback')
  tool.renderToolUseTag = () => 'tag callback'
  for (const running of [false, true]) {
    const data = messages(tool, {complete:true})
    data.lookups.resolvedToolUseIDs.clear()
    data.lookups.toolResultByToolUseID.clear()
    const panel = await mount(r, React.createElement(r.AssistantToolUseMessage, {
      param:data.call, lookups:data.lookups, tools:[tool], commands:[], addMargin:false,
      verbose:false, inProgressToolUseIDs:running?new Set([data.call.id]):new Set(),
      progressMessagesForMessage:[], shouldAnimate:false, shouldShowDot:true,
    }))
    try {
      assert.ok(panel.frame().includes(running?'running callback':'waiting callback'), panel.frame())
      assert.ok(panel.frame().includes('tag callback'), panel.frame())
    } finally { panel.close() }
  }
})

test('grouped tool callback text has the same safe terminal boundary', async () => {
  const tool = await registeredTool()
  tool.renderGroupedToolUse = () => React.createElement(React.Fragment,null,'group callback',42)
  const data = messages(tool,{complete:true})
  const assistant = r.normalizeMessages([r.createAssistantMessage({content:[data.call]})])[0]
  const panel = await mount(r, React.createElement(r.GroupedToolUseContent,{
    message:{toolName:tool.name,messages:[assistant],results:[data.message]},
    tools:[tool], lookups:data.lookups, inProgressToolUseIDs:new Set(),shouldAnimate:false,
  }))
  try { assert.ok(panel.frame().includes('group callback'),panel.frame()) }
  finally { panel.close() }
})

test('registered JSON output can expand and its searchable text matches the displayed full result', async () => {
  const tool = await registeredTool()
  const receipt = randomBytes(8).toString('hex')
  const value = { receipt, values:Array.from({length:12},(_,i)=>'line-'+i) }
  assert.equal(tool.isResultTruncated(value),true)
  assert.equal(tool.isResultTruncated('short'),false)
  const panel = await resultPanel(tool,value,true)
  try {
    const visible = panel.frame().replace(/^\s*╰─\s?/gm,'').split('\n').map(line=>line.trim()).filter(Boolean).join('\n')
    const indexed = tool.extractSearchText(value).split('\n').map(line=>line.trim()).filter(Boolean).join('\n')
    assert.equal(indexed,visible)
  } finally { panel.close() }
  for (const primitive of [0,false,null])
    assert.equal(tool.extractSearchText(primitive),JSON.stringify(primitive))
})

test('a valid output-schema transformation to null reaches the renderer as null', async () => {
  const tool = await registeredTool()
  tool.outputSchema = z.object({status:z.literal('empty')}).transform(()=>null)
  tool.renderToolResultMessage = output => output===null?'transformed null result':'wrong unparsed result'
  const panel = await resultPanel(tool,{status:'empty'},true)
  try { assert.ok(panel.frame().includes('transformed null result'),panel.frame()) }
  finally { panel.close() }
})
