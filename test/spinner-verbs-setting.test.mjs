import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { KEYS, loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// Spinner verbs: what each /config choice saves, what the spinner and the line
// after a turn then show, and the picker driven key by key. Runs against the
// built bundle (`npm run build` first). Settings live in a throwaway config
// folder and project, so neither your home nor this repo's .claude leaks in.
const repoDir = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tau-spinner-verbs-'))
const configDir = join(scratch, 'config')
const projectDir = join(scratch, 'project')
mkdirSync(configDir)
mkdirSync(projectDir)
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_TMPDIR = configDir
process.chdir(projectDir)
after(() => {
  process.chdir(repoDir)
  rmSync(scratch, { recursive: true, force: true })
})

const runtime = await loadBuiltRuntime({
  paths: [
    'src/utils/settings/settings.ts',
    'src/constants/spinnerVerbs.ts',
    'src/constants/turnCompletionVerbs.ts',
    'src/components/SpinnerVerbsPicker.tsx',
  ],
  exports: [
    'getSpinnerVerbs', 'getTurnCompletionVerbs', 'describeSpinnerVerbs',
    'normalizeCustomSpinnerVerb', 'SPINNER_VERBS', 'TURN_COMPLETION_VERBS',
    'updateSettingsForSource', 'resetSettingsCache', 'SpinnerVerbsPicker',
  ],
})

const settingsFile = join(configDir, 'settings.json')
const userSettings = () => JSON.parse(readFileSync(settingsFile, 'utf8'))

/** Saves the way /config does: user settings, undefined deletes the key. */
function save(spinnerVerbs) {
  assert.equal(runtime.updateSettingsForSource('userSettings', { spinnerVerbs }).error, null)
}

/** Writes settings.json the way someone editing it by hand would. */
function writeByHand(settings) {
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
  runtime.resetSettingsCache()
}

test('with no setting, the spinner and the line after a turn use the built-in verbs', () => {
  writeByHand({})
  assert.equal(runtime.describeSpinnerVerbs(undefined), 'On')
  assert.deepEqual(runtime.getSpinnerVerbs(), runtime.SPINNER_VERBS)
  assert.deepEqual(runtime.getTurnCompletionVerbs(), runtime.TURN_COMPLETION_VERBS)
})

test('Off, Custom and On save a shape every build reads, and both lines follow', () => {
  writeByHand({ theme: 'dark' })

  save({ mode: 'replace', verbs: ['Working'] })
  assert.deepEqual(userSettings(), { theme: 'dark', spinnerVerbs: { mode: 'replace', verbs: ['Working'] } })
  assert.equal(runtime.describeSpinnerVerbs(userSettings().spinnerVerbs), 'Off')
  assert.deepEqual(runtime.getSpinnerVerbs(), ['Working'])
  assert.deepEqual(runtime.getTurnCompletionVerbs(), ['Worked'])

  save({ mode: 'replace', verbs: ['Thinking'] })
  assert.equal(runtime.describeSpinnerVerbs(userSettings().spinnerVerbs), 'Custom: Thinking')
  assert.deepEqual(runtime.getSpinnerVerbs(), ['Thinking'])
  assert.deepEqual(runtime.getTurnCompletionVerbs(), ['Worked'])

  save(undefined)
  assert.deepEqual(userSettings(), { theme: 'dark' }, 'On removes the key and nothing else')
  assert.deepEqual(runtime.getSpinnerVerbs(), runtime.SPINNER_VERBS)
  assert.deepEqual(runtime.getTurnCompletionVerbs(), runtime.TURN_COMPLETION_VERBS)
})

test('a list written by hand reads as a custom list; an empty one reads as On', () => {
  writeByHand({ spinnerVerbs: { mode: 'append', verbs: ['Shipping', 'Debugging'] } })
  assert.equal(runtime.describeSpinnerVerbs(userSettings().spinnerVerbs), 'Custom list')
  assert.deepEqual(runtime.getSpinnerVerbs(), [...runtime.SPINNER_VERBS, 'Shipping', 'Debugging'])
  assert.deepEqual(runtime.getTurnCompletionVerbs(), runtime.TURN_COMPLETION_VERBS)

  writeByHand({ spinnerVerbs: { mode: 'replace', verbs: ['Shipping', 'Debugging'] } })
  assert.equal(runtime.describeSpinnerVerbs(userSettings().spinnerVerbs), 'Custom list')
  assert.deepEqual(runtime.getTurnCompletionVerbs(), ['Worked'])

  // An empty list falls back to the built-in verbs, so it is On in effect.
  writeByHand({ spinnerVerbs: { mode: 'replace', verbs: [] } })
  assert.equal(runtime.describeSpinnerVerbs(userSettings().spinnerVerbs), 'On')
  assert.deepEqual(runtime.getSpinnerVerbs(), runtime.SPINNER_VERBS)
  assert.deepEqual(runtime.getTurnCompletionVerbs(), runtime.TURN_COMPLETION_VERBS)
  writeByHand({})
})

test('a typed verb is cleaned to one line, without the dots the spinner adds itself', () => {
  assert.equal(runtime.normalizeCustomSpinnerVerb('  Thinking...  '), 'Thinking')
  assert.equal(runtime.normalizeCustomSpinnerVerb('Deep\n  thinking…'), 'Deep thinking')
  assert.equal(runtime.normalizeCustomSpinnerVerb('. . .'), '')
})

/** Mounts the picker; `outcomes` records what it hands back. */
async function openPicker(initial) {
  const outcomes = []
  const picker = await mount(runtime, React.createElement(runtime.SpinnerVerbsPicker, {
    initial,
    onComplete: value => outcomes.push(['complete', value]),
    onCancel: () => outcomes.push(['cancel']),
  }))
  return Object.assign(picker, { outcomes })
}

test('the picker lists the three choices, with the cursor on the current one', async () => {
  const fresh = await openPicker(undefined)
  try {
    const frame = fresh.frame()
    assert.match(frame, /Choose what the spinner says while Tau works:/)
    assert.match(frame, /❯ 1\. On/)
    assert.match(frame, /A random verb each time \(default\)/)
    assert.match(frame, /2\. Off/)
    assert.match(frame, /Always "Working…"/)
    assert.match(frame, /3\. Custom/)
    assert.doesNotMatch(frame, /own list of verbs/)
  } finally { fresh.close() }

  const custom = await openPicker({ mode: 'replace', verbs: ['Thinking'] })
  try {
    assert.match(custom.frame(), /❯ 3\. Custom: Thinking/)
  } finally { custom.close() }

  const list = await openPicker({ mode: 'append', verbs: ['Shipping', 'Debugging'] })
  try {
    assert.match(list.frame(), /Your settings\.json has its own list of verbs/)
  } finally { list.close() }
})

test('Enter on Off or On saves that choice', async () => {
  const off = await openPicker(undefined)
  try {
    await off.press(KEYS.down)
    await off.press(KEYS.enter)
    assert.deepEqual(off.outcomes, [['complete', { mode: 'replace', verbs: ['Working'] }]])
  } finally { off.close() }

  const on = await openPicker({ mode: 'replace', verbs: ['Thinking'] })
  try {
    await on.press(KEYS.up)
    await on.press(KEYS.up)
    await on.press(KEYS.enter)
    assert.deepEqual(on.outcomes, [['complete', undefined]])
  } finally { on.close() }
})

test('Custom saves the typed verb, and letters like n type instead of cancelling', async () => {
  const picker = await openPicker(undefined)
  try {
    await picker.press(KEYS.down)
    await picker.press(KEYS.down)
    await picker.type('Planning...')
    assert.match(picker.frame(), /Custom: Planning\.\.\./)
    assert.deepEqual(picker.outcomes, [])
    await picker.press(KEYS.enter)
    assert.deepEqual(picker.outcomes, [['complete', { mode: 'replace', verbs: ['Planning'] }]])
  } finally { picker.close() }

  const edit = await openPicker({ mode: 'replace', verbs: ['Thinking'] })
  try {
    await edit.press('\x7f'.repeat('Thinking'.length))
    await edit.type('Cooking')
    await edit.press(KEYS.enter)
    assert.deepEqual(edit.outcomes, [['complete', { mode: 'replace', verbs: ['Cooking'] }]])
  } finally { edit.close() }
})

test('Esc cancels from the list and from the text field; nothing usable typed saves nothing', async () => {
  const list = await openPicker(undefined)
  try {
    await list.press(KEYS.esc)
    assert.deepEqual(list.outcomes, [['cancel']])
  } finally { list.close() }

  const typing = await openPicker(undefined)
  try {
    await typing.press(KEYS.down)
    await typing.press(KEYS.down)
    await typing.type('Thin')
    await typing.press(KEYS.esc)
    assert.deepEqual(typing.outcomes, [['cancel']])
  } finally { typing.close() }

  const dots = await openPicker(undefined)
  try {
    await dots.press(KEYS.down)
    await dots.press(KEYS.down)
    await dots.type('...')
    await dots.press(KEYS.enter)
    assert.deepEqual(dots.outcomes, [['cancel']])
  } finally { dots.close() }
})
