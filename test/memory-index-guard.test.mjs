import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repository = fileURLToPath(new URL('../', import.meta.url))
const runtime = {}
const stubModules = {
  'bun:bundle': 'export const feature = name => runtime.buildFeatures.has(name)',
  '../bootstrap/state.js': 'export const getKairosActive = () => runtime.kairos',
  '../services/analytics/growthbook.js': 'export const getFeatureValue_CACHED_MAY_BE_STALE = (name, fallback) => runtime.flags[name] ?? fallback',
  '../utils/errors.js': "export const isENOENT = error => error?.code === 'ENOENT'",
  '../utils/fsOperations.js': 'export const getFsImplementation = () => runtime.fs',
  '../utils/path.js': 'export const expandPath = filePath => runtime.expandPath(filePath)',
  './paths.js': "export const getAutoMemPath = () => runtime.root; export const isAutoMemoryEnabled = () => runtime.enabled; export const LEARNED_SUBDIR = 'learned'",
}

// Bundle the production helper with its real Markdown parser. Only the runtime
// environment is substituted; the repository's application is never booted.
const bundle = await build({
  absWorkingDir: repository,
  entryPoints: ['src/memdir/memoryIndexGuard.ts'],
  bundle: true,
  packages: 'external',
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  plugins: [{
    name: 'memory-guard-runtime',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (Object.hasOwn(stubModules, args.path)) {
          return { path: args.path, namespace: 'memory-guard-runtime' }
        }
      })
      builder.onLoad({ filter: /.*/, namespace: 'memory-guard-runtime' }, args => ({
        contents: stubModules[args.path],
        loader: 'js',
      }))
    },
  }],
})
const helperModule = { exports: {} }
const nativeRequire = createRequire(import.meta.url)
const testPath = new Proxy(path, { get: (_, key) => (runtime.path ?? path)[key] })
const testProcess = new Proxy(process, {
  get: (target, key) => key === 'platform' ? runtime.platform ?? target.platform : target[key],
})
new Function('require', 'module', 'exports', 'runtime', 'process', bundle.outputFiles[0].text)(
  name => name === 'path' ? testPath : nativeRequire(name),
  helperModule, helperModule.exports, runtime, testProcess,
)
const { getMemoryIndexWarning } = helperModule.exports

const testingPreference = `---
name: Project test framework
description: Use Vitest for project tests and never Jest.
type: feedback
---
In this project I always want tests written with vitest, never jest.
`

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'tau-memory-index-guard-'))
  const root = path.join(directory, 'memory')
  fs.mkdirSync(root)
  Object.assign(runtime, {
    root: root + path.sep,
    path,
    platform: process.platform,
    enabled: true,
    kairos: false,
    buildFeatures: new Set(),
    flags: {},
    reads: [],
    readError: undefined,
    expandPath: value => path.resolve(value.trim()),
    fs: {
      readFileSync(file, options) {
        runtime.reads.push(file)
        if (runtime.readError) throw runtime.readError
        return fs.readFileSync(file, options)
      },
    },
  })
  // Delete only this test's freshly allocated directory, never a supplied path.
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('tau-memory-index-guard-'))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  function write(name, contents = testingPreference) {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
    return target
  }
  function index(contents, subdirectory = '') {
    return write(path.join(subdirectory, 'MEMORY.md'), contents)
  }
  return { directory, root, write, index }
}

function assertReminder(file, indexFromTopic = 'MEMORY.md') {
  const warning = getMemoryIndexWarning(file)
  assert.equal(typeof warning, 'string')
  assert.match(warning, /^<system-reminder>[\s\S]*<\/system-reminder>$/)
  assert.ok(warning.includes(JSON.stringify(indexFromTopic)), warning)
  assert.match(warning, /one-line link/)
  assert.ok(warning.split(/\s+/).length <= 40, 'only a short reminder is added')
  return warning
}

