// The mod lab: every feature of the three mod rounds, end to end, in the real
// CLI in a real terminal. Offline by default: a scripted model, a throwaway
// folder with its own home, config and fake sign-in. --play opens the same lab
// in your own terminal, to try everything by hand. See README.md.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createLab } from './lib/sandbox.mjs'
import { startTerminal } from './lib/terminal.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
const cli = resolve(option('--cli') ?? join(repo, 'dist', 'cli.mjs'))

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(join(here, 'README.md'), 'utf8').split('\n## ')[0])
  process.exit(0)
}
if (!existsSync(cli)) {
  console.error(`No Tau build at ${cli}.\nBuild first (npm run build), or pass --cli <path to a cli.mjs>.`)
  process.exit(2)
}

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
const readText = path => { try { return readFileSync(path, 'utf8') } catch { return undefined } }

if (flag('--play')) await play()
else await endToEnd()

/** The lab in your own terminal: the same mods, folder and checks, by hand. */
async function play() {
  const provider = option('--provider')
  const lab = createLab({ root: join(here, 'play'), offline: !provider, provider, model: option('--model') })
  const debugFile = join(lab.root, 'debug.txt')
  console.log([
    '',
    'Mod lab, by hand',
    `  Tau:        ${cli}`,
    `  Workspace:  ${lab.workspace}`,
    `  Model:      ${provider ? `your ${provider} sign-in${option('--model') ? `, ${option('--model')}` : ''} (uses your quota)` : 'the lab\'s scripted model (offline, free)'}`,
    '  Mods:       lab-org (prepend tier), lab-app, lab-ui, lab-stream (user tier), lab-tail (append tier), lab-refused (refused)',
    '',
    '  Follow the checklist in labs/mods/README.md. Start with /lab-api, then /lab-pane.',
    '  What the mods record lands in workspace/.lab/, and a summary prints when you leave.',
    '',
  ].join('\n'))
  const child = spawn(process.execPath, [cli, ...lab.args, '--debug-file', debugFile], { cwd: lab.workspace, env: lab.env, stdio: 'inherit' })
  await new Promise(done => child.on('exit', done))
  summarize(lab, debugFile)
}

function summarize(lab, debugFile) {
  const dir = join(lab.workspace, '.lab')
  console.log('\nWhat the mods recorded (workspace/.lab):')
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) console.log('  ' + name)
  const api = readJson(join(dir, 'api.json'))
  if (api) console.log(`\n/lab-api: ${api.filter(item => item.ok).length}/${api.length} passed` +
    api.filter(item => !item.ok).map(item => `\n  FAIL ${item.name}: ${item.detail}`).join(''))
  const warnings = (readText(debugFile) ?? '').split('\n').filter(line => /refused by|did not load|hook skipped|catch failed/.test(line))
  if (warnings.length) console.log('\nMod warnings from the debug log:\n' + warnings.map(line => '  ' + line.replace(/^\S+ \[\w+\] /, '')).join('\n'))
  console.log(`\nThe whole lab folder stays at ${lab.root} until the next --play.`)
}

