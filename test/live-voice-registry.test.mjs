import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

// Run the production registry against an in-memory settings store. These tests
// cannot read or change a developer's saved accounts, keys, or preferences.
const registryPath = resolve('src/voice/voiceConversation.ts')
const bundled = await build({
  stdin: {
    contents: `export * from ${JSON.stringify(registryPath)}; export * from 'test:voice-settings';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  plugins: [{
    name: 'isolated-voice-settings',
    setup(builder) {
      builder.onResolve({ filter: /(?:test:voice-settings|utils\/settings\/(?:settings|changeDetector)\.js)$/ },
        () => ({ path: 'settings', namespace: 'test-settings' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-settings' }, () => ({
        contents: `
          export const state = { settings: {}, writes: [], changes: [], error: null };
          export function getInitialSettings() { return state.settings; }
          export function updateSettingsForSource(source, patch) {
            if (state.error) return { error: state.error };
            state.writes.push({ source, patch });
            state.settings = { ...state.settings, ...patch };
            return { error: null };
          }
          export const settingsChangeDetector = {
            notifyChange(source) { state.changes.push(source); }
          };
        `,
        loader: 'js',
      }))
    },
  }],
})
const voice = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

function reset(settings = {}) {
  Object.assign(voice.state, { settings, writes: [], changes: [], error: null })
}

test('all nine Codex voices resolve and the default is Sol', () => {
  assert.deepEqual(voice.LIVE_VOICE_VALUES, [
    'arbor', 'breeze', 'cove', 'ember', 'juniper', 'maple', 'sol', 'spruce', 'vale',
  ])
  for (const option of voice.LIVE_VOICE_OPTIONS) {
    reset({ heyVoiceName: option.value })
    assert.equal(voice.getSelectedLiveVoice(), option.value)
    assert.equal(voice.getLiveVoiceDisplayName(option.value), option.label)
  }
  reset()
  assert.equal(voice.getSelectedLiveVoice(), 'sol')
})

test('legacy Gemini and local settings migrate on read without rewriting preferences', () => {
  for (const oldVoice of ['Kore', 'gemini-2.5-flash-preview-tts', '', null, 42]) {
    const previous = {
      heyEnabled: true,
      heyVoiceProvider: 'gemini',
      heyVoiceModel: 'gemini-2.5-flash-preview-tts',
      heyVoiceName: oldVoice,
      model: 'coding-model',
    }
    reset(previous)
    assert.equal(voice.getSelectedLiveVoice(), 'sol')
    assert.equal(voice.state.settings, previous)
    assert.deepEqual(voice.state.writes, [])
    assert.deepEqual(voice.state.changes, [])
  }
  reset({ heyVoiceProvider: 'local', heyVoiceName: 'cove' })
  assert.equal(voice.getSelectedLiveVoice(), 'cove')
})

test('selecting a voice persists only the voice and immediately refreshes settings', () => {
  reset({ heyEnabled: true, model: 'coding-model', provider: 'gemini' })
  assert.deepEqual(voice.setSelectedLiveVoice('maple'), { error: null })
  assert.deepEqual(voice.state.writes, [{ source: 'userSettings', patch: { heyVoiceName: 'maple' } }])
  assert.deepEqual(voice.state.changes, ['userSettings'])
  assert.equal(voice.getSelectedLiveVoice(), 'maple')
  assert.equal(voice.state.settings.model, 'coding-model')
  assert.equal(voice.state.settings.provider, 'gemini')
  assert.equal(voice.state.settings.heyEnabled, true)
})

test('unsupported voice selections report an error without replacing the current voice', () => {
  reset({ heyVoiceName: 'spruce' })
  for (const value of ['Kore', 'gemini-2.5-pro-preview-tts', '', 'unknown', 'SOL']) {
    assert.ok(voice.setSelectedLiveVoice(value).error instanceof Error)
  }
  assert.equal(voice.getSelectedLiveVoice(), 'spruce')
  assert.deepEqual(voice.state.writes, [])
  assert.deepEqual(voice.state.changes, [])
})

test('failed writes keep the selected voice and do not report a settings change', () => {
  reset({ heyVoiceName: 'vale' })
  const error = new Error('Settings are not writable')
  voice.state.error = error
  assert.equal(voice.setSelectedLiveVoice('ember').error, error)
  assert.equal(voice.getSelectedLiveVoice(), 'vale')
  assert.deepEqual(voice.state.writes, [])
  assert.deepEqual(voice.state.changes, [])
})
