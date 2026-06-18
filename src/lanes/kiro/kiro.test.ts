import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import { _normalizeKiroTokenPayload } from '../../services/api/auth/oauth_services.js'
import { normalizeKiroModelId } from './catalog.js'
import type { KiroEvent } from './eventstream.js'
import {
  _closeOpenToolUseBlocks,
  _deriveKiroPromptUsage,
  _handleKiroEvent,
  _isTransientKiroStatus,
  _parseDsmlFunctionCalls,
} from './loop.js'
import { checkKiroPayloadSize, trimKiroPayloadToLimit } from './payload_guards.js'
import { buildKiroPayload } from './request.js'
import {
  buildKiroToolNameReverseMap,
  resolvePreferredKiroShellToolName,
  sanitizeKiroToolName,
  toClaudexToolName,
  toKiroToolName,
} from './tool_names.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  FAIL ${name}: ${message}`)
  }
}

function assert(condition: unknown, hint: string): void {
  if (!condition) throw new Error(hint)
}

type HandlerState = Parameters<typeof _handleKiroEvent>[1]

function createHandlerState(
  preferredShellToolName: string | null = 'Bash',
): { state: HandlerState; sawToolUse: () => boolean } {
  let currentIndex = 0
  let openBlock: 'text' | 'thinking' | null = null
  let pendingAssistantText = ''
  let toolCounter = 0
  let sawTool = false

  return {
    state: {
      model: 'deepseek-3.2',
      messageId: 'kiro-test',
      toolBlocks: new Map(),
      getCurrentIndex: () => currentIndex,
      setCurrentIndex: value => { currentIndex = value },
      getOpenBlock: () => openBlock,
      setOpenBlock: value => { openBlock = value },
      getPendingAssistantText: () => pendingAssistantText,
      setPendingAssistantText: value => { pendingAssistantText = value },
      markSawToolUse: () => { sawTool = true },
      nextSyntheticToolUseId: () => `toolu_test_${++toolCounter}`,
      preferredShellToolName,
      toolNameReverseMap: new Map(),
    },
    sawToolUse: () => sawTool,
  }
}

function collect(events: KiroEvent[]): {
  emitted: AnthropicStreamEvent[]
  sawToolUse: boolean
} {
  const { state, sawToolUse } = createHandlerState()
  const emitted: AnthropicStreamEvent[] = []
  for (const event of events) {
    emitted.push(..._handleKiroEvent(event, state))
  }
  return { emitted, sawToolUse: sawToolUse() }
}

