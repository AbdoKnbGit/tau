/**
 * Optional prebuilt tool toggle unit tests.
 *
 * Run: bun run src/utils/prebuiltToolToggles.test.ts
 *
 * NOTE ON COVERAGE. These tests used to exercise `aliases` and multi-entry
 * `toolNames` through the AFT toggle, which bundled five tools under one id.
 * AFT has been removed, and no toggle in the registry has aliases or more than
 * one tool name any more — so those two branches of
 * `getPrebuiltToolToggleItem` are now supported by the types but unexercised.
 * They are deliberately not faked here: the registry is the input, and
 * inventing a fixture group would test a shape nothing ships. If a future
 * toggle bundles tools again, restore that coverage with it.
 */

import { ARTIFACT_CANVAS_TOOL_NAME } from '../tools/ArtifactCanvasTool/constants.js'
import { BROWSER_TOOL_NAME } from '../tools/BrowserTool/constants.js'
import { LSP_TOOL_NAME } from '../tools/LSPTool/prompt.js'
import { MERMAID_RENDER_TOOL_NAME } from '../tools/MermaidRenderTool/constants.js'
import { WEB_BROWSER_TOOL_NAME } from '../tools/WebBrowserTool/constants.js'
import {
  filterDisabledPrebuiltTools,
  isOptionalPrebuiltToolName,
  isPrebuiltToolDisabledByToolName,
  normalizeDisabledPrebuiltToolIds,
  setPrebuiltToolToggleEnabled,
} from './prebuiltToolToggles.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function assert(cond: unknown, hint: string): asserts cond {
  if (!cond) throw new Error(hint)
}

function assertJsonEqual(a: unknown, b: unknown, hint: string): void {
  const left = JSON.stringify(a)
  const right = JSON.stringify(b)
  if (left !== right) throw new Error(`${hint}: ${left} !== ${right}`)
}

console.log('prebuilt tool toggles:')

test('normalizes ids, casing, unknown values, and duplicates', () => {
  assertJsonEqual(
    normalizeDisabledPrebuiltToolIds([
      'unknown-tool',
      MERMAID_RENDER_TOOL_NAME,
      LSP_TOOL_NAME.toUpperCase(),
      LSP_TOOL_NAME,
    ]),
    // Input order is preserved here; canonical ordering is
    // setPrebuiltToolToggleEnabled's job, asserted separately below.
    [MERMAID_RENDER_TOOL_NAME, LSP_TOOL_NAME],
    'normalized disabled tools',
  )
})

test('filters the tool named by a disabled toggle', () => {
  const tools = [
    { name: MERMAID_RENDER_TOOL_NAME },
    { name: LSP_TOOL_NAME },
    { name: 'Read' },
  ]

  assertJsonEqual(
    filterDisabledPrebuiltTools(tools, {
      disabledPrebuiltTools: [MERMAID_RENDER_TOOL_NAME],
    }).map(tool => tool.name),
    [LSP_TOOL_NAME, 'Read'],
    'filtered tools',
  )
})

test('checks disabled state by concrete tool name', () => {
  const settings = { disabledPrebuiltTools: [MERMAID_RENDER_TOOL_NAME] }
  assert(
    isPrebuiltToolDisabledByToolName(MERMAID_RENDER_TOOL_NAME, settings),
    'MermaidRender should be disabled',
  )
  assert(
    !isPrebuiltToolDisabledByToolName(LSP_TOOL_NAME, settings),
    'LSP should stay enabled',
  )
  assert(isOptionalPrebuiltToolName(LSP_TOOL_NAME), 'LSP is optional')
  assert(!isOptionalPrebuiltToolName('Read'), 'basic tools are not optional')
})

test('recognizes browser and artifact tools as optional', () => {
  const settings = {
    disabledPrebuiltTools: [
      WEB_BROWSER_TOOL_NAME,
      ARTIFACT_CANVAS_TOOL_NAME,
      BROWSER_TOOL_NAME,
    ],
  }

  for (const name of [
    WEB_BROWSER_TOOL_NAME,
    ARTIFACT_CANVAS_TOOL_NAME,
    BROWSER_TOOL_NAME,
  ]) {
    assert(
      isPrebuiltToolDisabledByToolName(name, settings),
      `${name} should be optional`,
    )
  }
})

test('sets toggles with canonical ordering and rejects unknown ids', () => {
  const disabled = setPrebuiltToolToggleEnabled(
    [MERMAID_RENDER_TOOL_NAME, 'unknown-tool'],
    LSP_TOOL_NAME,
    false,
  )

  assertJsonEqual(
    disabled,
    [LSP_TOOL_NAME, MERMAID_RENDER_TOOL_NAME],
    'disabled tool order',
  )
  assertJsonEqual(
    setPrebuiltToolToggleEnabled(disabled ?? [], LSP_TOOL_NAME, true),
    [MERMAID_RENDER_TOOL_NAME],
    're-enabled LSP',
  )
  assert(
    setPrebuiltToolToggleEnabled(disabled ?? [], 'Read', false) === null,
    'basic tools should not be toggleable',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
