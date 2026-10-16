// Run after `npm run build`: node --test test/tool-prompt-contracts.test.mjs
// These checks protect parameter contracts, cache bytes, high-risk guidance and
// every point of the pre-compression prompts (test/tool-prompt-points.json).
// They are not a substitute for evaluating model behavior on real tasks.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const auditPath = join(dirname(distPath), `.prompt-contracts-${process.pid}.mjs`)
let source = readFileSync(distPath, 'utf8')
const entrypoint = /\nvoid main\d*\(\);\r?\n/
assert.match(source, entrypoint, 'CLI entrypoint must be removed before import')
source = source.replace(entrypoint, '\n')

// Resolve esbuild initializer names by their source paths, not unstable suffixes.
const initializers = new Map(
  [...source.matchAll(/var (\w+) = __esm\(\{\r?\n\s*"([^"]+)"/g)]
    .map(([, name, path]) => [path, name]),
)
const init = path => {
  assert.ok(initializers.has(path), `missing bundled source ${path}`)
  return `${initializers.get(path)}();`
}
const sessionCacheModule = source.slice(source.indexOf('// src/utils/toolSchemaCache.ts'))
const sessionCacheClear = sessionCacheModule.match(/function (clearToolSchemaCache\d*)\(/)?.[1]
assert.ok(sessionCacheClear, 'session tool cache reset must be available')
source += `\nexport function __promptContracts() {
  ${init('src/utils/api.ts')}
  ${init('src/tools/AgentTool/builtInAgents.ts')}
  const pool = getAllBaseTools();
  return {
    BrowserTool: pool.find(tool => tool.name === 'Browser'),
    AgentTool: pool.find(tool => tool.name === 'Agent'),
    BashTool: pool.find(tool => tool.name === 'Bash'),
    EvalTool: pool.find(tool => tool.name === 'Eval'),
    toolToAPISchema,
    clearToolSchemaCache: ${sessionCacheClear}, getAllBaseTools, getBuiltInAgents,
    getBrowserSession };
}\n`
writeFileSync(auditPath, source)
let audit
try {
  audit = (await import(pathToFileURL(auditPath).href)).__promptContracts()
} finally {
  unlinkSync(auditPath)
}

const permission = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
  shouldAvoidPermissionPrompts: false,
}
const options = {
  tools: audit.getAllBaseTools(),
  agents: audit.getBuiltInAgents(),
  getToolPermissionContext: async () => permission,
  model: 'claude-sonnet-4-6',
}
const tools = [audit.BrowserTool, audit.AgentTool, audit.BashTool, audit.EvalTool]
assert.ok(tools.every(Boolean), 'all four tools must be present in the registry')

test('prompt compression leaves all four parameter schemas unchanged', async () => {
  // Fingerprints of the full serialized input schemas before prompt compression:
  // names, types, descriptions, enums, defaults, bounds and required fields.
  // Agent's was re-pinned after a677b2b reworded its `model` description for
  // Mistral routing; with the old sentence it still hashes to b8d1fa71...
  const expected = {
    Browser: '365799a28a08395d81600c65806f5cc465b8362d07d5e3f7f729fbac2c5980d4',
    Agent: '22e6ea016a31c1c1cb909e7cc2663fa309efa7307c4ee78689315062011fbfdc',
    Bash: '753cf35982446613ce9c6768358e8702a64dd0cc3ea6f69b056c66f778d92a4b',
    Eval: '2599a200679af39f9daaa3938e69dc4a09a48eae6fbc6903211f836aaa0948d6',
  }
  for (const tool of tools) {
    const schema = await audit.toolToAPISchema(tool, options)
    const hash = createHash('sha256').update(JSON.stringify(schema.input_schema)).digest('hex')
    assert.equal(hash, expected[tool.name], `${tool.name} input contract changed`)
  }
})

test('rendered tool definitions stay byte-identical across turns and fresh renders', async () => {
  for (const tool of tools) {
    audit.clearToolSchemaCache()
    const expected = JSON.stringify(await audit.toolToAPISchema(tool, options))
    for (let turn = 0; turn < 3; turn++) {
      assert.equal(JSON.stringify(await audit.toolToAPISchema(tool, options)), expected, tool.name)
    }
    audit.clearToolSchemaCache()
    assert.equal(JSON.stringify(await audit.toolToAPISchema(tool, options)), expected, tool.name)
  }
})

test('request cache overlays never mutate the stable definition', async () => {
  for (const tool of tools) {
    const expected = JSON.stringify(await audit.toolToAPISchema(tool, options))
    await audit.toolToAPISchema(tool, {
      ...options,
      deferLoading: true,
      cacheControl: { type: 'ephemeral', ttl: '1h' },
    })
    assert.equal(JSON.stringify(await audit.toolToAPISchema(tool, options)), expected, tool.name)
  }
})

test('every Browser action remains discoverable in its prompt', async () => {
  const schema = await audit.toolToAPISchema(audit.BrowserTool, options)
  for (const action of schema.input_schema.properties.action.enum) {
    assert.match(schema.description, new RegExp(`\\b${action}\\b`), action)
  }
})

test('Browser retains evidence, targeting, recovery and intervention rules', async () => {
  const prompt = await audit.BrowserTool.prompt()
  for (const [rule, pattern] of [
    ['received visual evidence', /NEVER describe appearance[\s\S]*this turn[\s\S]*vision token[\s\S]*AND you received the image/],
    ['saved image is not seen', /path saves instead of sending an image/],
    ['unknown is not success', /unverified.*unknown, not success/],
    ['no guessed results', /Never fill missing data from memory/],
    ['fresh references', /latest observation of the current tab/],
    ['coordinate restriction', /ONLY for canvas\/map\/video\/drawing surfaces without DOM targets/],
    ['no repeated blind clicks', /coordinate_guessing blocks blind clicks/],
    ['state notes do not prove a cause', /State notes are observations, not causes/],
    ['recovery changes approach', /two failures of one tactic or blocker, change approach/],
    ['covered-element distinctions', /element_covered:[\s\S]*Fixed\/sticky[\s\S]*z-index[\s\S]*off-screen/],
    ['native picker is invisible', /NEVER open\/wait for the native file picker/],
    ['ask for intervention', /CAPTCHA\/login warnings: stop and ask the user/],
    ['confirmation cannot be bypassed', /user confirmation; NEVER bypass it/],
    // Added in fe9101e6 ("Fix browser automation behavior") with the runtime
    // coordinate block; a trimming pass dropped or blurred them once.
    ['observe unseen pages first', /observe before acting on a page you have not seen/],
    ['coordinates are blind', /coordinates are blind/],
    ['no-effect actions are not repeated', /NO OBSERVABLE EFFECT[^\n]*do NOT repeat it/],
    ['failure means look, not new numbers', /SEE the page, never try other numbers/],
    ['the tool, not the model, clicks around a covered centre', /the tool itself clicks an uncovered point/],
    ['modals use dismiss', /Modals, popups, drawers, overlays: dismiss; never hunt the X/],
    ['ref clicks strongly preferred', /click \{ ref \} \(strongly preferred\)/],
  ]) assert.match(prompt, pattern, rule)
})

test('Browser separates observations, expectations and diagnosis within its token budget', async () => {
  const prompt = await audit.BrowserTool.prompt()
  assert.match(prompt, /NO OBSERVABLE EFFECT[^\n]*no qualifying sampled change/)
  assert.match(prompt, /elapsed time for the whole action/)
  assert.match(prompt, /Check the expected result in available evidence/)
  assert.match(prompt, /unusual duration[^\n]*comparable actions/)
  assert.match(prompt, /one cheap, safe check[^\n]*within scope/)
  assert.match(prompt, /cause unresolved/)
  assert.match(prompt, /pressed toggles may still change/)
  assert.doesNotMatch(prompt, /the action did nothing|overlap is the likely cause|accept that explanation/)
  const tokens = Math.round((JSON.stringify(prompt).length - 2) / 4)
  // Pre-fix Browser prompt: 2,556 using Tau's serialized-character estimator.
  assert.ok(tokens <= 2_656, `${tokens - 2_556} estimated added tokens exceeds 100`)
})

test('Browser no-effect state notes do not diagnose a failed toggle or change cached definitions', async t => {
  const session = audit.getBrowserSession()
  const sample = {
    docId: 'd1', url: 'https://fixture.test/', title: 'Fixture', elements: 1,
    sig: 'same', textLen: 4, scrollY: 0, readyState: 'complete', target: 'pressed',
  }
  t.mock.method(session, 'isRunning', () => true)
  t.mock.method(session, 'claimActiveTab', () => null)
  t.mock.method(session, 'sampleState', async () => sample)
  t.mock.method(session, 'recordStep', () => {})
  const click = t.mock.method(session, 'click', async () => ({ ok: true, warnings: [] }))
  t.mock.method(session, 'explainNoEffect', async () => ({
    known: true, label: 'Mute', reasons: ['it was already pressed (aria-pressed="true")'],
  }))
  const definition = JSON.stringify(await audit.toolToAPISchema(audit.BrowserTool, options))
  const { data } = await audit.BrowserTool.call(
    { action: 'click', ref: 5 }, { abortController: new AbortController() },
  )
  assert.equal(data.ok, true, data.message)
  assert.equal(click.mock.callCount(), 1, 'no diagnostic retry should be introduced')
  assert.match(data.receipt, /NO OBSERVABLE EFFECT/)
  const rendered = audit.BrowserTool.mapToolResultToToolResultBlockParam(data, 'click-test').content
  assert.match(rendered, /Target state notes:.*aria-pressed/)
  assert.doesNotMatch(rendered, /Nothing changed because|overlap is the reason/)
  assert.equal(JSON.stringify(await audit.toolToAPISchema(audit.BrowserTool, options)), definition)
  audit.clearToolSchemaCache()
  assert.equal(JSON.stringify(await audit.toolToAPISchema(audit.BrowserTool, options)), definition)
})

test('Browser state guidance reuses evidence within its token budget', async () => {
  const prompt = await audit.BrowserTool.prompt()
  assert.match(prompt, /Same URL does not mean same content/)
  assert.match(prompt, /Update assumptions after known changes; use returned evidence first/)
  assert.match(prompt, /Check against task requirements/)
  const tokens = Math.round((JSON.stringify(prompt).length - 2) / 4)
  // Original Browser prompt: 2,556 using Tau's serialized-character estimator.
  assert.ok(tokens <= 2_656, `${tokens - 2_556} estimated added tokens exceeds 100`)
})

test('Browser state guidance preserves evidence without automatic checks or cache drift', async t => {
  const url = 'https://fixture.test/article'
  const before = {
    docId: 'd1', url, title: 'Article', elements: 1,
    sig: 'original', textLen: 100, scrollY: 0, readyState: 'complete',
  }
  const observation = { url, title: 'Article', interactive_elements: [] }
  const pickResult = (tag, text) => ({
    ok: true, warnings: [],
    picked: { tag, text, textLength: text.length, selector: tag, openTag: `<${tag}>`,
      box: { x: 0, y: 0, w: 100, h: 20 } },
    observation: { ...observation, interactive_elements: [{ id: 2057, tag, text, picked: true }] },
  })
  const scenarios = [
    { name: 'same-URL replacement exposes DOM change', input: { action: 'eval', js: 'document.querySelector("main").textContent = "Replaced content"' },
      returns: { evalJs: { ok: true, value: '"Replaced content"' } },
      after: { ...before, sig: 'replaced', textLen: 16 }, ok: true,
      evidence: /url unchanged.*same document.*dom changed/ },
    { name: 'read-only eval adds no observation', input: { action: 'eval', js: 'document.title' },
      returns: { evalJs: { ok: true, value: '"Article"' } }, ok: true, evidence: /Result:\s*"Article"/ },
    { name: 'unverified eval does not trigger retries', input: { action: 'eval', js: 'true' },
      returns: { evalJs: { ok: true, value: 'true' } }, after: null, ok: true, evidence: /unverified/ },
    { name: 'failed eval exposes its error', input: { action: 'eval', js: 'throw new Error("fixture failure")' },
      returns: { evalJs: { ok: false, error: 'fixture failure' } }, ok: false, evidence: /JavaScript failed: fixture failure/ },
    { name: 'stale read does not silently restart or reload', input: { action: 'read', offset: 200 },
      returns: { readPage: { success: true, stale: true, url } }, ok: false, evidence: /Reason: stale_read/ },
    { name: 'shifted read continues without rereading', input: { action: 'read', offset: 200 },
      returns: { readPage: { success: true, url, content: 'continued text', offset: 220, total: 500, shift: 20 } },
      ok: true, evidence: /page shifted by 20 characters/ },
    { name: 'wrong test target remains visible as a paragraph', input: { action: 'pick', text: 'Pick the article title' },
      returns: { pick: pickResult('p', 'Replaced content.') }, ok: true, evidence: /The user picked @2057: p "Replaced content\."/ },
    { name: 'valid user choice is not overridden by hint text', input: { action: 'pick', text: 'Point at the item you mean' },
      returns: { pick: pickResult('button', 'Second choice') }, ok: true, evidence: /The user picked @2057: button "Second choice"/ },
    { name: 'cancelled pick does not reopen the picker', input: { action: 'pick' },
      returns: { pick: { ok: false, reason: 'pick_cancelled', error: 'The user closed the picker.', warnings: [] } },
      ok: false, evidence: /Reason: pick_cancelled/ },
    { name: 'same-URL navigation reuses its existing observation', input: { action: 'navigate', url },
      returns: { navigate: undefined, observe: { observation, warnings: [] } },
      after: { ...before, docId: 'd2' }, ok: true, evidence: /url unchanged.*new document/ },
    { name: 'successful SPA click needs no extra refresh', input: { action: 'click', text: 'Details' },
      returns: { click: { ok: true, observation, warnings: [] } },
      after: { ...before, sig: 'details' }, ok: true, evidence: /url unchanged.*dom changed/ },
  ]
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const session = audit.getBrowserSession()
    t.mock.method(session, 'isRunning', () => true)
    t.mock.method(session, 'claimActiveTab', () => null)
    t.mock.method(session, 'recordStep', () => {})
    t.mock.method(session, 'drainSessionNotes', () => [])
    t.mock.method(session, 'drainWatchAlerts', () => [])
    let samples = 0
    t.mock.method(session, 'sampleState', async () => samples++ === 0
      ? before : Object.hasOwn(scenario, 'after') ? scenario.after : before)
    const calls = []
    for (const method of ['evalJs', 'readPage', 'pick', 'navigate', 'observe', 'reload', 'screenshot', 'click', 'ensureStarted']) {
      t.mock.method(session, method, async () => {
        calls.push(method)
        assert.ok(Object.hasOwn(scenario.returns, method), `unexpected ${method}`)
        return scenario.returns[method]
      })
    }
    const definition = JSON.stringify(await audit.toolToAPISchema(audit.BrowserTool, options))
    const { data } = await audit.BrowserTool.call(scenario.input, { abortController: new AbortController() })
    assert.equal(data.ok, scenario.ok, data.message)
    const rendered = audit.BrowserTool.mapToolResultToToolResultBlockParam(data, 'state-test').content
    assert.match(rendered, scenario.evidence)
    if (scenario.input.action === 'read' && !scenario.ok) assert.equal(data.pageText, undefined)
    assert.deepEqual(calls, Object.keys(scenario.returns), 'no extra observation, retry or reload')
    assert.equal(samples, 2, 'only the existing before/after samples')
    assert.equal(JSON.stringify(await audit.toolToAPISchema(audit.BrowserTool, options)), definition)
    audit.clearToolSchemaCache()
    assert.equal(JSON.stringify(await audit.toolToAPISchema(audit.BrowserTool, options)), definition)
  })
})

