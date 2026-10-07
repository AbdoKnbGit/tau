// Shared effort values and environment parsing. No provider or settings dependencies.
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  // tau-local top tier, first-party Anthropic Claude Opus 4.8 only. Maps to the
  // strongest real Anthropic effort on the wire (see configureEffortParams in
  // services/api/claude.ts); resolveAppliedEffort() clamps it away everywhere else.
  'ultracode',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  if (typeof value !== 'string') return undefined
  const str = value.trim().toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = /^[+-]?\d+$/.test(str) ? Number(str) : NaN
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.trim()
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    if (value <= 150) return 'xhigh'
    return 'max'
  }
  return 'high'
}
