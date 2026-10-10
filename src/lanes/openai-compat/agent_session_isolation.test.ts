import { afterAll, beforeEach, expect, test } from 'bun:test'
import { OpenAICompatLane } from './loop.js'
import type { OpenAIChatRequest } from './transformers/shared_types.js'
import type { ProviderMessage, ProviderTool } from '../../services/api/providers/base_provider.js'
import { resetSessionVolatileFreeze } from '../shared/volatile_freeze.js'
import { statedWorkingDirectory } from '../shared/working_directory.js'
import { _resetStickyLoadedToolsForTest } from '../shared/lazy_tools_core.js'
import { registerForkedAgent, resolveProviderRequestSessionId } from '../../services/api/cacheAffinity.js'
import type { AgentId } from '../../types/ids.js'
import type { QuerySource } from '../../constants/querySource.js'

const originalFetch = globalThis.fetch
afterAll(() => { globalThis.fetch = originalFetch })
beforeEach(() => {
  globalThis.fetch = originalFetch
  resetSessionVolatileFreeze()
  _resetStickyLoadedToolsForTest()
})

const MAIN_DIR = 'C:/repo'
const WORKTREE_DIR = 'C:/repo/.claude/worktrees/agent-a'
const system = (dir: string, status = 'clean') =>
  `Agent rules.\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n# Environment\n - Primary working directory: ${dir}\n - git status: ${status}`
const tool = (name: string, deferred = false): ProviderTool => ({
  name,
  description: `${name} tool`,
  input_schema: { type: 'object', properties: { value: { type: 'string' } } },
  ...(deferred && { defer_loading: true }),
}) as ProviderTool
const ask = (text: string): ProviderMessage => ({ role: 'user', content: text })
// The ToolSearch call that loaded WebFetch, as an agent's history carries it.
const loadWebFetch = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'search001', name: 'ToolSearch', input: { query: 'select:WebFetch' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search001', content: [{ type: 'tool_reference', tool_name: 'WebFetch' }] }] },
] as unknown as ProviderMessage[]
const block = (body: OpenAIChatRequest) => body.messages
  .find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<dynamic_context>'))?.content
const toolNames = (body: OpenAIChatRequest) => (body.tools ?? []).map(t => t.function.name)

// Tau defers tools behind ToolSearch on GLM and MiniMax only; DeepSeek and
// Moonshot always receive every tool (toolDeferralPolicy.ts).
const PROVIDERS = [
  { provider: 'deepseek', model: 'deepseek-v4-flash', defers: false },
  { provider: 'glm', model: 'glm-4.7', defers: true },
  { provider: 'moonshot', model: 'kimi-k2.6', defers: false },
  { provider: 'minimax', model: 'MiniMax-M2.7', defers: true },
] as const

for (const { provider, model, defers } of PROVIDERS) {
  test(`${provider}: a worktree agent keeps its own environment block and loaded tools; the main thread is unchanged`, async () => {
    const lane = new OpenAICompatLane()
    lane.registerProvider(provider, 'fixture', 'https://fixture.invalid/v1')
    const bodies: OpenAIChatRequest[] = []
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const tools = defers
      ? [tool('Read'), tool('ToolSearch'), tool('WebFetch', true)]
      : [tool('Read'), tool('WebFetch')]
    const rootSessionId = `${provider}-isolation-root`
    const send = async (agentId: string | undefined, querySource: string, dir: string, messages: ProviderMessage[], status?: string) => {
      const sessionId = resolveProviderRequestSessionId({
        provider, rootSessionId, ...(agentId && { agentId: agentId as AgentId }), querySource: querySource as QuerySource,
      })
      for await (const _ of lane.streamAsProvider({ model, providerHint: provider, sessionId, querySource,
        system: system(dir, status), messages, tools, max_tokens: 100, signal: new AbortController().signal })) { /* drain */ }
      return bodies.at(-1)!
    }

    const main = await send(undefined, 'repl_main_thread', MAIN_DIR, [ask('Main task.')])
    expect(block(main)).toContain(`Primary working directory: ${MAIN_DIR}\n`)

    const agent = await send('wt-a', 'agent:builtin:general-purpose', WORKTREE_DIR, [ask('Agent task.')])
    expect(block(agent)).toContain(`Primary working directory: ${WORKTREE_DIR}`)
    expect(block(agent)).not.toContain(`Primary working directory: ${MAIN_DIR}\n`)

    // A resume replays the agent's own frozen block, and keeps what it loaded.
    const agentHistory = defers ? [ask('Agent task.'), ...loadWebFetch] : [ask('Agent task.'), { role: 'assistant', content: 'OK' } as ProviderMessage, ask('Next.')]
    const resumed = await send('wt-a', 'agent:builtin:general-purpose', WORKTREE_DIR, agentHistory, 'modified')
    expect(block(resumed)).toBe(block(agent))
    if (defers) expect(toolNames(resumed)).toContain('WebFetch')

    // Its progress summary is a registered helper: same conversation, same prefix.
    const release = registerForkedAgent('wt-a-summary' as AgentId, 'wt-a' as AgentId)
    try {
      const summary = await send('wt-a-summary', 'agent_summary', WORKTREE_DIR, agentHistory)
      expect(block(summary)).toBe(block(agent))
      expect(toolNames(summary)).toEqual(toolNames(resumed))
    } finally {
      release()
    }

    // The main thread keeps its own frozen block and only the tools it loaded.
    const next = await send(undefined, 'repl_main_thread', MAIN_DIR,
      [ask('Main task.'), { role: 'assistant', content: 'OK' }, ask('Continue.')], 'modified')
    expect(block(next)).toBe(block(main))
    expect(toolNames(next)).toEqual(toolNames(main))
    if (defers) expect(toolNames(next)).not.toContain('WebFetch')

    if (provider === 'moonshot') {
      expect(main.prompt_cache_key).toBe(rootSessionId)
      expect(next.prompt_cache_key).toBe(rootSessionId)
      expect(agent.prompt_cache_key).toMatch(/^tau-agent-/)
      expect(resumed.prompt_cache_key).toBe(agent.prompt_cache_key)
    }
  })
}

