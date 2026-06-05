import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { arch, platform } from 'node:os'
import {
  buildProviderStreamResult,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicStreamEvent,
  type ModelInfo,
  type ProviderConfig,
  type ProviderContentBlock,
  type ProviderMessage,
  type ProviderRequestParams,
  type ProviderStreamResult,
  type ProviderTool,
  type SystemBlock,
} from './base_provider.js'
import { OpenAIProvider } from './openai_provider.js'
import { getProviderModelSet } from '../../../utils/model/configs.js'
import {
  commandCodeAnthropicBudgetForEffort,
  getCommandCodeModelDisplayName,
  getCommandCodeRequestEffort,
  inferCommandCodeUpstreamProvider,
  isCommandCodeClaudeModel,
  supportsCommandCodeEffortSelection,
} from '../../../utils/model/commandCodeThinking.js'
import type { OpenAIReasoningLevel } from '../../../utils/model/openaiReasoning.js'
import { getSessionId } from '../../../bootstrap/state.js'

const COMMAND_CODE_API_BASE_URL = 'https://api.commandcode.ai'
const COMMAND_CODE_PROVIDER_BASE_URL = `${COMMAND_CODE_API_BASE_URL}/provider/v1`
const COMMAND_CODE_ALPHA_GENERATE_PATH = '/alpha/generate'
const COMMAND_CODE_CLI_VERSION = process.env.COMMAND_CODE_CLI_VERSION ?? '0.32.2'
const COMMAND_CODE_CACHE_CONTROL = { type: 'ephemeral' } as const
const commandCodeEnvironmentContextBySession = new Map<string, Record<string, unknown>>()
let fallbackCommandCodeAlphaSessionId: string | null = null

const COMMAND_CODE_NATIVE_MODEL_IDS = [
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.5',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.7-Plus',
  'Qwen/Qwen3.7-Max-Free',
  'MiniMaxAI/MiniMax-M3',
  'MiniMaxAI/MiniMax-M2.7',
  'MiniMaxAI/MiniMax-M2.5',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'zai-org/GLM-5.1',
  'zai-org/GLM-5',
] as const

const COMMAND_CODE_FALLBACK_MODEL_IDS = [
  ...COMMAND_CODE_NATIVE_MODEL_IDS,
  'gpt-5.3-codex',
  'gpt-5.4-mini',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5',
] as const

type RawCommandCodeModel = Record<string, unknown>
type CommandCodeAlphaEvent = Record<string, unknown>

export class CommandCodeProvider extends OpenAIProvider {
  readonly name = 'commandcode'
  private readonly alphaBaseUrl: string

  constructor(config: ProviderConfig) {
    const providerBaseUrl = normalizeCommandCodeBaseUrl(config.baseUrl)
    super({
      ...config,
      baseUrl: providerBaseUrl,
    })
    this.preserveCacheControl = true
    this.alphaBaseUrl = normalizeCommandCodeAlphaBaseUrl(
      process.env.COMMANDCODE_API_URL
      ?? process.env.COMMANDCODE_ALPHA_BASE_URL
      ?? process.env.COMMAND_CODE_ALPHA_BASE_URL
      ?? providerBaseUrl,
    )
  }

