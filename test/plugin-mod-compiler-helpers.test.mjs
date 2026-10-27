import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const original = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-mod-helpers-'))
const project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: [
    'src/utils/plugins/mods/compiler.ts',
    'src/utils/plugins/mods/runtime.ts',
  ],
  exports: ['compileMod', 'ModRuntime'],
})
let fixtures = 0
const runtimes = new Set()
const write = (path, source) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}
async function compile(source, extra = {}) {
  const path = join(root, `mod-${fixtures++}`)
  const entry = join(path, 'register.ts')
  write(entry, source)
  for (const [name, content] of Object.entries(extra))
    write(join(path, name), content)
  return { path, entry, compiled: await r.compileMod(path, entry) }
}
async function run(source) {
  const { path, compiled } = await compile(source)
  const mod = new r.ModRuntime({ name: 'helper-fixture', root: path }, compiled)
  runtimes.add(mod)
  await mod.initialize()
  const calls = []
  const result = await mod.dispatch(
    'command.run',
    { command: 'notes' },
    async () => { throw new Error('Unexpected core call') },
    async (method, args) => {
      calls.push({ method, args })
      assert.equal(method, 'store.get')
      return `stored:${args[0]}`
    },
  )
  return { compiled, calls, result }
}

after(async () => {
  await Promise.allSettled([...runtimes].map(mod => mod.dispose()))
  process.chdir(original)
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('same-file named helpers and helper chains execute through the compiled worker', async () => {
  const { compiled, calls, result } = await run(`
    async function loadNotes($, key) { return $.store.get(key) }
    const decorate = async (prefix, $) => prefix + await loadNotes($, 'notes')
    export function register(on) {
      on('command.run', {command: 'notes'}, async ($) => ({text: await decorate('saved:', $)}))
    }
  `)
  assert.deepEqual(compiled.events, ['command.run'])
  assert.deepEqual(compiled.calls, ['store.get'])
  assert.deepEqual(calls, [{ method: 'store.get', args: ['notes'] }])
  assert.deepEqual(result, { text: 'saved:stored:notes' })
})

test('recursive helpers resolve their own lexical symbols and erased this parameters', async () => {
  const { calls, result } = await run(`
    const loadNotes = function repeat(this: void, $, remaining: number) {
      return remaining ? finish($, remaining - 1) : $.store.get('recursive')
      function unrelated() { return 'unused' }
    }
    function finish($, remaining) { return loadNotes($, remaining) }
    function recursive($, remaining) {
      return remaining ? recursive($, remaining - 1) : loadNotes($, 2)
    }
    export function register(on) {
      on('command.run', async ($) => ({text: await recursive($, 2)}))
    }
  `)
  assert.deepEqual(calls, [{ method: 'store.get', args: ['recursive'] }])
  assert.deepEqual(result, { text: 'stored:recursive' })

  // A named function expression's self-reference has its own binding.
  const named = await run(`
    const loadNotes = function repeat($, remaining) {
      return remaining ? repeat($, remaining - 1) : $.store.get('self')
    }
    export function register(on) {
      on('command.run', async ($) => ({text: await loadNotes($, 2)}))
    }
  `)
  assert.deepEqual(named.result, { text: 'stored:self' })
})

test('helpers retain deterministic method metadata and source cache digests', async () => {
  const source = `
    function first($) { $.store.get('one'); return second($) }
    function second($) { $.store.get('two'); return $.clock.now() }
    export function register(on) { on('command.run', async ($) => ({text: String(first($))})) }
  `
  const { path, entry, compiled } = await compile(source)
  const again = await r.compileMod(path, entry)
  assert.deepEqual(again, compiled)
  assert.deepEqual(compiled.calls, ['store.get', 'clock.now'])
  assert.match(compiled.digest, /^[a-f0-9]{64}$/)
  write(entry, source.replace("'two'", "'changed'"))
  const changed = await r.compileMod(path, entry)
  assert.notEqual(changed.digest, compiled.digest)
  assert.deepEqual(changed.calls, compiled.calls)
})

const hook = body => `export function register(on) { on('command.run', async ($) => { ${body}; return {text: 'ok'} }) }`
const helper = 'function helper($) { return $.store.get("notes") }\n'

test('passing the API to imports, methods, nested functions, aliases or the wrong parameter fails validation', async () => {
  for (const [name, source, extra = {}] of [
    ['imported', `import { helper } from './other.js'; ${hook('helper($)')}`, { 'other.js': helper + 'export { helper }' }],
    ['method', `const object = {helper($) { return $.store.get('notes') }}; ${hook('object.helper($)')}`],
    ['nested', hook('function helper($) { return $.store.get("notes") }; helper($)')],
    ['anonymous', hook('(function($) { return $.store.get("notes") })($)')],
    ['helper alias', helper + `const alias = helper; ${hook('alias($)')}`],
    ['API alias', helper + hook('const alias = $; helper(alias)')],
    ['namespace alias', helper + hook('const store = $.store; helper($)')],
    ['destructure API', helper + hook('const {store} = $; helper($)')],
    ['computed namespace', helper + hook('$["store"].get("notes"); helper($)')],
    ['different parameter', `function helper(api) { return api.store.get('notes') }; ${hook('helper($)')}`],
    ['rest parameter', `function helper(...$) {}; ${hook('helper($)')}`],
    ['wrong slot', `function helper(prefix, $) {}; ${hook('helper($, "suffix")')}`],
    ['spread shifts slot', `function helper(alias, $) { alias.store.get('hidden') }; ${hook('helper(...[], $)')}`],
    ['erased this shifts slot', `function helper(this: void, $, alias) { alias.store.get('hidden') }; ${hook('helper(null, $)')}`],
  ]) {
    await assert.rejects(compile(source, extra), /cannot be aliased/, name)
  }
})

test('lexical shadowing cannot redirect a validated helper call', async () => {
  for (const [name, body] of [
    ['parameter', '(function(helper) { helper($) })(() => {})'],
    ['block const', '{ const helper = (api) => api.store.get("hidden"); helper($) }'],
    ['block function', '{ function helper(api) { return api.store.get("hidden") }; helper($) }'],
    ['catch binding', 'try { throw () => {} } catch (helper) { helper($) }'],
    ['destructured binding', 'const {helper} = {helper: (api) => {}}; helper($)'],
  ]) {
    await assert.rejects(compile(helper + hook(body)), /cannot be aliased/, name)
  }
})

test('validated helpers cannot be reassigned through direct or destructuring writes', async () => {
  for (const [name, mutation] of [
    ['assignment', 'helper = replacement'],
    ['compound assignment', 'helper ||= replacement'],
    ['increment', 'helper++'],
    ['destructure array', '[helper] = [replacement]'],
    ['destructure property', '({value: helper} = {value: replacement})'],
    ['destructure shorthand', '({helper} = {helper: replacement})'],
    ['destructure default', '({helper = replacement} = {})'],
    ['destructure rest', '({...helper} = {helper: replacement})'],
    ['for of', 'for (helper of [replacement]) {}'],
    ['for in', 'for (helper in {replacement}) {}'],
    ['for rest', 'for ({...helper} of [{replacement}]) {}'],
    ['cast assignment', '(helper as unknown) = replacement'],
  ]) {
    const source = helper + `const replacement = (api) => api.store.get('hidden'); ${hook(`${mutation}; helper($)`)}`
    await assert.rejects(compile(source), /helper cannot be reassigned/, name)
  }
})

test('helper bodies undergo the same API checks and cannot recover the API through arguments', async () => {
  for (const [source, expected] of [
    [`function helper($) { return $.ui.open({}) }; ${hook('helper($)')}`, /does not yet support mod API \$\.ui\.open/],
    [`function helper($) { const store = $.store; return store.get('hidden') }; ${hook('helper($)')}`, /cannot be aliased/],
    [`function helper($) { return arguments[0].store.get('hidden') }; ${hook('helper($)')}`, /not arguments/],
    [`function helper($) { return (() => arguments[0].store.get('hidden'))() }; ${hook('helper($)')}`, /not arguments/],
  ]) {
    await assert.rejects(compile(source), expected)
  }
})

test('large helper graphs are scanned once and excessive scopes fail with a validation error', async () => {
  const chain = Array.from({ length: 200 }, (_, index) =>
    `function step${index}($) { return step${(index + 1) % 200}($) }`,
  ).join('\n')
  const { compiled } = await compile(chain + hook('step0($)'))
  assert.deepEqual(compiled.events, ['command.run'])
  assert.deepEqual(compiled.calls, [])
  const scopes = Array.from({ length: 1100 }, (_, index) => `function step${index}($) {}`).join('\n')
  await assert.rejects(compile(scopes + hook('step0($)')), /exceeds 2000 scopes/)
  await assert.rejects(compile('{'.repeat(520) + '0;' + '}'.repeat(520)), /nested too deeply to scan/)
})
