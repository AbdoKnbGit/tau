/**
 * Picks the LAN IPv4 the phone should dial.
 *
 * A laptop typically has several: the real Wi-Fi/Ethernet address plus a pile
 * of virtual ones (WSL, Docker, Hyper-V, VPN, VirtualBox, libvirt). Handing the
 * phone a virtual address produces a QR that scans fine and then times out,
 * which is the worst possible failure for a "just scan it" feature.
 *
 * The routing table answers first: the address the OS would send internet
 * traffic from sits on the adapter that actually reaches the router, whatever
 * that adapter is called — "Wi-Fi", "WiFi", "WLAN", "wlp3s0" or a translated
 * name. Name scoring only decides when there is no default route, or when the
 * default route is a VPN.
 *
 * Whether the chosen address is reachable at all depends on where Tau runs
 * (WSL 2 hides it behind a virtual switch); reach.ts owns that question.
 */

import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

/** Adapter names that are never reachable from a phone on the same Wi-Fi. */
const VIRTUAL_HINTS = [
  'vethernet',
  'virtualbox',
  'vmware',
  'docker',
  'wsl',
  'hyper-v',
  'loopback',
  'tailscale',
  'zerotier',
  'wireguard',
  'openvpn',
  'wintun',
  'nordlynx',
  'utun',
  'tun',
  'tap',
  'bridge',
]

/**
 * Linux and macOS virtual adapters, matched at the start of the name only:
 * the prefixes are short enough that a substring match would hit real ones.
 * Several carry 192.168/x addresses (virbr0, vboxnet0), which outscore a real
 * 10/x Wi-Fi address unless they are recognised.
 */
const VIRTUAL_PREFIXES = [
  'br-',
  'veth',
  'virbr',
  'vboxnet',
  'vmnet',
  'lxdbr',
  'lxcbr',
  'incusbr',
  'podman',
  'cni',
  'flannel',
  'wg',
  'zt',
  'ppp',
  'ipsec',
  'awdl',
  'llw',
]

function isVirtual(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    VIRTUAL_HINTS.some(hint => lower.includes(hint)) ||
    VIRTUAL_PREFIXES.some(prefix => lower.startsWith(prefix))
  )
}

/** Higher is better. 192.168/x is the overwhelmingly common home-router range. */
function score(name: string, address: string): number {
  let s = 0
  if (address.startsWith('192.168.')) s += 100
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 60
  else if (address.startsWith('10.')) s += 50
  else return -1 // not a private range — don't advertise it

  if (isVirtual(name)) s -= 80

  const lower = name.toLowerCase()
  if (
    lower.includes('wi-fi') ||
    lower.includes('wifi') ||
    lower.includes('wlan') ||
    lower.startsWith('wl') ||
    lower.includes('en0')
  ) {
    s += 25
  }
  if (lower.includes('ethernet') || lower.includes('eth')) s += 15

  return s
}

export type LanCandidate = {
  name: string
  address: string
  score: number
  virtual: boolean
}

export type Interfaces = ReturnType<typeof networkInterfaces>

export function listLanCandidates(
  interfaces: Interfaces = networkInterfaces(),
): LanCandidate[] {
  const out: LanCandidate[] = []
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      const s = score(name, addr.address)
      if (s < 0) continue
      out.push({ name, address: addr.address, score: s, virtual: isVirtual(name) })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

/** TEST-NET-1 (RFC 5737): never a real host, yet routed like any public address. */
const ROUTE_PROBE_ADDRESS = '192.0.2.1'
const ROUTE_PROBE_TIMEOUT_MS = 500

/**
 * The local address the OS would send internet traffic from, or null when
 * there is no default route.
 *
 * connect() on a UDP socket only asks the kernel to pick a route and bind the
 * matching source address; nothing is sent. That makes this an exact,
 * name-independent answer on Windows, macOS and Linux alike.
 */
export function defaultRouteAddress(): Promise<string | null> {
  return new Promise(resolve => {
    let socket: ReturnType<typeof createSocket>
    try {
      socket = createSocket('udp4')
    } catch {
      resolve(null)
      return
    }

    let settled = false
    const finish = (address: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve(address)
    }
    // A runtime without UDP connect() must degrade to scoring, not hang /remote.
    const timer = setTimeout(() => finish(null), ROUTE_PROBE_TIMEOUT_MS)
    timer.unref?.()

    // Without a callback, a failed connect() (ENETUNREACH: no default route)
    // arrives as an 'error' event.
    socket.once('error', () => finish(null))
    socket.once('connect', () => {
      try {
        finish(socket.address().address)
      } catch {
        finish(null)
      }
    })
    try {
      socket.connect(9, ROUTE_PROBE_ADDRESS)
    } catch {
      finish(null)
    }
  })
}

export type LanChoice = {
  address: string
  /** The machine's other real LAN addresses, for a phone on another network. */
  others: string[]
}

/**
 * Real adapters win over virtual ones, and among real adapters the one
 * carrying the default route wins over the best name score. A VPN default
 * route is virtual, so it falls through to the best real adapter.
 */
export function chooseLanAddress(
  candidates: LanCandidate[],
  routed: string | null,
): LanChoice | null {
  const physical = candidates.filter(c => !c.virtual)
  const pool = physical.length > 0 ? physical : candidates
  const best = pool.find(c => c.address === routed) ?? pool[0]
  if (!best) return null
  return {
    address: best.address,
    others: pool.filter(c => c !== best).map(c => c.address),
  }
}

/** Best guess at the address a phone on the same network can reach. */
export async function pickLanAddress(): Promise<LanChoice | null> {
  return chooseLanAddress(listLanCandidates(), await defaultRouteAddress())
}
