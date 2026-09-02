/**
 * Run: bun run src/lanes/gemini/lazy_tools.test.ts
 */

import type {
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import { isAntigravityModelId } from '../../services/api/providers/gemini_code_assist.js'
import { _resetStickyLoadedToolsForTest } from '../shared/lazy_tools_core.js'
import {
  extractGeminiLoadedToolNames,
  selectGeminiToolsForRequest,
} from './lazy_tools.js'

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

function tool(name: string, deferred = false): ProviderTool {
  const t: ProviderTool = {
    name,
    description: `${name} description`,
    input_schema: { type: 'object', properties: {} },
  }
  Object.defineProperty(t, '__tau_should_defer', {
    value: deferred,
    enumerable: false,
  })
  return t
}

function names(tools: ProviderTool[]): string[] {
  return tools.map(t => t.name)
}

function loadedMessage(...toolNames: string[]): ProviderMessage {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: toolNames.map(
        name => ({ type: 'tool_reference', tool_name: name }) as any,
      ),
    }],
  }
}

function compactBoundary(...toolNames: string[]): ProviderMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: {
      preCompactDiscoveredTools: toolNames,
    },
  } as unknown as ProviderMessage
}

console.log('gemini lazy tools:')

test('extracts loaded names from ToolSearch tool_reference results', () => {
  const messages: ProviderMessage[] = [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: [
        { type: 'tool_reference', tool_name: 'InspectSite' } as any,
        { type: 'tool_reference', tool_name: 'ProjectWorkflow' } as any,
      ],
    }],
  }]

  const loaded = extractGeminiLoadedToolNames(messages)
  assert(loaded.has('InspectSite'), 'InspectSite not loaded')
  assert(loaded.has('ProjectWorkflow'), 'ProjectWorkflow not loaded')
})

test('keeps undiscovered deferred tools out of Gemini declarations', () => {
  const selected = selectGeminiToolsForRequest(
    [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)],
    [],
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )

  assert(
    names(selected).join(',') === 'Read,ToolSearch',
    names(selected).join(','),
  )
})

test('missing ToolSearch automatically falls back to eager Gemini schemas', () => {
  const selected = selectGeminiToolsForRequest(
    [tool('Read'), tool('NotebookEdit', true)],
    [],
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )

  assert(
    names(selected).join(',') === 'Read,NotebookEdit',
    names(selected).join(','),
  )
})

test('includes a deferred tool after ToolSearch loaded it', () => {
  const messages: ProviderMessage[] = [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: [{ type: 'tool_reference', tool_name: 'InspectSite' } as any],
    }],
  }]
  const selected = selectGeminiToolsForRequest(
    [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)],
    messages,
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )

  assert(
    names(selected).join(',') === 'Read,ToolSearch,InspectSite',
    names(selected).join(','),
  )
})

test('includes deferred tools carried by compact boundary metadata', () => {
  const selected = selectGeminiToolsForRequest(
    [tool('Read'), tool('ToolSearch'), tool('TaskCreate', true)],
    [compactBoundary('TaskCreate')],
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )

  assert(
    names(selected).join(',') === 'Read,ToolSearch,TaskCreate',
    names(selected).join(','),
  )
})

test('undiscovered deferred additions do not change the cacheable tool set', () => {
  const base = selectGeminiToolsForRequest(
    [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)],
    [],
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )
  const withExtra = selectGeminiToolsForRequest(
    [
      tool('Read'),
      tool('ToolSearch'),
      tool('InspectSite', true),
      tool('SampleDeferred', true),
    ],
    [],
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )

  assert(
    JSON.stringify(names(base)) === JSON.stringify(names(withExtra)),
    `${names(base)} vs ${names(withExtra)}`,
  )
})

test('a deferred tool placed BEFORE the base appends after it (cache prefix stays stable)', () => {
  // Grep is deferred and sits at index 0, ahead of the non-deferred base.
  // A plain filter would keep it at index 0 and shift ToolSearch/Edit right,
  // breaking the cached tool prefix. Append-only ordering must move it last.
  const selected = selectGeminiToolsForRequest(
    [tool('Grep', true), tool('Read'), tool('ToolSearch'), tool('Edit')],
    [loadedMessage('Grep')],
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )

  assert(
    names(selected).join(',') === 'Read,ToolSearch,Edit,Grep',
    names(selected).join(','),
  )
})

test('deferred tools append in LOAD order, not array-index order', () => {
  // Alpha precedes Beta in the source array, but Beta is discovered first.
  // Load order (Beta, Alpha) is the only append-only choice: ordering by
  // array index would put Alpha ahead of the already-sent Beta.
  const selected = selectGeminiToolsForRequest(
    [tool('Read'), tool('ToolSearch'), tool('Alpha', true), tool('Beta', true)],
    [loadedMessage('Beta', 'Alpha')],
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )

  assert(
    names(selected).join(',') === 'Read,ToolSearch,Beta,Alpha',
    names(selected).join(','),
  )
})

