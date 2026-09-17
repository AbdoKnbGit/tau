/**
 * /remote reachability tests: which address a phone is given, and when local
 * mode must refuse instead.
 *
 * The adapter tables mirror real machines. Two encode bugs that shipped:
 *
 *  - WSL 2 NAT: the distro only sees its own eth0 (172.x), which nothing on the
 *    Wi-Fi can reach. The QR carried it and phones got "connection timed out".
 *  - libvirt/VirtualBox host adapters carry 192.168.x addresses, which outscored
 *    a real 10.x Wi-Fi address and put a dead address in the QR.
 *
 * Run: bun run src/services/remote/reach.test.ts
 * Live server round trip on this machine (binds the /remote port briefly):
 *   REMOTE_E2E=1 bun run src/services/remote/reach.test.ts
 */

import { networkInterfaces } from 'node:os'
import {
  chooseLanAddress,
  defaultRouteAddress,
  listLanCandidates,
  pickLanAddress,
  type Interfaces,
  type LanChoice,
} from './lan.js'
import { resolveLanReach, type ReachDeps } from './reach.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}: ${String(e)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

function table(entries: Record<string, string[]>, internal: string[] = []): Interfaces {
  const out: Interfaces = {}
  for (const [name, addresses] of Object.entries(entries)) {
    out[name] = addresses.map(address => ({
      address,
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:00',
      internal: internal.includes(name),
      cidr: `${address}/24`,
    }))
  }
  return out
}

function pickFrom(interfaces: Interfaces, routed: string | null): LanChoice | null {
  return chooseLanAddress(listLanCandidates(interfaces), routed)
}

function deps(overrides: Partial<ReachDeps>): ReachDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    override: () => undefined,
    platform: () => 'linux',
    wslVersion: () => undefined,
    wslNetworkingMode: async () => {
      calls.push('wslinfo')
      return 'nat'
    },
    pick: async () => {
      calls.push('pick')
      return { address: '192.168.1.20', others: [] }
    },
    ...overrides,
  }
}

