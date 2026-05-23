/**
 * Bash eval quoting regression tests.
 *
 * Run: bun run src/utils/bash/shellQuoting.test.ts
 */

import { quoteShellCommand } from './shellQuoting.js'
import { formatShellPrefixCommand } from './shellPrefix.js'

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

function main(): void {
  console.log('shell eval quoting:')

  test('preserves jq not-equals filters', () => {
    const quoted = quoteShellCommand(`jq '.x != .y' file`)

    assert(quoted.includes('!='), 'expected != to be preserved')
    assert(!quoted.includes('\\!'), 'must not inject a backslash before !')
  })

  test('redirects eval stdin instead of rewriting pipelines', () => {
    const quoted = quoteShellCommand('rg foo | wc -l')

    assert(
      quoted === "'rg foo | wc -l' < /dev/null",
      `unexpected quoted command: ${quoted}`,
    )
  })

  test('does not add stdin redirect to heredocs', () => {
    const quoted = quoteShellCommand("python - <<'PY'\nprint('hi')\nPY")

    assert(!quoted.endsWith(' < /dev/null'), 'heredoc got stdin redirect')
    assert(quoted.includes("print('\"'\"'hi'\"'\"')"), 'single quote escaping changed')
  })

  test('prefix wrapping preserves not-equals filters', () => {
    const wrapped = formatShellPrefixCommand(
      '/usr/bin/env bash -c',
      quoteShellCommand(`jq '.x != .y' file`),
    )

    assert(wrapped.includes('!='), 'expected != to be preserved')
    assert(!wrapped.includes('\\!'), 'must not inject a backslash before !')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