/** Every round's features, checked in one real session with the scripted model. */
async function endToEnd() {
  const columns = Number(option('--columns') ?? 200), rows = Number(option('--rows') ?? 50)
  const lab = createLab({ offline: true, fakeAudio: true })
  const debugFile = join(lab.root, 'debug.txt')
  const env = { ...lab.env, ...(flag('--no-fullscreen') ? { CLAUDE_CODE_NO_FLICKER: '0' } : {}) }
  const term = startTerminal({ cli, args: [...lab.args, '--debug-file', debugFile], cwd: lab.workspace, env, columns, rows })
  const labDir = join(lab.workspace, '.lab')
  const labFile = name => join(labDir, name)
  const requests = () => (readText(lab.record) ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const steps = () => (existsSync(labDir) ? readdirSync(labDir) : []).filter(name => name.startsWith('step-')).map(name => readJson(labFile(name))).filter(Boolean)
  const until = async (test, ms = 10_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await test()) return true; await delay(100) }
    return !!(await test())
  }
  // Esc gives a pane's keys back; the next command must reach the prompt.
  const release = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await term.press('\x1b', 1200)
      if (!/holds the keyboard/.test(term.screen())) return true
    }
    return false
  }
  const results = []
  const started = Date.now()
  const check = (group, name, ok, extra = '') => {
    // A failure keeps its whole detail, and the whole screen, in the results file.
    results.push({ group, name, ok: !!ok, ...(ok ? {} : { detail: String(extra), screen: term.screen() }) })
    const detail = ok ? '' : '\n' + String(extra).split('\n').filter(line => line.trim()).slice(-30).map(line => '      ' + line).join('\n')
    console.log(`${ok ? 'PASS' : 'FAIL'} [${group}] ${name}${detail}`)
  }
  console.log(`Mod lab, offline, ${columns}x${rows}${flag('--no-fullscreen') ? ', no fullscreen' : ''}: ${cli}\n`)
  try {
    // Startup.
    check('UI', 'the band draws above the prompt', await term.waitFor(/lab-ui band/, 90_000), term.screen())
    check('API', "lab-app's timer drives its status line (clock.every, ui.status)", await term.waitFor(/lab-app: ticks [1-9]/, 15_000), term.screen())
    check('Client', 'a Client module ticks in the band', await term.waitFor(/band clock(?: \(answered\))? [1-9]\d*s/, 15_000), term.screen())
    check('Client', "a Client's post is a ui.message to lab-ui; its { props } answer relabels the clock",
      await term.waitFor(/band clock \(answered\)/, 15_000) && existsSync(labFile('client-message-clock.json')), term.screen())
    const debug = readText(debugFile) ?? ''
    check('Chain', 'plugin.register: lab-org refused lab-refused before any of it ran',
      /lab-refused: hooks module refused by lab-org: lab-org refuses lab-refused/.test(debug) && !existsSync(labFile('refused-ran.json')),
      debug.split('\n').filter(line => /lab-refused|refused/.test(line)).join('\n') || 'no refusal in the debug log')
    check('Chain', 'every other lab mod loaded with no warning', !/(lab-org|lab-app|lab-ui|lab-stream|lab-tail)[^\n]*(did not load|hook skipped)/.test(debug),
      debug.split('\n').filter(line => /did not load|hook skipped/.test(line)).join('\n'))

    // The API battery: one check per API.
    await term.submit('/lab-api')
    const shown = await term.waitFor(/lab-api: \d+\/\d+ passed/, 90_000)
    const api = readJson(labFile('api.json')) ?? []
    check('API', '/lab-api ran the battery', shown && api.length > 0, term.screen())
    for (const item of api) check('API', item.name, item.ok, item.detail)

    // next.to: past the user tier.
    await term.submit('/lab-skip')
    check('Chain', "/lab-skip: lab-org's next.to lands in lab-tail (append), lab-app's user-tier hook skipped",
      await term.waitFor(/lab-tail answered \/lab-skip/, 20_000) && existsSync(labFile('tail-skip.json')) && !existsSync(labFile('app-skip.json')), term.screen())

    // A turn: turn.step, prompt.compose, next.trace.
    const beforePrompt = requests().length
    await term.submit('hello LAB-PROMPT')
    const answered = await term.waitFor(/LAB-ANSWER/, 40_000)
    await delay(800)
    const answer = term.screen()
    const answerLine = answer.split('\n').findLast(line => /●\s*LAB-ANSWER to/.test(line)) ?? ''
    check('Model', 'turn.step: the answer streams through lab-stream, SECRET hidden on screen',
      answered && /\[hidden by lab-stream\]-7/.test(answerLine) && !/SECRET/.test(answerLine), answer)
    check('Model', 'the answer answers the words typed, not a reminder', /LAB-ANSWER to "hello LAB-PROMPT"/.test(answerLine), answerLine)
    check('Model', "prompt.compose: lab-stream's section reached the model (it answers LAB-WORD=KIWI-42)",
      /LAB-WORD=KIWI-42/.test(answer) && requests().slice(beforePrompt).some(request => request.sawLabWord), answer)
    check('Model', 'turn.step: the hook read the result and the chain beneath it (next.trace, chunks)',
      await until(() => steps().some(step => step.stopReason === 'end_turn' && step.trace.some(entry => entry.plugin === 'engine' && entry.chunks > 0))),
      JSON.stringify(steps()).slice(0, 1200))
    const trace = readJson(labFile('org-trace.json'))
    check('Chain', 'next.trace: lab-org sees the user tier (lab-app), the append tier (lab-tail) and the engine beneath it',
      !!trace && ['lab-app', 'lab-tail', 'engine'].every(plugin => trace.trace.some(entry => entry.plugin === plugin)) &&
        trace.trace.find(entry => entry.plugin === 'lab-tail')?.tier === 'append', JSON.stringify(trace))

    // An answer without the model.
    await term.submit('/lab-canned')
    await term.waitFor(/the next message is answered by lab-stream/, 15_000)
    const beforeCanned = requests().length
    await term.submit('anything at all')
    check('Model', 'turn.step answers without the model: no request is sent',
      await term.waitFor(/LAB-CANNED: answered by the lab-stream hook/, 30_000) && requests().length === beforeCanned, term.screen())

    // A tool call through turn.step.
    await term.submit('please LAB-TOOL now')
    check('Model', 'a tool call streams through turn.step and runs (Read)',
      await term.waitFor(/LAB-AFTER-TOOL/, 40_000) && await until(() => steps().some(step => (step.toolUses ?? []).some(use => use.name === 'Read'))), term.screen())

    // A note under a permission dialog.
    await term.submit('please LAB-BASH now')
    check('UI', "ui.notice: lab-app's note shows under the Bash permission dialog", await term.waitFor(/this note sits under the dialog/, 40_000), term.screen())
    // Esc at the dialog: the person's rejection stands, whatever mods watch the call.
    await term.press('\x1b', 2500)
    const rejected = term.screen()
    check('Model', 'Esc at the dialog: the rejection shows, not an error from the hooks around the call',
      !/Mod event aborted/.test(rejected) && !existsSync(join(lab.workspace, 'lab-bash.txt')), rejected)

    // $.state across plugins.
    const countBefore = Number(/lab-app count (\d+)/.exec(term.screen())?.[1] ?? 0)
    await term.submit('/lab-state')
    check('State', "/lab-state: lab-app's write redraws lab-ui's band, which reads that value",
      await term.waitFor(new RegExp(`lab-app count ${countBefore + 1}`), 20_000), term.screen())

    // The lab pane.
    await term.submit('/lab-pane')
    check('UI', '/lab-pane opens the lab pane, holding the keys', await term.waitFor(/Lab pane · clicks/, 20_000), term.screen())
    const paneColumn = term.screen().split('\n').find(line => line.includes('Lab pane · clicks'))?.indexOf('Lab pane · clicks') ?? -1
    if (!flag('--no-fullscreen')) check('UI', 'a wide fullscreen terminal docks the pane beside the transcript', paneColumn > columns / 3, `the pane starts at column ${paneColumn}`)
    await term.press('a', 1000)
    check('State', 'a hotkey presses Add; $.state redraws the pane and the band by themselves',
      await term.waitFor(/Lab pane · clicks 1/, 15_000) && await term.waitFor(/lab-ui band · clicks 1/, 10_000), term.screen())
    check('Client', 'Client modules in the pane: the clock ticks', await term.waitFor(/pane clock(?: \(answered\))? [1-9]\d*s/, 15_000), term.screen())
    const pane = term.screen()
    check('UI', 'Svg, Link, Code and Markdown draw', /An Svg draws its children/.test(pane) && /A link to example\.com/.test(pane) && /console\.log\(lab\)/.test(pane) && /Markdown/.test(pane), pane)
    for (let i = 0; i < 4; i++) await term.press('\t', 350)
    await term.type('hello lab')
    check('UI', 'Tab moves the ring to the Input; what you type shows there', await term.waitFor(/hello lab/, 8_000), term.screen())
    check('UI', 'ui.focus: moving the ring raised ui.focus for lab-ui', existsSync(labFile('ui-focus.json')))
    await term.press('\r', 1500)
    check('UI', 'Enter submits the Input to the mod', await until(() => readText(labFile('note.txt')) === 'hello lab'), readText(labFile('note.txt')) ?? 'no note.txt')
    check('UI', 'Esc gives the keys back to the prompt', await release(), term.screen())

    // Several panes: tabs.
    // Each command finishes (its output shows) before a key is pressed: Esc
    // during a running command interrupts it.
    await term.submit('/lab-tabs')
    const tabsDone = await term.waitFor(/lab-tabs: \{/, 20_000)
    check('UI', '/lab-tabs: several panes, a tab row names them',
      tabsDone && await term.waitFor(/Tab A \(holdToasts\)/, 10_000) && await term.waitFor(/Tab C/, 10_000), term.screen())
    check('UI', 'a long tab row is cut short; the esc hint stays whole', /esc back/.test(term.screen()) && !/closeOnEsesc/.test(term.screen()), term.screen())
    await release()

    // A Client that fails.
    await term.submit('/lab-faults')
    await term.waitFor(/lab-faults: \{/, 20_000)
    check('Client', 'a failing Client draws one dimmed line in its place', await term.waitFor(/lab-ui: Client hooks\/broken\.tsx: lab broken on purpose/, 20_000), term.screen())
    check('Client', 'ui.fault reaches lab-ui, phase render', await until(() => readJson(labFile('client-fault.json'))?.phase === 'render'), JSON.stringify(readJson(labFile('client-fault.json'))))
    await release()

    // Closing panes: ui.close.
    await term.submit('/lab-close')
    check('UI', '/lab-close: every pane closes, each through ui.close (its toast shows)', await term.waitFor(/closed \(ui\.close\)/, 20_000), term.screen())

    // Sound, through a stand-in player: this run makes none.
    await term.submit('/lab-audio')
    const heard = await term.waitFor(/lab-audio: /, 40_000)
    const audio = readJson(labFile('audio.json')) ?? {}
    const played = (readText(lab.played) ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    check('Audio', '/lab-audio: chime, bytes, a loop its signal stopped, and speech',
      heard && Object.values(audio).every(result => !/failed/.test(String(result))) && played.filter(item => item.kind === 'play').length >= 3 &&
        played.some(item => item.kind === 'speak' && item.text === 'Tau mod lab'), JSON.stringify({ audio, played: played.length }))

    // Leaving: session.end.
    await term.submit('/exit')
    await term.waitExit(30_000)
    const seen = (await until(() => existsSync(labFile('org-seen-events.json')), 10_000)) ? readJson(labFile('org-seen-events.json')) : []
    const expected = ['session.start', 'session.end', 'turn.start', 'turn.step', 'turn.complete', 'prompt.compose', 'command.run', 'tool.call', 'tool.check',
      'ui.render', 'state.get', 'state.set', 'fs.write', 'clock.every', 'plugin.register', 'engine.create', 'classic.PreToolUse', 'classic.SessionStart']
    check('Chain', "'*': lab-org observed every kind of event the session raised", expected.every(event => seen.includes(event)),
      'missing: ' + expected.filter(event => !seen.includes(event)).join(', '))
  } catch (error) {
    check('Lab', 'the run finished', false, error instanceof Error ? error.stack : String(error))
  } finally {
    term.kill()
    const failed = results.filter(item => !item.ok)
    const summary = `${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s`
    console.log('\n' + summary)
    mkdirSync(join(here, 'results'), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(here, 'results', `${stamp}.json`), JSON.stringify({ cli, columns, rows, summary, results }, null, 2))
    if (flag('--keep')) console.log(`Kept the lab folder: ${lab.root}`)
    else { await delay(500); lab.remove() }
    process.exit(failed.length ? 1 : 0)
  }
}
