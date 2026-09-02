/**
 * Lane reachability for the Eval tool.
 *
 * Run via: bun run src/tools/EvalTool/lanes.test.ts
 *
 * Tau speaks 22 providers across 16 lanes, and several of them filter the tool
 * list on the way out — the Cursor exclusion set, Groq's curated small-tier
 * subset, NIM's fast subset, Gemini's deferred-tool selection. A tool can be
 * registered, enabled, and still never reach a given provider. These tests pin
 * that Eval survives each filter, and that it is never hidden behind a
 * ToolSearch round-trip on any of them.
 */

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { EVAL_TOOL_NAME } from './constants.js'
import {
  filterProviderToolsForLane,
  filterSharedToolsForLane,
} from '../../lanes/tool_filter.js'
import {
  isSmallTierGroqModel,
  isToolKeptByGroqSmallTierFilter,
} from '../../lanes/openai-compat/groq_tool_policy.js'
import { isToolKeptByNimFastFilter } from '../../lanes/openai-compat/nim_tool_policy.js'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    const message = e instanceof Error ? e.message : String(e)
    failures.push(`${name}: ${message}`)
    console.log(`  FAIL ${name}: ${message}`)
  }
}

const LANES = [
  'claude',
  'codex',
  'gemini',
  'qwen',
  'openai-compat',
  'cline',
  'kilo',
  'kiro',
  'cursor',
] as const

console.log('\nlane reachability')

test('every lane keeps Eval in its provider tool list', () => {
  const tools = [
    { name: 'Read' },
    { name: 'Bash' },
    { name: EVAL_TOOL_NAME },
  ] as never as Parameters<typeof filterProviderToolsForLane>[1]

  for (const lane of LANES) {
    const kept = filterProviderToolsForLane(lane, tools).map(tool => tool.name)
    assert(
      kept.includes(EVAL_TOOL_NAME),
      `${lane} dropped ${EVAL_TOOL_NAME} from its provider tools`,
    )
  }
})

test('every lane keeps Eval in its shared tool list', () => {
  const shared = [
    { implId: 'Read', anthropicDef: { name: 'Read' } },
    { implId: EVAL_TOOL_NAME, anthropicDef: { name: EVAL_TOOL_NAME } },
  ] as never as Parameters<typeof filterSharedToolsForLane>[1]

  for (const lane of LANES) {
    const kept = filterSharedToolsForLane(lane, shared).map(tool => tool.implId)
    assert(
      kept.includes(EVAL_TOOL_NAME),
      `${lane} dropped ${EVAL_TOOL_NAME} from its shared tools`,
    )
  }
})

test('Cursor does not exclude Eval', () => {
  // Cursor is the one lane with a hardcoded exclusion set. It strips the
  // Tau-addition tools; Eval is core capability, not an addition.
  const tools = [{ name: EVAL_TOOL_NAME }, { name: 'ArtifactCanvas' }] as never as Parameters<
    typeof filterProviderToolsForLane
  >[1]
  const kept = filterProviderToolsForLane('cursor', tools).map(tool => tool.name)
  assert(kept.includes(EVAL_TOOL_NAME), 'cursor dropped Eval')
  assert(
    !kept.includes('ArtifactCanvas'),
    'the cursor exclusion set stopped working, so this test proves nothing',
  )
})

test("Groq's curated small tier keeps Eval", () => {
  // Small models are the ones that can least afford to burn a context window
  // re-reading files to count something.
  for (const model of ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']) {
    assert(isSmallTierGroqModel(model), `${model} should match the small tier`)
    assert(
      isToolKeptByGroqSmallTierFilter(model, EVAL_TOOL_NAME),
      `groq small tier dropped Eval for ${model}`,
    )
  }
  // A non-small-tier model keeps everything, so it proves nothing on its own.
  assert(
    isToolKeptByGroqSmallTierFilter('kimi-k2-instruct', 'AnythingAtAll'),
    'the groq filter should be inert for large-tier models',
  )
})

test("NIM's fast subset keeps Eval", () => {
  assert(
    isToolKeptByNimFastFilter(EVAL_TOOL_NAME),
    'the NIM fast subset dropped Eval',
  )
  assert(
    !isToolKeptByNimFastFilter('ArtifactCanvas'),
    'the NIM filter stopped filtering, so this test proves nothing',
  )
})

test('Eval is never deferred behind a ToolSearch round-trip', () => {
  // `isDeferredTool` ends in `return tool.shouldDefer === true`. Setting
  // shouldDefer would put the kernel behind a discovery call on the lanes that
  // defer, and would break cheap mode's promise that it never hides a tool
  // behind a lookup. Asserted on the source: importing EvalTool.js pulls in
  // ink, which does not resolve under bun in this tree.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'EvalTool.ts'), 'utf8')
  assert(
    !source.includes('shouldDefer'),
    'Eval declares shouldDefer; every provider must receive its schema eagerly',
  )
  assert(
    source.includes('buildTool({'),
    'EvalTool.ts no longer looks like a tool definition, so this test proves nothing',
  )
})

test('Eval is in the cheap-mode core set', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(
    join(here, '..', '..', 'constants', 'cheapModeTools.ts'),
    'utf8',
  )
  assert(
    source.includes('  EVAL_TOOL_NAME,'),
    'cheap mode dropped Eval',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
if (failed > 0) process.exit(1)
