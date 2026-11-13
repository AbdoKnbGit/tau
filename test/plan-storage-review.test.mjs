import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  join,
  relative,
  isAbsolute,
  resolve,
} from 'node:path'
import { after, test } from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  entryPoints: ['src/utils/planFileStorage.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent',
})
function storage(overrides = {}) {
  const module = { exports: {} }
  Function(
    'require',
    'module',
    'exports',
    compiled.outputFiles[0].text,
  )(
    (name) => (name === 'fs' ? { ...fs, ...overrides } : require(name)),
    module,
    module.exports,
  )
  return module.exports
}
const stubs = {
  'lodash-es/memoize.js':
    'export default fn=>{let value;const result=()=>value??=fn();result.cache={clear(){value=undefined}};return result};',
  '../bootstrap/state.js':
    'export const getPlanSlugCache=()=>fixture.cache,getSessionId=()=>"session";',
  '../tools/ExitPlanModeTool/constants.js':
    'export const EXIT_PLAN_MODE_V2_TOOL_NAME="ExitPlanMode";',
  './cwd.js': 'export const getCwd=()=>fixture.directory;',
  './debug.js': 'export const logForDebugging=()=>{};',
  './envUtils.js': 'export const getClaudeConfigHomeDir=()=>fixture.directory;',
  './errors.js': 'export const isENOENT=error=>error?.code==="ENOENT";',
  './filePersistence/outputsScanner.js':
    'export const getEnvironmentKind=()=>null;',
  './fsOperations.js': 'export const getFsImplementation=()=>fixture.fs;',
  './log.js': 'export const logError=error=>fixture.errors.push(error);',
  './settings/settings.js':
    'export const getInitialSettings=()=>({plansDirectory:"."});',
  './words.js': 'export const generateWordSlug=()=>"example-generated-plan";',
  './fileHistory.js':
    'export const rebasePlanFileHistorySnapshots=value=>value;',
  './sessionStorage.js':
    'export const savePlanFileReference=async()=>{},getCurrentSessionTitle=()=>undefined,getTranscriptPath=()=>"unused",getTranscriptPathForSession=()=>"unused";',
}
const plansCompiled = await build({
  entryPoints: ['src/utils/plans.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent',
  plugins: [
    {
      name: 'plan-inspection-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          stubs[args.path]
            ? { path: args.path, namespace: 'fixture' }
            : undefined,
        )
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
        }))
      },
    },
  ],
})

const r = storage()
const root = fs.mkdtempSync(join(tmpdir(), 'tau-plan-storage-review-'))
after(() => {
  const child = relative(tmpdir(), root)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})
let sequence = 0
function directory() {
  const path = join(root, `case ${sequence++}`)
  fs.mkdirSync(path)
  return path
}

test('legacy resume cannot adopt another plan whose title occupies the old slug', async () => {
  const dir = directory()
  fs.writeFileSync(join(dir, 'new-plan.md'), 'Unrelated current plan bytes')
  const foreign = await r.renameStoredPlanFile({
    directory: dir,
    planId: 'new-plan',
    title: 'legacy-session-plan',
    shouldProceed: () => true,
    persistReference: async () => {},
  })
  assert.equal(basename(foreign.newPath), 'legacy-session-plan.md')
  assert.throws(
    () => r.readPlanFileRecord(dir, 'legacy-session-plan'),
    /another plan/,
  )
  const recovered = await r.restorePlanFileReference(
    dir,
    {
      version: 1,
      planId: 'legacy-session-plan',
      filename: 'legacy-session-plan.md',
      revision: 0,
    },
    'Original legacy session snapshot bytes',
  )
  assert.notEqual(recovered.filename, 'legacy-session-plan.md')
  assert.equal(
    fs.readFileSync(join(dir, recovered.filename), 'utf8'),
    'Original legacy session snapshot bytes',
  )
  assert.equal(
    fs.readFileSync(foreign.newPath, 'utf8'),
    'Unrelated current plan bytes',
  )
})

