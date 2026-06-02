/**
 * Run: bun run src/tools/BashTool/bashCommandParts.test.ts
 */

import {
  compileBashCommandParts,
  validateBashCommandPartsMatch,
} from './bashCommandParts.js'

let passed = 0
let failed = 0

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

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

async function main(): Promise<void> {
  console.log('bash command parts:')

  await test('quotes bash arguments and preserves structured flag order', () => {
    const result = compileBashCommandParts({
      executable: 'docker',
      tokens: [
        { kind: 'arg', value: 'compose' },
        { kind: 'flag', name: 'file', value: 'docker compose.yml' },
        { kind: 'arg', value: 'up' },
        { kind: 'flag', name: 'detach', value: true },
        { kind: 'flag', name: 'build', value: false },
        { kind: 'arg', value: 'api service' },
      ],
    })

    assertEqual(
      result.command,
      "docker compose --file 'docker compose.yml' up --detach 'api service'",
      'compiled docker command',
    )
  })

  await test('keeps grouped subcommands and flags for simple ordered commands', () => {
    const result = compileBashCommandParts({
      executable: 'docker',
      subcommands: ['compose', 'up'],
      flags: [{ name: 'detach', value: true }],
      positionals: ['api'],
    })

    assertEqual(result.command, 'docker compose up --detach api', 'grouped command')
  })

  await test('supports equals-style flags and repeated values', () => {
    const result = compileBashCommandParts({
      executable: 'pytest',
      flags: [
        { name: 'k', value: 'autoencoder or regression', style: 'equals' },
        { name: 'm', value: ['slow', 'gpu'] },
      ],
      positionals: ['tests/ml models'],
    })

    assertEqual(
      result.command,
      "pytest -k='autoencoder or regression' -m slow -m gpu 'tests/ml models'",
      'compiled pytest command',
    )
  })

  await test('reports mismatch against compiled command', () => {
    const result = validateBashCommandPartsMatch('docker compose up --detach web', {
      executable: 'docker',
      subcommands: ['compose', 'up'],
      flags: [{ name: 'detach', value: true }],
      positionals: ['api'],
    })

    assertEqual(result?.ok, false, 'expected mismatch')
    assertEqual(result?.compiledCommand, 'docker compose up --detach api', 'compiled command')
    assert(result?.message?.includes('Compiled command:'), 'expected compiled command message')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
