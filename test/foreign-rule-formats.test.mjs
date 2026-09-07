/**
 * Rule-dialect classification, unit-level.
 *
 * These decide whether a foreign rule lands in the always-on prompt, attaches
 * lazily, or is skipped. The always-on branch is the expensive one — every
 * rule that reaches it is paid for on every request — so each dialect's
 * unscoped default is pinned here.
 *
 * Exercised through the real bundle so the shipped classifier is the one under
 * test, not a re-implementation.
 */
import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const harnessPath = join(
  dirname(distPath),
  `.foreign-formats-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __formats() {
  init_foreignRuleFormats();
  return {
    classifyForeignRule, dialectForPath, normalizeRulePatterns,
    NATIVE_DIALECT, CURSOR_DIALECT, COPILOT_INSTRUCTIONS_DIALECT,
    CLINE_DIALECT, WINDSURF_DIALECT,
  };
}
`
writeFileSync(harnessPath, source)

let F
try {
  F = (await import(pathToFileURL(harnessPath).href)).__formats()
} finally {
  unlinkSync(harnessPath)
}

const classify = (fm, dialect) => F.classifyForeignRule(fm, dialect).kind

test('Cursor: the four rule types map to the right activation', () => {
  // Always
  assert.equal(classify({ alwaysApply: true }, F.CURSOR_DIALECT), 'always')
  // Auto-Attached
  assert.equal(
    classify({ globs: ['src/db/**/*.ts'], alwaysApply: false }, F.CURSOR_DIALECT),
    'conditional',
  )
  // Agent Requested — description only. Must NOT become always-on.
  assert.equal(
    classify({ description: 'style guide', alwaysApply: false }, F.CURSOR_DIALECT),
    'inert',
  )
  // Manual — nothing at all.
  assert.equal(classify({}, F.CURSOR_DIALECT), 'inert')
})

test('Cursor: alwaysApply outranks globs', () => {
  assert.equal(
    classify({ alwaysApply: true, globs: ['src/**'] }, F.CURSOR_DIALECT),
    'always',
  )
})

test('Cursor: empty or null globs do not become always-on', () => {
  assert.equal(classify({ globs: null }, F.CURSOR_DIALECT), 'inert')
  assert.equal(classify({ globs: '' }, F.CURSOR_DIALECT), 'inert')
  assert.equal(classify({ globs: [] }, F.CURSOR_DIALECT), 'inert')
})

test('Copilot: applyTo scopes, its absence is dormant, "**" is everything', () => {
  assert.equal(
    classify({ applyTo: '**/*.test.ts' }, F.COPILOT_INSTRUCTIONS_DIALECT),
    'conditional',
  )
  // GitHub documents that omitting applyTo means the file does nothing.
  assert.equal(classify({}, F.COPILOT_INSTRUCTIONS_DIALECT), 'inert')
  assert.equal(
    classify({ applyTo: '**' }, F.COPILOT_INSTRUCTIONS_DIALECT),
    'always',
  )
})

test('Copilot: comma-separated applyTo splits into patterns', () => {
  const a = F.classifyForeignRule(
    { applyTo: '**/*.ts,**/*.tsx' },
    F.COPILOT_INSTRUCTIONS_DIALECT,
  )
  assert.equal(a.kind, 'conditional')
  assert.deepEqual(a.paths, ['**/*.ts', '**/*.tsx'])
})

test('Cline: unscoped files apply, scoped ones attach lazily', () => {
  assert.equal(classify({}, F.CLINE_DIALECT), 'always')
  assert.equal(classify({ paths: 'src/**' }, F.CLINE_DIALECT), 'conditional')
})

test('Windsurf: trigger drives activation', () => {
  assert.equal(classify({ trigger: 'always_on' }, F.WINDSURF_DIALECT), 'always')
  assert.equal(classify({ trigger: 'manual' }, F.WINDSURF_DIALECT), 'inert')
  assert.equal(
    classify({ trigger: 'model_decision' }, F.WINDSURF_DIALECT),
    'inert',
  )
  assert.equal(
    classify({ trigger: 'glob', globs: '**/*.test.ts' }, F.WINDSURF_DIALECT),
    'conditional',
  )
  // trigger: glob with nothing to match scopes to nothing — not everything.
  assert.equal(classify({ trigger: 'glob' }, F.WINDSURF_DIALECT), 'inert')
})

test('native rules ignore foreign activation markers', () => {
  // A .claude/rules file carrying alwaysApply must keep being scoped by paths
  // alone, exactly as before other dialects were understood.
  const a = F.classifyForeignRule(
    { alwaysApply: true, paths: 'src/**' },
    F.NATIVE_DIALECT,
  )
  assert.equal(a.kind, 'conditional')
  assert.equal(classify({ trigger: 'manual' }, F.NATIVE_DIALECT), 'always')
  assert.equal(classify({}, F.NATIVE_DIALECT), 'always')
  assert.equal(classify({ paths: '**' }, F.NATIVE_DIALECT), 'always')
})

test('dialect is chosen from the file location', () => {
  const d = p => F.dialectForPath(p).id
  assert.equal(d('/repo/.cursor/rules/db.mdc'), 'cursor')
  assert.equal(d('/repo/.cursor/rules/nested/db.mdc'), 'cursor')
  assert.equal(d('/repo/.github/instructions/tests.instructions.md'), 'copilot-instructions')
  assert.equal(d('/repo/.windsurf/rules/style.md'), 'windsurf')
  assert.equal(d('/repo/.clinerules/coding.md'), 'cline')
  // Native paths must not be reinterpreted.
  assert.equal(d('/repo/CLAUDE.md'), 'claude')
  assert.equal(d('/repo/AGENTS.md'), 'claude')
  assert.equal(d('/repo/.claude/rules/style.md'), 'claude')
  assert.equal(d('/repo/.github/copilot-instructions.md'), 'claude')
})

test('dialect detection works with Windows separators', () => {
  assert.equal(F.dialectForPath('C:\\repo\\.cursor\\rules\\db.mdc').id, 'cursor')
  assert.equal(F.dialectForPath('C:\\repo\\CLAUDE.md').id, 'claude')
})

test('a directory named like a rules dir elsewhere still resolves', () => {
  // `.cursor/rules` nested deeper in the tree is still a Cursor rules dir.
  assert.equal(F.dialectForPath('/repo/packages/app/.cursor/rules/a.mdc').id, 'cursor')
  // A file merely named `.cursor` is not a rules dir.
  assert.equal(F.dialectForPath('/repo/.cursor').id, 'claude')
})

test('trailing /** is trimmed and all-** collapses to everything', () => {
  const r = F.normalizeRulePatterns('src/db/**')
  assert.deepEqual(r, { kind: 'patterns', paths: ['src/db'] })
  assert.equal(F.normalizeRulePatterns('**').kind, 'all')
  assert.equal(F.normalizeRulePatterns(undefined).kind, 'none')
  assert.equal(F.normalizeRulePatterns(123).kind, 'none')
  assert.equal(F.normalizeRulePatterns(true).kind, 'none')
})
