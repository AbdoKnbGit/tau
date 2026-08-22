/**
 * Bash prompt portability guidance regression tests.
 *
 * Run: bun run src/tools/BashTool/prompt.test.ts
 */

import {
  getBashCommandBestPractices,
  getBashPlatformBestPractices,
} from './bashBestPractices.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assertIncludes(lines: string[], text: string): void {
  const joined = lines.join('\n')
  if (!joined.includes(text)) {
    throw new Error(`expected guidance to include ${JSON.stringify(text)}`)
  }
}

function main(): void {
  console.log('bash command best practices:')

  test('covers the compact correctness contract', () => {
    const guidance = getBashCommandBestPractices()
    for (const expected of [
      '"$var"',
      '"$(command)"',
      '"${array[@]}"',
      'set -o pipefail',
      '>file 2>&1',
      'docker exec -i',
      "python <<'PY'",
      'Process substitution',
      'export NAME=value',
    ]) {
      assertIncludes(guidance, expected)
    }
    if (Buffer.byteLength(guidance.join('\n')) > 2_500) {
      throw new Error('command guidance exceeded 2500-byte budget')
    }
  })

  console.log('\nplatform-specific shell rules:')

  test('Linux uses Linux paths, /dev/null, and documents GNU behavior', () => {
    const guidance = getBashPlatformBestPractices('linux')
    assertIncludes(guidance, '/home/...')
    assertIncludes(guidance, '/dev/null')
    assertIncludes(guidance, 'GNU-only')
  })

  test('macOS uses BSD-compatible commands and avoids readlink -f assumptions', () => {
    const guidance = getBashPlatformBestPractices('macos')
    assertIncludes(guidance, '/Users/...')
    assertIncludes(guidance, 'BSD')
    assertIncludes(guidance, 'readlink -f')
    assertIncludes(guidance, 'Bash may be 3.x')
  })

  test('Git Bash uses POSIX Windows paths and never NUL', () => {
    const guidance = getBashPlatformBestPractices('windows')
    assertIncludes(guidance, '/c/path')
    assertIncludes(guidance, 'C:/path')
    assertIncludes(guidance, '/dev/null')
    assertIncludes(guidance, '`NUL`')
    assertIncludes(guidance, 'CRLF')
    assertIncludes(guidance, 'MSYS')
    assertIncludes(guidance, 'static container')
  })

  test('WSL separates Linux paths from mounted Windows paths', () => {
    const guidance = getBashPlatformBestPractices('wsl')
    assertIncludes(guidance, '/home/...')
    assertIncludes(guidance, '/mnt/c/...')
    assertIncludes(guidance, 'wslpath')
    assertIncludes(guidance, '/dev/null')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
