import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/services/api/auth/portOwners.ts'], bundle: true, packages: 'external', write: false, format: 'cjs', platform: 'node', target: 'node20' })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { parseListenerPids, localAddressPort, isReclaimableImage, describeOwners } = module.exports

// Real `netstat -ano` shape, including the neighbours that used to be killed.
const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:1455         0.0.0.0:0              LISTENING       1111',
  '  TCP    0.0.0.0:14550          0.0.0.0:0              LISTENING       2222',
  '  TCP    0.0.0.0:14559          0.0.0.0:0              LISTENING       3333',
  '  TCP    0.0.0.0:1456           0.0.0.0:0              LISTENING       4444',
  '  TCP    [::]:1455              [::]:0                 LISTENING       5555',
  '  TCP    192.168.1.9:52101      93.184.216.34:1455     ESTABLISHED     6666',
  '  UDP    0.0.0.0:1455           *:*                                    7777',
].join('\r\n')

test('only an exact local TCP port matches, not its neighbours', () => {
  const pids = parseListenerPids(NETSTAT, 1455)
  // 1111 and 5555 hold :1455 (IPv4 and IPv6). Everything else must be spared.
  assert.deepEqual(pids.sort(), ['1111', '5555'])
  // The old substring pattern killed these; regression guard.
  for (const spared of ['2222', '3333', '4444']) assert.ok(!pids.includes(spared), `killed neighbour ${spared}`)
  // An outbound connection to a remote :1455 does not hold the local port.
  assert.ok(!pids.includes('6666'))
  // UDP cannot conflict with the TCP callback server.
  assert.ok(!pids.includes('7777'))
})

test('port parsing handles IPv6, IPv4 and malformed addresses', () => {
  assert.equal(localAddressPort('0.0.0.0:1455'), 1455)
  assert.equal(localAddressPort('[::]:1455'), 1455)
  assert.equal(localAddressPort('[::1]:8080'), 8080)
  for (const bad of ['0.0.0.0', '', undefined, 'garbage', '1.2.3.4:notaport']) {
    assert.equal(localAddressPort(bad), null, `accepted ${String(bad)}`)
  }
})

test('PID 0 and non-numeric columns are never targeted', () => {
  const rows = [
    '  TCP    0.0.0.0:1455    0.0.0.0:0    LISTENING       0',
    '  TCP    0.0.0.0:1455    0.0.0.0:0    LISTENING       -',
  ].join('\n')
  assert.deepEqual(parseListenerPids(rows, 1455), [])
})

test('only processes that could host a callback server may be killed', () => {
  for (const image of ['node.exe', 'NODE.EXE', 'codex.exe', 'bun', 'tau.exe', ' claudex.exe ']) {
    assert.ok(isReclaimableImage(image), `refused ${image}`)
  }
  // The whole point: a database, editor or browser is never Tau's to terminate.
  for (const image of ['postgres.exe', 'Code.exe', 'chrome.exe', 'sqlservr.exe', '', undefined]) {
    assert.ok(!isReclaimableImage(image), `would kill ${String(image)}`)
  }
})

test('a refusal names what the user has to close', () => {
  assert.equal(describeOwners([{ pid: '4242', image: 'postgres.exe' }]), 'postgres.exe (PID 4242)')
  assert.equal(describeOwners([{ pid: '7', image: '' }]), 'unknown process (PID 7)')
})
