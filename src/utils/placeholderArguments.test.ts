/**
 * Optional-argument placeholder tests.
 *
 * Run: bun run src/utils/placeholderArguments.test.ts
 *
 * The recorded calls come from real sessions: a model that fills every
 * parameter (0 / false / "" / []) and a strict-mode lane that sends null for
 * every optional one.
 */

import { z } from 'zod/v4'
import { coerceMcpInput } from '../services/mcp/coerceMcpInput.js'
import {
  contractArgumentJudge,
  contractIssues,
} from '../services/mcp/contractValidation.js'
import {
  type ArgumentIssue,
  type ArgumentJudge,
  describeDroppedArguments,
  describeRefusedEmptyArguments,
  dropEmptyOptionalArguments,
  dropInvalidPlaceholderArguments,
  isEmptyArgumentValue,
  isPlaceholderValue,
  zodArgumentJudge,
} from './placeholderArguments.js'

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

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Shaped like the Browser tool: many optional fields, several with minimums.
const browserLike = z
  .strictObject({
    action: z.enum(['open', 'observe', 'click']),
    url: z.string().optional(),
    ref: z.number().int().min(0).optional(),
    nth: z.number().int().min(1).optional(),
    x: z.number().int().min(0).optional(),
    submit: z.boolean().optional(),
    amount: z.number().int().min(1).max(20_000).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    maxChars: z.number().int().min(500).max(30_000).optional(),
    offset: z.number().int().min(0).optional(),
    level: z.enum(['error', 'all']).optional(),
    direction: z.enum(['up', 'down']).optional(),
  })
  .strip()

