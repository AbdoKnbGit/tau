import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const originalCwd = process.cwd()
const directory = mkdtempSync(join(tmpdir(), 'tau-model-shortcut-hooks-'))
const project = join(directory, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(directory, 'config'), CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
after(() => {
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true, maxRetries: 10 })
})
const r = await loadMcpRuntime({
  paths: ['src/utils/hooks/commitModelSwitch.ts', 'src/commands/fast/fast.tsx', 'src/utils/hooks/hooksConfigManager.ts'],
  exports: [
    'commitModelSwitch', 'restoreModelSnapshot', 'applyFastMode', 'HOOK_EVENTS', 'getHookEventMetadata', 'groupHooksByEventAndMatcher',
    'getSwitchDeps: () => ({ executeHooks, updateSettingsForSource, clearFastModeCooldown, getFastModeModel, isFastModeSupportedByModel })',
    `setSwitchDeps: d => {
      executeHooks = d.executeHooks;
      updateSettingsForSource = d.updateSettingsForSource;
      clearFastModeCooldown = d.clearFastModeCooldown;
      getFastModeModel = d.getFastModeModel;
      isFastModeSupportedByModel = d.isFastModeSupportedByModel;
    }`,
  ],
})
const iterable = values => (async function* () { yield* values })()
function context() {
  const state = { ...fixtureContext([]).getAppState(), mainLoopModel: 'claude-sonnet-4-6', mainLoopModelForSession: null, fastMode: false }
  return fixtureContext([], { getAppState: () => state, setAppState: update => Object.assign(state, update(state)), setMessages() {} })
}
async function withDeps(dependencies, run) {
  const saved = r.getSwitchDeps()
  const changes = []
  r.setSwitchDeps({ ...saved, executeHooks: () => iterable([]),
    updateSettingsForSource: (...args) => changes.push(['settings', ...args]),
    clearFastModeCooldown: () => changes.push(['cooldown']),
    getFastModeModel: () => 'claude-opus-4-6',
    isFastModeSupportedByModel: model => model === 'claude-opus-4-6', ...dependencies })
  try { await run(changes) } finally { r.setSwitchDeps(saved) }
}

test('settings and hotkey preflight refuse deny/ask without running deferred selection effects', async () => {
  for (const behavior of ['deny', 'ask']) {
    const ctx = context()
    let prompted = 0
    let committed = 0
    ctx.requestPrompt = () => async () => { prompted++; return { selected: 'allow' } }
    await withDeps({ executeHooks: () => iterable([{ permissionBehavior: behavior, hookPermissionDecisionReason: 'policy reason' }]) }, async () => {
      const decision = await r.commitModelSwitch({ model: 'claude-opus-4-6', source: 'picker', context: ctx, commit: () => committed++ })
      assert.equal(decision.allowed, false)
      assert.equal(decision.reason, 'policy reason')
      assert.equal(committed, 0)
      assert.equal(prompted, 0)
      assert.equal(ctx.getAppState().mainLoopModel, 'claude-sonnet-4-6')
    })
  }
})

test('allowed selection commits before PostModelSwitch and forwards hook messages', async () => {
  const ctx = context()
  const order = []
  const notice = { type: 'system', content: 'selection hook notice' }
  let displayed
  await withDeps({ executeHooks: ({ hookInput }) => {
    order.push(hookInput.hook_event_name)
    if (hookInput.hook_event_name === 'PostModelSwitch') assert.equal(ctx.getAppState().mainLoopModel, 'claude-opus-4-6')
    return iterable(hookInput.hook_event_name === 'PreModelSwitch' ? [{ message: notice }] : [])
  } }, async () => {
    const decision = await r.commitModelSwitch({ model: 'claude-opus-4-6', source: 'picker', context: ctx,
      onMessages: messages => { displayed = messages }, commit: () => {
        order.push('committed')
        ctx.setAppState(previous => ({ ...previous, mainLoopModel: 'claude-opus-4-6' }))
      } })
    assert.equal(decision.allowed, true)
    assert.deepEqual(displayed, [notice])
    assert.deepEqual(order, ['PreModelSwitch', 'committed', 'PostModelSwitch'])
  })
})

