// MCP server instructions, end to end: every provider lane, fake network or
// live accounts, print mode and the interactive REPL.
//
//   node test/mcp-instructions/run.mjs --net fake --cli <tau.mjs> [--providers all|a,b]
//   node test/mcp-instructions/run.mjs --net live --cli <tau.mjs> --targets provider=model,...
//   options: --scenarios a,b   --label name   --env KEY=VALUE,KEY=VALUE
//
// Scenarios (the same steps and checks for every provider):
//   late       two servers; the second connects between user turns
//   subagent   a fresh general-purpose sub-agent: its FIRST request
//   reconnect  a server reconnects with new instructions, same tools
//   disable    a server is switched off mid-session
//   resume     a second process resumes the session
//   compact    /compact between two turns (re-announcement, no double)
//   custom     --system-prompt replaces the default system prompt
//   turn1      REPL: the first prompt is submitted while a server is still
//              connecting (inside the launch wait)
//   midturn    REPL: a server connects while a tool call is running
//
// Checks, read from the logged requests (never from tau's own reporting):
//   deliver    a request that offers a server's tools carries that server's
//              current instructions, exactly once; none before its tools
//   current    after a reconnect: the new text, announced after the old
//   retract    a server switched off: its tools gone, a retraction sent
//   prefix     each request starts with the previous request of the same
//              conversation; tool-list changes are reported apart
//   answer     live: the tool actually receives the required random argument
//   cache      live: the cache reads the provider reported, per request
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonical, responsesReply, stripMarkers, view } from './formats.mjs'
import { anthropicReply } from './anthropic-reply.mjs'
import { script } from './script.mjs'
import { hasInstructionsInsideToolOutput } from './wire-checks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const require = createRequire(import.meta.url)

