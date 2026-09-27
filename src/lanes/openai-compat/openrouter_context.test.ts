/**
 * Run: bun run src/lanes/openai-compat/openrouter_context.test.ts
 */
import {
  freezeOpenRouterSystem,
  freezeOpenRouterTools,
  openRouterContextKey,
  resetOpenRouterContext,
} from './openrouter_context.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  resetOpenRouterContext()
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

const fn = (name: string, extra: Record<string, unknown> = {}) => ({
  type: 'function' as const,
  function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { q: { type: 'string' }, ...extra } } },
})
const names = (tools: Array<{ function: { name: string } }>) => tools.map(t => t.function.name).join()
const key = (session: string | undefined, querySource: string | undefined, system = 'SYSTEM') =>
  openRouterContextKey('native', 'm', session, querySource, [], system)

async function main(): Promise<void> {
  console.log('openrouter context:')

  await test('a fork on the conversation session sends the conversation prompt and tool order', () => {
    const main = key('s1', 'repl_main_thread')
    freezeOpenRouterSystem(main, 'SYSTEM v1')
    freezeOpenRouterTools(main, [fn('Bash'), fn('Read'), fn('mcp__b__x')])
    // A connector connects late: it sorts first, the conversation appends it.
    const second = freezeOpenRouterTools(main, [fn('Bash'), fn('Read'), fn('mcp__a__late'), fn('mcp__b__x')])
    assert(names(second) === 'Bash,Read,mcp__b__x,mcp__a__late', `main order ${names(second)}`)

    const fork = key('s1', 'prompt_suggestion')
    assert(fork === main, 'a helper on the conversation session must use its snapshot')
    assert(freezeOpenRouterSystem(fork, 'SYSTEM v2') === 'SYSTEM v1', 'the fork must resend the frozen system prompt')
    const forkTools = freezeOpenRouterTools(fork, [fn('Bash'), fn('Read'), fn('mcp__a__late'), fn('mcp__b__x')])
    assert(JSON.stringify(forkTools) === JSON.stringify(second), `fork tool block differs: ${names(forkTools)}`)
  })

  await test('a helper with a prompt of its own keeps its own snapshot, even on the conversation session', () => {
    const main = key('s1', 'repl_main_thread', 'Initial')
    freezeOpenRouterSystem(main, 'Initial')
    const helper = key('s1', 'helper', 'Helper instructions')
    assert(helper !== main, 'a different prompt must not reuse the conversation snapshot')
    assert(freezeOpenRouterSystem(helper, 'Helper instructions') === 'Helper instructions', 'the helper prompt must reach the model')
    assert(key('s1', 'prompt_suggestion', 'Initial') === main, 'a fork with the conversation prompt still shares it')
  })

  await test('a helper before any conversation request neither shares nor seeds a snapshot', () => {
    const early = key('s1', 'compact')
    freezeOpenRouterSystem(early, 'HELPER')
    const main = key('s1', 'repl_main_thread')
    assert(main !== early, 'the conversation must not use the helper snapshot')
    assert(freezeOpenRouterSystem(main, 'MAIN') === 'MAIN', 'the helper must not seed the main prompt')
  })

  await test('an output style keeps a snapshot of its own; later forks follow it', () => {
    const plain = key('s1', 'repl_main_thread')
    freezeOpenRouterSystem(plain, 'PLAIN')
    const styled = key('s1', 'repl_main_thread:outputStyle:Explanatory')
    assert(styled !== plain, 'a style change must not replay the old prompt')
    assert(freezeOpenRouterSystem(styled, 'STYLED') === 'STYLED', 'the styled prompt must reach the model')
    assert(key('s1', 'prompt_suggestion') === styled, 'a fork follows the conversation it forks now')
  })

  await test('agents and side queries on sessions of their own keep their own snapshots', () => {
    const main = key('s1', 'repl_main_thread')
    const agent = key('tau-agent-a', 'agent:builtin:general-purpose')
    assert(agent !== main, 'agent shares the main snapshot')
    assert(key('tau-agent-a', 'compact') === agent, "an agent's fork uses the agent snapshot")
    assert(key('tau-query-t', 'generate_session_title') !== main, 'side query shares the main snapshot')
  })

  await test('a request with fewer tools leaves the order alone; a returning tool regains its slot', () => {
    const k = key('s1', 'repl_main_thread')
    freezeOpenRouterSystem(k, 'S')
    freezeOpenRouterTools(k, [fn('A'), fn('B'), fn('C')])
    const subset = freezeOpenRouterTools(k, [fn('C'), fn('A')])
    assert(names(subset) === 'A,C', `subset ${names(subset)}`)
    const back = freezeOpenRouterTools(k, [fn('A'), fn('B'), fn('C')])
    assert(names(back) === 'A,B,C', `after return ${names(back)}`)
    const changed = freezeOpenRouterTools(k, [fn('A'), fn('B', { limit: { type: 'integer' } }), { ...fn('C'), function: { ...fn('C').function, description: 'reworded' } }])
    assert(names(changed) === 'A,B,C', `after change ${names(changed)}`)
    assert((changed[1]!.function.parameters as any).properties.limit, 'a changed contract is sent')
    assert((changed[2]!.function as any).description === 'C tool', 'an unchanged contract keeps its first description')
  })

  await test('reset forgets conversations too', () => {
    const main = key('s1', 'repl_main_thread')
    freezeOpenRouterSystem(main, 'S')
    resetOpenRouterContext()
    assert(key('s1', 'prompt_suggestion') !== main, 'a reset must not leave forks pointing at a dropped snapshot')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