  protected resolveReasoningEffort(
    model: string,
    _thinking: ProviderRequestParams['thinking'],
  ): OpenAIReasoningLevel | undefined {
    const effort = getCommandCodeRequestEffort(model)
    if (!effort || effort === 'max') return undefined
    return effort
  }

  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const model = this.resolveModel(params.model)
    if (isCommandCodeClaudeModel(model)) {
      return this._streamAnthropicMessages(params, model)
    }
    if (isCommandCodeNativeAlphaModel(model)) {
      return this._streamAlphaGenerate({ ...params, model }, model)
    }
    return super.stream(params)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    const model = this.resolveModel(params.model)
    if (isCommandCodeClaudeModel(model)) {
      return this._createAnthropicMessage(params, model)
    }
    if (isCommandCodeNativeAlphaModel(model)) {
      return this._createAlphaGenerate({ ...params, model }, model)
    }
    return super.create(params)
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) {
        const data = await response.json()
        const rawModels = extractModelRows(data)
        const models = rawModels
          .map(toCommandCodeModelInfo)
          .filter((model): model is ModelInfo => model !== null)
        if (models.length > 0) return mergeCommandCodeModels(models)
      }
    } catch {
      // Use the fallback catalog if the live list is unreachable.
    }

    return fallbackModels()
  }

  resolveModel(model: string): string {
    const raw = model.trim()
    if (!raw.toLowerCase().includes('claude')) return raw

    const leaf = raw.split('/').pop() ?? raw
    if (/^claude-[a-z0-9-]+-\d/i.test(leaf)) {
      return leaf
    }

    const models = getProviderModelSet(this.name)
    const lower = raw.toLowerCase()
    if (lower.includes('opus')) return models.opus
    if (lower.includes('haiku')) return models.haiku
    return models.sonnet
  }

  protected formatAPIError(status: number, body: string): Error {
    const detail = extractErrorDetail(body)
    if (status === 403 && /upgrade_required|pro plan|pro or higher/i.test(detail)) {
      return new Error(
        'Command Code API error: this endpoint requires a higher Command Code plan.\n'
        + `${detail || 'Switch to a Go-plan model from /models, or upgrade your Command Code plan.'}`,
      )
    }
    if (status === 400 && /wrong endpoint|\/messages|chat\/completions|unsupported_model/i.test(detail)) {
      return new Error(
        'Command Code API error: the selected model must use the matching Command Code endpoint.\n'
        + `${detail || 'Claude models use /provider/v1/messages; GPT models use /provider/v1/chat/completions; Command Code pool models use /alpha/generate.'}`,
      )
    }
    return super.formatAPIError(status, body)
  }

  private async _streamAlphaGenerate(
    params: ProviderRequestParams,
    model: string,
  ): Promise<ProviderStreamResult> {
    const ac = new AbortController()
    const alphaSessionId = commandCodeAlphaSessionId()
    const response = await fetch(this._alphaGenerateUrl(), {
      method: 'POST',
      headers: this._alphaHeaders(alphaSessionId),
      body: JSON.stringify(this._alphaBody(params, model, alphaSessionId)),
      signal: ac.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
    }

    if (!response.body) {
      throw new Error('Command Code returned no response body for alpha streaming request')
    }

    this._extractRateLimits(response.headers)
    return buildProviderStreamResult(this._parseAlphaGenerateStream(response.body, model), ac)
  }

  private async _createAlphaGenerate(
    params: ProviderRequestParams,
    model: string,
  ): Promise<AnthropicMessage> {
    const alphaSessionId = commandCodeAlphaSessionId()
    const response = await fetch(this._alphaGenerateUrl(), {
      method: 'POST',
      headers: this._alphaHeaders(alphaSessionId),
      body: JSON.stringify(this._alphaBody(params, model, alphaSessionId)),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
    }

    if (!response.body) {
      throw new Error('Command Code returned no response body for alpha request')
    }

    this._extractRateLimits(response.headers)
    return collectAlphaMessage(this._parseAlphaGenerateStream(response.body, model), model)
  }

  private _alphaGenerateUrl(): string {
    return `${this.alphaBaseUrl}${COMMAND_CODE_ALPHA_GENERATE_PATH}`
  }

  private _alphaHeaders(alphaSessionId: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'x-cli-environment': 'production',
      'x-command-code-version': COMMAND_CODE_CLI_VERSION,
      'x-co-flag': 'false',
      'x-project-slug': commandCodeProjectSlug(),
      'x-session-id': alphaSessionId,
      'x-taste-learning': 'false',
      ...this.extraHeaders,
    }
  }

  private _alphaBody(
    params: ProviderRequestParams,
    model: string,
    alphaSessionId: string,
  ): Record<string, unknown> {
    const requestParams: Record<string, unknown> = {
      stream: true,
      messages: toCommandCodeAlphaMessages(params.messages),
      max_tokens: params.max_tokens,
      model,
    }

    const system = commandCodeSystemToText(params.system)
    if (system) requestParams.system = system
    if (params.temperature !== undefined) requestParams.temperature = params.temperature
    if (params.stop_sequences && params.stop_sequences.length > 0) {
      requestParams.stop_sequences = params.stop_sequences
    }
    if (params.tools && params.tools.length > 0) {
      requestParams.tools = toCommandCodeAlphaTools(params.tools)
    }

    const effort = getCommandCodeRequestEffort(model)
    if (effort) requestParams.reasoning_effort = effort

    return {
      mode: 'custom-agent',
      config: getCommandCodeEnvironmentContext(alphaSessionId),
      memory: '',
      threadId: alphaSessionId,
      params: requestParams,
    }
  }

  private async *_parseAlphaGenerateStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): AsyncGenerator<AnthropicStreamEvent> {
    const message = emptyAlphaMessage(model)
    let blockIndex = 0
    let currentBlock: AnthropicContentBlock | null = null
    let currentKind: 'text' | 'thinking' | null = null

    yield { type: 'message_start', message }

    const closeBlock = async function* (): AsyncGenerator<AnthropicStreamEvent> {
      if (!currentKind) return
      yield { type: 'content_block_stop', index: blockIndex }
      blockIndex += 1
      currentBlock = null
      currentKind = null
    }

    for await (const event of readCommandCodeAlphaEvents(body)) {
      const type = firstString(event.type, event.event)
      if (!type) continue

      if (type === 'error') {
        throw new Error(`Command Code API stream error: ${commandCodeAlphaErrorDetail(event)}`)
      }

      if (type === 'text-delta' || type === 'text_delta' || type === 'output_text_delta') {
        const text = firstText(event.text, event.delta, event.content)
        if (!text) continue
        if (currentKind === 'thinking') {
          for await (const stop of closeBlock()) yield stop
        }
        if (currentKind !== 'text') {
          currentBlock = { type: 'text', text: '' }
          message.content.push(currentBlock)
          currentKind = 'text'
          yield { type: 'content_block_start', index: blockIndex, content_block: { ...currentBlock } }
        }
        currentBlock!.text = (currentBlock!.text ?? '') + text
        yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text } }
        continue
      }

      if (type === 'reasoning-start' || type === 'reasoning_start') {
        if (currentKind === 'text') {
          for await (const stop of closeBlock()) yield stop
        }
        if (currentKind !== 'thinking') {
          currentBlock = { type: 'thinking', thinking: '' }
          message.content.push(currentBlock)
          currentKind = 'thinking'
          yield { type: 'content_block_start', index: blockIndex, content_block: { ...currentBlock } }
        }
        continue
      }

      if (type === 'reasoning-delta' || type === 'reasoning_delta') {
        const thinking = firstText(event.text, event.thinking, event.delta, event.content)
        if (!thinking) continue
        if (currentKind === 'text') {
          for await (const stop of closeBlock()) yield stop
        }
        if (currentKind !== 'thinking') {
          currentBlock = { type: 'thinking', thinking: '' }
          message.content.push(currentBlock)
          currentKind = 'thinking'
          yield { type: 'content_block_start', index: blockIndex, content_block: { ...currentBlock } }
        }
        currentBlock!.thinking = (currentBlock!.thinking ?? '') + thinking
        yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking } }
        continue
      }

      if (type === 'reasoning-end' || type === 'reasoning_end') {
        if (currentKind === 'thinking') {
          for await (const stop of closeBlock()) yield stop
        }
        continue
      }

      if (type === 'tool-call' || type === 'tool_call') {
        for await (const stop of closeBlock()) yield stop
        const id = firstString(event.toolCallId, event.tool_call_id, event.id) ?? `toolu_${randomUUID()}`
        const name = firstString(event.toolName, event.tool_name, event.name) ?? 'tool'
        const input = alphaToolInput(event)
        const block: AnthropicContentBlock = { type: 'tool_use', id, name, input }
        message.content.push(block)
        yield { type: 'content_block_start', index: blockIndex, content_block: { ...block, input: {} } }
        yield {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        }
        yield { type: 'content_block_stop', index: blockIndex }
        blockIndex += 1
        continue
      }

      if (type === 'tool-result' || type === 'tool_result') {
        if (event.providerExecuted === true) {
          const text = toolResultToText(firstDefined(event.output, event.result))
          if (text) {
            if (currentKind === 'thinking') {
              for await (const stop of closeBlock()) yield stop
            }
            if (currentKind !== 'text') {
              currentBlock = { type: 'text', text: '' }
              message.content.push(currentBlock)
              currentKind = 'text'
              yield { type: 'content_block_start', index: blockIndex, content_block: { ...currentBlock } }
            }
            currentBlock!.text = (currentBlock!.text ?? '') + text
            yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text } }
          }
        }
        continue
      }

      if (type === 'finish' || type === 'done' || type === 'message_stop') {
        for await (const stop of closeBlock()) yield stop
        const stopReason = alphaStopReason(firstString(event.finishReason, event.finish_reason, event.rawFinishReason))
        message.stop_reason = stopReason
        applyAlphaUsage(message, alphaUsageFromEvent(event))
        yield {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            output_tokens: message.usage.output_tokens,
            input_tokens: message.usage.input_tokens,
            ...(message.usage.cache_read_input_tokens
              ? { cache_read_input_tokens: message.usage.cache_read_input_tokens }
              : {}),
            ...(message.usage.cache_creation_input_tokens
              ? { cache_creation_input_tokens: message.usage.cache_creation_input_tokens }
              : {}),
          },
        }
        yield { type: 'message_stop' }
        return
      }
    }

    for await (const stop of closeBlock()) yield stop
    message.stop_reason = 'end_turn'
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        output_tokens: message.usage.output_tokens,
        input_tokens: message.usage.input_tokens,
      },
    }
    yield { type: 'message_stop' }
  }

  private async _streamAnthropicMessages(
    params: ProviderRequestParams,
    model: string,
  ): Promise<ProviderStreamResult> {
    const body = this._anthropicBody(params, model, true)
    const ac = new AbortController()
    const response = await fetch(this._messagesUrl(), {
      method: 'POST',
      headers: this._anthropicHeaders(),
      body: JSON.stringify(body),
      signal: ac.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
    }

    if (!response.body) {
      throw new Error('Command Code returned no response body for streaming request')
    }

    this._extractRateLimits(response.headers)
    return buildProviderStreamResult(this._parseAnthropicSSE(response.body), ac)
  }

  private async _createAnthropicMessage(
    params: ProviderRequestParams,
    model: string,
  ): Promise<AnthropicMessage> {
    const response = await fetch(this._messagesUrl(), {
      method: 'POST',
      headers: this._anthropicHeaders(),
      body: JSON.stringify(this._anthropicBody(params, model, false)),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
    }

    this._extractRateLimits(response.headers)
    return await response.json() as AnthropicMessage
  }

  private _messagesUrl(): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/messages`
  }

  private _anthropicHeaders(): Record<string, string> {
    return {
      ...this._headers(),
      'anthropic-version': '2023-06-01',
    }
  }

  private _anthropicBody(
    params: ProviderRequestParams,
    model: string,
    stream: boolean,
  ): Record<string, unknown> {
    const effort = getCommandCodeRequestEffort(model)
    const body: Record<string, unknown> = {
      model,
      max_tokens: params.max_tokens,
      messages: params.messages,
    }

    if (stream) body.stream = true
    if (params.system) body.system = params.system
    if (params.tools && params.tools.length > 0) body.tools = params.tools
    if (params.stop_sequences) body.stop_sequences = params.stop_sequences

    if (effort) {
      const budget = commandCodeAnthropicBudgetForEffort(effort)
      const maxTokens = Math.max(params.max_tokens, budget + 1)
      body.max_tokens = maxTokens
      body.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(budget, maxTokens - 1),
      }
    } else if (params.temperature !== undefined) {
      body.temperature = params.temperature
    }

    return body
  }

  private async *_parseAnthropicSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<AnthropicStreamEvent> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = this._parseAnthropicSSEEvent(event)
          if (parsed) yield parsed
        }
      }

      if (buffer.trim()) {
        const parsed = this._parseAnthropicSSEEvent(buffer)
        if (parsed) yield parsed
      }
    } finally {
      reader.releaseLock()
    }
  }

  private _parseAnthropicSSEEvent(event: string): AnthropicStreamEvent | null {
    const data: string[] = []
    for (const rawLine of event.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      if (line.startsWith('data:')) {
        data.push(line.slice(5).trimStart())
      }
    }

    const json = data.join('\n').trim()
    if (!json || json === '[DONE]') return null

    try {
      const parsed = JSON.parse(json) as AnthropicStreamEvent & {
        error?: { message?: string; type?: string }
      }
      if (parsed.type === 'error') {
        const detail = parsed.error?.message ?? parsed.error?.type ?? json
        throw new Error(`Command Code API stream error: ${detail}`)
      }
      return parsed
    } catch (error) {
      if (error instanceof Error && error.message.includes('Command Code API stream error')) {
        throw error
      }
      return null
    }
  }
}

function normalizeCommandCodeBaseUrl(raw?: string): string {
  const base = (raw || COMMAND_CODE_PROVIDER_BASE_URL).replace(/\/+$/, '')
  if (/\/provider\/v1$/i.test(base)) return base
  if (/\/provider$/i.test(base)) return `${base}/v1`
  if (/\/v1$/i.test(base)) return `${base.replace(/\/v1$/i, '')}/provider/v1`
  return `${base}/provider/v1`
}

function normalizeCommandCodeAlphaBaseUrl(raw?: string): string {
  const base = (raw || COMMAND_CODE_API_BASE_URL).replace(/\/+$/, '')
  return base
    .replace(/\/provider\/v1$/i, '')
    .replace(/\/provider$/i, '')
    .replace(/\/v1$/i, '')
}

function isCommandCodeNativeAlphaModel(model: string): boolean {
  return !isCommandCodeClaudeModel(model) && !isCommandCodeOpenAIModel(model)
}

function isCommandCodeOpenAIModel(model: string): boolean {
  const normalized = comparableCommandCodeModel(model)
  const leaf = normalized.split('/').pop() ?? normalized
  return (
    leaf.startsWith('gpt-')
    || leaf.startsWith('o1')
    || leaf.startsWith('o3')
    || leaf.startsWith('o4')
    || leaf.includes('codex')
  )
}

function comparableCommandCodeModel(model: string): string {
  return model.trim().toLowerCase().replace(/[._]/g, '-')
}

function extractModelRows(data: unknown): RawCommandCodeModel[] {
  if (Array.isArray(data)) return data.filter(isRecord)
  if (!isRecord(data)) return []
  const rows = data.data ?? data.models
  return Array.isArray(rows) ? rows.filter(isRecord) : []
}

function toCommandCodeModelInfo(raw: RawCommandCodeModel): ModelInfo | null {
  const id = firstString(raw.id, raw.model, raw.name)
  if (!id) return null
  const name =
    firstString(raw.display_name, raw.displayName, raw.label)
    ?? getCommandCodeModelDisplayName(id)
    ?? firstString(raw.name)
    ?? id
  const contextWindow = firstNumber(
    raw.context_window,
    raw.contextWindow,
    raw.context_length,
    raw.contextLength,
    raw.max_context_length,
  )
  return {
    id,
    name,
    provider: firstString(raw.provider, raw.owned_by, raw.owner)
      ?? inferCommandCodeUpstreamProvider(id),
    ...(contextWindow ? { contextWindow } : {}),
    supportsToolCalling: firstBoolean(
      raw.supports_tool_calling,
      raw.supportsToolCalling,
      raw.tool_calling,
    ) ?? true,
    tags: commandCodeTagsForModel(id),
  }
}

function commandCodeTagsForModel(id: string): readonly string[] {
  const tags = new Set<string>()
  const lower = id.toLowerCase()
  if (supportsCommandCodeEffortSelection(id)) tags.add('reasoning')
  if (lower.includes('mini') || lower.includes('haiku') || lower.includes('flash')) {
    tags.add('fast')
  }
  if (
    lower === 'gpt-5.3-codex'
    || lower.includes('sonnet-4-6')
    || lower.includes('kimi-k2.6')
    || lower.includes('qwen3.7-plus')
    || lower.includes('minimax-m3')
  ) {
    tags.add('recommended')
  }
  return Array.from(tags)
}

function mergeCommandCodeModels(apiModels: readonly ModelInfo[]): ModelInfo[] {
  const merged = new Map<string, ModelInfo>()
  for (const model of fallbackModels()) merged.set(model.id, model)
  for (const model of apiModels) merged.set(model.id, model)
  return Array.from(merged.values())
}

function fallbackModels(): ModelInfo[] {
  return COMMAND_CODE_FALLBACK_MODEL_IDS.map(id => ({
    id,
    name: getCommandCodeModelDisplayName(id) ?? id,
    provider: inferCommandCodeUpstreamProvider(id),
    supportsToolCalling: true,
    tags: commandCodeTagsForModel(id),
  }))
}

function toCommandCodeAlphaTools(tools: readonly ProviderTool[]): Array<Record<string, unknown>> {
  const result = tools.map(tool => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.input_schema,
    ...((tool as { cache_control?: unknown }).cache_control
      ? { cache_control: (tool as { cache_control?: unknown }).cache_control }
      : {}),
  }))

  if (result.length > 0 && !result.some(hasCommandCodeCacheControl)) {
    result[result.length - 1] = {
      ...result[result.length - 1]!,
      cache_control: COMMAND_CODE_CACHE_CONTROL,
    }
  }

  return result
}

function toCommandCodeAlphaMessages(messages: readonly ProviderMessage[]): Array<Record<string, unknown>> {
  const toolNames = commandCodeToolNameById(messages)
  const result: Array<Record<string, unknown>> = []

  for (const message of messages) {
    if (typeof message.content === 'string') {
      result.push({ role: message.role, content: message.content })
      continue
    }

    const toolResults = message.content
      .filter(block => block.type === 'tool_result')
      .map(block => toCommandCodeAlphaToolResultBlock(block, toolNames))
      .filter((block): block is Record<string, unknown> => block !== null)
    const otherBlocks = message.content
      .filter(block => block.type !== 'tool_result')
      .map(block => toCommandCodeAlphaContentBlock(block))
      .filter((block): block is Record<string, unknown> => block !== null)

    if (message.role === 'assistant') {
      if (otherBlocks.length > 0) {
        result.push({ role: 'assistant', content: otherBlocks })
      }
      if (toolResults.length > 0) {
        result.push({ role: 'tool', content: toolResults })
      }
      continue
    }

    if (toolResults.length > 0) {
      result.push({ role: 'tool', content: toolResults })
    }
    if (otherBlocks.length > 0) {
      result.push({ role: 'user', content: otherBlocks })
    }
  }

  return ensureCommandCodeMessageCacheControl(result)
}

function ensureCommandCodeMessageCacheControl(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (messages.some(messageHasCommandCodeContentCacheControl)) return messages

  const userIndexes = messages
    .map((message, index) => message.role === 'user' && message.content ? index : -1)
    .filter(index => index >= 0)
  if (userIndexes.length < 2) return messages

  const target = messages[userIndexes[userIndexes.length - 2]!]
  if (!target) return messages

  const content = target.content
  if (typeof content === 'string') {
    target.content = [{
      type: 'text',
      text: content,
      cache_control: COMMAND_CODE_CACHE_CONTROL,
    }]
    return messages
  }

  if (!Array.isArray(content)) return messages
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index]
    if (!isRecord(block)) continue
    content[index] = {
      ...block,
      cache_control: COMMAND_CODE_CACHE_CONTROL,
    }
    break
  }

  return messages
}

function messageHasCommandCodeContentCacheControl(message: Record<string, unknown>): boolean {
  const content = message.content
  return Array.isArray(content) && content.some(hasCommandCodeCacheControl)
}

function hasCommandCodeCacheControl(value: unknown): boolean {
  return isRecord(value) && value.cache_control !== undefined
}

function toCommandCodeAlphaContentBlock(block: ProviderContentBlock): Record<string, unknown> | null {
  const cacheControl = (block as { cache_control?: unknown }).cache_control
  const withCache = (value: Record<string, unknown>): Record<string, unknown> => (
    cacheControl ? { ...value, cache_control: cacheControl } : value
  )

  switch (block.type) {
    case 'text':
      return withCache({ type: 'text', text: block.text ?? '' })
    case 'thinking':
      return null
    case 'redacted_thinking':
      return null
    case 'tool_use':
      return withCache({
        type: 'tool-call',
        toolCallId: block.id ?? `toolu_${randomUUID()}`,
        toolName: block.name ?? 'tool',
        input: block.input ?? {},
      })
    case 'tool_result':
      return null
    case 'image':
      return withCache({
        type: 'image',
        source: block.source,
      })
  }
}

function commandCodeToolNameById(messages: readonly ProviderMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        names.set(block.id, block.name)
      }
    }
  }
  return names
}

function toCommandCodeAlphaToolResultBlock(
  block: ProviderContentBlock,
  toolNames: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  if (block.type !== 'tool_result') return null
  const toolCallId = block.tool_use_id ?? ''
  return {
    type: 'tool-result',
    toolCallId,
    ...(toolNames.get(toolCallId) ? { toolName: toolNames.get(toolCallId) } : {}),
    output: {
      type: block.is_error ? 'error-text' : 'text',
      value: toolResultToText(block.content),
    },
  }
}

function commandCodeSystemToText(system?: string | SystemBlock[]): string | undefined {
  if (!system) return undefined
  const text = typeof system === 'string'
    ? system
    : system.map(block => block.text).join('\n\n')
  return text.trim() ? text : undefined
}

function commandCodeProjectSlug(): string {
  const cwd = process.cwd().replace(/\\/g, '/').replace(/\/+$/, '')
  const leaf = cwd.split('/').pop()
  return leaf?.trim() || 'tau'
}

function commandCodeAlphaSessionId(): string {
  try {
    const sessionId = getSessionId()
    if (typeof sessionId === 'string' && sessionId.trim()) return sessionId
  } catch {
    // Fall back below when bootstrap state is unavailable in isolated tests.
  }

  fallbackCommandCodeAlphaSessionId ??= randomUUID()
  return fallbackCommandCodeAlphaSessionId
}

function getCommandCodeEnvironmentContext(sessionId: string): Record<string, unknown> {
  const existing = commandCodeEnvironmentContextBySession.get(sessionId)
  if (existing) return existing

  const context = buildCommandCodeEnvironmentContext()
  commandCodeEnvironmentContextBySession.set(sessionId, context)
  return context
}

function buildCommandCodeEnvironmentContext(): Record<string, unknown> {
  const workingDir = process.cwd()
  const isGitRepo = commandCodeIsGitRepository(workingDir)
  return {
    workingDir,
    date: new Date().toISOString().split('T')[0] ?? '',
    environment: `${platform()}-${arch()}, Node.js ${process.version}`,
    structure: commandCodeDirectoryStructure(workingDir),
    isGitRepo,
    currentBranch: isGitRepo ? commandCodeGitOutput(workingDir, ['branch', '--show-current']) : '',
    mainBranch: isGitRepo ? commandCodeMainBranch(workingDir) : '',
    gitStatus: isGitRepo ? commandCodeGitStatus(workingDir) : '',
    recentCommits: isGitRepo ? commandCodeRecentCommits(workingDir) : [],
  }
}

function commandCodeDirectoryStructure(workingDir: string): string[] {
  const ignored = new Set([
    'node_modules',
    'dist',
    'build',
    '.git',
    '.svn',
    '.hg',
    'coverage',
    '.nyc_output',
    '.cache',
    'tmp',
    'temp',
    '.next',
    '.nuxt',
    'out',
  ])
  try {
    return readdirSync(workingDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .filter(entry => !entry.name.startsWith('.'))
      .filter(entry => !ignored.has(entry.name))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function commandCodeIsGitRepository(workingDir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: workingDir,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function commandCodeMainBranch(workingDir: string): string {
  const branches = commandCodeGitOutput(workingDir, ['branch', '-r'])
  if (branches.includes('origin/main')) return 'main'
  if (branches.includes('origin/master')) return 'master'
  return branches ? 'main' : ''
}

function commandCodeGitStatus(workingDir: string): string {
  const status = commandCodeGitOutput(workingDir, ['status', '--porcelain'])
  if (!status) return 'Working tree clean'

  const lines = status.split('\n')
  const modified = lines.filter(line => line.startsWith(' M')).length
  const added = lines.filter(line => line.startsWith('A ')).length
  const deleted = lines.filter(line => line.startsWith(' D')).length
  const untracked = lines.filter(line => line.startsWith('??')).length
  const summary: string[] = []
  if (modified > 0) summary.push(`M ${modified}`)
  if (added > 0) summary.push(`A ${added}`)
  if (deleted > 0) summary.push(`D ${deleted}`)
  if (untracked > 0) summary.push(`?? ${untracked}`)
  return summary.join(', ') || status
}

function commandCodeRecentCommits(workingDir: string): string[] {
  const commits = commandCodeGitOutput(workingDir, ['log', '--oneline', '-3'])
  return commits ? commits.split('\n') : []
}

function commandCodeGitOutput(workingDir: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

async function* readCommandCodeAlphaEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<CommandCodeAlphaEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        const parsed = parseCommandCodeAlphaLine(line)
        if (parsed) yield parsed
      }
    }

    if (buffer.trim()) {
      const parsed = parseCommandCodeAlphaLine(buffer)
      if (parsed) yield parsed
    }
  } finally {
    reader.releaseLock()
  }
}

function parseCommandCodeAlphaLine(line: string): CommandCodeAlphaEvent | null {
  let json = line.trim()
  if (!json) return null
  if (json.startsWith('data:')) json = json.slice(5).trim()
  if (!json || json === '[DONE]') return null
  try {
    const parsed = JSON.parse(json) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function collectAlphaMessage(
  events: AsyncIterable<AnthropicStreamEvent>,
  model: string,
): Promise<AnthropicMessage> {
  let message: AnthropicMessage | null = null
  for await (const event of events) {
    if (event.type === 'message_start' && event.message) {
      message = event.message
    }
  }
  return message ?? emptyAlphaMessage(model)
}

function emptyAlphaMessage(model: string): AnthropicMessage {
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content: [],
    model,
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  }
}

function alphaStopReason(value: string | null): AnthropicMessage['stop_reason'] {
  const reason = value?.toLowerCase() ?? ''
  if (reason.includes('tool')) return 'tool_use'
  if (reason.includes('length') || reason.includes('max')) return 'max_tokens'
  return 'end_turn'
}

function alphaUsageFromEvent(event: CommandCodeAlphaEvent): unknown {
  return firstDefined(event.totalUsage, event.total_usage, event.usage)
}

function applyAlphaUsage(message: AnthropicMessage, usage: unknown): void {
  if (!isRecord(usage)) return
  const input = firstNumber(usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens)
  const output = firstNumber(usage.outputTokens, usage.output_tokens, usage.completionTokens, usage.completion_tokens)
  if (output !== null) message.usage.output_tokens = output

  const details = firstRecord(
    usage.inputTokenDetails,
    usage.input_token_details,
    usage.promptTokensDetails,
    usage.prompt_tokens_details,
  )
  const cacheRead = firstNumber(
    details?.cacheReadTokens,
    details?.cacheReadInputTokens,
    details?.cacheHitTokens,
    details?.cache_read_tokens,
    details?.cache_read_input_tokens,
    details?.cache_hit_tokens,
    details?.cachedTokens,
    details?.cached_tokens,
    usage.cacheReadTokens,
    usage.cacheReadInputTokens,
    usage.cacheHitTokens,
    usage.cacheHitInputTokens,
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.cache_hit_tokens,
    usage.cache_hit_input_tokens,
    usage.cachedInputTokens,
    usage.cachedTokens,
    usage.cached_input_tokens,
    usage.cached_tokens,
  )
  const cacheWrite = firstNumber(
    details?.cacheWriteTokens,
    details?.cacheWriteInputTokens,
    details?.cacheCreationTokens,
    details?.cache_write_tokens,
    details?.cache_write_input_tokens,
    details?.cache_creation_tokens,
    details?.cacheCreationInputTokens,
    details?.cache_creation_input_tokens,
    usage.cacheWriteTokens,
    usage.cacheWriteInputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheCreationTokens,
    usage.cache_write_tokens,
    usage.cache_write_input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_creation_tokens,
  )

  if (input !== null) {
    const noCacheInput = firstNumber(
      details?.noCacheTokens,
      details?.no_cache_tokens,
      details?.uncachedTokens,
      details?.uncached_tokens,
      usage.noCacheTokens,
      usage.no_cache_tokens,
      usage.uncachedInputTokens,
      usage.uncached_input_tokens,
    )
    if (noCacheInput !== null) {
      message.usage.input_tokens = Math.max(0, noCacheInput)
    } else {
      const cachedInput = Math.max(0, (cacheRead ?? 0) + (cacheWrite ?? 0))
      message.usage.input_tokens = Math.max(0, input - cachedInput)
    }
  }
  if (cacheRead !== null && cacheRead > 0) message.usage.cache_read_input_tokens = cacheRead
  if (cacheWrite !== null && cacheWrite > 0) message.usage.cache_creation_input_tokens = cacheWrite
}

function alphaToolInput(event: CommandCodeAlphaEvent): Record<string, unknown> {
  const input = firstDefined(event.input, event.args, event.arguments)
  if (isRecord(input)) return input
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown
      if (isRecord(parsed)) return parsed
    } catch {
      return { value: input }
    }
  }
  return {}
}

function commandCodeAlphaErrorDetail(event: CommandCodeAlphaEvent): string {
  const error = event.error
  if (typeof error === 'string') return error
  if (isRecord(error)) {
    return [
      firstString(error.message),
      firstString(error.code),
      firstString(error.type),
      firstNumber(error.statusCode, error.status)?.toString(),
    ].filter(Boolean).join(' ') || JSON.stringify(error)
  }
  return firstString(event.message, event.detail) ?? JSON.stringify(event)
}

function toolResultToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(part => {
      if (typeof part === 'string') return part
      if (isRecord(part)) return firstString(part.text, part.value, part.content) ?? JSON.stringify(part)
      return String(part)
    }).join('')
  }
  if (value === null || value === undefined) return ''
  if (isRecord(value)) {
    return firstString(value.text, value.value, value.content) ?? JSON.stringify(value)
  }
  return String(value)
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return null
}

function firstRecord(...values: unknown[]): RawCommandCodeModel | null {
  for (const value of values) {
    if (isRecord(value)) return value
  }
  return null
}

function isRecord(value: unknown): value is RawCommandCodeModel {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function extractErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string; code?: string }
      message?: string
      type?: string
    }
    return [
      parsed.error?.message,
      parsed.message,
      parsed.error?.code,
      parsed.error?.type,
      parsed.type,
    ].filter(Boolean).join(' ')
  } catch {
    return body
  }
}