test('Vitest-never-Jest orphan save gets a reminder without modifying memory', t => {
  const { root, write, index } = fixture(t)
  const file = write('feedback_testing.md')
  const before = fs.readFileSync(file, 'utf8')
  assertReminder(file)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(fs.existsSync(path.join(root, 'MEMORY.md')), false)

  const indexFile = index('# Memory\n')
  assertReminder(file)
  assert.equal(fs.readFileSync(indexFile, 'utf8'), '# Memory\n')

  index('- [Testing preference](feedback_testing.md): Vitest, never Jest.\n')
  assert.equal(getMemoryIndexWarning(file), undefined)
})

test('an existing index must point to every saved topic, not just one', t => {
  const { write, index } = fixture(t)
  const first = write('feedback_testing.md')
  const second = write('project_architecture.md', '# Architecture\nUse the shared service.\n')
  index('- [Testing preference](feedback_testing.md)\n')
  assert.equal(getMemoryIndexWarning(first), undefined)
  assertReminder(second)
  index('- [Testing preference](feedback_testing.md)\n- [Architecture](project_architecture.md)\n')
  assert.equal(getMemoryIndexWarning(first), undefined)
  assert.equal(getMemoryIndexWarning(second), undefined)
})

test('same path is rechecked after a no-op save, index addition and index removal', t => {
  const { write, index } = fixture(t)
  const file = write('feedback_testing.md')
  assertReminder(file)
  assertReminder(file)
  index('[Testing](feedback_testing.md)\n')
  assert.equal(getMemoryIndexWarning(file), undefined)
  index('# Memory\n')
  assertReminder(file)
  assert.equal(runtime.reads.length, 4)
})

test('valid Markdown pointers include normalized paths, references, titles and fragments', async t => {
  for (const [label, contents] of [
    ['inline', '- [Tests](feedback_testing.md)'],
    ['normalized', '- [Tests](./unused/../feedback_testing.md)'],
    ['fragment', '- [Tests](feedback_testing.md#framework)'],
    ['query', '- [Tests](feedback_testing.md?view=raw#framework)'],
    ['title', '- [Tests](feedback_testing.md "Test framework")'],
    ['reference', '[Tests][framework]\n\n[framework]: feedback_testing.md'],
    ['collapsed reference', '[Tests][]\n\n[Tests]: feedback_testing.md'],
    ['shortcut reference', '[Tests]\n\n[Tests]: feedback_testing.md'],
    ['table', '| Topic |\n| --- |\n| [Tests](feedback_testing.md) |'],
  ]) {
    await t.test(label, child => {
      const { write, index } = fixture(child)
      const file = write('feedback_testing.md')
      index(contents)
      assert.equal(getMemoryIndexWarning(file), undefined)
    })
  }
})

test('spaces and encoded filename characters resolve to the actual topic', async t => {
  for (const [name, destination] of [
    ['testing preference.md', '<testing preference.md>'],
    ['testing preference.md', 'testing%20preference.md'],
    ['testing#preference.md', 'testing%23preference.md#details'],
    ['testing%preference.md', 'testing%25preference.md'],
    ['caf\u00e9.md', 'caf%C3%A9.md'],
  ]) {
    await t.test(name + ' via ' + destination, child => {
      const { write, index } = fixture(child)
      const file = write(name)
      index(`[Tests](${destination})\n`)
      assert.equal(getMemoryIndexWarning(file), undefined)
    })
  }
})

