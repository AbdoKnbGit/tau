/**
 * Bash workdir normalization unit tests.
 *
 * Run: bun run src/tools/BashTool/bashWorkdir.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, posix as pathPosix, relative, win32 as pathWin32 } from 'path'
import { toJSONSchema, z } from 'zod/v4'
import { getPlatform } from '../../utils/platform.js'
import {
  extractLeadingCdCommand,
  isSameBashCwd,
  normalizeBashExecutionInput,
  normalizeForHostFs,
  resolveBashPathFrom,
} from './bashWorkdir.js'

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

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

async function main(): Promise<void> {
  console.log('bash workdir normalization:')

  await test('extracts simple leading cd command', () => {
    const result = extractLeadingCdCommand('cd backend && npm install')
    assert(result?.target === 'backend', 'expected backend target')
    assert(result?.remainder === 'npm install', 'expected command remainder')
  })

  await test('does not extract dynamic cd target', () => {
    const result = extractLeadingCdCommand('cd "$PROJECT_DIR" && npm install')
    assert(result === null, 'dynamic cd target should not normalize')
  })

  await test('moves relative leading cd into workdir', () => {
    const root = pathPosix.join('/tmp', 'repo')
    const result = normalizeBashExecutionInput(
      { command: 'cd backend && npm install' },
      root,
      'linux',
    )
    assert(result.command === 'npm install', 'expected cd to be stripped')
    assert(result.workdir === pathPosix.join(root, 'backend'), `got ${result.workdir}`)
  })

  await test('combines provided workdir with leading cd', () => {
    const root = pathPosix.join('/tmp', 'repo')
    const result = normalizeBashExecutionInput(
      { command: 'cd app && npm test', workdir: 'packages' },
      root,
      'linux',
    )
    assert(result.command === 'npm test', 'expected cd to be stripped')
    assert(
      result.workdir === pathPosix.join(root, 'packages', 'app'),
      `got ${result.workdir}`,
    )
  })

  await test('normalizes chained literal cd commands', () => {
    const root = pathPosix.join('/tmp', 'repo')
    const result = normalizeBashExecutionInput(
      { command: 'cd packages && cd app && npm test' },
      root,
      'linux',
    )
    assert(result.command === 'npm test', 'expected both cd commands stripped')
    assert(
      result.workdir === pathPosix.join(root, 'packages', 'app'),
      `got ${result.workdir}`,
    )
  })

  await test('keeps command_parts inputs unchanged', () => {
    const input = {
      command: 'cd backend && npm install',
      command_parts: { executable: 'npm' },
    }
    const result = normalizeBashExecutionInput(input, 'tmp', 'linux')
    assert(result === input, 'expected exact same object when command_parts exist')
  })

  await test('resolves Windows native path as absolute on Windows', () => {
    const target = 'C:\\Workspace\\todo-app\\backend'
    const result = normalizeBashExecutionInput(
      { command: `cd ${target} && npm install` },
      'C:\\Workspace\\main-project',
      'windows',
    )
    assert(result.command === 'npm install', 'expected cd to be stripped')
    assert(result.workdir === target, `got ${result.workdir}`)
  })

  await test('marks synthesized workdir with _workdirFromCd flag', () => {
    const result = normalizeBashExecutionInput(
      { command: 'cd backend && npm install' },
      '/tmp/repo',
      'linux',
    )
    assert(result._workdirFromCd === true, 'expected _workdirFromCd flag')
  })

  await test('does not set _workdirFromCd for explicit workdir without cd', () => {
    const result = normalizeBashExecutionInput(
      { command: 'npm install', workdir: 'backend' },
      '/tmp/repo',
      'linux',
    )
    assert(result._workdirFromCd === undefined, 'flag must stay unset')
  })

  await test('omit+strip Bash input schema hides workdir and injected internals', () => {
    // Regression for the `unrecognized_keys: _workdirFromCd` crash in the Bash
    // permission dialog. Mirrors BashTool.tsx `inputSchema`: a strictObject with
    // workdir/internal keys omitted, re-wrapped as a STRIPPING z.object.
    // validateInput mutates the live tool input in place to add `_workdirFromCd`
    // (see normalizeBashExecutionInputInPlace), and the permission UI / api
    // layer then re-parses that same input. If this schema is left strict, that
    // parse throws and crashes the dialog. It must STRIP hidden keys, not reject
    // them.
    const full = z.strictObject({
      command: z.string(),
      description: z.string().optional(),
      workdir: z.string().optional(),
      _simulatedSedEdit: z
        .object({ filePath: z.string(), newContent: z.string() })
        .optional(),
      _workdirFromCd: z.boolean().optional(),
    })
    const strict = full.omit({
      workdir: true,
      _simulatedSedEdit: true,
      _workdirFromCd: true,
    })
    const modelFacing = z.object(strict.shape)

    // Old strict behavior would throw here — the exact production bug.
    let strictThrew = false
    try {
      strict.parse({ command: 'npm install', workdir: '/repo/be', _workdirFromCd: true })
    } catch {
      strictThrew = true
    }
    assert(strictThrew, 'sanity: a strict omit DOES reject the injected internal key')

    // New stripping behavior must parse cleanly and drop hidden keys.
    const parsed = modelFacing.parse({
      command: 'npm install',
      workdir: '/repo/be',
      _workdirFromCd: true,
    })
    assert(parsed.command === 'npm install', 'command must survive the parse')
    assert(!('workdir' in parsed), 'workdir must be stripped from the parsed result')
    assert(
      !('_workdirFromCd' in parsed),
      'internal flag must be stripped from the parsed result',
    )

    // The model-facing JSON must hide workdir and internal keys.
    const json = toJSONSchema(modelFacing) as {
      properties?: Record<string, unknown>
    }
    assert(
      !json.properties?.workdir &&
        !json.properties?._workdirFromCd &&
        !json.properties?._simulatedSedEdit,
      'workdir/internal keys must stay hidden from the model-facing schema',
    )
  })

  await test('isSameBashCwd compares case-insensitively on Windows', () => {
    assert(
      isSameBashCwd('C:\\Workspace\\Demo', 'c:\\workspace\\DEMO\\', 'windows'),
      'expected Windows paths to compare equal',
    )
  })

  await test('isSameBashCwd matches Git Bash and native Windows spellings', () => {
    assert(
      isSameBashCwd('/c/Workspace/Demo', 'C:\\Workspace\\Demo', 'windows'),
      'expected Git Bash spelling to match native spelling',
    )
  })

  await test('isSameBashCwd stays case-sensitive on linux', () => {
    assert(!isSameBashCwd('/tmp/Repo', '/tmp/repo', 'linux'), 'must differ')
    assert(isSameBashCwd('/tmp/repo/', '/tmp/repo', 'linux'), 'trailing slash equal')
  })

  await test('resolves Git Bash drive path to host Windows path', () => {
    const result = resolveBashPathFrom(
      'C:\\Workspace\\main-project',
      '/c/Workspace/todo-app/backend',
      'windows',
    )
    assert(
      result === 'C:\\Workspace\\todo-app\\backend',
      `got ${result}`,
    )
  })

  await test('maps only the Windows host /tmp alias to the OS temp directory', () => {
    for (const [target, suffix] of [
      ['/tmp', ''],
      ['/tmp/', ''],
      ['/tmp/dummy-project', 'dummy-project'],
      ['/tmp/project with spaces/nested', 'project with spaces/nested'],
    ] as const) {
      assert(
        normalizeForHostFs(target, 'windows') === pathWin32.join(tmpdir(), suffix),
        `wrong host mapping for ${target}`,
      )
    }
    for (const target of ['/tmp-other/repo', '/temporary/repo', 'tmp/repo', '/var/tmp/repo']) {
      assert(normalizeForHostFs(target, 'windows') === target, `must preserve ${target}`)
    }
  })

  await test('preserves native /tmp semantics on Linux, macOS, and WSL', () => {
    for (const platform of ['linux', 'macos', 'wsl'] as const) {
      assert(normalizeForHostFs('/tmp/project', platform) === '/tmp/project', platform)
      const result = normalizeBashExecutionInput(
        { command: 'cd /tmp/project && pwd' },
        '/workspace',
        platform,
      )
      assert(result.workdir === '/tmp/project', `wrong ${platform} workdir`)
      assert(result.command === 'pwd' && result._workdirFromCd === true, platform)
    }
  })

  await test('leaves remote /tmp paths and git -C commands untouched', () => {
    for (const command of [
      'git -C /tmp/dummy-project status',
      'docker exec -w /tmp app sh -c "cd /tmp/project && pwd"',
      'docker compose exec namenode hadoop fs -ls /tmp/',
      'hadoop fs -ls /tmp/',
      'hdfs dfs -cat /tmp/result',
    ]) {
      const input = { command }
      assert(normalizeBashExecutionInput(input, 'Q:\\workspace', 'windows') === input, command)
      const result = normalizeBashExecutionInput(
        { command: `cd /tmp && ${command}` },
        'Q:\\workspace',
        'windows',
      )
      assert(result.command === command, `remote arguments changed: ${command}`)
    }
  })

  if (getPlatform() === 'windows') {
    await test('fixes /tmp cd chains without changing cwd flags or command contents', () => {
      const command = 'git add -A && git commit -m "Initial commit"'
      const result = normalizeBashExecutionInput(
        { command: `cd /tmp/dummy-project && ${command}` },
        tmpdir(),
      )
      assert(result.workdir === join(tmpdir(), 'dummy-project'), `got ${result.workdir}`)
      assert(result.command === command, 'git command must stay unchanged')
      assert(result._workdirFromCd === true, 'cd persistence flag must survive')
      assert(normalizeBashExecutionInput(result, tmpdir()) === result, 'must be idempotent')

      const chained = normalizeBashExecutionInput(
        { command: 'cd /tmp && cd "project with spaces" && pwd' },
        tmpdir(),
      )
      assert(chained.workdir === join(tmpdir(), 'project with spaces'), 'chained cd target')
      assert(chained.command === 'pwd', 'chained cd remainder')

      const explicit = normalizeBashExecutionInput({ command: 'pwd', workdir: '/tmp' }, tmpdir())
      assert(explicit.workdir === tmpdir(), 'explicit /tmp workdir')
      assert(explicit._workdirFromCd === undefined, 'explicit workdir must remain one-off')
      assert(isSameBashCwd('/tmp', tmpdir()), 'temp alias must match native cwd')
    })

    await test('uses configured temp roots without assuming a drive or caching the path', () => {
      const previousTemp = process.env.TEMP
      try {
        for (const temp of ['Q:\\custom temp', 'Z:\\', '\\\\server\\share\\temp']) {
          process.env.TEMP = temp
          assert(
            resolveBashPathFrom('R:\\workspace', '/tmp/project', 'windows') === pathWin32.join(temp, 'project'),
            `must use current temp root ${temp}`,
          )
        }
      } finally {
        if (previousTemp === undefined) delete process.env.TEMP
        else process.env.TEMP = previousTemp
      }
    })
  }

  await test('collapses a repeated cwd suffix from a leading cd', () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-workdir-overlap-'))
    try {
      const actual = join(root, 'sd', 'ef')
      mkdirSync(actual, { recursive: true })
      const repeated = relative(root, actual)
      const result = normalizeBashExecutionInput(
        { command: `cd ${repeated} && docker compose up -d` },
        actual,
        getPlatform(),
      )
      assert(result.command === 'docker compose up -d', 'expected cd to be stripped')
      assert(result.workdir === actual, `expected ${actual}, got ${result.workdir}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('collapses a repeated cwd suffix from an explicit workdir', () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-workdir-explicit-'))
    try {
      const actual = join(root, 'project', 'nested')
      mkdirSync(actual, { recursive: true })
      const repeated = relative(root, actual)
      const result = normalizeBashExecutionInput(
        { command: 'npm test', workdir: repeated },
        actual,
        getPlatform(),
      )
      assert(result.workdir === actual, `expected ${actual}, got ${result.workdir}`)
      assert(result._workdirFromCd === undefined, 'explicit workdir must stay one-off')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('keeps a real nested directory even when its name repeats', () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-workdir-real-nested-'))
    try {
      const current = join(root, 'app')
      const realChild = join(current, 'app')
      mkdirSync(realChild, { recursive: true })
      const result = normalizeBashExecutionInput(
        { command: 'cd app && pwd' },
        current,
        getPlatform(),
      )
      assert(result.workdir === realChild, `expected real child ${realChild}, got ${result.workdir}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('recovers a cd target expressed relative to an ancestor of cwd', () => {
    // cwd is .../todo-app/backend but the model wrote `cd todo-app/frontend`
    // (as if cwd were the project root). The literal path does not exist; the
    // sibling frontend does, reachable by resolving the same relative path
    // against the grandparent. This is the reported real-world failure.
    const root = mkdtempSync(join(tmpdir(), 'tau-workdir-ancestor-'))
    try {
      const backend = join(root, 'todo-app', 'backend')
      const frontend = join(root, 'todo-app', 'frontend')
      mkdirSync(backend, { recursive: true })
      mkdirSync(frontend, { recursive: true })
      const result = normalizeBashExecutionInput(
        { command: 'cd todo-app/frontend && npm run dev' },
        backend,
        getPlatform(),
      )
      assert(result.command === 'npm run dev', 'expected cd to be stripped')
      assert(result.workdir === frontend, `expected ${frontend}, got ${result.workdir}`)
      assert(result._workdirFromCd === true, 'expected _workdirFromCd flag')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('recovers a sibling directory from the nearest ancestor', () => {
    // `cd frontend` from .../todo-app/backend → the sibling one level up wins.
    const root = mkdtempSync(join(tmpdir(), 'tau-workdir-sibling-'))
    try {
      const backend = join(root, 'todo-app', 'backend')
      const frontend = join(root, 'todo-app', 'frontend')
      mkdirSync(backend, { recursive: true })
      mkdirSync(frontend, { recursive: true })
      const result = normalizeBashExecutionInput(
        { command: 'cd frontend && npm test' },
        backend,
        getPlatform(),
      )
      assert(result.command === 'npm test', 'expected cd to be stripped')
      assert(result.workdir === frontend, `expected ${frontend}, got ${result.workdir}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('does not redirect a cd target that exists nowhere', () => {
    // No ancestor holds the target — keep the lexical (nonexistent) workdir so
    // the shell surfaces its clear "workdir does not exist" error.
    const root = mkdtempSync(join(tmpdir(), 'tau-workdir-nomatch-'))
    try {
      const backend = join(root, 'todo-app', 'backend')
      mkdirSync(backend, { recursive: true })
      const result = normalizeBashExecutionInput(
        { command: 'cd frontend && npm test' },
        backend,
        getPlatform(),
      )
      assert(
        result.workdir === join(backend, 'frontend'),
        `expected lexical ${join(backend, 'frontend')}, got ${result.workdir}`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