test('cancelled or superseded async selections cannot mutate the newer model', async () => {
  for (const superseded of [false, true]) {
    const ctx = context()
    let active = true
    let release
    let committed = false
    await withDeps({ executeHooks: () => (async function* () { await new Promise(resolve => { release = resolve }) })() }, async () => {
      const pending = r.commitModelSwitch({ model: 'claude-opus-4-6', source: 'picker', context: ctx,
        isActive: () => active, commit: () => { committed = true } })
      if (superseded) ctx.setAppState(previous => ({ ...previous, mainLoopModel: 'claude-haiku-4-5' }))
      else active = false
      release()
      assert.equal((await pending).allowed, false)
      assert.equal(committed, false)
    })
  }
})

test('fast mode cannot persist settings or clear cooldown when its required model switch is denied', async () => {
  const ctx = context()
  await withDeps({ executeHooks: () => iterable([{ permissionBehavior: 'deny', hookPermissionDecisionReason: 'fast model denied' }]) }, async changes => {
    assert.equal(await r.applyFastMode(true, ctx.setAppState, ctx), 'fast model denied')
    assert.deepEqual(changes, [])
    assert.equal(ctx.getAppState().fastMode, false)
    assert.equal(ctx.getAppState().mainLoopModel, 'claude-sonnet-4-6')
  })
})

test('fast mode guards the effective session override and applies allowed switches', async () => {
  const ctx = context()
  ctx.setAppState(previous => ({ ...previous, mainLoopModel: 'claude-opus-4-6', mainLoopModelForSession: 'claude-sonnet-4-6' }))
  const events = []
  await withDeps({ executeHooks: ({ hookInput }) => { events.push(hookInput); return iterable([]) } }, async changes => {
    assert.equal(await r.applyFastMode(true, ctx.setAppState, ctx), undefined)
    assert.equal(ctx.getAppState().fastMode, true)
    assert.equal(ctx.getAppState().mainLoopModelForSession, null)
    assert.deepEqual(changes, [['cooldown'], ['settings', 'userSettings', { fastMode: true }]])
    assert.equal(events[0].from_model, 'claude-sonnet-4-6')
    assert.deepEqual(events.map(event => event.hook_event_name), ['PreModelSwitch', 'PostModelSwitch'])
  })
})

test('config rollback preserves model, effort, fast mode and their persisted settings when denied', async () => {
  const ctx = context()
  ctx.setAppState(previous => ({ ...previous, mainLoopModel: 'claude-opus-4-6', fastMode: true, effortValue: 'high' }))
  let settingsRestored = false
  await withDeps({ executeHooks: () => iterable([{ permissionBehavior: 'deny', hookPermissionDecisionReason: 'rollback denied' }]) }, async () => {
    const result = await r.restoreModelSnapshot({
      snapshot: { mainLoopModel: 'claude-sonnet-4-6', mainLoopModelForSession: null, fastMode: false, effortValue: 'low' },
      context: ctx, commitSettings: () => { settingsRestored = true },
    })
    assert.equal(result.allowed, false)
    assert.equal(settingsRestored, false)
    assert.equal(ctx.getAppState().mainLoopModel, 'claude-opus-4-6')
    assert.equal(ctx.getAppState().fastMode, true)
    assert.equal(ctx.getAppState().effortValue, 'high')
  })
})

test('allowed config rollback restores session override and related state together', async () => {
  const ctx = context()
  const snapshot = { mainLoopModel: 'claude-sonnet-4-6', mainLoopModelForSession: 'claude-opus-4-6', fastMode: true, effortValue: 'high' }
  let settingsRestored = false
  await withDeps({}, async () => {
    assert.equal((await r.restoreModelSnapshot({ snapshot, context: ctx, commitSettings: () => { settingsRestored = true } })).allowed, true)
    assert.equal(settingsRestored, true)
    for (const [key, value] of Object.entries(snapshot)) assert.equal(ctx.getAppState()[key], value)
  })
})

test('every supported hook event has menu metadata and a grouping bucket', () => {
  const metadata = r.getHookEventMetadata(['Read', 'Write'])
  const grouped = r.groupHooksByEventAndMatcher(context().getAppState(), ['Read', 'Write'])
  for (const event of r.HOOK_EVENTS) {
    assert.ok(metadata[event]?.summary, `${event} metadata`)
    assert.ok(metadata[event]?.description, `${event} description`)
    assert.ok(grouped[event], `${event} group`)
  }
})
