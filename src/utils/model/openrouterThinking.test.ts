/**
 * Run: bun run src/utils/model/openrouterThinking.test.ts
 */

process.env.TAU_OPENROUTER_REASONING_CATALOG = '0'
process.env.TAU_OPENROUTER_THINKING_STORE =
  `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/tau-openrouter-thinking-test.json`

import {
  deriveOpenRouterReasoningRows,
  getOpenRouterReasoningMeta,
  _resetOpenRouterReasoningCatalogForTests,
} from './openrouterReasoningCatalog.js'
import {
  cycleOpenRouterEffort,
  getOpenRouterEffort,
  getOpenRouterEffortChipLabel,
  getOpenRouterEffortLabel,
  openRouterEffortLevelsFor,
  resolveOpenRouterReasoningField,
  setOpenRouterEffort,
  supportsOpenRouterEffortSelection,
  _resetOpenRouterThinkingForTests,
} from './openrouterThinking.js'

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

function assertEq(actual: unknown, expected: unknown, hint: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${hint}: got ${a}, want ${b}`)
}

/** The shape OpenRouter's /api/v1/models actually publishes, trimmed. */
const LIVE_PAYLOAD = {
  data: [
    {
      id: 'meta/muse-spark-1.3-contributor',
      reasoning: {
        mandatory: true,
        supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'],
        default_effort: 'medium',
      },
    },
    {
      id: 'x-ai/grok-4.20',
      reasoning: {
        mandatory: false,
        default_enabled: true,
        supported_efforts: ['max', 'high', 'low'],
        default_effort: 'high',
      },
    },
    {
      id: 'deepseek/deepseek-v3.2',
      reasoning: { mandatory: false, default_enabled: false },
    },
    {
      id: 'z-ai/glm-5',
      reasoning: {
        mandatory: false,
        supported_efforts: ['xhigh', 'high', 'medium', 'low', 'none'],
      },
    },
    // A row that does not reason at all — no `reasoning` object.
    { id: 'openai/gpt-5.5-chat' },
  ],
}

function installCatalog(): void {
  _resetOpenRouterReasoningCatalogForTests(deriveOpenRouterReasoningRows(LIVE_PAYLOAD))
  _resetOpenRouterThinkingForTests()
}

test('derives one row per reasoning-capable model, skipping the rest', () => {
  const rows = deriveOpenRouterReasoningRows(LIVE_PAYLOAD)
  assertEq(
    Object.keys(rows).sort(),
    ['deepseek/deepseek-v3.2', 'meta/muse-spark-1.3-contributor', 'x-ai/grok-4.20', 'z-ai/glm-5'],
    'only rows carrying a reasoning object are described',
  )
  assert(!('openai/gpt-5.5-chat' in rows), 'a non-reasoning row must not be described')
})

test('reorders each published ladder least → most effort', () => {
  installCatalog()
  assertEq(
    getOpenRouterReasoningMeta('meta/muse-spark-1.3-contributor')?.efforts,
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    'Muse Spark ladder ascends',
  )
  assertEq(
    getOpenRouterReasoningMeta('x-ai/grok-4.20')?.efforts,
    ['low', 'high', 'max'],
    'a sparse ladder keeps its own values, ascending',
  )
})

test('a routing variant resolves to its base row', () => {
  installCatalog()
  assert(
    getOpenRouterReasoningMeta('z-ai/glm-5:free') !== undefined,
    ':free selects an endpoint, not a different model',
  )
})

test('mandatory rows are never offered an Off stop', () => {
  installCatalog()
  assertEq(
    openRouterEffortLevelsFor('meta/muse-spark-1.3-contributor'),
    ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    'reasoning cannot be switched off on a mandatory row',
  )
})

test('optional rows get Off, and a published none suppresses it', () => {
  installCatalog()
  assertEq(
    openRouterEffortLevelsFor('x-ai/grok-4.20'),
    ['default', 'off', 'low', 'high', 'max'],
    'an optional row can stop reasoning',
  )
  assertEq(
    openRouterEffortLevelsFor('z-ai/glm-5'),
    ['default', 'none', 'low', 'medium', 'high', 'xhigh'],
    'a row publishing its own none is not given a second way to say it',
  )
})

test('a reasoning row with no ladder cycles Default/Off/On', () => {
  installCatalog()
  assertEq(
    openRouterEffortLevelsFor('deepseek/deepseek-v3.2'),
    ['default', 'off', 'on'],
    'a toggle-only row still gets a chip',
  )
})

test('an undescribed model shows no chip', () => {
  installCatalog()
  assertEq(openRouterEffortLevelsFor('openai/gpt-5.5-chat'), ['default'], 'single stop')
  assert(
    !supportsOpenRouterEffortSelection('openai/gpt-5.5-chat'),
    'a row OpenRouter does not describe must not offer a ladder',
  )
})

test('cycling walks the model’s own ladder and wraps', () => {
  installCatalog()
  const model = 'x-ai/grok-4.20'
  assertEq(cycleOpenRouterEffort(model, 'right'), 'off', 'default → off')
  assertEq(cycleOpenRouterEffort(model, 'right'), 'low', 'off → low')
  assertEq(cycleOpenRouterEffort(model, 'left'), 'off', 'low → off')
  assertEq(cycleOpenRouterEffort(model, 'left'), 'default', 'off → default')
  assertEq(cycleOpenRouterEffort(model, 'left'), 'max', 'default wraps to the top')
})

test('a stop the model no longer publishes is ignored', () => {
  installCatalog()
  // xhigh was never on grok-4.20's ladder — a stale store entry must not ride.
  _resetOpenRouterThinkingForTests({ 'x-ai/grok-4.20': 'xhigh' })
  assertEq(getOpenRouterEffort('x-ai/grok-4.20'), 'default', 'off-ladder stop falls back')
})

test('an explicit pick is what goes on the wire', () => {
  installCatalog()
  setOpenRouterEffort('meta/muse-spark-1.3-contributor', 'xhigh')
  assertEq(
    resolveOpenRouterReasoningField('meta/muse-spark-1.3-contributor', {
      enabled: true,
      effort: 'low',
    }),
    { effort: 'xhigh' },
    'the chip outranks the session budget',
  )
})

test('the session budget only names an effort the row published', () => {
  installCatalog()
  // grok-4.20 publishes low/high/max — `medium` is not on it.
  assertEq(
    resolveOpenRouterReasoningField('x-ai/grok-4.20', { enabled: true, effort: 'medium' }),
    { enabled: true },
    'an off-ladder budget value is never sent as an effort',
  )
  assertEq(
    resolveOpenRouterReasoningField('x-ai/grok-4.20', { enabled: true, effort: 'high' }),
    { effort: 'high' },
    'a budget value the row published is sent as-is',
  )
})

test('thinking off never sends enabled:false to a mandatory row', () => {
  installCatalog()
  assertEq(
    resolveOpenRouterReasoningField('meta/muse-spark-1.3-contributor', {
      enabled: false,
      effort: null,
    }),
    undefined,
    'a mandatory row is left alone rather than 400d',
  )
  assertEq(
    resolveOpenRouterReasoningField('x-ai/grok-4.20', { enabled: false, effort: null }),
    { enabled: false },
    'an optional row honours thinking off',
  )
})

test('an undescribed model puts nothing on the wire', () => {
  installCatalog()
  assertEq(
    resolveOpenRouterReasoningField('openai/gpt-5.5-chat', { enabled: true, effort: 'high' }),
    undefined,
    'silence is the only safe answer for a row nobody described',
  )
})

test('labels read the way the ladder is spelled', () => {
  assertEq(getOpenRouterEffortLabel('xhigh'), 'xHigh', 'xhigh is not Xhigh')
  assertEq(getOpenRouterEffortLabel('minimal'), 'Minimal', '')
  assertEq(getOpenRouterEffortLabel('default'), 'Default', '')
})

test('the chip names what each stop actually does', () => {
  assertEq(getOpenRouterEffortChipLabel('high'), 'High effort', '')
  assertEq(getOpenRouterEffortChipLabel('default'), 'Default effort', '')
  assertEq(getOpenRouterEffortChipLabel('on'), 'Thinking On', 'a toggle stop is not an effort rung')
  assertEq(getOpenRouterEffortChipLabel('off'), 'Thinking Off', 'a toggle stop is not an effort rung')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
