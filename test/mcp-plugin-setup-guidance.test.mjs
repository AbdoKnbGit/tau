import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
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
