import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// The chain's tiers: prependPlugins and appendPlugins seat mods ahead of and
// behind the ones a person installs; next.to skips ahead; next.trace lists
// what settled beneath; next.origin names the caller's tier; a hook is skipped
// on an event its own call raised, its .catch told so (re-entry).
const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-tiers-')), project = join(root, 'project')
const config = join(root, 'config')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
  TAU_TEST_NODE: process.execPath,
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/sessionState.ts',
    'src/utils/plugins/mods/compiler.ts', 'src/utils/plugins/mods/runtime.ts'],
  exports: ['compileMod', 'ModRuntime', 'startPluginMods', 'stopPluginMods', 'dispatchModEvent', 'getModWarnings',
    'setInlinePlugins', 'resetSettingsCache', 'clearAllCaches', 'setOriginalCwd', 'setSessionTrustAccepted',
    'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath', 'updateHooksConfigSnapshot'],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)

let serial = 0
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)) }
const readJson = name => existsSync(join(project, name)) ? JSON.parse(readFileSync(join(project, name), 'utf8')) : undefined
/** Loads named mods; `tiers` lists which go in prependPlugins / appendPlugins
 * (a person's own settings, with no managed settings on this machine). */
async function loadMods(definitions, { prepend = [], append = [], allowWarnings = false } = {}) {
  const run = ++serial
  const names = Object.keys(definitions).map(name => `${name}-${run}`)
  const paths = Object.entries(definitions).map(([name, hooks]) => {
    const path = join(root, `${name}-${run}`)
    write(join(path, '.claude-plugin/plugin.json'), { name: `${name}-${run}`, version: '1.0.0' })
    write(join(path, 'hooks/hooks.json'), { modules: ['./register.ts'] })
    write(join(path, 'hooks/register.ts'), `export function register(on) {${hooks}}`)
    return path
  })
  write(join(config, 'settings.json'), {
    prependPlugins: prepend.map(name => `${name}-${run}@inline`),
    appendPlugins: append.map(name => `${name}-${run}@inline`),
  })
  r.setInlinePlugins(paths); r.resetSettingsCache(); r.clearAllCaches(); r.updateHooksConfigSnapshot()
  await r.startPluginMods(true)
  if (!allowWarnings) assert.deepEqual(r.getModWarnings(), [])
  return Object.fromEntries(Object.keys(definitions).map(name => [name, `${name}-${run}`]))
}
const pass = `on('turn.start', async ($, e, next) => next(e))`
const shape = trace => trace.map(({ index, plugin, tier, outcome, reason }) => ({ index, plugin, tier, outcome, ...(reason ? { reason } : {}) }))
afterEach(async () => { await r.stopPluginMods() })
after(async () => { await r.stopPluginMods(); process.chdir(original); rmSync(root, { recursive: true, force: true, maxRetries: 10 }) })

test('prependPlugins and appendPlugins seat mods around the ones a person installs; next.trace lists the links beneath', async () => {
  // Listed in load order user, append, prepend: the tiers decide the chain.
  const names = await loadMods({
    middle: pass,
    last: pass,
    first: `on('turn.start', async ($, e, next) => {
      const out = await next(e)
      await $.fs.write('first.json', JSON.stringify({ origin: next.origin, trace: next.trace }))
      return out
    })`,
  }, { prepend: ['first'], append: ['last'] })
  await r.dispatchModEvent('turn.start', { turnId: 't1' }, async e => ({ turnId: e.turnId }))
  const seen = readJson('first.json')
  assert.deepEqual(seen.origin, { plugin: 'engine', tier: 'core' })
  assert.deepEqual(shape(seen.trace), [
    { index: 1, plugin: names.middle, tier: 'user', outcome: 'returned' },
    { index: 2, plugin: names.last, tier: 'append', outcome: 'returned' },
    { index: 3, plugin: 'engine', tier: 'core', outcome: 'returned' },
  ])
  assert.deepEqual(seen.trace[2].received, { turnId: 't1' })
  assert.deepEqual(seen.trace[2].returned, { turnId: 't1' })
})

