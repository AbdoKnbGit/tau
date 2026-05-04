import { isEnvTruthy } from '../utils/envUtils.js'

export const HEY_TEXT_ONLY_ENV = 'TAU_HEY_TEXT_ONLY'
const LEGACY_HEY_TEXT_ONLY_ENV = 'CLAUDEX_HEY_TEXT_ONLY'

function getHeyTextOnlyEnvValue(): string | boolean | undefined {
  return (
    process.env[HEY_TEXT_ONLY_ENV] ?? process.env[LEGACY_HEY_TEXT_ONLY_ENV]
  )
}

export function getHeyTtsDisabledEnvName(): string | null {
  if (isEnvTruthy(process.env[HEY_TEXT_ONLY_ENV])) return HEY_TEXT_ONLY_ENV
  if (isEnvTruthy(process.env[LEGACY_HEY_TEXT_ONLY_ENV])) {
    return LEGACY_HEY_TEXT_ONLY_ENV
  }
  return null
}

export function isHeyTtsEnabled(): boolean {
  return !isEnvTruthy(getHeyTextOnlyEnvValue())
}
