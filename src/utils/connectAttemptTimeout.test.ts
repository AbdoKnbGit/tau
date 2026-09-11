/** Focused tests for configureConnectAttemptTimeout. */

import * as net from 'net'
import {
  CONNECT_ATTEMPT_TIMEOUT_MS,
  configureConnectAttemptTimeout,
} from './connectAttemptTimeout.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function test(name: string, run: () => void) {
  try {
    run()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** A recording stand-in for node:net's default, so most tests leave it alone. */
function fakeNet(defaultMs: number) {
  const sets: number[] = []
  let current = defaultMs
  return {
    sets,
    netImpl: {
      getDefaultAutoSelectFamilyAttemptTimeout: () => current,
      setDefaultAutoSelectFamilyAttemptTimeout: (value: number) => {
        sets.push(value)
        current = value
      },
    },
  }
}

const FLAG = '--network-family-autoselection-attempt-timeout'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

console.log('configureConnectAttemptTimeout:')

test("raises Node's 250 ms default to 2 s", () => {
  const f = fakeNet(250)
  const result = configureConnectAttemptTimeout({
    netImpl: f.netImpl,
    execArgv: [],
    nodeOptions: '',
  })
  assert(CONNECT_ATTEMPT_TIMEOUT_MS === 2000, `unexpected constant ${CONNECT_ATTEMPT_TIMEOUT_MS}`)
  assert(same(f.sets, [2000]), `wrong sets: ${JSON.stringify(f.sets)}`)
  assert(
    same(result, { outcome: 'applied', previousMs: 250 }),
    `wrong result: ${JSON.stringify(result)}`,
  )
})

test("keeps a value set with Node's flag, in every spelling Node accepts", () => {
  const cases: Array<[string[], string]> = [
    [[`${FLAG}=500`], ''],
    [[FLAG, '500'], ''],
    [['--network_family_autoselection_attempt_timeout=500'], ''],
    [[], `${FLAG}=500`],
    [[], `--max-old-space-size=4096 ${FLAG}=500 --enable-source-maps`],
    [[], `${FLAG} 500`],
    [[], `"${FLAG}=500"`],
    [[], '--network_family_autoselection_attempt_timeout=500'],
  ]
  for (const [execArgv, nodeOptions] of cases) {
    const f = fakeNet(500)
    const result = configureConnectAttemptTimeout({ netImpl: f.netImpl, execArgv, nodeOptions })
    const label = JSON.stringify({ execArgv, nodeOptions })
    assert(f.sets.length === 0, `${label}: must not override the flag`)
    assert(
      same(result, { outcome: 'node-flag', previousMs: 500 }),
      `${label}: wrong result ${JSON.stringify(result)}`,
    )
  }
})

test('options that only look similar do not count as the flag', () => {
  const cases: Array<[string[], string]> = [
    [['--network-family-autoselection'], ''],
    [['--no-network-family-autoselection'], ''],
    [['--title=--network-family-autoselection-attempt-timeout'], ''],
    [[], '--no-network-family-autoselection --max-old-space-size=4096'],
    [[], '--require ./network-family-autoselection-attempt-timeout.cjs'],
  ]
  for (const [execArgv, nodeOptions] of cases) {
    const f = fakeNet(250)
    const result = configureConnectAttemptTimeout({ netImpl: f.netImpl, execArgv, nodeOptions })
    const label = JSON.stringify({ execArgv, nodeOptions })
    assert(same(f.sets, [2000]), `${label}: wrong sets ${JSON.stringify(f.sets)}`)
    assert(result.outcome === 'applied', `${label}: wrong result ${JSON.stringify(result)}`)
  }
})

test('never lowers a default that is already 2 s or longer', () => {
  for (const current of [2000, 5000]) {
    const f = fakeNet(current)
    const result = configureConnectAttemptTimeout({
      netImpl: f.netImpl,
      execArgv: [],
      nodeOptions: '',
    })
    assert(f.sets.length === 0, `${current}: must not be changed`)
    assert(
      same(result, { outcome: 'already-longer', previousMs: current }),
      `${current}: wrong result ${JSON.stringify(result)}`,
    )
  }
})

test('a runtime without the setter is left unchanged', () => {
  const result = configureConnectAttemptTimeout({ netImpl: {}, execArgv: [], nodeOptions: '' })
  assert(same(result, { outcome: 'unsupported' }), `wrong result: ${JSON.stringify(result)}`)
})

test('a runtime without the getter still gets 2 s', () => {
  const sets: number[] = []
  const result = configureConnectAttemptTimeout({
    netImpl: {
      setDefaultAutoSelectFamilyAttemptTimeout: value => {
        sets.push(value)
      },
    },
    execArgv: [],
    nodeOptions: '',
  })
  assert(same(sets, [2000]), `wrong sets: ${JSON.stringify(sets)}`)
  assert(same(result, { outcome: 'applied' }), `wrong result: ${JSON.stringify(result)}`)
})

test('a throwing runtime never escapes', () => {
  const boom = () => {
    throw new Error('boom')
  }
  for (const netImpl of [
    {
      getDefaultAutoSelectFamilyAttemptTimeout: () => 250,
      setDefaultAutoSelectFamilyAttemptTimeout: boom,
    },
    {
      getDefaultAutoSelectFamilyAttemptTimeout: boom,
      setDefaultAutoSelectFamilyAttemptTimeout: () => {},
    },
  ]) {
    const result = configureConnectAttemptTimeout({ netImpl, execArgv: [], nodeOptions: '' })
    assert(same(result, { outcome: 'failed' }), `wrong result: ${JSON.stringify(result)}`)
  }
})

test('by default it reads the live NODE_OPTIONS', () => {
  const saved = process.env.NODE_OPTIONS
  try {
    process.env.NODE_OPTIONS = `${FLAG}=700`
    const f = fakeNet(700)
    const result = configureConnectAttemptTimeout({ netImpl: f.netImpl, execArgv: [] })
    assert(f.sets.length === 0, 'must not override NODE_OPTIONS')
    assert(result.outcome === 'node-flag', `wrong result: ${JSON.stringify(result)}`)
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = saved
  }
})

test("this runtime's own net module takes the value", () => {
  // Bun runs this file, so this only checks the API shape. Node's handling
  // is checked on the built CLI.
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout !== 'function') {
    const result = configureConnectAttemptTimeout({ execArgv: [], nodeOptions: '' })
    assert(result.outcome === 'unsupported', `wrong result: ${JSON.stringify(result)}`)
    return
  }
  const original = net.getDefaultAutoSelectFamilyAttemptTimeout()
  try {
    const result = configureConnectAttemptTimeout({ execArgv: [], nodeOptions: '' })
    assert(
      result.outcome === 'applied' || result.outcome === 'already-longer',
      `wrong result: ${JSON.stringify(result)}`,
    )
    assert(
      net.getDefaultAutoSelectFamilyAttemptTimeout() >= CONNECT_ATTEMPT_TIMEOUT_MS,
      `default is ${net.getDefaultAutoSelectFamilyAttemptTimeout()} ms`,
    )
  } finally {
    net.setDefaultAutoSelectFamilyAttemptTimeout(original)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