test('mentions, examples and links to other paths do not count as index pointers', async t => {
  for (const [label, contents] of [
    ['plain filename', 'Saved feedback_testing.md successfully.'],
    ['inline code', '`[Tests](feedback_testing.md)`'],
    ['fenced code', '```markdown\n[Tests](feedback_testing.md)\n```'],
    ['indented code', '    [Tests](feedback_testing.md)'],
    ['HTML comment', '<!-- [Tests](feedback_testing.md) -->'],
    ['link label only', '[feedback_testing.md](somewhere_else.md)'],
    ['same basename in another directory', '[Tests](archive/feedback_testing.md)'],
    ['filename substring', '[Tests](feedback_testing.md.bak)'],
    ['external URL', '[Tests](https://example.test/feedback_testing.md)'],
    ['unreferenced definition', '[unused]: feedback_testing.md'],
    ['image', '![Tests](feedback_testing.md)'],
    ['malformed encoding', '[Tests](feedback%ZZ_testing.md)'],
  ]) {
    await t.test(label, child => {
      const { write, index } = fixture(child)
      const file = write('feedback_testing.md')
      index(contents)
      assertReminder(file)
    })
  }
})

test('a malformed link does not hide a later valid pointer', t => {
  const { write, index } = fixture(t)
  const file = write('feedback_testing.md')
  index('[Bad](feedback%ZZ.md)\n\n[Tests](feedback_testing.md)\n')
  assert.equal(getMemoryIndexWarning(file), undefined)
})

test('nested topics resolve links from the memory root and remind about that root index', t => {
  const { write, index } = fixture(t)
  const file = write('preferences/feedback_testing.md')
  index('[Tests](feedback_testing.md)\n')
  assertReminder(file, '../MEMORY.md')
  index('[Tests](preferences/feedback_testing.md)\n')
  assert.equal(getMemoryIndexWarning(file), undefined)
})

test('ordinary project writes, prefix neighbors and traversal outside memory are quiet', t => {
  const { directory, root, write } = fixture(t)
  for (const file of [
    path.join(directory, 'README.md'),
    path.join(directory, 'memory-neighbor', 'feedback_testing.md'),
    path.join(root, '..', 'outside.md'),
    path.join(root, '..'),
    root,
    write('preferences.json', '{}'),
    write('MEMORY.md', '# Memory\n'),
    write('learned/proposed.md'),
    write('logs/2026/10/2026-10-11.md'),
  ]) assert.equal(getMemoryIndexWarning(file), undefined, file)
  assert.deepEqual(runtime.reads, [])
})

test('a normal subdirectory with a reserved word in its filename is still checked', t => {
  const { write } = fixture(t)
  assertReminder(write('learned_project.md'))
  assertReminder(write('logs_reference.md'))
  assertReminder(write('preferences/learned.md'), '../MEMORY.md')
})

test('relative and expanded input paths refer to the same successful topic save', t => {
  const { write, root } = fixture(t)
  const file = write('feedback_testing.md')
  assertReminder(path.relative(process.cwd(), file))
  assertReminder(`  ${file}  `)
  runtime.expandPath = value => value.startsWith('~/')
    ? path.join(root, value.slice(2))
    : path.resolve(value)
  assertReminder('~/feedback_testing.md')
})

test('disabled, indexless and active KAIROS modes add no reminder or index reads', async t => {
  for (const [label, configure] of [
    ['auto memory disabled', () => { runtime.enabled = false }],
    ['indexless memory', () => { runtime.flags.tengu_moth_copse = true }],
    ['active KAIROS', () => { runtime.buildFeatures.add('KAIROS'); runtime.kairos = true }],
  ]) {
    await t.test(label, child => {
      const { write } = fixture(child)
      configure()
      assert.equal(getMemoryIndexWarning(write('feedback_testing.md')), undefined)
      assert.deepEqual(runtime.reads, [])
    })
  }
})

test('inactive KAIROS or a build without KAIROS still checks normal memory', t => {
  const { write } = fixture(t)
  const file = write('feedback_testing.md')
  runtime.buildFeatures.add('KAIROS')
  assertReminder(file)
  runtime.buildFeatures.clear()
  runtime.kairos = true
  assertReminder(file)
})

