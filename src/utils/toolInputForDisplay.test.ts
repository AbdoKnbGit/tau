/**
 * Tool calls are shown with the input they run with.
 *
 * Run: bun run src/utils/toolInputForDisplay.test.ts
 */

import { z } from 'zod/v4'
import { parseToolInputForDisplay } from './toolInputForDisplay.js'

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

const skillLike = {
  inputSchema: z.strictObject({ skill: z.string(), args: z.string().optional() }),
}
const browserLike = {
  inputSchema: z.strictObject({
    action: z.enum(['observe', 'click']),
    nth: z.number().int().min(1).optional(),
    ref: z.number().int().min(0).optional(),
  }),
}

function main(): void {
  console.log('toolInputForDisplay')

  test('a valid input is shown as it is', () => {
    const parsed = parseToolInputForDisplay(skillLike, { skill: 'commit', args: '-m x' })
    assert(parsed.success && JSON.stringify(parsed.data) === '{"skill":"commit","args":"-m x"}', JSON.stringify(parsed))
  })

  test('a strict-lane null reads as omitted, so the call keeps its row', () => {
    // A strict-mode lane sends null for every optional field.
    const parsed = parseToolInputForDisplay(skillLike, { skill: 'someplugin:rules', args: null })
    assert(parsed.success, 'the recorded Skill call did not parse for display')
    assert(JSON.stringify(parsed.data) === '{"skill":"someplugin:rules"}', JSON.stringify(parsed.data))
  })

  test('a rejected placeholder is dropped, an accepted one kept', () => {
    const parsed = parseToolInputForDisplay(browserLike, { action: 'observe', nth: 0, ref: 0 })
    assert(parsed.success && JSON.stringify(parsed.data) === '{"action":"observe","ref":0}', JSON.stringify(parsed))
  })

  test('an unknown key is ignored the way execution ignores it', () => {
    const parsed = parseToolInputForDisplay(skillLike, { skill: 'commit', extra: true })
    assert(parsed.success, JSON.stringify(parsed))
  })

  test('a genuinely invalid input still fails', () => {
    const parsed = parseToolInputForDisplay(browserLike, { action: 'observe', nth: 'second' })
    assert(!parsed.success, 'an invalid input was shown as valid')
  })

  test('non-object input is left to the plain parse', () => {
    assert(!parseToolInputForDisplay(skillLike, null).success, 'null parsed')
    assert(!parseToolInputForDisplay(skillLike, 'x').success, 'a string parsed')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
