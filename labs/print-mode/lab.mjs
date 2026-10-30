#!/usr/bin/env node
// The -p lab. Runs the real CLI through scenarios about the tool list, the allowlist, permission modes and
// the prompt cache. See README.md, or run: node labs/print-mode/lab.mjs --help
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandbox, offlineEnvironment, realEnvironment, realEnvironmentFor, routeFor, writeMcpConfig, writeSampleProject } from './lib/sandbox.mjs'
import { toTauName } from './lib/tool-names.mjs'
import { firstDifference, MARKER, prefixOf, readRequest } from './lib/wire.mjs'
import { realScenarios, scenarios } from './scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const HELP = `Tau -p lab

  node labs/print-mode/lab.mjs                  every offline scenario on the Anthropic route (no account, no quota)
  node labs/print-mode/lab.mjs --provider agy   the same on the Antigravity route (or any provider name)
  node labs/print-mode/lab.mjs --real --provider agy   real model on that provider (USES YOUR QUOTA)
  node labs/print-mode/lab.mjs --real           real model on whichever provider is active (USES YOUR QUOTA)
  node labs/print-mode/lab.mjs --play           make a folder to try things by hand, and print the commands

  --only <word>   only scenarios whose group or id contains the word (cache, allowlist, tools, ...)
  --list          list the scenarios without running them
  --show <id>     run one scenario and print everything it did
  --cli <path>    test another build (default: this repo's dist/cli.mjs)
  --jobs <n>      run n scenarios at once (default 1)
  --model <id>    model to use (offline: overrides the route's model; real: passed to the CLI)
  --keep          keep each scenario's folder, with every captured request, and print where it is
  --max-turns <n> real runs stop after n model turns (default 6)
`

function parseArguments(argv) {
  const options = { provider: 'anthropic', jobs: 1, maxTurns: 6 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--real') options.real = true
    else if (arg === '--list') options.list = true
    else if (arg === '--play') options.play = true
    else if (arg === '--provider') { options.provider = argv[++i]; options.providerGiven = true }
    else if (arg === '--only') options.only = argv[++i]
    else if (arg === '--show') options.show = argv[++i]
    else if (arg === '--cli') options.cli = argv[++i]
    else if (arg === '--jobs') options.jobs = Number(argv[++i]) || 1
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--keep') options.keep = true
    else if (arg === '--max-turns') options.maxTurns = Number(argv[++i]) || 6
    else { console.error(`Unknown option: ${arg}\n\n${HELP}`); process.exit(2) }
  }
  return options
}

const options = parseArguments(process.argv.slice(2))
if (options.help) { console.log(HELP); process.exit(0) }
const cli = resolve(options.cli ?? join(here, '..', '..', 'dist', 'cli.mjs'))
const color = process.stdout.isTTY
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text)
const STATE = { PASS: paint(32, 'PASS'), FAIL: paint(31, 'FAIL'), WARN: paint(33, 'WARN'), SKIP: paint(90, 'SKIP'), INFO: paint(36, 'INFO') }
const stripAnsi = text => text.replace(/\u001b\[[0-9;?<>]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '')

function fillIn(value, places) {
  if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (whole, name) => places[name] ?? whole)
  if (Array.isArray(value)) return value.map(item => fillIn(item, places))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fillIn(inner, places)]))
  return value
}

function parseOutput(format, stdout) {
  const text = stripAnsi(stdout)
  if (format === 'stream-json') {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.startsWith('{')).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    return { lines, json: lines.findLast(line => line.type === 'result') ?? null, printed: lines.findLast(line => line.type === 'result')?.result ?? '' }
  }
  if (format === 'text') return { json: null, printed: text.trim() }
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    return { json, printed: typeof json.result === 'string' ? json.result : '' }
  } catch {
    return { json: null, printed: text.trim() }
  }
}

const running = new Set()

// The launcher starts the CLI as a child, so stopping a run has to stop the whole tree. A real run left
// behind would keep spending quota.
function stopRun(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {}
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of running) stopRun(child)
    process.exit(130)
  })
}

function spawnCli(args, cwd, env) {
  return new Promise(done => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    running.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', part => { stdout += part })
    child.stderr.on('data', part => { stderr += part })
    const timer = setTimeout(() => { stopRun(child); running.delete(child); done({ exit: 'timeout', stdout, stderr }) }, options.real ? 150_000 : 90_000)
    child.on('exit', exit => { clearTimeout(timer); running.delete(child); done({ exit, stdout, stderr }) })
  })
}

const shellQuote = arg => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg}"`)

async function runOffline(box, route, scenario, run, index, env) {
  const places = { ...box.places, mcpConfig: scenario.mcp ? writeMcpConfig(box) : '' }
  const planFile = join(box.root, `plan-${index}.json`)
  const recordFile = join(box.root, `record-${index}.jsonl`)
  writeFileSync(planFile, JSON.stringify(fillIn({ steps: run.steps ?? [], finalText: 'LAB-DONE', usage: run.usage ?? scenario.usage, refuse: scenario.refuse }, places)))
  const format = run.format ?? 'json'
  const prompt = run.prompt ?? `${MARKER} follow the script`
  const session = run.persist ? [] : ['--no-session-persistence']
  const args = fillIn([
    '-p', prompt,
    ...(format === 'text' ? [] : ['--output-format', format]),
    ...(format === 'stream-json' ? ['--verbose'] : []),
    ...((options.model ?? route.model) ? ['--model', options.model ?? route.model] : []),
    ...(scenario.mcp ? ['--mcp-config', '{mcpConfig}', '--strict-mcp-config'] : []),
    ...session,
    ...(run.args ?? []),
  ], places)
  const result = await spawnCli(args, box.workspace, { ...env, TAU_LAB_PLAN: planFile, TAU_LAB_RECORD: recordFile })
  const records = existsSync(recordFile) ? readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const requests = records.filter(record => !record.side && record.format !== 'other').map(readRequest)
  return { ...result, args, format, requests, otherFormat: records.some(record => record.format === 'other'), ...parseOutput(format, result.stdout) }
}

async function runReal(box, scenario, run, env) {
  // A provider can take a while to store a new cache entry, and a request sent before that misses it.
  if (run.pauseMs) await new Promise(done => setTimeout(done, run.pauseMs))
  const format = run.format ?? 'json'
  const args = [
    '-p', run.prompt,
    ...(format === 'text' ? [] : ['--output-format', format]),
    ...(format === 'stream-json' ? ['--verbose'] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(run.persist ? [] : ['--no-session-persistence']),
    // A refused real model keeps trying other tools, and each try costs quota.
    '--max-turns', String(options.maxTurns),
    ...fillIn(run.args ?? [], box.places),
  ]
  const result = await spawnCli(args, box.workspace, env)
  if (run.persist) box.savedRealSession = true
  return { ...result, args, format, requests: [], ...parseOutput(format, result.stdout) }
}

const namesOf = request => request.tools.map(tool => toTauName(tool.name)).sort()
const deniedOf = run => [...new Set((run.json?.permission_denials ?? []).map(entry => entry.tool_name))].sort()
const seenBy = run => (run.requests.at(-1)?.toolResults ?? []).map(result => result.text).join('\n')
const asList = value => (Array.isArray(value) ? value : [value])

function cacheShare(usage) {
  if (!usage) return null
  const read = usage.cache_read_input_tokens ?? 0
  const notCached = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  const total = read + notCached
  return { read, notCached, percent: total ? Math.round(read / total * 100) : 0 }
}

function checkExpectations(expect, run, box, baseline) {
  const problems = []
  const fail = text => problems.push(text)
  if (options.real) {
    // Reaching the turn limit is fine here. An API failure is not: it would make "the file was not
    // created" pass for the wrong reason.
    if (run.exit === 'timeout') fail('stopped after the time limit')
    else if (run.format !== 'text' && !run.json) fail(`no result. Output: ${stripAnsi(run.stdout + run.stderr).trim().slice(0, 300)}`)
    else if (run.json?.is_error && run.json.subtype !== 'error_max_turns') fail(`the run itself failed: ${String(run.json.result ?? run.json.subtype).slice(0, 300)}`)
  } else {
    const expectedExit = expect.exit ?? 0
    if (run.exit !== expectedExit) fail(`exit code ${run.exit}, expected ${expectedExit}. Output: ${stripAnsi(run.stdout + run.stderr).trim().slice(0, 300)}`)
  }
  if (expect.cleanOutput) {
    // Read the raw bytes here: other checks strip escape codes, so they cannot see this.
    if (/\u001b/.test(run.stdout)) fail(`stdout has escape codes: ${JSON.stringify(run.stdout.slice(-80))}`)
    if (/\u001b/.test(run.stderr)) fail(`stderr has escape codes: ${JSON.stringify(run.stderr.slice(-40))}`)
    if (run.format === 'json') {
      try { JSON.parse(run.stdout) } catch (error) { fail(`stdout is not valid JSON, so jq or ConvertFrom-Json would fail: ${error.message.slice(0, 90)}`) }
    }
  }
  if (expect.printed && !expect.printed.test(run.printed)) fail(`printed "${run.printed.slice(0, 160)}", expected to match ${expect.printed}`)
  if (expect.notPrinted && expect.notPrinted.test(run.printed)) fail(`printed "${run.printed.slice(0, 160)}", expected no match for ${expect.notPrinted}`)
  if (expect.isError !== undefined && run.json?.is_error !== expect.isError) fail(`is_error ${run.json?.is_error}, expected ${expect.isError}`)
  if (expect.subtype && run.json?.subtype !== expect.subtype) fail(`subtype ${run.json?.subtype}, expected ${expect.subtype}`)
  if (expect.denied) {
    const [actual, wanted] = [deniedOf(run), [...expect.denied].sort()]
    if (actual.join() !== wanted.join()) fail(`refused [${actual}], expected [${wanted}]`)
  }
  if (expect.offered !== undefined) {
    const actual = run.requests[0] ? namesOf(run.requests[0]) : null
    if (!actual) fail('no model request was made')
    else {
      const rule = expect.offered
      if (rule === 'all' || rule?.minus) {
        const wanted = baseline.filter(name => !(rule.minus ?? []).includes(name))
        const [missing, extra] = [wanted.filter(name => !actual.includes(name)), actual.filter(name => !wanted.includes(name))]
        if (missing.length || extra.length) fail(`offered ${actual.length} tools; missing [${missing}], extra [${extra}]`)
      } else if (Array.isArray(rule)) {
        if (actual.join() !== [...rule].sort().join()) fail(`offered [${actual}], expected [${[...rule].sort()}]`)
      } else {
        for (const name of rule.includes ?? []) if (!actual.includes(name)) fail(`${name} was not offered`)
        for (const name of rule.excludes ?? []) if (actual.includes(name)) fail(`${name} was offered`)
      }
    }
  }
  const seen = seenBy(run)
  for (const pattern of asList(expect.saw ?? [])) if (!pattern.test(seen)) fail(`model saw "${seen.replace(/\s+/g, ' ').slice(0, 220)}", expected ${pattern}`)
  for (const pattern of asList(expect.notSaw ?? [])) if (pattern.test(seen)) fail(`model saw "${seen.replace(/\s+/g, ' ').slice(0, 220)}", expected no ${pattern}`)
  for (const file of expect.exists ?? []) if (!existsSync(join(box.workspace, file))) fail(`${file} should exist and does not`)
  for (const file of expect.missing ?? []) if (existsSync(join(box.workspace, file))) fail(`${file} should not exist and does`)
  for (const [file, pattern] of Object.entries(expect.contains ?? {})) {
    const path = join(box.workspace, file)
    if (!existsSync(path) || !pattern.test(readFileSync(path, 'utf8'))) fail(`${file} does not match ${pattern}`)
  }
  if (expect.credential) {
    const headers = run.requests[0]?.headers ?? {}
    const actual = headers.authorization ? 'login' : headers['x-api-key'] ? 'key' : 'none'
    if (actual !== expect.credential) fail(`signed in with ${actual}, expected ${expect.credential}`)
  }
  for (const text of asList(expect.systemHas ?? [])) if (!run.requests[0]?.systemText.includes(text)) fail(`system prompt lacks "${text}"`)
  for (const text of asList(expect.systemLacks ?? [])) if (run.requests[0]?.systemText.includes(text)) fail(`system prompt has "${text}"`)
  if (expect.requests !== undefined && run.requests.length !== expect.requests) fail(`${run.requests.length} model requests, expected ${expect.requests}`)
  if (expect.usage) {
    for (const [key, value] of Object.entries(expect.usage)) if (run.json?.usage?.[key] !== value) fail(`usage.${key} is ${run.json?.usage?.[key]}, expected ${value}`)
  }
  if (expect.cacheMarkers !== undefined) {
    const counts = run.requests.map(request => (JSON.stringify(request.body).match(/"cache_control"/g) ?? []).length)
    if (counts.some(count => count !== expect.cacheMarkers)) fail(`cache markers per request: ${counts.join(', ')}; expected ${expect.cacheMarkers} on each`)
  }
  if (expect.stable) {
    if (run.requests.length < 2) fail(`only ${run.requests.length} model request(s), so turns cannot be compared`)
    for (let i = 1; i < run.requests.length; i++) {
      const [previous, next] = [run.requests[i - 1], run.requests[i]]
      const difference = firstDifference(previous, next)
      if (difference) fail(`turn ${i} to ${i + 1}: ${difference}`)
      if (previous.sessionKey !== next.sessionKey) fail(`turn ${i} to ${i + 1}: the session key changed`)
      const at = previous.history.findIndex((entry, n) => JSON.stringify(entry) !== JSON.stringify(next.history[n]))
      if (at >= 0) fail(`turn ${i} to ${i + 1}: history message ${at} was rewritten`)
      if (next.history.length <= previous.history.length) fail(`turn ${i} to ${i + 1}: history did not grow`)
    }
  }
  return problems
}

async function runScenario(scenario, route, baseline) {
  const box = createSandbox()
  const report = { id: scenario.id, group: scenario.group, title: scenario.title, note: scenario.note, problems: [], runs: [] }
  try {
    if (scenario.only && !scenario.only.includes(options.real ? 'real' : options.provider)) {
      report.state = 'SKIP'
      report.reason = `only for ${scenario.only.join(', ')}`
      return report
    }
    const env = !options.real ? offlineEnvironment(box, route, scenario.setup)
      : options.providerGiven ? realEnvironmentFor(box, route, options.model ?? route.model)
        : realEnvironment()
    const runs = scenario.runs ?? [scenario]
    const results = []
    for (const [index, run] of runs.entries()) {
      const result = options.real ? await runReal(box, scenario, run, env) : await runOffline(box, route, scenario, run, index, env)
      results.push(result)
      report.runs.push({
        command: `tau ${result.args.map(shellQuote).join(' ')}`,
        exit: result.exit,
        printed: result.printed.slice(0, 400),
        offered: result.requests[0] ? namesOf(result.requests[0]) : undefined,
        requests: result.requests.length,
        denied: deniedOf(result),
        toolResults: result.requests.at(-1)?.toolResults.map(item => item.text.replace(/\s+/g, ' ').slice(0, 300)),
        usage: result.json?.usage ? cacheShare(result.json.usage) : undefined,
        turns: result.json?.num_turns,
        apiKeySource: result.lines?.find(line => line.type === 'system' && line.subtype === 'init')?.apiKeySource,
      })
      if (result.otherFormat) report.reason = 'this provider uses a request format the fake model cannot answer, so only the first request was compared'
      if (run.expect) report.problems.push(...checkExpectations(run.expect, result, box, baseline).map(text => `run ${index + 1}: ${text}`))
    }
    if (scenario.expect) report.problems.push(...checkExpectations(scenario.expect, results.at(-1), box, baseline))
    if (scenario.compare) {
      const [first, second] = [results[0].requests[0], results.at(-1).requests[0]]
      if (!first || !second) report.problems.push('a run made no model request')
      else if (scenario.compare === 'same' && prefixOf(first) !== prefixOf(second)) report.problems.push(`the prefix changed between runs: ${firstDifference(first, second)}`)
      else if (scenario.compare === 'different' && prefixOf(first) === prefixOf(second)) report.problems.push('the prefix was expected to change between runs and did not')
    }
    if (scenario.continues) {
      const [before, after] = [results[0].requests.at(-1), results.at(-1).requests[0]]
      if (!before || !after) report.problems.push('a run made no model request')
      else {
        const at = before.history.findIndex((entry, n) => JSON.stringify(entry) !== JSON.stringify(after.history[n]))
        if (at >= 0) {
          const [x, y] = [JSON.stringify(before.history[at]), JSON.stringify(after.history[at] ?? null)]
          let byte = 0
          while (byte < x.length && x[byte] === y[byte]) byte++
          report.problems.push(`history message ${at} of ${before.history.length} changed after resuming, at byte ${byte}: "${x.slice(Math.max(0, byte - 60), byte + 120)}" became "${y.slice(Math.max(0, byte - 60), byte + 120)}"`)
        }
      }
    }
    if (scenario.reportCache !== undefined) {
      const share = cacheShare(results.at(-1).json?.usage)
      report.cache = share
      if (share && share.percent < scenario.reportCache) report.warnings = [`only ${share.percent}% came from cache; the provider decides, but expected at least ${scenario.reportCache}%`]
    }
    if (scenario.reportSignIn) report.info = `apiKeySource: ${report.runs.at(-1).apiKeySource}`
    report.state = report.problems.length ? (scenario.soft ? 'WARN' : 'FAIL') : report.warnings?.length ? 'WARN' : 'PASS'
    return report
  } catch (error) {
    report.problems.push(`the lab itself failed: ${error?.stack ?? error}`)
    report.state = 'FAIL'
    return report
  } finally {
    if (box.savedRealSession) removeRealSession(box.workspace)
    if (options.keep) report.folder = box.root
    else box.remove()
  }
}

// A real run that saves a session writes it under your settings, in a folder named after this throwaway
// working folder. Only that one folder is removed, so your session list stays as it was.
function removeRealSession(workspace) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const folder = workspace.replace(/[^a-zA-Z0-9]/g, '-')
  if (!folder.includes('tau-lab-')) return
  try { rmSync(join(projects, folder), { recursive: true, force: true, maxRetries: 5 }) } catch {}
}

function printRow(report) {
  const last = report.runs.at(-1)
  const refused = options.real ? last?.denied ?? [] : []
  const extra = [
    report.cache && `${report.cache.percent}% from cache: ${report.cache.read} of ${report.cache.read + report.cache.notCached} tokens`,
    report.info,
    options.real && last?.turns && `${last.turns} turns`,
    refused.length > 0 && `refused: ${refused.join(', ')}`,
  ].filter(Boolean).map(text => `  [${text}]`).join('')
  console.log(`  ${STATE[report.state]}  ${report.id.padEnd(34)} ${report.title}${extra}`)
  for (const problem of [...report.problems, ...(report.warnings ?? [])]) console.log(`        ${paint(90, '->')} ${problem}`)
  if (report.folder) console.log(`        ${paint(90, 'kept:')} ${report.folder}`)
  if (report.state === 'SKIP' && options.show) console.log(`        ${report.reason}`)
}

function printDetails(report) {
  if (report.note) console.log(`\n  Note: ${report.note}`)
  report.runs.forEach((run, index) => {
    console.log(`\n  Run ${index + 1}: ${run.command}`)
    console.log(`    exit code:     ${run.exit}`)
    console.log(`    printed:       ${JSON.stringify(run.printed)}`)
    if (run.offered) console.log(`    tools offered: ${run.offered.length}: ${run.offered.join(', ') || '(none)'}`)
    console.log(`    model requests:${' '}${run.requests}`)
    console.log(`    refused:       ${run.denied.join(', ') || '(none)'}`)
    for (const text of run.toolResults ?? []) console.log(`    model saw:     ${text}`)
    if (run.usage) console.log(`    cache:         ${run.usage.read} tokens from cache, ${run.usage.notCached} not (${run.usage.percent}%)`)
    if (run.apiKeySource !== undefined) console.log(`    apiKeySource:  ${run.apiKeySource}`)
  })
}

function playground() {
  const play = join(here, 'play')
  rmSync(play, { recursive: true, force: true, maxRetries: 5 })
  writeSampleProject(play)
  console.log(`Fresh sample project: ${play}

Go there first:   cd "${play}"
These use your real account and active provider. Add --output-format json to any of them to see
permission_denials and cache numbers. A refused model often keeps trying other tools, which costs quota, so
the refused examples use --max-turns. Run this command again to reset the folder.

  Reading works with no flags (answer: Pineapple)
    tau -p "Read notes.txt and answer with its first word"

  Writing is refused with no flags (no made.txt afterwards, exit code still 0)
    tau -p "Create made.txt containing hello" --max-turns 6

  Allow only Write (made.txt appears)
    tau -p "Create made.txt containing hello" --allowedTools Write

  A shell command is refused, then allowed by a rule (made-by-script.txt appears the second time)
    tau -p "Run this command: node make-file.mjs" --max-turns 6
    tau -p "Run this command: node make-file.mjs" --max-turns 6 --allowedTools "Bash(node:*)"

  Show the model only Read (it cannot write even if you ask)
    tau -p "Create made.txt containing hello" --tools Read

  Protect one folder and leave the rest readable
    tau -p "Read secret/hidden.txt and answer with its first word" --disallowedTools "Read(secret/**)"

  Accept file edits without asking, but not other commands
    tau -p "Create made.txt containing hello" --permission-mode acceptEdits

  See the cache: run this twice and compare cache_read_input_tokens with input_tokens
    tau -p "Read notes.txt and second.txt, then give both first words" --output-format json
`)
}

function listScenarios(list) {
  let group
  for (const scenario of list) {
    if (scenario.group !== group) { group = scenario.group; console.log(`\n${group.toUpperCase()}`) }
    console.log(`  ${scenario.id.padEnd(34)} ${scenario.title}${scenario.only ? `  (only ${scenario.only.join(', ')})` : ''}`)
  }
  console.log()
}

function activeProviderName() {
  const directory = process.env.CLAUDE_CONFIG_DIR
  const file = directory ? join(directory, '.claude.json') : join(homedir(), '.claude.json')
  try { return JSON.parse(readFileSync(file, 'utf8')).activeProvider ?? 'firstParty' } catch { return 'unknown' }
}

async function main() {
  if (options.play) { playground(); return 0 }
  const pool = options.real ? realScenarios : scenarios
  const selected = options.show
    ? pool.filter(scenario => scenario.id === options.show)
    : pool.filter(scenario => !options.only || scenario.group.includes(options.only) || scenario.id.includes(options.only))
  if (options.list) { listScenarios(selected); return 0 }
  if (!selected.length) { console.error(`No scenario matches. Try: node labs/print-mode/lab.mjs --list${options.real ? ' --real' : ''}`); return 2 }
  if (!existsSync(cli)) { console.error(`CLI not found: ${cli}\nBuild it with: npm run build, or pass --cli <path>`); return 2 }

  const route = routeFor(options.provider)
  const started = Date.now()
  if (options.real) {
    if (options.providerGiven && route.provider === 'firstParty') {
      console.error('Your Anthropic login is stored in your own settings, so a real Anthropic run has to use them.\nSwitch to Anthropic with /provider, then run --real without --provider.')
      return 2
    }
    const who = options.providerGiven ? `${options.provider}, your sign-in, throwaway settings` : `${activeProviderName()}, your active provider, your own settings`
    console.log(`Tau -p lab: REAL model on ${who}${options.model ? `, model ${options.model}` : ''}.`)
    console.log(`This uses your quota: each run stops after ${options.maxTurns} model turns or 150 seconds. Press Ctrl+C to stop.`)
  } else {
    console.log(`Tau -p lab: offline, ${options.provider} route (${route.provider}), fake model, no account, no quota.`)
  }
  console.log(`CLI ${cli}  Node ${process.version}  ${selected.length} scenario(s)`)

  // The full tool list on this build and route, so scenarios never hardcode it.
  let baseline = []
  if (!options.real) {
    const box = createSandbox()
    const first = await runOffline(box, route, {}, {}, 0, offlineEnvironment(box, route))
    box.remove()
    if (!first.requests[0]) {
      console.error(`\nCould not reach the fake model on this route, so nothing can be tested.\nOutput: ${stripAnsi(first.stdout + first.stderr).trim().slice(0, 400)}`)
      return 1
    }
    baseline = namesOf(first.requests[0])
    console.log(`Full tool list on this route: ${baseline.length} tools`)
  }

  const reports = new Array(selected.length)
  let next = 0
  let printedUpTo = 0
  let group
  const flush = () => {
    while (printedUpTo < selected.length && reports[printedUpTo]) {
      const report = reports[printedUpTo++]
      if (report.group !== group) { group = report.group; console.log(`\n${group.toUpperCase()}`) }
      printRow(report)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, async () => {
    while (next < selected.length) {
      const index = next++
      reports[index] = await runScenario(selected[index], route, baseline)
      flush()
    }
  }))

  if (options.show) printDetails(reports[0])
  const count = state => reports.filter(report => report.state === state).length
  const seconds = Math.round((Date.now() - started) / 1000)
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed${count('WARN') ? `, ${count('WARN')} warnings` : ''}${count('SKIP') ? `, ${count('SKIP')} skipped` : ''} in ${seconds}s`)
  const resultsDirectory = join(here, 'results')
  mkdirSync(resultsDirectory, { recursive: true })
  const saved = join(resultsDirectory, `${options.real ? `real-${options.providerGiven ? options.provider : 'active'}` : options.provider}.json`)
  writeFileSync(saved, JSON.stringify({ date: new Date().toISOString(), cli, node: process.version, reports }, null, 1))
  console.log(`Every command and result is saved in ${saved}`)
  return count('FAIL') ? 1 : 0
}

process.exit(await main())
