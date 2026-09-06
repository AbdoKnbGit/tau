/**
 * Retired agent-teams gate.
 *
 * Every teammate code path in the tree is reachable only through this
 * predicate. The bulk deletion of that code relies on it being false and
 * un-re-enablable, so these tests pin exactly that: no environment variable,
 * CLI flag, or USER_TYPE can turn teammates back on.
 *
 * When the last teammate caller is deleted, this file goes with the gate.
 *
 * Run: bun run src/utils/agentSwarmsEnabled.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

const here = dirname(fileURLToPath(import.meta.url))

console.log('agent swarms gate (retired)')

test('the gate is off', () => {
  assert(isAgentSwarmsEnabled() === false, 'teammates must be unreachable')
})

test('no environment variable re-enables it', () => {
  const vars = [
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    'CLAUDE_CODE_TEAM_NAME',
    'USER_TYPE',
  ]
  const saved = vars.map(v => [v, process.env[v]] as const)
  try {
    for (const v of vars) process.env[v] = '1'
    process.env.USER_TYPE = 'ant'
    assert(
      isAgentSwarmsEnabled() === false,
      'the gate must not read env any more — the opt-in was removed',
    )
  } finally {
    for (const [v, prior] of saved) {
      if (prior === undefined) delete process.env[v]
      else process.env[v] = prior
    }
  }
})

test('no argv flag re-enables it', () => {
  const saved = process.argv
  try {
    process.argv = [...saved, '--agent-teams']
    assert(isAgentSwarmsEnabled() === false, 'the --agent-teams flag was retired')
  } finally {
    process.argv = saved
  }
})

test('the source carries no opt-in path left to regress', () => {
  // Strip comments: the doc comment names the removed opt-in on purpose, so
  // what matters is that no executable statement reaches for it again.
  const code = readFileSync(join(here, 'agentSwarmsEnabled.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  for (const needle of [
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    'agent-teams',
    'process.env',
    'process.argv',
  ]) {
    assert(!code.includes(needle), `the retired gate must not read ${needle}`)
  }
})

test('the CLI no longer registers the --agent-teams option', () => {
  const main = readFileSync(join(here, '..', 'main.tsx'), 'utf8')
  assert(
    !main.includes("'--agent-teams'"),
    'a registered flag that cannot enable anything is worse than no flag',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
