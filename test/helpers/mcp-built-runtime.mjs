import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Exercise the shipped bundle, without launching the CLI or copying production functions.
export async function loadMcpRuntime() {
  const distPath = resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs')
  const auditPath = join(dirname(distPath), `.mcp-boundaries-${process.pid}-${Date.now()}.mjs`)
  let source = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
  const paths = [
    'src/services/tools/toolExecution.ts', 'src/utils/messages.ts',
    'src/services/mcp/client.ts', 'src/services/mcp/discovery.ts',
    'src/lanes/codex/loop.ts', 'src/lanes/qwen/loop.ts',
    'src/lanes/gemini/loop.ts', 'src/lanes/kiro/loop.ts',
    'src/lanes/openai-compat/loop.ts', 'src/lanes/provider-bridge.ts',
    'src/lanes/cline/tool_arg_validation.ts',
    'src/services/api/adapters/openai_responses.ts',
    'src/services/api/adapters/openai_to_anthropic.ts',
    'src/services/api/adapters/gemini_to_anthropic.ts',
    'src/tools/EvalTool/toolBridge.ts',
    'src/services/mcp/outcomes.ts',
  ]
  const inits = paths.map(path => {
    const match = source.match(new RegExp('var (init_\\w+) = __esm\\(\\{\\s*"' + path.replaceAll('.', '\\.') + '"\\(\\)'))
    assert.ok(match, `missing built module ${path}`)
    return `${match[1]}();`
  })
  source += `\nexport function __boundaries() {
    init_analytics(); ${inits.join('\n')}
    return { runToolUse, normalizeContentFromAPI, decodeToolArguments, decodeStatusOf,
      CodexLane, codexApi, QwenLane, qwenApi, GeminiLane, geminiApi, KiroLane,
      OpenAICompatLane, assembleFinalMessage, normalizeClineToolCallArgumentEvents,
      responsesMessageToAnthropic, openAIMessageToAnthropic, geminiMessageToAnthropic,
      geminiStreamToAnthropicEvents, openAIStreamToAnthropicEvents, responsesStreamToAnthropicEvents,
      callMCPTool, connectToServer, getServerCacheKey, clearServerCache,
      McpToolCallError: McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      fetchToolsForClient, getMcpToolsCommandsAndResources, memoizeDiscovery, ensureToolBridge, registerBridgeSession,
      getToolResultsDir, sanitizeErrorToolResultContent,
      outcomeOf, isOutcomeRecord, describeOutcome, mayHaveExecuted,
      attachOutcome, OUTCOME_RECORD_VERSION,
      disposeToolBridge: async () => {
        if (serverPromise) { const { server } = await serverPromise; await new Promise(resolve => server.close(resolve)); }
      } };
  }`
  writeFileSync(auditPath, source)
  try {
    return (await import(pathToFileURL(auditPath).href)).__boundaries()
  } finally {
    unlinkSync(auditPath)
  }
}

export function fixtureTool(overrides = {}) {
  const calls = []
  return {
    name: 'FixtureTool', calls, isMcp: false, maxResultSizeChars: 100_000,
    inputSchema: { safeParse: value => ({ success: true, data: value }) },
    inputJSONSchema: { type: 'object', properties: {}, additionalProperties: true },
    description: async () => 'fixture', prompt: async () => 'fixture',
    userFacingName: () => 'fixture', isReadOnly: () => true, isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: 'allow' }),
    async call(input) { calls.push(input); return { data: 'fixture ok' } },
    mapToolResultToToolResultBlockParam: (content, id) => ({ type: 'tool_result', tool_use_id: id, content }),
    renderToolUseMessage: () => null, renderToolResultMessage: () => null,
    ...overrides,
  }
}

export function fixtureContext(tools, overrides = {}) {
  return {
    abortController: new AbortController(),
    options: { tools, mcpClients: [], isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
    messages: [],
    getAppState: () => ({ mcp: { clients: [], tools }, sessionHooks: new Map(),
      toolPermissionContext: { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} } }),
    setAppState: () => {}, ...overrides,
  }
}

export async function executeBlock(runtime, block, tool, overrides) {
  const context = fixtureContext([tool], overrides)
  const updates = []
  for await (const update of runtime.runToolUse(block,
    { type: 'assistant', uuid: 'fixture-assistant', message: { id: 'fixture-message', content: [block] } },
    async () => ({ behavior: 'allow', updatedInput: block.input }), context)) updates.push(update)
  const messages = updates.map(u => u.message).filter(m => m?.type === 'user')
  const results = messages.flatMap(m => m.message.content).filter(b => b.type === 'tool_result')
  return { results, messages }
}
