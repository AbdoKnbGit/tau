/** Focused regression tests for vendored-ripgrep compatibility probing. */

import { isUsableRipgrep, parseRipgrepMajorVersion } from './ripgrepBinary.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
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

console.log('ripgrep binary compatibility:')

test('rejects a missing vendored binary without spawning it', () => {
  let spawned = false
  const usable = isUsableRipgrep('/missing/rg', {
    fileExists: () => false,
    spawnSyncImpl: (() => {
      spawned = true
      throw new Error('must not spawn')
    }) as never,
  })
  assert(!usable, 'missing binary was accepted')
  assert(!spawned, 'missing binary was executed')
})

test('rejects an incompatible binary and allows system-rg fallback', () => {
  const usable = isUsableRipgrep('/vendor/rg', {
    fileExists: () => true,
    spawnSyncImpl: (() => ({
      status: null,
      stdout: '',
      error: Object.assign(new Error('not found'), { code: 'ENOENT' }),
    })) as never,
  })
  assert(!usable, 'incompatible binary was accepted')
})

test('accepts only a successful ripgrep version probe', () => {
  const usable = isUsableRipgrep('/vendor/rg', {
    fileExists: () => true,
    spawnSyncImpl: (() => ({
      status: 0,
      stdout: 'ripgrep 14.1.1\n',
    })) as never,
  })
  assert(usable, 'working ripgrep binary was rejected')

  const impostor = isUsableRipgrep('/vendor/rg', {
    fileExists: () => true,
    spawnSyncImpl: (() => ({ status: 0, stdout: 'not-ripgrep\n' })) as never,
  })
  assert(!impostor, 'unrelated executable was accepted as ripgrep')
})

test('parses capability versions from official and development version banners', () => {
  for (const [banner, expected] of [
    ['ripgrep 11.0.2\n', 11],
    ['ripgrep 12.0.0\r\n', 12],
    ['ripgrep 15.2.0 (rev e89fff89ac)\nfeatures:+pcre2', 15],
    ['ripgrep 15.2.0-dev+build\n', 15],
  ] as const) {
    assert(parseRipgrepMajorVersion(banner) === expected, `wrong version: ${banner}`)
  }
})

test('unknown and malformed banners never enable a ripgrep capability', () => {
  for (const banner of ['', 'grep 15.2.0', 'ripgrep 15', 'ripgrep 15.2.0junk',
    'error: ripgrep 15.2.0', 'ripgrep 999999999999999999999.0.0']) {
    assert(parseRipgrepMajorVersion(banner) === null, `accepted ${banner}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
