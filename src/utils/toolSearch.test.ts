/**
 * Tool-search provider compatibility checks.
 *
 * Run via: bun run src/utils/toolSearch.test.ts
 */

import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.js'
import {
  providerSupportsClientSideToolDiscovery,
  providerSupportsSafeToolDiscovery,
  shouldDisableToolDeferralForProvider,
} from './toolDeferralPolicy.js'
import { providerSupportsAnthropicToolSearch } from './model/providerCapabilities.js'
import {
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from './model/providers.js'
import { z } from 'zod/v4'
import {
  checkBlindDeferredCallInput,
  resetBlindCallValidatorCache,
} from './blindToolCallValidation.js'
import { extractDiscoveredToolNames } from './toolDiscoveryScan.js'
import { decideLazyToolCall } from './toolSearchCallDecision.js'
import { normalizeToolSearchInput } from './toolSearchInput.js'
import { selectToolsForToolSearchRequest } from './toolSearchRequestFilter.js'

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

test('Cursor does not use Anthropic tool-search deferral', () => {
  assert(
    !providerSupportsAnthropicToolSearch('cursor'),
    'cursor must receive full tool schemas directly',
  )
})

test('Anthropic-native providers can use Anthropic tool search', () => {
  assert(providerSupportsAnthropicToolSearch('firstParty'), 'firstParty')
  assert(providerSupportsAnthropicToolSearch('bedrock'), 'bedrock')
  assert(providerSupportsAnthropicToolSearch('vertex'), 'vertex')
  assert(providerSupportsAnthropicToolSearch('foundry'), 'foundry')
})

test('other native lanes also bypass Anthropic tool-search deferral', () => {
  for (const provider of ['openai', 'gemini', 'antigravity', 'kiro'] as const) {
    assert(
      !providerSupportsAnthropicToolSearch(provider),
      `${provider} must receive full tool schemas directly`,
    )
  }
})

test('direct assistant tool_use marks deferred tool as discovered for retry', () => {
  const discovered = extractDiscoveredToolNames([
    {
      type: 'assistant',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'TaskUpdate',
            input: { id: '1', status: 'completed' },
          },
        ],
      },
    } as any,
  ])

  assert(discovered.has('TaskUpdate'), 'TaskUpdate should be discovered')
})

test('first-party Anthropic uses its native safe discovery transport', () => {
  assert(
    !shouldDisableToolDeferralForProvider('firstParty', 'normal'),
    'first-party normal mode should support server-native discovery',
  )
  assert(
    !shouldDisableToolDeferralForProvider('firstParty', 'full'),
    'first-party full mode should support server-native discovery',
  )
  assert(
    shouldDisableToolDeferralForProvider('firstParty', 'cheap'),
    'cheap mode must send eager schemas even on the server-native transport',
  )
})

test('Bedrock keeps existing Anthropic deferral policy', () => {
  assert(
    !shouldDisableToolDeferralForProvider('bedrock', 'normal'),
    'bedrock normal mode should keep existing deferral',
  )
  assert(
    !shouldDisableToolDeferralForProvider('bedrock', 'full'),
    'bedrock full mode should keep existing deferral',
  )
})

test('every provider is eager in cheap and lazy only in normal/full modes', () => {
  for (const provider of Object.keys(PROVIDER_DISPLAY_NAMES) as APIProvider[]) {
    assert(
      shouldDisableToolDeferralForProvider(provider, 'cheap'),
      `${provider}/cheap deferred a schema`,
    )
  }
  for (const provider of ['gemini', 'openrouter', 'opencode', 'deepseek'] as const) {
    assert(providerSupportsClientSideToolDiscovery(provider), provider)
    assert(providerSupportsSafeToolDiscovery(provider), provider)
    assert(
      shouldDisableToolDeferralForProvider(provider, 'cheap'),
      `${provider}/cheap must keep a stable eager prefix`,
    )
    for (const mode of ['normal', 'full'] as const) {
      assert(
        !shouldDisableToolDeferralForProvider(provider, mode),
        `${provider}/${mode} unexpectedly disabled`,
      )
    }
  }
})

test('AgentRouter bypass path does not opt into client-side discovery', () => {
  assert(!providerSupportsClientSideToolDiscovery('agentrouter'), 'agentrouter')
  for (const mode of ['cheap', 'normal', 'full'] as const) {
    assert(
      shouldDisableToolDeferralForProvider('agentrouter', mode),
      `agentrouter/${mode} must stay eager`,
    )
  }
})

test('unknown or dedicated lanes fall back to eager schemas', () => {
  for (const provider of ['cursor', 'openai', 'commandcode', 'kiro'] as const) {
    assert(!providerSupportsSafeToolDiscovery(provider), provider)
    for (const mode of ['cheap', 'normal', 'full'] as const) {
      assert(
        shouldDisableToolDeferralForProvider(provider, mode),
        `${provider}/${mode} must stay eager`,
      )
    }
  }
})

