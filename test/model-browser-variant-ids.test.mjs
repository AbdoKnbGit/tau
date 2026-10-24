import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { KEYS, loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// The model browser lists Anthropic models once per effort, with the effort
// encoded in the row's id (`claude-opus-5-5::effort=medium`). No request
// accepts that id, so a consumer that saves a model must save the model's own
// id. These open the agent editor's model selector and the /surf wizard on
// the built bundle (`npm run build` first) and pick an Anthropic row, whose
// list needs no network.
const repoDir = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tau-variant-ids-'))
const configDir = join(scratch, 'config')
const projectDir = join(scratch, 'project')
mkdirSync(configDir)
mkdirSync(join(projectDir, '.git'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_TMPDIR = configDir
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
  paths: ['src/components/agents/ModelSelector.tsx', 'src/commands/surf/SurfWizard.tsx'],
  exports: ['ModelSelector', 'SurfWizard', 'getGlobalConfig', 'saveGlobalConfig'],
})

const ROW = /> (claude-\S+) - .*?◀ (\w+) effort ▶/

test('the agent model selector saves an Anthropic pick as the model\'s own id', async () => {
  const picks = []
  const panel = await mount(runtime, React.createElement(runtime.ModelSelector, {
    onComplete: (model, provider) => picks.push([model, provider]),
    onCancel: () => {},
  }), { columns: 110, rows: 40 })
  try {
    await panel.waitFor(/Browse provider models/)
    // Sonnet, Opus, Haiku, Inherit, then Browse.
    for (let i = 0; i < 4; i++) await panel.press(KEYS.down)
    await panel.press(KEYS.enter)
    await panel.waitFor(/Select the provider for this agent/)
    await panel.press(KEYS.enter)
    await panel.waitFor(ROW)
    const [, model] = panel.frame().match(ROW)
    await panel.press(KEYS.enter)
    assert.deepEqual(picks, [[model, 'firstParty']])
    assert.doesNotMatch(picks[0][0], /::/)
  } finally { panel.close() }
})

test('the /surf wizard saves an Anthropic pick as the model\'s own id, with the row\'s effort', async () => {
  runtime.saveGlobalConfig(current => ({ ...current, surfPhaseTargets: undefined }))
  const results = []
  const panel = await mount(runtime, React.createElement(runtime.SurfWizard, {
    onDone: result => results.push(result),
    initialProvider: 'firstParty',
  }), { columns: 110, rows: 40 })
  try {
    await panel.waitFor(/Pick a provider first/)
    await panel.press(KEYS.enter)
    await panel.waitFor(ROW)
    const [, model, effort] = panel.frame().match(ROW)
    await panel.press(KEYS.enter)
    // The effort step opens on the row's effort; Enter keeps it.
    await panel.waitFor(new RegExp(`Native effort for ${model.replace(/[.]/g, '\\.')}`))
    await panel.press(KEYS.enter)
    // Skip the other six phases.
    for (let i = 0; i < 6; i++) {
      await panel.waitFor(/Pick a provider first/)
      await panel.press('s')
    }
    assert.equal(results.length, 1, 'the wizard finished')
    const planning = runtime.getGlobalConfig().surfPhaseTargets?.planning
    assert.deepEqual(planning, { provider: 'firstParty', model, effort })
  } finally {
    panel.close()
    runtime.saveGlobalConfig(current => ({ ...current, surfPhaseTargets: undefined }))
  }
})
