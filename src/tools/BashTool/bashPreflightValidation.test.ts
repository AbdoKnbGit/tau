/**
 * Bash preflight validation unit tests.
 *
 * Run: bun run src/tools/BashTool/bashPreflightValidation.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { anchorCommandToDir, extractPythonModuleTarget, findEnclosingProjectRoot, normalizeForFs, resolveAmbiguousPick, resolveComposeWorkdir, resolveTargetWorkdir, validateBashExecutionPreflight, wrapWithDirPrefix } from './bashPreflightValidation.js'

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

function assert(cond: unknown, hint: string): asserts cond {
  if (!cond) throw new Error(hint)
}

async function main(): Promise<void> {
  console.log('bash preflight validation:')

  const root = mkdtempSync(join(tmpdir(), 'tau-bash-preflight-'))

  try {
    await test('does not expose a preflight block for a missing leading cd', async () => {
      const result = await validateBashExecutionPreflight(
        { command: 'cd frontend && npm run build' },
        root,
      )

      assert(result.ok, 'missing cd target must be handled by normalization/execution')
    })

    await test('allows leading cd when the directory exists', async () => {
      mkdirSync(join(root, 'frontend'))

      const result = await validateBashExecutionPreflight(
        { command: 'cd frontend && npm run build' },
        root,
      )

      assert(result.ok, 'expected existing cd target to pass')
    })

    await test('does not block a missing cd target under a provided workdir', async () => {
      const packages = join(root, 'packages')
      mkdirSync(packages)

      const result = await validateBashExecutionPreflight(
        { command: 'cd app && npm test', workdir: 'packages' },
        root,
      )

      assert(result.ok, 'missing nested cd target must not produce a preflight block')
    })

    await test('does not expose a preflight block for a missing workdir', async () => {
      const result = await validateBashExecutionPreflight(
        { command: 'npm run build', workdir: 'missing' },
        root,
      )

      assert(result.ok, 'missing workdir must be handled by target discovery/execution')
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

    await test('searches for a misplaced script where the ignore files allow, not by folder name', async () => {
      const proj = join(root, 'ignore-aware')
      for (const dir of ['generated', 'scripts', 'build']) mkdirSync(join(proj, dir), { recursive: true })
      writeFileSync(join(proj, '.gitignore'), 'generated/\n')
      writeFileSync(join(proj, 'generated', 'job.py'), '# generated copy')
      writeFileSync(join(proj, 'scripts', 'job.py'), '# fixture')
      const job = await resolveTargetWorkdir('python job.py', proj)
      assert(
        job.kind === 'auto' && job.workdir === join(proj, 'scripts'),
        `expected only scripts/ (generated/ is ignored), got: ${job.kind === 'auto' ? job.workdir : job.kind}`,
      )
      // Not ignored here, so `build` is project content like any other folder.
      writeFileSync(join(proj, 'build', 'make.py'), '# fixture')
      const make = await resolveTargetWorkdir('python make.py', proj)
      assert(
        make.kind === 'auto' && make.workdir === join(proj, 'build'),
        `expected build/, got: ${make.kind === 'auto' ? make.workdir : make.kind}`,
      )
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

    // ── python -m module auto-workdir ──────────────────────────────
    await test('auto-resolves `python -m pkg.mod` to the import root', async () => {
      const proj = join(root, 'm-proj')
      const pkg = join(proj, 'sub', 'ml')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, '__init__.py'), '')
      writeFileSync(join(pkg, 'train_wear.py'), '# fixture')

      // Run from the project root where `ml` is NOT importable; the package
      // lives under sub/. Auto-workdir should point at sub/ (the import root).
      const resolution = await resolveTargetWorkdir('python -m ml.train_wear', proj)
      assert(resolution.kind === 'auto', `expected auto, got: ${resolution.kind}`)
      assert(
        resolution.kind === 'auto' && resolution.workdir === join(proj, 'sub'),
        `workdir should be the import root (sub/), got: ${resolution.kind === 'auto' ? resolution.workdir : '-'}`,
      )

      // Single candidate → auto-applied at call() time, so preflight allows.
      const preflight = await validateBashExecutionPreflight({ command: 'python -m ml.train_wear' }, proj)
      assert(preflight.ok, `single-candidate module must not block, got: ${preflight.ok ? 'ok' : preflight.message}`)
    })

    await test('no redirect when the module already resolves from the run dir', async () => {
      const resolution = await resolveTargetWorkdir('python -m ml.train_wear', join(root, 'm-proj', 'sub'))
      assert(resolution.kind === 'none', `expected none, got: ${resolution.kind}`)
    })

    await test('resolves the `__main__.py` package form of `python -m`', async () => {
      const proj = join(root, 'm-main')
      const pkg = join(proj, 'pkgs', 'tool')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, '__main__.py'), '# fixture')

      const resolution = await resolveTargetWorkdir('python3 -m tool', proj)
      assert(
        resolution.kind === 'auto' && resolution.workdir === join(proj, 'pkgs'),
        `expected pkgs/ as import root, got: ${resolution.kind === 'auto' ? resolution.workdir : resolution.kind}`,
      )
    })

    await test('auto-picks the shallowest of an AMBIGUOUS `python -m` module (no block)', async () => {
      const proj = join(root, 'm-ambig')
      for (const where of ['x', 'y']) {
        const pkg = join(proj, where, 'app')
        mkdirSync(pkg, { recursive: true })
        writeFileSync(join(pkg, 'run.py'), '# fixture')
      }
      const resolution = await resolveTargetWorkdir('python -m app.run', proj)
      assert(resolution.kind === 'ambiguous', `expected ambiguous, got: ${resolution.kind}`)
      assert(resolution.dirs.length === 2, 'ambiguous must carry both candidate dirs')

      const pick = resolveAmbiguousPick(resolution.dirs, proj)
      assert(pick.workdir === join(proj, 'x'), `expected shallowest pick x, got: ${pick.workdir}`)
      assert(pick.alternatives.length === 1, 'expected one alternative dir')

      const result = await validateBashExecutionPreflight({ command: 'python -m app.run' }, proj)
      assert(result.ok, 'ambiguous module must NOT block — it auto-picks')
    })

    await test('ignores `python script.py` and dynamic `-m` targets', async () => {
      // A positional before -m is a script invocation, handled by the script path.
      assert(extractPythonModuleTarget('python app.py') === null, 'script form is not a -m target')
      // Dynamic module name → no static resolution.
      assert(extractPythonModuleTarget('python -m "$MODULE"') === null, 'dynamic -m must not resolve')
      // Non-python runner → not a module target.
      assert(extractPythonModuleTarget('node -m foo') === null, 'only python runners qualify')
      // Well-formed target parses.
      const t = extractPythonModuleTarget('python -m ml.train_wear')
      assert(t?.module === 'ml.train_wear', 'expected parsed module name')
      assert(
        !!t && t.candidateRelPaths.includes('ml/train_wear.py'),
        'expected the .py file shape among candidates',
      )
    })

    // ── generic project-tool (marker-file) auto-workdir ────────────
    await test('auto-resolves `dvc repro` to the directory holding dvc.yaml', async () => {
      const proj = join(root, 'pt-dvc')
      const real = join(proj, 'experiments', 'pipeline')
      mkdirSync(real, { recursive: true })
      writeFileSync(join(real, 'dvc.yaml'), 'stages: {}')

      const resolution = await resolveTargetWorkdir('dvc repro', proj)
      assert(
        resolution.kind === 'auto' && resolution.workdir === real,
        `expected the dvc.yaml dir, got: ${resolution.kind === 'auto' ? resolution.workdir : resolution.kind}`,
      )
      const preflight = await validateBashExecutionPreflight({ command: 'dvc repro' }, proj)
      assert(preflight.ok, `single dvc.yaml must not block, got: ${preflight.ok ? 'ok' : preflight.message}`)
    })

    await test('generalizes to any marker tool (cargo → Cargo.toml)', async () => {
      const proj = join(root, 'pt-cargo')
      const crate = join(proj, 'crates', 'app')
      mkdirSync(crate, { recursive: true })
      writeFileSync(join(crate, 'Cargo.toml'), '[package]')

      const resolution = await resolveTargetWorkdir('cargo build --release', proj)
      assert(
        resolution.kind === 'auto' && resolution.workdir === crate,
        `expected the Cargo.toml dir, got: ${resolution.kind === 'auto' ? resolution.workdir : resolution.kind}`,
      )
    })

    await test('marker reachable UP the tree needs no redirect', async () => {
      // go.mod at the project root; running `go test` from a subpackage must
      // NOT redirect — go walks up and finds it.
      const proj = join(root, 'pt-go')
      const sub = join(proj, 'internal', 'svc')
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(proj, 'go.mod'), 'module x')
      const resolution = await resolveTargetWorkdir('go test ./...', sub)
      assert(resolution.kind === 'none', `ancestor marker must not redirect, got: ${resolution.kind}`)
    })

    await test('scaffold subcommands (cargo new) are never redirected', async () => {
      const proj = join(root, 'pt-cargo') // has crates/app/Cargo.toml from above
      const resolution = await resolveTargetWorkdir('cargo new my-crate', proj)
      assert(resolution.kind === 'none', `cargo new must not redirect into a sibling crate, got: ${resolution.kind}`)
    })

    await test('auto-picks the shallowest of an AMBIGUOUS marker (two Makefiles)', async () => {
      const proj = join(root, 'pt-make')
      for (const where of ['a', 'b']) {
        mkdirSync(join(proj, where), { recursive: true })
        writeFileSync(join(proj, where, 'Makefile'), 'all:')
      }
      const resolution = await resolveTargetWorkdir('make build', proj)
      assert(resolution.kind === 'ambiguous', `expected ambiguous, got: ${resolution.kind}`)
      const pick = resolveAmbiguousPick(resolution.dirs, proj)
      assert(pick.workdir === join(proj, 'a'), `expected shallowest pick a, got: ${pick.workdir}`)
    })

    await test('expands a known root UP to its project root (the file-edit → dvc fix)', async () => {
      // Mirrors the real failure: model edits <repo>/ml/train.py (so <repo>/ml
      // becomes a known search root via recordVisitedDir), then runs `dvc repro`
      // from an UNRELATED cwd. dvc.yaml sits at <repo> — one level ABOVE the
      // known root — which a downward-only search would miss. The project-root
      // expansion (<repo>/ml → <repo> via .git) bridges the gap.
      const repo = join(root, 'expand-repo')
      mkdirSync(join(repo, '.git'), { recursive: true }) // generic project marker
      const pkg = join(repo, 'ml')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(repo, 'dvc.yaml'), 'stages: {}') // dvc target at repo root
      writeFileSync(join(pkg, 'train.py'), '# fixture')

      const elsewhere = join(root, 'expand-elsewhere')
      mkdirSync(elsewhere, { recursive: true })

      // No workdir; cwd is unrelated; only <repo>/ml is a known search root.
      const resolution = await resolveTargetWorkdir('dvc repro', elsewhere, [pkg])
      assert(
        resolution.kind === 'auto' && resolution.workdir === repo,
        `expected auto-resolve to the repo root via project-root expansion, got: ${resolution.kind === 'auto' ? resolution.workdir : resolution.kind}`,
      )
    })

    await test('project-root expansion stops at $HOME (orphan dir → null)', async () => {
      // A dir with no markers anywhere up to home must not resolve a project
      // root — guarantees we never scan home/system trees. (tmp is under home
      // on Windows and under / elsewhere; both yield null.)
      const orphan = join(root, 'no-markers-here', 'deep')
      mkdirSync(orphan, { recursive: true })
      const result = await findEnclosingProjectRoot(orphan)
      assert(result === null, `orphan dir must not resolve a project root, got: ${result}`)
    })

    await test('does not auto-resolve a sub-path script that exists nowhere nearby', async () => {
      // `node lib/missing.js`: a sub-path target IS resolvable (see the sub-path
      // tests below), but only when found — here it exists nowhere, so leave it
      // for the shell to report rather than guess.
      const resolution = await resolveTargetWorkdir('node lib/missing.js', root)
      assert(resolution.kind === 'none', `missing sub-path target must not auto-resolve, got: ${resolution.kind}`)
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

    await test('auto-picks the shallowest of an AMBIGUOUS script (no block)', async () => {
      const ambig = join(root, 'amb-script')
      mkdirSync(join(ambig, 'a'), { recursive: true })
      mkdirSync(join(ambig, 'b'), { recursive: true })
      writeFileSync(join(ambig, 'a', 'app.js'), '// fixture')
      writeFileSync(join(ambig, 'b', 'app.js'), '// fixture')

      const resolution = await resolveTargetWorkdir('node app.js', ambig)
      assert(resolution.kind === 'ambiguous', `expected ambiguous, got: ${resolution.kind}`)
      const pick = resolveAmbiguousPick(resolution.dirs, ambig)
      assert(pick.workdir === join(ambig, 'a'), `expected shallowest pick a, got: ${pick.workdir}`)
      assert(pick.alternatives.length === 1, 'expected one alternative dir')

      const result = await validateBashExecutionPreflight({ command: 'node app.js' }, ambig)
      assert(result.ok, 'ambiguous script must NOT block — it auto-picks')
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

    await test('does not block inline code split by nested shell quoting', async () => {
      const result = await validateBashExecutionPreflight(
        { command: 'node -e "console.log("hello world")"' },
        root,
      )
      assert(result.ok, 'inline code is normalized at execution time, not blocked')
    })

    await test('allows inline code that the execution rewrite can repair safely', async () => {
      const result = await validateBashExecutionPreflight(
        { command: 'runtime --eval "fn({_id:"value"})"' },
        root,
      )
      assert(result.ok, 'single-word nested quoting is repaired before execution')
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

    await test('auto-picks the shallowest of an AMBIGUOUS npm command (no block)', async () => {
      const ambig = join(root, 'amb-manifest')
      mkdirSync(join(ambig, 'pkg-a'), { recursive: true })
      mkdirSync(join(ambig, 'pkg-b'), { recursive: true })
      writeFileSync(join(ambig, 'pkg-a', 'package.json'), '{}')
      writeFileSync(join(ambig, 'pkg-b', 'package.json'), '{}')

      const resolution = await resolveTargetWorkdir('npm run build', ambig)
      assert(resolution.kind === 'ambiguous', `expected ambiguous, got: ${resolution.kind}`)
      const pick = resolveAmbiguousPick(resolution.dirs, ambig)
      assert(pick.workdir === join(ambig, 'pkg-a'), `expected shallowest pick pkg-a, got: ${pick.workdir}`)

      const result = await validateBashExecutionPreflight({ command: 'npm run build' }, ambig)
      assert(result.ok, 'ambiguous manifest must NOT block — it auto-picks')
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
        'expected absolute Compose file directory',
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

    await test('auto-picks the shallowest AMBIGUOUS compose (no block) and notes the rest', async () => {
      const ambig = join(root, 'ambig')
      mkdirSync(join(ambig, 'a'), { recursive: true })
      mkdirSync(join(ambig, 'b'), { recursive: true })
      writeFileSync(join(ambig, 'a', 'docker-compose.yml'), 'services: {}')
      writeFileSync(join(ambig, 'b', 'compose.yaml'), 'services: {}')

      const resolution = await resolveComposeWorkdir('docker compose up -d', ambig)
      assert(resolution.kind === 'ambiguous', `expected ambiguous, got: ${resolution.kind}`)
      const pick = resolveAmbiguousPick(resolution.dirs, ambig)
      assert(pick.workdir === join(ambig, 'a'), `expected shallowest pick a, got: ${pick.workdir}`)
      assert(
        pick.alternatives.length === 1 && pick.alternatives[0] === 'b',
        `expected 'b' as the noted alternative, got: ${pick.alternatives.join(', ')}`,
      )

      const result = await validateBashExecutionPreflight(
        { command: 'docker compose up -d' },
        ambig,
      )
      assert(result.ok, 'ambiguous compose must NOT block — it auto-picks')
    })

    await test('two Compose files in the SAME dir collapse to one workdir (not ambiguous)', async () => {
      // The reported worry: two compose files at the same location. They name one
      // DIRECTORY, so there is nothing to disambiguate — just run there (docker
      // then applies its own file precedence).
      const proj = join(root, 'same-dir-compose')
      const svc = join(proj, 'svc')
      mkdirSync(svc, { recursive: true })
      writeFileSync(join(svc, 'compose.yaml'), 'services: {}')
      writeFileSync(join(svc, 'docker-compose.yml'), 'services: {}')

      const resolution = await resolveComposeWorkdir('docker compose up -d', proj)
      assert(
        resolution.kind === 'auto' && resolution.workdir === svc,
        `two files in one dir must resolve to that dir, got: ${resolution.kind === 'auto' ? resolution.workdir : resolution.kind}`,
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
      assert(resolution.workdir === otherApp, `expected workdir in the other root, got: ${resolution.workdir}`)
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

    await test('auto-picks deterministically when a target is ambiguous ACROSS roots', async () => {
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
      const pick = resolveAmbiguousPick(resolution.dirs, here)
      assert(pick.workdir === rootA, `expected alphabetically-first root, got: ${pick.workdir}`)
      assert(pick.alternatives.length === 1, 'expected one alternative root')
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

    // --- Resolution cache ("resolve once, reuse") -----------------------------

    await test('caches an auto-resolution: a repeat with NO roots is still served', async () => {
      const here = join(root, 'cache-cwd')
      const projDir = join(root, 'cache-proj')
      mkdirSync(here, { recursive: true })
      mkdirSync(projDir, { recursive: true })
      writeFileSync(join(projDir, 'cached_api.py'), '# fixture')

      // First resolve WITH the root → auto, populates the cache.
      const first = await resolveTargetWorkdir('python cached_api.py', here, [projDir])
      assert(
        first.kind === 'auto' && first.workdir === projDir,
        `first must auto-resolve, got: ${first.kind}`,
      )

      // Second resolve with NO roots → only the cache can answer it.
      const second = await resolveTargetWorkdir('python cached_api.py', here, [])
      assert(
        second.kind === 'auto' && second.workdir === projDir,
        `repeat must be served from cache, got: ${second.kind === 'auto' ? second.workdir : second.kind}`,
      )
    })

    await test('evicts a stale cache entry when the resolved file is gone', async () => {
      const here = join(root, 'cache-stale-cwd')
      const projDir = join(root, 'cache-stale-proj')
      mkdirSync(here, { recursive: true })
      mkdirSync(projDir, { recursive: true })
      const file = join(projDir, 'stale_api.py')
      writeFileSync(file, '# fixture')

      const first = await resolveTargetWorkdir('python stale_api.py', here, [projDir])
      assert(first.kind === 'auto', `first must auto-resolve, got: ${first.kind}`)

      // The file is gone; a repeat with no roots must NOT return the dead dir.
      rmSync(file, { force: true })
      const second = await resolveTargetWorkdir('python stale_api.py', here, [])
      assert(
        second.kind === 'none',
        `stale entry must be evicted, got: ${second.kind === 'auto' ? second.workdir : second.kind}`,
      )
    })

    await test('cache hit defers to the run dir once the target appears there', async () => {
      const here = join(root, 'cache-local-cwd')
      const projDir = join(root, 'cache-local-proj')
      mkdirSync(here, { recursive: true })
      mkdirSync(projDir, { recursive: true })
      writeFileSync(join(projDir, 'local_api.py'), '# remote')

      const first = await resolveTargetWorkdir('python local_api.py', here, [projDir])
      assert(
        first.kind === 'auto' && first.workdir === projDir,
        `first must auto-resolve, got: ${first.kind}`,
      )

      // A local copy appears in the run dir → running in place is correct (none);
      // the cached redirect must NOT win.
      writeFileSync(join(here, 'local_api.py'), '# local')
      const second = await resolveTargetWorkdir('python local_api.py', here, [])
      assert(
        second.kind === 'none',
        `local copy must defeat the cached redirect, got: ${second.kind === 'auto' ? second.workdir : second.kind}`,
      )
    })

    // --- Sub-path targets (python scripts/run.py from the wrong dir) -----------

    await test('auto-resolves a sub-path target to the dir containing the sub-path', async () => {
      const here = join(root, 'subpath-cwd')
      const projDir = join(root, 'subpath-proj')
      const scriptsDir = join(projDir, 'scripts')
      mkdirSync(here, { recursive: true })
      mkdirSync(scriptsDir, { recursive: true })
      writeFileSync(join(scriptsDir, 'run.py'), '# fixture')

      const resolution = await resolveTargetWorkdir('python scripts/run.py', here, [projDir])
      assert(
        resolution.kind === 'auto' && resolution.workdir === projDir,
        `expected the dir containing scripts/, got: ${resolution.kind === 'auto' ? resolution.workdir : resolution.kind}`,
      )
    })

    await test('does not resolve a sub-path target that escapes with ..', async () => {
      const here = join(root, 'subpath-bail-cwd')
      const projDir = join(root, 'subpath-bail-proj')
      const toolsDir = join(projDir, 'tools')
      mkdirSync(here, { recursive: true })
      mkdirSync(toolsDir, { recursive: true })
      writeFileSync(join(toolsDir, 'esc.py'), '# fixture')

      const up = await resolveTargetWorkdir('python ../tools/esc.py', here, [projDir])
      assert(up.kind === 'none', `.. escape must not auto-resolve, got: ${up.kind}`)
    })

    await test('resolveAmbiguousPick prefers the shallowest candidate (the TP1/TP2 case)', async () => {
      // Mirrors the reported docker-compose loop: TP1/ (depth 1) vs
      // TP2/hadoop-cluster/ (depth 2). The shallowest wins regardless of input
      // order; the rest are noted so the model/user can switch with workdir.
      const base = join(root, 'depth-base')
      const tp1 = join(base, 'TP1')
      const tp2 = join(base, 'TP2', 'hadoop-cluster')
      const pick = resolveAmbiguousPick([tp2, tp1], base)
      assert(pick.workdir === tp1, `expected the shallower TP1, got: ${pick.workdir}`)
      assert(
        pick.alternatives.length === 1 && pick.alternatives[0] === join('TP2', 'hadoop-cluster'),
        `expected TP2/hadoop-cluster noted, got: ${pick.alternatives.join(', ')}`,
      )
    })

    // --- Anchoring a command to an absolute location (the mechanism fix) ------

    await test('anchorCommandToDir rewrites a script arg to a POSIX absolute path (Git Bash)', async () => {
      const out = anchorCommandToDir('node server.js', 'C:\\Workspace\\proj', 'bash', 'windows')
      assert(
        out === `node '/c/Workspace/proj/server.js'`,
        `expected POSIX absolute file arg, got: ${out}`,
      )
    })

    await test('anchorCommandToDir rewrites a script arg to a native absolute path (PowerShell)', async () => {
      const out = anchorCommandToDir('python app.py', 'C:\\Workspace\\proj', 'powershell', 'windows')
      assert(
        out === `python 'C:\\Workspace\\proj\\app.py'`,
        `expected native absolute file arg, got: ${out}`,
      )
    })

    await test('anchorCommandToDir quotes a path containing spaces', async () => {
      const out = anchorCommandToDir('node server.js', '/workspace/my proj', 'bash', 'linux')
      assert(
        out === `node '/workspace/my proj/server.js'`,
        `expected quoted space path, got: ${out}`,
      )
    })

    await test('anchorCommandToDir rewrites only the first matching token', async () => {
      const out = anchorCommandToDir('node server.js server.js', '/workspace/srv', 'bash', 'linux')
      assert(
        out === `node '/workspace/srv/server.js' server.js`,
        `expected only the first token rewritten, got: ${out}`,
      )
    })

    await test('anchorCommandToDir wraps a no-file-arg command in a one-off subshell (bash)', async () => {
      const out = anchorCommandToDir('docker compose up', 'C:\\Workspace\\TP1', 'bash', 'windows')
      assert(
        out === `(cd '/c/Workspace/TP1' && docker compose up)`,
        `expected subshell cd, got: ${out}`,
      )
    })

    await test('anchorCommandToDir rewrites docker compose to an explicit compose file', async () => {
      const dir = join(root, 'anchor-compose')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'compose.yaml'), 'services: {}')
      const out = anchorCommandToDir('docker compose up -d', dir, 'bash')
      assert(out.includes('docker compose -f '), `expected compose -f rewrite, got: ${out}`)
      assert(out.includes('compose.yaml'), `expected compose file path, got: ${out}`)
      assert(!out.startsWith('(cd '), `must not hide compose behind cd wrapper, got: ${out}`)
    })

    await test('anchorCommandToDir rewrites npm package commands with --prefix', async () => {
      const out = anchorCommandToDir('npm run build', '/workspace/app', 'bash', 'linux')
      assert(
        out === `npm --prefix '/workspace/app' run build`,
        `expected npm --prefix rewrite, got: ${out}`,
      )
    })

    await test('anchorCommandToDir rewrites terraform commands with -chdir', async () => {
      const out = anchorCommandToDir('terraform plan', '/workspace/infra', 'bash', 'linux')
      assert(
        out === `terraform -chdir='/workspace/infra' plan`,
        `expected terraform -chdir rewrite, got: ${out}`,
      )
    })

    await test('anchorCommandToDir wraps a no-file-arg command with Push/Pop-Location (PowerShell)', async () => {
      const out = anchorCommandToDir('docker compose up', 'C:\\Workspace\\TP1', 'powershell', 'windows')
      assert(
        out === `Push-Location -LiteralPath 'C:\\Workspace\\TP1'; docker compose up; Pop-Location`,
        `expected Push/Pop-Location wrap, got: ${out}`,
      )
    })

    await test('wrapWithDirPrefix never drifts the session cwd (subshell / Push-Pop)', async () => {
      const bash = wrapWithDirPrefix('npm run build', '/workspace/app', 'bash', 'linux')
      assert(bash === `(cd '/workspace/app' && npm run build)`, `bash wrap wrong: ${bash}`)
      const ps = wrapWithDirPrefix('npm run build', 'C:\\Workspace\\app', 'powershell', 'windows')
      assert(
        ps === `Push-Location -LiteralPath 'C:\\Workspace\\app'; npm run build; Pop-Location`,
        `powershell wrap wrong: ${ps}`,
      )
    })

    // --- Cache: remember specific-file targets, never sticky compose ----------

    await test('compose is NOT cached: a second candidate makes it ambiguous (no TP2 stickiness)', async () => {
      const work = join(root, 'cache-compose', 'work')
      const lib = join(root, 'cache-compose', 'lib')
      const lib2 = join(root, 'cache-compose', 'lib2')
      mkdirSync(work, { recursive: true })
      mkdirSync(lib, { recursive: true })
      mkdirSync(lib2, { recursive: true })
      writeFileSync(join(lib, 'compose.yaml'), 'services: {}')

      const first = await resolveTargetWorkdir('docker compose up', work, [lib])
      assert(first.kind === 'auto', `first compose should auto-resolve, got: ${first.kind}`)

      // A second compose appears in another known dir. Because compose is never
      // cached, the next resolve re-searches and now sees TWO → ambiguous.
      writeFileSync(join(lib2, 'compose.yaml'), 'services: {}')
      const second = await resolveTargetWorkdir('docker compose up', work, [lib, lib2])
      assert(
        second.kind === 'ambiguous',
        `second compose must re-search and surface (not return a cached TP2), got: ${second.kind}`,
      )
    })

    await test('a script target IS remembered (cached) for the session', async () => {
      const work = join(root, 'cache-script', 'work')
      const lib = join(root, 'cache-script', 'lib')
      mkdirSync(work, { recursive: true })
      mkdirSync(lib, { recursive: true })
      writeFileSync(join(lib, 'runner.js'), '// fixture')

      const first = await resolveTargetWorkdir('node runner.js', work, [lib])
      assert(first.kind === 'auto', `first script should auto-resolve, got: ${first.kind}`)
      const firstDir = first.kind === 'auto' ? first.workdir : ''

      // A second runner.js appears later, but the specific target is already
      // remembered, so the cached directory is returned (still valid).
      const lib2 = join(root, 'cache-script', 'lib2')
      mkdirSync(lib2, { recursive: true })
      writeFileSync(join(lib2, 'runner.js'), '// fixture')
      const second = await resolveTargetWorkdir('node runner.js', work, [lib, lib2])
      assert(
        second.kind === 'auto' && second.workdir === firstDir,
        `cached script dir should be reused, got: ${second.kind}/${second.kind === 'auto' ? second.workdir : ''}`,
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
