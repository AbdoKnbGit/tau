import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Exercise the production preference and command against an in-memory store;
// loading this test never reads or writes the user's global configuration.
const bundled = await build({
  stdin: {
    contents: `
      export * from ${JSON.stringify(join(root, 'src/utils/compactionConfig.ts'))};
      export { call } from ${JSON.stringify(join(root, 'src/commands/compact-settings/compact-settings.tsx'))};
      export { state } from 'test:compaction-config';
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  plugins: [{
    name: 'isolated-compaction-config',
    setup(builder) {
      const replacements = [
        [/^(?:test:compaction-config|\.\/config\.js)$/, 'config'],
        [/\/services\/compact\/autoCompact\.js$/, 'engine'],
        [/\/utils\/model\/model\.js$/, 'model'],
        [/^\.\/CompactSettings\.js$/, 'panel'],
      ]
      for (const [filter, path] of replacements) {
        builder.onResolve({ filter }, () => ({ path, namespace: 'compaction-test' }))
      }
      builder.onLoad({ filter: /.*/, namespace: 'compaction-test' }, ({ path }) => ({
        contents: {
          config: `
            export const state = { config: {}, writes: [] };
            export function getGlobalConfig() { return state.config; }
            export function saveGlobalConfig(update) {
              const next = update(state.config);
              if (next !== state.config) state.writes.push(next);
              state.config = next;
            }
          `,
          engine: `export const describeAutoCompaction = () => ({
            contextWindow: 128000, threshold: 95000,
            thresholdShareOfWindow: 74.21875, headroomTokens: 33000,
            reservedTokens: 20000, source: 'auto', clampedByReserve: false,
          });`,
          model: 'export const getMainLoopModel = () => "test-model";',
          panel: 'export const CompactSettings = () => null;',
        }[path],
        loader: 'js',
      }))
    },
  }],
})
const config = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

function reset(value = {}) {
  Object.assign(config.state, { config: value, writes: [] })
}

test('retention requires an explicit true, without rewriting malformed settings', () => {
  for (const value of [undefined, false, null, 'true', 'false', 1, 0, {}, []]) {
    const saved = { autoCompactPreserveRecent: value }
    reset(saved)
    assert.equal(config.isRecentContextPreservationEnabled(), false)
    assert.equal(config.state.config, saved)
    assert.deepEqual(config.state.writes, [])
  }
  reset({ autoCompactPreserveRecent: true })
  assert.equal(config.isRecentContextPreservationEnabled(), true)
})

test('changing retention preserves other preferences and is idempotent', () => {
  reset({ autoCompactThresholdPercent: 65, autoCompactWindowTokens: 200000, theme: 'dark' })
  config.setRecentContextPreservationEnabled(true)
  assert.deepEqual(config.state.config, {
    autoCompactThresholdPercent: 65, autoCompactWindowTokens: 200000,
    theme: 'dark', autoCompactPreserveRecent: true,
  })
  const saved = config.state.config
  config.setRecentContextPreservationEnabled(true)
  assert.equal(config.state.config, saved)
  assert.equal(config.state.writes.length, 1)
  config.setRecentContextPreservationEnabled(false)
  assert.equal(config.isRecentContextPreservationEnabled(), false)
  assert.equal(config.state.config.theme, 'dark')
})

test('status reports retention and its scope without changing preferences', async () => {
  for (const enabled of [false, true]) {
    reset({ autoCompactPreserveRecent: enabled })
    const messages = []
    await config.call(message => messages.push(message), {}, ' status ')
    assert.equal(messages.length, 1)
    assert.ok(messages[0].includes(`Preserve recent context: ${enabled ? 'On' : 'Off'}`))
    assert.match(messages[0], /main conversation's automatic compaction only/)
    assert.match(messages[0], /manual \/compact and subagents unchanged/)
    assert.deepEqual(config.state.writes, [])
  }
})

test('reset and its existing auto alias restore retention Off and preserve unrelated settings', async () => {
  for (const arg of ['reset', 'auto']) {
    reset({ autoCompactPreserveRecent: true, autoCompactThresholdPercent: 65,
      autoCompactWindowTokens: 200000, theme: 'dark' })
    const messages = []
    await config.call(message => messages.push(message), {}, arg)
    assert.equal(config.state.config.autoCompactPreserveRecent, false)
    assert.equal(config.getConfiguredThresholdPercent(), undefined)
    assert.equal(config.getConfiguredWindowCap(), undefined)
    assert.equal(config.state.config.theme, 'dark')
    assert.match(messages[0], /reset to defaults/)
    assert.match(messages[0], /Preserve recent context: Off/)
  }
})

test('help and invalid arguments do not change retention', async () => {
  for (const arg of ['help', '--help', 'on']) {
    reset({ autoCompactPreserveRecent: false })
    const messages = []
    await config.call(message => messages.push(message), {}, arg)
    assert.match(messages[0], /Off by default/)
    assert.match(messages[0], /reduced or omitted/)
    assert.deepEqual(config.state.writes, [])
  }
})
