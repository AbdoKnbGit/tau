import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { KEYS, loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// /config's Sub-agent model row, driven the way a user does: open it, pick,
// close with Enter or cancel with Esc. Runs against the built bundle (`npm
// run build` first) with a throwaway config folder and project, where the
// provider is Anthropic and its model list needs no network.
const repoDir = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tau-subagent-config-'))
const configDir = join(scratch, 'config')
const projectDir = join(scratch, 'project')
mkdirSync(configDir)
mkdirSync(join(projectDir, '.git'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_TMPDIR = configDir
delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
process.chdir(projectDir)
after(async () => {
  process.chdir(repoDir)
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 100 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
})

const runtime = await loadBuiltRuntime({
  paths: ['src/components/Settings/Settings.tsx'],
  exports: ['Settings', 'updateSettingsForSource', 'getInitialSettings'],
})

const userFile = join(configDir, 'settings.json')
const userSetting = () => existsSync(userFile)
  ? JSON.parse(readFileSync(userFile, 'utf8')).subagentModel
  : undefined

async function openConfig() {
  const closes = []
  let panel
  const context = {
    messages: [], options: { mcpClients: [] },
    getAppState: () => panel.store.getState(),
    setAppState: update => panel.store.setState(update),
    setMessages: () => {},
  }
  panel = await mount(runtime, React.createElement(runtime.Settings, {
    onClose: (result, options) => closes.push([result, options]),
    context,
    defaultTab: 'Config',
  }), { columns: 110, rows: 40 })
  await panel.waitFor(/Search settings/)
  return Object.assign(panel, { closes })
}

/** Filters the list to the row and opens its submenu. */
async function openRow(panel, value) {
  await panel.type('Sub-agent')
  await panel.press(KEYS.down)
  assert.match(panel.frame(), new RegExp(`[❯>] Sub-agent model\\s+${value}`))
  // Space changes a row; Enter would save and close /config.
  await panel.press(KEYS.space)
  await panel.waitFor(/Same as main model/)
}

function setUserSetting(value) {
  assert.equal(runtime.updateSettingsForSource('userSettings', { subagentModel: undefined }).error, null)
  if (value !== undefined) {
    assert.equal(runtime.updateSettingsForSource('userSettings', { subagentModel: value }).error, null)
  }
}

test('Same as main model saves at once, and Esc restores the absent setting', async () => {
  setUserSetting(undefined)
  const panel = await openConfig()
  try {
    await openRow(panel, 'Auto')
    assert.match(panel.frame(), /Auto/)
    assert.match(panel.frame(), /Custom model…/)
    await panel.press(KEYS.down)
    await panel.press(KEYS.enter)
    await panel.waitFor(/Sub-agent model\s+Same as main model/)
    assert.deepEqual(userSetting(), { mode: 'inherit' })
    assert.deepEqual(runtime.getInitialSettings().subagentModel, { mode: 'inherit' })
    await panel.press(KEYS.esc)
    assert.equal(userSetting(), undefined, 'Esc puts it back')
    assert.deepEqual(panel.closes, [['Config dialog dismissed', { display: 'system' }]])
  } finally { panel.close() }
})

test('Enter keeps the choice and the summary names it', async () => {
  setUserSetting(undefined)
  const panel = await openConfig()
  try {
    await openRow(panel, 'Auto')
    await panel.press(KEYS.down)
    await panel.press(KEYS.enter)
    await panel.waitFor(/Sub-agent model\s+Same as main model/)
    await panel.press(KEYS.enter)
    assert.match(panel.closes[0]?.[0] ?? '', /Set sub-agent model to .*Same as main model/)
    assert.deepEqual(userSetting(), { mode: 'inherit' })
  } finally {
    panel.close()
    setUserSetting(undefined)
  }
})

test('Custom picks a model of the current provider and keeps other providers\' picks', async () => {
  const initial = { mode: 'custom', models: { openai: 'gpt-6-sol' } }
  setUserSetting(initial)
  const panel = await openConfig()
  try {
    await openRow(panel, 'Custom: none for Anthropic, using Auto')
    // The current mode is focused, so Enter opens the model list; Enter
    // while it still loads is ignored, so wait for a focused model row.
    await panel.press(KEYS.enter)
    await panel.waitFor(/> claude-\S+ - Claude/)
    await panel.press(KEYS.enter)
    await panel.waitFor(/Sub-agent model\s+Custom: /)
    const saved = userSetting()
    assert.equal(saved.mode, 'custom')
    assert.equal(saved.models.openai, 'gpt-6-sol', 'another provider\'s pick stays')
    assert.equal(typeof saved.models.firstParty, 'string')
    assert.ok(saved.models.firstParty.length > 0)
    assert.match(panel.frame(), new RegExp(`Custom: ${saved.models.firstParty.replace(/[.[\]]/g, '\\$&')}`))
    await panel.press(KEYS.esc)
    assert.deepEqual(userSetting(), initial, 'Esc removes the pick made in this session')
  } finally {
    panel.close()
    setUserSetting(undefined)
  }
})

test('Esc in the model list goes back to the modes without saving', async () => {
  setUserSetting(undefined)
  const panel = await openConfig()
  try {
    await openRow(panel, 'Auto')
    await panel.press(KEYS.down)
    await panel.press(KEYS.down)
    await panel.press(KEYS.enter)
    await panel.waitFor(/> claude-\S+ - Claude/)
    await panel.press(KEYS.esc)
    await panel.waitFor(/Same as main model/)
    assert.equal(userSetting(), undefined)
    await panel.press(KEYS.esc)
    await panel.waitFor(/Sub-agent model\s+Auto/)
    assert.equal(userSetting(), undefined)
  } finally { panel.close() }
})