async function main(): Promise<void> {
  console.log('lan: address choice')

  await test('Windows with a WSL switch picks the Wi-Fi adapter, whatever it is named', () => {
    const ifaces = table(
      {
        WiFi: ['192.168.1.116'],
        'vEthernet (WSL)': ['172.30.96.1'],
        Ethernet: ['169.254.250.80'],
        'Loopback Pseudo-Interface 1': ['127.0.0.1'],
      },
      ['Loopback Pseudo-Interface 1'],
    )
    eq(pickFrom(ifaces, '192.168.1.116'), { address: '192.168.1.116', others: [] }, 'routed')
    eq(pickFrom(ifaces, null), { address: '192.168.1.116', others: [] }, 'no route')
  })

  await test('Linux: libvirt and VirtualBox 192.168 adapters never beat real 10.x Wi-Fi', () => {
    const ifaces = table(
      {
        lo: ['127.0.0.1'],
        wlp3s0: ['10.0.0.23'],
        virbr0: ['192.168.122.1'],
        vboxnet0: ['192.168.56.1'],
        docker0: ['172.17.0.1'],
        'br-5f2a91c0d3e4': ['172.18.0.1'],
        veth1a2b3c: ['169.254.1.1'],
      },
      ['lo'],
    )
    eq(pickFrom(ifaces, '10.0.0.23'), { address: '10.0.0.23', others: [] }, 'routed')
    eq(pickFrom(ifaces, null), { address: '10.0.0.23', others: [] }, 'no route')
  })

  await test('macOS on a full-tunnel VPN still offers the Wi-Fi address', () => {
    const ifaces = table({
      en0: ['192.168.1.20'],
      bridge100: ['192.168.64.1'],
      utun4: ['10.8.0.2'],
    })
    eq(pickFrom(ifaces, '10.8.0.2'), { address: '192.168.1.20', others: [] }, 'vpn route')
  })

  await test('Linux WireGuard default route falls through to the real adapter', () => {
    const ifaces = table({ wg0: ['10.66.0.2'], enp0s31f6: ['172.16.4.20'] })
    eq(pickFrom(ifaces, '10.66.0.2'), { address: '172.16.4.20', others: [] }, 'wg route')
  })

  await test('the default route wins over name score, and the rest are listed', () => {
    const ifaces = table({ eth0: ['10.1.2.3'], wlan0: ['192.168.1.20'] })
    eq(
      pickFrom(ifaces, '10.1.2.3'),
      { address: '10.1.2.3', others: ['192.168.1.20'] },
      'dual-homed',
    )
  })

  await test('only virtual adapters: still offer the best one rather than nothing', () => {
    const ifaces = table({ 'Network Bridge': ['192.168.1.50'] })
    eq(pickFrom(ifaces, '192.168.1.50'), { address: '192.168.1.50', others: [] }, 'bridge')
  })

  await test('no private IPv4 at all: null', () => {
    eq(pickFrom(table({ eth0: ['100.101.102.103'] }), null), null, 'cgnat only')
    eq(pickFrom(table({}), null), null, 'empty')
  })

  await test('WSL 2 NAT eth0 looks like a real adapter, which is why reach.ts must gate it', () => {
    const ifaces = table({ lo: ['127.0.0.1'], eth0: ['172.30.98.229'] }, ['lo'])
    eq(pickFrom(ifaces, '172.30.98.229'), { address: '172.30.98.229', others: [] }, 'wsl nat')
  })

  console.log('reach: environment')

  await test('WSL 2 NAT refuses local mode without reading adapters', async () => {
    const d = deps({ platform: () => 'wsl', wslVersion: () => '2' })
    eq(await resolveLanReach(d), { kind: 'wsl-nat', networkingMode: 'nat' }, 'reach')
    eq(d.calls, ['wslinfo'], 'calls')
  })

  await test('WSL 2 modes without a Wi-Fi-reachable address all refuse', async () => {
    for (const mode of ['virtioproxy', 'consomme', 'none']) {
      const d = deps({
        platform: () => 'wsl',
        wslVersion: () => '2',
        wslNetworkingMode: async () => mode,
      })
      eq(await resolveLanReach(d), { kind: 'wsl-nat', networkingMode: mode }, mode)
    }
  })

  await test('WSL 2 mirrored and bridged use the shared adapters', async () => {
    for (const mode of ['mirrored', 'bridged']) {
      const d = deps({
        platform: () => 'wsl',
        wslVersion: () => '2',
        wslNetworkingMode: async () => mode,
      })
      eq(
        await resolveLanReach(d),
        { kind: 'lan', address: '192.168.1.20', others: [] },
        mode,
      )
    }
  })

  await test('a WSL 1 kernel uses the Windows stack and never asks wslinfo', async () => {
    const d = deps({ platform: () => 'wsl', wslVersion: () => '1' })
    eq((await resolveLanReach(d)).kind, 'lan', 'kind')
    eq(d.calls, ['pick'], 'calls')
  })

  await test('an unreadable WSL networking mode reads as NAT', async () => {
    const d = deps({
      platform: () => 'wsl',
      wslVersion: () => '2',
      wslNetworkingMode: async () => {
        throw new Error('interop wedged')
      },
    })
    eq(await resolveLanReach(d), { kind: 'wsl-nat', networkingMode: 'nat' }, 'reach')
  })

  await test('native platforms go straight to the adapters', async () => {
    for (const platform of ['windows', 'macos', 'linux']) {
      const d = deps({ platform: () => platform })
      eq((await resolveLanReach(d)).kind, 'lan', platform)
      eq(d.calls, ['pick'], `${platform} calls`)
    }
  })

  await test('no adapters, or adapters that cannot be read: none', async () => {
    eq((await resolveLanReach(deps({ pick: async () => null }))).kind, 'none', 'null')
    const throwing = deps({
      pick: async () => {
        throw new Error('EPERM')
      },
    })
    eq((await resolveLanReach(throwing)).kind, 'none', 'throws')
  })

  await test('TAU_REMOTE_HOST wins over detection, even under WSL 2 NAT', async () => {
    const d = deps({
      override: () => ' 192.168.1.116 ',
      platform: () => 'wsl',
      wslVersion: () => '2',
    })
    eq(
      await resolveLanReach(d),
      { kind: 'lan', address: '192.168.1.116', others: [] },
      'reach',
    )
    eq(d.calls, [], 'calls')
    eq((await resolveLanReach(deps({ override: () => 'mypc.local' }))).kind, 'lan', 'hostname')
  })

  await test('TAU_REMOTE_HOST that would break the URL is reported, not used', async () => {
    for (const value of ['http://192.168.1.5', '192.168.1.5:7777', 'my pc', '-bad', 'a/b']) {
      eq(
        await resolveLanReach(deps({ override: () => value })),
        { kind: 'invalid-override', value },
        value,
      )
    }
    eq((await resolveLanReach(deps({ override: () => '   ' }))).kind, 'lan', 'blank ignored')
  })

  console.log('live: this machine')

  const own = new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter(a => a && a.family === 'IPv4' && !a.internal)
      .map(a => a!.address),
  )

  await test('defaultRouteAddress is one of this machine\'s addresses, quickly', async () => {
    const started = Date.now()
    const routed = await defaultRouteAddress()
    const ms = Date.now() - started
    assert(ms < 1_000, `took ${ms}ms`)
    assert(routed === null || own.has(routed), `${routed} is not a local address`)
    console.log(`      routed via ${routed ?? '(no default route)'} in ${ms}ms`)
  })

  await test('pickLanAddress returns a local address or null', async () => {
    const choice = await pickLanAddress()
    assert(choice === null || own.has(choice.address), `${choice?.address} is not local`)
    console.log(`      picked ${choice ? JSON.stringify(choice) : 'null'}`)
  })

  if (process.env.REMOTE_E2E === '1') {
    console.log('live: local mode server round trip')
    await test('local mode serves the page and the socket on the advertised address', async () => {
      const { turnOn, turnOff } = await import('./lifecycle.js')
      const { WebSocket } = await import('ws')
      try {
        const state = await turnOn('local')
        const choice = await pickLanAddress()
        eq(state.host, choice?.address, 'advertised host')
        assert(state.url.startsWith(`http://${state.host}:${state.port}/#`), state.url)

        const page = await fetch(`http://${state.host}:${state.port}/`)
        eq(page.status, 200, 'page status')
        assert((await page.text()).includes('Tau Remote'), 'page body')

        const hello = await new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(
            `ws://${state.host}:${state.port}/ws?t=${encodeURIComponent(state.token)}`,
          )
          const timer = setTimeout(() => reject(new Error('no hello within 5s')), 5_000)
          ws.once('message', data => {
            clearTimeout(timer)
            ws.close()
            resolve(String(data))
          })
          ws.once('error', err => {
            clearTimeout(timer)
            reject(err)
          })
        })
        eq(JSON.parse(hello).t, 'hello', 'first frame')
        console.log(`      served ${state.url.replace(/#.*/, '#<token>')}`)
      } finally {
        turnOff()
      }
    })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
