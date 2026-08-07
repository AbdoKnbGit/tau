import { beforeEach, describe, expect, test } from 'bun:test'
import { CHEAP_MODE_CORE_TOOL_NAME_SET } from '../constants/cheapModeTools.js'
import { PREBUILT_TOOL_TOGGLE_ITEMS } from '../constants/prebuiltToolToggles.js'
import {
  applyPowerModeTheme,
  getPowerModeWordmarkPalette,
  initializePowerModeTheme,
  isPowerModeThemeTransitionActive,
  setPowerModeTheme,
} from './modeTheme.js'
import {
  getPowerModeFromSettings,
  isNormalToolingMode,
  normalizePowerMode,
  POWER_MODES,
  resetSessionPowerModeForTesting,
  seedSessionPowerMode,
  setSessionPowerMode,
} from './powerMode.js'
import {
  filterDisabledPrebuiltTools,
  getDisabledPrebuiltToolIds,
} from './prebuiltToolToggles.js'
import { getTheme } from './theme.js'

describe('power mode', () => {
  // Every test starts with an unpinned session so the pure resolver is
  // exercised except where a test explicitly pins.
  beforeEach(() => resetSessionPowerModeForTesting())

  test('normalizes names and aliases', () => {
    expect(normalizePowerMode('cheap')).toBe('cheap')
    expect(normalizePowerMode(' ECO ')).toBe('cheap')
    expect(normalizePowerMode('normal')).toBe('normal')
    expect(normalizePowerMode('default')).toBe('normal')
    expect(normalizePowerMode('rust')).toBe('rust')
    expect(normalizePowerMode('RustCode')).toBe('rust')
    expect(normalizePowerMode('full')).toBe('full')
    expect(normalizePowerMode('FullPower')).toBe('full')
    expect(normalizePowerMode('max')).toBe('full')
    expect(normalizePowerMode('bogus')).toBeNull()
    expect(normalizePowerMode('')).toBeNull()
  })

  test('resolves settings values with safe fallback', () => {
    expect(getPowerModeFromSettings(undefined)).toBe('normal')
    expect(getPowerModeFromSettings({})).toBe('normal')
    expect(getPowerModeFromSettings({ powerMode: 'cheap' })).toBe('cheap')
    expect(getPowerModeFromSettings({ powerMode: 'rust' })).toBe('rust')
    expect(getPowerModeFromSettings({ powerMode: 'full' })).toBe('full')
    expect(getPowerModeFromSettings({ powerMode: 'normal' })).toBe('normal')
  })

  test('rust deliberately inherits normal tool behavior', () => {
    expect(isNormalToolingMode('normal')).toBe(true)
    expect(isNormalToolingMode('rust')).toBe(true)
    expect(isNormalToolingMode('cheap')).toBe(false)
    expect(isNormalToolingMode('full')).toBe(false)
  })

  test('cheap mode forces every optional toggle off', () => {
    const disabled = getDisabledPrebuiltToolIds({
      powerMode: 'cheap',
      disabledPrebuiltTools: [],
    })
    expect(disabled.size).toBe(PREBUILT_TOOL_TOGGLE_ITEMS.length)
  })

  test('full mode forces every optional toggle on', () => {
    const disabled = getDisabledPrebuiltToolIds({
      powerMode: 'full',
      disabledPrebuiltTools: PREBUILT_TOOL_TOGGLE_ITEMS.map(item => item.id),
    })
    expect(disabled.size).toBe(0)
  })

  test('normal mode preserves saved toggles', () => {
    const first = PREBUILT_TOOL_TOGGLE_ITEMS[0]!
    const disabled = getDisabledPrebuiltToolIds({
      disabledPrebuiltTools: [first.id],
    })
    expect(disabled.has(first.id)).toBe(true)
    expect(disabled.size).toBe(1)
  })

  test('rust mode preserves normal tool toggles', () => {
    const first = PREBUILT_TOOL_TOGGLE_ITEMS[0]!
    const disabled = getDisabledPrebuiltToolIds({
      powerMode: 'rust',
      disabledPrebuiltTools: [first.id],
    })
    expect(disabled.has(first.id)).toBe(true)
    expect(disabled.size).toBe(1)
  })

  // filterDisabledPrebuiltTools is the shared filter both getTools() and
  // mergeAndFilterTools() apply — the exact function the live tool pool
  // flows through on every turn.
  test('tool filtering follows the mode at the shared choke point', () => {
    const optionalName = PREBUILT_TOOL_TOGGLE_ITEMS[0]!.toolNames[0]!
    const pool = [{ name: 'Bash' }, { name: optionalName }]

    const cheap = filterDisabledPrebuiltTools(pool, { powerMode: 'cheap' })
    expect(cheap.map(t => t.name)).toEqual(['Bash'])

    const full = filterDisabledPrebuiltTools(pool, {
      powerMode: 'full',
      disabledPrebuiltTools: [PREBUILT_TOOL_TOGGLE_ITEMS[0]!.id],
    })
    expect(full.map(t => t.name)).toEqual(['Bash', optionalName])

    const normal = filterDisabledPrebuiltTools(pool, {
      disabledPrebuiltTools: [PREBUILT_TOOL_TOGGLE_ITEMS[0]!.id],
    })
    expect(normal.map(t => t.name)).toEqual(['Bash'])

    // Deterministic within a mode — the tool list (and the prompt-cache
    // prefix derived from it) must not oscillate between turns.
    const again = filterDisabledPrebuiltTools(pool, { powerMode: 'cheap' })
    expect(again.map(t => t.name)).toEqual(cheap.map(t => t.name))
  })

  // The clamp lives in getTools() and mergeAndFilterTools(); both filter by
  // this set. Pins the allowlist contract: core in, agents/skills/aux out.
  test('cheap core allowlist keeps core tools and excludes agents/skills', () => {
    expect(CHEAP_MODE_CORE_TOOL_NAME_SET.has('Bash')).toBe(true)
    expect(CHEAP_MODE_CORE_TOOL_NAME_SET.has('Read')).toBe(true)
    expect(CHEAP_MODE_CORE_TOOL_NAME_SET.has('Edit')).toBe(true)
    expect(CHEAP_MODE_CORE_TOOL_NAME_SET.has('Write')).toBe(true)
    // Snapshot save/list/diff/restore stays available in cheap mode — it's a
    // core safety tool (undo layer), not an optional prebuilt.
    expect(CHEAP_MODE_CORE_TOOL_NAME_SET.has('Snapshot')).toBe(true)
    expect(CHEAP_MODE_CORE_TOOL_NAME_SET.has('Agent')).toBe(false)
    expect(CHEAP_MODE_CORE_TOOL_NAME_SET.has('Skill')).toBe(false)
  })

  // The session pin is the fix for the cross-session mode leak: a running
  // session must keep its own mode even when the shared settings.json changes
  // under it (another Tau session's /mode, surfaced live by the file watcher).
  test('a pinned session ignores external settings changes', () => {
    setSessionPowerMode('normal')
    // The watcher hands us fresh settings that say cheap — must NOT switch us.
    expect(getPowerModeFromSettings({ powerMode: 'cheap' })).toBe('normal')
    expect(getPowerModeFromSettings({ powerMode: 'full' })).toBe('normal')
  })

  test("this session's own /mode still updates the pin", () => {
    setSessionPowerMode('normal')
    setSessionPowerMode('cheap')
    expect(getPowerModeFromSettings({ powerMode: 'normal' })).toBe('cheap')
  })

  test('seeding pins once from persisted settings and is idempotent', () => {
    seedSessionPowerMode({ powerMode: 'cheap' })
    expect(getPowerModeFromSettings({ powerMode: 'normal' })).toBe('cheap')
    // A later re-seed (e.g. /clear rebuilding app state) must not adopt a value
    // a concurrent session wrote to the shared file in the meantime.
    seedSessionPowerMode({ powerMode: 'normal' })
    expect(getPowerModeFromSettings({ powerMode: 'normal' })).toBe('cheap')
  })

  test('before seeding, resolution stays pure (settings win)', () => {
    expect(getPowerModeFromSettings({ powerMode: 'cheap' })).toBe('cheap')
    expect(getPowerModeFromSettings(undefined)).toBe('normal')
  })
})

