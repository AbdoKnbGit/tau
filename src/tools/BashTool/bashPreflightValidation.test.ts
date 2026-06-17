/**
 * Bash preflight validation unit tests.
 *
 * Run: bun run src/tools/BashTool/bashPreflightValidation.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalizeForFs, resolveComposeWorkdir, resolveTargetWorkdir, validateBashExecutionPreflight } from './bashPreflightValidation.js'

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
        normalizeForFs('/c/Workspace/site/backend', 'windows') ===
          'C:\\Workspace\\site\\backend',
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
    await test('auto-resolves a script run to the subdirectory holding the file', async () => {
      const api = join(root, 'api')
      mkdirSync(api, { recursive: true })
      writeFileSync(join(api, 'server.js'), '// fixture')

      const resolution = await resolveTargetWorkdir('node server.js', root)
      assert(resolution.kind === 'auto', `expected auto-resolution, got: ${resolution.kind}`)
      assert(
        resolution.kind === 'auto' && resolution.workdir === api,
        'expected workdir to be the directory holding server.js',
      )
      assert(
        resolution.kind === 'auto' && resolution.label === 'server.js',
        'expected the file name as the label',
      )

      // Single candidate is auto-applied at call() time → preflight must allow.
      const preflight = await validateBashExecutionPreflight({ command: 'node server.js' }, root)
      assert(preflight.ok, `single-candidate script must not block, got: ${preflight.ok ? 'ok' : preflight.message}`)
    })

    await test('no redirection when the script exists in the execution dir', async () => {
      const resolution = await resolveTargetWorkdir('node server.js', join(root, 'api'))
      assert(resolution.kind === 'none', `expected none, got: ${resolution.kind}`)

      const result = await validateBashExecutionPreflight(
        { command: 'node server.js', workdir: 'api' },
        root,
      )
      assert(result.ok, `expected existing script target to pass, got: ${result.ok ? 'ok' : result.message}`)
    })

    await test('allows script referenced by its correct relative path', async () => {
      const resolution = await resolveTargetWorkdir('node api/server.js', root)
      assert(resolution.kind === 'none', 'correct relative path needs no redirect')

      const result = await validateBashExecutionPreflight(
        { command: 'node api/server.js' },
        root,
      )
      assert(result.ok, 'expected correct relative path to pass')
    })

    await test('does not auto-resolve a script referenced with a path component', async () => {
      // `node lib/missing.js` with a path component can't be fixed by changing
      // the workdir — leave it for the shell to report rather than guess.
      const resolution = await resolveTargetWorkdir('node lib/missing.js', root)
      assert(resolution.kind === 'none', `pathed target must not auto-resolve, got: ${resolution.kind}`)
    })

    await test('does not block a script that exists nowhere nearby', async () => {
      // Nothing to point at → run as-is; the shell reports the real error
      // (and bashFailureGuidance adds workdir hints) — no preflight block.
      const resolution = await resolveTargetWorkdir('python does_not_exist_anywhere.py', root)
      assert(resolution.kind === 'none', `expected none, got: ${resolution.kind}`)

      const result = await validateBashExecutionPreflight(
        { command: 'python does_not_exist_anywhere.py' },
        root,
      )
      assert(result.ok, 'a script with no nearby match must not be blocked')
    })

    await test('blocks an AMBIGUOUS script found in several different subdirectories', async () => {
      const ambig = join(root, 'amb-script')
      mkdirSync(join(ambig, 'a'), { recursive: true })
      mkdirSync(join(ambig, 'b'), { recursive: true })
      writeFileSync(join(ambig, 'a', 'app.js'), '// fixture')
      writeFileSync(join(ambig, 'b', 'app.js'), '// fixture')

      const resolution = await resolveTargetWorkdir('node app.js', ambig)
      assert(resolution.kind === 'ambiguous', `expected ambiguous, got: ${resolution.kind}`)

      const result = await validateBashExecutionPreflight({ command: 'node app.js' }, ambig)
      assert(!result.ok, 'ambiguous script must block')
    })

    await test('does not block dynamic or non-file script arguments', async () => {
      const dynamic = await validateBashExecutionPreflight(
        { command: 'node "$SCRIPT_PATH"' },
        root,
      )
      assert(dynamic.ok, 'dynamic argument must pass')

      const inlineCode = await validateBashExecutionPreflight(
        { command: 'python -c "print(1)"' },
        root,
      )
      assert(inlineCode.ok, 'inline code must pass')

      const plainCommand = await validateBashExecutionPreflight(
        { command: 'git status' },
        root,
      )
      assert(plainCommand.ok, 'non-interpreter command must pass')
    })

    await test('auto-resolves an npm command to the subdirectory holding package.json', async () => {
      writeFileSync(join(root, 'api', 'package.json'), '{}')

      const resolution = await resolveTargetWorkdir('npm install', root)
      assert(resolution.kind === 'auto', `expected auto-resolution, got: ${resolution.kind}`)
      assert(
        resolution.kind === 'auto' && resolution.workdir === join(root, 'api'),
        'expected workdir to be the directory holding package.json',
      )
      assert(
        resolution.kind === 'auto' && resolution.label === 'package.json',
        'expected package.json as the label',
      )

      const preflight = await validateBashExecutionPreflight({ command: 'npm install' }, root)
      assert(preflight.ok, `single-candidate manifest must not block, got: ${preflight.ok ? 'ok' : preflight.message}`)
    })

    await test('allows npm command when package.json exists in the execution dir', async () => {
      const resolution = await resolveTargetWorkdir('npm install', join(root, 'api'))
      assert(resolution.kind === 'none', `expected none, got: ${resolution.kind}`)

      const result = await validateBashExecutionPreflight(
        { command: 'npm install', workdir: 'api' },
        root,
      )
      assert(result.ok, 'expected manifest in workdir to pass')
    })

    await test('blocks an AMBIGUOUS npm command (package.json in several subdirectories)', async () => {
      const ambig = join(root, 'amb-manifest')
      mkdirSync(join(ambig, 'pkg-a'), { recursive: true })
      mkdirSync(join(ambig, 'pkg-b'), { recursive: true })
      writeFileSync(join(ambig, 'pkg-a', 'package.json'), '{}')
      writeFileSync(join(ambig, 'pkg-b', 'package.json'), '{}')

      const resolution = await resolveTargetWorkdir('npm run build', ambig)
      assert(resolution.kind === 'ambiguous', `expected ambiguous, got: ${resolution.kind}`)

      const result = await validateBashExecutionPreflight({ command: 'npm run build' }, ambig)
      assert(!result.ok, 'ambiguous manifest must block')
    })

    // Dedicated root for compose tests so sibling fixtures (api/, frontend/,
    // package.json) can't leak into the downward Compose-file search.
    const composeRoot = join(root, 'compose-root')
    const composeStack = join(composeRoot, 'sd', 'ef')
    mkdirSync(composeStack, { recursive: true })
    writeFileSync(join(composeStack, 'docker-compose.yml'), 'services: {}')

    await test('auto-resolves docker compose up to the single subdirectory holding the Compose file', async () => {
      // Reported case: run from the project root, Compose file lives in sd/ef/.
      // A single unambiguous candidate is auto-applied as the workdir at call
      // time, so the preflight ALLOWS it (no block, no loop).
      const resolution = await resolveComposeWorkdir('docker compose up -d', composeRoot)
      assert(resolution.kind === 'auto', `expected auto-resolution, got: ${resolution.kind}`)
      assert(
        resolution.kind === 'auto' && resolution.relWorkdir === join('sd', 'ef'),
        `expected relWorkdir sd/ef, got: ${resolution.kind === 'auto' ? resolution.relWorkdir : '-'}`,
      )
      assert(
        resolution.kind === 'auto' && resolution.workdir === composeStack,
        'expected absolute workdir to be the Compose file directory',
      )

      const preflight = await validateBashExecutionPreflight(
        { command: 'docker compose up -d' },
        composeRoot,
      )
      assert(preflight.ok, `single-candidate compose must not block, got: ${preflight.ok ? 'ok' : preflight.message}`)
    })

    await test('no redirection when a Compose file is already in the execution dir', async () => {
      const resolution = await resolveComposeWorkdir('docker compose up -d', composeStack)
      assert(resolution.kind === 'none', `expected none, got: ${resolution.kind}`)

      const ok = await validateBashExecutionPreflight(
        { command: 'docker compose up -d', workdir: 'sd/ef' },
        composeRoot,
      )
      assert(ok.ok, `expected compose in workdir to pass, got: ${ok.ok ? 'ok' : ok.message}`)
    })

    await test('a stray Compose file in a PARENT does not hijack the subdirectory resolution', async () => {
      // Regression for the reported bug: the run dir has no Compose file, an
      // unrelated one sits in a parent (the classic ~/Desktop leftover), and
      // the real one is in a subdirectory. The parent must be ignored and the
      // subdirectory chosen.
      const parent = join(root, 'stray-parent')
      const work = join(parent, 'work')
      const svc = join(work, 'svc')
      mkdirSync(svc, { recursive: true })
      writeFileSync(join(parent, 'docker-compose.yml'), 'services: {}') // stray
      writeFileSync(join(svc, 'docker-compose.yml'), 'services: {}') // the real one

      const resolution = await resolveComposeWorkdir('docker compose up -d', work)
      assert(
        resolution.kind === 'auto' && resolution.workdir === svc,
        `stray parent must not hijack; expected svc, got: ${resolution.kind === 'auto' ? resolution.workdir : resolution.kind}`,
      )
    })

    await test('blocks AMBIGUOUS compose when Compose files live in different subdirectories', async () => {
      const ambig = join(root, 'ambig')
      mkdirSync(join(ambig, 'a'), { recursive: true })
      mkdirSync(join(ambig, 'b'), { recursive: true })
      writeFileSync(join(ambig, 'a', 'docker-compose.yml'), 'services: {}')
      writeFileSync(join(ambig, 'b', 'compose.yaml'), 'services: {}')

      const resolution = await resolveComposeWorkdir('docker compose up -d', ambig)
      assert(resolution.kind === 'ambiguous', `expected ambiguous, got: ${resolution.kind}`)

      const result = await validateBashExecutionPreflight(
        { command: 'docker compose up -d' },
        ambig,
      )
      assert(!result.ok, 'ambiguous compose must block')
      assert(
        !result.ok && result.message.includes('a') && result.message.includes('b'),
        'expected both candidate directories listed',
      )
    })

    await test('no redirection when the run dir has no Compose file in any subdirectory', async () => {
      const leaf = join(root, 'leaf-no-compose')
      mkdirSync(leaf, { recursive: true })

      const resolution = await resolveComposeWorkdir('docker compose up -d', leaf)
      assert(resolution.kind === 'none', `expected none, got: ${resolution.kind}`)

      const ok = await validateBashExecutionPreflight(
        { command: 'docker compose up -d' },
        leaf,
      )
      assert(ok.ok, `nothing nearby to point at must pass, got: ${ok.ok ? 'ok' : ok.message}`)
    })

    await test('auto-resolves the hyphenated docker-compose form too', async () => {
      const resolution = await resolveComposeWorkdir('docker-compose up', composeRoot)
      assert(
        resolution.kind === 'auto' && resolution.relWorkdir === join('sd', 'ef'),
        `expected hyphenated form to auto-resolve, got: ${resolution.kind}`,
      )
    })

    await test('no redirection for docker compose with an explicit -f file', async () => {
      const resolution = await resolveComposeWorkdir(
        'docker compose -f sd/ef/docker-compose.yml up -d',
        composeRoot,
      )
      assert(resolution.kind === 'none', `explicit -f must skip resolution, got: ${resolution.kind}`)
    })

    await test('no redirection for file-less compose subcommands', async () => {
      const version = await resolveComposeWorkdir('docker compose version', composeRoot)
      assert(version.kind === 'none', 'compose version needs no Compose file')

      const ls = await resolveComposeWorkdir('docker compose ls', composeRoot)
      assert(ls.kind === 'none', 'compose ls needs no Compose file')
    })

    // --- Cross-root resolution (the "different directory tree" case) ----------

    await test('resolves a target that lives in a DIFFERENT root via searchRoots', async () => {
      // cwd has nothing under it; the file lives in a separate tree passed as a
      // known root (an added dir or a session-visited dir).
      const here = join(root, 'mr-cwd')
      const otherRoot = join(root, 'mr-other')
      const otherApp = join(otherRoot, 'app')
      mkdirSync(here, { recursive: true })
      mkdirSync(otherApp, { recursive: true })
      writeFileSync(join(otherApp, 'server.js'), '// fixture')

      const resolution = await resolveTargetWorkdir('node server.js', here, [otherRoot])
      assert(resolution.kind === 'auto', `expected auto across roots, got: ${resolution.kind}`)
      assert(
        resolution.kind === 'auto' && resolution.workdir === otherApp,
        `expected workdir in the other root, got: ${resolution.kind === 'auto' ? resolution.workdir : resolution.kind}`,
      )
    })

    await test('cross-root resolution works for compose and manifests too', async () => {
      const here = join(root, 'mr-cwd2')
      const composeOther = join(root, 'mr-compose', 'stack')
      const manifestOther = join(root, 'mr-manifest', 'web')
      mkdirSync(here, { recursive: true })
      mkdirSync(composeOther, { recursive: true })
      mkdirSync(manifestOther, { recursive: true })
      writeFileSync(join(composeOther, 'docker-compose.yml'), 'services: {}')
      writeFileSync(join(manifestOther, 'package.json'), '{}')

      const compose = await resolveTargetWorkdir('docker compose up -d', here, [join(root, 'mr-compose')])
      assert(
        compose.kind === 'auto' && compose.workdir === composeOther,
        `expected compose to resolve across roots, got: ${compose.kind}`,
      )

      const manifest = await resolveTargetWorkdir('npm run build', here, [join(root, 'mr-manifest')])
      assert(
        manifest.kind === 'auto' && manifest.workdir === manifestOther,
        `expected manifest to resolve across roots, got: ${manifest.kind}`,
      )
    })

    await test('does not resolve across roots when the target is in none of them', async () => {
      const here = join(root, 'mr-none')
      mkdirSync(here, { recursive: true })
      const resolution = await resolveTargetWorkdir('node nope.js', here, [join(root, 'mr-other')])
      assert(resolution.kind === 'none', `expected none, got: ${resolution.kind}`)
    })

    await test('blocks when a target is ambiguous ACROSS roots', async () => {
      const here = join(root, 'mr-amb-cwd')
      const rootA = join(root, 'mr-amb-a')
      const rootB = join(root, 'mr-amb-b')
      mkdirSync(here, { recursive: true })
      mkdirSync(rootA, { recursive: true })
      mkdirSync(rootB, { recursive: true })
      writeFileSync(join(rootA, 'main.js'), '// fixture')
      writeFileSync(join(rootB, 'main.js'), '// fixture')

      const resolution = await resolveTargetWorkdir('node main.js', here, [rootA, rootB])
      assert(resolution.kind === 'ambiguous', `expected ambiguous across roots, got: ${resolution.kind}`)
    })

    await test('auto-resolves under the run dir even when extra roots are provided', async () => {
      const here = join(root, 'mr-tie')
      const sub = join(here, 'svc')
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(sub, 'index.js'), '// fixture')

      const resolution = await resolveTargetWorkdir('node index.js', here, [join(root, 'mr-other')])
      assert(
        resolution.kind === 'auto' && resolution.workdir === sub,
        `expected cwd-subdir resolution, got: ${resolution.kind === 'auto' ? resolution.workdir : resolution.kind}`,
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
