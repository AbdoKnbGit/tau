// Auto compaction on an Ollama model on this machine, through the built CLI and
// a fake Ollama that counts tokens and refuses a request larger than its
// context, as Ollama 0.40 does with `truncate: false`. Tau must compact before
// the conversation outgrows the context it sends, fit every request into that
// context, and never refuse its own requests.
//
// TAU_LOCAL_COMPACTION_CLI runs the case against another build.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { stopProcessTree } from './helpers/stop-process-tree.mjs'

const cli = resolve(process.env.TAU_LOCAL_COMPACTION_CLI ?? 'dist/cli.mjs')
const root = mkdtempSync(join(tmpdir(), 'tau-local-compaction-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

const MODEL = 'compact-test:4b'
// What Ollama 0.40 counted for Tau's request: 16,014 tokens for 74K characters.
const CHARS_PER_TOKEN = 4.6
const SUMMARY_MARKER = 'Your task is to create a detailed summary'

// ownDefault: the context this fake Ollama picks when it loads the model with
// no options, as Ollama 0.40 picks 4K, 32K or 256K from the GPU's memory.
async function startFakeOllama({ ownDefault }) {
  const chats = []
  const calls = []
  let loaded
  const server = createServer(async (request, response) => {
    request.setEncoding('utf8')
    let raw = ''
    for await (const part of request) raw += part
    const body = raw ? JSON.parse(raw) : null
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const json = (data, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(data))
    }
    if (path === '/api/tags') return json({ models: [{ name: MODEL, model: MODEL, modified_at: '2026-01-01T00:00:00Z', size: 1, digest: 'fake', details: {} }] })
    if (path === '/api/show') return json({ capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 262_144 } })
    calls.push(`${request.method} ${path}`)
    if (path === '/api/ps') return json({ models: loaded === undefined ? [] : [{ name: MODEL, model: MODEL, context_length: loaded }] })
    if (path === '/api/generate') {
      loaded = ownDefault
      return json({ model: MODEL, done: true, done_reason: 'load', options: body.options ?? null })
    }
    if (path !== '/api/chat') return json({ error: `no route for ${path}` }, 404)
    const reloaded = loaded !== body.options.num_ctx
    loaded = body.options.num_ctx

    const promptTokens = Math.ceil(JSON.stringify({ messages: body.messages, tools: body.tools ?? [] }).length / CHARS_PER_TOKEN)
    const lastUser = [...body.messages].reverse().find(message => message.role === 'user')
    const isCompaction = String(lastUser?.content ?? '').includes(SUMMARY_MARKER)
    const refused = body.truncate === false && promptTokens > body.options.num_ctx
    chats.push({ promptTokens, numCtx: body.options.num_ctx, numPredict: body.options.num_predict, truncate: body.truncate, isCompaction, refused, reloaded })
    if (refused) {
      return json({ error: `request (${promptTokens} tokens) exceeds the available context size (${body.options.num_ctx} tokens), try increasing it` }, 400)
    }
    const text = isCompaction ? '<summary>The user shared long project notes in several parts.</summary>' : 'Noted.'
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: text }, done: false })}\n`)
    response.end(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: promptTokens, eval_count: 8 })}\n`)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return {
    chats,
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()) }),
  }
}

function freshPlace(name) {
  const home = join(root, name)
  const workspace = join(home, 'workspace')
  const configDir = join(home, 'config')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    activeProvider: 'ollama',
    // A throwaway config would pull Ollama's cloud models into this machine's
    // Ollama on every run (ensureCloudModelsPrimed).
    ollamaCloudModelsPrimedAt: 1,
  }))
  return { home, workspace, configDir }
}

function cleanEnv({ home, configDir }, extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GOOGLE_|TAU_|CLAUDEX|CODEX_|OLLAMA|LMSTUDIO|LM_STUDIO|DEEPSEEK|CI$|ENABLE_TOOL_SEARCH|NODE_OPTIONS$|SESSIONNAME$|WT_SESSION$|ConEmuPID$|DISABLE_AUTO_COMPACT$|DISABLE_COMPACT$)/i.test(key)))
  return {
    ...env,
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
    CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(home, 'cache'),
    NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1', NO_PROXY: '127.0.0.1,localhost',
    ...extra,
  }
}

// Long, distinct notes: about 2,300 tokens each at Ollama's ratio.
function note(turn) {
  const line = `Part ${turn} of the project notes. Module ${turn} handles queue ${turn} and writes report ${turn}.`
  return `${line}\n`.repeat(110) + `End of part ${turn}. Reply with one word.`
}

