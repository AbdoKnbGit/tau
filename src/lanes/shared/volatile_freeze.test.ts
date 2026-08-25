/**
 * Run: bun run src/lanes/shared/volatile_freeze.test.ts
 *
 * The freeze exists so an implicit prefix cache sees byte-identical volatile
 * context every turn. The failure mode it must NOT have is outliving a
 * deliberate prompt rebuild: /mode and /team-mode clear the system-prompt
 * section cache precisely so their sections recompute, and if the frozen
 * snapshot survived that, the lane would keep replaying pre-toggle bytes and
 * the change would never reach the model.
 */

import {
  freezeSessionVolatileText,
  resetSessionVolatileFreeze,
  volatileFreezeKey,
} from './volatile_freeze.js'

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

console.log('volatile freeze:')

test('freezes to the first non-empty value', () => {
  resetSessionVolatileFreeze()
  assert(freezeSessionVolatileText('k', 'first') === 'first', 'first call seeds')
  assert(freezeSessionVolatileText('k', 'second') === 'first', 'later calls replay the seed')
})

test('an empty first value pins nothing (late-arriving block freezes later)', () => {
  resetSessionVolatileFreeze()
  assert(freezeSessionVolatileText('k', '') === '', 'empty pins nothing')
  assert(freezeSessionVolatileText('k', 'arrived') === 'arrived', 'later value seeds instead')
  assert(freezeSessionVolatileText('k', 'changed') === 'arrived', 'and is then held')
})

test('reset lets a deliberate prompt rebuild through', () => {
  resetSessionVolatileFreeze()
  freezeSessionVolatileText('k', 'team-mode OFF')
  // …/team-mode toggles, clearSystemPromptSections() runs …
  resetSessionVolatileFreeze()
  assert(
    freezeSessionVolatileText('k', 'team-mode ON') === 'team-mode ON',
    'post-reset value must be the freshly built one, not the stale snapshot',
  )
})

test('keys separate model and session; both survive a reset independently', () => {
  resetSessionVolatileFreeze()
  const a = volatileFreezeKey('deepseek', 'deepseek-v4-flash', 'sess-1', [])
  const b = volatileFreezeKey('deepseek', 'deepseek-v4-flash', 'sess-2', [])
  const c = volatileFreezeKey('deepseek', 'deepseek-reasoner', 'sess-1', [])
  assert(a !== b, 'different sessions must not share a snapshot')
  assert(a !== c, 'different models must not share a snapshot')
  freezeSessionVolatileText(a, 'A')
  freezeSessionVolatileText(b, 'B')
  assert(freezeSessionVolatileText(a, 'x') === 'A', 'session 1 holds its own')
  assert(freezeSessionVolatileText(b, 'x') === 'B', 'session 2 holds its own')
})

test('sessionless callers fall back to first-user-message lineage', () => {
  resetSessionVolatileFreeze()
  const msgs = [{ role: 'user' as const, content: 'the very first thing asked' }]
  const k1 = volatileFreezeKey('deepseek', 'm', undefined, msgs)
  const k2 = volatileFreezeKey('deepseek', 'm', undefined, msgs)
  assert(k1 === k2, 'same conversation must produce the same key')
  const other = volatileFreezeKey('deepseek', 'm', undefined, [
    { role: 'user' as const, content: 'a different conversation' },
  ])
  assert(k1 !== other, 'different conversations must not share a snapshot')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
