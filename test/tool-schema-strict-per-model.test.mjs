import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// A tool's rendered schema is cached for the session by the first request that
// builds it, and that request may be for any model: a helper, an agent, a hook
// check. The cache keeps the session's strict intent (the flag and the tool);
// whether a request sends `strict` follows that request's model.
const tempRoot = realpathSync(tmpdir())
const fixtureDirectory = mkdtempSync(join(tempRoot, 'tau-strict-schema-'))
for (const key of Object.keys(process.env)) {
  if (/^(CLAUDE_CODE_USE_|ANTHROPIC_|OPENAI_|GEMINI_|CLAUDEX_)/.test(key)) delete process.env[key]
}
Object.assign(process.env, { CLAUDE_CONFIG_DIR: fixtureDirectory, DISABLE_TELEMETRY: '1' })
// Strict tools are a remote gate, off in Tau: pin it on where tool schemas are built.
const STRICT_GATE = /(if \(!base\) \{\s*const strictToolsEnabled = )checkStatsigFeatureGate_CACHED_MAY_BE_STALE\("tengu_tool_pear"\)/
let gatePinned = 0
const r = await loadMcpRuntime({
  paths: ['src/utils/api.ts'], exports: ['toolToAPISchema', 'getToolSchemaCache', 'getAPIProvider'],
  transform: source => source.replace(STRICT_GATE, (_, head) => (gatePinned++, `${head}true`)),
})
assert.equal(gatePinned, 1, 'the strict gate is pinned where tool schemas are built')

test.after(() => {
  const resolved = realpathSync(fixtureDirectory)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup path')
  rmSync(resolved, { recursive: true, force: true })
})

const tool = fixtureTool({ name: 'StrictProbe', strict: true })
const plain = fixtureTool({ name: 'PlainProbe' })
const render = (probe, model) => r.toolToAPISchema(probe, {
  getToolPermissionContext: async () => ({ mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} }),
  tools: [probe], agents: [], model,
})
const WITH_STRICT = 'claude-sonnet-4-6'
const WITHOUT_STRICT = 'claude-3-5-haiku-20241022'

test('strict follows each request\'s model, whichever model built the cached schema first', async () => {
  assert.equal(r.getAPIProvider(), 'firstParty')
  r.getToolSchemaCache().clear()
  assert.equal((await render(tool, WITHOUT_STRICT)).strict, undefined, 'a model without strict support gets none')
  assert.equal((await render(tool, WITH_STRICT)).strict, true, 'a later request for a model with support gets it')

  r.getToolSchemaCache().clear()
  const first = await render(tool, WITH_STRICT)
  assert.equal(first.strict, true)
  assert.equal((await render(tool, WITHOUT_STRICT)).strict, undefined, 'the first model does not decide for the next')
  assert.equal((await render(tool, undefined)).strict, undefined, 'no model given: no strict')
  // The field keeps its place in the rendered tool.
  assert.deepEqual(Object.keys(first), ['name', 'description', 'input_schema', 'strict'])
})

test('a tool that does not ask for strict never gets it', async () => {
  r.getToolSchemaCache().clear()
  for (const model of [WITH_STRICT, WITHOUT_STRICT]) assert.equal((await render(plain, model)).strict, undefined)
})