// Shaped like Bash with its advisory command_parts.
const token = z.union([
  z.strictObject({ kind: z.literal('arg'), value: z.string() }),
  z.strictObject({ kind: z.literal('flag'), name: z.string(), value: z.union([z.string(), z.number()]).optional() }),
  z.strictObject({ kind: z.literal('separator') }),
])
const bashLike = z
  .strictObject({
    command: z.string().min(1),
    timeout: z.number().optional(),
    description: z.string().optional(),
    run_in_background: z.boolean().optional(),
    command_parts: z
      .strictObject({
        executable: z.string(),
        tokens: z.array(token).optional(),
        positionals: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strip()

function main(): void {
  console.log('placeholderArguments')

  test('placeholder and empty value sets', () => {
    for (const value of [null, '', '  ', 0, false, [], {}]) {
      assert(isPlaceholderValue(value), `${JSON.stringify(value)} should be a placeholder`)
    }
    for (const value of [1, -1, true, 'x', [0], { a: null }]) {
      assert(!isPlaceholderValue(value), `${JSON.stringify(value)} is a real value`)
    }
    assert(!isEmptyArgumentValue(0) && !isEmptyArgumentValue(false), '0 and false are not empty')
    assert(isEmptyArgumentValue('') && isEmptyArgumentValue(null) && isEmptyArgumentValue([]), 'empty set')
  })

  test('valid input is returned untouched, placeholders and all', () => {
    const input = { action: 'observe', ref: 0, offset: 0, submit: false, x: 0 }
    const repair = dropInvalidPlaceholderArguments(input, zodArgumentJudge(browserLike))
    assert(repair.input === input, 'a valid call must keep its identity')
    assert(repair.dropped.length === 0, 'nothing is dropped from a valid call')
  })

  test('the recorded zero-filled Browser call runs without the rejected zeros', () => {
    const recorded = {
      action: 'observe', url: 'https://example.com', ref: 0, nth: 0, x: 0,
      submit: false, direction: 'down', amount: 0, timeoutMs: 0, maxChars: 4000,
      offset: 0, level: 'all',
    }
    const repair = dropInvalidPlaceholderArguments(recorded, zodArgumentJudge(browserLike))
    assert(browserLike.safeParse(repair.input).success, 'the repaired call must validate')
    assert(same(repair.dropped.map(d => d.path.join('.')).sort(), ['amount', 'nth', 'timeoutMs']),
      `dropped ${JSON.stringify(repair.dropped.map(d => d.path))}`)
    // Accepted placeholders stay: they are the model's values.
    assert(repair.input.ref === 0 && repair.input.x === 0 && repair.input.offset === 0, 'valid zeros kept')
    assert(repair.input.submit === false, 'valid false kept')
    const note = describeDroppedArguments(repair.dropped) ?? ''
    assert(/`nth` = 0/.test(note) && /`amount` = 0/.test(note) && /`timeoutMs` = 0/.test(note), note)
    assert(/Leave out optional parameters/.test(note), 'the note should say how to avoid it')
  })

  test('strict-mode nulls are read as omitted, silently', () => {
    const judge = zodArgumentJudge(browserLike)
    const repair = dropInvalidPlaceholderArguments(
      { action: 'observe', url: null, nth: null, amount: null, level: null },
      judge,
    )
    assert(same(repair.input, { action: 'observe' }), JSON.stringify(repair.input))
    assert(describeDroppedArguments(repair.dropped) === undefined, 'null drops need no note')
  })

  test('an explicitly nullable field keeps its null', () => {
    const schema = z.strictObject({ a: z.string(), b: z.string().nullable().optional() })
    const input = { a: 'x', b: null }
    const repair = dropInvalidPlaceholderArguments(input, zodArgumentJudge(schema))
    assert(repair.input === input && repair.dropped.length === 0, 'meaningful null removed')
  })

  test('a required placeholder is never dropped', () => {
    const input = { command: '', timeout: 0 }
    const repair = dropInvalidPlaceholderArguments(input, zodArgumentJudge(bashLike))
    assert(repair.input === input && repair.dropped.length === 0, 'required field dropped')
  })

  test('a real invalid value elsewhere keeps the whole call failing', () => {
    const input = { action: 'observe', nth: 'second', amount: 0 }
    const repair = dropInvalidPlaceholderArguments(input, zodArgumentJudge(browserLike))
    assert(repair.input === input && repair.dropped.length === 0, 'partial repair accepted')
  })

  test('array items are never removed', () => {
    const schema = z.strictObject({ tags: z.array(z.string().min(1)).optional() })
    const input = { tags: ['', 'x'] }
    const repair = dropInvalidPlaceholderArguments(input, zodArgumentJudge(schema))
    assert(repair.input === input && repair.dropped.length === 0, 'an array item was removed')
  })

  test('nested optional placeholders are dropped where they sit', () => {
    const schema = z.strictObject({
      query: z.string(),
      filters: z.strictObject({ owner: z.string().min(1).optional(), tag: z.string().optional() }).optional(),
    })
    const repair = dropInvalidPlaceholderArguments(
      { query: 'q', filters: { owner: '', tag: 'a' } },
      zodArgumentJudge(schema),
    )
    assert(same(repair.input, { query: 'q', filters: { tag: 'a' } }), JSON.stringify(repair.input))
    assert(repair.dropped[0]?.path.join('.') === 'filters.owner', 'wrong path')
  })

  test('an empty optional object missing its required keys reads as omitted', () => {
    const schema = z.strictObject({
      query: z.string(),
      filters: z.strictObject({ owner: z.string() }).optional(),
    })
    const repair = dropInvalidPlaceholderArguments({ query: 'q', filters: {} }, zodArgumentJudge(schema))
    assert(same(repair.input, { query: 'q' }), JSON.stringify(repair.input))
  })

  test('a malformed advisory field is dropped only when it is the only problem', () => {
    const recorded = {
      command: 'pwd && tau mcp list', timeout: 120000, description: 'Inspect',
      run_in_background: false,
      command_parts: {
        executable: 'pwd',
        tokens: [{ kind: 'arg', value: [] }, { kind: 'arg', value: [] }],
        positionals: [],
      },
    }
    const judge = zodArgumentJudge(bashLike)
    const repair = dropInvalidPlaceholderArguments(recorded, judge, { advisoryFields: ['command_parts'] })
    assert(!('command_parts' in repair.input), 'command_parts should be dropped')
    assert(bashLike.safeParse(repair.input).success, 'repaired call must validate')
    assert(repair.dropped.length === 1 && repair.dropped[0]!.advisory === true,
      `dropped ${JSON.stringify(repair.dropped)}`)

    const notAdvisory = dropInvalidPlaceholderArguments(recorded, judge)
    assert(notAdvisory.input === recorded, 'without the declaration the call must fail as before')

    const alsoBroken = { ...recorded, command: '' }
    const blocked = dropInvalidPlaceholderArguments(alsoBroken, judge, { advisoryFields: ['command_parts'] })
    assert(blocked.input === alsoBroken, 'an advisory drop must not hide another problem')
  })

  test('a normalize step repairs what a placeholder was blocking', () => {
    const judge: ArgumentJudge = value => {
      const v = value as Record<string, unknown>
      const issues: ArgumentIssue[] = []
      if (typeof v.count !== 'number') issues.push({ path: ['count'], message: 'must be integer' })
      if ('offset' in v && typeof v.offset !== 'number') issues.push({ path: ['offset'], message: 'must be integer' })
      return issues
    }
    const coerceCount = (value: Record<string, unknown>) =>
      typeof value.count === 'string' && /^\d+$/.test(value.count) && !('offset' in value && typeof value.offset !== 'number')
        ? { ...value, count: Number(value.count) }
        : value
    const repair = dropInvalidPlaceholderArguments({ count: '3', offset: null }, judge, { normalize: coerceCount })
    assert(same(repair.input, { count: 3 }), JSON.stringify(repair.input))
  })

  test('an unjudgeable contract changes nothing', () => {
    const input = { a: 0 }
    const repair = dropInvalidPlaceholderArguments(input, () => null)
    assert(repair.input === input && repair.dropped.length === 0, 'null verdict treated as invalid')
  })

  test('a placeholder under an own __proto__ key is dropped without touching prototypes', () => {
    const input = JSON.parse('{"a":"x","__proto__":""}') as Record<string, unknown>
    const judge: ArgumentJudge = value =>
      Object.prototype.hasOwnProperty.call(value, '__proto__') ? [{ path: ['__proto__'], message: 'bad' }] : []
    const repair = dropInvalidPlaceholderArguments(input, judge)
    assert(!Object.prototype.hasOwnProperty.call(repair.input, '__proto__'), 'own __proto__ kept')
    assert(({} as Record<string, unknown>).a === undefined, 'prototype polluted')
    assert(repair.input.a === 'x', 'other argument lost')
  })

  test('empty optional arguments for a tool check that names no path', () => {
    const recorded = { file_path: 'a.py', offset: 0, limit: 2000, skeleton: false, pages: '' }
    const repair = dropEmptyOptionalArguments(recorded, new Set(['file_path']))
    assert(same(repair.input, { file_path: 'a.py', offset: 0, limit: 2000, skeleton: false }),
      JSON.stringify(repair.input))
    const required = dropEmptyOptionalArguments({ file_path: '' }, new Set(['file_path']))
    assert(required.dropped.length === 0, 'a required empty argument was dropped')
    const note = describeRefusedEmptyArguments(repair.dropped, 'Invalid pages parameter: "".') ?? ''
    assert(/`pages` = ""/.test(note) && /Invalid pages parameter/.test(note), note)
  })

  // MCP tools are judged by their server's JSON Schema.
  const playwrightTabs = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'new', 'close', 'select'] },
      index: { type: 'number' },
      url: { type: 'string' },
    },
    required: ['action'],
    additionalProperties: false,
  }

  test('the recorded strict-lane MCP call runs without its nulls', () => {
    const recorded = { action: 'list', index: null, url: null }
    const repair = dropInvalidPlaceholderArguments(recorded, contractArgumentJudge(playwrightTabs))
    assert(same(repair.input, { action: 'list' }), JSON.stringify(repair.input))
    assert(describeDroppedArguments(repair.dropped) === undefined, 'null drops need no note')
  })

  test('a server schema that accepts null keeps it', () => {
    const schema = {
      type: 'object',
      properties: { action: { type: 'string' }, index: { type: ['number', 'null'] } },
      required: ['action'],
    }
    const input = { action: 'list', index: null }
    const repair = dropInvalidPlaceholderArguments(input, contractArgumentJudge(schema))
    assert(repair.input === input, 'a valid null was dropped')
  })

  test('schema coercion runs once the placeholder is out of the way', () => {
    const schema = {
      type: 'object',
      properties: { query: { type: 'string' }, count: { type: 'integer' }, offset: { type: 'integer' } },
      required: ['query'],
    }
    const coerced = coerceMcpInput({ query: 'x', count: '3', offset: null }, schema) as Record<string, unknown>
    assert(coerced.count === '3', 'coercion alone was expected to be blocked by the null')
    const repair = dropInvalidPlaceholderArguments(coerced, contractArgumentJudge(schema), {
      normalize: value => coerceMcpInput(value, schema) as Record<string, unknown>,
    })
    assert(same(repair.input, { query: 'x', count: 3 }), JSON.stringify(repair.input))
  })

  test('issues about an unexpected property name that property', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }
    const issues = contractIssues(schema, { a: 'x', 'we/ird~': '' }) ?? []
    assert(same(issues.map(issue => issue.path), [['we/ird~']]), JSON.stringify(issues))
    const repair = dropInvalidPlaceholderArguments({ a: 'x', 'we/ird~': '' }, contractArgumentJudge(schema))
    assert(same(repair.input, { a: 'x' }), JSON.stringify(repair.input))

    // JSON-pointer escapes in an instance path come back as the real key.
    const escaped = { type: 'object', properties: { 'a/b~c': { type: 'number', minimum: 1 } } }
    const pointerIssues = contractIssues(escaped, { 'a/b~c': 0 }) ?? []
    assert(same(pointerIssues.map(issue => issue.path), [['a/b~c']]), JSON.stringify(pointerIssues))
    const repairedEscaped = dropInvalidPlaceholderArguments({ 'a/b~c': 0 }, contractArgumentJudge(escaped))
    assert(same(repairedEscaped.input, {}), JSON.stringify(repairedEscaped.input))
  })

  test('notes are deterministic', () => {
    const recorded = { action: 'observe', nth: 0, amount: 0 }
    const a = describeDroppedArguments(dropInvalidPlaceholderArguments(recorded, zodArgumentJudge(browserLike)).dropped)
    const b = describeDroppedArguments(dropInvalidPlaceholderArguments({ ...recorded }, zodArgumentJudge(browserLike)).dropped)
    assert(a !== undefined && a === b, 'the same call must produce the same note')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