test('Eval keeps the fixes for its observed failures', async () => {
  // Each line answers an incident recorded in 015c3694 and in prompt.ts.
  const prompt = await audit.EvalTool.prompt(options)
  for (const [rule, pattern] of [
    // "never re-define" alone did not stop a helper being re-imported every cell.
    ['worked example: gather once, reuse next cell', /# cell 1[\s\S]*tool\.Grep\([\s\S]*# cell 2[\s\S]*counts/],
    ['only printed rows reach the conversation', /412 matched lines never entered the conversation/],
    ['helpers stay in the kernel', /write a helper to disk to re-import/],
    // len() on a result string once reported 4,249 files that do not exist.
    ['results are text, not lists', /a str, not a list/],
    ['len() counts characters', /len\(result\)` counts characters/],
    // A ranking followed into find | xargs took three attempts and ranked wrong.
    ['the incident pipeline is computing', /xargs wc -l \| sort \| head`\) is \*\*computing\*\* → cell/],
    ['xargs corrupts totals', /batching silently corrupts totals/],
    ['patterned edits are computing', /thirty patterned edits are computing/],
    // An unscoped walk answered 1,736 where the truth was 590.
    ['duplicate trees inflate counts plausibly', /inflated figure looks plausible/],
    ['no hand-typed roots', /Never type an absolute root/],
  ]) assert.match(prompt, pattern, rule)
})

