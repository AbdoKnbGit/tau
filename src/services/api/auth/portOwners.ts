/**
 * Who holds the OAuth callback port, and whether Tau may reclaim it.
 *
 * The previous implementation shelled out to `netstat -ano | findstr ":1455"`,
 * which is a substring match: ports 14550-14559 matched too, and every matching
 * PID was passed to `taskkill /F`. A listener on 14550 was force-killed with no
 * save and no prompt. Matching is now numeric, and only processes from the
 * families that actually run an OAuth callback server are ever killed.
 *
 * Parsing is separated from process control so the matching rules are testable
 * without listening on a port or killing anything.
 */

import { execFileSync } from 'child_process'
import { resolveWindowsSystemExecutable } from '../../../../scripts/platform-support.mjs'

export interface PortOwner { pid: string; image: string }

/** Images that plausibly host a stale Tau/Codex callback server. Anything else
 * is reported to the user rather than killed: it is not ours to terminate. */
const RECLAIMABLE_IMAGES = new Set([
  'node', 'node.exe', 'bun', 'bun.exe',
  'codex', 'codex.exe', 'tau', 'tau.exe', 'claudex', 'claudex.exe',
])

export function isReclaimableImage(image: string | undefined): boolean {
  return typeof image === 'string' && RECLAIMABLE_IMAGES.has(image.trim().toLowerCase())
}

/** Port from a netstat local address: `0.0.0.0:1455`, `[::]:1455`, `127.0.0.1:1455`. */
export function localAddressPort(address: string | undefined): number | null {
  if (!address) return null
  const separator = address.lastIndexOf(':')
  if (separator === -1) return null
  const port = Number(address.slice(separator + 1))
  return Number.isInteger(port) && port > 0 ? port : null
}

/**
 * PIDs whose *local* TCP port is exactly `port`.
 *
 * The connection state is deliberately not matched: netstat localises it
 * (LISTENING/ABHÖREN/ECOUTE), and an exact local-port match already excludes
 * both neighbouring ports and outbound connections to a remote `:port`.
 */
export function parseListenerPids(output: string, port: number): string[] {
  const pids = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4 || !/^TCP(v6)?$/i.test(parts[0] ?? '')) continue
    if (localAddressPort(parts[1]) !== port) continue
    const pid = parts[parts.length - 1]
    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid)
  }
  return [...pids]
}

/**
 * Windows system tools are resolved through System32, never PATH: Git Bash,
 * MSYS2 and WSL routinely shadow `netstat`, `tasklist` and `find`-style tools
 * with GNU builds that take different arguments. When the real binary cannot be
 * located we return nothing, which makes the caller refuse to kill rather than
 * act on the output of an unknown program.
 */
function run(name: string, args: string[]): string {
  const file = process.platform === 'win32' ? resolveWindowsSystemExecutable(`${name}.exe`) : name
  if (!file) return ''
  try {
    return execFileSync(file, args, { encoding: 'utf-8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function imageForPid(pid: string): string {
  if (process.platform === 'win32') {
    // tasklist CSV: "node.exe","1234","Console","1","50,000 K"
    return /^"([^"]+)"/.exec(run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']).trim())?.[1] ?? ''
  }
  return run('ps', ['-p', pid, '-o', 'comm=']).trim().split('/').pop() ?? ''
}

/** Everything currently holding `port`, each tagged with its process image. */
export function ownersOfPort(port: number): PortOwner[] {
  const pids = process.platform === 'win32'
    ? parseListenerPids(run('netstat', ['-ano']), port)
    : run('lsof', ['-t', '-i', `:${port}`]).split(/\s+/).filter(pid => /^\d+$/.test(pid))
  return [...new Set(pids)].map(pid => ({ pid, image: imageForPid(pid) }))
}

function terminate(pid: string): boolean {
  if (process.platform === 'win32') return run('taskkill', ['/F', '/PID', pid]) !== ''
  try { process.kill(Number(pid), 'SIGKILL'); return true } catch { return false }
}

export interface ReclaimResult {
  /** The port is held by this process; the caller must close its own handle. */
  ownedBySelf: boolean
  killed: PortOwner[]
  /** Held by something Tau will not kill. Name these to the user instead. */
  refused: PortOwner[]
}

export function reclaimPort(port: number, ownPid = String(process.pid)): ReclaimResult {
  const result: ReclaimResult = { ownedBySelf: false, killed: [], refused: [] }
  for (const owner of ownersOfPort(port)) {
    if (owner.pid === ownPid) { result.ownedBySelf = true; continue }
    if (!isReclaimableImage(owner.image)) { result.refused.push(owner); continue }
    if (terminate(owner.pid)) result.killed.push(owner)
    else result.refused.push(owner)
  }
  return result
}

/** One line naming what is holding the port, for an error the user can act on. */
export function describeOwners(owners: readonly PortOwner[]): string {
  return owners.map(owner => `${owner.image || 'unknown process'} (PID ${owner.pid})`).join(', ')
}
