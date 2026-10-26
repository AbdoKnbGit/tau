import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const original = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-mod-startup-'))
const project = join(root, 'project'),
  config = join(root, 'config')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '',
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: [
    'src/utils/plugins/mods/manager.ts',
    'src/utils/skills/skillChangeDetector.ts',
  ],
  exports: [
    'startPluginMods',
    'stopPluginMods',
    'getModCommands',
    'getModWarnings',
    'setInlinePlugins',
    'setOriginalCwd',
    'setSessionTrustAccepted',
    'setAllowedSettingSources',
    'setIsInteractive',
    'resetSettingsCache',
    'clearAllCaches',
    'getManagedFilePath',
    'skillChangeDetector',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setIsInteractive(false)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const reset = () => {
  r.resetSettingsCache()
  r.clearAllCaches()
}
const names = () => r.getModCommands().map((command) => command.name)
const append = (path, text) =>
  `await $.fs.write(${JSON.stringify(path)},(await $.fs.read(${JSON.stringify(path)}))+${JSON.stringify(text + '\n')});`
function plugin(name, source, extra = {}) {
  const path = join(root, name)
  write(join(path, '.claude-plugin/plugin.json'), {
    name,
    version: '1.0.0',
    ...extra,
  })
  write(join(path, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(join(path, 'hooks/register.ts'), source)
  return path
}
const serve = (name) =>
  `on('command.run',{command:${JSON.stringify(name)}},async()=>({text:${JSON.stringify(name + '-response')}}));`
const register = (name) =>
  `await $.command.register({name:${JSON.stringify(name)},description:'Startup command'});`
async function answer(name) {
  const command = r.getModCommands().find((command) => command.name === name)
  assert.ok(command, `Missing /${name}`)
  return (
    await (
      await command.load()
    ).call('', { abortController: new AbortController() })
  ).value
}
afterEach(async () => {
  await r.stopPluginMods()
  r.setInlinePlugins([])
  reset()
})
after(() => {
  process.chdir(original)
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

test('session.start is one dependency-ordered middleware chain and both mods register commands', async () => {
  const trace = 'ordered-start.txt'
  write(join(project, trace), '')
  const core = plugin(
    'startup-core',
    `export function register(on){
    on('session.start',async($,e,next)=>{${append(trace, 'core-before')}${register('core-command')}const result=await next(e);${append(trace, 'core-after')}return result;});${serve('core-command')}}`,
  )
  const wrapper = plugin(
    'startup-wrapper',
    `export function register(on){
    on('session.start',async($,e,next)=>{${append(trace, 'wrapper-before')}${register('wrapper-command')}const commands=await $.command.list();if(!commands.some(c=>c.name==='wrapper-command'))throw new Error('Startup registration missing from private inventory');const result=await next(e);${append(trace, 'wrapper-after')}return result;});${serve('wrapper-command')}}`,
    { dependencies: ['startup-core'] },
  )
  // Deliberately discover the dependency first; its dependent must wrap it.
  r.setInlinePlugins([core, wrapper])
  reset()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  assert.equal(
    readFileSync(join(project, trace), 'utf8'),
    'wrapper-before\ncore-before\ncore-after\nwrapper-after\n',
  )
  assert.deepEqual(names().sort(), ['core-command', 'wrapper-command'])
  assert.equal(await answer('core-command'), 'core-command-response')
  assert.equal(await answer('wrapper-command'), 'wrapper-command-response')
})

test('a session.start answer without next suppresses later startup callbacks', async () => {
  const core = plugin(
    'suppressed-core',
    `export function register(on){on('session.start',async($,e,next)=>{await $.fs.write('must-not-start.txt','ran');${register('suppressed-command')}return next(e);});${serve('suppressed-command')}}`,
  )
  const wrapper = plugin(
    'suppressing-wrapper',
    `export function register(on){on('session.start',async($,e)=>{${register('outer-command')}return {cwd:e.cwd};});${serve('outer-command')}}`,
    { dependencies: ['suppressed-core'] },
  )
  r.setInlinePlugins([core, wrapper])
  reset()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  assert.equal(existsSync(join(project, 'must-not-start.txt')), false)
  assert.deepEqual(names(), ['outer-command'])
  assert.equal(await answer('outer-command'), 'outer-command-response')
})

test('startup command reservations protect builtins and commands already owned by another mod', async () => {
  const second = plugin(
    'collision-second',
    `export function register(on){on('session.start',async($,e,next)=>{
      let duplicate=false,builtin=false;try{${register('shared-startup-command')}}catch{duplicate=true}
      try{${register('help')}}catch{builtin=true}
      await $.fs.write('startup-collisions.json',JSON.stringify({duplicate,builtin}));
      ${register('second-owned-command')}return next(e)});${serve('second-owned-command')}}`,
  )
  const first = plugin(
    'collision-first',
    `export function register(on){on('session.start',async($,e,next)=>{${register('shared-startup-command')}return next(e)});${serve('shared-startup-command')}}`,
    { dependencies: ['collision-second'] },
  )
  r.setInlinePlugins([second, first])
  reset()
  await r.startPluginMods(true)
  assert.deepEqual(r.getModWarnings(), [])
  assert.deepEqual(
    JSON.parse(readFileSync(join(project, 'startup-collisions.json'), 'utf8')),
    { duplicate: true, builtin: true },
  )
  assert.deepEqual(names().sort(), [
    'second-owned-command',
    'shared-startup-command',
  ])
  assert.equal(
    await answer('shared-startup-command'),
    'shared-startup-command-response',
  )
  assert.equal(
    await answer('second-owned-command'),
    'second-owned-command-response',
  )
})

test('multiple module entries keep separate command maps and an invalid entry does not discard valid siblings', async () => {
  const path = plugin(
    'entry-owner',
    `export function register(on){on('session.start',async($,e,next)=>{${register('entry-first')}return next(e)});${serve('entry-first')}}`,
    { hooks: ['./extra-hooks.json', './invalid-hooks.json'] },
  )
  write(join(path, 'extra-hooks.json'), { modules: ['./extra.ts'] })
  write(
    join(path, 'extra.ts'),
    `export function register(on){on('session.start',async($,e,next)=>{${register('entry-second')}return next(e)});${serve('entry-second')}}`,
  )
  write(join(path, 'invalid-hooks.json'), { modules: ['./invalid.ts'] })
  write(
    join(path, 'invalid.ts'),
    `throw new Error('invalid sibling');export function register(on){}`,
  )
  r.setInlinePlugins([path])
  reset()
  await r.startPluginMods(true)
  assert.deepEqual(names().sort(), ['entry-first', 'entry-second'])
  assert.equal(await answer('entry-first'), 'entry-first-response')
  assert.equal(await answer('entry-second'), 'entry-second-response')
  assert.equal(r.getModWarnings().length, 1)
  assert.match(r.getModWarnings()[0], /invalid sibling/)
})

test('new startup commands remain private until the whole replacement snapshot is ready', async () => {
  const old = plugin(
    'previous-owner',
    `export function register(on){on('session.start',async($,e,next)=>{${register('previous-command')}return next(e)});${serve('previous-command')}}`,
  )
  r.setInlinePlugins([old])
  reset()
  await r.startPluginMods(true)
  const next = plugin(
    'pending-owner',
    `export function register(on){on('session.start',async($,e,next)=>{${register('pending-command')}await $.fs.write('startup-paused.txt','paused');await $.clock.sleep(250);return next(e)});${serve('pending-command')}}`,
  )
  r.setInlinePlugins([next])
  reset()
  const published = []
  const unsubscribe = r.skillChangeDetector.subscribe(() =>
    published.push(names()),
  )
  try {
    const startup = r.startPluginMods(true)
    const deadline = Date.now() + 5000
    while (
      !existsSync(join(project, 'startup-paused.txt')) &&
      Date.now() < deadline
    )
      await delay(10)
    assert.ok(
      existsSync(join(project, 'startup-paused.txt')),
      'Startup did not reach its pause',
    )
    assert.deepEqual(names(), ['previous-command'])
    assert.deepEqual(published, [])
    await startup
    assert.deepEqual(names(), ['pending-command'])
    assert.deepEqual(published, [['pending-command']])
    assert.equal(await answer('pending-command'), 'pending-command-response')
  } finally {
    unsubscribe()
  }
})
