/**
 * Build a CodeWhisperer `GenerateAssistantResponse` payload from
 * Anthropic-IR messages + tools.
 *
 * Wire format reference: reference/9router-master/open-sse/translator/
 *   request/openai-to-kiro.js. The shape:
 *
 *   conversationState:
 *     chatTriggerType: "MANUAL"
 *     conversationId:  uuid
 *     currentMessage:
 *       userInputMessage:
 *         content, modelId, origin: "AI_EDITOR"
 *         userInputMessageContext?: { tools?, toolResults? }
 *     history: [ { userInputMessage } | { assistantResponseMessage } ]
 *   profileArn?
 *   inferenceConfig?: { maxTokens, temperature, topP }
 *
 * History rules (the Kiro API rejects traffic that violates these):
 *   - Alternating user/assistant roles only.
 *   - Merge consecutive same-role messages.
 *   - Empty content is illegal — fall back to "continue" (user) / "..." (assistant).
 *   - `tools` only live inside `currentMessage.userInputMessageContext`.
 *   - Every historical `userInputMessage` needs `modelId` set.
 */

import { randomUUID } from 'crypto'
import type {
  ProviderMessage,
  ProviderTool,
  ProviderContentBlock,
} from '../../services/api/providers/base_provider.js'
import {
  appendStrictParamsHint,
  KIRO_TOOL_USAGE_RULES,
  sanitizeSchemaForLane,
} from '../shared/mcp_bridge.js'
import { normalizeKiroModelId } from './catalog.js'
import {
  isKiroShellCandidate,
  resolvePreferredKiroShellToolName,
  toKiroToolName,
} from './tool_names.js'
import {
  checkKiroPayloadSize,
  trimKiroPayloadToLimit,
} from './payload_guards.js'
import { WEB_SEARCH_NATIVE_DESCRIPTION } from '../../tools/WebSearchTool/prompt.js'

interface KiroToolSpec {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: Record<string, unknown> }
  }
}

interface KiroToolResult {
  toolUseId: string
  status: 'success'
  content: Array<{ text: string }>
}

interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

interface KiroUserMessage {
  userInputMessage: {
    content: string
    modelId: string
    origin?: string
    userInputMessageContext?: {
      tools?: KiroToolSpec[]
      toolResults?: KiroToolResult[]
    }
  }
}

interface KiroAssistantMessage {
  assistantResponseMessage: {
    content: string
    toolUses?: KiroToolUse[]
  }
}

type KiroHistoryEntry = KiroUserMessage | KiroAssistantMessage

export interface KiroPayload {
  conversationState: {
    chatTriggerType: 'MANUAL'
    conversationId: string
    currentMessage: KiroUserMessage
    history: KiroHistoryEntry[]
  }
  profileArn?: string
  inferenceConfig?: {
    maxTokens?: number
    temperature?: number
    topP?: number
  }
}

export interface BuildKiroPayloadParams {
  model: string
  system: string
  messages: ProviderMessage[]
  tools: ProviderTool[]
  conversationId?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  profileArn?: string
}

const KIRO_TOOL_DESCRIPTION_MAX_LENGTH = 10_000
const KIRO_DEFAULT_MAX_PAYLOAD_BYTES = 600_000
const KIRO_DEFAULT_TARGET_PAYLOAD_BYTES = 220_000

export function buildKiroPayload(params: BuildKiroPayloadParams): KiroPayload {
  const {
    model,
    system,
    messages,
    tools,
    conversationId,
    maxTokens,
    temperature,
    topP,
    profileArn,
  } = params
  const resolvedModel = normalizeKiroModelId(model)
  const preferredShellToolName = resolvePreferredKiroShellToolName(
    tools.map(tool => tool.name),
  )

  const { specs, toolDocumentation } = _buildToolSpecs(tools, preferredShellToolName)
  const systemWithRules = specs.length > 0
    ? _assembleKiroToolSystemPrompt(
        system,
        tools,
        preferredShellToolName,
        toolDocumentation,
      )
    : system
  const { history, currentMessage } = _convertMessages(messages, systemWithRules, specs, resolvedModel)

  // CodeWhisperer prepends the current wall-clock — 9router does the
  // same so models that rely on "current time" skills (scheduling,
  // file timestamps) see fresh context each turn.
  const stampedContent = `[Context: Current time is ${new Date().toISOString()}]\n\n${
    currentMessage.userInputMessage.content
  }`

  const payload: KiroPayload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: conversationId || randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: stampedContent,
          modelId: resolvedModel,
          origin: 'AI_EDITOR',
          ...(currentMessage.userInputMessage.userInputMessageContext && {
            userInputMessageContext: currentMessage.userInputMessage.userInputMessageContext,
          }),
        },
      },
      history,
    },
  }

  _optimizeKiroPayload(payload, systemWithRules)

  if (profileArn) payload.profileArn = profileArn
  if (maxTokens != null || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {}
    if (maxTokens != null) payload.inferenceConfig.maxTokens = maxTokens
    if (temperature !== undefined) payload.inferenceConfig.temperature = temperature
    if (topP !== undefined) payload.inferenceConfig.topP = topP
  }
  return payload
}

