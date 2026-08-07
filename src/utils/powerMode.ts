import type { SettingsJson } from './settings/types.js'

/**
 * Power modes control how much machinery the session loads and exposes:
 *
 * - `cheap`: minimal footprint. Every optional prebuilt tool toggle is forced
 *   off, skills/agents/plugins are not loaded (even when present in the
 *   project folder), no MCP server is read or connected, and LSP never
 *   starts. Only the core file/shell/search/task tools remain.
 * - `normal`: current default behavior. The user's own /tools toggles apply,
 *   MCP/skills/agents/plugins/LSP load as configured.
 * - `rust`: normal-mode machinery plus mode-gated native Rust capabilities
 *   and routing guidance.
 * - `full`: everything on. All optional prebuilt tool toggles are forced on
 *   regardless of saved /tools state; MCP/skills/agents/LSP behave as in
 *   normal mode.
 *
 * The mode is a persisted user setting (settings.json `powerMode`). All gates
 * read it through the merged settings so a /mode switch (which persists and
 * resets the settings cache) takes effect immediately and deterministically —
 * within a mode the tool list is stable, so prompt caching is unaffected
 * except for the single expected re-warm when the user changes modes.
 */
export const POWER_MODES = ['cheap', 'normal', 'rust', 'full'] as const

export type PowerMode = (typeof POWER_MODES)[number]

/**
 * Modes offered in the /mode picker and help text. 'full' is retired from the
 * UI — it was just normal with every optional tool force-enabled, a confusing
 * third choice with no real value over normal. It stays in POWER_MODES (and in
 * the settings schema, tool/theme gate maps) so a persisted `powerMode: 'full'`
 * still resolves and `/mode full` still works for power users, but it is no
 * longer advertised or shown as a selectable option.
 */
export const SELECTABLE_POWER_MODES = ['cheap', 'normal', 'rust'] as const

export const DEFAULT_POWER_MODE: PowerMode = 'normal'

/** Modes that retain the user's normal /tools and provider behavior. */
export function isNormalToolingMode(mode: PowerMode): boolean {
  return mode === 'normal' || mode === 'rust'
}

type SettingsWithPowerMode = Pick<SettingsJson, 'powerMode'>

/**
 * Normalize user-typed values ("fullpower", "eco", …) to a PowerMode.
 * Returns null when the value doesn't name a mode.
 */
export function normalizePowerMode(value: string): PowerMode | null {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  switch (normalized) {
    case 'cheap':
    case 'eco':
    case 'low':
    case 'minimal':
      return 'cheap'
    case 'normal':
    case 'default':
    case 'balanced':
      return 'normal'
    case 'rust':
    case 'rustcode':
      return 'rust'
    case 'full':
    case 'fullpower':
    case 'full-power':
    case 'max':
    case 'all':
      return 'full'
    default:
      return null
  }
}

/**
 * The power mode THIS process (session) is running in, pinned in memory.
 *
 * Why a pin exists: powerMode is persisted in the shared user settings.json,
 * and Tau's settings file-watcher (utils/settings/changeDetector.ts) applies
 * external edits to that file LIVE. Without a pin, a second concurrently
 * running Tau session that runs `/mode` writes powerMode to the shared file,
 * this session's watcher fires, resetSettingsCache() + applySettingsChange()
 * run, and this session silently switches mode mid-conversation — the
 * cross-session leak users hit ("switch mode in session B, session A inherits
 * it"). The pin makes each session's mode sticky: seeded once at startup from
 * the persisted value, changed ONLY by this session's own /mode. Persisting to
 * disk still happens (so the last writer sets the default for the NEXT launch),
 * but a live external write can no longer move a running session.
 *
 * null = not yet seeded; getPowerModeFromSettings falls back to the passed
 * settings (its original pure behavior, which keeps unit tests deterministic).
 */
let sessionPowerModePin: PowerMode | null = null

/** Pure settings → mode resolution, independent of the session pin. */
function resolvePowerModeFromSettingsValue(
  settings: SettingsWithPowerMode | undefined,
): PowerMode {
  const value = settings?.powerMode
  if (value === 'cheap' || value === 'rust' || value === 'full') return value
  return DEFAULT_POWER_MODE
}

/**
 * Resolve the effective power mode. When this session has pinned a mode (the
 * normal case after startup seeding), the pin wins over `settings` so that a
 * live external edit to the shared settings.json — surfaced through either
 * getInitialSettings() or a reactive appState.settings — cannot switch the
 * running session. Before seeding (pin === null) it behaves as the original
 * pure resolver, so direct unit tests stay deterministic.
 */
export function getPowerModeFromSettings(
  settings: SettingsWithPowerMode | undefined,
): PowerMode {
  if (sessionPowerModePin !== null) return sessionPowerModePin
  return resolvePowerModeFromSettingsValue(settings)
}

/**
 * Pin this session's power mode. Called by the /mode command after it persists
 * the change, so the switch takes effect for this session immediately and
 * survives later external settings-file churn.
 */
export function setSessionPowerMode(mode: PowerMode): void {
  sessionPowerModePin = mode
}

/**
 * Seed the session pin from the persisted settings exactly once, at session
 * startup (app-state construction). Idempotent: a no-op if the session already
 * pinned a mode, so re-creating app state (e.g. /clear) never re-reads a mode
 * another session may have written in the meantime.
 */
export function seedSessionPowerMode(
  settings: SettingsWithPowerMode | undefined,
): void {
  if (sessionPowerModePin === null) {
    sessionPowerModePin = resolvePowerModeFromSettingsValue(settings)
  }
}

/** Test-only: clear the pin so pure settings-based resolution is exercised. */
export function resetSessionPowerModeForTesting(): void {
  sessionPowerModePin = null
}

export const POWER_MODE_LABELS: Record<PowerMode, string> = {
  cheap: 'Cheap',
  normal: 'Normal',
  rust: 'Rust',
  full: 'Full power',
}

export const POWER_MODE_DESCRIPTIONS: Record<PowerMode, string> = {
  cheap:
    'Core tools only — optional tools, skills, agents, plugins, MCP, and LSP are all off and hidden from the model (folder configs are ignored; /tools hidden)',
  normal:
    'Default behavior — your /tools toggles apply; MCP, skills, agents, and LSP load as configured',
  rust:
    'Normal behavior plus Rust-focused guidance and native Rust capabilities when available',
  full: 'Everything on — all optional tools forced on; /tools hidden (your saved toggles return in normal mode)',
}
