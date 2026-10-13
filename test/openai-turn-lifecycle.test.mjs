// TAU_MCP_TEST_BUNDLE=<isolated build>/cli.mjs node --test test/openai-turn-lifecycle.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const cli = resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/cli.mjs')
const preload = new URL('./helpers/openai-turn-lifecycle-preload.mjs', import.meta.url).href

async function conversation(workspace, env, turns, resume) {
  const child = spawn(process.execPath, ['--import', preload, cli, '-p',
    '--model', 'gpt-6.1-sol', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ...(resume ? ['--resume', resume] : [])], {
    cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const entries = []
  let stdout = '', stderr = '', buffer = '', closed = false, failure
  child.stdout.on('data', chunk => {
    stdout += chunk
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try { entries.push(JSON.parse(line)) } catch { /* CLI text is retained for failures. */ }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.on('error', error => { failure = error })
  child.on('error', error => { failure = error })
  const finished = new Promise(resolveExit => child.on('close', code => { closed = true; resolveExit(code) }))
  const timer = setTimeout(() => child.kill(), 60_000)
  const detail = () => `${failure?.message ?? ''}\n${stderr.slice(-2000)}\n${stdout.slice(-2500)}`
  const waitFor = async predicate => {
    const deadline = Date.now() + 45_000
    while (!predicate() && !closed && !failure && Date.now() < deadline) await delay(50)
    assert.ok(predicate(), detail())
  }
  const send = entry => child.stdin.write(JSON.stringify(entry) + '\n')
  try {
    send({ type: 'control_request', request_id: 'lifecycle-initialize', request: { subtype: 'initialize' } })
    await waitFor(() => entries.some(entry => entry.type === 'control_response' && entry.response?.request_id === 'lifecycle-initialize'))
    for (const [index, turn] of turns.entries()) {
      send({ type: 'user', session_id: '', message: { role: 'user', content: `TURN_LIFECYCLE_${turn}: read the two fixture files.` }, parent_tool_use_id: null })
      await waitFor(() => entries.filter(entry => entry.type === 'result').length > index)
      const result = entries.filter(entry => entry.type === 'result')[index]
      assert.equal(result.subtype, 'success', detail())
      assert.equal(result.is_error, false, detail())
      assert.ok(result.result.includes(`TURN_LIFECYCLE_DONE_${turn}`), detail())
    }
    child.stdin.end()
    assert.equal(await finished, 0, detail())
    return entries.find(entry => entry.session_id)?.session_id
  } finally {
    clearTimeout(timer)
    if (!closed) child.kill()
    await finished
  }
}

test('real SDK user turns retain routing through tools, reset between turns, and reset after resume', { timeout: 150_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-turn-lifecycle-'))
  const config = join(root, 'config'), workspace = join(root, 'workspace')
  for (const name of ['config', 'workspace', 'home', 'appdata', 'localappdata']) mkdirSync(join(root, name))
  writeFileSync(join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'openai',
    projects: { [workspace.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
  }))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ effortLevel: 'medium', permissions: { allow: ['Read'] } }))
  writeFileSync(join(workspace, 'alpha.txt'), 'ALPHA_FILE_ACTUALLY_READ\n')
  writeFileSync(join(workspace, 'beta.txt'), 'BETA_FILE_ACTUALLY_READ\n')
  const log = join(root, 'requests.jsonl')
  writeFileSync(log, '')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key),
  ))
  Object.assign(env, {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1',
    ANTHROPIC_API_KEY: 'sk-ant-local-turn-lifecycle', OPENAI_API_KEY: 'sk-proj-local-turn-lifecycle',
    OPENAI_BASE_URL: 'https://turn-lifecycle.invalid/v1', TAU_CODEX_WEBSOCKET: '0', TAU_TURN_LIFECYCLE_LOG: log,
  })
  try {
    const sessionId = await conversation(workspace, env, ['FIRST', 'SECOND'])
    assert.ok(sessionId, 'CLI did not report its session ID')
    const resumedSessionId = await conversation(workspace, env, ['RESUMED'], sessionId)
    assert.equal(resumedSessionId, sessionId, 'resume must continue the same transcript')
    const records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(records.length, 9, 'three requests per user turn; no hidden extra request')
    assert.equal(new Set(records.map(record => record.sessionId)).size, 1, 'cache session remains stable across user turns and resume')
    for (const turn of ['FIRST', 'SECOND', 'RESUMED']) {
      const requests = records.filter(record => record.turn === turn)
      assert.deepEqual(requests.map(record => record.round), [0, 1, 2])
      assert.deepEqual(requests.map(record => record.sentTurnState), [null, `routing-${turn}-0`, `routing-${turn}-0`], turn)
      assert.ok(requests[1].readResults.some(result => result.includes('ALPHA_FILE_ACTUALLY_READ')), `${turn}: first tool did not execute`)
      assert.ok(requests[2].readResults.some(result => result.includes('BETA_FILE_ACTUALLY_READ')), `${turn}: second tool did not execute`)
    }
    assert.ok(records.every(record => record.effort === 'medium' && record.model === 'gpt-6.1-sol'))
    assert.ok(records.every(record => !record.leakedTurnId), 'internal turn IDs must not enter the Responses body')
    assert.deepEqual(records.find(record => record.turn === 'RESUMED').previousPrompts, ['FIRST', 'SECOND'], 'resume must restore actual prior conversation history')
  } finally {
    const cleanupPath = realpathSync(root), childPath = relative(realpathSync(tmpdir()), cleanupPath)
    assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath), 'unsafe fixture cleanup path')
    await rm(cleanupPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