function _optimizeKiroPayload(
  payload: KiroPayload,
  systemText: string,
): void {
  if (payload.conversationState.history.length === 0) return

  const preserveLeadingEntries = systemText.trim().length > 0
    ? _getSystemBearingHistoryPrefixLength(payload.conversationState.history)
    : 0
  const targetBytes = _readKiroPayloadByteBudget(
    'CLAUDEX_KIRO_TARGET_PAYLOAD_BYTES',
    KIRO_DEFAULT_TARGET_PAYLOAD_BYTES,
  )
  const maxBytes = _readKiroPayloadByteBudget(
    'CLAUDEX_KIRO_MAX_PAYLOAD_BYTES',
    KIRO_DEFAULT_MAX_PAYLOAD_BYTES,
  )

  if (targetBytes > 0 && checkKiroPayloadSize(payload) > targetBytes) {
    trimKiroPayloadToLimit(payload, targetBytes, { preserveLeadingEntries })
  }

  const effectiveHardLimit = maxBytes > 0 ? maxBytes : KIRO_DEFAULT_MAX_PAYLOAD_BYTES
  if (checkKiroPayloadSize(payload) > effectiveHardLimit) {
    trimKiroPayloadToLimit(payload, effectiveHardLimit, { preserveLeadingEntries })
  }
}

function _readKiroPayloadByteBudget(
  envName: string,
  defaultValue: number,
): number {
  const raw = process.env[envName]
  if (!raw) return defaultValue
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue
}

function _getSystemBearingHistoryPrefixLength(
  history: KiroHistoryEntry[],
): number {
  const firstUserIndex = history.findIndex(entry => 'userInputMessage' in entry)
  if (firstUserIndex === -1) return 0
  const nextIndex = firstUserIndex + 1
  if (nextIndex < history.length && 'assistantResponseMessage' in history[nextIndex]!) {
    return nextIndex + 1
  }
  return firstUserIndex + 1
}

// ─── Tool specs ──────────────────────────────────────────────────

function _buildToolSpecs(
  tools: ProviderTool[],
  preferredShellToolName: string | null,
): {
  specs: KiroToolSpec[]
  toolDocumentation: string
} {
  const seen = new Set<string>()
  const specs: KiroToolSpec[] = []
  const documentationSections: string[] = []
  for (const t of tools) {
    const kiroName = toKiroToolName(t.name)
    if (
      kiroName === 'shell'
      && preferredShellToolName
      && isKiroShellCandidate(t.name)
      && t.name !== preferredShellToolName
    ) {
      continue
    }
    // Skip duplicates — e.g. Bash + PowerShell both map to 'shell'
    if (seen.has(kiroName)) continue
    seen.add(kiroName)
    const schema = sanitizeSchemaForLane(
      t.input_schema ?? { type: 'object', properties: {} },
      'kiro',
    )
    // Kiro 400s "Improperly formed request" on empty `required: []` and on
    // any `additionalProperties` keyword (per kiro-gateway reference). Both
    // are stripped recursively by sanitizeSchemaForLane for the kiro profile,
    // so do NOT add `required: []` back here.
    const normalized = Object.keys(schema).length === 0
      ? { type: 'object', properties: {} }
      : schema
    const baseDescription = _normalizeKiroToolDescription(
      t.name,
      kiroName,
      t.description,
    )
    const fullDescription = appendStrictParamsHint(
      baseDescription,
      normalized as Record<string, unknown>,
    )
    const { inlineDescription, documentationSection } = _compressKiroToolDescription(
      kiroName,
      fullDescription,
    )
    if (documentationSection) documentationSections.push(documentationSection)
    specs.push({
      toolSpecification: {
        name: kiroName,
        description: inlineDescription,
        inputSchema: { json: normalized as Record<string, unknown> },
      },
    })
  }
  return {
    specs,
    toolDocumentation: documentationSections.length > 0
      ? [
          '<tool_documentation>',
          'Some Kiro tool descriptions are too long to send inline. Read the referenced sections below when a tool points here.',
          ...documentationSections,
          '</tool_documentation>',
        ].join('\n')
      : '',
  }
}

