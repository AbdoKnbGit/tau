// What a skill's allowed-tools mean, as the user and the model are told.
//
// A skill adds no tools: its allowed-tools pre-approve existing ones while it
// runs. "Successfully loaded skill · 5 tools allowed" read as five tools the
// skill provided, and the model, never told what was pre-approved, guessed.

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const runtime = await loadMcpRuntime({
  paths: ['src/tools/SkillTool/SkillTool.ts', 'src/tools/SkillTool/UI.tsx'],
  exports: ['SkillTool', 'summarizeToolNames'],
})

test('the pre-approved tools are named, not counted', () => {
  assert.equal(runtime.summarizeToolNames(['Read', 'Write', 'Edit', 'Glob', 'Grep']), 'Read, Write, Edit, Glob, Grep')
})

test('a long list stays on one line and counts the rest', () => {
  const names = Array.from({ length: 12 }, (_, i) => `mcp__server_${i}__tool_with_a_long_name`)
  const summary = runtime.summarizeToolNames(names)
  assert.match(summary, /^mcp__server_0__tool_with_a_long_name, .* \+\d+ more$|^mcp__server_0__tool_with_a_long_name \+11 more$/)
  assert.ok(summary.length < 110, summary)
})

test('the model is told what the skill pre-approves and that it adds no tools', () => {
  const block = runtime.SkillTool.mapToolResultToToolResultBlockParam(
    { success: true, commandName: 'someplugin:rules', allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'] },
    'toolu_skill',
  )
  assert.match(String(block.content), /^Launching skill: someplugin:rules\n/)
  assert.match(String(block.content), /need no permission prompt: Read, Write, Edit, Glob, Grep\./)
  assert.match(String(block.content), /adds no tools of its own/)
})

test('a skill without allowed-tools keeps the result it always had', () => {
  const block = runtime.SkillTool.mapToolResultToToolResultBlockParam(
    { success: true, commandName: 'commit' },
    'toolu_skill',
  )
  assert.equal(block.content, 'Launching skill: commit')
})
