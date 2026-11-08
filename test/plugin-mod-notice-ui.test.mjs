import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// A plugin's own transcript line ($.ui.log, a turn.complete text) must show in
// the default view; other informational rows stay behind verbose mode.
const previousCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-mod-notice-ui-'))
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
    'src/components/messages/SystemTextMessage.tsx',
    'src/utils/plugins/mods/lifecycle.ts',
    'src/utils/messages.ts',
  ],
  exports: ['SystemTextMessage', 'createModNoticeMessage', 'createSystemMessage', 'normalizeMessagesForAPI'],
})
const h = React.createElement
const dot = process.platform === 'darwin' ? '⏺' : '●'

async function screen(message, verbose) {
  const view = await mount(r, h(r.SystemTextMessage, { message, addMargin: false, verbose }))
  try {
    return view.frame()
  } finally {
    view.close()
  }
}

test('a plugin line draws dim with a dot outside verbose mode, and stays out of the model request', async () => {
  const notice = r.createModNoticeMessage('my-mod: build finished')
  for (const verbose of [false, true]) {
    const frame = await screen(notice, verbose)
    assert.ok(frame.includes(`${dot} my-mod: build finished`), frame)
  }
  assert.doesNotMatch(JSON.stringify(r.normalizeMessagesForAPI([notice], [])), /build finished/)
})

test('other informational rows still show only in verbose mode', async () => {
  const info = r.createSystemMessage('internal detail', 'info')
  assert.doesNotMatch(await screen(info, false), /internal detail/)
  assert.match(await screen(info, true), /internal detail/)
})