function _assembleKiroToolSystemPrompt(
  system: string,
  tools: ProviderTool[],
  preferredShellToolName: string | null,
  toolDocumentation: string,
): string {
  const sections = [KIRO_TOOL_USAGE_RULES]
  const guide = _buildKiroToolSelectionGuide(tools, preferredShellToolName)
  if (guide) sections.push(guide)
  if (toolDocumentation) sections.push(toolDocumentation)
  if (system) sections.push(system)
  return sections.join('\n')
}

function _buildKiroToolSelectionGuide(
  tools: ProviderTool[],
  preferredShellToolName: string | null,
): string {
  const toolNames = new Set(tools.map(tool => tool.name))
  const lines: string[] = []

  const addCategory = (label: string, entries: string[]): void => {
    if (entries.length === 0) return
    lines.push(`- ${label}: ${entries.join(', ')}`)
  }

  const pick = (name: string, description: string): string | null =>
    toolNames.has(name) ? `${name} (${description})` : null

  const collect = (...entries: Array<string | null>): string[] =>
    entries.filter((entry): entry is string => typeof entry === 'string')

  addCategory('Files', collect(
    pick('Read', 'read files'),
    pick('Write', 'create or overwrite files'),
    pick('Edit', 'modify existing files in place'),
    pick('Glob', 'find files by pattern'),
    pick('Grep', 'search file contents'),
    pick('NotebookEdit', 'edit Jupyter notebook cells'),
  ))

  addCategory('Code', collect(
    pick('LSP', 'semantic code operations like definitions, references, and symbols'),
  ))

  const shellEntries: string[] = []
  if (preferredShellToolName && toolNames.has(preferredShellToolName)) {
    const shellDescription = preferredShellToolName === 'PowerShell'
      ? 'run Windows shell and git commands'
      : 'run shell and git commands'
    shellEntries.push(`${preferredShellToolName} (${shellDescription})`)
  } else {
    shellEntries.push(...collect(
      pick('Bash', 'run shell and git commands'),
      pick('PowerShell', 'run Windows shell and git commands'),
    ))
  }
  shellEntries.push(...collect(
    pick('TaskOutput', 'read background task output'),
    pick('TaskStop', 'stop a background task'),
  ))
  addCategory('Shell', shellEntries)

  addCategory('Planning', collect(
    pick('TodoWrite', 'manage the session checklist'),
    pick('TaskCreate', 'create a task'),
    pick('TaskGet', 'read a task'),
    pick('TaskList', 'list tasks'),
    pick('TaskUpdate', 'update a task'),
    pick('EnterPlanMode', 'switch into planning mode'),
    pick('ExitPlanMode', 'present a plan and exit planning mode'),
    pick('EnterWorktree', 'create and enter an isolated git worktree'),
    pick('ExitWorktree', 'leave the current worktree'),
  ))

  addCategory('Web', collect(
    pick('WebFetch', 'fetch web content'),
    pick('WebSearch', WEB_SEARCH_NATIVE_DESCRIPTION),
  ))

  addCategory('Interaction', collect(
    pick('AskUserQuestion', 'ask the user a clarifying question'),
    pick('Skill', 'invoke a slash-command skill'),
    pick('SendUserMessage', 'send a message back to the user'),
    pick('Config', 'read or change Tau settings'),
  ))

  addCategory('Agents', collect(
    pick('Agent', 'launch a subagent'),
    pick('SendMessage', 'message a running agent teammate'),
    pick('TeamCreate', 'create a multi-agent team'),
    pick('TeamDelete', 'disband a multi-agent team'),
  ))

  addCategory('MCP', collect(
    pick('ListMcpResourcesTool', 'list MCP resources'),
    pick('ReadMcpResourceTool', 'read a specific MCP resource'),
  ))

  const mcpServerTools = tools
    .map(tool => tool.name)
    .filter(name => name.startsWith('mcp__'))
  if (mcpServerTools.length > 0) {
    lines.push(`- MCP server tools: ${mcpServerTools.length} tool(s) named mcp__* are available; use the exact tool name shown in the tool list when you need one.`)
  }

  if (lines.length === 0) return ''

  return [
    '<tool_selection_guide>',
    'Prefer specialized tools over shell when a direct tool exists for files, notebooks, planning, worktrees, questions, skills, tasks, or MCP resources.',
    'For Agent/subagent results, report the tool output as observed; only describe rate limiting when the result explicitly says 429, rate limit, quota, or throttled.',
    ...lines,
    '</tool_selection_guide>',
  ].join('\n')
}