test('Agent keeps its briefing and lifecycle guidance', async () => {
  const prompt = await audit.AgentTool.prompt(options)
  for (const [rule, pattern] of [
    ['brief like a colleague who just walked in', /smart colleague who just walked into the room/],
    ['never delegate understanding', /Never delegate understanding/],
    ['implementation prompts name target, change, acceptance', /Target:\*\*[\s\S]*Change:\*\*[\s\S]*Acceptance:\*\*/],
    ['background only for independent work', /run_in_background only for genuinely independent/],
    ['no polling for completion', /do NOT sleep, poll or proactively check/],
    ['proactive only when the description says so', /description says to use it proactively/],
    ['parallel agents get settled contracts', /guessed twice, differently/],
  ]) assert.match(prompt, pattern, rule)
})

test('every point of the pre-compression prompts is still covered', async () => {
  // 193 points read from HEAD de2e0189's rendered prompts. Shortening is fine;
  // dropping a point is a decision: delete it from the JSON and say why.
  const points = JSON.parse(readFileSync(resolve('test/tool-prompt-points.json'), 'utf8'))
  const missing = []
  for (const tool of tools) {
    const text = await tool.prompt(options)
    const flat = text.replace(/\s+/g, ' ')
    for (const point of points[tool.name]) {
      if (point.platform === 'windows' && process.platform !== 'win32') continue
      if (point.skipIfEnv && /^(1|true|yes|on)$/i.test(process.env[point.skipIfEnv] ?? '')) continue
      const covered = point.all.every(source => {
        const pattern = new RegExp(source, 'i')
        return pattern.test(flat) || pattern.test(text)
      })
      if (!covered) missing.push(`${tool.name} ${point.id} ${point.point}`)
    }
  }
  assert.deepEqual(missing, [], `points lost:\n${missing.join('\n')}`)
})

test('guidance compression stays within its budget without charging schemas', async () => {
  let tokens = 0
  for (const tool of tools) {
    const prompt = await tool.prompt(options)
    tokens += Math.round((JSON.stringify(prompt).length - 2) / 4)
  }
  // Small headroom for platform and attribution variants. Before: ~8,207.
  // A first pass reached 4,955 by dropping 35 of the 193 covered points;
  // restoring them, plus two git rules 076bb45f dropped, costs ~5,847
  // (Windows rendering).
  assert.ok(tokens <= 5_950, `${tokens} estimated prompt tokens exceeds 5,950`)
})
