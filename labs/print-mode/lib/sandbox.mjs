// One throwaway folder per scenario. Offline runs also get their own home, settings and fake sign-ins, so
// they can never read or change your real account. Real runs keep your real settings and only use a
// throwaway working folder.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FAR_FUTURE = 4102444800000
const FIXTURE_KEY = 'sk-ant-lab-fixture-key-0000000001'

export const ROUTES = {
  anthropic: { provider: 'firstParty', model: 'claude-sonnet-4-6' },
  agy: { provider: 'antigravity', model: 'gemini-3.8-flash-high' },
}
const KEY_PROVIDERS = ['openai', 'openrouter', 'agentrouter', 'vercel', 'requesty', 'opencode', 'opencodego', 'commandcode', 'lxd', 'mimo', 'fireworks', 'mistral', 'nim', 'deepseek', 'glm', 'moonshot', 'minimax', 'alibaba', 'xai', 'meta']
const OAUTH_PROVIDERS = ['cline', 'clinepass', 'copilot', 'kilocode', 'kiro', 'iflow']

export function routeFor(name) {
  return ROUTES[name] ?? { provider: name, model: undefined }
}

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

/** The sample project every scenario starts from. Also used for the --play folder. */
export function writeSampleProject(workspace) {
  write(join(workspace, 'notes.txt'), 'Pineapple is the first word of this file.\n')
  write(join(workspace, 'second.txt'), 'Mango is the first word of the second file.\n')
  write(join(workspace, 'src', 'app.js'), "console.log('old text')\n")
  write(join(workspace, 'secret', 'hidden.txt'), 'Papaya is in a folder you may want to protect.\n')
  // .mjs, so it runs the same inside a folder whose package.json sets a module type.
  write(join(workspace, 'make-file.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync('made-by-script.txt', 'made by a script')\n")
}

export function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'tau-lab-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  writeSampleProject(workspace)
  write(join(outside, 'far.txt'), 'Coconut lives outside the working folder.\n')
  return {
    root, workspace, outside,
    places: { workspace, outside, outsideSlash: outside.replaceAll('\\', '/') },
    remove() { try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch {} },
  }
}

/** Fake sign-ins, an MCP server when a scenario needs one, and an environment with no way to the real account. */
export function offlineEnvironment(box, route, setup = {}) {
  const home = join(box.root, 'home')
  const config = join(box.root, 'config')
  const isAnthropic = route.provider === 'firstParty'
  const keyDecision = setup.key ?? 'approved'
  const lastTwenty = FIXTURE_KEY.slice(-20)
  write(join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    activeProvider: route.provider,
    customApiKeyResponses: isAnthropic
      ? { approved: keyDecision === 'approved' ? [lastTwenty] : [], rejected: keyDecision === 'rejected' ? [lastTwenty] : [] }
      : { approved: [], rejected: [] },
  }))
  if (setup.login) {
    write(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'lab-fixture-login-token', refreshToken: 'lab-fixture-refresh', expiresAt: FAR_FUTURE, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: null } }))
  }
  for (const [path, content] of Object.entries(setup.files ?? {})) {
    write(join(box.workspace, path), typeof content === 'string' ? content : JSON.stringify(content))
  }

  const google = JSON.stringify({ accessToken: 'lab-fixture-google-token', refreshToken: 'lab-fixture-google-refresh', expiresAt: FAR_FUTURE })
  const keys = { gemini_oauth_antigravity: google, gemini_oauth_cli: google }
  for (const name of KEY_PROVIDERS) keys[name] = `lab-fixture-${name}-key-00000000`
  for (const name of OAUTH_PROVIDERS) keys[`${name}_oauth`] = JSON.stringify({ accessToken: `lab-fixture-${name}-token-000000`, refreshToken: 'lab-fixture-refresh', expiresAt: FAR_FUTURE, meta: { apiKey: `lab-fixture-${name}-key` } })
  write(join(home, '.config', 'claude-code', 'provider-keys.json'), JSON.stringify({ version: 1, keys, metadata: {} }))

  // Answers the CLI's background update check at once, so nothing outlives a run and holds this folder.
  const stubBin = join(box.root, 'bin')
  write(join(stubBin, 'npm.cmd'), '@echo off\r\necho 0.0.0\r\n')
  write(join(stubBin, 'npm'), '#!/bin/sh\necho 0.0.0\n')
  chmodSync(join(stubBin, 'npm'), 0o755)

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GOOGLE_|TAU_|CLAUDEX|CODEX_|CI$|ENABLE_TOOL_SEARCH|NODE_PATH$|NODE_OPTIONS$|NODE_ENV$|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(name)))
  const pathName = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathName] = `${stubBin}${delimiter}${env[pathName] ?? ''}`
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(box.root, 'appdata'), LOCALAPPDATA: join(box.root, 'localappdata'), XDG_CONFIG_HOME: join(home, '.config'),
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(box.root, 'cache'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1',
    NODE_OPTIONS: `--import=${pathToFileURL(join(here, 'fake-model.mjs')).href}`,
    ...(isAnthropic && setup.key !== 'none' && { ANTHROPIC_API_KEY: FIXTURE_KEY }),
    ...setup.env,
  })
  return env
}

/** An MCP config for one small local server, for scenarios about MCP tools. */
export function writeMcpConfig(box) {
  const server = join(box.root, 'mcp-echo.js')
  write(server, `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line); if (q.id === undefined) return; let result = {}
  if (q.method === 'initialize') result = { protocolVersion: q.params.protocolVersion, serverInfo: { name: 'echo', version: '1' }, capabilities: { tools: {} } }
  if (q.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a greeting', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to echo' } }, required: ['text'] } }] }
  if (q.method === 'tools/call') result = { content: [{ type: 'text', text: 'lab-echo-reply' }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n') })`)
  const file = join(box.root, 'mcp.json')
  write(file, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [server] } } }))
  return file
}

/** Real runs: your own settings, minus anything the session that started the lab may have set. */
export function realEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDECODE$|CLAUDE_CODE_(?!OAUTH_TOKEN)|TAU_|NODE_OPTIONS$|NODE_PATH$|CI$)/i.test(name)))
  env.DISABLE_AUTOUPDATER = '1'
  return env
}

/**
 * Real runs on a chosen provider: your normal sign-in for it, which lives in your home folder, with
 * throwaway settings, so your active provider is neither read nor changed.
 */
export function realEnvironmentFor(box, route, model) {
  const config = join(box.root, 'config')
  write(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: route.provider }))
  if (model) write(join(config, 'settings.json'), JSON.stringify({ model }))
  const env = realEnvironment()
  env.CLAUDE_CONFIG_DIR = config
  delete env.ANTHROPIC_API_KEY
  return env
}