function _normalizeKiroToolDescription(
  claudexName: string,
  kiroName: string,
  description: string | undefined,
): string {
  const trimmed = description?.trim()
  let resolved = trimmed || `Tool: ${kiroName}`

  if (kiroName !== 'shell') return resolved

  if (claudexName === 'PowerShell') {
    return `${resolved}\nUse Windows PowerShell syntax for commands.`
  }

  if (claudexName === 'Bash') {
    return `${resolved}\nUse POSIX/bash syntax for commands. Do not use PowerShell cmdlets.`
  }

  return resolved
}

function _compressKiroToolDescription(
  toolName: string,
  description: string,
): {
  inlineDescription: string
  documentationSection: string
} {
  if (
    KIRO_TOOL_DESCRIPTION_MAX_LENGTH <= 0
    || description.length <= KIRO_TOOL_DESCRIPTION_MAX_LENGTH
  ) {
    return {
      inlineDescription: description,
      documentationSection: '',
    }
  }

  return {
    inlineDescription: `[Full documentation in system prompt under '## Tool: ${toolName}']`,
    documentationSection: `## Tool: ${toolName}\n\n${description}`,
  }
}

// ─── Message conversion ──────────────────────────────────────────

function _convertMessages(
  messages: ProviderMessage[],
  systemText: string,
  tools: KiroToolSpec[],
  model: string,
): { history: KiroHistoryEntry[]; currentMessage: KiroUserMessage } {
  const history: KiroHistoryEntry[] = []

  let currentRole: 'user' | 'assistant' | null = null
  let pendingUserText: string[] = []
  let pendingAssistantText: string[] = []
  let pendingToolResults: KiroToolResult[] = []

  const flush = (): void => {
    if (currentRole === 'user') {
      const content = pendingUserText.join('\n\n').trim() || 'continue'
      const msg: KiroUserMessage = {
        userInputMessage: { content, modelId: model },
      }
      if (pendingToolResults.length > 0) {
        msg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults,
        }
      }
      history.push(msg)
      pendingUserText = []
      pendingToolResults = []
    } else if (currentRole === 'assistant') {
      const content = pendingAssistantText.join('\n\n').trim() || '...'
      history.push({ assistantResponseMessage: { content } })
      pendingAssistantText = []
    }
  }

  // Kiro has no system role — 9router prepends the system prompt onto
  // the first user turn. Mirror that so CLAUDE.md / environment / git
  // status still reach the model. Sent once; subsequent user turns carry
  // only their own content.
  let systemInjected = !systemText

  for (const msg of messages) {
    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user'

    if (currentRole !== null && role !== currentRole) flush()
    currentRole = role

    if (role === 'user') {
      const { text, toolResults } = _extractUserBlocks(msg.content)
      let content = text
      if (!systemInjected) {
        content = content ? `${systemText}\n\n${content}` : systemText
        systemInjected = true
      }
      if (content) pendingUserText.push(content)
      pendingToolResults.push(...toolResults)
    } else {
      const { text, toolUses } = _extractAssistantBlocks(msg.content)
      if (text) pendingAssistantText.push(text)
      if (toolUses.length > 0) {
        flush()
        const last = history[history.length - 1]
        if (last && 'assistantResponseMessage' in last) {
          last.assistantResponseMessage.toolUses = toolUses
        } else {
          // Tool call with no preceding text — Kiro still wants an
          // assistant envelope to attach the toolUses to.
          history.push({ assistantResponseMessage: { content: '...', toolUses } })
        }
        currentRole = null
      }
    }
  }

  if (currentRole !== null) flush()

  // The Kiro envelope separates `currentMessage` (the prompt we're
  // sending this turn) from `history` (the preceding turns). Pop the
  // LAST user message off history and promote it. If the trailing turn
  // is an assistant tool-call (common: model just returned a tool call
  // and we are about to send tool_result back), inject a placeholder
  // "continue" user message so there's always a currentMessage.
  let currentMessage: KiroUserMessage | undefined
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if ('userInputMessage' in entry) {
      currentMessage = entry
      history.splice(i, 1)
      break
    }
  }
  if (!currentMessage) {
    currentMessage = {
      userInputMessage: { content: 'continue', modelId: model },
    }
  }

  // Clean up stale tool scaffolding from historical user messages —
  // only the currentMessage carries the active `tools` array.
  for (const entry of history) {
    if ('userInputMessage' in entry) {
      const ctx = entry.userInputMessage.userInputMessageContext
      if (ctx) {
        delete (ctx as { tools?: unknown }).tools
        if (Object.keys(ctx).length === 0) {
          delete entry.userInputMessage.userInputMessageContext
        }
      }
      if (!entry.userInputMessage.modelId) entry.userInputMessage.modelId = model
    }
  }

  // Merge consecutive SAME-role messages. Kiro requires strictly alternating
  // user/assistant roles and 400s ("Improperly formed request") otherwise.
  // currentMessage promotion (popping a middle user) or a fallback-reshaped
  // history can leave two user OR two assistant entries adjacent, so merge both
  // — preserving tool results / tool calls from the entry that gets folded in.
  const merged: KiroHistoryEntry[] = []
  for (const entry of history) {
    const last = merged[merged.length - 1]
    if (last && 'userInputMessage' in last && 'userInputMessage' in entry) {
      const a = last.userInputMessage
      const b = entry.userInputMessage
      a.content = [a.content, b.content].filter(Boolean).join('\n\n') || 'continue'
      const foldedResults = b.userInputMessageContext?.toolResults
      if (foldedResults && foldedResults.length > 0) {
        const ctx = (a.userInputMessageContext ??= {})
        ctx.toolResults = [...(ctx.toolResults ?? []), ...foldedResults]
      }
    } else if (
      last
      && 'assistantResponseMessage' in last
      && 'assistantResponseMessage' in entry
    ) {
      const a = last.assistantResponseMessage
      const b = entry.assistantResponseMessage
      a.content = [a.content, b.content].filter(c => c && c !== '...').join('\n\n') || '...'
      if (b.toolUses && b.toolUses.length > 0) {
        a.toolUses = [...(a.toolUses ?? []), ...b.toolUses]
      }
    } else {
      merged.push(entry)
    }
  }

  // Attach tools to the outgoing prompt (only ever on currentMessage).
  if (tools.length > 0) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {}
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = tools
  }

  return { history: merged, currentMessage }
}

