/**
 * Decides what a phone on the same Wi-Fi can dial to reach this session.
 *
 * lan.ts reads this machine's adapters; this module decides whether any of
 * them is reachable at all, which depends on where Tau runs:
 *
 *   Windows, macOS, Linux, WSL 1  the adapters are the machine's own.
 *   WSL 2, mirrored networking    the distro shares Windows' adapters.
 *   WSL 2, NAT (the default)      the distro only sees its own eth0 on a
 *                                 private virtual switch inside Windows.
 *
 * The last case is why a phone got "connection timed out": the QR carried the
 * eth0 address, which exists only inside the PC. Nothing on the Linux side
 * can fix that — Windows would need a port forward, which takes admin rights
 * — so local mode says so instead of printing a code that can never work.
 *
 * TAU_REMOTE_HOST overrides everything, for setups detection cannot see: a
 * port forwarded from Windows, a published container port, a reverse proxy.
 */

import memoize from 'lodash-es/memoize.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getPlatform, getWslVersion } from '../../utils/platform.js'
import { which } from '../../utils/which.js'
import { pickLanAddress, type LanChoice } from './lan.js'

export type LanReach =
  | ({ kind: 'lan' } & LanChoice)
  /** WSL 2 networking that the Wi-Fi cannot reach (NAT, consomme, none). */
  | { kind: 'wsl-nat'; networkingMode: string }
  | { kind: 'invalid-override'; value: string }
  | { kind: 'none' }

/**
 * WSL networking modes that give the distro an address the Wi-Fi can reach:
 * mirrored shares Windows' adapters, bridged (deprecated) gets its own address
 * from the router, and a WSL 1 distro uses the Windows network stack.
 */
const REACHABLE_WSL_MODES = new Set(['mirrored', 'bridged', 'wsl1'])

const WSLINFO_TIMEOUT_MS = 3_000

/**
 * `wslinfo --networking-mode` (WSL 2.0.4+) is a Linux binary, so it answers
 * even with Windows interop disabled. WSL before it could only do NAT, so a
 * missing wslinfo reads as NAT. The mode is fixed for the life of the VM,
 * which outlives this process.
 */
const readWslNetworkingMode = memoize(async (): Promise<string> => {
  if (!(await which('wslinfo'))) return 'nat'
  const result = await execFileNoThrowWithCwd('wslinfo', ['--networking-mode'], {
    timeout: WSLINFO_TIMEOUT_MS,
    stdin: 'ignore',
    preserveOutputOnError: false,
  })
  return (result.code === 0 && result.stdout.trim().toLowerCase()) || 'nat'
})

/** A bare IPv4 address or hostname; anything else would break the URL. */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/

export type ReachDeps = {
  override: () => string | undefined
  platform: () => string
  wslVersion: () => string | undefined
  wslNetworkingMode: () => Promise<string>
  pick: () => Promise<LanChoice | null>
}

const LIVE: ReachDeps = {
  override: () => process.env.TAU_REMOTE_HOST,
  platform: getPlatform,
  wslVersion: getWslVersion,
  wslNetworkingMode: readWslNetworkingMode,
  pick: pickLanAddress,
}

/** Never throws: every failure is a kind the caller turns into a message. */
export async function resolveLanReach(deps: ReachDeps = LIVE): Promise<LanReach> {
  const override = deps.override()?.trim()
  if (override) {
    return HOST_RE.test(override)
      ? { kind: 'lan', address: override, others: [] }
      : { kind: 'invalid-override', value: override }
  }

  if (deps.platform() === 'wsl' && deps.wslVersion() !== '1') {
    let mode = 'nat'
    try {
      mode = await deps.wslNetworkingMode()
    } catch {
      /* unreadable reads as the default, NAT */
    }
    if (!REACHABLE_WSL_MODES.has(mode)) {
      return { kind: 'wsl-nat', networkingMode: mode }
    }
  }

  let choice: LanChoice | null = null
  try {
    choice = await deps.pick()
  } catch {
    /* no adapters readable — same as none */
  }
  return choice ? { kind: 'lan', ...choice } : { kind: 'none' }
}
