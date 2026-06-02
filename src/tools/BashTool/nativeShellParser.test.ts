/**
 * Native shell parser bridge tests.
 *
 * Run after `bun run build:native-shell` or `bun run build`:
 * bun run src/tools/BashTool/nativeShellParser.test.ts
 */

import {
  analyzeNativeShellCommand,
  findNativeShellParserBinary,
} from './nativeShellParser.js'

let passed = 0
let failed = 0
let skipped = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function skip(name: string, reason: string): void {
  skipped++
  console.log(`  skip ${name}: ${reason}`)
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

async function main(): Promise<void> {
  console.log('native shell parser:')

  if (!findNativeShellParserBinary()) {
    skip('analyzes bash command structure', 'native helper binary not built')
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
    return
  }

  await test('analyzes bash command structure', async () => {
    const analysis = await analyzeNativeShellCommand(
      'cd src && docker compose --file docker-compose.yml up --detach api | tee out.log',
    )

    assert(analysis !== null, 'expected native analysis')
    assert(analysis?.ok, 'expected successful parse')
    assert(analysis?.parser.includes('mvdan.cc/sh'), 'expected mvdan/sh parser')
    assert(analysis?.summary?.hasCd, 'expected cd detection')
    assert(analysis?.summary?.hasPipeline, 'expected pipeline detection')
    assert(
      analysis?.summary?.firstCommands.includes('docker'),
      'expected docker command detection',
    )
    assert(
      analysis?.formatted?.includes('docker compose --file docker-compose.yml up --detach api'),
      'expected formatted command',
    )
  })

  await test('returns parse diagnostics without throwing', async () => {
    const analysis = await analyzeNativeShellCommand('if true; then echo ok')

    assert(analysis !== null, 'expected native analysis')
    assert(analysis?.ok === false, 'expected parse error')
    assert(
      (analysis?.diagnostics?.[0]?.message ?? '').length > 0,
      'expected parse diagnostic',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
