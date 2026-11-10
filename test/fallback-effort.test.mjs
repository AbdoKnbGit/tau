import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const tempRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(tempRoot, 'tau-fallback-effort-'))
process.env.CLAUDE_CONFIG_DIR = fixture
process.env.DISABLE_TELEMETRY = '1'
delete process.env.CLAUDE_CODE_EFFORT_LEVEL

const r = await loadMcpRuntime({
  paths: ['src/utils/fallback/apply.ts', 'src/utils/model/openaiReasoning.ts'],
  exports: ['getOpenAIReasoningLevel', 'setOpenAIReasoningLevel',
    'getMainLoopModelOverride',
    `applyFallbackFixture: target => {
      const previous = getAPIProvider;
      try {
        // No provider switch or config write is needed when applying the
        // fallback to its already-active provider.
        getAPIProvider = () => target.provider;
        return applyFallbackTargetToRuntime(target);
      } finally { getAPIProvider = previous; }
    }`],
})

test.after(() => {
  const resolved = realpathSync(fixture)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup')
  rmSync(resolved, { recursive: true, force: true })
})

test.beforeEach(() => {
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  r.setOpenAIReasoningLevel('high')
})

for (const effort of ['none', 'max']) {
  test(`fallback to Terra restores ${effort} for requests and the standalone picker`, () => {
    const value = r.applyFallbackFixture({ provider: 'openai', model: 'gpt-6.1-terra', effort })
    assert.equal(value, effort)
    assert.equal(r.getMainLoopModelOverride(), 'gpt-6.1-terra')
    assert.equal(r.getOpenAIReasoningLevel('gpt-6.1-terra', value), effort)
    assert.equal(r.getOpenAIReasoningLevel('gpt-6.1-terra'), effort)
  })
}

test('unsupported fallback effort is clamped without overwriting the original preference', () => {
  const value = r.applyFallbackFixture({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'none' })
  assert.equal(value, 'none')
  assert.equal(r.getOpenAIReasoningLevel('gpt-6.1-sol'), 'low')
  assert.equal(r.getOpenAIReasoningLevel('gpt-6.1-terra'), 'none')
})

test('non-reasoning fallback models cannot overwrite OpenAI picker effort', () => {
  assert.equal(r.applyFallbackFixture({ provider: 'openai', model: 'gpt-4.1', effort: 'none' }), 'none')
  assert.equal(r.getOpenAIReasoningLevel('gpt-6.1-terra'), 'high')
})

test('fallbacks through another provider keep OpenAI picker state isolated', () => {
  for (const effort of ['none', 'max']) {
    assert.equal(r.applyFallbackFixture({ provider: 'openrouter', model: 'openai/gpt-6.1-terra', effort }), effort)
    assert.equal(r.getOpenAIReasoningLevel('gpt-6.1-terra'), 'high')
  }
})
