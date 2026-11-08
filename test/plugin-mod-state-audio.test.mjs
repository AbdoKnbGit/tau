import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// $.state and the claude-code library's helpers, the realm's web APIs,
// $.audio (through a stand-in player: these tests never make a sound),
// the telemetry events and their collector rule, and prompt.compose.
const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-state-')), project = join(root, 'project')
const config = join(root, 'config')
mkdirSync(project)
const player = join(root, 'player.cjs'), played = join(root, 'played.jsonl')
writeFileSync(player, `const fs = require('fs')
const [kind, a, b] = process.argv.slice(2)
let input = ''
const done = () => {
  const entry = kind === 'play'
    ? { kind, file: a, gain: Number(b), exists: fs.existsSync(a), bytes: fs.existsSync(a) ? fs.readFileSync(a).length : 0 }
    : { kind, voice: a, text: input }
  fs.appendFileSync(process.env.TAU_TEST_PLAYED, JSON.stringify(entry) + '\\n')
  if (kind === 'speak' && a === 'missing') { process.stderr.write('voice missing is not installed'); process.exit(3) }
  setTimeout(() => process.exit(0), 40)
}
if (kind === 'speak') { process.stdin.setEncoding('utf8'); process.stdin.on('data', c => { input += c }); process.stdin.on('end', done) } else done()
`)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
  TAU_TEST_NODE: process.execPath,
  TAU_TEST_AUDIO_COMMAND: JSON.stringify([process.execPath, player]),
  TAU_TEST_PLAYED: played,
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/manager.ts', 'src/utils/plugins/mods/sessionState.ts',
    'src/utils/plugins/mods/compiler.ts', 'src/utils/plugins/mods/runtime.ts', 'src/utils/plugins/mods/uiState.ts'],
  exports: ['startPluginMods', 'stopPluginMods', 'endPluginMods', 'dispatchModEvent', 'getModWarnings',
    'setInlinePlugins', 'resetSettingsCache', 'clearAllCaches', 'setOriginalCwd', 'setSessionTrustAccepted',
    'setAllowedSettingSources', 'setIsInteractive', 'getManagedFilePath', 'updateHooksConfigSnapshot',
    'bindModSession', 'requestModSite', 'getModSite', 'dispatchModCollectorRecord', 'composeSystemPrompt'],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)

let serial = 0, closeSession
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)) }
const readJson = name => existsSync(join(project, name)) ? JSON.parse(readFileSync(join(project, name), 'utf8')) : undefined
const until = async (check, what, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.fail(`timed out waiting for ${what}`)
}
/** Loads mods from whole module sources (NAME reads as the plugin's own
 * name); `prepend` lists the ones a person's settings seat first. */
async function loadMods(definitions, { prepend = [], allowWarnings = false, files = {} } = {}) {
  const run = ++serial
  const names = Object.fromEntries(Object.keys(definitions).map(name => [name, `${name}-${run}`]))
  const paths = Object.entries(definitions).map(([name, source]) => {
    const path = join(root, names[name])
    write(join(path, '.claude-plugin/plugin.json'), { name: names[name], version: '1.0.0' })
    write(join(path, 'hooks/hooks.json'), { modules: ['./register.ts'] })
    write(join(path, 'hooks/register.ts'), source.replaceAll('NAME', names[name]))
    for (const [file, content] of Object.entries(files[name] ?? {})) write(join(path, file), content)
    return path
  })
  write(join(config, 'settings.json'), { prependPlugins: prepend.map(name => `${names[name]}@inline`) })
  r.setInlinePlugins(paths); r.resetSettingsCache(); r.clearAllCaches(); r.updateHooksConfigSnapshot()
  await r.startPluginMods(true)
  if (!allowWarnings) assert.deepEqual(r.getModWarnings(), [])
  return names
}
const hook = body => `export function register(on) { ${body} }`
const turn = () => r.dispatchModEvent('turn.start', { turnId: `t${++serial}` }, async e => ({ turnId: e.turnId }))
afterEach(async () => { closeSession?.(); closeSession = undefined; await r.stopPluginMods() })
after(async () => { await r.stopPluginMods(); process.chdir(original); rmSync(root, { recursive: true, force: true, maxRetries: 10 }) })

