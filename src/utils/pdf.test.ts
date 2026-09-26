/**
 * PDF tool detection and failure wording unit tests.
 *
 * Run: bun run src/utils/pdf.test.ts
 */

import {
  describePdfToolFailure,
  getPopplerInstallHint,
  isPdfToolVersionBanner,
} from './pdf.js'

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

console.log('pdf tools:')

test('a version banner proves the tool ran (Poppler and Xpdf)', () => {
  assert(isPdfToolVersionBanner('pdftoppm', 'pdftoppm version 24.02.0'), 'Poppler banner')
  assert(isPdfToolVersionBanner('pdftotext', 'pdftotext version 4.06 [www.xpdfreader.com]'), 'Xpdf banner')
})

test('a launch failure on stderr is not a banner', () => {
  assert(
    !isPdfToolVersionBanner('pdftoppm', "'pdftoppm' is not recognized as an internal or external command"),
    'cmd.exe not-found text',
  )
  assert(!isPdfToolVersionBanner('pdftoppm', 'pdftotext version 4.06'), 'another tool')
})

test('install hint per OS', () => {
  assert(getPopplerInstallHint('win32').includes('winget install oschwartz10612.Poppler'), 'Windows')
  assert(getPopplerInstallHint('darwin').includes('brew install poppler'), 'macOS')
  assert(getPopplerInstallHint('linux').includes('poppler-utils'), 'Linux')
})

test('a Windows crash code is called a crash, in hex', () => {
  const text = describePdfToolFailure('pdftotext', {
    code: 3221225477,
    stderr: '',
    error: 'Command failed with exit code 3221225477: pdftotext -layout -enc UTF-8 -f 2 -l 3 "C:\\x\\a.pdf" -',
  })
  assert(text === 'pdftotext crashed (Windows error 0xC0000005).', text)
})

test('a negative Windows crash code reads the same', () => {
  const text = describePdfToolFailure('pdftoppm', { code: -1073741819, stderr: '' })
  assert(text === 'pdftoppm crashed (Windows error 0xC0000005).', text)
})

test('a crash signal is called a crash', () => {
  const text = describePdfToolFailure('pdftotext', {
    code: 1,
    stderr: '',
    error: 'Command was killed with SIGSEGV (Segmentation fault): pdftotext a.pdf -',
  })
  assert(text === 'pdftotext crashed (SIGSEGV): Command was killed with SIGSEGV (Segmentation fault)', text)
})

test('a timeout keeps its reason and is not a crash', () => {
  const text = describePdfToolFailure('pdftoppm', {
    code: 1,
    stderr: '',
    error: 'Command timed out after 120000 milliseconds: pdftoppm -jpeg a.pdf page',
  })
  assert(text === 'pdftoppm failed (exit code 1): Command timed out after 120000 milliseconds', text)
})

test("the tool's stderr is the detail when present", () => {
  const text = describePdfToolFailure('pdftotext', {
    code: 1,
    stderr: 'Syntax Error: Couldn\'t find trailer dictionary\n',
    error: 'Command failed with exit code 1: pdftotext a.pdf -',
  })
  assert(text === "pdftotext failed (exit code 1): Syntax Error: Couldn't find trailer dictionary", text)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
