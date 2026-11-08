// A mod a person installs (the user tier): the API battery (/lab-api), the
// lab's shared counter in $.state (/lab-state), sound (/lab-audio), questions,
// notifications and toasts, a ticking status line, every classic.* event it
// saw, and a note under the permission dialog of a Bash call.
import { atom, derive, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const COUNT = atom({ plugin: 'lab-app', key: 'count' }, 0)
const DOUBLE = derive([COUNT], (n: number) => n * 2)
const classicSeen = new Set<string>()
let ticks = 0

type Check = { name: string; ok: boolean; detail: string }
const short = (value: unknown) => {
  let text: string
  try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { text = String(value) }
  return text === undefined ? 'undefined' : text.length > 160 ? text.slice(0, 157) + '...' : text
}
const reason = (error: unknown) => String(error && (error as Error).message !== undefined ? (error as Error).message : error)

/** Every API a mod reaches, checked; written to .lab/api.json. */
async function battery($, offline: boolean): Promise<Check[]> {
  const out: Check[] = []
  const check = async (name: string, run: () => Promise<[boolean, unknown]>) => {
    try {
      const [ok, detail] = await run()
      out.push({ name, ok, detail: short(detail) })
    } catch (error) {
      out.push({ name, ok: false, detail: 'threw: ' + reason(error) })
    }
  }
  await check('session.version answers the Claude Code contract, 2.1.319', async () => {
    const version = await $.session.version()
    return [version.version === '2.1.319' && version.base === '2.1.319' && typeof version.tau === 'string', version]
  })
  await check('$.state: versions and compare-and-set; only the owner writes', async () => {
    const ref = { plugin: 'lab-app', key: 'probe' }
    const before = await $.state.get(ref)
    const landed = await $.state.set(ref, 'one', { ifVersion: before.version })
    const missed = await $.state.set(ref, 'two', { ifVersion: before.version })
    let refused = ''
    try { await $.state.set({ plugin: 'lab-ui', key: 'clicks' }, 99) } catch (error) { refused = reason(error) }
    return [landed.isSet && !missed.isSet && /values are its own/.test(refused), { landed, missed }]
  })
  await check('claude-code helpers: atom, derive, read, update', async () => {
    const before = await read($, COUNT)
    const wrote = await update($, COUNT, n => n + 1)
    const doubled = await read($, DOUBLE)
    return [wrote === before + 1 && doubled === wrote * 2, { before, wrote, doubled }]
  })
  await check('web APIs inside the mod realm', async () => {
    const url = new URL('https://example.com/a?b=1')
    url.searchParams.set('lab', 'yes')
    const controller = new AbortController()
    controller.abort('stop')
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'))))
      .map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 8)
    const ok = url.href.endsWith('lab=yes') && controller.signal.aborted && digest === 'ba7816bf' &&
      structuredClone({ a: [1] }).a[0] === 1 && btoa('hi') === 'aGk=' && crypto.randomUUID().length === 36
    return [ok, { href: url.href, digest }]
  })
  await check('engine.create: $.labkit, added by lab-org, runs there', async () => {
    const said = await $.labkit.hello('lab-app')
    return [said === 'hello lab-app from lab-org', said]
  })
  await check('op events: lab-org (above) refuses a write into secret/', async () => {
    let refused = ''
    try { await $.fs.write('secret/blocked.txt', 'no') } catch (error) { refused = reason(error) }
    return [/lab-org keeps secret\/ closed/.test(refused) && !(await $.fs.exists('secret/blocked.txt')), refused]
  })
  await check('fs: write, read, exists, stat, list, ancestors', async () => {
    await $.fs.write('.lab/probe.txt', 'lab probe')
    const text = await $.fs.read('.lab/probe.txt')
    const stat = await $.fs.stat('.lab/probe.txt')
    const list = await $.fs.list('.lab')
    const ancestors = await $.fs.ancestors({ names: ['LAB.md'] })
    return [text === 'lab probe' && (await $.fs.exists('.lab/probe.txt')) && stat.size === 9 && JSON.stringify(list).includes('probe.txt'),
      { size: stat.size, labMd: Array.isArray(ancestors) ? ancestors.length : ancestors }]
  })
  await check('store: set, get, keys, delete', async () => {
    await $.store.set('lab', { at: 1 })
    const got = await $.store.get('lab')
    const keys = await $.store.keys()
    await $.store.delete('lab')
    return [got.at === 1 && keys.includes('lab') && (await $.store.get('lab')) === undefined, keys]
  })
  await check('clock: now and sleep', async () => {
    const start = await $.clock.now()
    await $.clock.sleep(50)
    const end = await $.clock.now()
    return [end - start >= 40, end - start]
  })
  await check('process.run and process.spawn', async () => {
    const run = await $.process.run(['node', '-e', 'process.stdout.write(String(6 * 7))'])
    const spawned = $.process.spawn(['node', '-e', 'console.log("a"); console.log("b")'])
    let streamed = ''
    for await (const chunk of spawned) streamed += chunk.text
    const result = await spawned.result
    return [run.stdout.trim() === '42' && /a\s+b/.test(streamed) && result.exitCode === 0, { run: run.stdout.trim(), streamed: streamed.trim() }]
  })
  await check('http.fetch', async () => {
    const reply = await $.http.fetch(offline ? 'http://lab.invalid/ping' : 'https://example.com/')
    return [reply.status === 200, reply.status]
  })
  await check('model.complete', async () => {
    const reply = await $.model.complete({ model: await $.session.model(), prompt: 'Answer with one word: ready', maxTokens: 20 })
    return [reply.isAnswered === true && typeof reply.text === 'string' && reply.text.length > 0, reply.text ?? reply.reason]
  })
  await check('prompt.compose: lab-stream adds its section; the call skips this mod', async () => {
    const { sections } = await $.prompt.compose()
    const ids = sections.map(section => section.id)
    return [ids.includes('lab-stream:policy') && ids.includes('intro'), ids.slice(-4)]
  })
  await check('telemetry.log: to is anthropic when left out; lab-org sees the record', async () => {
    await $.telemetry.log({ event: 'lab_check', props: { ok: true } })
    const seen = JSON.parse(await $.fs.read('.lab/org-telemetry-lab_check.json'))
    return [seen.to === 'anthropic' && seen.event === 'lab_check', seen]
  })
  await check('telemetry.mark checks its kind', async () => {
    await $.telemetry.mark({ feature: 'lab', kind: 'ok' })
    let refused = ''
    try { await $.telemetry.mark({ feature: 'lab', kind: 'meh' }) } catch (error) { refused = reason(error) }
    return [/kind is 'ok', 'sad' or 'bad'/.test(refused), refused]
  })
  await check('audio.play refuses a path outside the plugin', async () => {
    let refused = ''
    try { await $.audio.play({ asset: '../outside.wav' }) } catch (error) { refused = reason(error) }
    return [/a path inside the plugin/.test(refused), refused]
  })
  await check('session: id, cwd, model, surfaces, usage, repo', async () => {
    const facts = {
      id: await $.session.id(), cwd: await $.session.cwd(), model: await $.session.model(),
      surfaces: await $.session.surfaces(), usage: Object.keys((await $.session.usage()) ?? {}), repo: (await $.session.repo())?.root ?? null,
    }
    return [typeof facts.id === 'string' && typeof facts.cwd === 'string' && Array.isArray(facts.surfaces), facts]
  })
  await check('lists: commands, tools, agents', async () => {
    const commands = await $.command.list()
    const tools = await $.tool.list()
    const agents = await $.agent.list()
    return [commands.some(item => item.name === 'lab-api') && tools.length > 0, { commands: commands.length, tools: tools.length, agents: agents.length }]
  })
  await check('classic.* events seen so far', async () => [classicSeen.size > 0, [...classicSeen].sort()])
  return out
}