const argv = process.argv.slice(2)
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const NET = opt('net') ?? 'fake'
const CLI = resolve(opt('cli') ?? join(REPO, 'dist', 'tau.mjs'))
const LABEL = opt('label') ?? `${NET}-${Date.now()}`
if (!/^[a-zA-Z0-9_-]+$/.test(LABEL)) throw new Error('Invalid run label')
const ALL_SCENARIOS = ['late', 'subagent', 'reconnect', 'disable', 'resume', 'compact', 'custom', 'turn1', 'midturn']
const SCENARIOS = (opt('scenarios') ?? ALL_SCENARIOS.join(',')).split(',')
const EXTRA_ENV = Object.fromEntries((opt('env') ?? '').split(',').filter(Boolean)
  .map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
const OUT = join(REPO, 'tmp', 'mcp-instr', 'out', LABEL)
mkdirSync(OUT, { recursive: true })
const TURN_TIMEOUT = NET === 'live' ? 240_000 : 90_000

// ── providers ──────────────────────────────────────────────────────────────
const FAR = Date.now() + 30 * 24 * 3600e3
const oauth = (extra = {}) => JSON.stringify({ accessToken: 'c28-access-token-0000000000000000', refreshToken: 'c28-refresh', expiresAt: FAR, ...extra })
// Fake-network credentials and a model per provider (the cache28 table).
const FAKE = {
  firstParty: { model: 'claude-sonnet-4-6', env: port => ({ ANTHROPIC_API_KEY: 'sk-ant-api03-' + 'c28'.repeat(30), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }) },
  openai: { model: 'gpt-5.6-luna', env: port => ({ OPENAI_API_KEY: 'sk-proj-' + 'c28x'.repeat(12), OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` }) },
  commandcode: { model: 'deepseek/deepseek-v4-flash', env: () => ({ CMD_API_KEY: 'c28-commandcode-key-00000000' }) },
  antigravity: { model: 'gemini-3.7-flash-medium', keys: { gemini_oauth_antigravity: oauth() } },
  openrouter: { model: 'example/e2e-model', env: () => ({ OPENROUTER_API_KEY: 'sk-or-v1-' + 'c28x'.repeat(16), TAU_OPENROUTER_REASONING_CATALOG: '0' }) },
  agentrouter: { model: 'e2e-model', env: () => ({ AGENT_ROUTER_TOKEN: 'c28-agentrouter-token-000000' }) },
  vercel: { model: 'e2e/e2e-model', env: () => ({ AI_GATEWAY_API_KEY: 'c28-vercel-key-000000000000' }) },
  requesty: { model: 'e2e/e2e-model', env: () => ({ REQUESTY_API_KEY: 'c28-requesty-key-00000000000' }) },
  opencode: { model: 'e2e-model', env: () => ({ OPENCODE_API_KEY: 'c28-opencode-key-00000000000' }) },
  opencodego: { model: 'e2e-model', env: () => ({ OPENCODE_GO_API_KEY: 'c28-opencodego-key-000000000' }) },
  lxd: { model: 'e2e-model', env: () => ({ LXD_API_KEY: 'c28-lxd-key-0000000000000000' }) },
  mimo: { model: 'mimo-v2-flash', env: () => ({ MIMO_API_KEY: 'c28-mimo-key-000000000000000' }) },
  fireworks: { model: 'accounts/fireworks/models/e2e', env: () => ({ FIREWORKS_API_KEY: 'c28-fireworks-key-0000000000' }) },
  cloudflare: { model: '@cf/e2e/model', env: () => ({ CLOUDFLARE_API_TOKEN: 'c28-cloudflare-token-00000000', CLOUDFLARE_ACCOUNT_ID: 'c28account0000000000000000000000' }) },
  mistral: { model: 'mistral-large-latest', env: () => ({ MISTRAL_API_KEY: 'c28-mistral-key-0000000000000' }) },
  nim: { model: 'e2e/e2e-model', env: () => ({ NIM_API_KEY: 'nvapi-c28-nim-key-00000000000' }) },
  deepseek: { model: 'deepseek-chat', env: () => ({ DEEPSEEK_API_KEY: 'sk-c28-deepseek-key-000000000' }) },
  glm: { model: 'glm-4.6', env: () => ({ GLM_API_KEY: 'c28-glm-key-0000000000000000' }) },
  moonshot: { model: 'kimi-k2-0905-preview', env: () => ({ MOONSHOT_API_KEY: 'sk-c28-moonshot-key-000000000' }) },
  minimax: { model: 'MiniMax-M2', env: () => ({ MINIMAX_API_KEY: 'c28-minimax-key-0000000000000' }) },
  alibaba: { model: 'qwen3-coder-plus', env: () => ({ DASHSCOPE_API_KEY: 'sk-c28-dashscope-key-00000000' }) },
  ollama: { model: 'e2e-model', env: () => ({ OLLAMA_API_KEY: 'ollama' }) },
  lmstudio: { model: 'e2e-model', env: () => ({ LMSTUDIO_API_KEY: 'lm-studio' }) },
  cline: { model: 'anthropic/claude-sonnet-4.6', keys: { cline_oauth: oauth({ meta: { email: 'c28@example.com', accountId: 'c28-account', tokenType: 'Bearer' } }) } },
  clinepass: { model: 'anthropic/claude-sonnet-4.6', keys: { clinepass_oauth: oauth({ meta: { email: 'c28@example.com', accountId: 'c28-account', tokenType: 'Bearer' } }) } },
  copilot: { model: 'gpt-4.1', keys: { copilot_oauth: oauth({ meta: { refreshIn: 1500, refreshAt: FAR, sku: 'copilot_individual', individual: true } }) } },
  kilocode: { model: 'anthropic/claude-sonnet-4.6', keys: { kilocode_oauth: JSON.stringify({ accessToken: 'c28-kilo-token-000000000000000', meta: { email: 'c28@example.com', orgId: null } }) } },
  kiro: { model: 'claude-sonnet-4.5', keys: { kiro_oauth: oauth({ meta: { authMethod: 'social', region: 'us-east-1' } }) } },
}
const TARGETS = NET === 'live'
  ? (opt('targets') ?? '').split(',').filter(Boolean).map(s => {
      const i = s.indexOf('=')
      return { provider: s.slice(0, i), model: s.slice(i + 1) }
    })
  : (!opt('providers') || opt('providers') === 'all' ? Object.keys(FAKE) : opt('providers').split(','))
      .map(provider => ({ provider, model: FAKE[provider].model }))

// Resume an interrupted audit without discarding its evidence. Only entirely
// passing cases count; setup failures and ungraded checks are run again.
const completedCases = new Set()
for (const label of (opt('skip-passed') ?? '').split(',').filter(Boolean)) {
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Invalid prior run label')
  const rows = JSON.parse(readFileSync(join(REPO, 'tmp', 'mcp-instr', 'out', label, 'summary.json'), 'utf8'))
  for (const row of rows) {
    if (row.verdict === 'OK' && row.checks.every(check => check.pass === true)) {
      completedCases.add(`${row.provider}:${row.model}:${row.scenario}`)
    }
  }
}

// ── fake network: local server for the Anthropic and Responses lanes ───────
let port = 0
if (NET === 'fake') {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', d => chunks.push(d))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const isResponses = req.url.startsWith('/v1/responses')
      if (!isResponses && (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens'))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ input_tokens: 100 }))
      }
      const format = isResponses ? 'responses' : 'anthropic'
      const body = JSON.parse(raw || '{}')
      const { action } = script(format, body)
      // Logged by net.mjs inside tau, which sees this request on its way out.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(isResponses ? responsesReply(action) : anthropicReply(action, body.model))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  process.on('exit', () => server.close())
}

// ── one sealed run folder ──────────────────────────────────────────────────
// --seed makes codewords and tags repeatable, so two builds can be diffed byte for byte.
const SEED = opt('seed')
let seeded = 0
const randomHex = n => SEED
  ? createHash('sha256').update(`${SEED}:${++seeded}`).digest('hex').slice(0, n * 2)
  : randomBytes(n).toString('hex')
const token = label => `${label}-${randomHex(4).toUpperCase()}`
// The code appears once in the text, so one announcement = one occurrence.
const instructionsFor = (name, code) =>
  `Codeword: ${code}. Whenever you call this server's probe tool, set its note argument to this codeword.`

function setup(target, scenario, servers, scenarioEnv = {}, settings = {}) {
  if (!Object.hasOwn(FAKE, target.provider) || ![...ALL_SCENARIOS, 'sdkmidturn', 'nomcp', 'cheap', 'nomcprepl', 'cheaprepl'].includes(scenario)) throw new Error('Unknown provider/scenario')
  const root = join(OUT, `${target.provider}`, scenario)
  if (existsSync(root)) throw new Error('Run directory already exists; choose a fresh --label')
  for (const d of ['config', 'ws', 'tmp', 'instr']) mkdirSync(join(root, d), { recursive: true })
  const ws = join(root, 'ws')
  const log = join(root, 'requests.jsonl')
  writeFileSync(log, '')

  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(CLAUDE|ANTHROPIC|OPENROUTER|OPENAI|GEMINI|TAU_|CLAUDEX|ENABLE_TOOL_SEARCH|E2E_|MCP_|NoDefaultCurrentDirectoryInExePath)/i.test(k)) env[k] = v
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    E2E_NET: NET, E2E_MODEL: target.model, E2E_LOG: log, E2E_SCENARIO: scenario,
  })
  const config = {
    theme: 'dark', hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: target.provider,
    projects: { [ws.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
  }
  if (NET === 'fake') {
    const spec = FAKE[target.provider]
    for (const d of ['home', 'appdata', 'localappdata']) mkdirSync(join(root, d), { recursive: true })
    Object.assign(env, {
      HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false', TAU_SKIP_PREFLIGHT: '1',
      E2E_LOCAL: `http://127.0.0.1:${port}`, ...(spec.env?.(port) ?? {}),
    })
    config.customApiKeyResponses = { approved: ['c28'.repeat(30).slice(-20)], rejected: [] }
    if (spec.keys) {
      const dir = join(root, 'home', '.config', 'claude-code')
      mkdirSync(dir, { recursive: true })
      const now = new Date().toISOString()
      writeFileSync(join(dir, 'provider-keys.json'), JSON.stringify({
        version: 1, keys: spec.keys,
        metadata: Object.fromEntries(Object.keys(spec.keys).map(k => [k, { savedAt: now, format: 'oauth_token' }])),
      }))
    }
  }
  if (NET === 'live' && target.provider === 'firstParty') Object.assign(env, anthropicLoginEnv())
  Object.assign(env, EXTRA_ENV, scenarioEnv)
  writeFileSync(join(root, 'config', '.claude.json'), JSON.stringify(config))
  writeFileSync(join(root, 'config', 'settings.json'), JSON.stringify({
    ...settings,
    permissions: { allow: ['Bash', 'PowerShell', 'Agent', 'Read', 'Glob', 'Grep', ...servers.map(s => `mcp__${s.name}`)] },
  }))

  const mcpServers = {}
  for (const s of servers) {
    if (s.code) codeServer.set(s.code, s.name)
    const file = join(root, 'instr', `${s.name}.txt`)
    writeFileSync(file, s.code ? instructionsFor(s.name, s.code) : '')
    mcpServers[s.name] = {
      command: process.execPath,
      args: [join(HERE, 'mcp-server.mjs')],
      env: { FX_NAME: s.name, FX_INSTR_FILE: file, FX_CALL_LOG: join(root, 'calls.jsonl'), FX_START_LOG: join(root, 'server-starts.jsonl'), ...(s.delayMs && { FX_DELAY_MS: String(s.delayMs) }),
        ...(s.release && { FX_RELEASE_FILE: join(root, `${s.name}.release`) }),
        ...(s.afterFirstRequest && { FX_WAIT_REQUEST_LOG: log }),
      },
    }
  }
  const mcpPath = join(root, 'mcp.json')
  writeFileSync(mcpPath, JSON.stringify({ mcpServers }))
  // Prompts sent, in order: they identify the main conversation and its turns
  // (no marker in the prompt itself, which models can read as injected text).
  return { root, ws, log, env, mcpPath, prompts: [], target, scenario, callLog: join(root, 'calls.jsonl'), instrFile: name => join(root, 'instr', `${name}.txt`) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const preload = pathToFileURL(join(HERE, 'net.mjs')).href

/**
 * Live first-party: tau's Anthropic login lives in the config dir, which is
 * sealed here, so the subscription token goes to the child through the env
 * var tau already reads. Straight into the child's environment, never printed.
 */
function anthropicLoginEnv() {
  const file = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', '.credentials.json')
  if (!existsSync(file)) return {}
  const value = JSON.parse(readFileSync(file, 'utf8'))?.claudeAiOauth?.accessToken
  return value ? { CLAUDE_CODE_OAUTH_TOKEN: value } : {}
}

// ── print mode over stream-json ────────────────────────────────────────────
async function printSession(ctx, steps, extraArgs = []) {
  const child = spawn(process.execPath, ['--import', preload, CLI,
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', ctx.target.model, '--mcp-config', ctx.mcpPath, '--strict-mcp-config', ...extraArgs],
  { cwd: ctx.ws, env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const t0 = Date.now()
  const results = []
  const controls = new Map()
  let sessionId
  let out = ''
  let err = ''
  let buf = ''
  child.stdout.on('data', d => {
    out += d
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.session_id && !sessionId) sessionId = m.session_id
      if (m.type === 'result') results.push(m)
      if (m.type === 'control_response') controls.set(m.response?.request_id, m.response)
    }
  })
  child.stderr.on('data', d => { err += d })
  const exited = new Promise(r => child.on('exit', c => r(c)))
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(100); return pred() }
  const send = m => child.stdin.write(JSON.stringify(m) + '\n')
  for (const step of steps) {
    step.startedAt = Date.now()
    if (step.user || step.raw) {
      const n = results.length + 1
      const content = step.raw ?? step.user
      if (step.user && !ctx.prompts.some(p => p.text === step.user)) ctx.prompts.push({ turn: Number(step.turn.slice(1)), text: step.user })
      send({ type: 'user', session_id: '', message: { role: 'user', content }, parent_tool_use_id: null })
      await waitFor(() => results.length >= n, TURN_TIMEOUT)
    } else if (step.at) {
      const wait = step.at - (Date.now() - t0)
      if (wait > 0) await sleep(wait)
    } else if (step.control) {
      const request_id = `lmi-${randomBytes(3).toString('hex')}`
      send({ type: 'control_request', request_id, request: step.control })
      await waitFor(() => controls.has(request_id), 60_000)
      step.response = controls.get(request_id)
    } else if (step.do) {
      await step.do()
    }
  }
  child.stdin.end()
  const code = await Promise.race([exited, sleep(30_000).then(() => { child.kill(); return 'timeout' })])
  appendFileSync(join(ctx.root, 'stdout.jsonl'), out)
  appendFileSync(join(ctx.root, 'stderr.txt'), err)
  return { code, results, sessionId, out, err }
}

// ── the interactive REPL in a pseudo-terminal ──────────────────────────────
async function replSession(ctx, prompt, doneWhen, timeoutMs) {
  ctx.prompts.push({ turn: 1, text: prompt })
  const pty = require(join(REPO, 'node_modules', 'node-pty'))
  const { Terminal } = require(require.resolve('@xterm/headless', { paths: [HERE] }))
  const cols = 140
  const rows = 45
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  const p = pty.spawn(process.execPath, ['--import', preload, CLI,
    '--model', ctx.target.model, '--mcp-config', ctx.mcpPath, '--strict-mcp-config', prompt],
  { name: 'xterm-256color', cols, rows, cwd: ctx.ws, env: ctx.env })
  p.onData(d => term.write(d))
  term.onData(d => p.write(d))
  let exited = false
  p.onExit(() => { exited = true })
  const end = Date.now() + timeoutMs
  let done = false
  while (!exited && Date.now() < end) {
    await sleep(500)
    if (doneWhen(readLog(ctx.log))) { done = true; break }
  }
  await sleep(2000)
  if (!exited) { try { p.kill() } catch {} }
  await sleep(1000)
  const screen = []
  for (let y = 0; y < term.buffer.active.length; y++) screen.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  writeFileSync(join(ctx.root, 'screen.txt'), screen.join('\n'))
  return { done, exited, texts: transcriptTexts(ctx) }
}

/** The REPL's turn is over: the last main request answered and nothing new for 6 s. */
function turnOver(ctx, extra = () => true) {
  const r = requests(ctx).filter(x => x.conv === 'main')
  const last = r.at(-1)
  // `end`, not usage: Anthropic reports usage when the stream starts.
  if (!last || !last.end || !extra(r)) return false
  const latest = Math.max(...readLog(ctx.log).map(e => e.t ?? 0))
  return Date.now() - latest > 6000
}

/** Final assistant texts from the sealed transcript (live answer checks). */
function transcriptTexts(ctx) {
  const dir = join(ctx.root, 'config', 'projects')
  const texts = []
  if (!existsSync(dir)) return texts
  for (const project of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, project)).filter(f => f.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(dir, project, f), 'utf8').split('\n')) {
        let m
        try { m = JSON.parse(line) } catch { continue }
        if (m.type !== 'assistant' || m.isSidechain) continue
        const t = (m.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
        if (t.trim()) texts.push(t)
      }
    }
  }
  return texts
}

// ── reading the request log ────────────────────────────────────────────────
function readLog(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
const count = (s, needle) => (needle ? s.split(needle).length - 1 : 0)
/** code -> server, filled when a scenario writes a server's instructions. */
const codeServer = new Map()
/**
 * How one delivery of a server's instructions shows up in a request body
 * (JSON text, so the newline is the two characters \n): the rendered block,
 * a `## <server>` line then the text, which every channel uses (system
 * prompt, frozen block, reminder). A model's own quote of the sentence (an
 * answer, a compaction summary) does not carry that header.
 */
const mk = code => `## ${codeServer.get(code)}\\nCodeword: ${code}. Whenever you call`
function requests(ctx) {
  const entries = readLog(ctx.log)
  const usage = new Map()
  const ends = new Map()
  for (const e of entries) {
    if (e.kind === 'usage') usage.set(e.id, e.usage)
    if (e.kind === 'end') ends.set(e.id, e)
  }
  return entries.filter(e => e.kind === 'req' && e.main && e.body).map(e => {
    const f = e.format === 'ollama' ? 'chat' : e.format
    const all = JSON.stringify(e.body)
    // A prompt appears in the body JSON-escaped (quotes, backslashes).
    const esc = t => JSON.stringify(t).slice(1, -1)
    const turns = ctx.prompts.filter(p => all.includes(esc(p.text))).map(p => p.turn)
    return {
      id: e.id, t: e.t, pid: e.pid, format: f, body: e.body, all,
      conv: ctx.scenario === 'subagent' && !all.includes(esc(ctx.prompts[0]?.text ?? 'LMI-MAIN')) ? 'sub' : 'main',
      turn: turns.length ? Math.max(...turns) : 0,
      tools: view(f, e.body).tools,
      usage: usage.get(e.id), end: ends.get(e.id),
    }
  })
}
/** The request as the model reads it, oldest first (Kiro sends currentMessage before history). */
function ordered(r) {
  if (r.format !== 'kiro') return r.all
  const state = r.body.conversationState ?? {}
  return JSON.stringify(state.history ?? []) + JSON.stringify(state.currentMessage ?? {})
}
const offers = (r, server) => r.tools.some(n => n.startsWith(`mcp__${server}__`)) ||
  [...r.all.matchAll(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/g)]
    .some(match => match[0].includes(`mcp__${server}__`))

function prefixIssues(list) {
  const issues = []
  for (let i = 1; i < list.length; i++) {
    const a = canonical(list[i - 1].format, list[i - 1].body)
    const b = canonical(list[i].format, list[i].body)
    const at = `#${i}`
    if (JSON.stringify(a.system) !== JSON.stringify(b.system)) issues.push(`${at} system changed`)
    if (JSON.stringify(a.tools) !== JSON.stringify(b.tools)) issues.push(`${at} tools changed`)
    const am = a.messages ?? []
    const bm = b.messages ?? []
    if (bm.length < am.length) { issues.push(`${at} history shrank`); continue }
    for (let k = 0; k < am.length; k++) {
      if (JSON.stringify(stripMarkers(am[k])) !== JSON.stringify(stripMarkers(bm[k]))) {
        const flat = v => JSON.stringify(stripMarkers(v), (key, x) => Array.isArray(x) && x.length === 1 && x[0]?.type === 'text' && typeof x[0].text === 'string' ? x[0].text : x)
        // Tool search lists deferred tools in a leading message; a tool that
        // joins changes it with the tool list (tools side, same on HEAD).
        // Kiro has no system role: its lane puts the system text, with a tool
        // guide that counts the MCP tools, into history message 0.
        const withoutDeferredCatalog = m => JSON.stringify(stripMarkers(m), (key, value) => {
          if (typeof value !== 'string') return value
          let text = value.replace(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/g, '<available-deferred-tools/>')
          if (list[i].format === 'kiro' && k === 0 && JSON.stringify(a.tools) !== JSON.stringify(b.tools)) {
            text = text.replace(/^- MCP server tools: \d+ tool\(s\) named mcp__\* are available; use the exact tool name shown in the tool list when you need one\.\n?/gm, '')
          }
          return text
        })
        const deferredList = withoutDeferredCatalog(am[k]) === withoutDeferredCatalog(bm[k])
        issues.push(`${at} message ${k} ${flat(am[k]) === flat(bm[k]) ? 're-encoded (same text)' : deferredList ? 'deferred-tools list changed' : 'rewritten'}`)
        if (!deferredList) break
      }
    }
  }
  return issues
}

/** Provider-reported prompt size and cache reads, normalized. */
function cacheOf(r) {
  const u = r.usage
  if (!u) return null
  let total
  let read
  if (r.format === 'anthropic' || (u.cache_read_input_tokens !== undefined && u.prompt_tokens === undefined)) {
    read = u.cache_read_input_tokens ?? 0
    total = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0)
  } else if (u.promptTokenCount !== undefined) {
    total = u.promptTokenCount
    read = u.cachedContentTokenCount ?? 0
  } else {
    total = u.prompt_tokens ?? u.input_tokens
    read = u.cached_tokens ?? u.cache_read_input_tokens ?? 0
  }
  return total ? { total, read } : null
}

// ── checks ─────────────────────────────────────────────────────────────────
function checker() {
  const list = []
  const check = (pass, label, detail = '') => { list.push({ pass: pass === true ? true : pass === null ? null : false, label, detail }) }
  return { list, check }
}

/** Every request that offers `server`'s tools carries `code` exactly once; none before. */
function deliverChecks(check, reqs, server, code, label) {
  const offering = reqs.filter(r => offers(r, server))
  const bad = offering.filter(r => count(r.all, mk(code)) !== 1)
  check(offering.length > 0 && bad.length === 0, `${label}: instructions with every request offering ${server}`,
    offering.length === 0 ? 'no request offered it' : bad.map(r => `${r.id}: ${count(r.all, mk(code))}x`).join(' '))
  const early = reqs.filter(r => !offers(r, server) && count(r.all, mk(code)) > 0 && !r.all.includes('no longer apply'))
  check(early.length === 0, `${label}: no ${server} instructions before its tools`, early.map(r => r.id).join(' '))
}

function prefixCheck(check, reqs, label, { toolsMayChange = false } = {}) {
  const byConv = {}
  for (const r of reqs) (byConv[`${r.pid}:${r.conv}`] ??= []).push(r)
  for (const [key, list] of Object.entries(byConv)) {
    if (list.length < 2) continue
    const issues = prefixIssues(list)
    const real = issues.filter(i => !/re-encoded/.test(i) && !(toolsMayChange && /tools changed|deferred-tools list changed/.test(i)))
    check(real.length === 0, `${label}: prefix kept (${key.split(':')[1]}, ${list.length} requests)`, issues.join('; '))
  }
}

/**
 * Live: did the model act on the server's instructions? The server logs every
 * call; the instructions ask for note = the code on each probe call, so a
 * call carrying the current code (and, after a change, not the old one) is
 * the model following what it was told. Nothing asks it to reveal anything.
 */
function followCheck(check, ctx, server, code, label, { since = 0, notCode } = {}) {
  if (NET !== 'live') return
  const mine = readLog(ctx.callLog).filter(c => c.server === server && c.t >= since)
  const notes = mine.map(c => String(c.args?.note ?? '').trim())
  const ok = notes.includes(code) && !(notCode && notes.includes(notCode))
  check(ok, `${label}: model followed ${server}'s instructions`, mine.length ? `notes: ${notes.map(n => n || '(none)').join(', ')}` : 'no probe call')
}

function cacheReport(reqs) {
  if (NET !== 'live') return ''
  const rows = []
  const byConv = {}
  for (const r of reqs) (byConv[`${r.pid}:${r.conv}`] ??= []).push(r)
  for (const [key, list] of Object.entries(byConv)) {
    let prev = null
    for (const r of list) {
      const c = cacheOf(r)
      rows.push(`${key.split(':')[1]} T${r.turn} ${c ? `prompt=${c.total} read=${c.read}${prev ? ` (${Math.round((100 * c.read) / prev)}% of previous prompt)` : ''}` : 'no usage reported'}`)
      if (c) prev = c.total
    }
  }
  return rows.join('\n        ')
}

// ── scenarios ──────────────────────────────────────────────────────────────
const PROBE = server => `Use the ${server} server's probe tool once to check that it is reachable, then reply with the single word: done.`
const PROBE_AGAIN = server => `Use the ${server} server's probe tool once more, then reply with the single word: done.`

const SCENARIO = {
  async late(target) {
    const E = token('EARLY')
    const L = token('LATE')
    const ctx = setup(target, 'late', [{ name: 'lmi_early', code: E }, { name: 'lmi_late', code: L, release: true }], { TAU_MCP_LAUNCH_WAIT_MS: '6000' })
    const steps = [
      { turn: 'T1', user: PROBE('lmi_early') },
      { do: async () => {
        const file = join(ctx.root, 'lmi_late.release')
        writeFileSync(file, '')
        const deadline = Date.now() + 20_000
        while (!existsSync(`${file}.ready`) && Date.now() < deadline) await sleep(50)
        if (!existsSync(`${file}.ready`)) throw new Error('late server failed to list tools')
        await sleep(500)
      } },
      { turn: 'T2', user: PROBE('lmi_late') },
      { turn: 'T3', user: 'Reply with the single word: done.' },
    ]
    const run = await printSession(ctx, steps)
    const reqs = requests(ctx).filter(r => r.conv === 'main')
    const { list, check } = checker()
    const t1 = reqs.filter(r => r.turn === 1)
    check(t1.length > 0 && !t1.some(r => offers(r, 'lmi_late')), 'setup: lmi_late not connected at turn 1', t1.map(r => r.tools.length).join(','))
    const earlyAtT1 = t1.length > 0 && offers(t1[0], 'lmi_early')
    check(earlyAtT1, 'setup: lmi_early connected by turn 1', earlyAtT1 ? '' : 'server missed the startup window')
    deliverChecks(check, reqs, 'lmi_early', E, 'early')
    deliverChecks(check, reqs, 'lmi_late', L, 'late')
    prefixCheck(check, reqs, 'late', { toolsMayChange: true })
    if (earlyAtT1) followCheck(check, ctx, 'lmi_early', E, 'T1')
    followCheck(check, ctx, 'lmi_late', L, 'T2')
    return { list, run, reqs }
  },

  async subagent(target) {
    const E = token('EARLY')
    const ctx = setup(target, 'subagent', [{ name: 'lmi_early', code: E }])
    const run = await printSession(ctx, [
      { turn: 'T1', user: "Please delegate this to a general-purpose subagent using the Agent tool: have it use the lmi_early server's probe tool once to check that it is reachable. Then reply with the single word: done." },
    ])
    const all = requests(ctx)
    const subs = all.filter(r => r.conv === 'sub')
    const { list, check } = checker()
    check(subs.length > 0, 'a sub-agent ran', `${subs.length} sub-agent requests`)
    if (subs.length) {
      const first = subs[0]
      check(offers(first, 'lmi_early') && count(first.all, mk(E)) === 1, 'sub-agent: instructions in its FIRST request', `${count(first.all, mk(E))}x, offers=${offers(first, 'lmi_early')}`)
      deliverChecks(check, subs, 'lmi_early', E, 'sub-agent')
      prefixCheck(check, subs, 'sub-agent')
    }
    deliverChecks(check, all.filter(r => r.conv === 'main'), 'lmi_early', E, 'main')
    followCheck(check, ctx, 'lmi_early', E, 'sub-agent')
    return { list, run, reqs: all }
  },

  async reconnect(target) {
    const V1 = token('VAULTA')
    const V2 = token('VAULTB')
    const ctx = setup(target, 'reconnect', [{ name: 'lmi_vault', code: V1 }])
    const steps = [
      { turn: 'T1', user: PROBE('lmi_vault') },
      { do: async () => { codeServer.set(V2, 'lmi_vault'); writeFileSync(ctx.instrFile('lmi_vault'), instructionsFor('lmi_vault', V2)) } },
      { control: { subtype: 'mcp_reconnect', serverName: 'lmi_vault' } },
      { turn: 'T2', user: PROBE_AGAIN('lmi_vault') },
      { turn: 'T3', user: 'Reply with the single word: done.' },
    ]
    const run = await printSession(ctx, steps)
    const reqs = requests(ctx).filter(r => r.conv === 'main')
    const { list, check } = checker()
    check(steps[2].response?.subtype === 'success', 'setup: reconnect succeeded', JSON.stringify(steps[2].response ?? null))
    const t1 = reqs.filter(r => r.turn === 1)
    const after = reqs.filter(r => r.turn >= 2)
    check(t1.length > 0 && t1.every(r => count(r.all, mk(V1)) === 1 && count(r.all, mk(V2)) === 0), 'turn 1: first text once', t1.map(r => `${count(r.all, mk(V1))}/${count(r.all, mk(V2))}`).join(' '))
    check(after.length > 0 && after.every(r => count(r.all, mk(V2)) === 1), 'after reconnect: new text once in every request', after.map(r => `${r.id}: ${count(r.all, mk(V2))}x`).join(' '))
    check(after.length > 0 && after.every(r => ordered(r).indexOf(mk(V2)) > ordered(r).indexOf(mk(V1)) && r.all.includes('Updated MCP Server Instructions')), 'after reconnect: announced as replacing the earlier text')
    prefixCheck(check, reqs, 'reconnect')
    followCheck(check, ctx, 'lmi_vault', V1, 'T1')
    followCheck(check, ctx, 'lmi_vault', V2, 'T2 (after reconnect)', { since: steps[3].startedAt, notCode: V1 })
    return { list, run, reqs }
  },

  async disable(target) {
    const E = token('EARLY')
    const G = token('GONE')
    const ctx = setup(target, 'disable', [{ name: 'lmi_early', code: E }, { name: 'lmi_gone', code: G }])
    const steps = [
      { turn: 'T1', user: PROBE('lmi_gone') },
      { control: { subtype: 'mcp_toggle', serverName: 'lmi_gone', enabled: false } },
      { turn: 'T2', user: 'Which MCP servers can you use right now? Reply with their names only.' },
    ]
    const run = await printSession(ctx, steps)
    const reqs = requests(ctx).filter(r => r.conv === 'main')
    const { list, check } = checker()
    check(steps[1].response?.subtype === 'success', 'setup: server switched off', JSON.stringify(steps[1].response ?? null))
    const after = reqs.filter(r => r.turn >= 2)
    const stillDeclared = after.some(r => r.tools.some(n => n.includes('lmi_gone')))
    check(after.length > 0 && !stillDeclared, 'after: lmi_gone tools no longer declared', stillDeclared ? 'still declared' : '')
    check(after.length > 0 && after.every(r => {
      const o = ordered(r)
      const i = o.lastIndexOf('no longer apply')
      return i > o.lastIndexOf(mk(G)) && o.indexOf('lmi_gone', i) > i
    }), 'after: retraction naming lmi_gone, after its instructions')
    deliverChecks(check, reqs, 'lmi_early', E, 'lmi_early untouched')
    prefixCheck(check, reqs, 'disable', { toolsMayChange: true })
    followCheck(check, ctx, 'lmi_gone', G, 'T1')
    return { list, run, reqs, note: `T2 answer: ${JSON.stringify((run.results[1]?.result ?? '').slice(0, 160))}` }
  },

  async resume(target) {
    const E = token('EARLY')
    const ctx = setup(target, 'resume', [{ name: 'lmi_early', code: E }])
    const a = await printSession(ctx, [{ turn: 'T1', user: PROBE('lmi_early') }])
    const resumedAt = Date.now()
    const b = await printSession(ctx, [{ turn: 'T2', user: PROBE_AGAIN('lmi_early') }], ['--resume', a.sessionId ?? 'missing'])
    const reqs = requests(ctx).filter(r => r.conv === 'main')
    const { list, check } = checker()
    const resumed = reqs.filter(r => r.turn >= 2)
    check(resumed.length > 0, 'resumed process sent requests', `${resumed.length}`)
    check(resumed.length > 0 && resumed.every(r => count(r.all, mk(E)) === 1), 'resumed: instructions exactly once', resumed.map(r => `${count(r.all, mk(E))}x`).join(' '))
    deliverChecks(check, reqs, 'lmi_early', E, 'resume')
    followCheck(check, ctx, 'lmi_early', E, 'T1')
    followCheck(check, ctx, 'lmi_early', E, 'T2 (resumed)', { since: resumedAt })
    return { list, run: { code: `${a.code}/${b.code}`, results: [...a.results, ...b.results], err: a.err + b.err }, reqs }
  },

  async compact(target) {
    const E = token('EARLY')
    const ctx = setup(target, 'compact', [{ name: 'lmi_early', code: E }])
    const steps = [
      { turn: 'T1', user: PROBE('lmi_early') },
      { turn: 'T1', raw: '/compact' },
      { turn: 'T2', user: PROBE_AGAIN('lmi_early') },
    ]
    const run = await printSession(ctx, steps)
    const reqs = requests(ctx).filter(r => r.conv === 'main')
    const { list, check } = checker()
    const after = reqs.filter(r => r.turn >= 2)
    check(after.length > 0 && after.every(r => r.all.includes('being continued from a previous conversation')), 'setup: T2 runs on a compacted conversation', `${after.length} requests`)
    check(after.length > 0 && after.every(r => count(r.all, mk(E)) === 1), 'after compaction: instructions exactly once (re-announced, not doubled)', after.map(r => `${count(r.all, mk(E))}x`).join(' '))
    followCheck(check, ctx, 'lmi_early', E, 'T2 (after compaction)', { since: steps[2].startedAt })
    return { list, run, reqs }
  },

  async custom(target) {
    const E = token('EARLY')
    const ctx = setup(target, 'custom', [{ name: 'lmi_early', code: E }])
    const run = await printSession(ctx, [{ turn: 'T1', user: PROBE('lmi_early') }],
      ['--system-prompt', 'You are a concise assistant. Use tools when needed.'])
    const reqs = requests(ctx).filter(r => r.conv === 'main')
    const { list, check } = checker()
    deliverChecks(check, reqs, 'lmi_early', E, 'custom system prompt')
    followCheck(check, ctx, 'lmi_early', E, 'T1')
    return { list, run, reqs }
  },

  async turn1(target) {
    const S = token('SLOW')
    const ctx = setup(target, 'turn1', [{ name: 'lmi_slow', code: S, delayMs: 3_000 }], { TAU_MCP_LAUNCH_WAIT_MS: '15000' })
    const repl = await replSession(ctx, PROBE('lmi_slow'), () => turnOver(ctx), NET === 'live' ? 240_000 : 90_000)
    const reqs = requests(ctx).filter(r => r.conv === 'main')
    const { list, check } = checker()
    check(reqs.length > 0, 'REPL sent the first request', `${reqs.length} requests, done=${repl.done}`)
    if (reqs.length) check(offers(reqs[0], 'lmi_slow') && count(reqs[0].all, mk(S)) === 1, 'first request: server connected in the launch wait has its instructions', `offers=${offers(reqs[0], 'lmi_slow')} count=${count(reqs[0].all, mk(S))}`)
    deliverChecks(check, reqs, 'lmi_slow', S, 'turn1')
    followCheck(check, ctx, 'lmi_slow', S, 'T1')
    return { list, run: { code: repl.exited ? 'exited' : 'killed', results: [] }, reqs }
  },

  async midturn(target) {
    const L = token('LATE')
    const ctx = setup(target, 'midturn', [{ name: 'lmi_late', code: L, afterFirstRequest: true }], { TAU_MCP_LAUNCH_WAIT_MS: '1500' })
    const repl = await replSession(ctx,
      // Live: a quote-free delay that runs the same in bash, PowerShell and cmd
      // (a model that mangles the quotes of `node -e "..."` never gets to the probe).
      `First run this exact shell command and wait for it to finish: ${NET === 'live' ? 'ping -n 16 127.0.0.1' : 'node -e "setTimeout(()=>{},4000)"'} . When it has finished, use the lmi_late server's probe tool once, then reply with the single word: done.`,
      () => turnOver(ctx, r => r.length >= 2 && r.some(x => offers(x, 'lmi_late'))),
      NET === 'live' ? 300_000 : 120_000)
    const reqs = requests(ctx).filter(r => r.conv === 'main')
    const { list, check } = checker()
    check(reqs.length >= 2 && !offers(reqs[0], 'lmi_late'), 'setup: lmi_late connected after the first request, during the tool call', `${reqs.length} requests; first offers lmi_late=${reqs.length ? offers(reqs[0], 'lmi_late') : '-'}`)
    const firstWith = reqs.find(r => offers(r, 'lmi_late'))
    check(firstWith ? count(firstWith.all, mk(L)) === 1 : false, 'first request offering the new tools carries their instructions', firstWith ? `${firstWith.id}: ${count(firstWith.all, mk(L))}x` : 'no request offered lmi_late')
    deliverChecks(check, reqs, 'lmi_late', L, 'midturn')
    prefixCheck(check, reqs, 'midturn', { toolsMayChange: true })
    followCheck(check, ctx, 'lmi_late', L, 'mid-turn')
    return { list, run: { code: repl.exited ? 'exited' : 'killed', results: [] }, reqs }
  },

  // Optional companion to midturn: exercise QueryEngine/SDK refresh, rather
  // than the REPL's callback. It needs no second user turn to discover MCP.
  async sdkmidturn(target) {
    const L = token('LATE')
    const ctx = setup(target, 'sdkmidturn', [{ name: 'lmi_late', code: L, afterFirstRequest: true }], { TAU_MCP_LAUNCH_WAIT_MS: '1500' })
    const command = NET === 'live' ? 'ping -n 16 127.0.0.1' : 'node -e "setTimeout(()=>{},4000)"'
    const run = await printSession(ctx, [{ turn: 'T1', user: `First run this exact shell command and wait for it to finish: ${command} . When it has finished, use the lmi_late server's probe tool once, then reply with the single word: done.` }])
    const reqs = requests(ctx).filter(r => r.conv === 'main')
    const { list, check } = checker()
    check(reqs.length >= 2 && !offers(reqs[0], 'lmi_late'), 'setup: server connected after the first SDK request')
    deliverChecks(check, reqs, 'lmi_late', L, 'SDK midturn')
    prefixCheck(check, reqs, 'SDK midturn', { toolsMayChange: true })
    followCheck(check, ctx, 'lmi_late', L, 'SDK midturn')
    return { list, run, reqs }
  },

  async nomcp(target) { return modeWithoutMcp(target, 'normal') },
  async cheap(target) { return modeWithoutMcp(target, 'cheap') },
  async nomcprepl(target) { return modeWithoutMcp(target, 'normal', true) },
  async cheaprepl(target) { return modeWithoutMcp(target, 'cheap', true) },
}

async function modeWithoutMcp(target, mode, interactive = false) {
  if (mode === 'cheap' && target.provider === 'antigravity') throw new Error('Antigravity deliberately does not support cheap mode')
  const code = token('HIDDEN')
  const servers = mode === 'cheap' ? [{ name: 'lmi_hidden', code }] : []
  const scenario = `${mode === 'cheap' ? 'cheap' : 'nomcp'}${interactive ? 'repl' : ''}`
  const ctx = setup(target, scenario, servers, {}, { powerMode: mode })
  const run = interactive ? await replSession(ctx, 'Reply with the single word: ready.', () => turnOver(ctx), TURN_TIMEOUT) : await printSession(ctx, [
    { turn: 'T1', user: 'Reply with the single word: ready.' },
    { turn: 'T2', user: 'Reply with the single word: done.' },
  ])
  const reqs = requests(ctx).filter(r => r.conv === 'main')
  const { list, check } = checker()
  const enoughRequests = reqs.length >= (interactive ? 1 : 2)
  check(interactive ? run.done && reqs.at(-1)?.end?.status === 200 : run.results.length === 2 && run.results.every(r => !r.is_error), 'ordinary conversation completed')
  check(enoughRequests && reqs.every(r => r.tools.some(n => ['Bash', 'shell', 'run_shell_command'].includes(n))), 'core shell tool remains available')
  check(enoughRequests && reqs.every(r => !r.tools.some(n => n.startsWith('mcp__'))), 'no MCP tools exposed')
  check(enoughRequests && reqs.every(r => !r.all.includes(code) && !r.all.includes('MCP configuration update:')), 'no MCP instruction updates sent')
  check(!existsSync(join(ctx.root, 'server-starts.jsonl')), 'no MCP server process launched')
  // Setup rules must reach providers even before the first server is added.
  // Check the serialized requests, not just the shared prompt generator.
  for (const rule of ['one executable and a separate argument array',
    'Do not add a shell wrapper', 'local overrides project',
    'successful add only saves configuration', 'redact secrets']) {
    check(enoughRequests && reqs.every(r => r.all.includes(rule)), `setup guidance delivered: ${rule}`)
  }
  prefixCheck(check, reqs, `${mode} without MCP`)
  return { list, run, reqs }
}

// ── main ───────────────────────────────────────────────────────────────────
const summary = []
for (const target of TARGETS) {
  for (const name of SCENARIOS) {
    if (completedCases.has(`${target.provider}:${target.model}:${name}`)) continue
    const started = Date.now()
    // The local server (Anthropic and Responses lanes) scripts in this process.
    process.env.E2E_SCENARIO = name
    let res
    try {
      res = await SCENARIO[name](target)
    } catch (e) {
      res = { list: [{ pass: false, label: 'harness error', detail: String(e?.stack ?? e).slice(0, 400) }], run: {}, reqs: [] }
    }
    res.list.push({
      pass: !!res.reqs?.length && !res.reqs.some(r => hasInstructionsInsideToolOutput(r.body)),
      label: 'MCP configuration is separate from tool output on the wire',
    })
    if (target.provider === 'antigravity') {
      res.list.push({
        pass: !!res.reqs?.length && res.reqs.every(r => r.format === 'antigravity' && r.body.userAgent === 'antigravity'),
        label: 'requests actually use the Antigravity route',
      })
    }
    const failed = res.list.filter(c => c.pass === false)
    const unknown = res.list.filter(c => c.pass === null)
    const verdict = failed.length ? 'FAIL' : unknown.length ? 'N/A ' : 'OK  '
    console.log(`${verdict} ${target.provider.padEnd(12)} ${target.model.padEnd(34)} ${name.padEnd(9)} ${Math.round((Date.now() - started) / 1000)}s, ${res.reqs?.length ?? 0} model requests, exit=${res.run?.code}`)
    for (const c of res.list) if (c.pass !== true) console.log(`       ${c.pass === null ? 'n/a ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`)
    if (res.note) console.log(`       note: ${res.note}`)
    const cache = cacheReport(res.reqs ?? [])
    if (cache) console.log(`       cache: ${cache}`)
    if (!res.reqs?.length && res.run) {
      const why = `${res.run.err ?? ''} ${(res.run.results ?? []).map(r => r.result ?? r.subtype).join(' | ')}`.replace(/\s+/g, ' ').trim()
      if (why) console.log(`       why: ${why.slice(-500)}`)
    }
    const errs = readLog(join(OUT, target.provider, name, 'requests.jsonl')).filter(e => e.kind === 'end' && e.status >= 400)
    for (const e of errs.slice(0, 2)) console.log(`       http ${e.status}: ${(e.error ?? '').replace(/\s+/g, ' ').slice(0, 300)}`)
    summary.push({ provider: target.provider, model: target.model, scenario: name, verdict: verdict.trim(), checks: res.list, note: res.note,
      answers: (res.run?.results ?? []).map(r => r.result), cache: cache || undefined })
    writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
  }
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
process.exit(summary.some(row => row.verdict === 'FAIL') ? 1 : 0)
