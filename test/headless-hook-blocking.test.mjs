// Runs the shipped CLI with isolated settings and a local provider trap.
// Build first, or set TAU_MCP_TEST_BUNDLE to an isolated cli.mjs build.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'

const cli = resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/cli.mjs')
const privatePrompt = 'PRIVATE_PROMPT_MUST_NOT_BE_ECHOED'

async function runCli(workspace, env, prompt, format) {
  const child = spawn(process.execPath, [cli, '-p', prompt,
    '--model', 'claude-sonnet-4-6', '--output-format', format,
    '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'project',
    ...(format === 'stream-json' ? ['--verbose'] : []),
  ], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 30_000)
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', done)
    })
    assert.equal(timedOut, false, `CLI timed out:\n${stderr}\n${stdout}`)
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

test('headless hook denials report their reason, fail explicitly, and never submit a model request', { timeout: 180_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'tau-headless-hook-block-'))
  const config = join(root, 'config'), workspace = join(root, 'workspace')
  for (const name of ['config', 'workspace', 'home', 'appdata', 'localappdata']) mkdirSync(join(root, name))
  const settingsDirectory = join(workspace, '.claude')
  mkdirSync(settingsDirectory)
  const skillDirectory = join(settingsDirectory, 'skills', 'blocked-skill')
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, 'SKILL.md'), '---\nname: blocked-skill\ndescription: Headless expansion fixture\n---\nNever reach the provider.\n')
  writeFileSync(join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty',
    projects: { [workspace.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
  }))
  const requests = []
  const server = createServer((request, response) => {
    // Startup preconnect performs HEAD / before prompt processing. It sends no
    // prompt; every other request is forbidden for these blocked submissions.
    if (request.method !== 'HEAD' || request.url !== '/') requests.push(`${request.method} ${request.url}`)
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Provider trap: blocked prompts must never arrive here' } }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key),
  ))
  Object.assign(env, {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1',
    ANTHROPIC_API_KEY: 'sk-ant-headless-hook-fixture',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1,localhost',
  })
  const cases = [
    { name: 'decision block', event: 'UserPromptSubmit', formats: ['text', 'json', 'stream-json'],
      script: `console.log(JSON.stringify({decision:'block',reason:'fixture policy denied',suppressOriginalPrompt:true}))`,
      reason: 'fixture policy denied', prompt: privatePrompt },
    { name: 'continue false', event: 'UserPromptSubmit', formats: ['text', 'json'],
      script: `console.log(JSON.stringify({continue:false,stopReason:'fixture policy stopped'}))`,
      reason: 'fixture policy stopped', prompt: privatePrompt },
    { name: 'exit code 2', event: 'UserPromptSubmit', formats: ['json'],
      script: `console.error('fixture exit-code policy denied');process.exitCode=2`,
      reason: 'fixture exit-code policy denied', prompt: privatePrompt },
    { name: 'expansion block', event: 'UserPromptExpansion', formats: ['json'],
      script: `console.log(JSON.stringify({decision:'block',reason:'fixture expansion denied'}))`,
      reason: 'fixture expansion denied', prompt: `/blocked-skill ${privatePrompt}` },
  ]
  try {
    for (const scenario of cases) {
      writeFileSync(join(settingsDirectory, 'settings.json'), JSON.stringify({ hooks: {
        [scenario.event]: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', scenario.script] }] }],
      } }))
      for (const format of scenario.formats) await t.test(`${scenario.name}: ${format}`, async () => {
        const before = requests.length
        const result = await runCli(workspace, env, scenario.prompt, format)
        const detail = `${result.stderr}\n${result.stdout}`
        assert.deepEqual(requests.slice(before), [], `Hook denial reached the provider (${requests.slice(before).join(', ')}):\n${detail}`)
        assert.equal(result.code, 1, detail)
        assert.ok(result.stdout.includes(scenario.reason), detail)
        if (format === 'text') {
          assert.ok(!result.stdout.includes(privatePrompt), detail)
        } else {
          const entries = format === 'stream-json'
            ? result.stdout.trim().split('\n').map(line => JSON.parse(line))
            : [JSON.parse(result.stdout)]
          const results = entries.filter(entry => entry.type === 'result')
          assert.equal(results.length, 1, detail)
          assert.equal(results[0].subtype, 'error_during_execution')
          assert.equal(results[0].is_error, true)
          assert.equal(results[0].num_turns, 0)
          assert.ok(results[0].errors.some(error => error.includes(scenario.reason)))
          assert.ok(!JSON.stringify(results[0]).includes(privatePrompt), 'Error must not echo the prompt')
          assert.equal(entries.some(entry => entry.type === 'assistant'), false, detail)
          if (scenario.name === 'decision block') assert.ok(!result.stdout.includes(privatePrompt), 'Suppressed prompt must not appear in the stream')
        }
      })
    }
  } finally {
    await new Promise(done => server.close(done))
    const cleanupPath = realpathSync(root), childPath = relative(realpathSync(tmpdir()), cleanupPath)
    assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath), 'Unsafe fixture cleanup path')
    await rm(cleanupPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