function _extractUserBlocks(content: string | ProviderContentBlock[]): {
  text: string
  toolResults: KiroToolResult[]
} {
  if (typeof content === 'string') return { text: content, toolResults: [] }

  const texts: string[] = []
  const toolResults: KiroToolResult[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    } else if (block.type === 'tool_result' && block.tool_use_id) {
      toolResults.push({
        toolUseId: block.tool_use_id,
        status: 'success',
        content: [{ text: _stringifyToolResultContent(block.content) }],
      })
    }
    // Images: Kiro supports base64 via a separate `images` field on
    // userInputMessage, but the claudex tool stack never emits image
    // blocks in provider messages (screenshots go through the Read
    // tool), so we intentionally skip them.
  }
  return { text: texts.join('\n'), toolResults }
}

function _extractAssistantBlocks(content: string | ProviderContentBlock[]): {
  text: string
  toolUses: KiroToolUse[]
} {
  if (typeof content === 'string') return { text: content, toolUses: [] }

  const texts: string[] = []
  const toolUses: KiroToolUse[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    } else if (block.type === 'tool_use' && block.id && block.name) {
      toolUses.push({
        toolUseId: block.id,
        name: toKiroToolName(block.name),
        input: (block.input ?? {}) as Record<string, unknown>,
      })
    }
    // thinking blocks: Kiro has no reasoning channel we can round-trip —
    // the model emits reasoningContentEvent but won't accept it back.
    // Dropping on re-submission keeps the history legal.
  }
  return { text: texts.join('\n').trim(), toolUses }
}

function _stringifyToolResultContent(
  content: string | ProviderContentBlock[] | undefined,
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (typeof block === 'object' && block) {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n')
}
