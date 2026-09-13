import {
  isValidThresholdPercent,
  isValidWindowCap,
  normalizeThresholdPercent,
} from './compactionSettings.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'

/**
 * Reads and writes for the automatic-compaction controls.
 *
 * Split from ./compactionSettings.js so the threshold arithmetic there stays
 * dependency-free and directly testable; this file is the only part that
 * touches global config.
 */

/** Configured threshold percentage, or undefined for auto. */
export function getConfiguredThresholdPercent(): number | undefined {
  const value = getGlobalConfig().autoCompactThresholdPercent
  return isValidThresholdPercent(value) ? value : undefined
}

/** Configured context ceiling in tokens, or undefined for auto. */
export function getConfiguredWindowCap(): number | undefined {
  const value = getGlobalConfig().autoCompactWindowTokens
  return isValidWindowCap(value) ? Math.floor(value) : undefined
}

/** Retaining recent context is enabled only by an explicit boolean opt-in. */
export function isRecentContextPreservationEnabled(): boolean {
  return getGlobalConfig().autoCompactPreserveRecent === true
}

/** Persist the threshold percentage; `undefined` restores auto. */
export function setConfiguredThresholdPercent(
  percent: number | undefined,
): void {
  const next =
    percent === undefined ? undefined : normalizeThresholdPercent(percent)
  saveGlobalConfig(config =>
    config.autoCompactThresholdPercent === next
      ? config
      : { ...config, autoCompactThresholdPercent: next },
  )
}

/** Persist the context ceiling; `undefined` restores auto. */
export function setConfiguredWindowCap(tokens: number | undefined): void {
  const next = isValidWindowCap(tokens) ? Math.floor(tokens) : undefined
  saveGlobalConfig(config =>
    config.autoCompactWindowTokens === next
      ? config
      : { ...config, autoCompactWindowTokens: next },
  )
}

/** Persist the automatic-compaction preference; manual /compact is unaffected. */
export function setRecentContextPreservationEnabled(enabled: boolean): void {
  saveGlobalConfig(config =>
    config.autoCompactPreserveRecent === enabled
      ? config
      : { ...config, autoCompactPreserveRecent: enabled },
  )
}
