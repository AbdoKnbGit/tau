/**
 * Regression tests for shell-description rendering + single-shell
 * filter + per-transformer schema/generation extras.
 *
 * The core invariant: tool description bytes shipped to the upstream
 * provider must be DETERMINISTIC given (model, platform, psEdition).
 * Any per-call data leaking in (homedir, tmpdir, session id,
 * timestamps) would churn the upstream prompt cache every turn — the
 * exact cost regression the user asked us to avoid.
 *
 * Run:  bun run src/lanes/openai-compat/shell_descriptions.test.ts
 */

import { getCompatShellDescription } from './shell_descriptions.js'
import { filterToSingleShell, pickPreferredShell } from './single_shell.js'
import { moonshotTransformer } from './transformers/moonshot.js'
import { openrouterTransformer } from './transformers/openrouter.js'
import { minimaxTransformer } from './transformers/minimax.js'

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

function assertEq<T>(a: T, b: T, hint: string): void {
  if (a !== b) {
    const av = String(a).slice(0, 200)
    const bv = String(b).slice(0, 200)
    throw new Error(`${hint}: expected equal\n  a=${av}\n  b=${bv}`)
  }
}

// ─── Determinism / cache stability ──────────────────────────────

test('Bash description is byte-stable across two renders on the same input', () => {
  const ctx = { platform: 'linux' as NodeJS.Platform, psEdition: null }
  const a = getCompatShellDescription('Bash', ctx)!
  const b = getCompatShellDescription('Bash', ctx)!
  assertEq(a, b, 'two renders should produce identical bytes')
})

test('PowerShell description is byte-stable across psEdition=desktop renders', () => {
  const ctx = { platform: 'win32' as NodeJS.Platform, psEdition: 'desktop' as const }
  const a = getCompatShellDescription('PowerShell', ctx)!
  const b = getCompatShellDescription('PowerShell', ctx)!
  assertEq(a, b, 'two renders should produce identical bytes')
})