function main(): void {
  console.log('kiro DSML regression:')

  test('parses DSML function blocks into JSON inputs', () => {
    const dsml = [
      '<\uFF5CDSML\uFF5Cfunction_calls>',
      '<\uFF5CDSML\uFF5Cinvoke name="Bash">',
      '<\uFF5CDSML\uFF5Cparameter name="command" string="true">pwd</\uFF5CDSML\uFF5Cparameter>',
      '<\uFF5CDSML\uFF5Cparameter name="timeout" string="false">120000</\uFF5CDSML\uFF5Cparameter>',
      '</\uFF5CDSML\uFF5Cinvoke>',
      '<\uFF5CDSML\uFF5Cinvoke name="Write">',
      '<\uFF5CDSML\uFF5Cparameter name="payload" string="false">{"ok":true}</\uFF5CDSML\uFF5Cparameter>',
      '</\uFF5CDSML\uFF5Cinvoke>',
      '</\uFF5CDSML\uFF5Cfunction_calls>',
    ].join('\n')

    const parsed = _parseDsmlFunctionCalls(dsml)
    assert(parsed !== null, 'expected DSML parser to succeed')
    assert(parsed?.length === 2, `expected 2 tool calls, got ${parsed?.length ?? 0}`)
    assert(parsed?.[0]?.name === 'Bash', `wrong first tool: ${parsed?.[0]?.name ?? 'missing'}`)
    assert(parsed?.[0]?.input.command === 'pwd', 'missing string parameter')
    assert(parsed?.[0]?.input.timeout === 120000, 'missing numeric parameter')
    assert((parsed?.[1]?.input.payload as { ok?: boolean }).ok === true, 'missing object parameter')
  })

  test('converts streamed DSML text into tool_use IR without leaking raw tags', () => {
    const events: KiroEvent[] = [
      {
        eventType: 'assistantResponseEvent',
        payload: {
          content: 'Let me inspect that.\n\n<\uFF5CDSML\uFF5Cfunct',
        },
      },
      {
        eventType: 'assistantResponseEvent',
        payload: {
          content: [
            'ion_calls>',
            '<\uFF5CDSML\uFF5Cinvoke name="Bash">',
            '<\uFF5CDSML\uFF5Cparameter name="command" string="true">pwd</\uFF5CDSML\uFF5Cparameter>',
            '</\uFF5CDSML\uFF5Cinvoke>',
            '</\uFF5CDSML\uFF5Cfunction_calls>',
          ].join('\n'),
        },
      },
      { eventType: 'messageStopEvent', payload: {} },
    ]

    const { emitted, sawToolUse } = collect(events)
    assert(sawToolUse, 'expected DSML tool call to mark tool use')

    const textDeltas = emitted
      .filter((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> => event.type === 'content_block_delta')
      .filter(event => event.delta.type === 'text_delta')
      .map(event => event.delta.text)
      .join('')
    assert(textDeltas.includes('Let me inspect that.'), 'expected normal text prefix to survive')
    assert(!textDeltas.includes('function_calls'), 'raw DSML markers leaked into text output')

    const toolStart = emitted.find((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> =>
      event.type === 'content_block_start' && event.content_block.type === 'tool_use')
    assert(toolStart?.content_block.name === 'Bash', 'expected Bash tool_use block')

    const toolDelta = emitted.find((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> =>
      event.type === 'content_block_delta' && event.delta.type === 'input_json_delta')
    assert(toolDelta?.delta.partial_json === '{"command":"pwd"}', `unexpected tool args: ${toolDelta?.delta.partial_json ?? 'missing'}`)

    const toolStop = emitted.find((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_stop' }> =>
      event.type === 'content_block_stop' && event.index === toolStart?.index)
    assert(toolStop, 'expected DSML tool_use block to be closed')
  })

  test('drops dangling DSML marker text when Kiro also emits toolUseEvent', () => {
    const events: KiroEvent[] = [
      {
        eventType: 'assistantResponseEvent',
        payload: {
          content: '\n\n<\uFF5CDSML\uFF5Cfunction_calls',
        },
      },
      {
        eventType: 'toolUseEvent',
        payload: {
          toolUseId: 'toolu_real',
          name: 'Bash',
          input: '{"command": "pwd"}',
        },
      },
      { eventType: 'messageStopEvent', payload: {} },
    ]

    const { emitted } = collect(events)
    const textDeltas = emitted
      .filter((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> => event.type === 'content_block_delta')
      .filter(event => event.delta.type === 'text_delta')
      .map(event => event.delta.text)
      .join('')
    assert(!textDeltas.includes('function_calls'), 'expected dangling DSML marker to be dropped')

    const toolStart = emitted.find((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> =>
      event.type === 'content_block_start' && event.content_block.type === 'tool_use')
    assert(toolStart?.content_block.name === 'Bash', 'expected toolUseEvent to still emit tool block')
  })

  test('normalizes legacy Kiro model aliases to the current ids', () => {
    assert(normalizeKiroModelId('MiniMax-M2.5') === 'minimax-m2.5', 'expected MiniMax alias to normalize')
    assert(normalizeKiroModelId('claude-sonnet-4.0') === 'claude-sonnet-4', 'expected sonnet alias to normalize')
    assert(normalizeKiroModelId('claude-opus-4.6') === 'claude-opus-4.6', 'unexpected rewrite for unknown retired model id')
  })

  test('builds Kiro tool payloads with sanitized schemas and strict hints', () => {
    const payload = buildKiroPayload({
      model: 'MiniMax-M2.5',
      system: 'Project rules',
      conversationId: 'stable-kiro-session',
      messages: [
        {
          role: 'user',
          content: 'List the files using the tool.',
        },
      ],
      tools: [
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
            required: ['command'],
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            strict: true,
          },
        },
      ],
    })

    assert(payload.conversationState.currentMessage.userInputMessage.modelId === 'minimax-m2.5', 'expected normalized model id in payload')
    assert(payload.conversationState.conversationId === 'stable-kiro-session', 'expected caller-supplied conversation id')

    const tool = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0]
    assert(!!tool, 'expected tool spec in current message')
    assert(tool?.toolSpecification.description.includes('STRICT PARAMETERS:'), 'expected strict hint in tool description')
    const schema = tool?.toolSpecification.inputSchema.json as Record<string, unknown>
    assert(!('$schema' in schema), 'expected $schema to be stripped from Kiro tool schema')
    assert(!('strict' in schema), 'expected strict keyword to be stripped from Kiro tool schema')

    const content = payload.conversationState.currentMessage.userInputMessage.content
    assert(content.includes('<tool_usage_rules>'), 'expected Kiro tool usage rules in system prompt')
  })

  test('omits Kiro profileArn unless auth supplied a real one', () => {
    const base = {
      model: 'deepseek-3.2',
      system: '',
      messages: [{ role: 'user' as const, content: 'hi' }],
      tools: [],
    }
    const withoutProfile = buildKiroPayload(base)
    assert(!('profileArn' in withoutProfile), 'Builder ID payload should omit profileArn')

    const withProfile = buildKiroPayload({
      ...base,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/EXAMPLE',
    })
    assert(withProfile.profileArn?.endsWith('/EXAMPLE'), 'expected stored profileArn to be preserved')
  })

  test('moves oversized Kiro tool descriptions into the system prompt', () => {
    const longDescription = 'Long tool documentation. '.repeat(600)
    const payload = buildKiroPayload({
      model: 'deepseek-3.2',
      system: 'Project rules',
      messages: [
        {
          role: 'user',
          content: 'Use the interactive question tool.',
        },
      ],
      tools: [
        {
          name: 'AskUserQuestion',
          description: longDescription,
          input_schema: {
            type: 'object',
            properties: {
              question: { type: 'string' },
            },
            required: ['question'],
          },
        },
      ],
    })

    const tool = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0]
    assert(!!tool, 'expected AskUserQuestion tool spec')
    assert(
      tool?.toolSpecification.description === "[Full documentation in system prompt under '## Tool: AskUserQuestion']",
      `unexpected inline tool description: ${tool?.toolSpecification.description ?? 'missing'}`,
    )

    const content = payload.conversationState.currentMessage.userInputMessage.content
    assert(content.includes('<tool_documentation>'), 'expected tool documentation block in system prompt')
    assert(content.includes('## Tool: AskUserQuestion'), 'expected AskUserQuestion documentation section')
    assert(content.includes('STRICT PARAMETERS:'), 'expected strict parameters hint to remain in moved documentation')
  })

  test('strips additionalProperties and empty required[] from Kiro tool schemas', () => {
    const payload = buildKiroPayload({
      model: 'minimax-m2.5',
      system: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'NoArgsTool',
          description: 'Takes no arguments',
          input_schema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        {
          name: 'NestedTool',
          description: 'Has nested object',
          input_schema: {
            type: 'object',
            properties: {
              payload: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: [],
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      ],
    })

    const tools = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools ?? []
    assert(tools.length === 2, `expected 2 tool specs, got ${tools.length}`)

    const noArgs = tools[0]?.toolSpecification.inputSchema.json as Record<string, unknown>
    assert(!('additionalProperties' in noArgs), 'expected additionalProperties stripped at top level')
    assert(!('required' in noArgs), 'expected empty required[] stripped at top level')

    const nested = tools[1]?.toolSpecification.inputSchema.json as Record<string, unknown>
    assert(!('additionalProperties' in nested), 'expected top-level additionalProperties stripped')
    const nestedPayload = (nested.properties as Record<string, unknown>)?.payload as Record<string, unknown>
    assert(!!nestedPayload, 'expected nested payload property to survive')
    assert(!('additionalProperties' in nestedPayload), 'expected nested additionalProperties stripped')
    assert(!('required' in nestedPayload), 'expected nested empty required[] stripped')
  })

  test('maps native shell tool_use blocks back to the preferred local shell tool', () => {
    const preferredShellToolName = resolvePreferredKiroShellToolName(['Bash', 'PowerShell']) ?? 'Bash'
    const { state } = createHandlerState(preferredShellToolName)
    const emitted = _handleKiroEvent({
      eventType: 'toolUseEvent',
      payload: {
        toolUseId: 'toolu_shell',
        name: 'shell',
        input: '{"command":"Get-ChildItem"}',
      },
    }, state)

    const toolStart = emitted.find((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> =>
      event.type === 'content_block_start' && event.content_block.type === 'tool_use')
    assert(toolStart?.content_block.name === preferredShellToolName, `expected shell tool to map to ${preferredShellToolName}, got ${toolStart?.content_block.name ?? 'missing'}`)
  })

  test('unwraps nested Kiro toolUseEvent payloads before mapping tool names', () => {
    const { state } = createHandlerState('Bash')
    const emitted = _handleKiroEvent({
      eventType: 'toolUseEvent',
      payload: {
        toolUseEvent: {
          toolUseId: 'toolu_nested_shell',
          name: 'shell',
          input: { command: 'pwd' },
        },
      },
    }, state)

    const toolStart = emitted.find((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> =>
      event.type === 'content_block_start' && event.content_block.type === 'tool_use')
    assert(toolStart?.content_block.name === 'Bash', `expected nested shell event to map to Bash, got ${toolStart?.content_block.name ?? 'missing'}`)

    const toolDelta = emitted.find((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> =>
      event.type === 'content_block_delta' && event.delta.type === 'input_json_delta')
    assert(toolDelta?.delta.partial_json === '{"command":"pwd"}', `unexpected nested tool args: ${toolDelta?.delta.partial_json ?? 'missing'}`)
  })

  test('derives non-negative rolling Kiro cache reads from context usage', () => {
    const first = _deriveKiroPromptUsage({
      rawInputTokens: 0,
      contextTokens: 12_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      previousContextTokens: 0,
    })
    assert(first.inputTokens === 12_000, `expected first turn input to be full context, got ${first.inputTokens}`)
    assert(first.cacheReadTokens === 0, `expected first turn cache read 0, got ${first.cacheReadTokens}`)

    const second = _deriveKiroPromptUsage({
      rawInputTokens: 0,
      contextTokens: 12_500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      previousContextTokens: first.nextContextTokens,
    })
    assert(second.inputTokens === 500, `expected second turn uncached delta 500, got ${second.inputTokens}`)
    assert(second.cacheReadTokens === 12_000, `expected second turn cache read 12000, got ${second.cacheReadTokens}`)

    const trimmed = _deriveKiroPromptUsage({
      rawInputTokens: 0,
      contextTokens: 8_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      previousContextTokens: second.nextContextTokens,
    })
    assert(trimmed.inputTokens === 0, `expected trimmed context to avoid negative input, got ${trimmed.inputTokens}`)
    assert(trimmed.cacheReadTokens === 8_000, `expected trimmed context cache read to clamp to current context, got ${trimmed.cacheReadTokens}`)
  })

  test('closes native tool_use blocks when the stream ends without messageStopEvent', () => {
    const { state } = createHandlerState('Bash')
    const emitted = _handleKiroEvent({
      eventType: 'toolUseEvent',
      payload: {
        toolUseId: 'toolu_glob',
        name: 'glob',
        input: { pattern: '**/*.py' },
      },
    }, state)

    const finalized: AnthropicStreamEvent[] = []
    _closeOpenToolUseBlocks(state, finalized)

    const toolStart = emitted.find((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> =>
      event.type === 'content_block_start' && event.content_block.type === 'tool_use')
    assert(toolStart?.content_block.name === 'Glob', `expected Glob tool, got ${toolStart?.content_block.name ?? 'missing'}`)

    const toolStop = finalized.find((event): event is Extract<AnthropicStreamEvent, { type: 'content_block_stop' }> =>
      event.type === 'content_block_stop' && event.index === toolStart?.index)
    assert(toolStop, 'expected finalizer to close the open tool_use block')
    assert(state.toolBlocks.size === 0, 'expected tool block state to be cleared after finalization')
  })

  test('adds shell syntax guidance that matches the chosen local shell backend', () => {
    const payload = buildKiroPayload({
      model: 'deepseek-3.2',
      system: '',
      messages: [{ role: 'user', content: 'List files' }],
      tools: [
        {
          name: 'Bash',
          description: 'Run shell command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
        {
          name: 'PowerShell',
          description: 'Run PowerShell command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
    })

    const tool = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0]
    assert(!!tool, 'expected shell tool spec')
    const preferredShellToolName = resolvePreferredKiroShellToolName(['Bash', 'PowerShell']) ?? 'Bash'
    if (preferredShellToolName === 'PowerShell') {
      assert(tool?.toolSpecification.description.includes('Use Windows PowerShell syntax'), 'expected PowerShell syntax guidance')
    } else {
      assert(tool?.toolSpecification.description.includes('Use POSIX/bash syntax'), 'expected Bash syntax guidance')
    }
  })

  test('adds a Kiro tool selection guide for the actual session tool pool', () => {
    const payload = buildKiroPayload({
      model: 'deepseek-3.2',
      system: 'Repo rules',
      messages: [{ role: 'user', content: 'Inspect the repo' }],
      tools: [
        {
          name: 'PowerShell',
          description: 'Run PowerShell command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
        {
          name: 'Edit',
          description: 'Edit a file',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
            },
            required: ['file_path', 'old_string', 'new_string'],
          },
        },
        {
          name: 'EnterPlanMode',
          description: 'Enter plan mode',
          input_schema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'Agent',
          description: 'Run a subagent',
          input_schema: {
            type: 'object',
            properties: { task: { type: 'string' } },
            required: ['task'],
          },
        },
        {
          name: 'ListMcpResourcesTool',
          description: 'List MCP resources',
          input_schema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    })

    const content = payload.conversationState.currentMessage.userInputMessage.content
    assert(content.includes('<tool_selection_guide>'), 'expected tool selection guide in prompt')
    assert(content.includes('PowerShell (run Windows shell and git commands)'), 'expected preferred shell guidance')
    assert(content.includes('Read (read files)'), 'expected file tool guidance')
    assert(content.includes('Edit (modify existing files in place)'), 'expected edit guidance')
    assert(content.includes('EnterPlanMode (switch into planning mode)'), 'expected planning guidance')
    assert(content.includes('Agent (launch a subagent)'), 'expected agent guidance')
    assert(content.includes('only describe rate limiting when the result explicitly says 429'), 'expected subagent rate-limit guard')
    assert(content.includes('ListMcpResourcesTool (list MCP resources)'), 'expected MCP guidance')
    assert(content.includes('Repo rules'), 'expected original system prompt preserved')
  })

  test('accepts snake_case Kiro social token payloads', () => {
    const now = Date.now() + 3600 * 1000
    const parsed = _normalizeKiroTokenPayload({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      profile_arn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/EXAMPLE',
      expires_at: new Date(now).toISOString(),
    })

    assert(parsed.accessToken === 'access-token', 'expected access_token to map to accessToken')
    assert(parsed.refreshToken === 'refresh-token', 'expected refresh_token to map to refreshToken')
    assert(parsed.profileArn?.includes(':profile/EXAMPLE') === true, 'expected profile_arn to map to profileArn')
    assert(typeof parsed.expiresIn === 'number' && parsed.expiresIn > 0, 'expected expires_at to map to expiresIn seconds')
  })

  test('trims Kiro payload history in pairs while preserving the system-bearing prefix', () => {
    const payload = {
      conversationState: {
        chatTriggerType: 'MANUAL' as const,
        conversationId: 'test-conversation',
        currentMessage: {
          userInputMessage: {
            content: 'Current user turn',
            modelId: 'deepseek-3.2',
          },
        },
        history: [
          {
            userInputMessage: {
              content: `System rules\n\n${'A'.repeat(200)}`,
              modelId: 'deepseek-3.2',
            },
          },
          {
            assistantResponseMessage: {
              content: 'First assistant turn',
            },
          },
          {
            userInputMessage: {
              content: 'Second user turn ' + 'B'.repeat(800),
              modelId: 'deepseek-3.2',
              userInputMessageContext: {
                toolResults: [
                  {
                    toolUseId: 'toolu_second',
                    status: 'success' as const,
                    content: [{ text: 'tool result' }],
                  },
                ],
              },
            },
          },
          {
            assistantResponseMessage: {
              content: 'Second assistant turn',
            },
          },
          {
            userInputMessage: {
              content: 'Third user turn ' + 'C'.repeat(800),
              modelId: 'deepseek-3.2',
            },
          },
          {
            assistantResponseMessage: {
              content: 'Third assistant turn',
            },
          },
        ],
      },
    }

    const originalBytes = checkKiroPayloadSize(payload)
    const stats = trimKiroPayloadToLimit(payload, Math.floor(originalBytes * 0.7), {
      preserveLeadingEntries: 2,
    })

    assert(stats.trimmed, 'expected payload history to be trimmed')
    assert(payload.conversationState.history.length < 6, 'expected some history entries to be removed')
    const firstUser = payload.conversationState.history[0]
    assert(!!firstUser && 'userInputMessage' in firstUser, 'expected preserved history to still start with user')
    assert(firstUser.userInputMessage.content.includes('System rules'), 'expected system-bearing first user turn to be preserved')
  })

  test('soft-trims Kiro payloads during build to control per-turn token spend', () => {
    const previousTarget = process.env.CLAUDEX_KIRO_TARGET_PAYLOAD_BYTES
    const previousMax = process.env.CLAUDEX_KIRO_MAX_PAYLOAD_BYTES
    process.env.CLAUDEX_KIRO_TARGET_PAYLOAD_BYTES = '2200'
    process.env.CLAUDEX_KIRO_MAX_PAYLOAD_BYTES = '4000'

    try {
      const messages = [
        { role: 'user' as const, content: 'Initial question ' + 'X'.repeat(700) },
        { role: 'assistant' as const, content: 'Initial answer ' + 'Y'.repeat(500) },
        { role: 'user' as const, content: 'Follow-up one ' + 'Z'.repeat(700) },
        { role: 'assistant' as const, content: 'Follow-up answer ' + 'Q'.repeat(500) },
        { role: 'user' as const, content: 'Follow-up two ' + 'R'.repeat(700) },
      ]

      const payload = buildKiroPayload({
        model: 'deepseek-3.2',
        system: 'Project rules',
        messages,
        tools: [],
      })

      const size = checkKiroPayloadSize(payload)
      assert(size <= 4000, `expected payload to stay under hard cap, got ${size}`)
      assert(payload.conversationState.history.length < 4, `expected build-time trim to shrink history, got ${payload.conversationState.history.length}`)

      const firstHistory = payload.conversationState.history[0]
      assert(!!firstHistory && 'userInputMessage' in firstHistory, 'expected history to retain a user turn after trim')
      assert(firstHistory.userInputMessage.content.includes('Project rules'), 'expected system prompt to remain in preserved prefix after trim')
    } finally {
      if (previousTarget === undefined) delete process.env.CLAUDEX_KIRO_TARGET_PAYLOAD_BYTES
      else process.env.CLAUDEX_KIRO_TARGET_PAYLOAD_BYTES = previousTarget
      if (previousMax === undefined) delete process.env.CLAUDEX_KIRO_MAX_PAYLOAD_BYTES
      else process.env.CLAUDEX_KIRO_MAX_PAYLOAD_BYTES = previousMax
    }
  })

  test('sanitizes Kiro tool names to the Bedrock-allowed shape', () => {
    // Valid names (incl. hyphenated MCP names) pass through unchanged.
    assert(
      sanitizeKiroToolName('mcp__context7__resolve-library-id') === 'mcp__context7__resolve-library-id',
      'valid hyphenated MCP name must be unchanged',
    )
    // Out-of-set characters (dots, slashes, spaces) become underscores.
    assert(
      sanitizeKiroToolName('weird.tool name/v2') === 'weird_tool_name_v2',
      'invalid characters must collapse to underscore',
    )
    // Over-length names are capped to 64 and stay valid.
    const long = `mcp__server__${'x'.repeat(200)}`
    const capped = sanitizeKiroToolName(long)
    assert(capped.length <= 64, `expected <=64 chars, got ${capped.length}`)
    assert(/^[A-Za-z0-9_-]{1,64}$/.test(capped), 'capped name must still match the allowed pattern')
  })

  test('tool names round-trip through the Kiro reverse map', () => {
    const names = ['Read', 'Bash', 'mcp__context7__resolve-library-id', 'odd.name has spaces']
    const reverse = buildKiroToolNameReverseMap(names)
    for (const name of names) {
      const kiro = toKiroToolName(name)
      assert(/^[A-Za-z0-9_-]{1,64}$/.test(kiro), `outgoing name invalid for ${name}: ${kiro}`)
      assert(
        toClaudexToolName(kiro, null, reverse) === name,
        `expected round-trip ${name} -> ${kiro} -> ${name}`,
      )
    }
  })

  test('merges consecutive assistant turns so history alternates roles', () => {
    // An assistant tool-call immediately followed by an assistant text turn
    // would otherwise leave two adjacent assistant entries — Kiro 400s on that.
    const payload = buildKiroPayload({
      model: 'deepseek-3.2',
      system: '',
      tools: [],
      messages: [
        { role: 'user', content: 'start the app' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'assistant', content: 'done' },
      ],
    })

    const history = payload.conversationState.history
    const roleOf = (entry: (typeof history)[number]): string =>
      'userInputMessage' in entry ? 'user' : 'assistant'
    for (let i = 1; i < history.length; i++) {
      assert(
        roleOf(history[i]!) !== roleOf(history[i - 1]!),
        `history must strictly alternate roles (index ${i})`,
      )
    }
    const assistant = history.find(entry => 'assistantResponseMessage' in entry)
    assert(
      !!assistant && 'assistantResponseMessage' in assistant
        && (assistant.assistantResponseMessage.toolUses?.length ?? 0) === 1,
      'merged assistant turn must keep its tool call',
    )
  })

  test('classifies transient Kiro statuses for retry', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      assert(_isTransientKiroStatus(status), `status ${status} should be retried`)
    }
    for (const status of [200, 400, 401, 403, 404, 422]) {
      assert(!_isTransientKiroStatus(status), `status ${status} must not be retried`)
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