test('next.to lets a prepended mod skip the user tier, traced as bypassed; other tiers may not', async () => {
  const names = await loadMods({
    guard: `on('turn.start', async ($, e, next) => {
      // Refused before anything runs: a tier with more authority.
      let backwards
      try { await next.to(e, 'prepend') } catch (error) { backwards = error.message }
      const out = await next.to(e, 'append')
      await $.fs.write('guard.json', JSON.stringify({ trace: next.trace, backwards }))
      return out
    })`,
    person: `on('turn.start', async ($, e, next) => {
      let refused
      try { await next.to(e, 'core') } catch (error) { refused = error.message }
      await $.fs.write('person.json', JSON.stringify({ refused }))
      return next(e)
    })`,
    tail: `on('turn.start', async ($, e, next) => {
      let refused
      try { await next.to(e, 'user') } catch (error) { refused = error.message }
      await $.fs.write('tail.json', JSON.stringify({ refused }))
      return next.to(e, 'core')
    })`,
  }, { prepend: ['guard'], append: ['tail'] })
  await r.dispatchModEvent('turn.start', { turnId: 't2' }, async e => ({ turnId: e.turnId }))
  const guard = readJson('guard.json')
  assert.deepEqual(shape(guard.trace), [
    { index: 1, plugin: names.person, tier: 'user', outcome: 'skipped', reason: `bypassed by ${names.guard}` },
    { index: 2, plugin: names.tail, tier: 'append', outcome: 'returned' },
    { index: 3, plugin: 'engine', tier: 'core', outcome: 'returned' },
  ])
  assert.match(guard.backwards, /next\.to cannot continue at prepend from the prepend tier/)
  assert.equal(readJson('person.json'), undefined, 'the user tier never ran')
  assert.match(readJson('tail.json').refused, /next\.to cannot continue at user from the append tier/)
  // A person's mod may not call it at all.
  await loadMods({ person: `on('turn.start', async ($, e, next) => {
    let refused
    try { await next.to(e, 'core') } catch (error) { refused = error.message }
    await $.fs.write('alone.json', JSON.stringify({ refused }))
    return next(e)
  })` })
  await r.dispatchModEvent('turn.start', { turnId: 't3' }, async e => ({ turnId: e.turnId }))
  assert.match(readJson('alone.json').refused, /next\.to is for mods in prependPlugins or appendPlugins/)
})

test('the trace tells a hook that failed before or after next, and one its .catch answered', async () => {
  const names = await loadMods({
    top: `on('turn.start', async ($, e, next) => {
      const out = await next(e)
      await $.fs.write('top.json', JSON.stringify(next.trace))
      return out
    })`,
    before: `on('turn.start', async () => { throw new Error('boom before') })`,
    after: `on('turn.start', async ($, e, next) => { await next(e); throw new Error('boom after') })`,
    caught: `on('turn.start', async () => { throw new Error('boom caught') }).catch(async ($, e, next) => {
      await $.fs.write('caught.json', JSON.stringify({ kind: next.error.kind, called: next.called }))
      return next(e)
    })`,
  }, { prepend: ['top'], allowWarnings: true })
  await r.dispatchModEvent('turn.start', { turnId: 't4' }, async e => ({ turnId: e.turnId }))
  const outcomes = Object.fromEntries(readJson('top.json').map(entry => [entry.plugin, entry.outcome]))
  assert.equal(outcomes[names.before], 'skipped')
  assert.equal(outcomes[names.after], 'kept')
  assert.equal(outcomes[names.caught], 'caught')
  assert.equal(outcomes.engine, 'returned')
  assert.deepEqual(readJson('caught.json'), { kind: 'throw', called: false })
})

test('a call a mod makes reaches the mods above with that mod\'s tier as next.origin', async () => {
  const names = await loadMods({
    watcher: `on('fs.exists', async ($, e, next) => {
      await $.fs.write('origin.json', JSON.stringify(next.origin))
      return next(e)
    })`,
    caller: `on('turn.start', async ($, e, next) => { await $.fs.exists('anything.txt'); return next(e) })`,
  }, { prepend: ['watcher'] })
  await r.dispatchModEvent('turn.start', { turnId: 't5' }, async e => ({ turnId: e.turnId }))
  assert.deepEqual(readJson('origin.json'), { plugin: names.caller, tier: 'user' })
})

test('a hook skipped on an event its own call raised is told so in its .catch (re-entry)', async () => {
  const path = join(root, 'reentry')
  write(join(path, 'register.ts'), `export function register(on) {
    on('turn.start', async ($, e, next) => { await $.fs.write('ran', 'yes'); return next(e) }).catch(async ($, e, next) => {
      await $.fs.write('caught', next.error.kind + ':' + next.called)
      return next(e)
    })
  }`)
  const compiled = await r.compileMod(path, join(path, 'register.ts'))
  const runtime = new r.ModRuntime({ name: 'reentry', root: path }, compiled, {})
  await runtime.initialize()
  const calls = []
  const host = async (method, args) => { calls.push([method, ...args]) }
  try {
    // From its own call: skipped, its handler asked with kind re-entry.
    assert.deepEqual(await runtime.dispatch('turn.start', { turnId: 't6' }, async e => e, host, { skipHook: 0 }), { turnId: 't6' })
    assert.deepEqual(calls.splice(0), [['fs.write', 'caught', 're-entry:false']])
    // From the module's code outside its hooks: the same.
    assert.deepEqual(await runtime.dispatch('turn.start', { turnId: 't6' }, async e => e, host, { skipAll: true }), { turnId: 't6' })
    assert.deepEqual(calls.splice(0), [['fs.write', 'caught', 're-entry:false']])
    // Any other event runs the hook itself.
    await runtime.dispatch('turn.start', { turnId: 't6' }, async e => e, host, {})
    assert.deepEqual(calls.splice(0), [['fs.write', 'ran', 'yes']])
  } finally {
    await runtime.dispose()
  }
})