test('discovering a second tool only appends — earlier prefix is byte-stable', () => {
  const source = [
    tool('Read'),
    tool('ToolSearch'),
    tool('Alpha', true),
    tool('Beta', true),
  ]
  const afterBeta = selectGeminiToolsForRequest(
    source,
    [loadedMessage('Beta')],
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )
  const afterBetaThenAlpha = selectGeminiToolsForRequest(
    source,
    [loadedMessage('Beta', 'Alpha')],
    { model: 'gemini-2.5-pro', providerHint: 'gemini' },
  )

  // The turn-1 selection must be an exact prefix of the turn-2 selection.
  const prev = names(afterBeta)
  const next = names(afterBetaThenAlpha)
  assert(
    JSON.stringify(next.slice(0, prev.length)) === JSON.stringify(prev),
    `${prev} is not a prefix of ${next}`,
  )
})

test('a loaded tool survives compaction erasing its history evidence', () => {
  _resetStickyLoadedToolsForTest()
  const source = [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)]
  const opts = {
    model: 'gemini-2.5-pro',
    providerHint: 'gemini',
    sessionId: 'sess-sticky',
  }

  // Turn N: history shows the load → tool appended.
  const loaded = selectGeminiToolsForRequest(
    source,
    [loadedMessage('InspectSite')],
    opts,
  )
  assert(
    names(loaded).join(',') === 'Read,ToolSearch,InspectSite',
    names(loaded).join(','),
  )

  // Turn N+1: compaction wiped the tool_reference evidence — the same session
  // must keep the tool at the same appended position (no tool-block rewrite,
  // no silently-vanishing tool).
  const afterCompaction = selectGeminiToolsForRequest(source, [], opts)
  assert(
    names(afterCompaction).join(',') === 'Read,ToolSearch,InspectSite',
    names(afterCompaction).join(','),
  )
})

test('sticky registry is per-session — other sessions stay hidden', () => {
  _resetStickyLoadedToolsForTest()
  const source = [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)]
  selectGeminiToolsForRequest(source, [loadedMessage('InspectSite')], {
    model: 'gemini-2.5-pro',
    providerHint: 'gemini',
    sessionId: 'sess-a',
  })
  const other = selectGeminiToolsForRequest(source, [], {
    model: 'gemini-2.5-pro',
    providerHint: 'gemini',
    sessionId: 'sess-b',
  })
  assert(names(other).join(',') === 'Read,ToolSearch', names(other).join(','))
})

test('Antigravity provider hint keeps the current full tool behavior', () => {
  const selected = selectGeminiToolsForRequest(
    [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)],
    [],
    { model: 'gemini-3-flash', providerHint: 'antigravity' },
  )

  assert(
    names(selected).join(',') === 'Read,ToolSearch,InspectSite',
    names(selected).join(','),
  )
})

test('Antigravity model ids opt out with or without the models/ prefix', () => {
  assert(isAntigravityModelId('gemini-3-flash'), 'bare id')
  assert(isAntigravityModelId('models/gemini-3-flash'), 'models/ prefix')
  assert(isAntigravityModelId('CLAUDE-FABLE-5') === isAntigravityModelId('claude-fable-5'), 'case-insensitive')
  assert(!isAntigravityModelId('gemini-2.5-pro'), 'CLI Gemini id must stay lazy-eligible')

  // The lane selector and the upstream request-filter gate share this
  // predicate — a model the lane declines must keep its full tool set here.
  const selected = selectGeminiToolsForRequest(
    [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)],
    [],
    { model: 'models/gemini-3-flash', providerHint: 'gemini' },
  )
  assert(
    names(selected).join(',') === 'Read,ToolSearch,InspectSite',
    names(selected).join(','),
  )
})

test('ENABLE_TOOL_SEARCH=false keeps full Gemini tool behavior', () => {
  const previous = process.env.ENABLE_TOOL_SEARCH
  process.env.ENABLE_TOOL_SEARCH = 'false'
  try {
    const selected = selectGeminiToolsForRequest(
      [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)],
      [],
      { model: 'gemini-2.5-pro', providerHint: 'gemini' },
    )

    assert(
      names(selected).join(',') === 'Read,ToolSearch,InspectSite',
      names(selected).join(','),
    )
  } finally {
    if (previous === undefined) {
      delete process.env.ENABLE_TOOL_SEARCH
    } else {
      process.env.ENABLE_TOOL_SEARCH = previous
    }
  }
})

test('ENABLE_TOOL_SEARCH=auto:100 keeps full Gemini tool behavior', () => {
  const previous = process.env.ENABLE_TOOL_SEARCH
  process.env.ENABLE_TOOL_SEARCH = 'auto:100'
  try {
    const selected = selectGeminiToolsForRequest(
      [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)],
      [],
      { model: 'gemini-2.5-pro', providerHint: 'gemini' },
    )

    assert(
      names(selected).join(',') === 'Read,ToolSearch,InspectSite',
      names(selected).join(','),
    )
  } finally {
    if (previous === undefined) {
      delete process.env.ENABLE_TOOL_SEARCH
    } else {
      process.env.ENABLE_TOOL_SEARCH = previous
    }
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
