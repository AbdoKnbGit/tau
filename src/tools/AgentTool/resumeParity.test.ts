/**
 * Resume parity: what a resumed subagent needs to repeat its spawn's prefix.
 *
 * Run: bun run src/tools/AgentTool/resumeParity.test.ts
 */
import type { Tool, Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  _resetAgentConversationsForTest,
  getAgentConversation,
  refuseToolsOutsideRunPolicy,
  rememberAgentConversation,
} from './resumeParity.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  _resetAgentConversationsForTest()
  try {
    await fn()
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

const msg = (uuid: string, type = 'user'): Message => ({ type, uuid }) as unknown as Message

function tool(name: string, extra: Record<string, unknown> = {}): Tool {
  return {
    name,
    inputSchema: { shape: { a: 1 } },
    async prompt() {
      return `prompt of ${name}`
    },
    async validateInput() {
      return { result: true }
    },
    ...extra,
  } as unknown as Tool
}

async function main(): Promise<void> {
  console.log('resume parity:')

  await test('returns the remembered conversation in order', () => {
    rememberAgentConversation('a1', [msg('u1'), msg('a1', 'assistant'), msg('att', 'attachment')])
    const got = getAgentConversation('a1')
    assert(got?.map(m => m.uuid).join(',') === 'u1,a1,att', `got=${got?.map(m => m.uuid)}`)
  })

  await test('unknown agent falls back (undefined)', () => {
    assert(getAgentConversation('nope') === undefined, 'expected undefined')
  })

  await test('stores and hands out copies, never the live arrays', () => {
    const live = [msg('u1')]
    rememberAgentConversation('a1', live)
    live.push(msg('late'))
    const first = getAgentConversation('a1')!
    first.push(msg('mutated'))
    const second = getAgentConversation('a1')!
    assert(second.length === 1, `length=${second.length}`)
  })

  await test('a newer run of the same agent replaces its conversation', () => {
    rememberAgentConversation('a1', [msg('old')])
    rememberAgentConversation('a1', [msg('old'), msg('new')])
    assert(getAgentConversation('a1')?.length === 2, 'expected the newer conversation')
  })

  await test('caps held conversations, dropping the least recently finished', () => {
    for (let i = 0; i < 16; i++) rememberAgentConversation(`a${i}`, [msg(`u${i}`)])
    rememberAgentConversation('a0', [msg('u0-again')]) // a0 finishes again: now newest
    rememberAgentConversation('a16', [msg('u16')])
    assert(getAgentConversation('a1') === undefined, 'a1 should be evicted')
    assert(getAgentConversation('a0') !== undefined, 'a0 was refreshed and must stay')
    assert(getAgentConversation('a16') !== undefined, 'newest must stay')
  })

  await test('all tools runnable: the declared array is returned untouched', () => {
    const declared: Tools = [tool('Read'), tool('Grep')]
    const out = refuseToolsOutsideRunPolicy(declared, declared, 'x')
    assert(out === declared, 'expected the same array')
  })

  await test('tools outside the run policy stay declared but refuse to run', async () => {
    const read = tool('Read')
    const send = tool('SendMessage', { description: 'send it' })
    const out = refuseToolsOutsideRunPolicy([read, send], [read], 'is not available in the background.')
    assert(out.length === 2, `length=${out.length}`)
    assert(out[0] === read, 'runnable tool must keep its identity')
    const wrapped = out[1]!
    assert(wrapped !== send, 'refused tool is a copy')
    assert(wrapped.name === 'SendMessage', `name=${wrapped.name}`)
    assert((wrapped as any).description === 'send it', 'declaration fields are kept')
    assert(wrapped.inputSchema === send.inputSchema, 'same input schema object')
    assert((await (wrapped as any).prompt()) === 'prompt of SendMessage', 'same prompt text')
    const verdict = await wrapped.validateInput!({} as never, {} as never)
    assert(verdict.result === false, 'must refuse')
    assert(
      verdict.result === false &&
        verdict.message === 'SendMessage is not available in the background.',
      `message=${verdict.result === false ? verdict.message : ''}`,
    )
    const original = await send.validateInput!({} as never, {} as never)
    assert(original.result === true, 'the original tool is not mutated')
  })

  await test('declaration order is preserved (tool order is part of the prefix)', () => {
    const names = ['Agent', 'Read', 'SendMessage', 'Grep', 'TaskCreate']
    const declared = names.map(n => tool(n))
    const runnable = declared.filter(t => t.name === 'Read' || t.name === 'Grep')
    const out = refuseToolsOutsideRunPolicy(declared, runnable, 'x')
    assert(out.map(t => t.name).join(',') === names.join(','), `order=${out.map(t => t.name)}`)
  })

  await test('getter-defined fields keep their values in the refused copy', () => {
    const schema = { shape: { to: 1 } }
    const withGetter = {
      name: 'SendMessage',
      get inputSchema() {
        return schema
      },
    } as unknown as Tool
    const [out] = refuseToolsOutsideRunPolicy([withGetter], [], 'x')
    assert(out!.inputSchema === schema, 'getter value must be carried over')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
