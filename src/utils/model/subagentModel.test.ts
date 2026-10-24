/**
 * Run: bun run src/utils/model/subagentModel.test.ts
 */

import {
  describeSubagentModelSetting,
  getCustomSubagentModel,
  getCustomSubagentModelProviders,
  getCustomSubagentTarget,
  getGlobalSubagentTarget,
  getSubagentModelEnvOverride,
  getSubagentModelMode,
  isConcreteModelSpec,
  isInheritModelSpec,
  isSubagentSettingScoped,
  isTierModelSpec,
  type SubagentModelSetting,
  toSubagentModelEntry,
} from './subagentModel.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function main(): void {
  console.log('sub-agent model setting:')

  test('tiers, inherit and concrete ids are told apart, whatever the case or padding', () => {
    for (const tier of ['haiku', ' SONNET ', 'Opus', 'best', 'opus[1m]', 'opusplan']) {
      assert(isTierModelSpec(tier), `${tier} is a tier`)
      assert(!isConcreteModelSpec(tier), `${tier} is not concrete`)
    }
    for (const inherit of ['inherit', ' INHERIT ']) {
      assert(isInheritModelSpec(inherit), `${inherit} is inherit`)
      assert(!isConcreteModelSpec(inherit), `${inherit} is not concrete`)
    }
    for (const blank of [undefined, '', '   ']) {
      assert(!isConcreteModelSpec(blank), `${JSON.stringify(blank)} is not concrete`)
    }
    for (const id of ['gemini-3.8-flash-medium', 'claude-opus-4-6-thinking', 'gpt-6-luna', 'Custom-Deployment']) {
      assert(isConcreteModelSpec(id), `${id} is concrete`)
    }
  })

  test('the mode defaults to auto and ignores anything it does not know', () => {
    assert(getSubagentModelMode(undefined) === 'auto', 'unset')
    assert(getSubagentModelMode({}) === 'auto', 'empty')
    assert(getSubagentModelMode({ mode: 'auto' }) === 'auto', 'auto')
    assert(getSubagentModelMode({ mode: 'custom' }) === 'custom', 'custom')
    assert(getSubagentModelMode({ mode: 'inherit' }) === 'inherit', 'inherit')
    assert(getSubagentModelMode({ mode: ' Custom ' }) === 'custom', 'hand-typed custom')
    assert(getSubagentModelMode({ mode: 'INHERIT' }) === 'inherit', 'hand-typed inherit')
    assert(getSubagentModelMode({ mode: 'fast' }) === 'auto', 'unknown')
    assert(getSubagentModelMode({ mode: 3 as never }) === 'auto', 'not a string')
  })

  test('a custom model belongs to one provider and is never read for another', () => {
    const setting: SubagentModelSetting = {
      mode: 'custom',
      models: { antigravity: ' gemini-3.8-flash-medium ', openai: 'gpt-6-sol' },
    }
    assert(getCustomSubagentModel(setting, 'antigravity') === 'gemini-3.8-flash-medium', 'trimmed antigravity pick')
    assert(getCustomSubagentModel(setting, 'openai') === 'gpt-6-sol', 'openai pick')
    assert(getCustomSubagentModel(setting, 'kiro') === undefined, 'no pick for kiro')
    assert(getCustomSubagentModel(undefined, 'openai') === undefined, 'no setting')
    const providers = getCustomSubagentModelProviders(setting)
    assert(providers.length === 2 && providers.includes('antigravity') && providers.includes('openai'), `providers=${providers}`)
  })

  test('a custom entry that cannot be sent as a model is ignored', () => {
    for (const value of ['', '  ', 'haiku', ' OPUS ', 'inherit', 42, null, ['gpt-6-sol']]) {
      const setting = { mode: 'custom', models: { openai: value } } as unknown as SubagentModelSetting
      assert(getCustomSubagentModel(setting, 'openai') === undefined, `${JSON.stringify(value)} was accepted`)
    }
    for (const models of [[], 'gpt-6-sol', null]) {
      const setting = { mode: 'custom', models } as unknown as SubagentModelSetting
      assert(getCustomSubagentModel(setting, 'openai') === undefined, `models=${JSON.stringify(models)}`)
    }
  })

  test('inherited object keys are not custom models', () => {
    const setting: SubagentModelSetting = { mode: 'custom', models: {} }
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert(getCustomSubagentModel(setting, key as never) === undefined, `${key} leaked from the prototype`)
    }
  })

  test('built-in agents follow the setting even when they name a tier; files with a model keep it', () => {
    const builtIn = { builtIn: true, agentType: 'Explore' }
    assert(isSubagentSettingScoped('haiku', builtIn), 'Explore haiku')
    assert(isSubagentSettingScoped('inherit', { builtIn: true, agentType: 'Plan' }), 'Plan inherit')
    assert(isSubagentSettingScoped(undefined, { builtIn: true, agentType: 'general-purpose' }), 'general-purpose')
    assert(isSubagentSettingScoped('sonnet', { builtIn: true, agentType: 'statusline-setup' }), 'statusline-setup sonnet')
    const file = { builtIn: false, agentType: 'reviewer' }
    assert(isSubagentSettingScoped(undefined, file), 'file without a model')
    assert(isSubagentSettingScoped('  ', file), 'file with a blank model')
    assert(!isSubagentSettingScoped('haiku', file), 'file with a tier')
    assert(!isSubagentSettingScoped('inherit', file), 'file with inherit')
    assert(!isSubagentSettingScoped('gemini-3.8-flash-high', file), 'file with a concrete model')
    assert(isSubagentSettingScoped(undefined, undefined), 'no scope, no model')
    assert(!isSubagentSettingScoped('haiku', undefined), 'no scope means a file')
  })

  test('the fork always keeps its parent model', () => {
    assert(!isSubagentSettingScoped('inherit', { builtIn: true, agentType: 'fork' }), 'fork is scoped')
    assert(!isSubagentSettingScoped(undefined, { builtIn: true, agentType: 'fork' }), 'fork without model is scoped')
  })

  test('CLAUDE_CODE_SUBAGENT_MODEL counts only when it names something', () => {
    assert(getSubagentModelEnvOverride({}) === undefined, 'unset')
    assert(getSubagentModelEnvOverride({ CLAUDE_CODE_SUBAGENT_MODEL: '' }) === undefined, 'empty')
    assert(getSubagentModelEnvOverride({ CLAUDE_CODE_SUBAGENT_MODEL: '   ' }) === undefined, 'blank')
    assert(getSubagentModelEnvOverride({ CLAUDE_CODE_SUBAGENT_MODEL: ' gpt-6-sol ' }) === 'gpt-6-sol', 'trimmed')
  })

  test('/config labels say what is in force on the current provider', () => {
    const name = (provider: string) => ({ antigravity: 'Antigravity', openai: 'OpenAI' })[provider] ?? provider
    const describe = (setting: SubagentModelSetting, env?: string) =>
      describeSubagentModelSetting(setting, 'antigravity', name, env)
    assert(describe(undefined) === 'Auto', 'unset')
    assert(describe({ mode: 'inherit' }) === 'Same as main model', 'inherit')
    assert(describe({ mode: 'custom', models: { antigravity: 'gemini-3.8-flash-medium' } }) === 'Custom: gemini-3.8-flash-medium', 'custom with a pick')
    assert(
      describe({ mode: 'custom', models: { antigravity: { model: 'claude-sonnet-4-6', effort: 'high' } } }) === 'Custom: claude-sonnet-4-6 · high',
      'custom with an effort',
    )
    assert(describe({ mode: 'custom', models: { openai: 'gpt-6-sol' } }) === 'Custom: none for Antigravity, using Auto', 'custom without a pick here')
    assert(
      describe({ mode: 'global', global: { provider: 'openai', model: 'gpt-6-luna', effort: 'low' } }) === 'Global: OpenAI / gpt-6-luna · low',
      'global with an effort',
    )
    assert(describe({ mode: 'global', global: { provider: 'openai', model: 'gpt-6-luna' } }) === 'Global: OpenAI / gpt-6-luna', 'global')
    assert(describe({ mode: 'global' }) === 'Global: none set, using Auto', 'global without a pick')
    assert(describe({ mode: 'inherit' }, 'gpt-6-sol') === 'CLAUDE_CODE_SUBAGENT_MODEL (gpt-6-sol)', 'env override')
  })

  test('the global pick names a known provider and a model that can be sent; a bad effort is dropped', () => {
    assert(getSubagentModelMode({ mode: ' Global ' }) === 'global', 'mode')
    const target = getGlobalSubagentTarget({ global: { provider: ' openai ', model: ' gpt-6-luna ', effort: ' HIGH ' } })
    assert(target?.provider === 'openai' && target.model === 'gpt-6-luna' && target.effort === 'high', JSON.stringify(target))
    const noEffort = getGlobalSubagentTarget({ global: { provider: 'openai', model: 'gpt-6-luna', effort: 'turbo' } })
    assert(noEffort !== undefined && noEffort.effort === undefined, JSON.stringify(noEffort))
    for (const global of [
      undefined, null, 'openai', [], {}, { provider: 'openai' }, { model: 'gpt-6-luna' },
      { provider: 'made-up', model: 'gpt-6-luna' }, { provider: 'OpenAI', model: 'gpt-6-luna' },
      { provider: 'openai', model: 'haiku' }, { provider: 'openai', model: 'inherit' }, { provider: 'openai', model: '  ' },
      { provider: 'openai', model: 42 },
    ]) {
      assert(getGlobalSubagentTarget({ mode: 'global', global }) === undefined, `${JSON.stringify(global)} was accepted`)
    }
  })

  test('a custom pick is an id or { model, effort }, and saves as the shorter one', () => {
    const setting: SubagentModelSetting = {
      models: { antigravity: 'gemini-3.8-flash-medium', firstParty: { model: 'claude-opus-5-5', effort: 'max' }, openai: { model: 'haiku' } },
    }
    const plain = getCustomSubagentTarget(setting, 'antigravity')
    assert(plain?.model === 'gemini-3.8-flash-medium' && plain.effort === undefined, JSON.stringify(plain))
    const withEffort = getCustomSubagentTarget(setting, 'firstParty')
    assert(withEffort?.model === 'claude-opus-5-5' && withEffort.effort === 'max', JSON.stringify(withEffort))
    assert(getCustomSubagentModel(setting, 'firstParty') === 'claude-opus-5-5', 'model of an object pick')
    assert(getCustomSubagentTarget(setting, 'openai') === undefined, 'a tier inside an object is not a model')
    assert(toSubagentModelEntry({ model: 'gpt-6-luna' }) === 'gpt-6-luna', 'plain entry')
    const entry = toSubagentModelEntry({ model: 'gpt-6-luna', effort: 'low' })
    assert(typeof entry === 'object' && entry.model === 'gpt-6-luna' && entry.effort === 'low', JSON.stringify(entry))
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
