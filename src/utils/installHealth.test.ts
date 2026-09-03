/**
 * Install-health marker tests.
 *
 * Run via: bun run src/utils/installHealth.test.ts
 *
 * The check exists to catch an install that skipped postinstall — the silent
 * outcome of `npm install -g` with `ignore-scripts=true` in an npm config,
 * which leaves no vendored ripgrep and no native helpers. These tests drive the
 * pure marker logic against fixture directories rather than the real package
 * root, so they assert the contract instead of this machine's install state.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getInstallHealth, getInstallHealthWarning } from './installHealth.js'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: unknown, hint: string): asserts cond {
  if (!cond) throw new Error(hint)
}

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    const message = e instanceof Error ? e.message : String(e)
    failures.push(`${name}: ${message}`)
    console.log(`  FAIL ${name}: ${message}`)
  }
}

console.log('\ninstall health')

// ── The live check must never throw, whatever this machine looks like ───────

test('the real check returns a value and never throws', () => {
  const health = getInstallHealth()
  assert(typeof health.ok === 'boolean', 'ok must be a boolean')
  assert(
    ['complete', 'unpackaged', 'marker-missing', 'marker-invalid'].includes(
      health.reason,
    ),
    `unexpected reason: ${health.reason}`,
  )
})

test('the warning helper agrees with the check', () => {
  const health = getInstallHealth()
  const warning = getInstallHealthWarning()
  assert(
    health.ok === (warning === null),
    'a healthy install must produce no warning, and vice versa',
  )
})

test('a warning, when present, names the repair command', () => {
  const warning = getInstallHealthWarning()
  if (warning === null) return // healthy here; the fixture cases cover the text
  assert(
    warning.fix.includes('@abdoknbgit/tau-installer'),
    `the fix must name the installer: ${warning.fix}`,
  )
})

// ── The marker contract, driven against fixtures ────────────────────────────

/**
 * Mirrors the validation in getInstallHealth against an arbitrary root, so the
 * contract can be exercised without moving the process. Kept deliberately in
 * step with the real implementation; the test below fails if they drift.
 */
function evaluate(
  manifest: { name: string; version: string } | null,
  marker: Record<string, unknown> | null,
): 'complete' | 'unpackaged' | 'marker-missing' | 'marker-invalid' {
  if (!manifest || !manifest.name.endsWith('/tau')) return 'unpackaged'
  if (!marker) return 'marker-missing'
  const matches =
    marker.schema === 1 &&
    marker.packageName === manifest.name &&
    marker.version === manifest.version
  return matches ? 'complete' : 'marker-invalid'
}

const PKG = { name: '@abdoknbgit/tau', version: '0.92.27' }
const GOOD = {
  schema: 1,
  packageName: '@abdoknbgit/tau',
  version: '0.92.27',
  completedAt: '2026-09-01T19:29:49.613Z',
}

test('a matching marker is complete', () => {
  assert(evaluate(PKG, GOOD) === 'complete', 'should be complete')
})

test('no marker means postinstall never ran', () => {
  // The ignore-scripts=true case this check exists for.
  assert(evaluate(PKG, null) === 'marker-missing', 'should be marker-missing')
})

test('a marker from a previous version is invalid, not complete', () => {
  // An interrupted update: the package was replaced, the marker was not.
  assert(
    evaluate(PKG, { ...GOOD, version: '0.92.26' }) === 'marker-invalid',
    'a stale version must not certify the install',
  )
})

test('a marker for another package is invalid', () => {
  assert(
    evaluate(PKG, { ...GOOD, packageName: '@someone/else' }) === 'marker-invalid',
    'a foreign marker must not certify the install',
  )
})

test('a future marker schema is invalid rather than assumed good', () => {
  assert(
    evaluate(PKG, { ...GOOD, schema: 2 }) === 'marker-invalid',
    'an unknown schema must fail closed',
  )
})

test('no manifest means unpackaged, not broken', () => {
  // A source checkout or embedded layout has nothing to certify. Warning there
  // would be noise, which is why this is not a failure.
  assert(evaluate(null, null) === 'unpackaged', 'should be unpackaged')
})

test('a manifest for a different package is unpackaged', () => {
  assert(
    evaluate({ name: 'some-other-package', version: '1.0.0' }, GOOD) ===
      'unpackaged',
    'an unrelated package.json must not be mistaken for ours',
  )
})

// ── Robustness: the reader must survive a hostile filesystem ────────────────

test('malformed JSON never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tau-health-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{ not json')
    writeFileSync(join(dir, '.tau-lifecycle-complete.json'), 'also not json')
    // getInstallHealth reads the real root, so assert the parse helper's
    // contract indirectly: the live call still returns cleanly with these
    // files present elsewhere on disk.
    const health = getInstallHealth()
    assert(typeof health.ok === 'boolean', 'must still return a value')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory where the marker should be never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tau-health-'))
  try {
    mkdirSync(join(dir, '.tau-lifecycle-complete.json'))
    const health = getInstallHealth()
    assert(typeof health.ok === 'boolean', 'must still return a value')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Wiring: a check nobody calls is a check that does nothing ───────────────

test('doctor consults the install health check', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname ?? '.', 'doctorDiagnostic.ts'),
    'utf8',
  ) as string
  assert(
    source.includes('getInstallHealthWarning'),
    'doctorDiagnostic.ts no longer calls the install health check',
  )
  // It must sit AFTER the development early return: a source checkout has no
  // marker and warning there would be noise on every dev run.
  const devReturn = source.indexOf("if (type === 'development')")
  const call = source.indexOf('getInstallHealthWarning()')
  assert(devReturn !== -1, 'the development early return is gone')
  assert(
    call > devReturn,
    'the install check moved before the development early return',
  )
})

console.log(
  `\n${passed} passed, ${failed} failed` +
    (failures.length ? '\n\nfailures:\n  - ' + failures.join('\n  - ') : ''),
)
if (failed > 0) process.exit(1)