async function runConversation(place, env, turns) {
  const child = spawn(process.execPath, [
    cli, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--tools', 'Read',
    '--model', MODEL,
  ], {
    cwd: place.workspace, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let sent = 0
  let results = 0
  const send = content => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
  child.stdout.on('data', part => {
    stdout += part
    // One turn at a time, as a person would type them.
    const seen = (stdout.match(/"type":"result"/g) ?? []).length
    while (results < seen) {
      results++
      if (sent < turns) send(note(++sent))
      else child.stdin.end()
    }
  })
  child.stderr.on('data', part => { stderr += part })
  send(note(++sent))
  const timer = setTimeout(() => stopProcessTree(child), 300_000)
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    return { code, stdout, stderr, results }
  } finally {
    clearTimeout(timer)
  }
}

function describeRun(run, server) {
  return [
    `exit ${run.code}, results ${run.results}`,
    `calls: ${JSON.stringify(server.calls)}`,
    `chats: ${JSON.stringify(server.chats)}`,
    `stdout tail: ${run.stdout.slice(-1500)}`,
    `stderr tail: ${run.stderr.slice(-1500)}`,
  ].join('\n')
}

// The questions Tau asked Ollama about the model before its first request.
function probesBeforeFirstChat(server) {
  const firstChat = server.calls.indexOf('POST /api/chat')
  return server.calls.slice(0, firstChat).filter(call => /^(GET|POST) \/api\/(ps|generate)$/.test(call))
}

test("a long conversation compacts within the context Tau needs where Ollama's own is too small (an 8 GB GPU)", async () => {
  const server = await startFakeOllama({ ownDefault: 4096 })
  try {
    const place = freshPlace('small-gpu')
    const turns = 14
    const run = await runConversation(place, cleanEnv(place, { OLLAMA_BASE_URL: server.baseUrl }), turns)
    const chats = server.chats
    const context = describeRun(run, server)
    if (process.env.TAU_LOCAL_COMPACTION_VERBOSE) console.log(server.calls, chats)

    assert.equal(run.results, turns, context)
    assert.doesNotMatch(run.stdout, /Prompt is too long/, context)
    // Tau asked Ollama what it gives the model before its first request.
    assert.deepEqual(probesBeforeFirstChat(server), ['GET /api/ps', 'POST /api/generate', 'GET /api/ps'], context)
    // Tau compacted, and every request fit the context it asked for.
    const compactions = chats.filter(chat => chat.isCompaction)
    assert.ok(compactions.length >= 1, `no compaction request\n${context}`)
    assert.deepEqual(chats.filter(chat => chat.refused), [], context)
    for (const chat of chats) {
      assert.equal(chat.truncate, false, context)
      assert.ok(chat.numCtx > 4096, context)
      assert.ok(chat.promptTokens + 1024 <= chat.numCtx || chat.isCompaction, `no room for an answer: ${JSON.stringify(chat)}\n${context}`)
    }
    // One context for the whole conversation: Ollama loaded the model once
    // for Tau's requests, after the 4K load that answered Tau's question.
    assert.deepEqual(chats.filter(chat => chat.reloaded).length, 1, context)
    // Compaction fired near 80% of that context, not at a 200K default, and
    // left the summary room to be written.
    const before = chats[chats.indexOf(compactions[0]) - 1]
    assert.ok(before.promptTokens < before.numCtx * 0.8 + 3000, context)
    assert.ok(compactions[0].numPredict >= 2000, context)
    // The conversation went on after it, smaller.
    const afterCompaction = chats.slice(chats.indexOf(compactions[0]) + 1).filter(chat => !chat.isCompaction)
    assert.ok(afterCompaction.length >= 1, context)
    assert.ok(afterCompaction[0].promptTokens < before.promptTokens / 2, context)
  } finally {
    await server.close()
  }
})

test('where Ollama gives the model 256K on its own (a 48 GB GPU), Tau keeps that context and does not compact early', async () => {
  const server = await startFakeOllama({ ownDefault: 262_144 })
  try {
    const place = freshPlace('big-gpu')
    const turns = 4
    const run = await runConversation(place, cleanEnv(place, { OLLAMA_BASE_URL: server.baseUrl }), turns)
    const chats = server.chats
    const context = describeRun(run, server)

    assert.equal(run.results, turns, context)
    assert.deepEqual(probesBeforeFirstChat(server), ['GET /api/ps', 'POST /api/generate', 'GET /api/ps'], context)
    assert.ok(chats.length >= turns, context)
    for (const chat of chats) {
      assert.equal(chat.numCtx, 262_144, context)
      assert.equal(chat.reloaded, false, context)
      assert.equal(chat.isCompaction, false, context)
    }
  } finally {
    await server.close()
  }
})