test('resuming an unwritten legacy plan reserves its slug before another title can claim it', async () => {
  const dir = directory()
  await r.restorePlanFileReference(dir, {
    version: 1,
    planId: 'waiting-legacy-plan',
    filename: 'waiting-legacy-plan.md',
    revision: 0,
  })
  fs.writeFileSync(join(dir, 'second-plan.md'), 'Second plan')
  const renamed = await r.renameStoredPlanFile({
    directory: dir,
    planId: 'second-plan',
    title: 'waiting-legacy-plan',
    now: new Date('2026-11-12T01:02:03Z'),
    shouldProceed: () => true,
    persistReference: async () => {},
  })
  assert.equal(
    basename(renamed.newPath),
    'waiting-legacy-plan-20261112T010203Z.md',
  )
})

test('portable metadata cannot enter an agent namespace through filename casing', () => {
  for (const filename of [
    'other-agent-worker.md',
    'other-AGENT-worker.md',
    'other-Agent-worker.md',
  ]) {
    assert.equal(
      r.parsePlanFileReference({
        version: 1,
        planId: 'imported-plan',
        filename,
        revision: 1,
      }),
      undefined,
    )
  }
})

test('portable metadata rejects Windows device aliases including superscript digits', () => {
  for (const name of ['CON', 'aux', 'LPT1', 'COM¹', 'lpt²', 'COM³']) {
    assert.equal(
      r.parsePlanFileReference({
        version: 1,
        planId: 'imported-plan',
        filename: `${name}.md`,
        revision: 1,
      }),
      undefined,
    )
    const slug = r.planTitleToFilenameSlug(name)
    assert.ok(
      r.parsePlanFileReference({
        version: 1,
        planId: 'imported-plan',
        filename: `${slug}.md`,
        revision: 1,
      }),
    )
  }
})

test('file alias inspection follows dangling relative chains without needing host symlink privileges', async () => {
  const dir = directory(),
    planId = 'alias-source'
  const source = join(dir, `${planId}.md`)
  fs.writeFileSync(source, '# Saved alias plan\n')
  const moved = await r.renameStoredPlanFile({
    directory: dir,
    planId,
    title: 'alias-approved-title',
    shouldProceed: () => true,
    persistReference: async () => {},
  })
  const aliasDirectory = join(dir, 'aliases')
  fs.mkdirSync(aliasDirectory)
  const first = join(aliasDirectory, 'first.md'),
    second = join(aliasDirectory, 'second.md')
  const links = new Map([
    [first, './second.md'],
    [second, relative(dirname(second), source)],
  ])
  let networkProbes = 0
  const fixtureFs = {
    ...fs,
    lstatSync(path, ...args) {
      if (String(path).startsWith('\\\\') || String(path).startsWith('//')) {
        networkProbes++
        throw new Error('unexpected network probe')
      }
      if (links.has(resolve(path)))
        return { isSymbolicLink: () => true, isFile: () => false }
      return fs.lstatSync(path, ...args)
    },
    readlinkSync(path) {
      return links.get(resolve(path)) ?? fs.readlinkSync(path)
    },
  }
  const fixture = {
    directory: dir,
    cache: new Map([['session', planId]]),
    fs: fixtureFs,
    errors: [],
  }
  const module = { exports: {} }
  Function(
    'require',
    'module',
    'exports',
    'fixture',
    plansCompiled.outputFiles[0].text,
  )(require, module, module.exports, fixture)
  const plans = module.exports
  assert.equal(plans.getRetiredPlanPathReplacement(first), moved.newPath)
  let writes = 0
  await assert.rejects(
    plans.withPlanFileMutation(first, async () => {
      writes++
    }),
    /moved/,
  )
  assert.equal(writes, 0)
  assert.equal(fs.existsSync(source), false)
  assert.equal(fs.readFileSync(moved.newPath, 'utf8'), '# Saved alias plan\n')
  links.set(second, '\\\\unavailable-host\\share\\plan.md')
  assert.equal(plans.getRetiredPlanPathReplacement(first), undefined)
  assert.equal(networkProbes, 0)
})

