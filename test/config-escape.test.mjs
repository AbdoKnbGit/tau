import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import ts from 'typescript'
import { KEYS, loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// Esc in /config means cancel. Every change is saved the moment it is made,
// so Esc has to write the starting values back. These tests open the real
// /config panel, flip a setting and press Esc the way a user does. Runs
// against the built bundle (`npm run build` first), with a throwaway config
// folder and project.
const repoDir = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tau-config-escape-'))
const configDir = join(scratch, 'config')
const projectDir = join(scratch, 'project')
mkdirSync(configDir)
mkdirSync(join(projectDir, '.git'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_TMPDIR = configDir
process.chdir(projectDir)
after(async () => {
  process.chdir(repoDir)
  // The panel leaves short-lived children running in the project folder
  // (git check-ignore after a local settings write, npm config get prefix for
  // diagnostics), and Windows won't delete a folder a process runs in.
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
  exports: ['Settings'],
})

const localFile = join(projectDir, '.claude', 'settings.local.json')
const localSettings = () => existsSync(localFile) ? JSON.parse(readFileSync(localFile, 'utf8')) : {}

/** Opens the panel the way /config does; `closes` records its onClose calls. */
async function openConfig() {
  const closes = []
  const panel = await mount(runtime, React.createElement(runtime.Settings, {
    onClose: (result, options) => closes.push([result, options]),
    context: { messages: [], options: { mcpClients: [] } },
    defaultTab: 'Config',
  }), { columns: 100, rows: 40 })
  // The Config tab suspends on memory files before it first draws.
  await panel.waitFor(/Search settings/)
  return Object.assign(panel, { closes })
}

/** Filters the list to `row`, flips it with Space, checks the save, presses Esc. */
async function flipThenEsc(panel, query, row, key) {
  await panel.type(query)
  await panel.press(KEYS.down)
  assert.match(panel.frame(), new RegExp(`❯ ${row}\\s+true`))
  await panel.press(KEYS.space)
  assert.equal(localSettings()[key], false, 'Space saves the change at once')
  await panel.press(KEYS.esc)
}

// Keep this test first. On the first /config of a session the Config tab
// registers its Esc handler after the panel's own, which used to win: the
// panel closed and nothing was undone.
test('Esc on the first /config of a session undoes Display images', async () => {
  const panel = await openConfig()
  try {
    await flipThenEsc(panel, 'images', 'Display images', 'inlineImagesEnabled')
    assert.deepEqual(panel.closes, [['Config dialog dismissed', { display: 'system' }]])
    assert.equal(localSettings().inlineImagesEnabled, undefined, 'Esc puts it back')
  } finally { panel.close() }
})

test('Esc undoes Draw diagrams', async () => {
  const panel = await openConfig()
  try {
    await flipThenEsc(panel, 'diagrams', 'Draw diagrams', 'mermaidDiagrams')
    assert.deepEqual(panel.closes, [['Config dialog dismissed', { display: 'system' }]])
    assert.equal(localSettings().mermaidDiagrams, undefined, 'Esc puts it back')
  } finally { panel.close() }
})

test('every setting /config saves to a settings file is one Esc restores', () => {
  const path = join(repoDir, 'src/components/Settings/Config.tsx')
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const text = node => node.getText(file)

  /** Top-level keys a settings object passed to updateSettingsForSource writes. */
  function keysOf(expr) {
    if (ts.isParenthesizedExpression(expr)) return keysOf(expr.expression)
    if (ts.isConditionalExpression(expr)) return [...keysOf(expr.whenTrue), ...keysOf(expr.whenFalse)]
    if (ts.isObjectLiteralExpression(expr)) {
      return expr.properties.flatMap(p => ts.isSpreadAssignment(p) ? keysOf(p.expression) : [text(p.name)])
    }
    if (ts.isIdentifier(expr)) {
      // A local object built up first, like `const newSettings: {...} = {...}`.
      let decl
      const find = node => {
        if (!decl && ts.isVariableDeclaration(node) && text(node.name) === text(expr)) decl = node
        ts.forEachChild(node, find)
      }
      find(file)
      assert.ok(decl, `no declaration for ${text(expr)}`)
      const typed = decl.type && ts.isTypeLiteralNode(decl.type) ? decl.type.members.map(m => text(m.name)) : []
      return [...typed, ...(decl.initializer ? keysOf(decl.initializer) : [])]
    }
    assert.fail(`can't tell which settings ${text(expr)} writes; teach this test`)
  }

  const saved = {}
  const restored = {}
  function visit(node, inRevert) {
    if (ts.isVariableDeclaration(node) && text(node.name) === 'revertChanges') inRevert = true
    if (ts.isCallExpression(node) && text(node.expression) === 'updateSettingsForSource') {
      const [source, settings] = node.arguments
      const into = inRevert ? restored : saved
      for (const key of keysOf(settings)) (into[source.text] ??= new Set()).add(key)
    }
    ts.forEachChild(node, child => visit(child, inRevert))
  }
  visit(file, false)

  assert.ok(saved.localSettings?.size && saved.userSettings?.size, 'found the settings /config saves')
  for (const [source, keys] of Object.entries(saved)) {
    const missing = [...keys].filter(key => !restored[source]?.has(key))
    assert.deepEqual(missing, [], `${source} keys /config saves but Esc leaves changed`)
  }
})
