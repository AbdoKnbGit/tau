/**
 * Eval kernel PATH parity with the Bash tool.
 *
 * Run via: bun run src/tools/EvalTool/shellPath.test.ts
 */

import { execFileSync } from 'child_process'
import { isAbsolute } from 'path'

import {
  _resetBashToolPathForTest,
  bashToolPathEntries,
  splitPathList,
  withAppendedPath,
} from './shellPath.js'

let passed = 0
let failed = 0

function assert(cond: unknown, hint: string): asserts cond {
  if (!cond) throw new Error(hint)
}

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

async function main(): Promise<void> {
  console.log('shellPath')

  await test('appends only what the PATH lacks, keeping the key spelling', () => {
    const env = { Path: 'C:\\Windows\\system32;C:\\Tools\\', HOME: 'x' }
    const out = withAppendedPath(env, ['c:\\tools', 'C:\\Git\\mingw64\\bin', 'C:\\Git\\usr\\bin\\', 'C:\\GIT\\MINGW64\\BIN'],
      { delimiter: ';', caseInsensitive: true })
    assert(!('PATH' in out), 'a second, differently cased PATH was added')
    assert(out.Path === 'C:\\Windows\\system32;C:\\Tools\\;C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin\\', out.Path)
    assert(out.HOME === 'x', 'another variable changed')
  })

  await test('nothing to add returns the same environment', () => {
    const env = { PATH: '/usr/bin:/bin' }
    assert(withAppendedPath(env, [], { delimiter: ':' }) === env, 'empty list changed the env')
    assert(withAppendedPath(env, ['/usr/bin/'], { delimiter: ':', caseInsensitive: false }) === env,
      'an entry already present was added again')
  })

  await test('POSIX comparison is case-sensitive', () => {
    const out = withAppendedPath({ PATH: '/opt/Tools' }, ['/opt/tools'], { delimiter: ':', caseInsensitive: false })
    assert(out.PATH === '/opt/Tools:/opt/tools', out.PATH)
  })

  await test('a missing PATH gets one', () => {
    const out = withAppendedPath({}, ['/a'], { delimiter: ':' })
    assert(out.PATH === '/a', JSON.stringify(out))
  })

  await test('path lists split cleanly', () => {
    const parts = splitPathList(' C:\\a ;;C:\\b\r\n', ';')
    assert(JSON.stringify(parts) === JSON.stringify(['C:\\a', 'C:\\b']), JSON.stringify(parts))
  })

  await test('the Bash tool PATH comes back as native, absolute paths', async () => {
    _resetBashToolPathForTest()
    const entries = await bashToolPathEntries()
    if (process.platform !== 'win32') {
      assert(entries.length === 0, 'nothing should be added where the snapshot pins PATH')
      return
    }
    for (const entry of entries) {
      assert(isAbsolute(entry) && !entry.startsWith('/'), `not a native path: ${entry}`)
    }
    // Asked once per session.
    assert((await bashToolPathEntries()) === entries, 'the shell was asked twice')
  })

  await test('every program the Bash tool resolves is on the appended PATH', async () => {
    if (process.platform !== 'win32') return
    const { findGitBashPath } = await import('../../utils/windowsPaths.js')
    const bash = findGitBashPath()
    if (!bash) return
    const env = withAppendedPath({ ...process.env } as Record<string, string>, await bashToolPathEntries())
    for (const name of ['ls', 'sed', 'awk', 'file', 'pdftotext']) {
      let inShell = ''
      try {
        inShell = execFileSync(bash, ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
      } catch {
        continue
      }
      if (!inShell) continue
      const found = execFileSync('where.exe', [name], { env, encoding: 'utf8' }).trim()
      assert(found.length > 0, `${name}: Bash finds ${inShell}, the kernel's PATH does not`)
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