test('collision recovery respects the byte budget for every accepted Unicode reference', async () => {
  const dir = directory()
  const filename = '计'.repeat(61) + '.md'
  const reference = {
    version: 1,
    planId: 'unicode-import',
    filename,
    revision: 3,
  }
  assert.ok(
    r.parsePlanFileReference(reference),
    'the incoming reference is valid',
  )
  fs.writeFileSync(join(dir, filename), 'Unrelated Unicode-named plan')
  const restored = await r.restorePlanFileReference(
    dir,
    reference,
    'Recovered Unicode plan',
  )
  assert.notEqual(restored.filename, filename)
  assert.ok(Buffer.byteLength(restored.filename) <= 200)
  assert.equal(
    fs.readFileSync(join(dir, restored.filename), 'utf8'),
    'Recovered Unicode plan',
  )
  assert.equal(
    fs.readFileSync(join(dir, filename), 'utf8'),
    'Unrelated Unicode-named plan',
  )
})

test('ownership inspection of an unrelated sibling never requires metadata writes', () => {
  const dir = directory()
  let attemptedWrites = 0
  const readOnly = storage({
    mkdirSync() {
      attemptedWrites++
      throw Object.assign(new Error('read only'), { code: 'EACCES' })
    },
  })
  assert.equal(
    readOnly.isPlanFilePathCandidate(
      dir,
      'original-plan',
      join(dir, 'unrelated.md'),
    ),
    false,
  )
  assert.equal(attemptedWrites, 0)
})

test('read-only metadata storage does not crash lazy plan path inspection', () => {
  const dir = directory()
  const deniedFs = {
    ...fs,
    mkdirSync(path, options) {
      if (String(path).includes('.plan-metadata'))
        throw Object.assign(new Error('read only metadata'), { code: 'EACCES' })
      return fs.mkdirSync(path, { recursive: true, ...options })
    },
  }
  const fixture = { directory: dir, cache: new Map(), fs: deniedFs, errors: [] }
  const module = { exports: {} }
  Function(
    'require',
    'module',
    'exports',
    'fixture',
    plansCompiled.outputFiles[0].text,
  )(
    (name) => (name === 'fs' ? deniedFs : require(name)),
    module,
    module.exports,
    fixture,
  )
  assert.doesNotThrow(() => module.exports.getPlanFilePath())
  assert.equal(module.exports.getPlan(), null)
  assert.match(module.exports.getPlanSlug(), /^plan-/)
  assert.ok(fixture.errors.some((error) => error.code === 'EACCES'))
})

function loadPlans(fixtureFs, cache) {
  const fixture = { directory: undefined, cache, fs: fixtureFs, errors: [] }
  const module = { exports: {} }
  Function(
    'require',
    'module',
    'exports',
    'fixture',
    plansCompiled.outputFiles[0].text,
  )(
    (name) => (name === 'fs' ? fixtureFs : require(name)),
    module,
    module.exports,
    fixture,
  )
  return { plans: module.exports, fixture }
}

test('network and device paths are classified without any filesystem access', () => {
  const dir = directory(),
    planId = 'network-guard-plan'
  fs.writeFileSync(join(dir, `${planId}.md`), '# Saved plan\n')
  const probes = []
  const remote = (path) => /^[\/]{2}/.test(String(path))
  const guard =
    (name) =>
    (path, ...args) => {
      if (remote(path)) {
        probes.push(`${name} ${path}`)
        throw Object.assign(new Error('unexpected network probe'), {
          code: 'EACCES',
        })
      }
      return fs[name](path, ...args)
    }
  const fixtureFs = { ...fs }
  for (const name of [
    'lstatSync',
    'statSync',
    'realpathSync',
    'existsSync',
    'readFileSync',
    'readlinkSync',
    'openSync',
  ])
    fixtureFs[name] = guard(name)
  const guarded = storage(fixtureFs)
  const { plans, fixture } = loadPlans(
    fixtureFs,
    new Map([['session', planId]]),
  )
  fixture.directory = dir
  // The plan's own filename on a remote host or device path: the case a
  // permission check or a rendered tool call meets before any approval.
  const remotePaths = [
    `\\attacker.example\share\${planId}.md`,
    `//attacker.example/share/${planId}.md`,
    `\\?\UNC\attacker.example\share\${planId}.md`,
    `\\.\pipe\${planId}.md`,
  ]
  for (const path of remotePaths) {
    assert.equal(guarded.samePlanPath(path, join(dir, `${planId}.md`)), false)
    assert.equal(guarded.samePlanDirectory(dirname(path), dir), false)
    assert.equal(guarded.isPlanFilePathCandidate(dir, planId, path), false)
    assert.equal(plans.isCurrentSessionPlanFile(path), false)
    assert.equal(plans.isPlanFileForDisplay(path), false)
    assert.equal(plans.getRetiredPlanPathReplacement(path), undefined)
    assert.equal(plans.getPlanHistoryPath(path), path)
  }
  assert.deepEqual(probes, [])
  // The local plan itself is still recognized.
  assert.equal(plans.isCurrentSessionPlanFile(join(dir, `${planId}.md`)), true)
  assert.equal(plans.isPlanFileForDisplay(join(dir, `${planId}.md`)), true)
})

