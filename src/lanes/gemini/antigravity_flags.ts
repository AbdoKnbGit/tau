/**
 * Antigravity Gemini switches that are on by default: the trajectory
 * envelope (TAU_ANTIGRAVITY_TRAJECTORY), connection keep-alive
 * (TAU_ANTIGRAVITY_KEEPALIVE) and no commit-window pacing
 * (TAU_ANTIGRAVITY_NO_PACING). Setting one to 0, false, no or off turns it
 * off. No imports, so the Node transport test can bundle its readers.
 */
export function antigravitySwitchOn(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}
