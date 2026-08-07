/**
 * Tool-search provider compatibility checks.
 *
 * Run via: bun run src/utils/toolSearch.test.ts
 */

import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.js'
import { shouldDisableToolDeferralForProvider } from './toolDeferralPolicy.js'
import { providerSupportsAnthropicToolSearch } from './model/providerCapabilities.js'
import {
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from './model/providers.js'
import { extractDiscoveredToolNames } from './toolDiscoveryScan.js'
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

test('first-party Anthropic disables schema deferral', () => {
  assert(
    shouldDisableToolDeferralForProvider('firstParty', 'normal'),
    'first-party normal mode should send schemas inline',
  )
  assert(
    shouldDisableToolDeferralForProvider('firstParty', 'full'),
    'first-party full mode should send schemas inline',
  )
  assert(
    shouldDisableToolDeferralForProvider('firstParty', 'rust'),
    'first-party rust mode should send schemas inline',
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
  assert(
    !shouldDisableToolDeferralForProvider('bedrock', 'rust'),
    'bedrock rust mode should keep existing deferral',
  )
})

test('Rust mode preserves normal deferral behavior on every provider', () => {
  for (const provider of Object.keys(PROVIDER_DISPLAY_NAMES) as APIProvider[]) {
    assert(
      shouldDisableToolDeferralForProvider(provider, 'rust') ===
        shouldDisableToolDeferralForProvider(provider, 'normal'),
      `${provider} changed schema-deferral behavior in rust mode`,
    )
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