test('rendering unrelated files and history for non-Markdown never resolve directories', () => {
  const dir = directory(),
    planId = 'render-cost-plan'
  fs.writeFileSync(join(dir, `${planId}.md`), '# Saved plan\n')
  const elsewhere = join(dir, 'docs')
  fs.mkdirSync(elsewhere)
  let resolved = 0
  const fixtureFs = {
    ...fs,
    realpathSync(path, ...args) {
      resolved++
      return fs.realpathSync(path, ...args)
    },
  }
  const { plans, fixture } = loadPlans(
    fixtureFs,
    new Map([['session', planId]]),
  )
  fixture.directory = dir
  // Called while rendering every Read/Write/Edit message.
  for (const path of [
    join(elsewhere, 'README.md'),
    join(elsewhere, 'CHANGELOG.md'),
    join(elsewhere, 'index.ts'),
  ])
    assert.equal(plans.isPlanFileForDisplay(path), false)
  // Called for every tracked file on each turn's history snapshot.
  const code = join(elsewhere, 'index.ts')
  assert.equal(plans.getPlanHistoryPath(code), code)
  assert.equal(plans.getRetiredPlanPathReplacement(code), undefined)
  assert.equal(plans.isCurrentSessionPlanFile(code), false)
  assert.equal(resolved, 0)
})

test('a lost plan lock is reported instead of ending the process, and finished work stands', {
  timeout: 30_000,
}, async () => {
  const dir = directory(),
    planId = 'lock-safety-plan'
  const reports = []
  r.setPlanFileLockReporter((message) => reports.push(message))
  const lockPath = `${r.getPlanMetadataPath(dir, planId)}.lock`
  try {
    // Another process judged the lock stale (event-loop stall, system sleep)
    // and took it over: the holder's heartbeat finds its lock gone.
    const result = await r.withPlanFileLock(dir, planId, async () => {
      fs.rmSync(lockPath, { recursive: true })
      await new Promise((done) => setTimeout(done, 6_500))
      return 'completed'
    })
    assert.equal(result, 'completed')
    assert.ok(reports.some((message) => /compromised/.test(message)))
    // A lock that cannot be removed must not turn a finished edit into an error.
    const kept = await r.withPlanFileLock(dir, planId, async () => {
      fs.writeFileSync(join(lockPath, 'blocker'), '')
      return 'kept'
    })
    assert.equal(kept, 'kept')
    assert.ok(reports.some((message) => /release failed/.test(message)))
  } finally {
    r.setPlanFileLockReporter(() => {})
    fs.rmSync(lockPath, { recursive: true, force: true })
  }
})

test('plan metadata created inside a project is not offered for commit', () => {
  const dir = directory()
  assert.equal(r.reservePlanIdentity(dir, 'gitignore-plan'), true)
  assert.equal(
    fs.readFileSync(join(dir, '.plan-metadata', '.gitignore'), 'utf8'),
    '*\n',
  )
})

test('a permission check on a plans-folder file creates no plan identity', () => {
  const dir = directory()
  const other = join(dir, 'someone-elses-plan.md')
  fs.writeFileSync(other, '# Another session plan\n')
  const { plans, fixture } = loadPlans(fs, new Map())
  fixture.directory = dir
  assert.equal(plans.isCurrentSessionPlanFile(other), false)
  assert.equal(plans.getPlan(), null)
  assert.equal(fixture.cache.size, 0)
  assert.equal(fs.existsSync(join(dir, '.plan-metadata')), false)
})