test('$.state: versions, compare-and-set, the owner alone writes, and a hook above sees previous and rewrites the value', async () => {
  await loadMods({
    guard: hook(`on('state.set', async ($, e, next) => {
      await $.fs.write('guard-' + e.value + '.json', JSON.stringify({ previous: e.previous ?? null, ifVersion: e.ifVersion ?? null }))
      return next({ ...e, value: typeof e.value === 'number' ? e.value * 10 : e.value })
    })`),
    counter: hook(`on('turn.start', async ($, e, next) => {
      const ref = { plugin: 'NAME', key: 'count' }
      const first = await $.state.get(ref)
      const a = await $.state.set(ref, 1)
      const b = await $.state.set(ref, 2, { ifVersion: 0 })
      const c = await $.state.set(ref, 3, { ifVersion: 1 })
      const now = await $.state.get(ref)
      let other, empty
      try { await $.state.set({ plugin: 'someone-else', key: 'x' }, 1) } catch (error) { other = error.message }
      try { await $.state.set(ref, undefined) } catch (error) { empty = error.message }
      await $.fs.write('counter.json', JSON.stringify({ first, a, b, c, now, other, empty }))
      return next(e)
    })`),
  }, { prepend: ['guard'] })
  await turn()
  const seen = readJson('counter.json')
  assert.deepEqual(seen.first, { version: 0 })
  assert.deepEqual(seen.a, { isSet: true, version: 1 })
  assert.deepEqual(seen.b, { isSet: false, version: 1 })
  assert.deepEqual(seen.c, { isSet: true, version: 2 })
  assert.deepEqual(seen.now, { value: 30, version: 2 })
  assert.match(seen.other, /someone-else's values are its own; hook its state\.set and rewrite e\.value/)
  assert.match(seen.empty, /JSON data/)
  assert.deepEqual(readJson('guard-1.json'), { previous: null, ifVersion: null })
  assert.deepEqual(readJson('guard-2.json'), { previous: 10, ifVersion: 0 })
  assert.deepEqual(readJson('guard-3.json'), { previous: 10, ifVersion: 1 })
})

test('a drawing that reads $.state is drawn again when the value is written; a write while drawing is refused', async () => {
  await loadMods({
    band: hook(`
      on('ui.render', async ($, e) => {
        const { Text } = $.ui.resolve(e)
        const { value = 0 } = await $.state.get({ plugin: 'NAME', key: 'n' })
        try { await $.state.set({ plugin: 'NAME', key: 'n' }, 99) } catch (error) { await $.fs.write('render-set.json', JSON.stringify(error.message)) }
        return h(Text, null, 'n=' + value)
      })
      on('turn.start', async ($, e, next) => { await $.state.set({ plugin: 'NAME', key: 'n' }, 7); return next(e) })`),
  })
  const input = { component: 'AbovePrompt', requestId: 'AbovePrompt', props: {} }
  r.requestModSite('AbovePrompt', input)
  await until(() => JSON.stringify(r.getModSite('AbovePrompt')?.tree ?? null).includes('n=0'), 'the first drawing')
  assert.match(readJson('render-set.json'), /refused while a ui\.render hook draws/)
  await turn()
  assert.equal(r.getModSite('AbovePrompt').stale, true, 'the write marks the site that read it')
  await until(() => {
    r.requestModSite('AbovePrompt', input)
    return JSON.stringify(r.getModSite('AbovePrompt')?.tree ?? null).includes('n=7')
  }, 'the drawing after the write')
})

test('the claude-code library: atom, derive, memberOf, read and update (shaped values, concurrent writes), and uses.state', async () => {
  const names = await loadMods({
    judge: hook(`on('plugin.register', async ($, e, next) => {
      await $.fs.write('uses-' + e.name + '.json', JSON.stringify(e.uses))
      return next(e)
    })`),
    lib: `import { atom, derive, memberOf, read, update } from 'claude-code'
import * as cc from 'claude-code'
import type { Register } from 'claude-code'
const count = atom({ plugin: 'NAME', key: 'n' }, 5)
const flag = atom({ plugin: 'NAME', key: 'flag' }, false, { shape: 'v2' })
const rows = { plugin: 'NAME', key: 'row' } as const
let computed = 0
const doubled = derive([count], (n: number) => { computed++; return n * 2 })
export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    const before = await read($, count)
    const d1 = await read($, doubled)
    const d2 = await read($, doubled)
    const results = await Promise.all([update($, count, n => n + 1), update($, count, n => n + 1), cc.update($, count, n => n + 1)])
    const after = await read($, count)
    const d3 = await read($, doubled)
    await update($, flag, () => true)
    const raw = await $.state.get(flag.ref)
    const member = memberOf(atom(rows, 'none'), { requestId: 'r7' })
    const unset = await read($, member)
    await update($, member, () => 'seven')
    const plain = await read($, { plugin: 'NAME', key: 'nothing' })
    await $.fs.write('lib.json', JSON.stringify({ before, d1, d2, results: [...results].sort(), after, d3, computed, raw, unset,
      member: await read($, member), plain: plain === undefined, memberRef: member.ref }))
    return next(e)
  })
}`,
  }, { prepend: ['judge'] })
  await turn()
  const seen = readJson('lib.json')
  assert.equal(seen.before, 5)
  assert.equal(seen.d1, 10)
  assert.equal(seen.d2, 10)
  assert.deepEqual(seen.results, [6, 7, 8], 'three updates racing on one value all land')
  assert.equal(seen.after, 8)
  assert.equal(seen.d3, 16)
  assert.equal(seen.computed, 2, 'a derived value computes again only when a source moved')
  assert.deepEqual(seen.raw, { value: { shape: 'v2', value: true }, version: 1 })
  assert.equal(seen.unset, 'none')
  assert.equal(seen.member, 'seven')
  assert.equal(seen.plain, true)
  assert.deepEqual(seen.memberRef, { plugin: names.lib, key: 'row', id: 'r7' })
  const uses = readJson(`uses-${names.lib}.json`)
  assert.deepEqual(uses.state, {
    reads: [{ plugin: names.lib, key: 'flag' }, { plugin: names.lib, key: 'n' }, { plugin: names.lib, key: 'nothing' }],
    writes: [{ plugin: names.lib, key: 'flag' }, { plugin: names.lib, key: 'n' }],
  })
  assert.ok(uses.calls.includes('state.get') && uses.calls.includes('state.set'))
})

test('a value import claude-code does not have refuses the module, and the state helpers stay unaliasable', async () => {
  await loadMods({ bad: `import { frobnicate } from 'claude-code'\n${hook('')}` }, { allowWarnings: true })
  assert.ok(r.getModWarnings().some(text => /claude-code has no value frobnicate/.test(text)), r.getModWarnings().join('\n'))
})

test('a hooks module has the web APIs its realm promises, built inside the realm', async () => {
  await loadMods({
    web: hook(`on('turn.start', async ($, e, next) => {
      const url = new URL('https://example.com/a?b=1')
      url.searchParams.set('c', 'two words')
      const controller = new AbortController()
      controller.abort('stop')
      const any = AbortSignal.any([new AbortController().signal, controller.signal])
      const bytes = new TextEncoder().encode('h\\u00e9llo')
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'))))
        .map(x => x.toString(16).padStart(2, '0')).join('')
      let escape
      try { escape = URL.constructor('return 1')() } catch (error) { escape = error.name }
      await $.fs.write('web.json', JSON.stringify({
        href: url.href, aborted: controller.signal.aborted, reason: controller.signal.reason, any: any.reason,
        length: bytes.length, text: new TextDecoder().decode(bytes), digest: digest.slice(0, 16),
        uuid: crypto.randomUUID().length, clone: structuredClone({ a: [1, { b: new Date(0) }] }), b64: btoa('hi'),
        params: new URLSearchParams({ q: 'a&b' }).toString(), now: typeof performance.now(), escape,
      }))
      return next(e)
    })`),
  })
  await turn()
  const seen = readJson('web.json')
  assert.equal(seen.href, 'https://example.com/a?b=1&c=two+words')
  assert.equal(seen.aborted, true)
  assert.equal(seen.reason, 'stop')
  assert.equal(seen.any, 'stop')
  assert.equal(seen.length, 6)
  assert.equal(seen.text, 'héllo')
  assert.equal(seen.digest, 'ba7816bf8f01cfea')
  assert.equal(seen.uuid, 36)
  assert.deepEqual(seen.clone, { a: [1, { b: '1970-01-01T00:00:00.000Z' }] })
  assert.equal(seen.b64, 'aGk=')
  assert.equal(seen.params, 'q=a%26b')
  assert.equal(seen.now, 'number')
  assert.equal(seen.escape, 'EvalError', 'the realm offers no way to the host\'s Function')
})

test('$.audio.play plays the plugin\'s asset, bytes and loops through the platform player; speak queues utterances', async () => {
  writeFileSync(played, '')
  await loadMods({
    sound: hook(`on('turn.start', async ($, e, next) => {
      const out = {}
      await $.audio.play({ asset: 'sounds/ding.wav' }, { gain: 0.5 })
      for (const [name, clip, options] of [
        ['escape', { asset: '../escape.wav' }], ['missing', { asset: 'sounds/none.wav' }],
        ['gain', { asset: 'sounds/ding.wav' }, { gain: 9 }], ['two', { asset: 'sounds/ding.wav', url: 'https://x' }],
        ['mime', { base64: 'AAAA', mime: 'text/plain' }], ['loopNoSignal', { asset: 'sounds/ding.wav' }, { shouldLoop: true }],
      ]) {
        try { await $.audio.play(clip, options); out[name] = 'played' } catch (error) { out[name] = error.message }
      }
      await $.audio.play({ base64: btoa('RIFFdata'), mime: 'audio/wav' })
      const stop = new AbortController()
      const started = Date.now()
      const looping = $.audio.play({ asset: 'sounds/ding.wav' }, { shouldLoop: true, signal: stop.signal })
      await $.clock.sleep(1500)
      stop.abort()
      await looping
      out.loopMs = Date.now() - started
      out.spoke = await Promise.all([$.audio.speak('first'), $.audio.speak('second', { voice: 'Samantha' })])
      try { await $.audio.speak('x', { voice: 'missing' }) } catch (error) { out.voice = error.message }
      await $.fs.write('audio.json', JSON.stringify(out))
      return next(e)
    })`),
  }, { files: { sound: { 'sounds/ding.wav': 'RIFF....WAVEfmt ' } } })
  await turn()
  const seen = readJson('audio.json')
  assert.match(seen.escape, /a path inside the plugin/)
  assert.match(seen.missing, /has no file sounds\/none\.wav/)
  assert.match(seen.gain, /gain is a number from 0 to 4/)
  assert.match(seen.two, /takes one clip/)
  assert.match(seen.mime, /text\/plain is not an audio type/)
  assert.match(seen.loopNoSignal, /needs the signal that ends it/)
  assert.ok(seen.loopMs < 3000, `the loop stopped when its signal aborted (${seen.loopMs} ms)`)
  assert.deepEqual(seen.spoke, [{ via: 'system' }, { via: 'system' }])
  assert.match(seen.voice, /voice missing is not installed/)
  const entries = readFileSync(played, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const plays = entries.filter(item => item.kind === 'play')
  assert.ok(plays[0].file.endsWith(join('sounds', 'ding.wav')) && plays[0].gain === 0.5 && plays[0].exists)
  const bytes = plays.find(item => /tau-audio-/.test(item.file))
  assert.ok(bytes && bytes.exists && bytes.bytes === 8, 'the bytes were a file while they played')
  assert.equal(existsSync(bytes.file), false, 'and the file is gone after')
  assert.ok(plays.filter(item => item.file.endsWith('ding.wav')).length >= 3, 'the loop played the clip again')
  assert.deepEqual(entries.filter(item => item.kind === 'speak').map(({ voice, text }) => [voice, text]),
    [['', 'first'], ['Samantha', 'second'], ['missing', 'x']], 'utterances in the order they were asked for')
})

test('telemetry: to is pinned (anthropic when left out), a mark is checked, and a mod a person installs sees only the collector stream', async () => {
  const names = await loadMods({
    org: hook(`on('telemetry.log', async ($, e, next) => {
      await $.fs.write('org-' + e.event + '.json', JSON.stringify(e))
      if (e.event === 'redirect') return next({ ...e, to: 'collector' })
      return next(e)
    })`),
    peek: hook(`on('telemetry.log', async ($, e, next) => { await $.fs.write('peek.json', '1'); return next(e) })`),
    collector: hook(`on('telemetry.log', { to: 'collector' }, async ($, e, next) => {
      if (e.event === 'secret') return { deny: 'not that one' }
      return next({ ...e, attributes: { ...e.attributes, user: 'redacted', bad: { nested: true } } })
    })`),
    caller: hook(`on('turn.start', async ($, e, next) => {
      const out = {}
      await $.telemetry.log({ event: 'survey', props: { answer: 2 } })
      try { await $.telemetry.log({ event: 'redirect' }) } catch (error) { out.redirect = error.message }
      try { await $.telemetry.mark({ feature: 'pane', kind: 'meh' }) } catch (error) { out.mark = error.message }
      await $.telemetry.mark({ feature: 'pane', kind: 'ok' })
      await $.fs.write('caller.json', JSON.stringify(out))
      return next(e)
    })`),
  }, { prepend: ['org'], allowWarnings: true })
  assert.deepEqual(r.getModWarnings().filter(text => /telemetry/.test(text)),
    [`${names.peek}: telemetry.log hook skipped: in a mod a person installs, a telemetry hook takes the filter { to: 'collector' }, as in on('telemetry.log', { to: 'collector' }, hook)`])
  await turn()
  assert.deepEqual(readJson('org-survey.json'), { event: 'survey', props: { answer: 2 }, to: 'anthropic' })
  assert.equal(readJson('caller.json').redirect, undefined, 'a hook whose rewrite is refused is skipped; the record goes on')
  assert.ok(r.getModWarnings().some(text => text === `${names.org}: telemetry.log hook skipped: telemetry.log cannot rewrite to`), r.getModWarnings().join('\n'))
  assert.match(readJson('caller.json').mark, /kind is 'ok', 'sad' or 'bad'/)
  assert.equal(readJson('peek.json'), undefined, 'the unfiltered hook never ran')
  // The engine's own collector records pass the hooks before they leave.
  const sent = await r.dispatchModCollectorRecord('user_prompt', { user: 'alice', length: 3, 'event.timestamp': '2026-11-07T00:00:00.000Z' })
  assert.deepEqual(sent, { user: 'redacted', length: 3, 'event.timestamp': '2026-11-07T00:00:00.000Z' })
  assert.equal(await r.dispatchModCollectorRecord('secret', { a: 1 }), undefined, 'a refused record is not sent')
})

test('prompt.compose: no hook leaves the prompt as the engine composed it; hooks drop, add and reorder sections; $.prompt.compose', async () => {
  const tools = [], model = 'claude-sonnet-4-5'
  const engine = await r.composeSystemPrompt(tools, model)
  const ids = engine.sections.map(section => section.id)
  assert.ok(ids.includes('intro') && ids.includes('tone'), ids.join(','))
  assert.ok(engine.sections.every((section, index, all) => section.scope === 'session' || all.slice(0, index).every(item => item.scope === 'shared')))
  const names = await loadMods({
    pass: hook(`on('prompt.compose', async ($, e, next) => next(e))`),
  })
  assert.deepEqual((await r.composeSystemPrompt(tools, model)).entries, engine.entries, 'a hook that passes changes nothing')
  await r.stopPluginMods()
  const edited = await loadMods({
    edit: hook(`on('prompt.compose', async ($, e, next) => {
      const { sections } = await next(e)
      await $.fs.write('compose-input.json', JSON.stringify(e))
      return { sections: [...sections.filter(s => s.id !== 'tone'), { id: 'NAME:policy', text: 'POLICY TEXT', scope: 'session' }] }
    })`),
    wrong: hook(`on('prompt.compose', async ($, e, next) => {
      const { sections } = await next(e)
      return { sections: [...sections, { id: 'late', text: 'LATE', scope: 'shared' }] }
    })`),
    asker: hook(`on('turn.start', async ($, e, next) => {
      const { sections } = await $.prompt.compose({ tools: [] })
      await $.fs.write('asked.json', JSON.stringify(sections.map(s => s.id)))
      return next(e)
    })
    on('prompt.compose', async ($, e, next) => { await $.fs.write('asker-own.json', '1'); return next(e) })`),
  }, { allowWarnings: true })
  const composed = await r.composeSystemPrompt(tools, model)
  assert.ok(r.getModWarnings().some(text => text.startsWith(`${edited.wrong}: prompt.compose hook skipped`) && /shared section after a session one/.test(text)))
  const tone = engine.sections.find(section => section.id === 'tone').text
  assert.equal(composed.entries.includes(tone), false, 'the dropped section is not sent')
  assert.equal(composed.entries.at(-1), 'POLICY TEXT')
  assert.equal(composed.entries.includes('LATE'), false)
  const marker = engine.entries.findIndex(entry => entry === '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  if (marker >= 0) assert.ok(composed.entries.includes('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'), 'the cache boundary stays between the sides')
  const input = readJson('compose-input.json')
  assert.equal(input.model, model)
  assert.deepEqual(input.tools, [])
  assert.ok(Array.isArray(input.traits) && input.traits.includes('print'))
  // A mod's own call: through every other mod's hook, its own skipped.
  closeSession = r.bindModSession({
    getMessages: () => [], getModel: () => model,
    getCompactContext: () => ({
      options: { tools: [], mainLoopModel: model, mcpClients: [] },
      getAppState: () => ({ toolPermissionContext: { additionalWorkingDirectories: new Map() } }),
    }),
  })
  rmSync(join(project, 'asker-own.json'), { force: true })
  await turn()
  const asked = readJson('asked.json')
  assert.ok(asked.includes(`${edited.edit}:policy`) && !asked.includes('tone'), asked.join(','))
  assert.equal(readJson('asker-own.json'), undefined, 'the caller\'s own prompt.compose hook is skipped')
  void names
})