test('Bash description does not include process-specific data', () => {
  const ctx = { platform: 'linux' as NodeJS.Platform, psEdition: null }
  const desc = getCompatShellDescription('Bash', ctx)!
  // Things that would change per-process and bust the upstream cache:
  const homedir = process.env.HOME ?? process.env.USERPROFILE
  if (homedir && homedir.length > 0) {
    assert(!desc.includes(homedir), `Bash description should not include $HOME (${homedir})`)
  }
  assert(!desc.includes(process.cwd()), 'should not include cwd')
  assert(!/\bclaudex-\d+\b/.test(desc), 'should not include per-uid claude tmp dir')
  assert(!/[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\AppData/.test(desc), 'should not include AppData paths')
})

test('PowerShell description differs between editions', () => {
  const win = { platform: 'win32' as NodeJS.Platform, psEdition: 'desktop' as const }
  const cross = { platform: 'win32' as NodeJS.Platform, psEdition: 'core' as const }
  const a = getCompatShellDescription('PowerShell', win)!
  const b = getCompatShellDescription('PowerShell', cross)!
  assert(a !== b, '5.1 and 7+ descriptions must diverge on chain operators')
  assert(a.includes('5.1') || a.includes('PowerShell 5'), '5.1 description should call it out')
  assert(b.includes('7+') || b.includes('PowerShell 7'), '7+ description should call it out')
})

test('Unknown tool name returns undefined (caller falls back to original description)', () => {
  const ctx = { platform: 'linux' as NodeJS.Platform, psEdition: null }
  const desc = getCompatShellDescription('NotAShell', ctx)
  assertEq(desc, undefined, 'must be undefined so caller uses original description')
})

test('Bash description on Windows mentions Git Bash + POSIX paths', () => {
  const ctx = { platform: 'win32' as NodeJS.Platform, psEdition: null }
  const desc = getCompatShellDescription('Bash', ctx)!
  assert(desc.toLowerCase().includes('git bash'), 'should mention Git Bash on Windows')
  assert(desc.includes('/c/Users'), 'should show POSIX path example')
})

test('Bash description steers dev servers to tracked background tasks', () => {
  const ctx = { platform: 'linux' as NodeJS.Platform, psEdition: null }
  const desc = getCompatShellDescription('Bash', ctx)!
  assert(desc.includes('run_in_background: true'), 'should mention run_in_background')
  assert(desc.includes('echo $!'), 'should warn against pid capture')
  assert(desc.includes('docker compose up -d'), 'should warn against Docker detach')
  assert(desc.includes('& echo $!'), 'should include the raw-background anti-pattern')
})

test('Bash description on Linux does NOT mention Git Bash', () => {
  const ctx = { platform: 'linux' as NodeJS.Platform, psEdition: null }
  const desc = getCompatShellDescription('Bash', ctx)!
  assert(!desc.toLowerCase().includes('git bash'), 'Git Bash note is Windows-only')
})

// ─── Single-shell filter ────────────────────────────────────────

test('filterToSingleShell is a no-op when only one shell is present', () => {
  const tools = [{ name: 'Bash' }, { name: 'Read' }, { name: 'Edit' }]
  const out = filterToSingleShell(tools)
  assertEq(out.length, 3, 'no shell to drop')
  assert(out.find(t => t.name === 'Bash') !== undefined, 'Bash must survive')
})

test('filterToSingleShell drops one shell when both are present', () => {
  const tools = [{ name: 'Bash' }, { name: 'PowerShell' }, { name: 'Read' }]
  const out = filterToSingleShell(tools)
  assertEq(out.length, 2, 'one of the two shells must be dropped')
  const hasBash = out.some(t => t.name === 'Bash')
  const hasPS = out.some(t => t.name === 'PowerShell')
  assert(hasBash !== hasPS, 'exactly one of Bash/PowerShell must remain')
})

test('CLAUDE_CODE_SHELL=powershell forces PowerShell selection', () => {
  const prev = process.env.CLAUDE_CODE_SHELL
  process.env.CLAUDE_CODE_SHELL = 'powershell'
  try {
    assertEq(pickPreferredShell(), 'PowerShell', 'env override should pick PowerShell')
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SHELL
    else process.env.CLAUDE_CODE_SHELL = prev
  }
})

test('CLAUDE_CODE_SHELL=bash forces Bash selection', () => {
  const prev = process.env.CLAUDE_CODE_SHELL
  process.env.CLAUDE_CODE_SHELL = '/usr/bin/bash'
  try {
    assertEq(pickPreferredShell(), 'Bash', 'env override should pick Bash')
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SHELL
    else process.env.CLAUDE_CODE_SHELL = prev
  }
})

// ─── Moonshot schema sanitizer ──────────────────────────────────

test('Moonshot sanitizeToolSchemaExtra drops $ref siblings', () => {
  const input = {
    type: 'object',
    properties: {
      ref: { $ref: '#/$defs/X', description: 'this should go away' },
    },
  }
  const out = moonshotTransformer.sanitizeToolSchemaExtra!(input, 'kimi-k2.5')
  const props = (out.properties as Record<string, any>).ref
  assertEq(Object.keys(props).length, 1, 'only $ref should remain')
  assertEq(props.$ref, '#/$defs/X', '$ref value must be preserved')
})

test('Moonshot sanitizeToolSchemaExtra collapses tuple items to single schema', () => {
  const input = {
    type: 'array',
    items: [{ type: 'string' }, { type: 'number' }],
  }
  const out = moonshotTransformer.sanitizeToolSchemaExtra!(input, 'kimi-k2')
  assert(!Array.isArray(out.items), 'items must not be a tuple')
  assertEq((out.items as any).type, 'string', 'first schema wins')
})

// ─── OpenRouter Gemini sanitizer ────────────────────────────────

test('OpenRouter sanitizeToolSchemaExtra only fires for Gemini upstreams', () => {
  const input = {
    type: 'object',
    properties: {
      level: { type: 'integer', enum: [1, 2, 3] },
    },
  }
  // Non-Gemini → pass-through
  const passthrough = openrouterTransformer.sanitizeToolSchemaExtra!(input, 'anthropic/claude-sonnet-4.6')
  const levelA = (passthrough.properties as Record<string, any>).level
  assertEq(levelA.type, 'integer', 'non-Gemini schema must not be rewritten')
  assert(levelA.enum.every((v: unknown) => typeof v === 'number'), 'non-Gemini enum stays numeric')

  // Gemini → rewrite integer enum → string enum
  const rewritten = openrouterTransformer.sanitizeToolSchemaExtra!(input, 'google/gemini-2.5-pro')
  const levelB = (rewritten.properties as Record<string, any>).level
  assertEq(levelB.type, 'string', 'Gemini must rewrite integer-enum type → string')
  assert(levelB.enum.every((v: unknown) => typeof v === 'string'), 'Gemini enum values stringified')
})

test('OpenRouter Gemini sanitizer fills missing array `items`', () => {
  const input = { type: 'array' }
  const out = openrouterTransformer.sanitizeToolSchemaExtra!(input, 'google/gemini-3-flash')
  assert(out.items !== undefined, 'items must be filled')
  assertEq((out.items as any).type, 'string', 'default item type is string')
})

test('OpenRouter Gemini sanitizer filters `required` to declared fields', () => {
  const input = {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a', 'b', 'c'],
  }
  const out = openrouterTransformer.sanitizeToolSchemaExtra!(input, 'google/gemini-2.5-flash')
  assert(Array.isArray(out.required), 'required preserved')
  assertEq((out.required as string[]).length, 1, 'only declared field "a" remains')
  assertEq((out.required as string[])[0], 'a', '')
})

// ─── Default generation params ──────────────────────────────────

test('Moonshot defaults non-thinking Kimi to temperature 0.6', () => {
  const out = moonshotTransformer.defaultGenerationParams!('kimi-k2-turbo-preview')
  assertEq(out!.temperature, 0.6, '')
})

test('Moonshot defaults thinking Kimi to temperature 1.0', () => {
  const out = moonshotTransformer.defaultGenerationParams!('kimi-k2.5')
  assertEq(out!.temperature, 1.0, '')
  assertEq(out!.top_p, 0.95, '')
})

test('OpenRouter defaults Gemini to 1.0/0.95/64', () => {
  const out = openrouterTransformer.defaultGenerationParams!('google/gemini-2.5-pro')
  assertEq(out!.temperature, 1.0, '')
  assertEq(out!.top_p, 0.95, '')
  assertEq(out!.top_k, 64, '')
})

test('OpenRouter defaults Qwen to 0.55/1.0', () => {
  const out = openrouterTransformer.defaultGenerationParams!('qwen/qwen-3-coder-480b')
  assertEq(out!.temperature, 0.55, '')
  assertEq(out!.top_p, 1.0, '')
})

test('MiniMax defaults are 1.0/0.95/20 or 40 depending on variant', () => {
  const m2 = minimaxTransformer.defaultGenerationParams!('MiniMax-M2')
  assertEq(m2!.temperature, 1.0, '')
  assertEq(m2!.top_p, 0.95, '')
  assertEq(m2!.top_k, 20, 'M2 uses 20')

  const m25 = minimaxTransformer.defaultGenerationParams!('MiniMax-M2.5')
  assertEq(m25!.top_k, 40, 'M2.5 uses 40')
})

test('MiniMax defaults return undefined for non-MiniMax model ids', () => {
  const out = minimaxTransformer.defaultGenerationParams!('something-else')
  assertEq(out, undefined, '')
})

// ─── Cross-cutting cache invariants ─────────────────────────────

test('Shell description never contains a timestamp-shaped substring', () => {
  for (const ctx of [
    { platform: 'linux' as NodeJS.Platform, psEdition: null },
    { platform: 'darwin' as NodeJS.Platform, psEdition: null },
    { platform: 'win32' as NodeJS.Platform, psEdition: 'desktop' as const },
    { platform: 'win32' as NodeJS.Platform, psEdition: 'core' as const },
  ]) {
    for (const tool of ['Bash', 'PowerShell']) {
      const desc = getCompatShellDescription(tool, ctx)
      if (!desc) continue
      assert(!/\d{4}-\d{2}-\d{2}T/.test(desc), `${tool}@${ctx.platform}/${ctx.psEdition}: timestamp leaked`)
      assert(!/\b\d{10}\b/.test(desc), `${tool}@${ctx.platform}/${ctx.psEdition}: epoch leaked`)
    }
  }
})

// ─── Summary ───────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
