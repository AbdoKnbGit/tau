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
    clearToolSchemaCache: ${sessionCacheClear}, getAllBaseTools, getBuiltInAgents };
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
  const expected = {
    Browser: '365799a28a08395d81600c65806f5cc465b8362d07d5e3f7f729fbac2c5980d4',
    Agent: 'b8d1fa710090cadc8a8ec59eb409b06d97829a32408275bcac7acf805a443b0a',
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
    ['tool-proven no-effect cause', /When the result attributes no effect/],
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
