/**
 * Bash preflight validation unit tests.
 *
 * Run: bun run src/tools/BashTool/bashPreflightValidation.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalizeForFs, validateBashExecutionPreflight } from './bashPreflightValidation.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
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

async function main(): Promise<void> {
  console.log('bash preflight validation:')

  const root = mkdtempSync(join(tmpdir(), 'tau-bash-preflight-'))

  try {
    await test('blocks leading cd into a missing directory', async () => {
      const result = await validateBashExecutionPreflight(
        { command: 'cd frontend && npm run build' },
        root,
      )

      assert(!result.ok, 'expected missing cd target to be blocked')
      assert(
        !result.ok && result.message.includes('Bash preflight blocked'),
        `expected preflight message, got: ${result.ok ? 'ok' : result.message}`,
      )
      assert(
        !result.ok && result.message.includes('find .. -maxdepth 4 -name package.json'),
        'expected manifest search guidance',
      )
    })

    await test('allows leading cd when the directory exists', async () => {
      mkdirSync(join(root, 'frontend'))

      const result = await validateBashExecutionPreflight(
        { command: 'cd frontend && npm run build' },
        root,
      )

      assert(result.ok, 'expected existing cd target to pass')
    })

    await test('resolves cd target from provided workdir', async () => {
      const packages = join(root, 'packages')
      mkdirSync(packages)

      const result = await validateBashExecutionPreflight(
        { command: 'cd app && npm test', workdir: 'packages' },
        root,
      )

      assert(!result.ok, 'expected missing cd target under workdir to block')
      assert(
        !result.ok && result.message.includes('packages'),
        'expected workdir context in message',
      )
    })

    await test('blocks missing workdir before shell execution', async () => {
      const result = await validateBashExecutionPreflight(
        { command: 'npm run build', workdir: 'missing' },
        root,
      )

      assert(!result.ok, 'expected missing workdir to be blocked')
      assert(
        !result.ok && result.message.includes('requested workdir'),
        'expected missing workdir message',
      )
    })

    await test('does not block dynamic cd targets', async () => {
      const result = await validateBashExecutionPreflight(
        { command: 'cd "$PROJECT_DIR" && npm test' },
        root,
      )

      assert(result.ok, 'expected dynamic cd target to pass')
    })

    await test('normalizeForFs translates Git Bash drive paths on Windows', () => {
      assert(
        normalizeForFs('/c/Users/ok/Desktop/test2-teamode/backend', 'windows') ===
          'C:\\Users\\ok\\Desktop\\test2-teamode\\backend',
        'Git Bash drive form should convert',
      )
      assert(
        normalizeForFs('/d/projects', 'windows') === 'D:\\projects',
        'lowercase drive letter should uppercase',
      )
    })

    await test('normalizeForFs translates Cygwin and UNC paths on Windows', () => {
      assert(
        normalizeForFs('/cygdrive/c/Users/foo', 'windows') === 'C:\\Users\\foo',
        'Cygwin form should convert',
      )
      assert(
        normalizeForFs('//server/share/path', 'windows') === '\\\\server\\share\\path',
        'UNC form should convert',
      )
    })

    await test('normalizeForFs leaves non-POSIX paths untouched on Windows', () => {
      assert(
        normalizeForFs('C:\\Users\\foo', 'windows') === 'C:\\Users\\foo',
        'native Windows path unchanged',
      )
      assert(
        normalizeForFs('backend', 'windows') === 'backend',
        'relative path unchanged',
      )
      assert(
        normalizeForFs('./backend/sub', 'windows') === './backend/sub',
        'dot-relative path unchanged',
      )
    })

    await test('normalizeForFs is a no-op on non-Windows hosts', () => {
      assert(
        normalizeForFs('/c/Users/foo', 'linux') === '/c/Users/foo',
        'Linux should not rewrite — /c/ is a real directory name',
      )
      assert(
        normalizeForFs('/c/Users/foo', 'macos') === '/c/Users/foo',
        'macOS should not rewrite',
      )
    })

    await test('preflight accepts Git Bash POSIX cd target on Windows', async () => {
      // Repro of the original bug: cwd is a tmpdir, command does
      // `cd <gitbash-form-of-cwd>/subdir && ...`. Pre-fix this returned
      // !ok with "does not exist"; post-fix it should resolve correctly.
      if (process.platform !== 'win32') return

      const sub = join(root, 'backend')
      mkdirSync(sub, { recursive: true })

      // Build the POSIX-style absolute path the way Git Bash users write it.
      // `C:\Users\...\tmpX\backend` → `/c/Users/.../tmpX/backend`
      const driveMatch = sub.match(/^([A-Za-z]):(.*)$/)
      if (!driveMatch) return
      const posixForm =
        '/' + driveMatch[1]!.toLowerCase() + driveMatch[2]!.replace(/\\/g, '/')

      const result = await validateBashExecutionPreflight(
        { command: `cd ${posixForm} && ls -la` },
        root,
      )

      assert(result.ok, `expected POSIX cd target to be accepted on Windows; got: ${result.ok ? 'ok' : result.message}`)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