test('reads the working directory an environment block states, and nothing else', () => {
  expect(statedWorkingDirectory('# Environment\n - Primary working directory: C:\\Users\\a b\\repo\n - Platform: win32')).toBe('C:\\Users\\a b\\repo')
  expect(statedWorkingDirectory('Notes.\nWorking directory: /tmp/repo/.claude/worktrees/agent-a\r\nPlatform: linux')).toBe('/tmp/repo/.claude/worktrees/agent-a')
  expect(statedWorkingDirectory('- To install an MCP server, check the working directory first.')).toBeUndefined()
  expect(statedWorkingDirectory('')).toBeUndefined()
})

// The main thread's system prompt is built once per turn (query.ts), and
// EnterWorktree/ExitWorktree reset the frozen blocks mid-turn through
// clearSystemPromptSections() -> resetSessionVolatileFreeze(). The rest of
// that turn still states the old directory; the next turn states the new one.
const WORKTREE = 'C:/repo/.claude/worktrees/probe'
for (const { provider, model } of [...PROVIDERS, { provider: 'mistral', model: 'mistral-large-4' }] as const) {
  test(`${provider}: the main thread's frozen environment follows EnterWorktree and ExitWorktree from the next turn`, async () => {
    const lane = new OpenAICompatLane()
    lane.registerProvider(provider, 'fixture', 'https://fixture.invalid/v1')
    const bodies: OpenAIChatRequest[] = []
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const history: ProviderMessage[] = []
    const send = async (dir: string, text: string) => {
      history.push(ask(text))
      for await (const _ of lane.streamAsProvider({ model, providerHint: provider, sessionId: `${provider}-worktree-root`, querySource: 'repl_main_thread',
        system: system(dir), messages: [...history], tools: [tool('Read')], max_tokens: 100, signal: new AbortController().signal })) { /* drain */ }
      history.push({ role: 'assistant', content: 'OK' })
      const body = bodies.at(-1)!
      // Direct lanes move the block into a leading user message; Mistral
      // freezes the whole system prompt, block included.
      const frozen = block(body) ?? String(body.messages.find(m => m.role === 'system')?.content ?? '')
      return statedWorkingDirectory(frozen)
    }

    expect(await send(MAIN_DIR, 'Turn 1: enter a worktree.')).toBe(MAIN_DIR)
    resetSessionVolatileFreeze() // EnterWorktree
    expect(await send(MAIN_DIR, 'Rest of turn 1.')).toBe(MAIN_DIR)
    expect(await send(WORKTREE, 'Turn 2.')).toBe(WORKTREE)
    expect(await send(WORKTREE, 'Rest of turn 2.')).toBe(WORKTREE)
    resetSessionVolatileFreeze() // ExitWorktree
    expect(await send(WORKTREE, 'Rest of turn 3.')).toBe(WORKTREE)
    expect(await send(MAIN_DIR, 'Turn 4.')).toBe(MAIN_DIR)
  })
}
