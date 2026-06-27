/**
 * Tool input coercion invariants.
 *
 * Run: bun run src/utils/coerceToolInput.test.ts
 */

import { z } from 'zod/v4'
import { coerceToolInput } from './coerceToolInput.js'

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
  console.log('tool input coercion:')

  test('drops null optional/defaulted fields before Zod validation', () => {
    const schema = z.object({
      taskId: z.string(),
      subject: z.string().optional(),
      priority: z.number().default(1),
    })

    const out = coerceToolInput({
      taskId: 'task-1',
      subject: null,
      priority: null,
    }, schema)

    assert(out.taskId === 'task-1', 'required value preserved')
    assert(!('subject' in out), 'optional null should be omitted')
    assert(!('priority' in out), 'defaulted null should be omitted')
    assert(schema.safeParse(out).success, 'coerced input should pass')
  })

  test('keeps null required fields so validation can reject them', () => {
    const schema = z.object({ taskId: z.string() })
    const out = coerceToolInput({ taskId: null }, schema)
    assert('taskId' in out && out.taskId === null, 'required null must not be hidden')
    assert(!schema.safeParse(out).success, 'required null should still fail')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
