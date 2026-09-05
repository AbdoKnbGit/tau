/**
 * Picks the LAN IPv4 the phone should dial.
 *
 * A laptop typically has several: the real Wi-Fi/Ethernet address plus a pile
 * of virtual ones (WSL, Docker, Hyper-V, VPN, VirtualBox). Handing the phone a
 * virtual address produces a QR that scans fine and then times out, which is
 * the worst possible failure for a "just scan it" feature — so score the
 * candidates and prefer real private ranges on non-virtual adapters.
 */

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
  'utun',
  'tun',
  'tap',
  'bridge',
]

function isVirtual(name: string): boolean {
  const lower = name.toLowerCase()
  return VIRTUAL_HINTS.some(hint => lower.includes(hint))
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
  if (lower.includes('wi-fi') || lower.includes('wlan') || lower.includes('en0')) s += 25
  if (lower.includes('ethernet') || lower.includes('eth')) s += 15

  return s
}

export type LanCandidate = { name: string; address: string; score: number }

export function listLanCandidates(): LanCandidate[] {
  const out: LanCandidate[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      const s = score(name, addr.address)
      if (s < 0) continue
      out.push({ name, address: addr.address, score: s })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Best guess at the address a phone on the same network can reach. */
export function pickLanAddress(): string | null {
  return listLanCandidates()[0]?.address ?? null
}
