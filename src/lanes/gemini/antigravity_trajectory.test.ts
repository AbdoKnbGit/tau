/** Run: bun run src/lanes/gemini/antigravity_trajectory.test.ts */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve, sep } from 'node:path'

const tempRoot = realpathSync(os.tmpdir())
const sandbox = realpathSync(mkdtempSync(join(tempRoot, 'tau-trajectory-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))
let project = 'trajectory-project'
const codeAssist = await import('../../services/api/providers/gemini_code_assist.js')
mock.module('../../services/api/providers/gemini_code_assist.js', () => ({
  ...codeAssist,
  ensureCodeAssistReady: async () => project,
  warmupCodeAssist: () => {},
}))
mock.module('../../services/api/providers/gemini_provider.js', () => ({ resolveCliModelsForPicker: () => [] }))
const cache = await import('./antigravity_cache.js')
const trace = await import('./antigravity_trace.js')
const trajectory = await import('./antigravity_trajectory.js')
const { geminiApi, TAU_STABLE_SESSION_ID_FIELD, TAU_QUERY_SOURCE_FIELD } = await import('./api.js')

const LOG = join(sandbox, 'tau-cache-debug.jsonl')
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const STRUCTURED_ID = new RegExp(`^agent/(${UUID})/(\\d{13})/(${UUID})/(\\d+)$`)
const originalFetch = globalThis.fetch
const previousToken = (geminiApi as any).antigravityOAuthToken
const previousEnv = { debug: process.env.TAU_CACHE_DEBUG, trajectory: process.env.TAU_ANTIGRAVITY_TRAJECTORY }

type Reply = { kind: 'ok' } | { kind: 'status'; status: number; body: string } | { kind: 'throw' }
let replies: Reply[] = []
const bodies: any[] = []

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  bodies.push(JSON.parse(String(init?.body)))
  const reply = replies.shift() ?? { kind: 'ok' }
  if (reply.kind === 'throw') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  if (reply.kind === 'status') return new Response(reply.body, { status: reply.status })
  const response = { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20_000, cachedContentTokenCount: 16_384 }, responseId: `r${bodies.length}` }
  return String(url).includes('streamGenerateContent')
    ? new Response(`data: ${JSON.stringify({ response })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    : Response.json({ response })
}) as typeof fetch

let seq = 0
function request(opts: { session?: string; source?: string; model?: string; text?: string } = {}) {
  const model = opts.model ?? 'gemini-3.8-flash-medium'
  const body = {
    model,
    systemInstruction: { parts: [{ text: 'Trajectory test system prompt.' }] },
    tools: [{ functionDeclarations: [{ name: 'lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } }] }],
    contents: [{ role: 'user', parts: [{ text: opts.text ?? 'Question.' }] }],
    generationConfig: { temperature: 1, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'medium' } },
    [TAU_STABLE_SESSION_ID_FIELD]: '-9001',
    [TAU_QUERY_SOURCE_FIELD]: opts.source ?? 'repl_main_thread',
  }
  cache.trackAntigravityCacheRequest(body, {
    sessionId: opts.session ?? 'main-session',
    model,
    querySource: opts.source ?? 'repl_main_thread',
    requestId: `logical-${++seq}`,
  })
  return body
}

async function stream(body: Record<string, unknown>): Promise<void> {
  for await (const _chunk of geminiApi.streamGenerateContent(body)) { /* drain */ }
}

function idParts(body: any) {
  const match = STRUCTURED_ID.exec(body.requestId)
  assert.ok(match, `requestId is not the structured form: ${body.requestId}`)
  return { uuid: match[1]!, ms: Number(match[2]), trajectoryId: match[3]!, step: Number(match[4]) }
}

function reset(): void {
  bodies.length = 0
  replies = []
  project = 'trajectory-project'
  rmSync(LOG, { force: true })
  codeAssist._resetAntigravityGeminiAffinityForTest()
  codeAssist._resetAntigravityGeminiHostCooldownForTest()
  trace._resetAntigravityTraceStateForTest()
  trajectory._resetAntigravityTrajectoryForTest()
}

try {
  ;(geminiApi as any).antigravityOAuthToken = 'trajectory-token'
  delete process.env.TAU_CACHE_DEBUG

  // ── 1. Switched off: the plain envelope, byte for byte. ──
  reset()
  process.env.TAU_ANTIGRAVITY_TRAJECTORY = '0'
  await stream(request())
  await geminiApi.generateContent(request())
  for (const body of bodies) {
    assert.match(body.requestId, new RegExp(`^agent-${UUID}$`))
    assert.equal(body.request.labels, undefined)
  }
  const offBody = bodies[0]

  // ── 2. On by default: structured id + verified labels, prompt bytes unchanged. ──
  reset()
  delete process.env.TAU_ANTIGRAVITY_TRAJECTORY
  await stream(request())
  await stream(request({ text: 'Question.' }))
  await geminiApi.generateContent(request())
  const main = bodies.map(idParts)
  assert.deepEqual(main.map(p => p.step), [2, 3, 4], 'steps start at 2 and advance once per attempt')
  assert.equal(new Set(main.map(p => p.trajectoryId)).size, 1, 'one trajectory per conversation stream')
  assert.equal(new Set(main.map(p => p.uuid)).size, 1)
  assert.notEqual(main[0]!.uuid, main[0]!.trajectoryId)
  assert.ok(Math.abs(main[0]!.ms - Date.now()) < 60_000)
  for (const body of bodies) {
    assert.deepEqual(body.request.labels, {
      trajectory_id: idParts(body).trajectoryId,
      used_claude: 'false',
      used_claude_conservative: 'false',
    })
  }
  const onBody = bodies[0]
  const { labels: _labels, ...onRequest } = onBody.request
  assert.equal(JSON.stringify(onRequest), JSON.stringify(offBody.request), 'the experiment changed prompt, config or sessionId bytes')
  for (const key of ['model', 'userAgent', 'requestType', 'project']) assert.equal(onBody[key], offBody[key])
  assert.deepEqual(Object.keys(onBody), Object.keys(offBody), 'envelope keys must match today\'s')

  // ── 3. Agents are separate trajectories; helpers get nothing and advance nothing. ──
  await stream(request({ session: 'tau-agent-1', source: 'agent:builtin:general-purpose' }))
  await stream(request({ source: 'compact' }))
  await stream(request({ source: 'count_tokens' }))
  await stream(request())
  const [agent, compact, countTokens, mainAgain] = bodies.slice(3)
  assert.notEqual(idParts(agent).trajectoryId, main[0]!.trajectoryId)
  assert.equal(idParts(agent).step, 2, 'an agent starts its own sequence')
  for (const helper of [compact, countTokens]) {
    assert.match(helper.requestId, new RegExp(`^agent-${UUID}$`))
    assert.equal(helper.request.labels, undefined)
  }
  assert.equal(idParts(mainAgain).trajectoryId, main[0]!.trajectoryId)
  assert.equal(idParts(mainAgain).step, 5, 'a helper advanced the main counter')

  // ── 4. Hops share an attempt's id; retries and failures consume steps, never reused. ──
  reset()
  replies = [
    { kind: 'status', status: 503, body: '{"error":{"code":503,"status":"UNAVAILABLE"}}' },
    { kind: 'status', status: 503, body: '{"error":{"code":503,"status":"UNAVAILABLE"}}' },
    { kind: 'ok' },
  ]
  await stream(request())
  const [hop0, hop1, retry] = bodies.map(idParts)
  assert.equal(hop0!.step, 2)
  assert.equal(hop1!.step, 2, 'endpoint hops of one attempt share its request id')
  assert.equal(bodies[0].requestId, bodies[1].requestId)
  assert.equal(retry!.step, 3, 'a retry attempt gets the next step')
  replies = [{ kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }]
  await assert.rejects(stream(request()))
  assert.deepEqual(bodies.slice(3).map(b => idParts(b).step), [4, 4, 5, 5])
  await stream(request())
  assert.equal(idParts(bodies.at(-1)).step, 6, 'a failed request rewound or reused a step')

  // ── 5. Model and project are part of the trajectory scope. ──
  const mainTrajectory = idParts(bodies.at(-1)).trajectoryId
  await stream(request({ model: 'gemini-3.8-flash-high' }))
  assert.notEqual(idParts(bodies.at(-1)).trajectoryId, mainTrajectory)
  project = 'other-project'
  await stream(request())
  assert.notEqual(idParts(bodies.at(-1)).trajectoryId, mainTrajectory)
  project = 'trajectory-project'
  await stream(request())
  assert.equal(idParts(bodies.at(-1)).trajectoryId, mainTrajectory)
  assert.equal(idParts(bodies.at(-1)).step, 7)

  // ── 6. The profile is chosen once per stream. ──
  reset()
  process.env.TAU_ANTIGRAVITY_TRAJECTORY = '0'
  await stream(request({ session: 'started-off' }))
  process.env.TAU_ANTIGRAVITY_TRAJECTORY = '1'
  await stream(request({ session: 'started-off' }))
  await stream(request({ session: 'started-on' }))
  process.env.TAU_ANTIGRAVITY_TRAJECTORY = '0'
  await stream(request({ session: 'started-on' }))
  assert.equal(bodies[1].request.labels, undefined, 'a stream switched profile mid-conversation')
  assert.ok(bodies[2].request.labels && bodies[3].request.labels, 'a stream switched profile mid-conversation')

  // ── 7. Eviction is reported as a reset trajectory. ──
  reset()
  process.env.TAU_ANTIGRAVITY_TRAJECTORY = '1'
  const scope = (i: number) => ({ sessionId: `s${i}`, querySource: 'repl_main_thread', model: 'gemini-3.8-flash-medium', account: 'a', project: 'p' })
  const first = trajectory.antigravityTrajectoryForAttempt(scope(0))
  assert.equal(first.state, 'new')
  for (let i = 1; i <= 2048; i++) trajectory.antigravityTrajectoryForAttempt(scope(i))
  const again = trajectory.antigravityTrajectoryForAttempt(scope(0))
  assert.equal(again.state, 'reset')
  assert.notEqual(again.identity!.labels.trajectory_id, first.identity!.labels.trajectory_id)
  assert.equal(trajectory.antigravityTrajectoryForAttempt(scope(0)).state, 'continued')

  // ── 8. A 400 naming an envelope field turns it off; that request is resent once without it. ──
  reset()
  delete process.env.TAU_ANTIGRAVITY_TRAJECTORY
  process.env.TAU_CACHE_DEBUG = '1'
  replies = [{ kind: 'status', status: 400, body: JSON.stringify({ error: { code: 400, message: 'Corrupted thought signature.', status: 'INVALID_ARGUMENT' } }) }]
  await stream(request())
  assert.equal(trajectory.antigravityTrajectoryRejection(), undefined, 'an unrelated 400 disabled the envelope')
  replies = [{ kind: 'status', status: 400, body: JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "labels" at \'request\': Cannot find field.', status: 'INVALID_ARGUMENT' } }) }]
  const before = bodies.length
  await stream(request())
  assert.equal(bodies.length - before, 2, 'the rejected request must be resent exactly once')
  assert.ok(bodies[before].request.labels, 'the first attempt carried the envelope')
  assert.equal(bodies[before + 1].request.labels, undefined, 'the resend must drop the envelope')
  assert.match(bodies[before + 1].requestId, new RegExp(`^agent-${UUID}$`))
  assert.deepEqual(trajectory.antigravityTrajectoryRejection(), { status: 400, fields: ['labels'] })
  await stream(request())
  assert.match(bodies.at(-1).requestId, new RegExp(`^agent-${UUID}$`))
  assert.equal(bodies.at(-1).request.labels, undefined)
  const rows = readFileSync(LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const profiles = rows.filter(r => r.kind === 'dispatch').map(r => r.profile.trajectory)
  assert.deepEqual(profiles, ['minimal', 'minimal', 'minimal', 'rejected', 'rejected'])
  assert.ok(rows.some(r => r.kind === 'endpoint' && r.event === 'trajectory-rejected'))
  const rejectedDispatch = rows.filter(r => r.kind === 'dispatch')[2]
  assert.equal(rejectedDispatch.labels.trajectory_id, idParts(bodies[before]).trajectoryId, 'dispatch rows must show the labels that were sent')

  console.log('Antigravity trajectory envelope passed: switched-off parity, on by default, prompt bytes, id/labels contract, agent/helper isolation, hops/retries/failures, scope, sticky profile, reset, rejection resend')
} finally {
  globalThis.fetch = originalFetch
  ;(geminiApi as any).antigravityOAuthToken = previousToken
  if (previousEnv.debug === undefined) delete process.env.TAU_CACHE_DEBUG
  else process.env.TAU_CACHE_DEBUG = previousEnv.debug
  if (previousEnv.trajectory === undefined) delete process.env.TAU_ANTIGRAVITY_TRAJECTORY
  else process.env.TAU_ANTIGRAVITY_TRAJECTORY = previousEnv.trajectory
  trajectory._resetAntigravityTrajectoryForTest()
  mock.restore()
  assert.ok(resolve(sandbox).startsWith(resolve(tempRoot) + sep))
  rmSync(sandbox, { recursive: true, force: true })
}
