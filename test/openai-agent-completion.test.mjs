// TAU_MCP_TEST_BUNDLE=<isolated test build>/cli.mjs node --test test/openai-agent-completion.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'

const cli = resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/cli.mjs')
const preload = new URL('./helpers/openai-agent-completion-preload.mjs', import.meta.url).href

for (const model of ['gpt-6-sol', 'gpt-5.6-luna']) {
  test(`${model}: print mode receives agent completion on the next tool round`, { timeout: 90_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-notification-test-'))
    const config = join(root, 'config')
    const workspace = join(root, 'workspace')
    for (const name of ['config', 'workspace', 'home', 'appdata', 'localappdata']) mkdirSync(join(root, name))
    writeFileSync(join(config, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'openai',
      projects: { [workspace.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
    }))
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Agent', 'Bash', 'PowerShell'] } }))
    const log = join(root, 'requests.jsonl')
    writeFileSync(log, '')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key),
    ))
    Object.assign(env, {
      HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
      // Exercise CI startup locally too. This is a real CLI run with the
      // preload's Responses fixture, not NODE_ENV=test's VCR replay path.
      CI: 'true', NODE_ENV: 'production',
      CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1',
      // Shared CLI startup checks Anthropic auth under CI/NODE_ENV=test,
      // even with OpenAI selected. The preload intercepts every fetch; this
      // dummy value satisfies startup without reading real credentials.
      ANTHROPIC_API_KEY: 'sk-ant-local-notification-test',
      OPENAI_API_KEY: 'sk-proj-local-notification-test', OPENAI_BASE_URL: 'https://notification-test.invalid/v1',
      TAU_NOTIFICATION_TEST_LOG: log,
    })
    const child = spawn(process.execPath, ['--import', preload, cli, '-p', 'NOTIFICATION_PARENT: launch an agent and keep working.',
      '--model', model, '--output-format', 'stream-json', '--verbose'], {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 75_000)
    try {
      const exit = await new Promise((resolveExit, reject) => {
        child.on('error', reject)
        child.on('close', resolveExit)
      })
      const records = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      assert.equal(exit, 0, `CLI exited ${exit}: ${stderr.slice(-1500)}\n${stdout.slice(-1500)}`)
      const finishedIndex = records.findIndex(record => record.kind === 'child-finished')
      assert.ok(finishedIndex >= 0, `child did not finish: ${JSON.stringify(records)}\n${stdout.slice(-1500)}`)
      const nextParent = records.slice(finishedIndex + 1).find(record => record.kind === 'parent-request')
      assert.equal(nextParent?.notified, true,
        `next model request did not contain the completed agent notification: ${JSON.stringify(records.map(({ input, ...record }) => record))}\n${JSON.stringify(nextParent?.input).slice(-6000)}\n${stdout.slice(-2500)}\n${stderr.slice(-1500)}`)
      assert.ok(stdout.includes('NOTIFICATION_DELIVERED_MIDTURN'), stdout.slice(-1500))
      assert.ok(!stdout.includes('NOTIFICATION_MISSING'), 'model ended its turn before receiving the completion')
      const parentRequests = records.filter(record => record.kind === 'parent-request')
      assert.equal(parentRequests[0].sentTurnState, null)
      assert.ok(parentRequests.slice(1).every(record => record.sentTurnState === 'parent-routing-token'),
        'tool rounds must preserve the server-issued token for the query chain')
      assert.ok(parentRequests.every(record => record.leakedTurnId === undefined))
      assert.equal(records[finishedIndex].sentTurnState, null, 'the agent must not borrow its parent turn state')
    } finally {
      clearTimeout(timer)
      child.kill()
      const cleanupPath = realpathSync(root)
      const childPath = relative(realpathSync(tmpdir()), cleanupPath)
      assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath), 'unsafe fixture cleanup path')
      await rm(cleanupPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