describe('power mode theme overlay', () => {
  test('normal mode returns the base theme object untouched', () => {
    initializePowerModeTheme('normal')
    setPowerModeTheme('normal', { animate: false })
    const theme = getTheme('dark')
    // Identity check: the fast path must not allocate a new theme object.
    expect(getTheme('dark')).toBe(theme)
  })

  test('cheap/rust/full tint accent slots but keep text and semantics', () => {
    setPowerModeTheme('normal', { animate: false })
    const base = getTheme('dark')

    setPowerModeTheme('cheap', { animate: false })
    const bronze = getTheme('dark')
    expect(bronze.brand).not.toBe(base.brand)
    expect(bronze.claude).not.toBe(base.claude)
    expect(bronze.text).toBe(base.text)
    expect(bronze.error).toBe(base.error)
    expect(bronze.background).toBe(base.background)

    setPowerModeTheme('rust', { animate: false })
    const green = getTheme('dark')
    expect(green.brand).not.toBe(base.brand)
    expect(green.brand).not.toBe(bronze.brand)
    expect(green.text).toBe(base.text)
    expect(green.error).toBe(base.error)
    expect(green.background).toBe(base.background)

    setPowerModeTheme('full', { animate: false })
    const gold = getTheme('dark')
    expect(gold.brand).not.toBe(base.brand)
    expect(gold.brand).not.toBe(bronze.brand)
    expect(gold.text).toBe(base.text)

    // Light themes get their own (darker) accent values for contrast.
    const goldLight = getTheme('light')
    expect(goldLight.brand).not.toBe(gold.brand)

    setPowerModeTheme('normal', { animate: false })
    expect(getTheme('dark').brand).toBe(base.brand)
  })

  test('animated switch interpolates and settles on the target', async () => {
    setPowerModeTheme('normal', { animate: false })
    const base = getTheme('dark')

    setPowerModeTheme('full', { durationMs: 40 })
    expect(isPowerModeThemeTransitionActive()).toBe(true)
    const mid = getTheme('dark')
    expect(mid.brand).toMatch(/^rgb\(\d+,\d+,\d+\)$/)

    await new Promise(resolve => setTimeout(resolve, 80))
    expect(isPowerModeThemeTransitionActive()).toBe(false)
    const settled = getTheme('dark')
    expect(settled.brand).not.toBe(base.brand)
    // Settled value must be exactly the stable full-power palette.
    setPowerModeTheme('full', { animate: false })
    expect(getTheme('dark').brand).toBe(settled.brand)

    setPowerModeTheme('normal', { animate: false })
  })

  test('wordmark palette follows power mode and animated transitions', async () => {
    setPowerModeTheme('normal', { animate: false })
    const normal = getPowerModeWordmarkPalette()

    setPowerModeTheme('cheap', { animate: false })
    const bronze = getPowerModeWordmarkPalette()
    expect(bronze.bodyLeft).not.toEqual(normal.bodyLeft)
    expect(bronze.bodyRight).not.toEqual(normal.bodyRight)

    setPowerModeTheme('rust', { animate: false })
    const green = getPowerModeWordmarkPalette()
    expect(green.bodyLeft).not.toEqual(normal.bodyLeft)
    expect(green.bodyLeft).not.toEqual(bronze.bodyLeft)
    expect(green.bodyRight.g).toBeGreaterThan(green.bodyRight.r)

    setPowerModeTheme('full', { animate: false })
    const gold = getPowerModeWordmarkPalette()
    expect(gold.bodyLeft).not.toEqual(bronze.bodyLeft)
    expect(gold.bodyRight).not.toEqual(bronze.bodyRight)

    setPowerModeTheme('normal', { animate: false })
    setPowerModeTheme('full', { durationMs: 1000 })
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(isPowerModeThemeTransitionActive()).toBe(true)

    const during = getPowerModeWordmarkPalette()
    expect(during.bodyRight).not.toEqual(normal.bodyRight)
    expect(during.bodyRight).not.toEqual(gold.bodyRight)
    expect(getPowerModeWordmarkPalette({ snap: true }).bodyRight).toEqual(
      gold.bodyRight,
    )

    setPowerModeTheme('normal', { animate: false })
  })

  test('ANSI themes snap instead of interpolating', async () => {
    setPowerModeTheme('normal', { animate: false })
    setPowerModeTheme('cheap', { durationMs: 40 })
    const during = getTheme('dark-ansi')
    expect(during.brand.startsWith('ansi:')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(getTheme('dark-ansi').brand.startsWith('ansi:')).toBe(true)
    setPowerModeTheme('normal', { animate: false })
  })

  test('every mode has a defined palette for every theme family', () => {
    for (const mode of POWER_MODES) {
      setPowerModeTheme(mode, { animate: false })
      for (const themeName of [
        'dark',
        'light',
        'studio',
        'dark-ansi',
        'light-ansi',
        'dark-daltonized',
        'light-daltonized',
      ] as const) {
        const theme = getTheme(themeName)
        expect(typeof theme.brand).toBe('string')
        expect(theme.brand.length).toBeGreaterThan(0)
      }
    }
    setPowerModeTheme('normal', { animate: false })
  })
})