test('first-party Anthropic keeps deferred schemas on the request', () => {
  const tools = [
    { name: TOOL_SEARCH_TOOL_NAME },
    { name: 'Read' },
    { name: 'TaskUpdate' },
    { name: 'WebFetch' },
  ] as any

  const selected = selectToolsForToolSearchRequest(tools, {
    useToolSearch: true,
    useNativeLaneToolSearch: false,
    deferredToolNames: new Set(['TaskUpdate', 'WebFetch']),
    discoveredToolNames: new Set(['TaskUpdate']),
    provider: 'firstParty',
  }).map(tool => tool.name)

  assert(selected.includes('WebFetch'), 'undiscovered deferred tool was filtered')
  assert(selected.length === tools.length, 'first-party should keep all tools')
})

test('non-first-party Anthropic providers keep discovered-only filtering', () => {
  const tools = [
    { name: TOOL_SEARCH_TOOL_NAME },
    { name: 'Read' },
    { name: 'TaskUpdate' },
    { name: 'WebFetch' },
  ] as any

  const selected = selectToolsForToolSearchRequest(tools, {
    useToolSearch: true,
    useNativeLaneToolSearch: false,
    deferredToolNames: new Set(['TaskUpdate', 'WebFetch']),
    discoveredToolNames: new Set(['TaskUpdate']),
    provider: 'bedrock',
  }).map(tool => tool.name)

  assert(selected.includes(TOOL_SEARCH_TOOL_NAME), 'ToolSearch was filtered')
  assert(selected.includes('TaskUpdate'), 'discovered tool was filtered')
  assert(!selected.includes('WebFetch'), 'undiscovered tool should stay filtered')
})

test('native request filtering preserves the full pool for lane fallback', () => {
  const tools = [
    { name: TOOL_SEARCH_TOOL_NAME },
    { name: 'Read' },
    { name: 'NotebookEdit' },
  ] as any

  const selected = selectToolsForToolSearchRequest(tools, {
    useToolSearch: false,
    useNativeLaneToolSearch: true,
    deferredToolNames: new Set(['NotebookEdit']),
    discoveredToolNames: new Set(),
    provider: 'deepseek',
  })

  assert(selected.length === tools.length, 'native source schema was discarded')
  assert(selected[2] === tools[2], 'native source order/reference changed')
})

test('ToolSearch repairs guessed parameter aliases without changing its public dialect', () => {
  const repaired = normalizeToolSearchInput({
    tool_name: 'NotebookEdit',
    max_results: '3',
    invented_parameter: true,
  }) as Record<string, unknown>
  assert(repaired.query === 'select:NotebookEdit', String(repaired.query))
  assert(repaired.max_results === '3', 'coercible fields should be preserved')

  const canonical = normalizeToolSearchInput({
    query: 'web current information',
    tool_name: 'WrongGuess',
  }) as Record<string, unknown>
  assert(canonical.query === 'web current information', 'canonical query lost')
})

const builtinToolFixture = {
  name: 'NotebookEdit',
  isMcp: false,
  inputSchema: z.object({
    notebook_path: z.string(),
    new_source: z.string(),
    cell_type: z.enum(['code', 'markdown']).optional(),
  }),
} as never

const mcpToolFixture = {
  name: 'mcp__github__create_issue',
  isMcp: true,
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['repo', 'title'],
  },
} as never

test('blind deferred call runs when its arguments match the real schema', () => {
  resetBlindCallValidatorCache()
  const first = decideLazyToolCall({
    toolName: 'NotebookEdit',
    isDeferred: true,
    schemaWasLoaded: false,
    discoveryIsActive: true,
  })
  assert(
    first.action === 'execute_unverified',
    'blind call was not routed to local verification',
  )

  const wellFormed = checkBlindDeferredCallInput(builtinToolFixture, {
    notebook_path: '/tmp/a.ipynb',
    new_source: 'print(1)',
    cell_type: 'code',
  })
  assert(wellFormed.ok, 'a correct blind call was refused')

  const guessed = checkBlindDeferredCallInput(builtinToolFixture, {
    notebook_path: '/tmp/a.ipynb',
    new_source: 'print(1)',
    overwrite_kernel: true,
  })
  assert(!guessed.ok, 'invented parameter was accepted on a blind call')
  assert(guessed.ok || guessed.message.includes('overwrite_kernel'), 'invented key not named')
  assert(
    guessed.ok || guessed.message.includes('Expected input schema'),
    'schema was not inlined for recovery',
  )

  const retry = decideLazyToolCall({
    toolName: 'NotebookEdit',
    isDeferred: true,
    schemaWasLoaded: true,
    discoveryIsActive: true,
  })
  assert(retry.action === 'execute', 'schema-loaded retry stayed guarded')
})

test('blind MCP call is validated against the server-declared JSON schema', () => {
  resetBlindCallValidatorCache()
  const ok = checkBlindDeferredCallInput(mcpToolFixture, {
    repo: 'a/b',
    title: 'hello',
  })
  assert(ok.ok, 'a correct blind MCP call was refused')

  const missing = checkBlindDeferredCallInput(mcpToolFixture, { repo: 'a/b' })
  assert(!missing.ok, 'blind MCP call ran without a required argument')

  const invented = checkBlindDeferredCallInput(mcpToolFixture, {
    repo: 'a/b',
    title: 'hello',
    assignee: 'nobody',
  })
  assert(!invented.ok, 'blind MCP call ran with an invented argument')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
