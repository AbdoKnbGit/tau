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

  test('covers quoting, errors, Docker stdin, Python heredocs, and shell features', () => {
    const guidance = getBashCommandBestPractices()
    for (const expected of [
      '"$var"',
      '"$(command)"',
      '"${array[@]}"',
      'grep pattern file',
      'set -o pipefail',
      '>file 2>&1',
      'docker exec -i',
      'stay in the foreground automatically',
      "python <<'PY'",
      'inline evaluator',
      '--option value',
      'Process substitution',
      'bash --version',
      'run_in_background: true',
      'echo $!',
      'docker compose up -d',
      'export NAME=value',
    ]) {
      assertIncludes(guidance, expected)
    }
  })

  console.log('\nplatform-specific shell rules:')

  test('Linux uses Linux paths, /dev/null, and documents GNU behavior', () => {
    const guidance = getBashPlatformBestPractices('linux')
    assertIncludes(guidance, '/home/name/project')
    assertIncludes(guidance, '/dev/null')
    assertIncludes(guidance, 'readlink -f')
    assertIncludes(guidance, 'GNU')
  })

  test('macOS uses BSD-compatible commands and avoids readlink -f assumptions', () => {
    const guidance = getBashPlatformBestPractices('macos')
    assertIncludes(guidance, '/Users/name/project')
    assertIncludes(guidance, 'BSD')
    assertIncludes(guidance, 'readlink -f')
    assertIncludes(guidance, 'greadlink')
    assertIncludes(guidance, 'Bash 3.x')
  })

  test('Git Bash uses POSIX Windows paths and never NUL', () => {
    const guidance = getBashPlatformBestPractices('windows')
    assertIncludes(guidance, '/c/Users/name/project')
    assertIncludes(guidance, 'C:/Users/name/project')
    assertIncludes(guidance, 'cygpath -w')
    assertIncludes(guidance, '/dev/null')
    assertIncludes(guidance, 'Never redirect to `NUL`')
    assertIncludes(guidance, 'CRLF')
    assertIncludes(guidance, 'same native per-user temporary directory')
    assertIncludes(guidance, 'MSYS')
    assertIncludes(guidance, 'static remote arguments')
    assertIncludes(guidance, 'Quoting only the direct')
  })

  test('WSL separates Linux paths from mounted Windows paths', () => {
    const guidance = getBashPlatformBestPractices('wsl')
    assertIncludes(guidance, '/home/name/project')
    assertIncludes(guidance, '/mnt/c/Users/name/project')
    assertIncludes(guidance, 'wslpath -w')
    assertIncludes(guidance, '/dev/null')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
