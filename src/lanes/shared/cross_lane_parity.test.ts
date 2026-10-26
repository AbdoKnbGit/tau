/**
 * Cross-lane parity tests.
 *
 * Every lane must emit the same three tool-call protections, adapted
 * to its native idiom:
 *
 *   1. Server-side schema enforcement
 *        Gemini  → toolConfig.functionCallingConfig.mode = 'VALIDATED'
 *        Codex   → function tools get strict: true
 *        Qwen    → function.strict: true
 *        Compat  → function.strict: true (where provider honors it)
 *
 *   2. STRICT PARAMETERS description hint
 *        All four lanes append via appendStrictParamsHint().
 *
 *   3. TOOL_USAGE_RULES system-prompt preamble
 *        Lane-specific constants in mcp_bridge.ts.
 *
 * This test asserts presence of (2) and (3). (1) is asserted indirectly
 * by the tool-build functions in each lane; see validated_mode.test.ts
 * for the hint-helper unit tests.
 *
 * Run:  bun run src/lanes/shared/cross_lane_parity.test.ts
 */

import {
  GEMINI_TOOL_USAGE_RULES,
  CODEX_TOOL_USAGE_RULES,
  QWEN_TOOL_USAGE_RULES,
  OPENAI_COMPAT_TOOL_USAGE_RULES,
  appendStrictParamsHint,
} from './mcp_bridge.js'
import { MCP_INSTRUCTION_UPDATES_GUIDANCE } from '../../constants/mcpInstructions.js'

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
  console.log('cross-lane parity (tool call protections):')

  const preambles: Array<{ lane: string; rules: string }> = [
    { lane: 'gemini', rules: GEMINI_TOOL_USAGE_RULES },
    { lane: 'codex', rules: CODEX_TOOL_USAGE_RULES },
    { lane: 'qwen', rules: QWEN_TOOL_USAGE_RULES },
    { lane: 'openai-compat', rules: OPENAI_COMPAT_TOOL_USAGE_RULES },
  ]

  // Every lane has a TOOL_USAGE_RULES preamble defined.
  for (const { lane, rules } of preambles) {
    test(`${lane} exports non-empty TOOL_USAGE_RULES`, () => {
      assert(typeof rules === 'string' && rules.length > 50,
        `${lane} rules too short: ${rules.length}`)
    })
  }

  // Every preamble carries the three core nudges (wording varies by lane).
  const coreNudges: Array<[RegExp, string]> = [
    [/required|never send empty|never omit/i, 'required-field nudge'],
    [/case-sensitive|exactly/i, 'case-sensitivity / exact-name nudge'],
    [/types exactly|match.*type|array.*object/i, 'type-match nudge'],
  ]
  for (const { lane, rules } of preambles) {
    for (const [re, label] of coreNudges) {
      test(`${lane} preamble carries ${label}`, () => {
        assert(re.test(rules), `missing ${label} in ${lane}:\n${rules}`)
      })
    }
  }

  // Every preamble carries the failure-recovery nudge: when a tool call
  // fails, diagnose the cause and don't iterate cosmetic variants of the
  // same call. Without this, non-Claude models fall into multi-turn
  // syntax-flailing on unfamiliar CLIs/containers/etc., burning input
  // tokens. The exact wording varies; the *intent* must be present in
  // every lane.
  const diagnoseNudges: Array<[RegExp, string]> = [
    [/diagnose|exit code|error text/i, 'diagnose-the-failure nudge'],
    [/cosmetic variants|blind retries|don'?t iterate|don'?t retry/i, 'no-blind-retry nudge'],
    [/--help|docs|documentation/i, 'check-docs-before-guessing nudge'],
  ]
  for (const { lane, rules } of preambles) {
    for (const [re, label] of diagnoseNudges) {
      test(`${lane} preamble carries ${label}`, () => {
        assert(re.test(rules), `missing ${label} in ${lane}:\n${rules}`)
      })
    }
  }

  // Every preamble stays small so cache cost stays small. The MCP updates
  // guidance is one block every lane carries verbatim, so it is budgeted once
  // and each lane's own rules get the rest. The lane budget was 1KB of
  // everything until that block (d32cd66), the deferred-tool rule (3cdf4e3)
  // and Codex's tool-name rule (d02801b) were added on purpose.
  test('shared MCP guidance under 512 bytes', () => {
    const b = Buffer.byteLength(MCP_INSTRUCTION_UPDATES_GUIDANCE, 'utf-8')
    assert(b < 512, `shared MCP guidance too long: ${b} bytes`)
  })
  for (const { lane, rules } of preambles) {
    test(`${lane} preamble under 1280 bytes besides the shared MCP guidance`, () => {
      assert(rules.includes(MCP_INSTRUCTION_UPDATES_GUIDANCE), `${lane} preamble lacks the shared MCP guidance`)
      const b = Buffer.byteLength(rules.replace(MCP_INSTRUCTION_UPDATES_GUIDANCE, ''), 'utf-8')
      assert(b < 1280, `${lane} preamble too long: ${b} bytes`)
    })
  }

  // appendStrictParamsHint is idempotent across all lanes (same helper).
  test('appendStrictParamsHint is idempotent (single helper across lanes)', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    }
    const a = appendStrictParamsHint('desc', schema)
    const b = appendStrictParamsHint(a, schema)
    assert(a === b, 'hint double-applied')
  })

  test('appendStrictParamsHint names required fields', () => {
    const hinted = appendStrictParamsHint('Runs command', {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    })
    assert(hinted.includes('command: string REQUIRED'),
      `REQUIRED marker missing: ${hinted}`)
  })

  // Preamble cross-contamination check — each is distinct.
  test('preambles are distinct strings (no copy-paste)', () => {
    const set = new Set(preambles.map(p => p.rules))
    assert(set.size === preambles.length,
      'two lanes share the same preamble text — each should be tuned natively')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
