/**
 * Regression tests for the three belt-and-suspenders protections
 * that prevent Flash-class models from emitting empty-args tool calls:
 *
 *   1. toolConfig.functionCallingConfig.mode === 'VALIDATED' on every
 *      tool-enabled request (server-side schema enforcement).
 *   2. TOOL_USAGE_RULES preamble prepended to systemInstruction when
 *      tools are present.
 *   3. STRICT PARAMETERS summary appended to every tool description.
 *
 * Run:  bun run src/lanes/gemini/validated_mode.test.ts
 */

import {
  appendStrictParamsHint,
  buildStrictParamsSummary,
  GEMINI_TOOL_USAGE_RULES,
} from '../shared/mcp_bridge.js'
import { GEMINI_TOOL_REGISTRY } from './tools.js'

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
  console.log('gemini validated-mode + hint regression:')

  // ── buildStrictParamsSummary ────────────────────────────────────
  test('summary labels required fields REQUIRED', () => {
    const s = buildStrictParamsSummary({
      type: 'object',
      properties: { command: { type: 'string' }, dir_path: { type: 'string' } },
      required: ['command'],
    })
    assert(s.includes('command: string REQUIRED'),
      `want 'command: string REQUIRED' in summary: ${s}`)
    assert(!s.includes('dir_path: string REQUIRED'),
      `dir_path should not be marked REQUIRED: ${s}`)
  })

  test('summary renders enum values compactly', () => {
    const s = buildStrictParamsSummary({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b', 'c'] } },
      required: [],
    })
    assert(s.includes('mode: string enum(a|b|c)'),
      `enum not rendered: ${s}`)
  })

  test('summary renders nested object children', () => {
    const s = buildStrictParamsSummary({
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
      required: [],
    })
    assert(s.includes('filter: {q: string REQUIRED}'),
      `nested not rendered: ${s}`)
  })

  // ── appendStrictParamsHint ──────────────────────────────────────
  test('appends STRICT PARAMETERS: line to description', () => {
    const d = appendStrictParamsHint('Runs a shell command.', {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    })
    assert(d.includes('Runs a shell command.'), 'base description kept')
    assert(d.includes('STRICT PARAMETERS:'), 'hint added')
    assert(d.includes('command: string REQUIRED'), 'required field in hint')
  })

  test('hint is idempotent (does not stack)', () => {
    const once = appendStrictParamsHint('Run it', {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    })
    const twice = appendStrictParamsHint(once, {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    })
    assert(once === twice, 'calling twice must be a no-op on the second call')
  })

  test('hint works when description is empty', () => {
    const d = appendStrictParamsHint('', {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    })
    assert(d.startsWith('STRICT PARAMETERS:'),
      `empty-desc path should lead with STRICT PARAMETERS, got: ${d.slice(0, 60)}`)
  })

  // ── TOOL_USAGE_RULES ────────────────────────────────────────────
  test('run_shell_command advertises Bash syntax for the Bash implementation', () => {
    const reg = GEMINI_TOOL_REGISTRY.find(r => r.nativeName === 'run_shell_command')!
    assert(reg.implId === 'Bash', 'run_shell_command must be backed by Bash')
    assert(/Bash\/POSIX/i.test(reg.nativeDescription), 'description must tell Gemini to use Bash syntax')
    assert(reg.nativeDescription.includes('is_background'), 'description must steer to tracked background execution')
    assert(reg.nativeDescription.includes('echo $!'), 'description must warn against pid capture')
    assert(reg.nativeDescription.includes('docker compose up -d'), 'description must warn against Docker detach')
    assert(!/powershell/i.test(reg.nativeDescription), 'description must not advertise PowerShell')
    const command = reg.nativeSchema.properties?.command
    assert(typeof command === 'object' && command !== null && !Array.isArray(command), 'command schema missing')
    const commandDescription = String((command as { description?: unknown }).description ?? '')
    assert(/Bash\/POSIX/i.test(commandDescription), 'command field must tell Gemini to use Bash syntax')
    assert(commandDescription.includes('echo $!'), 'command field must warn against pid capture')
    assert(!/powershell/i.test(commandDescription), 'command field must not advertise PowerShell')
  })

  test('TOOL_USAGE_RULES contains schema, recovery, and primitive nudges', () => {
    const r = GEMINI_TOOL_USAGE_RULES
    assert(r.includes('<TOOL_USAGE_RULES>'), 'XML wrapper present')
    assert(/Supply EVERY parameter listed in "required"/.test(r),
      'required-field nudge missing')
    assert(/never send empty objects/i.test(r),
      'empty-object nudge missing')
    assert(/Do not invent extra parameters/i.test(r),
      'no-invention nudge missing')
    assert(/don't retry blindly/i.test(r),
      'no-blind-retry nudge missing')
    assert(/corrected retry/i.test(r),
      'corrected-retry nudge missing')
    assert(/don't abandon a viable approach/i.test(r),
      "don't-abandon nudge missing")
    assert(/punt\/paste commands/i.test(r),
      "don't-punt nudge missing")
    assert(/background retry/i.test(r) && /retry started/i.test(r),
      'background-retry-monitoring nudge missing')
    assert(/Bash autonomy/i.test(r) && /run them/i.test(r),
      'Bash autonomy nudge missing')
    assert(/Skill tool/i.test(r) && /Only use listed skills/i.test(r),
      'Skill tool nudge missing')
    assert(/Agent tool/i.test(r) && /subagent_type/i.test(r),
      'Agent/subagent nudge missing')
    assert(/claude mcp add/i.test(r) && /normal Bash commands/i.test(r),
      'MCP command nudge missing')
  })

  test('TOOL_USAGE_RULES under 2048 bytes (cost budget)', () => {
    // The preamble lands on every Gemini turn (cached after the first), so
    // it must stay under 2KB. Three concerns share this block:
    //   1. Schema authority (anti-empty-args nudge for Flash-class).
    //   2. Failure-recovery (don't blind-retry, don't abandon, don't punt).
    //   3. Claude-Code-primitive parity (Bash autonomy, Skills, Agent, MCP).
    // Each is belt-and-suspenders against a model behavior that's expensive
    // when it slips — one prevented "punt to user" turn pays for the byte
    // cost ten times over. Cached after turn 1, so steady-state cost is zero.
    const b = Buffer.byteLength(GEMINI_TOOL_USAGE_RULES, 'utf-8')
    assert(b < 2048, `preamble too long (${b} bytes) — eats cache budget`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