test('plugin.register: the mods admitted before a module judge it by tier and uses; a refusal keeps it out', async () => {
  const names = await loadMods({
    judge: `on('plugin.register', async ($, e, next) => {
      await $.store.set('seen:' + e.name, e)
      if (e.tier === 'user' && e.uses.calls.includes('process.run')) return { refuse: 'no processes here' }
      return next(e)
    })`,
    runner: `on('turn.start', async ($, e, next) => { await $.fs.write('runner.txt', 'ran'); await $.process.run(['node', '-v']); return next(e) })
      on('session.start', async ($, e, next) => { await $.env.get('RUNNER_FLAG'); return next(e) })`,
    quiet: `on('turn.start', async ($, e, next) => { await $.fs.write('quiet.txt', 'ran'); return next(e) })`,
  }, { prepend: ['judge'], allowWarnings: true })
  assert.ok(r.getModWarnings().some(text => text === `${names.runner}: hooks module refused by ${names.judge}: no processes here`), r.getModWarnings().join('\n'))
  await r.dispatchModEvent('turn.start', { turnId: 't7' }, async e => ({ turnId: e.turnId }))
  assert.equal(existsSync(join(project, 'runner.txt')), false, 'a refused module has no hooks')
  assert.equal(readFileSync(join(project, 'quiet.txt'), 'utf8'), 'ran')
})

test('engine.create: a mod adds a noun every module calls; an org mod withholds one, a person\'s may not; replacing fails', async () => {
  const names = await loadMods({
    org: `on('engine.create', async ($, e, next) => {
      const built = await next(e)
      const { process, ...rest } = built
      return rest
    })`,
    lender: `on('engine.create', async ($, e, next) => {
      const built = await next(e)
      return { ...built, greet: { hello: async name => { await built.fs.write('lent.txt', 'by lender'); return 'hello ' + name } } }
    })`,
    greedy: `on('engine.create', async ($, e, next) => {
      const built = await next(e)
      const { store, ...rest } = built
      return rest
    })`,
    consumer: `on('turn.start', async ($, e, next) => {
      const answer = await $.greet.hello('bob')
      let processes
      try { await $.process.run(['node', '-v']) } catch (error) { processes = error.message }
      const store = await $.store.keys().then(() => 'callable', error => error.message)
      await $.fs.write('consumer.json', JSON.stringify({ answer, processes, store }))
      return next(e)
    })`,
  }, { prepend: ['org'], allowWarnings: true })
  assert.ok(r.getModWarnings().some(text => text.includes(`${names.greedy}: engine.create: a mod a person installs may not withhold $.store`)), r.getModWarnings().join('\n'))
  await r.dispatchModEvent('turn.start', { turnId: 't8' }, async e => ({ turnId: e.turnId }))
  const seen = readJson('consumer.json')
  assert.ok(seen, r.getModWarnings().join('\n'))
  assert.equal(seen.answer, 'hello bob')
  assert.ok(seen.processes.includes(`$.process is withheld by ${names.org}`), seen.processes)
  assert.equal(seen.store, 'callable', 'a person\'s mod cannot withhold a noun')
  assert.equal(readFileSync(join(project, 'lent.txt'), 'utf8'), 'by lender')
})

test('engine.create: a step that replaces a noun is unloaded, and a module calling a noun nobody added does not load', async () => {
  const names = await loadMods({
    replacer: `on('engine.create', async ($, e, next) => {
      const built = await next(e)
      return { ...built, fs: { read: async () => 'fake' } }
    })`,
    orphan: `on('turn.start', async ($, e, next) => { await $.nowhere.thing(); return next(e) })`,
    fine: `on('turn.start', async ($, e, next) => { await $.fs.write('fine.txt', await $.fs.exists('fine.txt') ? 'again' : 'first'); return next(e) })`,
  }, { allowWarnings: true })
  const warnings = r.getModWarnings().join('\n')
  assert.ok(warnings.includes(`${names.replacer}: engine.create hook skipped: engine.create may not replace $.fs, which a step beneath built`), warnings)
  assert.ok(warnings.includes(`${names.replacer}: unloaded; $ is built again without it`), warnings)
  assert.ok(warnings.includes(`${names.orphan}: mod did not load: it calls $.nowhere.thing, which no loaded mod adds to $`), warnings)
  await r.dispatchModEvent('turn.start', { turnId: 't9' }, async e => ({ turnId: e.turnId }))
  assert.equal(readFileSync(join(project, 'fine.txt'), 'utf8'), 'first')
})