/** A small sound, as bytes: a 0.2 s 880 Hz tone at 8 kHz. */
function toneBase64(): string {
  const rate = 8000, samples = 1600
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i) }
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / rate * 2 * Math.PI * 880) * 8000), true)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const [name, description] of [
      ['lab-api', 'Mod lab: run every API check (writes .lab/api.json)'],
      ['lab-state', 'Mod lab: add one to the shared counter ($.state); the band redraws'],
      ['lab-audio', 'Mod lab: play a chime, bytes and a loop, then speak'],
      ['lab-ask', 'Mod lab: ask a question with $.ui.ask'],
      ['lab-notify', 'Mod lab: send a terminal notification'],
      ['lab-toast', 'Mod lab: show a toast'],
    ]) await $.command.register({ name, description })
    $.clock.every(1000, async () => {
      ticks++
      $.ui.status('ticks ' + ticks + ' · count ' + (await read($, COUNT)))
    })
    $.ui.toast('loaded at session.start', { timeoutMs: 6000 })
    return next(e)
  })

  // A link of the user tier in every turn's chain (lab-org's next.trace shows it).
  on('turn.start', async ($, e, next) => next(e))

  // Every settings hook event, as classic.<Event>.
  on('classic.*', async ($, e, next) => {
    classicSeen.add(String(e.hook_event_name ?? next.event))
    return next(e)
  })

  // A note under the permission dialog of a Bash call.
  on('tool.check', async ($, e, next) => {
    if (e.tool === 'Bash' && e.tool_use_id) $.ui.notice(e.tool_use_id, 'lab-app: this note sits under the dialog ($.ui.notice)')
    return next(e)
  })

  // lab-org jumps past this tier for /lab-skip: this must never run.
  on('command.run', { command: 'lab-skip' }, async ($, e, next) => {
    await $.fs.write('.lab/app-skip.json', JSON.stringify('lab-app ran for /lab-skip: next.to did not skip the user tier'))
    return next(e)
  })

  on('command.run', { command: 'lab-api' }, async ($, e) => {
    const checks = await battery($, (await $.env.get('TAU_LAB_OFFLINE')) === '1')
    await $.fs.write('.lab/api.json', JSON.stringify(checks, null, 2))
    const passed = checks.filter(item => item.ok).length
    return { text: ['lab-api: ' + passed + '/' + checks.length + ' passed', ...checks.map(item => (item.ok ? 'PASS ' : 'FAIL ') + item.name + ' - ' + item.detail)].join('\n') }
  })

  on('command.run', { command: 'lab-state' }, async ($, e) => {
    const now = await update($, COUNT, n => n + 1)
    return { text: 'lab-app: count is ' + now + ' (the band reads it and redraws by itself)' }
  })

  on('command.run', { command: 'lab-audio' }, async ($, e) => {
    const out: Record<string, string> = {}
    const step = async (name: string, run: () => Promise<unknown>) => {
      try {
        const value = await run()
        out[name] = value === undefined ? 'played' : short(value)
      } catch (error) { out[name] = 'failed: ' + reason(error) }
    }
    await step('chime (the plugin\'s file)', () => $.audio.play({ asset: 'sounds/chime.wav' }))
    await step('tone (bytes)', () => $.audio.play({ base64: toneBase64(), mime: 'audio/wav' }, { gain: 0.5 }))
    await step('loop, stopped after 1.5 s', async () => {
      const stop = new AbortController()
      const playing = $.audio.play({ asset: 'sounds/chime.wav' }, { shouldLoop: true, signal: stop.signal })
      await $.clock.sleep(1500)
      stop.abort()
      await playing
      return 'stopped'
    })
    await step('speech', () => $.audio.speak('Tau mod lab'))
    await $.fs.write('.lab/audio.json', JSON.stringify(out, null, 2))
    return { text: 'lab-audio: ' + Object.entries(out).map(([name, result]) => name + ': ' + result).join(' | ') }
  })

  on('command.run', { command: 'lab-ask' }, async ($, e) => {
    const answer = await $.ui.ask('Lab question: which one?', ['Alpha', 'Beta'])
    return { text: 'lab-ask: you picked ' + short(answer) }
  })

  on('command.run', { command: 'lab-notify' }, async ($, e) => {
    const sent = await $.ui.notify('Notification from the mod lab', { title: 'Tau mod lab' })
    return { text: 'lab-notify: ' + short(sent) }
  })

  on('command.run', { command: 'lab-toast' }, async ($, e) => {
    $.ui.toast('a toast from /lab-toast', { timeoutMs: 8000 })
    return { text: 'lab-toast: sent (a pane opened with holdToasts keeps it back until it is not shown)' }
  })
}