test('team topics use their own index and require both team gates', t => {
  const { root, write, index } = fixture(t)
  const file = write('team/feedback_testing.md')
  assert.equal(getMemoryIndexWarning(file), undefined)
  runtime.buildFeatures.add('TEAMMEM')
  assert.equal(getMemoryIndexWarning(file), undefined)
  runtime.flags.tengu_herring_clock = true
  index('[Tests](team/feedback_testing.md)\n')
  assertReminder(file)
  assert.equal(runtime.reads.at(-1), path.join(root, 'team', 'MEMORY.md'))
  index('[Tests](feedback_testing.md)\n', 'team')
  assert.equal(getMemoryIndexWarning(file), undefined)
  runtime.buildFeatures.clear()
  assert.equal(getMemoryIndexWarning(file), undefined)
})

test('team index, staging and daily logs stay quiet', t => {
  const { write } = fixture(t)
  runtime.buildFeatures.add('TEAMMEM')
  runtime.flags.tengu_herring_clock = true
  for (const name of ['team/MEMORY.md', 'team/learned/proposed.md', 'team/logs/2026-10-11.md']) {
    assert.equal(getMemoryIndexWarning(write(name)), undefined, name)
  }
  assert.deepEqual(runtime.reads, [])
})

test('Windows case differences preserve existing pointers and excluded paths', { skip: process.platform !== 'win32' }, t => {
  const { write, index } = fixture(t)
  const file = write('Feedback_Testing.md')
  index('[Tests](FEEDBACK_TESTING.MD)\n')
  assert.equal(getMemoryIndexWarning(file.toUpperCase()), undefined)
  runtime.buildFeatures.add('TEAMMEM')
  runtime.flags.tengu_herring_clock = true
  runtime.reads.length = 0
  for (const name of ['MEMORY.MD', 'LEARNED/proposed.md', 'LOGS/today.md', 'TEAM/LEARNED/proposed.md', 'TEAM/LOGS/today.md']) {
    assert.equal(getMemoryIndexWarning(write(name)), undefined, name)
  }
  assert.deepEqual(runtime.reads, [])
})

test('unreadable index and unexpected filesystem failures cannot fail a save', t => {
  const { write } = fixture(t)
  const file = write('feedback_testing.md')
  for (const code of ['EACCES', 'EIO', 'EISDIR']) {
    runtime.readError = Object.assign(new Error(code), { code })
    assert.equal(getMemoryIndexWarning(file), undefined)
  }
  runtime.readError = Object.assign(new Error('missing index'), { code: 'ENOENT' })
  assertReminder(file)
  runtime.expandPath = () => { throw new Error('path expansion failed') }
  assert.equal(getMemoryIndexWarning(file), undefined)
})

// Exercise both path dialects on every host; these are path-semantics checks,
// while the fixtures above exercise the host's actual filesystem.
for (const [platform, dialect, root] of [
  ['linux', path.posix, '/srv/project-memory'],
  ['win32', path.win32, 'D:\\projects\\project-memory'],
]) {
  test(`${platform} paths resolve the configured root without host-specific assumptions`, t => {
    fixture(t)
    let indexText = ''
    Object.assign(runtime, {
      root, path: dialect, platform,
      expandPath: value => dialect.resolve(value.trim()),
      fs: {
        readFileSync(file) {
          assert.equal(file, dialect.join(root, 'MEMORY.md'))
          return indexText
        },
      },
    })
    const topic = dialect.join(root, 'preferences', 'testing.md')
    assertReminder(topic, '../MEMORY.md')
    indexText = '[Tests](preferences/testing.md)\n'
    assert.equal(getMemoryIndexWarning(topic), undefined)
    indexText = '[Wrong directory](other/testing.md)\n'
    assertReminder(topic, '../MEMORY.md')
    for (const outside of [
      dialect.join(root + '-neighbor', 'testing.md'),
      dialect.join(root, '..', 'testing.md'),
    ]) assert.equal(getMemoryIndexWarning(outside), undefined)
    indexText = '[Tests](Preferences/Testing.md)\n'
    if (platform === 'win32') assert.equal(getMemoryIndexWarning(topic), undefined)
    else assertReminder(topic, '../MEMORY.md')
  })
}
