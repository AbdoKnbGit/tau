import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Told nothing about how servers and plugins are installed here, the model
// reconstructs a procedure from general knowledge and gets it wrong in ways
// that fail as soon as a user acts on them: writing `mcpServers` into
// settings.json (the wrong file, so the edit silently does nothing), claiming
// plugins are "just MCP servers", and inventing slash commands and package
// names.
//
// Two halves, and the second is the one that matters over time: the prompt
// must carry the guidance, AND every command it names must actually exist in
// the CLI. Guidance that drifts into fiction is worse than none.

const runtime = await loadMcpRuntime()
const CLI = resolve('dist/cli.mjs')

const prompt = (await runtime.getSystemPrompt([], 'claude-opus-5')).join('\n')

function cliHelp(args) {
  return execFileSync(process.execPath, [CLI, ...args, '--help'], {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('the prompt says MCP servers are managed through the CLI', () => {
  assert.match(prompt, /tau mcp add/)
  assert.match(prompt, /tau mcp list|`list`/)
})

test('the prompt corrects the settings.json mistake explicitly', () => {
  // The specific wrong belief observed: an `mcpServers` block hand-written
  // into settings.json, which is silently ignored.
  assert.match(prompt, /NOT in settings\.json/)
  assert.match(prompt, /\.mcp\.json/)
})

test('the prompt says plugins are a separate system from MCP servers', () => {
  assert.match(prompt, /SEPARATE system/)
  assert.match(prompt, /tau plugin/)
  assert.match(prompt, /marketplace/)
})

test('the prompt warns against inventing identifiers', () => {
  // `/install-github-mcp` and `@anthropic/mcp-filesystem` were both invented.
  assert.match(prompt, /Never guess a package name/)
})

test('the prompt teaches the flag-ordering gotcha', () => {
  // Tau's own flags before `--`, the server's after. Getting this wrong makes
  // the CLI reject `-y` as an unknown option.
  assert.match(prompt, /BEFORE `--`/)
})

test('every MCP command the prompt names exists in the CLI', () => {
  const help = cliHelp(['mcp'])
  for (const sub of ['add', 'list', 'get', 'remove']) {
    assert.ok(
      new RegExp(`^\\s+${sub}\\b`, 'm').test(help),
      `the prompt promises \`tau mcp ${sub}\` but the CLI does not offer it`,
    )
  }
})

test('every plugin command the prompt names exists in the CLI', () => {
  const help = cliHelp(['plugin'])
  for (const sub of ['install', 'list', 'enable', 'disable', 'uninstall', 'marketplace']) {
    assert.ok(
      new RegExp(`^\\s+${sub}\\b`, 'm').test(help),
      `the prompt promises \`tau plugin ${sub}\` but the CLI does not offer it`,
    )
  }
})

test('the flags the prompt names exist on `mcp add`', () => {
  const help = cliHelp(['mcp', 'add'])
  for (const flag of ['--transport', '--header', '--env', '--scope']) {
    assert.ok(
      help.includes(flag),
      `the prompt promises ${flag} but \`tau mcp add\` does not offer it`,
    )
  }
})

test('the prompt does not promise tooling that does not exist', () => {
  // Both of these were invented by a model describing this product.
  assert.doesNotMatch(prompt, /install-github-mcp/)
  assert.doesNotMatch(prompt, /@anthropic\/mcp-/)
})

// --- Generality, cache safety, and the call-shape rules ---

test('the CLI name is derived, not spelled out per-site', () => {
  // A rename must not leave the model describing a command that no longer
  // exists, so the guidance and `program.name()` read the same constant.
  const source = readFileSync(resolve('src/constants/prompts.ts'), 'utf8')
  const fn = source.slice(
    source.indexOf('function getMcpAndPluginSetupGuidance'),
    source.indexOf('function getMcpCallShapeGuidance'),
  )
  assert.ok(fn.includes('PRODUCT_COMMAND'), 'guidance must read the shared constant')
  assert.doesNotMatch(
    fn.replace(/PRODUCT_COMMAND/g, ''),
    /\btau\b/,
    'the binary name must not be hardcoded in the guidance text',
  )
})

test('the same inputs produce a byte-identical prompt', async () => {
  // Prefix caching depends on this: a prompt that varies between calls with
  // identical inputs would invalidate the cache on every request.
  const first = (await runtime.getSystemPrompt([], 'claude-opus-5')).join('\n')
  const second = (await runtime.getSystemPrompt([], 'claude-opus-5')).join('\n')
  assert.equal(first, second, 'the prompt must be stable for identical inputs')
})

test('call-shape guidance does not depend on tools present at first build', () => {
  // This section is cached per session by name and rebuilt only on /mode or
  // post-compact. Gating it on "are MCP tools connected right now" would
  // freeze the answer from the first build, so a server connected later in
  // the session would never get the guidance — precisely when a model is most
  // likely to guess at an unfamiliar schema.
  const source = readFileSync(resolve('src/constants/prompts.ts'), 'utf8')
  // The call site is the invocation inside the guidance item list, which sits
  // after the function definitions in this file.
  const callSite = source.slice(source.indexOf('getMcpAndPluginSetupGuidance(),'))
  assert.ok(
    /\n\s*getMcpCallShapeGuidance\(\),/.test(callSite),
    'call-shape guidance must be present in the item list',
  )
  assert.doesNotMatch(
    callSite.slice(0, callSite.indexOf('].filter')),
    /\?\s*getMcpCallShapeGuidance\(\)/,
    'call-shape guidance must be unconditional, not gated on volatile state',
  )
})

test('call-shape guidance names no specific server, tool or field', async () => {
  // The rules must generalize. Anything drawn from one server's API would
  // be hardcoding a single integration into the system prompt.
  const source = readFileSync(resolve('src/constants/prompts.ts'), 'utf8')
  const fn = source.slice(
    source.indexOf('function getMcpCallShapeGuidance'),
    source.indexOf('function getSessionSpecificGuidanceSection'),
  )
  for (const leak of [
    'Claude Docs', 'claude.ai', 'container', 'ifRev', 'engine',
    'block_in_text', 'pending', 'markdown', 'ops', '_raw',
  ]) {
    assert.ok(
      !fn.includes(leak),
      `call-shape guidance must not mention "${leak}" — it has to hold for any server`,
    )
  }
})

test('the call-shape rules cover the mistakes that were observed', async () => {
  const tool = name => ({ name, inputSchema: {}, description: async () => '', prompt: async () => '' })
  const prompt = (await runtime.getSystemPrompt([tool('mcp__srv__do')], 'claude-opus-5')).join('\n')

  // Sent a field the contract did not declare.
  assert.match(prompt, /Adding a field it does not list/)
  // Supplied two ways of addressing one thing.
  assert.match(prompt, /two ways of addressing the same thing/)
  // Guessed a grammar inside a string argument.
  assert.match(prompt, /nested format/)
  // Retried with a newly invented shape instead of reading the diagnostic.
  assert.match(prompt, /Two failures with the same cause/)
  assert.match(prompt, /never invent a field|Never invent a field/)
})

test('guidance contains no OS-specific assumption', () => {
  // Checked against the guidance source, not the rendered prompt: env info
  // legitimately carries the real working directory, which is platform-shaped.
  const source = readFileSync(resolve('src/constants/prompts.ts'), 'utf8')
  const fn = source.slice(
    source.indexOf('function getMcpAndPluginSetupGuidance'),
    source.indexOf('function getSessionSpecificGuidanceSection'),
  )
  for (const leak of ['PowerShell', 'C:\\', '/usr/', 'bash ', '.exe']) {
    assert.ok(
      !fn.includes(leak),
      `setup guidance must not assume an OS ("${leak}")`,
    )
  }
})
